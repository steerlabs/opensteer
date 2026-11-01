import websocket from "@fastify/websocket";
import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import { browserSiteDomain } from "@opensteer/browser-profile/source-state";
import {
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  OpensteerError,
  ThreadAccessModeSchema,
  type RunnerId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  BrowserSourceStore,
  createDatabase,
  migrateToLatest,
  OpensteerStore,
} from "@opensteer/database";
import { takeTransactionConflicts } from "@opensteer/database/test-support/lock-order";
import type { PersonalHostAccessRouteEnvelope } from "@opensteer/deployment-authority";
import {
  browserSourceChallengeBytes,
  browserSourcePairChallengeBytes,
  browserSourceRouteChangedBytes,
} from "@opensteer/deployment-authority";
import type {
  BrowserClientMessage,
  LoginAuthorizationOutcome,
  PasswordSignInAuthorityCommand,
  PasswordSignInAuthorityEvent,
  PasswordSignInAuthorityResult,
  PendingAgentEvent,
  RunnerDescriptor,
} from "@opensteer/protocol";
import {
  browserSourceProtocolVersion,
  type BrowserSourceStatus,
} from "@opensteer/protocol/browser-sources";
import Fastify from "fastify";
import { sql } from "kysely";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { registerBrowserSourceWire } from "../server/browser-source-registration.js";
import { normalizeHostError } from "../server/http-errors.js";
import {
  BrowserService,
  type BrowserConsumerPeer,
  type BrowserRuntimeConnection,
} from "./browser-service.js";
import { BrowserSourceService } from "./browser-source-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";
import { PasswordSignInService } from "./password-sign-in-service.js";

let reservedLoginRef = "lgn_" + "1".repeat(32);
let reservedLoginExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

function authorized(): Extract<LoginAuthorizationOutcome, { kind: "authorized" }> {
  return {
    kind: "authorized",
    loginRef: reservedLoginRef,
    account: "t•••@example.test",
    expiresAt: reservedLoginExpiresAt,
  };
}

const sourceOrigin = "https://source-host.test";
const sourceDestination = { origin: sourceOrigin, routeGeneration: null };

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * An in-process Browser Runtime that speaks the Host's session protocol:
 * it announces a ready session and answers `state.import`, recording every
 * command the Host relays so a test can see what reached the browser.
 */
class FakeRuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState: number = WebSocket.OPEN;
  readonly received: (BrowserClientMessage | PasswordSignInAuthorityCommand)[] = [];
  readonly initialPage: BrowserRuntimeConnection["initialPage"];
  readonly passwordEvents = new EventEmitter();
  authorityConnected = true;
  hasPasswordAuthority = false;
  /** What the Mac answers a sign-in probe; the Passwords switch, as the runtime sees it. */
  holdStartAck = false;
  passwords: "has-login" | "no-login" | "off" | "not-set-up" | "unavailable" = "has-login";
  onStart = (message: Extract<PasswordSignInAuthorityCommand, { type: "login.authorize" }>) =>
    this.needSignIn(message.operationId, "approval");
  /** How the runtime answers a cancel: by default as cancelled, before authorization. */
  onCancel: (message: Extract<PasswordSignInAuthorityCommand, { type: "login.cancel" }>) => void = (
    message,
  ) => this.replySignIn(message.operationId, { kind: "cancelled", reason: message.reason });

  constructor(ticket: string) {
    super();
    const claims = JSON.parse(
      Buffer.from(ticket.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as import("@opensteer/protocol").BrowserAttachTicketClaims;
    this.initialPage = claims.initialNavigation
      ? {
          operationKey: claims.initialNavigation.operationKey,
          surfaceId: "page-1" as import("@opensteer/protocol").BrowserSurfaceId,
          navigation: claims.initialNavigation.url ? "submitted" : "blank",
        }
      : undefined;
    queueMicrotask(() =>
      this.#reply({
        access: "full-control",
        dialog: null,
        sessionId: claims.sessionId,
        state: "ready",
        surfaces: [{ active: true, id: "page-1", title: "Example", url: "about:blank" }],
        type: "browser.snapshot",
      }),
    );
  }

  send(data: string, _options: { readonly binary: false }, callback: (error?: Error) => void) {
    const message = JSON.parse(data) as BrowserClientMessage;
    this.received.push(message);
    if (!this.holdStartAck || message.type !== "login.authorize") callback();
    if (message.type === "state.import") {
      queueMicrotask(() =>
        this.#reply({ error: null, operationId: message.operationId, type: "state.import.result" }),
      );
    }
    if (message.type === "cdp.command") {
      queueMicrotask(() =>
        this.#reply({
          type: "cdp.result",
          requestId: message.requestId,
          result: { targetInfos: [{ targetId: "target-1", type: "page" }] },
        }),
      );
    }
  }

  async passwordCommand(
    command: PasswordSignInAuthorityCommand,
  ): Promise<PasswordSignInAuthorityResult> {
    this.received.push(command);
    if (!this.authorityConnected) return { type: "unavailable" };
    switch (command.type) {
      case "signin.probe":
        return { type: "signin.probe.result", passwords: this.passwords };
      case "login.authorize":
        reservedLoginRef = command.loginRef;
        reservedLoginExpiresAt = command.expiresAt;
        queueMicrotask(() => this.onStart(command));
        if (this.holdStartAck) return new Promise(() => undefined);
        return { type: "login.authorize.started" };
      case "login.cancel":
        queueMicrotask(() => this.onCancel(command));
        return { type: "login.cancelled" };
      case "login.seal":
        return { type: "login.seal.result", status: "unavailable" };
    }
  }
  disconnectAuthority(): void {
    this.authorityConnected = false;
    this.passwordEvents.emit("event", { type: "authority-lost" });
  }

  signInStarts(): Extract<PasswordSignInAuthorityCommand, { type: "login.authorize" }>[] {
    return this.received.filter(
      (message): message is Extract<PasswordSignInAuthorityCommand, { type: "login.authorize" }> =>
        message.type === "login.authorize",
    );
  }

  signInCancels(): Extract<PasswordSignInAuthorityCommand, { type: "login.cancel" }>[] {
    return this.received.filter(
      (message): message is Extract<PasswordSignInAuthorityCommand, { type: "login.cancel" }> =>
        message.type === "login.cancel",
    );
  }

  needSignIn(operationId: string, need: "approval" | null): void {
    this.passwordEvents.emit("event", { type: "login.needs", operationId, need });
  }

  replySignIn(operationId: string, outcome: LoginAuthorizationOutcome): void {
    if (!this.authorityConnected) return;
    this.passwordEvents.emit("event", { operationId, outcome, type: "login.result" });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  terminate(): void {
    this.close(1006);
  }

  imports(): Extract<BrowserClientMessage, { type: "state.import" }>[] {
    return this.received.filter(
      (message): message is Extract<BrowserClientMessage, { type: "state.import" }> =>
        message.type === "state.import",
    );
  }

  #reply(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

/** The extension side of one connected Chrome profile. */
class FakeChrome {
  exports = 0;
  holdExports = false;
  status: BrowserSourceStatus = "available";
  /** Cookies Chrome returns for a site; by default one sign-in cookie on it. */
  cookiesFor: (site: string) => BrowserCookie[] = (site) => [
    {
      domain: browserSiteDomain(site),
      expires: -1,
      hostOnly: true,
      httpOnly: true,
      name: "session",
      path: "/",
      sameSite: "Lax",
      secure: true,
      value: `signed-in-${site}`,
    },
  ];
  readonly held: { operationId: string; site: string }[] = [];
  readonly closed: Promise<number>;
  readonly errors: unknown[] = [];

  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type: string;
        nonce?: string;
        operationId?: string;
        site?: string;
      };
      if (message.type === "ping")
        socket.send(JSON.stringify({ type: "pong", nonce: message.nonce }));
      if (message.type === "source.error") this.errors.push(message);
      if (message.type === "source.inspect") {
        socket.send(
          JSON.stringify({
            operationId: message.operationId,
            status: this.status,
            type: "source.inspect.result",
          }),
        );
      }
      if (message.type === "source.export") {
        this.exports += 1;
        const operation = { operationId: message.operationId!, site: message.site! };
        if (this.holdExports) this.held.push(operation);
        else this.#export(operation);
      }
    });
  }

  releaseExports(): void {
    for (const operation of this.held.splice(0)) this.#export(operation);
  }

  async close(): Promise<void> {
    this.socket.close();
    await this.closed;
  }

  #export(operation: { operationId: string; site: string }): void {
    this.socket.send(
      JSON.stringify({
        operationId: operation.operationId,
        result:
          this.status === "available"
            ? {
                snapshot: { cookies: this.cookiesFor(operation.site), origins: [] },
                status: "exported",
              }
            : { status: this.status },
        type: "source.export.result",
      }),
    );
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

