import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { computerAppIntegrations } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, type EnvironmentId } from "@opensteer/core";
import type { ComputerAppSetupSummary } from "@opensteer/integration-core/computer-app-setup";
import type { IntegrationAccess } from "@opensteer/integration-core/access";
import type { MessagingModule } from "@opensteer/messaging-module";
import {
  ComputerUseBridgeRequestSchema,
  type ComputerUseBridgeRequest,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runnerIntegrationsProtocolVersion,
  type RunnerAuxiliaryModule,
  type RunnerMessagingModule,
  type RunnerIntegrationsModule,
  type RunnerModuleName,
  type RunnerDevice,
  type ComputerUseDataGrants,
  type ComputerUseDataInvokeParams,
} from "@opensteer/protocol";
import { createRunnerAuxiliarySignature } from "@opensteer/runner-auth";
import {
  ComputerAppModuleHandler,
  type ComputerAppProvider,
  type ComputerAppModuleHandlerOptions,
  type ComputerAppValue,
  type HelperDataPort,
} from "@opensteer/runner";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  closed,
  acknowledgeCommands,
  connectPrimary,
  enrollmentToken,
  type MachineAccessHost,
  type PrimaryConnection,
} from "./machine-access-protocol.test-support.js";

/**
 * A Mac as a Host meets it: its primary connection, its `integrations`
 * stream carrying the given app providers, and — when `messaging` is given —
 * a `messaging` module it advertises, attached separately with
 * `attachMessaging`. App decisions use the owner's authenticated Host session.
 */
export async function connectComputerAppMachine(
  host: MachineAccessHost,
  provider: ComputerAppProvider | readonly ComputerAppProvider[],
  options: {
    readonly allowedModules?: readonly RunnerModuleName[];
    readonly device?: RunnerDevice;
    readonly personalMain?: {
      readonly environmentId: EnvironmentId;
      readonly enrollmentToken: string;
    };
    /** The desktop's side of this Mac, as the Runner prepares it with a bridge. */
    readonly desktop?: Pick<ComputerAppModuleHandlerOptions, "computerUse" | "files" | "localMcp">;
    readonly messaging?: RunnerMessagingModule;
    readonly integrations?: RunnerIntegrationsModule;
    readonly statusIntervalMs?: number;
  } = {},
) {
  const providers = Array.isArray(provider) ? provider : [provider];
  const desktop = options.desktop ?? {};
  const runnerId = createId("runner");
  const mainSocket = options.personalMain
    ? new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`)
    : undefined;
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    capabilities: [],
    ...(options.device ? { device: options.device } : {}),
    modules: {
      ...(options.personalMain
        ? {
            agents: {
              environmentIds: [options.personalMain.environmentId],
              harnessDrivers: [],
              maxConcurrentRuns: 1,
              providerStateModes: ["isolated"],
            },
          }
        : {}),
      integrations: options.integrations ?? {
        platform: "darwin",
        protocolVersion: runnerIntegrationsProtocolVersion,
      },
      ...(options.messaging ? { messaging: options.messaging } : {}),
    },
    name: "Studio Mac",
    runnerId,
    runnerKind: options.personalMain ? "main" : "local",
    runtimeVersion: "integration",
  });
  const primary = await connectPrimary(
    host.hostPort,
    descriptor,
    {
      token:
        options.personalMain?.enrollmentToken ??
        (await enrollmentToken(host, {
          allowedModules: options.allowedModules ?? ["integrations"],
          idempotencyKey: `computer-app-target:${runnerId}`,
          name: "Studio Mac",
        })),
    },
    mainSocket,
  );
  if (options.personalMain) acknowledgeCommands(primary, () => true);
  let module: Awaited<ReturnType<typeof attachIntegrations>>;
  const close = async () => {
    try {
      await module?.close();
    } finally {
      primary.socket.close();
      await closed(primary.socket);
    }
  };
  try {
    module = await attachIntegrations(
      host.hostPort,
      primary,
      providers,
      options.statusIntervalMs,
      desktop,
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    answer: async (
      setupRequestId: string,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> => {
      if (answer.setupRequestId !== setupRequestId)
        return { kind: "refused", message: "This answer names another request." };
      try {
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "integration.computer.setup.respond",
            setupRequestId,
            decision: answer.kind,
            idempotencyKey: `computer-answer:${setupRequestId}:${randomUUID()}`,
          },
          { headers: host.ownerHeaders },
        );
        return { kind: answer.kind === "allow" ? "allowed" : "declined" };
      } catch (error) {
        return { kind: "refused", message: error instanceof Error ? error.message : "Refused" };
      }
    },
    primary,
    get auxiliaryStreamId() {
      return module.auxiliaryStreamId;
    },
    get streamLeaseExpiresAt() {
      return module.streamLeaseExpiresAt;
    },
    close,
    disconnectModule: async () => {
      await module.close();
    },
    /** Attaches again; `restarted` is a Runner that came back with a new desktop side. */
    reconnectModule: async (
      restarted?: Pick<ComputerAppModuleHandlerOptions, "computerUse" | "localMcp">,
    ) => {
      module = await attachIntegrations(
        host.hostPort,
        primary,
        providers,
        options.statusIntervalMs,
        restarted ?? desktop,
      );
    },
    heartbeat: () => module.heartbeat(),
    rejectHeartbeat: (overrides: Readonly<Record<string, unknown>>) =>
      module.rejectHeartbeat(overrides),
    rejectPreAuthenticationHeartbeat: () =>
      rejectPreAuthenticationHeartbeat(host.hostPort, primary),
    runnerId,
  };
}

async function rejectPreAuthenticationHeartbeat(hostPort: number, primary: PrimaryConnection) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/integrations`,
  );
  const challenged = waitForMessage(
    socket,
    (message) => message.type === "host.auxiliary.challenge",
  );
  await challenged;
  const closing = waitForClose(socket);
  socket.send(
    JSON.stringify({
      ...primary.fence,
      auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
        "rax_22222222-2222-4222-8222-222222222222",
      ),
      module: "integrations",
      sentAt: new Date().toISOString(),
      type: "runner.auxiliary.heartbeat",
    }),
  );
  return closing;
}

