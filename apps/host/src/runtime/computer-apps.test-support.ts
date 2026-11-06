import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, type EnvironmentId } from "@opensteer/core";
import type { ComputerAppSetupSummary, IntegrationAccess } from "@opensteer/integration-core";
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
} from "@opensteer/protocol";
import { createRunnerAuxiliarySignature } from "@opensteer/runner-auth";
import {
  ComputerAppModuleHandler,
  type ComputerAppProvider,
  type ComputerAppModuleHandlerOptions,
} from "@opensteer/runner";
import { attachLocalWorkspaceDisk } from "../workspace/runner-local-workspace.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  closed,
  acknowledgeCommands,
  connectPrimary,
  enrollmentToken,
  type MachineAccessHost,
  type PrimaryConnection,
} from "./machine-access.test-support.js";

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
  const disk = mainSocket ? attachLocalWorkspaceDisk(mainSocket) : undefined;
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
              localStorage: disk?.inventory ?? null,
              maxConcurrentRuns: 1,
              providerStateModes: ["isolated"],
              workspaceBackings: ["local-directory"],
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
    disk?.stop();
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
    .where("runnerId", "=", request.runnerId)
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

/** Search rows, one per account, each with the address that calls it. */
export function operations(search: Record<string, unknown>) {
  const rows = search.operations as readonly {
    readonly accounts?: readonly string[];
    readonly installation: string;
    readonly name: string;
  }[];
  const results = search.results as readonly {
    readonly accounts: readonly { readonly account: string; readonly connectionId: string }[];
    readonly name: string;
  }[];
  return rows.flatMap((row) => {
    const accounts = results.find(({ name }) => name === row.installation)?.accounts ?? [];
    const shown = row.accounts
      ? accounts.filter(({ connectionId }) => row.accounts?.includes(connectionId))
      : accounts;
    const name = row.name.slice(0, row.name.lastIndexOf("@"));
    return shown.length > 0
      ? shown.map(({ account, connectionId }) => ({
          account,
          address: { account: connectionId, operation: row.name },
          connectionId: connectionId as string | null,
          name,
        }))
      : [
          {
            account: row.installation,
            address: { operation: row.name },
            connectionId: null as string | null,
            name,
          },
        ];
  });
}

export function toolReadiness(search: Record<string, unknown>, name: string) {
  const results = search.results as readonly {
    readonly tools?: readonly {
      readonly name: string;
      readonly readiness: { readonly code: string; readonly detail: string | null };
    }[];
  }[];
  const found = results.flatMap(({ tools }) => tools ?? []).find((tool) => tool.name === name);
  if (found) return found.readiness;
  if (operations(search).some((candidate) => candidate.name === name)) {
    return { code: "READY", detail: null };
  }
  throw new Error(`Tool ${name} was not found in ${JSON.stringify(search)}`);
}

export function operation(search: Record<string, unknown>, name: string) {
  const found = operations(search).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Operation ${name} was not found in ${JSON.stringify(search)}`);
  return found;
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