integration.sequential("browser sign-ins over a Chrome connection", () => {
  const database = createDatabase({
    connectionString: databaseUrl ?? "postgres://unconfigured",
    applicationName: "opensteer-browser-source-host-test",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database);
  const sourceStore = new BrowserSourceStore(database);
  const hostKey = generateKeyPairSync("ed25519");
  let currentRoute: PersonalHostAccessRouteEnvelope | null = null;
  let routeFault: Error | null = null;
  let ingressOrigin = sourceOrigin;
  const runtime = {
    connections: [] as FakeRuntimeConnection[],
    runnerId: null as RunnerId | null,
    signIn: false,
    authorityConnection: null as FakeRuntimeConnection | null,
    supportsImport: true,
  };
  let clockOffsetMs = 0;
  /** How many Request settlements the store fails before it works again. */
  let settleFaults = 0;
  let openFault = false;
  let beforeOpen: (() => Promise<void>) | null = null;
  let description = {
    deploymentId: "dep_test",
    deploymentName: "Test",
    threadTitle: "Test thread",
    workspaceName: "Main",
  };
  const passwordListeners = new Set<
    (runnerId: RunnerId, event: PasswordSignInAuthorityEvent | { type: "authority-lost" }) => void
  >();
  const passwordAuthority = {
    onPasswordSignIn(
      listener: (
        runnerId: RunnerId,
        event: PasswordSignInAuthorityEvent | { type: "authority-lost" },
      ) => void,
    ) {
      passwordListeners.add(listener);
      return () => {
        passwordListeners.delete(listener);
      };
    },
    passwordSignInSupported(runnerId: RunnerId) {
      return (
        runnerId === runtime.runnerId &&
        runtime.authorityConnection?.hasPasswordAuthority === true &&
        runtime.authorityConnection.authorityConnected
      );
    },
    async sendPasswordSignIn(
      runnerId: RunnerId,
      command: PasswordSignInAuthorityCommand,
    ): Promise<PasswordSignInAuthorityResult> {
      return runnerId === runtime.runnerId && runtime.authorityConnection
        ? runtime.authorityConnection.passwordCommand(command)
        : { type: "unavailable" };
    },
  };
  const resolvePasswordAuthority = async () =>
    runtime.runnerId && passwordAuthority.passwordSignInSupported(runtime.runnerId)
      ? { runnerId: runtime.runnerId, name: "Test Mac" }
      : null;
  const browser = new BrowserService({
    connectTimeoutMs: 2_000,
    onSessionsChanged: () => {},
    onWorkspaceEvent: () => {},
    hostOrigin: new URL(sourceOrigin),
    repository: store,
    signer: new BrowserAttachTicketSigner({ keyId: "host-test", privateKey: hostKey.privateKey }),
    targetResolver: {
      placements: () =>
        runtime.runnerId
          ? [
              {
                available: true,
                environmentIds: [],
                kind: "runner" as const,
                label: "Test Mac",
                runnerId: runtime.runnerId,
                runtimeId: "browser",
              },
            ]
          : [],
      resolve: (placement) => ({
        connect: (ticket) => {
          const connection = new FakeRuntimeConnection(ticket);
          connection.hasPasswordAuthority = runtime.signIn;
          runtime.authorityConnection = connection;
          connection.passwordEvents.on(
            "event",
            (event: PasswordSignInAuthorityEvent | { type: "authority-lost" }) => {
              if (runtime.runnerId)
                for (const listener of passwordListeners) listener(runtime.runnerId, event);
            },
          );
          runtime.connections.push(connection);
          return connection;
        },
        cdpBoundary: true,
        sharedControl: true,
        computer: { name: "Test Mac", runnerId: placement.runnerId },
        placementKey: `runner:${placement.runnerId}:browser`,
        runtimeId: "browser",
        signIn: runtime.signIn,
        stateImport: runtime.supportsImport,
      }),
    },
  });
  let resolvedRequests = 0;
  const serviceErrors: unknown[] = [];
  const passwordSignInErrors: unknown[] = [];
  const reconciliationSchedule = vi.spyOn(globalThis, "setInterval");
  const passwords = new PasswordSignInService({
    authority: passwordAuthority,
    resolveAuthority: resolvePasswordAuthority,
    agentWaitMs: 40,
    declineAnswerMs: 400,
    now: () => Date.now() + clockOffsetMs,
    onError: (error) => passwordSignInErrors.push(error),
    reconcileIntervalMs: 100,
    describe: async () => description,
    onRequestResolved: () => {
      resolvedRequests += 1;
    },
    onWorkspaceEvent: () => {},
    requests: {
      hasPasswordSignInAuthority: store.requests.hasPasswordSignInAuthority.bind(store.requests),
      get: (requestId) => store.requests.get(requestId),
      listPendingPasswordSignIns: store.requests.listPendingPasswordSignIns.bind(store.requests),
      openPasswordSignIn: async (input) => {
        await beforeOpen?.();
        if (openFault) throw new Error("Synthetic Request opening failure");
        return store.requests.openPasswordSignIn(input);
      },
      settlePasswordSignInRequest: (input) => {
        if (settleFaults > 0) {
          settleFaults -= 1;
          return Promise.reject(new Error("The database connection was reset."));
        }
        return store.requests.settlePasswordSignInRequest(input);
      },
    },
  });
  const reconcilePasswords = reconciliationSchedule.mock.calls[0]?.[0];
  reconciliationSchedule.mockRestore();
  if (typeof reconcilePasswords !== "function")
    throw new Error("Missing Passwords reconciliation tick");
  const service = new BrowserSourceService({
    browser,
    canonicalOrigin: sourceOrigin,
    currentRoute: async () => {
      if (routeFault) throw routeFault;
      return currentRoute;
    },
    store: sourceStore,
    requests: store.requests,
    onError: (error) => serviceErrors.push(error),
    onRequestResolved: () => {
      resolvedRequests += 1;
    },
    onWorkspaceEvent: () => {},
    passwords,
    sign: (bytes) => sign(null, bytes, hostKey.privateKey).toString("base64url"),
  });
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => service.acceptSocket(socket, ingressOrigin, "127.0.0.1"));

  beforeAll(async () => migrateToLatest(database));
  beforeEach(async () => {
    currentRoute = null;
    routeFault = null;
    ingressOrigin = sourceOrigin;
    runtime.supportsImport = true;
    openFault = false;
    beforeOpen = null;
    description = {
      deploymentId: "dep_test",
      deploymentName: "Test",
      threadTitle: "Test thread",
      workspaceName: "Main",
    };
    settleFaults = 0;
    passwordSignInErrors.length = 0;
    serviceErrors.length = 0;
    // A previous test's closed Chrome may still be finishing its drain or
    // last-seen write; truncation can deadlock with it, so retry.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await sql`truncate table deployments, users restart identity cascade`.execute(database);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "40P01" || attempt >= 5) throw error;
      }
    }
    // Those deadlocks are this cleanup's, whichever side lost; the next test
    // must still fail on one of its own.
    takeTransactionConflicts();
  });
  afterAll(async () => {
    service.close();
    passwords.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.destroy();
  });

  async function pairChrome(
    ownerId: UserId,
    name: string,
    replaces: { readonly sourceId: string; readonly token: string } | null = null,
  ) {
    const pairing = await service.createPairing({ ownerId, route: null });
    return service.pair(
      {
        ...sourceDestination,
        code: pairing.code,
        name,
        replaces,
        version: browserSourceProtocolVersion,
      },
      sourceOrigin,
    );
  }

  async function connectChrome(paired: { sourceId: string; token: string }): Promise<FakeChrome> {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const ready = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === "source.proof") {
          socket.send(
            JSON.stringify({
              sourceId: paired.sourceId,
              token: paired.token,
              type: "source.hello",
              version: browserSourceProtocolVersion,
            }),
          );
        }
        if (message.type === "source.ready") resolve();
      });
    });
    const chrome = new FakeChrome(socket);
    socket.send(
      JSON.stringify({
        ...sourceDestination,
        nonce: randomUUID(),
        sourceId: paired.sourceId,
        type: "source.challenge",
      }),
    );
    await ready;
    return chrome;
  }

  async function runningRun(
    ownerId: UserId,
    workspaceId: WorkspaceId,
    existingRunnerId?: RunnerId,
  ) {
    const suffix = randomUUID();
    const runnerId = existingRunnerId ?? createId("runner");
    const existingThread = existingRunnerId
      ? await database
          .selectFrom("threads")
          .select("environmentId")
          .limit(1)
          .executeTakeFirstOrThrow()
      : null;
    const environmentId = existingThread?.environmentId ?? createId("environment");
    const pair = generateKeyPairSync("ed25519");
    const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
    const enrollmentTokenHash = `sha256:${createHash("sha256").update(suffix).digest("base64url")}`;
    if (!existingRunnerId)
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `browser-sign-in-${suffix}`,
        mainEnrollmentPurpose: "initial",
        name: "Browser sign-in test runner",
        requestFingerprint: `sha256:${suffix}`,
        runnerKind: "main",
        tokenHash: enrollmentTokenHash,
      });
    const descriptor: RunnerDescriptor = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      capabilities: ["filesystem"],
      modules: {
        agents: {
          environmentIds: [environmentId],
          harnessDrivers: [
            {
              accessModes: ThreadAccessModeSchema.options,
              driverKind: HarnessIdSchema.parse("native"),
              readiness: "configured",
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "Native",
                  quota: "none",
                  sourceId: "native",
                  stateKinds: ["isolated"],
                },
              ],
            },
          ],
          localStorage: null,
          maxConcurrentRuns: 1,
          providerStateModes: ["isolated"],
          workspaceBackings: ["portablefs"],
          workspaceMounts: [],
        },
      },
      name: "Browser sign-in test runner",
      runnerId,
      runnerKind: "main",
      runtimeVersion: "test",
    };
    if (!existingRunnerId)
      await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash,
        publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      sourceId: "native",
      stateKind: "isolated",
    });
    const { thread } = await store.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: `thread-${suffix}`,
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      }),
      title: "Browser sign-in",
      workspaceId,
    });
    const admitted = await store.enqueueThreadInput({
      content: [{ text: "Start", type: "text" }],
      idempotencyKey: `${suffix}-initial`,
      policy: "queue",
      requestedBy: ownerId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!admitted.command || !admitted.run) throw new Error("Expected queued Run");
    await store.claimCommand(admitted.command.id, `${suffix}-dispatcher`);
    const runnerBootId = `boot-${suffix}`;
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: harness.id,
      leaseTokenHash: `${suffix}-lease`,
      membershipGeneration: 1,
      runnerBootId,
      runnerId,
      runId: admitted.run.id,
      threadId: thread.id,
    });
    const started: PendingAgentEvent = {
      bindingGeneration: binding.bindingGeneration,
      data: { status: "running" },
      emittedAt: new Date().toISOString(),
      environmentId,
      ordinal: 0,
      runId: admitted.run.id,
      threadId: thread.id,
      type: "run.started",
      workspaceId,
    };
    await store.commitRunnerEvent({ environmentId, event: started, runnerBootId, runnerId });
    return { runId: admitted.run.id, runnerId, threadId: thread.id };
  }

  async function pendingSignIns(ownerId: UserId) {
    return database
      .selectFrom("requests")
      .select(["id", "payload"])
      .where("requestedBy", "=", ownerId)
      .where("kind", "=", "browser.sign-in")
      .where("status", "=", "pending")
      .orderBy("createdAt", "asc")
      .execute();
  }

  function remoteRoute(origin: string, generation: number) {
    return {
      document: { route: { origin, generation } },
    } as unknown as PersonalHostAccessRouteEnvelope;
  }

  /** An owner, a specialized Workspace, a running agent in it, and a live fresh session. */
  async function scene() {
    const ownerId = await store.createUser("Chrome owner");
    await store.ensureDeployment({
      canonicalOrigin: sourceOrigin,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
    });
    const workspace = await store.createWorkspace({
      kind: "specialized",
      backing: {
        kind: "portablefs",
        generation: 1,
        serviceId: "test-portablefs",
        volumeId: `test-${randomUUID()}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: randomUUID(),
      name: "Sign-in test",
      status: "ready",
    });
    const run = await runningRun(ownerId, workspace.id);
    runtime.runnerId = run.runnerId;
    const opened = await browser.start({
      fresh: true,
      ownerId,
      placement: { kind: "runner", runnerId: run.runnerId },
      workspaceId: workspace.id,
    });
    const connection = runtime.connections.at(-1);
    if (!connection) throw new Error("Expected a runtime connection");
    return {
      agent: {
        canRequest: true,
        loginFill: true,
        ownerId,
        reason: "Open the dashboard",
        runId: run.runId,
        sessionId: opened.session.id,
        targetId: "target-1",
        threadId: run.threadId,
        workspaceId: workspace.id,
      },
      connection,
      ownerId,
      sessionId: opened.session.id,
      workspaceId: workspace.id,
    };
  }

  /** A scene whose session runs on a Mac with Opensteer Passwords on. */
  async function disconnectRuntime(ready: Awaited<ReturnType<typeof scene>>): Promise<void> {
    ready.connection.disconnectAuthority();
    ready.connection.close(1011, "Fixture runtime disconnected");
    await waitFor(
      async () =>
        (await store.getBrowserSessionForOwner(ready.sessionId, ready.ownerId))?.state === "failed",
    );
  }

  async function passwordScene() {
    runtime.signIn = true;
    try {
      return await scene();
    } finally {
      runtime.signIn = false;
    }
  }

  async function passwordRequest(requestId: string) {
    const request = await store.requests.get(requestId as Parameters<typeof store.requests.get>[0]);
    if (!request || request.payload.kind !== "browser.password-sign-in") {
      throw new Error("Expected a password sign-in Request");
    }
    return { payload: request.payload, request };
  }

  async function continuationCount(requestId: string): Promise<number> {
    const rows = await database
      .selectFrom("requestContinuations")
      .select("requestId")
      .where("requestId", "=", requestId as Parameters<typeof store.requests.get>[0])
      .execute();
    return rows.length;
  }

  async function startedPasswordSignIn(site = "https://example.test") {
    const ready = await passwordScene();
    const result = await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
    if (result.status !== "pending") throw new Error(`Expected pending, got ${result.status}`);
    await waitFor(() => ready.connection.signInStarts().length === 1);
    const start = ready.connection.signInStarts()[0]!;
    return { ...ready, requestId: result.requestId, site, start };
  }

  async function passwordRequestCount(runId: Parameters<typeof service.agentSignIn>[0]["runId"]) {
    return (
      await database
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "browser.password-sign-in")
        .where("originatingRunId", "=", runId)
        .execute()
    ).length;
  }

  it("returns and replays autonomous joins without a Request or continuation", async () => {
    const ready = await passwordScene();
    ready.connection.onStart = (message) =>
      ready.connection.replySignIn(message.operationId, authorized());
    const calls = Array.from({ length: 6 }, () => randomUUID());
    const results = await Promise.all(
      calls.map((callId) =>
        service.agentSignIn({
          ...ready.agent,
          callId,
          site: "https://autonomous.test",
        }),
      ),
    );
    expect(results).toEqual(
      calls.map(() => ({
        site: "https://autonomous.test",
        status: "ready",
        account: "t•••@example.test",
        loginRef: authorized().loginRef,
      })),
    );
    expect(ready.connection.signInStarts()).toHaveLength(1);
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
    for (const callId of calls)
      expect(
        await service.agentSignIn({ ...ready.agent, callId, site: "https://autonomous.test" }),
      ).toEqual(results[0]);
    await expect(
      service.agentSignIn({ ...ready.agent, callId: calls[0]!, site: "https://different.test" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(ready.connection.signInStarts()[0]).toMatchObject({ workspaceId: ready.workspaceId });
    expect(ready.connection.received.find((m) => m.type === "signin.probe")).toEqual({
      type: "signin.probe",
      site: "https://autonomous.test",
    });
  });

  it.each([true, false])("allows unattended sign-in when canRequest is %s", async (canRequest) => {
    const ready = await passwordScene();
    ready.connection.onStart = (message) =>
      ready.connection.replySignIn(message.operationId, {
        ...authorized(),
      });
    expect(
      await service.agentSignIn({
        ...ready.agent,
        canRequest,
        callId: randomUUID(),
        site: "https://delegated-grant.test",
      }),
    ).toEqual({
      site: "https://delegated-grant.test",
      status: "ready",
      account: "t•••@example.test",
      loginRef: authorized().loginRef,
    });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
  });

  it.each([
    {
      outcome: { kind: "unavailable", reason: "passwords-off" },
      status: "unavailable",
      reason: "passwords-off",
    },
    {
      outcome: { kind: "unavailable", reason: "not-set-up" },
      status: "unavailable",
      reason: "passwords-not-set-up",
    },
    {
      outcome: { kind: "unavailable", reason: "not-responding" },
      status: "unavailable",
      reason: "passwords-not-responding",
    },
    { outcome: { kind: "expired" }, status: "unavailable", reason: "expired" },
    { outcome: { kind: "cancelled", reason: "expired" }, status: "unavailable", reason: "expired" },
    {
      outcome: { kind: "cancelled", reason: "authority-lost" },
      status: "unavailable",
      reason: "interrupted",
    },
    {
      outcome: { kind: "cancelled", reason: "withdrawn" },
      status: "unavailable",
      reason: "interrupted",
    },
  ] as const)("returns direct $reason without asking", async ({ outcome, status, reason }) => {
    const ready = await passwordScene();
    const site = "https://direct-failure.test";
    ready.connection.onStart = (message) =>
      ready.connection.replySignIn(message.operationId, outcome);
    expect(await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site })).toEqual({
      status,
      reason,
      site,
    });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
    expect(await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site })).toEqual({
      status,
      reason,
      site,
    });
    expect(ready.connection.signInStarts()).toHaveLength(2);
  });

  it.each([true, false])(
    "preserves another Run's open Request when canRequest is %s",
    async (canRequest) => {
      const ready = await startedPasswordSignIn("https://cross-run.test");
      const other = await runningRun(ready.ownerId, ready.workspaceId, runtime.runnerId!);
      expect(
        await service.agentSignIn({
          ...ready.agent,
          ...other,
          callId: randomUUID(),
          site: ready.site,
          canRequest,
        }),
      ).toEqual({
        status: "unavailable",
        site: ready.site,
        reason: "busy",
      });
      expect(ready.connection.signInCancels()).toHaveLength(0);
      expect((await passwordRequest(ready.requestId)).request.status).toBe("pending");
      ready.connection.replySignIn(ready.start.operationId, {
        ...authorized(),
      });
      await waitFor(async () => (await continuationCount(ready.requestId)) === 1);
      expect(await passwordRequestCount(other.runId)).toBe(0);
    },
  );

  it.each(["authorized", "approval"] as const)(
    "lets another Run join unattended work until $0",
    async (outcome) => {
      const ready = await passwordScene();
      const other = await runningRun(ready.ownerId, ready.workspaceId, runtime.runnerId!);
      const site = "https://joining-runtime.test";
      const started = Promise.withResolvers<string>();
      ready.connection.onStart = (message) => started.resolve(message.operationId);
      // Freeze the unattended budget while the second Run reaches the operation.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const starter = service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
        const operationId = await started.promise;
        const observedJoin = Promise.withResolvers<{
          operation: ReturnType<typeof passwords.join>;
        }>();
        const join = passwords.join.bind(passwords);
        vi.spyOn(passwords, "join").mockImplementation((input) => {
          const result = join(input);
          if (input.runId === other.runId) {
            observedJoin.resolve({ operation: result });
          }
          return result;
        });
        const joined = service.agentSignIn({
          ...ready.agent,
          ...other,
          callId: randomUUID(),
          site,
        });
        const { operation } = await observedJoin.promise;
        expect(operation).not.toBeNull();
        if (outcome === "approval") ready.connection.needSignIn(operationId, "approval");
        else
          ready.connection.replySignIn(operationId, {
            ...authorized(),
          });
        expect(await joined).toEqual(
          outcome === "approval"
            ? { status: "unavailable", reason: "busy", site }
            : {
                status: "ready",
                site,
                account: "t•••@example.test",
                loginRef: authorized().loginRef,
              },
        );
        expect((await starter).status).toBe(outcome === "approval" ? "pending" : "ready");
        expect(ready.connection.signInStarts()).toHaveLength(1);
        expect(ready.connection.signInCancels()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports a closed session when it ends at Chrome Request insertion", async () => {
    const ready = await passwordScene();
    const site = "https://insert-ended-session.test";
    ready.connection.passwords = "off";
    const create = store.requests.create.bind(store.requests);
    vi.spyOn(store.requests, "create").mockImplementationOnce(async (input) => {
      expect(input.kind).toBe("browser.sign-in");
      await disconnectRuntime(ready);
      return create(input);
    });
    await expect(
      service.agentSignIn({ ...ready.agent, callId: randomUUID(), site }),
    ).resolves.toEqual({ status: "unavailable", reason: "session-closed", site });
    expect(
      await database
        .selectFrom("requests")
        .select("id")
        .where("originatingRunId", "=", ready.agent.runId)
        .execute(),
    ).toEqual([]);
  });

  it("reports a closed session when its broker ended before persistence", async () => {
    const ready = await passwordScene();
    const transitionStarted = Promise.withResolvers<void>();
    const releaseTransition = Promise.withResolvers<void>();
    const transition = store.transitionBrowserSession.bind(store);
    vi.spyOn(store, "transitionBrowserSession").mockImplementationOnce(async (input) => {
      expect(input.state).toBe("failed");
      transitionStarted.resolve();
      await releaseTransition.promise;
      return transition(input);
    });
    const stopping = disconnectRuntime(ready);
    try {
      await transitionStarted.promise;
      expect((await store.getBrowserSessionForOwner(ready.sessionId, ready.ownerId))?.state).toBe(
        "ready",
      );
      expect(
        (await browser.signInTarget({ ownerId: ready.ownerId, sessionId: ready.sessionId }))?.live,
      ).toBe(false);
    } finally {
      releaseTransition.resolve();
      await stopping;
    }
  });

  it.each(["conflict", "internal"] as const)(
    "preserves a %s Request insertion failure other than a closed session",
    async (code) => {
      const ready = await passwordScene();
      ready.connection.passwords = "off";
      const error = new OpensteerError({ code, message: "Another Request insertion failure" });
      vi.spyOn(store.requests, "create").mockImplementationOnce(async () => {
        // The session ending meanwhile does not make another refusal a closed session.
        await disconnectRuntime(ready);
        throw error;
      });
      try {
        await expect(
          service.agentSignIn({
            ...ready.agent,
            callId: randomUUID(),
            site: "https://insert-failure.test",
          }),
        ).rejects.toBe(error);
      } finally {
        await disconnectRuntime(ready);
      }
    },
  );

  it("retains settlement retries when the vault disconnects while a Request opens", async () => {
    const ready = await passwordScene();
    beforeOpen = async () => {
      beforeOpen = null;
      ready.connection.disconnectAuthority();
      ready.connection.close(1011, "session closed during insert");
      await waitFor(
        async () =>
          !(await browser.signInTarget({ ownerId: ready.ownerId, sessionId: ready.sessionId }))
            ?.live,
      );
      settleFaults = 1;
    };
    const answer = await service.agentSignIn({
      ...ready.agent,
      callId: randomUUID(),
      site: "https://close-open.test",
    });
    if (!("requestId" in answer)) throw new Error("Expected created Request");
    await waitFor(
      async () => (await passwordRequest(answer.requestId)).request.status === "fulfilled",
    );
    expect((await passwordRequest(answer.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "interrupted" },
    });
    expect(await continuationCount(answer.requestId)).toBe(1);
    expect(passwordSignInErrors).toHaveLength(1);
  });

  it("allows a fresh call after decline while replaying the declined call", async () => {
    const ready = await passwordScene();
    const site = "https://decline-retry.test";
    const input = { ...ready.agent, callId: randomUUID(), site };
    const first = await service.agentSignIn(input);
    if (first.status !== "pending") throw new Error("Expected pending");
    await service.declinePasswordSignIn({ ownerId: ready.ownerId, requestId: first.requestId });
    expect(await service.agentSignIn(input)).toEqual({
      status: "declined",
      requestId: first.requestId,
    });
    ready.connection.onStart = (message) =>
      ready.connection.replySignIn(message.operationId, {
        ...authorized(),
      });
    expect(await service.agentSignIn({ ...input, callId: randomUUID() })).toEqual({
      status: "ready",
      account: "t•••@example.test",
      loginRef: authorized().loginRef,
      site,
    });
    expect(ready.connection.signInStarts()).toHaveLength(2);
  });

  it("cleans and clips requester display names before runtime validation", async () => {
    const ready = await passwordScene();
    description = {
      ...description,
      deploymentName: "D".repeat(118) + "\u0000🫡",
      threadTitle: "Thread\n\u200b".repeat(40),
      workspaceName: "Work\tspace\u202e".repeat(20),
    };
    expect(
      (
        await service.agentSignIn({
          ...ready.agent,
          callId: randomUUID(),
          site: "https://requester.test",
        })
      ).status,
    ).toBe("pending");
    const requester = ready.connection.signInStarts()[0]!.requester;
    expect(requester.deploymentName.length).toBeLessThanOrEqual(120);
    expect(requester.threadTitle.length).toBeLessThanOrEqual(200);
    expect(requester.workspaceName.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(requester)).not.toMatch(/\\[nt]|\\u0000|[\u202e\u200b]/u);
    for (const name of [requester.deploymentName, requester.threadTitle, requester.workspaceName]) {
      expect(name).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    }
    expect(ready.connection.readyState).toBe(WebSocket.OPEN);
  });

  it("clears waitingFor after approval while the same Request signs in", async () => {
    const ready = await startedPasswordSignIn("https://approved-stage.test");
    ready.connection.needSignIn(ready.start.operationId, null);
    const answer = await service.agentSignIn({
      ...ready.agent,
      site: ready.site,
      callId: randomUUID(),
    });
    expect(answer).toMatchObject({ status: "pending", requestId: ready.requestId });
    expect(answer).not.toHaveProperty("waitingFor");
    expect(ready.connection.readyState).toBe(WebSocket.OPEN);
    expect(ready.connection.signInCancels()).toHaveLength(0);
  });

  it("does not close a session over local requester validation", async () => {
    const ready = await passwordScene();
    const target = await browser.signInTarget({
      ownerId: ready.ownerId,
      sessionId: ready.sessionId,
    });
    if (!target) throw new Error("Expected target");
    await expect(
      passwords.request({
        ...ready.agent,
        callId: randomUUID(),
        site: "https://invalid-requester.test",
        reason: "",
        admitStart: () => true,
      }),
    ).rejects.toThrow();
    expect(ready.connection.signInStarts()).toHaveLength(0);
    expect(ready.connection.readyState).toBe(WebSocket.OPEN);
  });

  it("returns no-saved-login when Passwords has no login and no Chrome is available", async () => {
    const ready = await passwordScene();
    ready.connection.passwords = "no-login";
    expect(
      await service.agentSignIn({
        ...ready.agent,
        callId: randomUUID(),
        site: "https://manual.test",
      }),
    ).toEqual({ status: "unavailable", reason: "no-saved-login", site: "https://manual.test" });
    expect(ready.connection.signInStarts()).toHaveLength(0);
  });

  it.each(["has-login", "no-login"] as const)(
    "routes %s against available Chrome",
    async (availability) => {
      const ready = await passwordScene();
      ready.connection.passwords = availability;
      const paired = await pairChrome(ready.ownerId, "Chrome");
      const chrome = await connectChrome(paired);
      try {
        const result = await service.agentSignIn({
          ...ready.agent,
          callId: randomUUID(),
          site: "https://routing.test",
        });
        expect(result.status).toBe("pending");
        if (result.status !== "pending") throw new Error("Expected pending");
        expect((await store.requests.get(result.requestId))?.kind).toBe(
          availability === "has-login" ? "browser.password-sign-in" : "browser.sign-in",
        );
        expect(ready.connection.signInStarts()).toHaveLength(availability === "has-login" ? 1 : 0);
      } finally {
        await chrome.close();
      }
    },
  );

  it("keeps an existing Chrome grant ahead of Passwords", async () => {
    const ready = await passwordScene();
    const paired = await pairChrome(ready.ownerId, "Chrome");
    const chrome = await connectChrome(paired);
    const site = "https://chrome-grant.test";
    try {
      await sourceStore.upsertGrant({
        ownerId: ready.ownerId,
        workspaceId: ready.workspaceId,
        preferredSourceId: paired.sourceId,
        site,
      });
      expect(
        await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site }),
      ).toMatchObject({ status: "applied" });
      expect(ready.connection.signInStarts()).toHaveLength(0);
      expect(ready.connection.received.filter((m) => m.type === "signin.probe")).toHaveLength(0);
    } finally {
      await chrome.close();
    }
  });

  it("settles a result racing the atomic lazy open exactly once", async () => {
    const ready = await passwordScene();
    beforeOpen = async () => {
      const start = ready.connection.signInStarts()[0]!;
      ready.connection.replySignIn(start.operationId, {
        ...authorized(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const result = await service.agentSignIn({
      ...ready.agent,
      callId: randomUUID(),
      site: "https://open-race.test",
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("Expected resolved");
    expect(await continuationCount(result.requestId)).toBe(1);
    expect((await passwordRequest(result.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "authorized", account: "t•••@example.test" },
    });
  });

  it("cancels authorization if lazy Request creation fails", async () => {
    const ready = await passwordScene();
    openFault = true;
    const site = "https://open-failure.test";
    const result = await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
    expect(result).toEqual({ status: "unavailable", reason: "interrupted", site });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
    expect(ready.connection.signInCancels()[0]).toMatchObject({ reason: "authority-lost" });
    expect(
      await browser.signInTarget({ ownerId: ready.ownerId, sessionId: ready.sessionId }),
    ).toMatchObject({ live: true });
  });

  it("rechecks live Run authority while opening a Request", async () => {
    const ready = await passwordScene();
    beforeOpen = async () => {
      await database
        .updateTable("runs")
        .set({ status: "completed" })
        .where("id", "=", ready.agent.runId)
        .execute();
    };
    expect(
      await service.agentSignIn({
        ...ready.agent,
        callId: randomUUID(),
        site: "https://run-ended.test",
      }),
    ).toMatchObject({ status: "unavailable", reason: "interrupted" });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
  });

  it("cancels a silent operation without inventing a human need", async () => {
    const ready = await passwordScene();
    ready.connection.onStart = () => undefined;
    const site = "https://silent-start.test";
    expect(await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site })).toEqual({
      status: "unavailable",
      reason: "passwords-not-responding",
      site,
    });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
    expect(
      await browser.signInTarget({ ownerId: ready.ownerId, sessionId: ready.sessionId }),
    ).toMatchObject({ live: true });
  });

  it("refuses a Workspace whose membership disappeared before the lazy open", async () => {
    const ready = await passwordScene();
    beforeOpen = async () => {
      await database
        .deleteFrom("workspaceMemberships")
        .where("workspaceId", "=", ready.workspaceId)
        .where("userId", "=", ready.ownerId)
        .execute();
    };
    expect(
      await service.agentSignIn({
        ...ready.agent,
        callId: randomUUID(),
        site: "https://revoked-workspace.test",
      }),
    ).toMatchObject({ status: "unavailable", reason: "interrupted" });
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
    expect(ready.connection.signInCancels()[0]).toMatchObject({ reason: "authority-lost" });
  });

  it("bounds a stuck start write without holding operation admission", async () => {
    const ready = await passwordScene();
    ready.connection.holdStartAck = true;
    ready.connection.onStart = () => undefined;
    const site = "https://stuck-write.test";
    // Release both calls into the site's admission together. Otherwise their
    // own database reads can land the second after the first settled, 40 ms
    // in, and it rightly starts its own attempt, as the last call checks.
    const request = passwords.request.bind(passwords);
    const arrived: (() => void)[] = [];
    const together = vi.spyOn(passwords, "request").mockImplementation(async (input) => {
      const turn = Promise.withResolvers<void>();
      arrived.push(turn.resolve);
      if (arrived.length === 2) for (const release of arrived) release();
      await turn.promise;
      return request(input);
    });
    const results = await Promise.all(
      [0, 1].map(() => service.agentSignIn({ ...ready.agent, callId: randomUUID(), site })),
    );
    together.mockRestore();
    expect(results).toEqual(
      [0, 1].map(() => ({ status: "unavailable", reason: "passwords-not-responding", site })),
    );
    expect(ready.connection.signInStarts()).toHaveLength(1);
    expect(await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site })).toEqual({
      status: "unavailable",
      reason: "passwords-not-responding",
      site,
    });
    expect(ready.connection.signInStarts()).toHaveLength(2);
    expect(await passwordRequestCount(ready.agent.runId)).toBe(0);
  });

  it("asks the Mac, never the Host, for a saved-password sign-in and settles once from its answer", async () => {
    const { connection, payload, requestId, site, start } = await (async () => {
      const started = await startedPasswordSignIn();
      return { ...started, payload: (await passwordRequest(started.requestId)).payload };
    })();
    expect(payload).toMatchObject({
      computerName: "Test Mac",
      kind: "browser.password-sign-in",
      operationId: start.operationId,
      scope: "workspace",
      permissionVersion: 5,
      site,
    });
    expect(payload).not.toHaveProperty("sessionId");
    expect(start).toMatchObject({
      requester: { deploymentName: "Test", threadTitle: "Test thread", workspaceName: "Main" },
      site,
    });
    expect(Date.parse(start.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(connection.received.map((message) => message.type)).toEqual(
      expect.arrayContaining(["signin.probe", "login.authorize"]),
    );
    expect(connection.imports()).toEqual([]);

    connection.replySignIn(start.operationId, authorized());
    await waitFor(async () => (await passwordRequest(requestId)).request.status === "fulfilled");
    const { request } = await passwordRequest(requestId);
    expect(request.response).toEqual({
      kind: "external",
      value: { outcome: "authorized", account: "t•••@example.test" },
    });
    expect(await continuationCount(requestId)).toBe(1);
    // A second answer for the same operation changes nothing.
    connection.replySignIn(start.operationId, { kind: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await passwordRequest(requestId)).request.status).toBe("fulfilled");
    expect(await continuationCount(requestId)).toBe(1);
  });

  it("keeps Chrome for a Mac with Passwords off, and refuses delegated approvals", async () => {
    const ready = await passwordScene();
    ready.connection.passwords = "off";
    const site = "https://off.test";
    const chromeResult = await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
    expect(chromeResult.status).toBe("pending");
    expect(ready.connection.signInStarts()).toEqual([]);
    expect((await pendingSignIns(ready.ownerId)).length).toBe(1);

    ready.connection.passwords = "has-login";
    const delegated = {
      ...ready.agent,
      callId: randomUUID(),
      canRequest: false,
      site: "https://delegated.test",
    };
    const refused = { reason: "needs-approval", site: delegated.site, status: "unavailable" };
    expect(await service.agentSignIn(delegated)).toEqual(refused);
    // A replay after the actual maintenance tick must retain the same refusal.
    reconcilePasswords();
    await Promise.resolve();
    expect(await service.agentSignIn(delegated)).toEqual(refused);
    expect(ready.connection.signInStarts()).toHaveLength(1);
    expect(ready.connection.signInCancels()).toHaveLength(1);
  });

  it("replays a repeated call as its own Request, then as resolved once it ended", async () => {
    const ready = await passwordScene();
    const site = "https://replay.test";
    const callId = randomUUID();
    const first = await service.agentSignIn({ ...ready.agent, callId, site });
    if (first.status !== "pending") throw new Error("Expected pending");
    expect(await service.agentSignIn({ ...ready.agent, callId, site })).toEqual({
      replayed: true,
      requestId: first.requestId,
      status: "pending",
    });
    // Another call for the same session and site joins the open Request.
    const joinedCallId = randomUUID();
    expect(await service.agentSignIn({ ...ready.agent, callId: joinedCallId, site })).toEqual({
      replayed: true,
      requestId: first.requestId,
      status: "pending",
    });
    await waitFor(() => ready.connection.signInStarts().length === 1);
    const start = ready.connection.signInStarts()[0]!;
    ready.connection.replySignIn(start.operationId, { kind: "expired" });
    await waitFor(
      async () => (await passwordRequest(first.requestId)).request.status !== "pending",
    );
    expect(await service.agentSignIn({ ...ready.agent, callId, site })).toEqual({
      requestId: first.requestId,
      status: "resolved",
    });
    // The joined call's replay learns the same Request's end, and the person
    // is not asked again.
    expect(await service.agentSignIn({ ...ready.agent, callId: joinedCallId, site })).toEqual({
      requestId: first.requestId,
      status: "resolved",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ready.connection.signInStarts()).toHaveLength(1);
    expect((await passwordRequest(first.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "expired" },
    });
  });

  it("asks the person once when calls for one site race", async () => {
    const ready = await passwordScene();
    const site = "https://race.test";
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.agentSignIn({ ...ready.agent, callId: randomUUID(), site }),
      ),
    );
    const requestIds = new Set(
      results.map((result) => {
        if (result.status !== "pending") throw new Error(`Expected pending, got ${result.status}`);
        return result.requestId;
      }),
    );
    expect(requestIds.size).toBe(1);
    await waitFor(() => ready.connection.signInStarts().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ready.connection.signInStarts()).toHaveLength(1);
    const open = await database
      .selectFrom("requests")
      .select("id")
      .where("kind", "=", "browser.password-sign-in")
      .where("originatingRunId", "=", ready.agent.runId)
      .where("status", "=", "pending")
      .execute();
    expect(open).toHaveLength(1);
  });

  it("settles a decline from what the Mac reports", async () => {
    const declined = await startedPasswordSignIn("https://decline.test");
    expect(
      await service.declinePasswordSignIn({
        ownerId: declined.ownerId,
        requestId: declined.requestId as Parameters<typeof store.requests.get>[0],
      }),
    ).toBe("declined");
    expect(declined.connection.signInCancels()).toMatchObject([
      { operationId: declined.start.operationId, reason: "declined" },
    ]);
    expect(await continuationCount(declined.requestId)).toBe(1);
  });

  it("settles decline and refuses a late authorization when the Mac never answers", async () => {
    const silent = await startedPasswordSignIn("https://silent.test");
    silent.connection.onCancel = () => undefined;
    expect(
      await service.declinePasswordSignIn({
        ownerId: silent.ownerId,
        requestId: silent.requestId as Parameters<typeof store.requests.get>[0],
      }),
    ).toBe("declined");
    expect(silent.connection.readyState).toBe(WebSocket.OPEN);
    // A late answer for a Request the person declined is never recorded.
    silent.connection.replySignIn(silent.start.operationId, {
      ...authorized(),
    });
    expect((await passwordRequest(silent.requestId)).request.status).toBe("declined");
  });

  it("keeps approval after the browser closes, then settles from the independent vault", async () => {
    const ended = await startedPasswordSignIn("https://ended.test");
    ended.connection.close(1011, "browser gone, vault still connected");
    await waitFor(
      async () =>
        (await store.getBrowserSessionForOwner(ended.sessionId, ended.ownerId))?.state === "failed",
    );
    expect((await passwordRequest(ended.requestId)).request.status).toBe("pending");
    expect(await continuationCount(ended.requestId)).toBe(0);
    expect(ended.connection.signInCancels()).toEqual([]);
    ended.connection.replySignIn(ended.start.operationId, {
      ...authorized(),
      loginRef: ended.start.loginRef,
      expiresAt: ended.start.expiresAt,
    });
    await waitFor(
      async () => (await passwordRequest(ended.requestId)).request.status === "fulfilled",
    );
    expect((await passwordRequest(ended.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "authorized", account: "t•••@example.test" },
    });
    expect(await continuationCount(ended.requestId)).toBe(1);
  });

  it("records a sign-in the store failed to record, and keeps its session", async () => {
    const landed = await startedPasswordSignIn("https://store-retry.test");
    settleFaults = 1;
    landed.connection.replySignIn(landed.start.operationId, {
      ...authorized(),
    });
    await waitFor(
      async () => (await passwordRequest(landed.requestId)).request.status === "fulfilled",
    );
    expect((await passwordRequest(landed.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "authorized", account: "t•••@example.test" },
    });
    expect(landed.connection.readyState).toBe(WebSocket.OPEN);
    expect(await continuationCount(landed.requestId)).toBe(1);
  });

  it("records a sign-in the Mac stopped itself as interrupted, and keeps the session", async () => {
    const stopped = await startedPasswordSignIn("https://interrupted.test");
    stopped.connection.replySignIn(stopped.start.operationId, {
      kind: "cancelled",
      reason: "authority-lost",
    });
    await waitFor(
      async () => (await passwordRequest(stopped.requestId)).request.status !== "pending",
    );
    expect((await passwordRequest(stopped.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "interrupted" },
    });
    expect(stopped.connection.readyState).toBe(WebSocket.OPEN);
    expect(await continuationCount(stopped.requestId)).toBe(1);
  });

  it("expires authorization when the Mac stays silent past the deadline", async () => {
    const late = await startedPasswordSignIn("https://deadline.test");
    clockOffsetMs = 61 * 60_000;
    try {
      await waitFor(() => late.connection.signInCancels().length > 0);
      await waitFor(
        async () => (await passwordRequest(late.requestId)).request.status !== "pending",
      );
      expect((await passwordRequest(late.requestId)).request.response).toEqual({
        kind: "external",
        value: { outcome: "expired" },
      });
    } finally {
      clockOffsetMs = 0;
    }
  });

  it("keeps the lease when authorization settles during reconciliation's Request read", async () => {
    const ready = await startedPasswordSignIn("https://reconcile-approval.test");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const get = store.requests.get.bind(store.requests);
    vi.spyOn(store.requests, "get").mockImplementationOnce(async (requestId) => {
      entered.resolve();
      await release.promise;
      const request = await get(requestId);
      returned.resolve();
      return request;
    });
    try {
      await entered.promise;
      ready.connection.replySignIn(ready.start.operationId, {
        ...authorized(),
        expiresAt: ready.start.expiresAt,
      });
      await waitFor(
        async () => (await passwordRequest(ready.requestId)).request.status === "fulfilled",
      );
      expect(passwords.leaseForOperation(ready.start.operationId)?.loginRef).toBe(
        authorized().loginRef,
      );
      release.resolve();
      await returned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(passwords.leaseForOperation(ready.start.operationId)?.loginRef).toBe(
        authorized().loginRef,
      );
      expect(ready.connection.signInCancels()).toEqual([]);
    } finally {
      release.resolve();
    }
  });

  it("expires a live lease and reacquires without replaying the expired reference", async () => {
    const ready = await passwordScene();
    const site = "https://lease-deadline.test";
    ready.connection.onStart = (message) =>
      ready.connection.replySignIn(message.operationId, {
        ...authorized(),
        expiresAt: message.expiresAt,
      });
    const first = await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("Expected ready");
    expect(
      passwords.validateLease({
        loginRef: first.loginRef,
        workspaceId: ready.workspaceId,
      }),
    ).toBe(true);
    try {
      clockOffsetMs = 61 * 60_000;
      expect(
        passwords.validateLease({
          loginRef: first.loginRef,
          workspaceId: ready.workspaceId,
        }),
      ).toBe(false);
      ready.connection.onStart = (message) =>
        ready.connection.replySignIn(message.operationId, {
          ...authorized(),
          loginRef: message.loginRef,
          expiresAt: message.expiresAt,
        });
      const next = await service.agentSignIn({ ...ready.agent, callId: randomUUID(), site });
      const nextRef = ready.connection.signInStarts()[1]!.loginRef;
      expect(nextRef).not.toBe(first.loginRef);
      expect(next).toEqual({
        status: "ready",
        site,
        account: "t•••@example.test",
        loginRef: nextRef,
      });
      expect(ready.connection.signInStarts()).toHaveLength(2);
      expect(ready.connection.signInCancels()).toContainEqual(
        expect.objectContaining({ reason: "expired" }),
      );
    } finally {
      clockOffsetMs = 0;
    }
  });

  it("settles sign-ins left pending by a Host restart", async () => {
    const orphan = await startedPasswordSignIn("https://restart.test");
    const restarted = new PasswordSignInService({
      authority: passwordAuthority,
      resolveAuthority: resolvePasswordAuthority,
      describe: async () => ({
        deploymentId: "dep_test",
        deploymentName: "Test",
        threadTitle: "Test thread",
        workspaceName: "Main",
      }),
      onRequestResolved: () => {},
      onWorkspaceEvent: () => {},
      requests: store.requests,
    });
    try {
      await restarted.sweepAfterRestart();
    } finally {
      restarted.close();
    }
    expect((await passwordRequest(orphan.requestId)).request.response).toEqual({
      kind: "external",
      value: { outcome: "interrupted" },
    });
    expect(await continuationCount(orphan.requestId)).toBe(1);
  });

  it("pairs and proves canonical HTTPS authority through a proxy without forwarded protocol", async () => {
    const ownerId = await store.createUser("Canonical proxy source owner");
    const pairing = await service.createPairing({ ownerId, route: null });
    const host = Fastify();
    await host.register(websocket);
    registerBrowserSourceWire(host, service, sourceOrigin);
    const hostAddress = await host.listen({ host: "127.0.0.1", port: 0 });
    const upstreamPort = Number(new URL(hostAddress).port);
    const canonicalHost = new URL(sourceOrigin).host;
    const proxy = createServer((request, response) => {
      const headers: Record<string, string | string[] | undefined> = {
        ...request.headers,
        host: canonicalHost,
      };
      delete headers["x-forwarded-proto"];
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: upstreamPort,
          path: request.url,
          method: request.method,
          headers,
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      request.pipe(upstream);
    });
    proxy.on("upgrade", (request, downstream, head) => {
      const upstream = connectTcp(upstreamPort, "127.0.0.1", () => {
        const headers = Object.entries(request.headers)
          .filter(([name]) => name !== "host" && name !== "x-forwarded-proto")
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        upstream.write(
          `GET ${request.url} HTTP/1.1\r\nHost: ${canonicalHost}\r\n${headers}\r\n\r\n`,
        );
        if (head.byteLength > 0) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Expected proxy port");
    let client: WebSocket | null = null;
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/internal/v1/browser-sources/pair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: canonicalHost,
            origin: `chrome-extension://${"a".repeat(32)}`,
          },
          body: JSON.stringify({
            code: pairing.code,
            name: "Proxy Chrome",
            replaces: null,
            version: browserSourceProtocolVersion,
            ...sourceDestination,
          }),
        },
      );
      expect(response.status).toBe(200);
      const paired = (await response.json()) as { sourceId: string; token: string };
      client = new WebSocket(
        `ws://127.0.0.1:${proxyAddress.port}/internal/v1/browser-sources/connect`,
        {
          headers: { Host: canonicalHost, Origin: `chrome-extension://${"a".repeat(32)}` },
        },
      );
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      const connected = new Promise<void>((resolve) => {
        client!.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            type: string;
            nonce?: string;
            signature?: string;
          };
          if (message.type === "source.proof") {
            expect(
              verify(
                null,
                browserSourceChallengeBytes({
                  ...sourceDestination,
                  sourceId: paired.sourceId as ReturnType<typeof createId<"browserSource">>,
                  nonce: message.nonce!,
                }),
                hostKey.publicKey,
                Buffer.from(message.signature!, "base64url"),
              ),
            ).toBe(true);
            client!.send(
              JSON.stringify({
                type: "source.hello",
                sourceId: paired.sourceId,
                token: paired.token,
                version: browserSourceProtocolVersion,
              }),
            );
          }
          if (message.type === "source.ready") resolve();
        });
      });
      client.send(
        JSON.stringify({
          type: "source.challenge",
          sourceId: paired.sourceId,
          nonce: randomUUID(),
          ...sourceDestination,
        }),
      );
      await connected;
    } finally {
      client?.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await host.close();
    }
  });

  it("rejects stale remote route pairing without consuming the local pairing code", async () => {
    const ownerId = await store.createUser("Route source owner");
    const remoteOrigin = "https://remote-source-host.test";
    const route = (generation: number) =>
      ({
        document: { route: { origin: remoteOrigin, generation } },
      }) as unknown as PersonalHostAccessRouteEnvelope;
    currentRoute = route(1);
    const pairing = await service.createPairing({ ownerId, route: currentRoute });
    currentRoute = route(2);
    await expect(
      service.pair(
        {
          code: pairing.code,
          name: "Stale remote",
          version: browserSourceProtocolVersion,
          replaces: null,
          origin: remoteOrigin,
          routeGeneration: 1,
        },
        remoteOrigin,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.pair(
        {
          code: pairing.code,
          name: "Changed remote",
          version: browserSourceProtocolVersion,
          replaces: null,
          origin: remoteOrigin,
          routeGeneration: 2,
        },
        remoteOrigin,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const local = await service.pair(
      {
        code: pairing.code,
        name: "Local",
        replaces: null,
        version: browserSourceProtocolVersion,
        ...sourceDestination,
      },
      sourceOrigin,
    );
    expect(local.token).toBeTruthy();
    const fresh = await service.createPairing({ ownerId, route: currentRoute });
    const remote = await service.pair(
      {
        code: fresh.code,
        name: "Current remote",
        replaces: null,
        version: browserSourceProtocolVersion,
        origin: remoteOrigin,
        routeGeneration: 2,
      },
      remoteOrigin,
    );
    expect(remote.sourceId).not.toBe(local.sourceId);
    ingressOrigin = remoteOrigin;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    routeFault = new Error("Transient route database failure");
    const retryable = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      retryable.once("open", resolve);
      retryable.once("error", reject);
    });
    const seen: string[] = [];
    retryable.on("message", (raw) => seen.push(JSON.parse(raw.toString()).type));
    const retryableClose = new Promise<number>((resolve) => retryable.once("close", resolve));
    retryable.send(
      JSON.stringify({
        type: "source.challenge",
        sourceId: remote.sourceId,
        nonce: randomUUID(),
        origin: remoteOrigin,
        routeGeneration: 2,
      }),
    );
    await expect(retryableClose).resolves.toBe(1011);
    expect(seen).toEqual([]);
    routeFault = null;
    const admitted = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      admitted.once("open", resolve);
      admitted.once("error", reject);
    });
    const ready = new Promise<void>((resolve) => {
      admitted.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        if (message.type === "source.proof") {
          admitted.send(
            JSON.stringify({
              type: "source.hello",
              sourceId: remote.sourceId,
              token: remote.token,
              version: browserSourceProtocolVersion,
            }),
          );
        }
        if (message.type === "source.ready") resolve();
      });
    });
    admitted.send(
      JSON.stringify({
        type: "source.challenge",
        sourceId: remote.sourceId,
        nonce: randomUUID(),
        origin: remoteOrigin,
        routeGeneration: 2,
      }),
    );
    await ready;
    const disconnected = new Promise<void>((resolve) => admitted.once("close", () => resolve()));
    currentRoute = route(3);
    service.disconnectRouteAdmittedSources();
    await disconnected;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const refusal = new Promise<{ type: string; code: string; signature?: string }>((resolve) => {
      client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    const stale = {
      sourceId: local.sourceId as ReturnType<typeof createId<"browserSource">>,
      nonce: randomUUID(),
      origin: remoteOrigin,
      routeGeneration: 1,
    };
    client.send(JSON.stringify({ ...stale, type: "source.challenge" }));
    // Refused before any connection proof, so the notice proves the Host
    // signed it over this very challenge; the extension trusts nothing less.
    const refused = await refusal;
    expect(refused).toEqual({
      type: "source.error",
      code: "route-changed",
      signature: expect.any(String),
    });
    expect(
      verify(
        null,
        browserSourceRouteChangedBytes(stale),
        hostKey.publicKey,
        Buffer.from(refused.signature!, "base64url"),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        browserSourceChallengeBytes(stale),
        hostKey.publicKey,
        Buffer.from(refused.signature!, "base64url"),
      ),
    ).toBe(false);
    client.close();
  });

  it("signs a live session in, replays by invocation, and fences a Chrome revoked mid-transfer", async () => {
    const { agent, connection, ownerId, sessionId, workspaceId } = await scene();
    const paired = await pairChrome(ownerId, "Chrome on Mac");
    const chrome = await connectChrome(paired);
    const site = "https://example.test";

    expect(
      await service.sessionSignIn({
        idempotencyKey: randomUUID(),
        ownerId,
        sessionId,
        sourceId: null,
        url: "https://www.example.test/dashboard",
      }),
    ).toEqual({ profileName: null, site, sourceName: "Chrome on Mac", status: "applied" });
    expect(connection.imports()).toEqual([
      expect.objectContaining({ cookies: chrome.cookiesFor(site), site, type: "state.import" }),
    ]);
    expect(await service.listState({ ownerId })).toMatchObject({
      sites: [{ preferredSourceId: paired.sourceId, site, workspaceId }],
      sources: [{ connected: true, id: paired.sourceId, name: "Chrome on Mac" }],
    });

    const callId = randomUUID();
    const standing = { ...agent, callId, site: "gist.example.test" };
    expect(await service.agentSignIn(standing)).toMatchObject({ site, status: "applied" });
    expect(chrome.exports).toBe(2);
    expect(await service.agentSignIn(standing)).toMatchObject({ site, status: "applied" });
    expect(chrome.exports).toBe(2);
    expect(connection.imports()).toHaveLength(2);
    expect(new Set(connection.imports().map(({ operationId }) => operationId)).size).toBe(2);

    // Revoked after export, before import: the Host re-checks and imports nothing.
    chrome.holdExports = true;
    const fenced = service.agentSignIn({ ...agent, callId: randomUUID(), site });
    await waitFor(() => chrome.held.length === 1);
    expect(await sourceStore.revoke({ ownerId, sourceId: paired.sourceId })).toBe(true);
    chrome.releaseExports();
    expect(await fenced).toMatchObject({ status: "pending" });
    expect(connection.imports()).toHaveLength(2);

    // Viewers reach the browser, but never its identity controls.
    const peer: BrowserConsumerPeer = {
      close: () => {},
      id: "viewer",
      isOpen: () => true,
      send: async () => {},
    };
    const attachment = await browser.attach(ownerId, sessionId, peer, {
      authSessionId: createId("authSession"),
      mode: "control",
      signedIn: async () => true,
    });
    const frame = (message: unknown) => Buffer.from(JSON.stringify(message));
    await expect(
      attachment.handle(
        frame({ cookies: [], operationId: randomUUID(), site, type: "state.import" }),
        false,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await attachment.handle(frame({ type: "navigation.reload" }), false);
    attachment.close();
    expect(connection.imports()).toHaveLength(2);

    expect(connection.received.at(-1)).toEqual({ type: "navigation.reload" });
    await chrome.close();
  });

  it("completes an allowed Request by itself when Chrome reconnects as a new connection", async () => {
    const { agent, connection, ownerId, workspaceId } = await scene();
    const first = await pairChrome(ownerId, "Chrome A");
    const chromeA = await connectChrome(first);
    const site = "https://example.test";
    const callId = randomUUID();

    const asked = await service.agentSignIn({ ...agent, callId, site });
    expect(asked).toMatchObject({ replayed: false, status: "pending" });
    if (asked.status !== "pending") throw new Error("Expected a pending Request");
    expect(await service.agentSignIn({ ...agent, callId, site })).toEqual({
      replayed: true,
      requestId: asked.requestId,
      status: "pending",
    });
    expect(await service.agentSignIn({ ...agent, callId: randomUUID(), site })).toEqual({
      replayed: true,
      requestId: asked.requestId,
      status: "pending",
    });

    await chromeA.close();
    await waitFor(async () => !(await service.listState({ ownerId })).sources[0]?.connected);
    expect(
      await service.respond({
        decision: { decision: "allow", sourceId: first.sourceId },
        ownerId,
        requestId: asked.requestId,
      }),
    ).toEqual({ problem: "chrome-offline", site, sourceName: "Chrome A", status: "problem" });
    expect(await store.requests.get(asked.requestId)).toMatchObject({ status: "pending" });
    expect(await sourceStore.getGrant({ ownerId, site, workspaceId })).toMatchObject({
      preferredSourceId: first.sourceId,
    });

    const second = await pairChrome(ownerId, "Chrome A again", first);
    expect(await sourceStore.getGrant({ ownerId, site, workspaceId })).toMatchObject({
      preferredSourceId: second.sourceId,
    });
    const chromeB = await connectChrome(second);
    await waitFor(async () => (await store.requests.get(asked.requestId))?.status === "fulfilled");
    expect(await store.requests.get(asked.requestId)).toMatchObject({
      response: {
        kind: "external",
        value: { outcome: "applied", profileName: null, sourceName: "Chrome A again" },
      },
    });
    expect(connection.imports()).toHaveLength(1);
    expect(chromeB.exports).toBe(1);
    expect(resolvedRequests).toBeGreaterThan(0);
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toContain(asked.requestId);
    expect((await sourceStore.list(ownerId)).map(({ id }) => id)).toEqual([second.sourceId]);
    expect(
      await service.respond({
        decision: { decision: "allow", sourceId: second.sourceId },
        ownerId,
        requestId: asked.requestId,
      }),
    ).toMatchObject({ site, status: "applied" });
    expect(await service.agentSignIn({ ...agent, callId, site })).toMatchObject({
      site,
      sourceName: "Chrome A again",
      status: "applied",
    });

    const declinedCall = randomUUID();
    const other = await service.agentSignIn({
      ...agent,
      callId: declinedCall,
      site: "https://other.test",
    });
    if (other.status !== "pending") throw new Error("Expected a pending Request");
    expect(
      await service.respond({
        decision: { decision: "decline" },
        ownerId,
        requestId: other.requestId,
      }),
    ).toBeNull();
    expect(
      await service.agentSignIn({ ...agent, callId: declinedCall, site: "https://other.test" }),
    ).toEqual({ requestId: other.requestId, status: "declined" });
    expect(connection.imports()).toHaveLength(1);

    // Disconnect in Chrome ends the connection like Disconnect in Opensteer;
    // the sites the Workspace allowed stay allowed.
    chromeB.socket.send(JSON.stringify({ type: "source.disconnect" }));
    await chromeB.closed;
    expect(await sourceStore.list(ownerId)).toEqual([]);
    expect(
      await sourceStore.authenticate(createHash("sha256").update(second.token).digest("hex")),
    ).toBeNull();
    expect(await sourceStore.getGrant({ ownerId, site, workspaceId })).not.toBeNull();
    expect(serviceErrors).toEqual([]);
  });

  it("answers without a Request when it can, and refuses what Chrome or the runtime cannot do", async () => {
    const { agent, connection, ownerId, sessionId } = await scene();
    const paired = await pairChrome(ownerId, "Chrome on Mac");
    const chrome = await connectChrome(paired);
    const site = "https://example.test";
    chrome.status = "no-state";

    expect(
      await service.agentSignIn({ ...agent, callId: randomUUID(), canRequest: false, site }),
    ).toEqual({ reason: "needs-approval", site, status: "unavailable" });
    expect(await service.agentSignIn({ ...agent, callId: randomUUID(), site })).toEqual({
      site,
      status: "not-signed-in",
    });
    expect(await service.agentSignIn({ ...agent, callId: randomUUID(), site })).toEqual({
      site,
      status: "not-signed-in",
    });
    expect(await service.agentSignIn({ ...agent, callId: randomUUID(), site })).toEqual({
      reason: "rate-limited",
      site,
      status: "unavailable",
    });
    expect(await pendingSignIns(ownerId)).toEqual([]);
    await expect(
      service.agentSignIn({ ...agent, callId: randomUUID(), site: "ftp://example.test" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // Chrome must not widen the scope: a cookie for another site fails the transfer.
    chrome.status = "available";
    chrome.cookiesFor = () => [
      {
        domain: "evil.test",
        expires: -1,
        hostOnly: true,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "stolen",
      },
    ];
    expect(
      await service.sessionSignIn({
        idempotencyKey: randomUUID(),
        ownerId,
        sessionId,
        sourceId: null,
        url: "https://other.test",
      }),
    ).toEqual({
      problem: "unsupported",
      site: "https://other.test",
      sourceName: "Chrome on Mac",
      status: "problem",
    });
    expect(await chrome.closed).toBe(1008);
    expect(connection.imports()).toEqual([]);

    runtime.supportsImport = false;
    const outdated = await browser.start({
      fresh: true,
      ownerId,
      placement: { kind: "runner", runnerId: runtime.runnerId! },
      reuseExisting: false,
      workspaceId: agent.workspaceId,
    });
    expect(outdated.session.id).not.toBe(sessionId);
    expect(
      await service.agentSignIn({
        ...agent,
        callId: randomUUID(),
        sessionId: outdated.session.id,
        site: "https://third.test",
      }),
    ).toEqual({ reason: "runtime-outdated", site: "https://third.test", status: "unavailable" });

    await browser.stop(ownerId, sessionId);
    expect(
      await service.agentSignIn({ ...agent, callId: randomUUID(), site: "https://fourth.test" }),
    ).toEqual({ reason: "session-closed", site: "https://fourth.test", status: "unavailable" });
    expect(
      await service.sessionSignIn({
        idempotencyKey: randomUUID(),
        ownerId,
        sessionId,
        sourceId: null,
        url: "https://fourth.test",
      }),
    ).toMatchObject({ problem: "session-closed", status: "problem" });
  });

  /*
   * Ways a sign-in could reach a site no agent may hold:
   * - a public suffix (`github.io`, `co.uk`) named as the site, covering every
   *   tenant under it;
   * - a loopback site in any spelling (`127.0.0.1`, `localhost` with a port,
   *   `*.localhost`, `[::1]`), where a Personal Deployment's session cookie lives;
   * - the site of the canonical origin or of the current remote route, in
   *   either scheme and through any subdomain;
   * - a Request already open for a site that became the remote route's site,
   *   then allowed (creating a grant) or drained.
   * Each must be refused before a Request is created or Chrome is asked.
   * Sites normalization does produce (`_` hosts, IPv6 literals) must still be
   * storable end to end.
   */
  it("refuses shared suffixes and Opensteer's own sites before asking anyone", async () => {
    const { agent, connection, ownerId, sessionId, workspaceId } = await scene();
    const paired = await pairChrome(ownerId, "Chrome on Mac");
    const chrome = await connectChrome(paired);
    const ask = (site: string) => service.agentSignIn({ ...agent, callId: randomUUID(), site });

    for (const site of ["github.io", "https://co.uk/login", "com"]) {
      await expect(ask(site)).rejects.toMatchObject({ code: "bad_request" });
    }
    currentRoute = remoteRoute("https://remote-source-host.test", 4);
    for (const [input, site] of [
      ["127.0.0.1", "https://127.0.0.1"],
      ["http://localhost:3000/", "http://localhost"],
      ["http://app.localhost", "http://app.localhost"],
      ["http://[::1]:8080", "http://[::1]"],
      ["source-host.test", "https://source-host.test"],
      ["http://login.source-host.test/", "http://source-host.test"],
      ["https://remote-source-host.test/", "https://remote-source-host.test"],
    ] as const) {
      expect(await ask(input)).toEqual({ reason: "not-allowed", site, status: "unavailable" });
    }
    expect(
      await service.sessionSignIn({
        idempotencyKey: randomUUID(),
        ownerId,
        sessionId,
        sourceId: paired.sourceId,
        url: "http://127.0.0.1:8080/settings",
      }),
    ).toEqual({
      problem: "not-allowed",
      site: "http://127.0.0.1",
      sourceName: null,
      status: "problem",
    });
    expect(await pendingSignIns(ownerId)).toEqual([]);
    expect(chrome.exports).toBe(0);

    // Shapes normalization produces reach PostgreSQL intact.
    for (const [input, site] of [
      ["https://foo_bar.github.io/x", "https://foo_bar.github.io"],
      ["http://[2001:db8::1]/", "http://[2001:db8::1]"],
    ] as const) {
      expect(await ask(input)).toMatchObject({ replayed: false, status: "pending" });
      expect((await pendingSignIns(ownerId)).at(-1)?.payload).toMatchObject({ site });
    }

    // A site that became the remote route's after its Request opened.
    const later = await ask("https://later-remote.test");
    if (later.status !== "pending") throw new Error("Expected a pending Request");
    currentRoute = remoteRoute("https://later-remote.test", 5);
    expect(
      await service.respond({
        decision: { decision: "allow", sourceId: paired.sourceId },
        ownerId,
        requestId: later.requestId,
      }),
    ).toEqual({
      problem: "not-allowed",
      site: "https://later-remote.test",
      sourceName: null,
      status: "problem",
    });
    expect(
      await sourceStore.getGrant({ ownerId, site: "https://later-remote.test", workspaceId }),
    ).toBeNull();
    expect(await store.requests.get(later.requestId)).toMatchObject({ status: "pending" });
    expect(chrome.exports).toBe(0);
    expect(connection.imports()).toEqual([]);
    await chrome.close();
  });

  /*
   * Ways the pairing proof could fail to protect the one-use code and a
   * replaced connection's token:
   * - the Host signs for a destination it would not pair on (another origin,
   *   a stale remote route generation), so a replayed discovery document
   *   passes for a squatter;
   * - the signature is not bound to the nonce, or is reusable as a connection
   *   proof;
   * - any web page, or an unbounded number of calls, can make the Host sign.
   */
  it("proves the Host for a destination it serves before any pairing secret is sent", async () => {
    const host = Fastify();
    host.setErrorHandler((error, _request, reply) => {
      const normalized = normalizeHostError(error);
      void reply.status(normalized.status).send({ error: normalized.error });
    });
    await host.register(websocket);
    registerBrowserSourceWire(host, service, sourceOrigin);
    const address = new URL(await host.listen({ host: "127.0.0.1", port: 0 }));
    const post = (body: unknown, origin: string | null = `chrome-extension://${"a".repeat(32)}`) =>
      new Promise<{ status: number; body: { signature?: string } }>((resolve, reject) => {
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: Number(address.port),
            path: "/internal/v1/browser-sources/pair/challenge",
            method: "POST",
            headers: {
              "content-type": "application/json",
              host: new URL(sourceOrigin).host,
              ...(origin ? { origin } : {}),
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} }),
            );
          },
        );
        request.on("error", reject);
        request.end(payload);
      });
    try {
      const challenge = { ...sourceDestination, nonce: randomUUID() };
      const proved = await post(challenge);
      expect(proved.status).toBe(200);
      const signature = Buffer.from(proved.body.signature!, "base64url");
      expect(
        verify(null, browserSourcePairChallengeBytes(challenge), hostKey.publicKey, signature),
      ).toBe(true);
      expect(
        verify(
          null,
          browserSourcePairChallengeBytes({ ...challenge, nonce: randomUUID() }),
          hostKey.publicKey,
          signature,
        ),
      ).toBe(false);
      expect(
        verify(
          null,
          browserSourceChallengeBytes({ ...challenge, sourceId: createId("browserSource") }),
          hostKey.publicKey,
          signature,
        ),
      ).toBe(false);
      let calls = 1;

      const refusals = [
        await post({ ...challenge, origin: "https://elsewhere.test" }),
        await post({
          origin: "https://remote-source-host.test",
          routeGeneration: 3,
          nonce: randomUUID(),
        }),
      ];
      calls += refusals.length;
      for (const refused of refusals) {
        expect(refused.status).toBe(403);
        expect(refused.body.signature).toBeUndefined();
      }
      currentRoute = remoteRoute("https://remote-source-host.test", 3);
      // The route is current, but this request arrived on the canonical ingress.
      expect(
        await post({
          origin: "https://remote-source-host.test",
          routeGeneration: 3,
          nonce: randomUUID(),
        }),
      ).toMatchObject({ status: 403 });
      calls += 1;
      expect(await post(challenge, null)).toMatchObject({ status: 403, body: {} });
      expect(await post(challenge, "https://evil.test")).toMatchObject({ status: 403, body: {} });
      expect(await post({ ...challenge, nonce: "not-a-uuid" })).toMatchObject({ status: 400 });

      while (calls < 30) {
        expect(await post({ ...challenge, nonce: randomUUID() })).toMatchObject({ status: 200 });
        calls += 1;
      }
      expect(await post({ ...challenge, nonce: randomUUID() })).toMatchObject({
        status: 429,
        body: {},
      });
    } finally {
      await host.close();
    }
  });

  /*
   * Ways an owner's decline or site removal could lose to a delivery already
   * exporting from Chrome: the delivery imports anyway and records a receipt
   * with no Request, the agent is told "declined" for a browser that is
   * signed in, or a removed site is reported as Chrome not being connected.
   */
  it("never signs in for a Request declined or a site removed while Chrome exports", async () => {
    const { agent, connection, ownerId, workspaceId } = await scene();
    const paired = await pairChrome(ownerId, "Chrome on Mac");
    const chrome = await connectChrome(paired);
    const open = async (site: string) => {
      const asked = await service.agentSignIn({ ...agent, callId: randomUUID(), site });
      if (asked.status !== "pending") throw new Error("Expected a pending Request");
      return asked.requestId;
    };
    const allow = (requestId: Awaited<ReturnType<typeof open>>) =>
      service.respond({
        decision: { decision: "allow", sourceId: paired.sourceId },
        ownerId,
        requestId,
      });
    chrome.holdExports = true;

    // Declined in Opensteer while exporting: the decline waits for the
    // delivery already past its checks, so the Request ends one way only.
    const raced = await open("https://raced.test");
    const allowing = allow(raced);
    await waitFor(() => chrome.held.length === 1);
    const declining = service.respond({
      decision: { decision: "decline" },
      ownerId,
      requestId: raced,
    });
    // Let the decline reach its turn before Chrome answers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await store.requests.get(raced)).toMatchObject({ status: "pending" });
    chrome.releaseExports();
    expect(await allowing).toMatchObject({ site: "https://raced.test", status: "applied" });
    await expect(declining).rejects.toMatchObject({ code: "conflict" });
    expect(await store.requests.get(raced)).toMatchObject({ status: "fulfilled" });
    expect(connection.imports()).toHaveLength(1);

    // Declined elsewhere (another Host process) before the import: nothing lands.
    const declined = await open("https://declined.test");
    const late = allow(declined);
    await waitFor(() => chrome.held.length === 1);
    await store.requests.declineBrowserSignInRequest({ requestId: declined, resolvedBy: ownerId });
    chrome.releaseExports();
    await expect(late).rejects.toMatchObject({ code: "conflict" });
    expect(await store.requests.get(declined)).toMatchObject({ status: "declined" });
    expect(connection.imports()).toHaveLength(1);
    expect(
      await database
        .selectFrom("browserSignIns")
        .select("site")
        .where("ownerId", "=", ownerId)
        .execute(),
    ).toEqual([{ site: "https://raced.test" }]);

    // The site removed while exporting: the card says so, and it stays open.
    const removed = await open("https://removed.test");
    const removing = allow(removed);
    await waitFor(() => chrome.held.length === 1);
    await service.removeSite({ ownerId, site: "https://removed.test", workspaceId });
    chrome.releaseExports();
    expect(await removing).toEqual({
      problem: "site-removed",
      site: "https://removed.test",
      sourceName: null,
      status: "problem",
    });
    expect(await store.requests.get(removed)).toMatchObject({ status: "pending" });
    expect(connection.imports()).toHaveLength(1);
    await chrome.close();
  });

  /*
   * Ways an allowed Request could wait forever: older Requests nobody can
   * answer (no grant, another Chrome preferred) fill the drain's page ahead of
   * it, or the site is allowed some other way while it waits and nothing
   * delivers it until Chrome happens to reconnect.
   */
  it("completes allowed Requests past any backlog, and on the agent's next call", async () => {
    const { agent, connection, ownerId, sessionId, workspaceId } = await scene();
    const paired = await pairChrome(ownerId, "Chrome on Mac");
    let chrome = await connectChrome(paired);
    for (let index = 0; index < 70; index += 1) {
      const site = `https://backlog${index}.test`;
      await store.requests.create({
        callId: randomUUID(),
        kind: "browser.sign-in",
        mode: "durable",
        originatingRunId: agent.runId,
        originatingThreadId: agent.threadId,
        originatingWorkspaceId: workspaceId,
        payload: { kind: "browser.sign-in", reason: "Backlog", sessionId, site },
        presentation: {
          detail: "Backlog",
          kind: "external",
          subject: { id: site, kind: "browser-site" },
          title: `Sign in to backlog${index}.test`,
        },
        requestedBy: ownerId,
        requiredActor: "requester",
        targetWorkspaceId: workspaceId,
      });
    }
    const asked = await service.agentSignIn({
      ...agent,
      callId: randomUUID(),
      site: "https://late.test",
    });
    if (asked.status !== "pending") throw new Error("Expected a pending Request");
    await chrome.close();
    await waitFor(async () => !(await service.listState({ ownerId })).sources[0]?.connected);
    expect(
      await service.respond({
        decision: { decision: "allow", sourceId: paired.sourceId },
        ownerId,
        requestId: asked.requestId,
      }),
    ).toMatchObject({ problem: "chrome-offline" });
    chrome = await connectChrome(paired);
    await waitFor(async () => (await store.requests.get(asked.requestId))?.status === "fulfilled");
    expect(chrome.exports).toBe(1);
    expect(await pendingSignIns(ownerId)).toHaveLength(70);

    // Allowed from the toolbar while the agent's Request waits: the agent's
    // next call delivers it instead of returning the stale pending Request.
    const waiting = await service.agentSignIn({
      ...agent,
      callId: randomUUID(),
      site: "https://toolbar.test",
    });
    if (waiting.status !== "pending") throw new Error("Expected a pending Request");
    expect(
      await service.sessionSignIn({
        idempotencyKey: randomUUID(),
        ownerId,
        sessionId,
        sourceId: null,
        url: "https://toolbar.test",
      }),
    ).toMatchObject({ status: "applied" });
    expect(await store.requests.get(waiting.requestId)).toMatchObject({ status: "pending" });
    expect(
      await service.agentSignIn({ ...agent, callId: randomUUID(), site: "https://toolbar.test" }),
    ).toMatchObject({ site: "https://toolbar.test", status: "applied" });
    expect(await store.requests.get(waiting.requestId)).toMatchObject({
      status: "fulfilled",
      response: { kind: "external", value: { outcome: "applied" } },
    });
    expect(connection.imports().map(({ site }) => site)).toEqual([
      "https://late.test",
      "https://toolbar.test",
      "https://toolbar.test",
    ]);
    expect(serviceErrors).toEqual([]);
    await chrome.close();
  });

  it("rejects a source that does not prove the paired token and ID", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    const messages: unknown[] = [];
    const sourceId = createId("browserSource");
    client.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      messages.push(message);
      if (message.type === "source.proof")
        client.send(
          JSON.stringify({
            type: "source.hello",
            version: browserSourceProtocolVersion,
            sourceId,
            token: randomBytes(32).toString("base64url"),
          }),
        );
    });
    client.send(
      JSON.stringify({
        ...sourceDestination,
        type: "source.challenge",
        sourceId,
        nonce: randomUUID(),
      }),
    );
    expect(await closed).toBe(1008);
    expect(messages).toEqual([
      expect.objectContaining({ type: "source.proof" }),
      { type: "source.error", code: "source-unauthorized" },
    ]);
  });

  it("bounds unauthenticated frames before parsing source state", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    client.send("x".repeat(4_097));
    expect(await closed).toBe(1009);

    const early = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      early.once("open", resolve);
      early.once("error", reject);
    });
    const refused = new Promise<number>((resolve) => early.once("close", resolve));
    early.send(JSON.stringify({ type: "source.disconnect" }));
    expect(await refused).toBe(1008);
  });

  it("reports an incompatible extension before attempting source authentication", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const sourceId = createId("browserSource");
    const failure = new Promise<unknown>((resolve) =>
      client.on("message", (raw) => {
        const message: unknown = JSON.parse(raw.toString());
        if (typeof message !== "object" || message === null || !("type" in message)) return;
        if (message.type === "source.proof") {
          client.send(
            JSON.stringify({
              type: "source.hello",
              sourceId,
              token: randomBytes(32).toString("base64url"),
              version: browserSourceProtocolVersion + 1,
            }),
          );
        } else resolve(message);
      }),
    );
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send(
      JSON.stringify({
        ...sourceDestination,
        type: "source.challenge",
        sourceId,
        nonce: randomUUID(),
      }),
    );
    expect(await failure).toEqual({
      type: "source.error",
      code: "unsupported-version",
      supportedVersion: browserSourceProtocolVersion,
    });
    client.close();
  });

  it("caps simultaneous unauthenticated connections", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected socket server port");
    const clients: WebSocket[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        });
      }
      const extra = new WebSocket(`ws://127.0.0.1:${address.port}`);
      expect(await new Promise<number>((resolve) => extra.once("close", resolve))).toBe(1013);
    } finally {
      await Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve) => {
              client.once("close", () => resolve());
              client.close();
            }),
        ),
      );
    }
  });
});