/**
 * One auxiliary stream, opened exactly as the Runner opens it: the primary
 * connection asks for a one-use ticket, the stream proves the machine key
 * against a fresh challenge, and every later frame repeats the fence the
 * welcome stamped. Heartbeats keep its lease for as long as it is open.
 */
export async function openAuxiliaryStream(
  hostPort: number,
  primary: PrimaryConnection,
  module: RunnerAuxiliaryModule,
) {
  const ticketed = waitForMessage(
    primary.socket,
    (message) => message.type === "host.auxiliary.ticket",
  );
  primary.socket.send(
    JSON.stringify({
      ...primary.fence,
      module,
      requestId: `${module}-${randomUUID()}`,
      type: "runner.auxiliary.ticket-request",
    }),
  );
  const { ticket } = (await ticketed) as { readonly ticket: string };
  const socket = new WebSocket(
    `ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/${module}`,
  );
  const challenged = waitForMessage(
    socket,
    (message) => message.type === "host.auxiliary.challenge",
  );
  const challenge = RunnerAuxiliaryChallengeSchema.parse(await challenged);
  const welcomed = waitForMessage(socket, (message) => message.type === "host.auxiliary.welcome");
  socket.send(
    JSON.stringify({
      bootId: primary.bootId,
      challengeId: challenge.challengeId,
      module,
      runnerId: primary.fence.runnerId,
      signature: createRunnerAuxiliarySignature(primary.privateKey, {
        bootId: primary.bootId,
        challenge,
        module,
        runnerId: primary.fence.runnerId,
        ticket,
      }),
      ticket,
      type: "runner.auxiliary.authenticate",
    }),
  );
  const welcome = RunnerAuxiliaryWelcomeSchema.parse(await welcomed);
  const fence = {
    auxiliaryStreamId: welcome.auxiliaryStreamId,
    bootId: welcome.bootId,
    connectionGeneration: welcome.connectionGeneration,
    connectionId: welcome.connectionId,
    connectionLeaseId: welcome.connectionLeaseId,
    module,
    runnerId: welcome.runnerId,
  };
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        ...fence,
        sentAt: new Date().toISOString(),
        type: "runner.auxiliary.heartbeat",
      }),
    );
  }, welcome.heartbeatIntervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  return { fence, socket, welcome };
}

