import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, type EnvironmentId } from "@opensteer/core";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import type {
  ComputerAppApproval,
  ComputerAppSetupRequest,
  IntegrationAccess,
} from "@opensteer/integration-core";
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
  HostIntegrationsComputerAppApprovalKeyChallengeSchema,
  type ComputerAppApprovalAnswer,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcome,
  type ComputerAppApprovalOutcomeFrame,
  type RunnerAuxiliaryModule,
  type RunnerMessagingModule,
  type RunnerIntegrationsModule,
  type RunnerModuleName,
  type RunnerDevice,
} from "@opensteer/protocol";
import {
  createRunnerAuxiliarySignature,
  signComputerAppApprovalKeyChallenge,
} from "@opensteer/runner-auth";
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
 * `attachMessaging`. The owner registers the desktop's approval key, as
 * opening the Mac's page on the Mac does.
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
    readonly desktop?: Pick<ComputerAppModuleHandlerOptions, "computerUse" | "localMcp">;
    readonly messaging?: RunnerMessagingModule;
    readonly integrations?: RunnerIntegrationsModule;
    readonly registerApprovalKey?: boolean;
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
              workspaceMounts: [],
            },
          }
        : {}),
      // A desktop supervises it, so it relays approvals.
      integrations: options.integrations ?? {
        computerAppApprovals: true,
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
  const approvalKey = generateKeyPairSync("ed25519");
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
      approvalKey.privateKey,
      options.statusIntervalMs,
      desktop,
    );
    if (options.registerApprovalKey !== false)
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: `approval-key:${runnerId}`,
          input: {
            publicKey: approvalKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
            runnerId,
          },
          type: "integration.computer.approval-key.set",
        },
        { headers: host.ownerHeaders },
      );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    answer: (setupRequestId: string, answer: ComputerAppApprovalAnswer) =>
      module.answer(setupRequestId, answer),
    approvalKey,
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
        approvalKey.privateKey,
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
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
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
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
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
  approvalKey: KeyObject,
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
      if (parsed.type === "host.integrations.computer-app-approval-key-challenge") {
        const message = HostIntegrationsComputerAppApprovalKeyChallengeSchema.parse(parsed);
        const { challengeId, expiresAt, keyId, nonce, runnerId } = message;
        const challenge = { challengeId, expiresAt, keyId, nonce, runnerId };
        socket.send(
          JSON.stringify({
            ...fence,
            challengeId: challenge.challengeId,
            signature: signComputerAppApprovalKeyChallenge(approvalKey, challenge),
            type: "runner.integrations.computer-app-approval-key-proof",
          }),
        );
        return;
      }
    }
    void handler.handleFrame(frame, isBinary);
  });
  socket.once("close", () => handler.detach());
  return {
    /** The person's answer on this Mac, and the Host's outcome for it. */
    answer: async (
      setupRequestId: string,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> => {
      const decided = waitForMessage(
        socket,
        (message) =>
          message.type === "host.integrations.computer-app-approval-outcome" &&
          (message as { readonly setupRequestId?: string }).setupRequestId === setupRequestId,
      );
      socket.send(
        JSON.stringify({
          ...fence,
          answer,
          setupRequestId,
          type: "runner.integrations.computer-app-approval-answer",
        }),
      );
      return ((await decided) as { readonly outcome: ComputerAppApprovalOutcome }).outcome;
    },
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
): Promise<ComputerAppSetupRequest> {
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
 * The person allows the request on the Mac: the signed answer goes back on the
 * Mac's own `integrations` stream, and the Host's outcome comes back on it.
 */
export async function setComputerApp(
  host: MachineAccessHost,
  computer: { readonly answer: IntegrationsModule["answer"] },
  request: ComputerAppSetupRequest,
  approval: ComputerAppApproval,
) {
  const outcome = await computer.answer(request.id, { approval, kind: "allow" });
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

type IntegrationsModule = Awaited<ReturnType<typeof attachIntegrations>>;

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
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
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
  const outcomes: ComputerAppApprovalOutcomeFrame[] = [];
  const requests: ComputerUseBridgeRequest[] = [];
  /** Every approval a list has shown this desktop, by setup request. */
  const shown = new Map<string, ComputerAppSetupRequest>();
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
            : frame.method === "approvals.list" || frame.method === "approvals.outcome"
              ? (() => {
                  if (frame.method === "approvals.outcome") {
                    outcomes.push(frame.params as ComputerAppApprovalOutcomeFrame);
                  } else {
                    for (const { request } of (frame.params as ComputerAppApprovalList).approvals) {
                      shown.set(request.id, request);
                    }
                  }
                  return { result: {} };
                })()
              : (answer(frame) ?? {
                  error: { code: "unsupported", message: "The fake desktop has no such method." },
                });
      socket.send(JSON.stringify({ id: frame.id, kind: "response", ...answered }));
    });
  });
  return {
    requests,
    /**
     * The person's answer on the Mac, sent as desktop main sends it — to the
     * Runner over its bridge, which carries it to the Host — and the Host's
     * outcome, as it comes back the same way.
     */
    answer: async (
      setupRequestId: string,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> => {
      // Desktop main answers only what a list showed it.
      const shownBy = Date.now() + 15_000;
      let request = shown.get(setupRequestId);
      while (!request) {
        if (Date.now() > shownBy) throw new Error("The Mac was never shown this approval");
        await new Promise((resolve) => setTimeout(resolve, 25));
        request = shown.get(setupRequestId);
      }
      // Allowing a server names the launch the person saw, as desktop main does.
      const allowedServer =
        answer.kind === "allow" && request.kind === "server" && request.server
          ? {
              launchDigest: localMcpLaunchDigest(request.server.launch),
              serverId: request.server.serverId,
            }
          : null;
      const before = outcomes.length;
      for (const client of server.clients) {
        client.send(
          JSON.stringify({
            event: "approval.answer",
            kind: "event",
            params: { answer, setupRequestId },
            server: allowedServer,
          }),
        );
      }
      const deadline = Date.now() + 15_000;
      for (;;) {
        const found = outcomes
          .slice(before)
          .find((outcome) => outcome.setupRequestId === setupRequestId);
        if (found) return found.outcome;
        if (Date.now() > deadline) throw new Error("The Host never answered the Mac");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
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

export function operations(search: Record<string, unknown>) {
  return search.operations as readonly {
    readonly name: string;
    readonly account: string;
    readonly connectionId: string | null;
    readonly toolRef: string;
  }[];
}

export function toolReadiness(search: Record<string, unknown>, name: string) {
  const results = search.results as readonly {
    readonly tools: readonly {
      readonly name: string;
      readonly readiness: { readonly code: string; readonly detail: string | null };
    }[];
  }[];
  const found = results.flatMap(({ tools }) => tools).find((tool) => tool.name === name);
  if (!found) throw new Error(`Tool ${name} was not found in ${JSON.stringify(search)}`);
  return found.readiness;
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