export async function attachIntegrations(
  hostPort: number,
  primary: PrimaryConnection,
  providers: readonly ComputerAppProvider[],
  statusIntervalMs = 60_000,
  desktop: Pick<ComputerAppModuleHandlerOptions, "computerUse" | "localMcp"> = {},
) {
  const { fence, socket, welcome } = await openAuxiliaryStream(hostPort, primary, "integrations");
  const handler = new ComputerAppModuleHandler({
    ...desktop,
    logger: { error() {}, info() {} },
    providers,
    statusIntervalMs,
  });
  handler.attach({
    browserAttachPublicKeys: undefined,
    fence,
    send: (frame, binary) =>
      new Promise<void>((resolve, reject) => {
        socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve()));
      }),
  });
  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (!isBinary) {
      const parsed = JSON.parse(frame.toString("utf8")) as { readonly type: string };
      if (parsed.type === "host.auxiliary.lease-renewed") return;
    }
    void handler.handleFrame(frame, isBinary);
  });
  socket.once("close", () => handler.detach());
  return {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    streamLeaseExpiresAt: welcome.streamLeaseExpiresAt,
    close: async () => {
      handler.detach();
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await closed(socket);
    },
    heartbeat: async () => {
      const renewed = waitForMessage(
        socket,
        (message) => message.type === "host.auxiliary.lease-renewed",
      );
      socket.send(
        JSON.stringify({
          ...fence,
          sentAt: new Date().toISOString(),
          type: "runner.auxiliary.heartbeat",
        }),
      );
      return RunnerAuxiliaryLeaseRenewedSchema.parse(await renewed);
    },
    rejectHeartbeat: (overrides: Readonly<Record<string, unknown>>) => {
      const closing = waitForClose(socket);
      socket.send(
        JSON.stringify({
          ...fence,
          sentAt: new Date().toISOString(),
          type: "runner.auxiliary.heartbeat",
          ...overrides,
        }),
      );
      return closing;
    },
  };
}

/**
 * A Runner's `messaging` module on its own stream, attached the way the
 * Runner's host connection attaches it: every frame but a lease renewal goes
 * to the module, and the module detaches when the stream ends.
 */
export async function attachMessaging(
  hostPort: number,
  primary: PrimaryConnection,
  module: MessagingModule,
) {
  const { fence, socket } = await openAuxiliaryStream(hostPort, primary, "messaging");
  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (!isBinary) {
      const parsed = JSON.parse(frame.toString("utf8")) as { readonly type: string };
      if (parsed.type === "host.auxiliary.lease-renewed") return;
    }
    void module.handleFrame(frame, isBinary).catch(() => undefined);
  });
  const ended = new Promise<void>((resolve) => {
    socket.once("close", () => {
      void module.detach().finally(resolve);
    });
  });
  await module.attach({
    browserAttachPublicKeys: undefined,
    fence,
    send: (frame, binary) =>
      new Promise<void>((resolve, reject) => {
        socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve()));
      }),
  });
  return {
    close: async () => {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close();
        await closed(socket);
      }
      await ended;
    },
  };
}

export async function requestComputerAppSetup(
  host: MachineAccessHost,
  runnerId: PrimaryConnection["fence"]["runnerId"],
  access: IntegrationAccess,
  key: string,
  definitionId = "apple-messages",
): Promise<ComputerAppSetupSummary> {
  const result = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: `${key}:setup`,
      input: { kind: "app", app: null, access, definitionId, runnerId },
      type: "integration.computer.setup.request",
    },
    { headers: host.ownerHeaders },
  );
  if (result.type !== "integration.computer.setup.request") throw new Error("Command mismatch");
  return result.request;
}

/**
 * The owner allows the stored request through the shared Host command.
 */
export async function setComputerApp(
  host: MachineAccessHost,
  computer: {
    readonly answer: (
      setupRequestId: string,
      answer: ComputerAppApprovalAnswer,
    ) => Promise<ComputerAppApprovalOutcome>;
  },
  request: ComputerAppSetupSummary,
  setupRequestId: string,
) {
  const outcome = await computer.answer(request.id, { setupRequestId, kind: "allow" });
  if (outcome.kind !== "allowed") {
    throw new Error(
      `The Host ${outcome.kind === "refused" ? `refused: ${outcome.message}` : "declined"}`,
    );
  }
  const connection = await host.store.database
    .selectFrom("integrationConnections")
    .select("id")
    .where("deviceId", "=", await host.store.requireSelfDeviceId(request.runnerId))
    .where("integrationDefinitionId", "=", request.definitionId)
    .where("status", "!=", "revoked")
    .executeTakeFirstOrThrow();
  return { connection };
}

export function waitForMessage(
  socket: WebSocket,
  predicate: (message: { readonly type: string }) => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("close", close);
      socket.off("error", error);
      socket.off("message", receive);
    };
    const close = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(`WebSocket closed before the expected frame (${code}: ${reason.toString()})`),
      );
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const receive = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { readonly type: string };
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket frame"));
    }, 15_000);
    socket.once("close", close);
    socket.once("error", error);
    socket.on("message", receive);
  });
}

export function waitForClose(
  socket: WebSocket,
  description = "the WebSocket to close",
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", close);
      socket.off("error", error);
    };
    const close = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString("utf8") });
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}`));
    }, 15_000);
    socket.once("close", close);
    socket.once("error", error);
  });
}

export type FakeDesktopAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: string; readonly message: string } };

/**
 * The desktop's end of a Runner's bridge, on its own loopback port: every
 * grant allowed, every approval relayed to it taken, and anything else
 * answered by `answer` — or refused as a method it does not have.
 */
export async function startFakeDesktop(
  answer: (request: ComputerUseBridgeRequest) => FakeDesktopAnswer | undefined = () => undefined,
  options: { readonly computerUseVersion?: 2 } = {},
) {
  const token = randomUUID();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: ComputerUseBridgeRequest[] = [];
  /** Every approval a list has shown this desktop, by setup request. */
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake desktop has no port");
  server.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.close(1008, "unauthorized");
      return;
    }
    socket.on("message", (raw) => {
      const frame = ComputerUseBridgeRequestSchema.parse(JSON.parse(String(raw)));
      requests.push(frame);
      const answered: FakeDesktopAnswer =
        frame.method === "permissions.get"
          ? {
              result: {
                ...options,
                permissions: { accessibility: "granted", screenRecording: "granted" },
              },
            }
          : frame.method === "data.status"
            ? {
                result: {
                  grants: {
                    automation: "granted",
                    calendars: "granted",
                    contacts: "granted",
                    "full-disk-access": "granted",
                    reminders: "granted",
                  },
                },
              }
            : (answer(frame) ?? {
                error: { code: "unsupported", message: "The fake desktop has no such method." },
              });
      socket.send(JSON.stringify({ id: frame.id, kind: "response", ...answered }));
    });
  });
  return {
    requests,
    close: async () => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, "close");
    },
    token,
    url: new URL(`ws://127.0.0.1:${address.port}/`),
  };
}

/** A Run's integration gateway, as its agent reaches it. */
export async function integrationGateway(plan: { readonly token: string; readonly url: string }) {
  const client = new Client({ name: "computer-app-integration-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(plan.url), {
    requestInit: { headers: { authorization: `Bearer ${plan.token}` } },
  });
  await client.connect(transport as unknown as Transport);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ arguments: args, name });
      if (result.isError) throw new Error(toolText(result));
      return result.structuredContent as Record<string, unknown>;
    },
    callRaw: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close: () => client.close(),
  };
}

export function toolText(value: unknown): string {
  return (
    (value as { readonly content: readonly { readonly text: string }[] }).content[0]?.text ?? ""
  );
}

export type ComputerAppApprovalAnswer = {
  readonly kind: "allow" | "deny";
  readonly setupRequestId: string;
};
export type ComputerAppApprovalOutcome =
  | { readonly kind: "allowed" | "declined" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * The signed helper as the Runner reaches it: the grants its person allowed,
 * and each call it was sent, answered by the step that is running.
 */
export function scriptedHelper() {
  const grants: { -readonly [K in keyof ComputerUseDataGrants]: ComputerUseDataGrants[K] } = {
    automation: "unknown",
    calendars: "requestable",
    contacts: "requestable",
    "full-disk-access": "denied",
    reminders: "requestable",
  };
  const invocations: ComputerUseDataInvokeParams[] = [];
  const script: { answer: () => ComputerAppValue } = {
    answer: () => {
      throw new Error("No step expects a call to the helper now");
    },
  };
  const port: HelperDataPort = {
    dataGrants: async () => ({ ...grants }),
    dataInvoke: async (params) => {
      invocations.push(params);
      return script.answer();
    },
  };
  return {
    grants,
    invocations,
    port,
    /** How the helper answers the calls of the step that is running. */
    set answer(answer: () => ComputerAppValue) {
      script.answer = answer;
    },
  };
}

/** The agent asks for access, and the owner fulfils it with the Mac's connection. */
export async function grantAccess(
  host: MachineAccessHost,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  input: {
    readonly access: IntegrationAccess;
    readonly connectionId: string;
    readonly integration: string;
  },
) {
  const held = gateway.call("app_access_request", {
    access: input.access,
    dataApp: input.integration.replace(/^(?:apple|iphone)-/u, ""),
    reason: `Use ${input.integration}`,
  });
  const request = await vi.waitFor(
    async () => {
      const pending = await host.store.integrationRequests.listPendingIntegrationAccessRequests(
        host.ownerId,
      );
      const row = pending.at(-1);
      expect(row, "The access Request was not created").toBeDefined();
      return row!;
    },
    { timeout: 10_000 },
  );
  if (!request) throw new Error(`The ${input.integration} access Request was not created`);
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: `${input.integration}-access`,
      requestId: request.request.id,
      response: {
        kind: "external",
        value: {
          access: input.access,
          alias: `${input.integration} on Studio Mac`,
          connectionId: input.connectionId,
          decision: "fulfilled",
          isDefault: true,
        },
      },
      type: "request.respond",
    },
    { headers: host.ownerHeaders },
  );
  await expect(held).resolves.toMatchObject({ status: "fulfilled" });
}

export function contractOf(definitionId: string, name: string): string {
  const definition = computerAppIntegrations.find(({ id }) => id === definitionId);
  const found =
    definition && isComputerAppDefinition(definition)
      ? definition.config.operations.find((candidate) => candidate.name === name)
      : undefined;
  if (!found) throw new Error(`The catalog must define ${definitionId}.${name}`);
  return computerAppOperationContract(found);
}

/** A plugin tool's exact path, found by searching as an agent does. */
export async function pluginPath(
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  query: string,
  tool: string,
): Promise<string> {
  const found = await gateway.call("plugin_search", { query });
  const path = (found.items as readonly { readonly path: string }[]).find(({ path }) =>
    path.endsWith(`.${tool}`),
  )?.path;
  if (!path) throw new Error(`plugin_search found no ${tool}: ${JSON.stringify(found)}`);
  return path;
}

/** One plugin tool call as the agent reads it: the tool's value, or why it failed. */
export async function pluginCall(
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  path: string,
  input: Record<string, unknown>,
): Promise<{
  readonly value?: unknown;
  readonly failure?: string;
  readonly raw: Awaited<ReturnType<typeof gateway.callRaw>>;
}> {
  const raw = await gateway.callRaw("plugin_call", { calls: { path, input } });
  const result = raw.structuredContent as Record<string, unknown> | undefined;
  const execution = (result?.result as { execution?: { ok?: boolean; value?: unknown } })
    ?.execution;
  // One direct call answers { ok, path, value } or { ok: false, path, error }.
  const call = execution?.value as { ok?: boolean; value?: unknown; error?: unknown } | undefined;
  if (execution?.ok && call?.ok) return { value: call.value, raw };
  const error = call?.error ?? result?.error ?? raw;
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : error;
  return { failure: typeof message === "string" ? message : JSON.stringify(message), raw };
}

/** The explanation inside a failed call's one-line summary, as the agent reads it. */
export function failureMessage(failure: string): string {
  return /^\S+ \(HTTP \d+\): ([\s\S]*?) Recovery:/u.exec(failure)?.[1] ?? failure;
}

export async function expectPluginSettingRefusal(
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  namespace: string,
  path: string,
  input: Record<string, unknown>,
  label: "Read-only" | "Off",
) {
  const blocked = {
    code: "access_denied",
    message: expect.stringContaining(label),
    next: expect.stringMatching(/person.*Plugins/u),
  };
  // Off keeps the whole app, so its namespace says so once; Read-only keeps each write.
  const search = await gateway.call("plugin_search", { namespace });
  const describe = await gateway.call("plugin_describe", { paths: [path] });
  for (const found of [search, describe]) {
    const items = found.items as { path: string; blocked?: unknown }[];
    expect(items.map((item) => item.path)).toContain(path);
    if (label === "Off") {
      expect(found.namespaces).toEqual([expect.objectContaining({ blocked })]);
      expect(items.filter((item) => "blocked" in item)).toEqual([]);
    } else {
      expect(items.find((item) => item.path === path)).toMatchObject({ blocked });
    }
  }
  expect((await pluginCall(gateway, path, input)).raw).toMatchObject({
    isError: true,
    structuredContent: { error: blocked },
  });
  expect(
    await gateway.call("plugin_execute", {
      code: `return await ${path}(${JSON.stringify(input)})`,
    }),
  ).toMatchObject({
    result: { execution: { value: { kind: "blocked", blocked } } },
  });
}
