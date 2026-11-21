import { runHasBrowserPages } from "../agents/browser-capability.js";
import {
  PageAgentBindInputSchema,
  browserAgentHostRoutePrefix,
} from "@opensteer/protocol/browser-agent";
import type { AgentCallerResolver } from "../mcp/agent-caller.js";
import type { TabServicePort } from "../tabs/ports.js";
import { normalizeHostError } from "../server/http-errors.js";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { OpensteerError } from "@opensteer/core";
import {
  BrowserActionRequestSchema,
  BrowserActionErrorCodeSchema,
  BrowserActionDialogSchema,
  browserActionMaxBytes,
} from "@opensteer/protocol/browser-actions";
import { safeMessage } from "@opensteer/shared/safeMessage";
import type { IncomingHttpHeaders } from "node:http";
import type { EnvironmentId, ThreadAccessMode, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { BrowserSessionIdSchema, type BrowserSessionId } from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { z } from "zod";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import type { RunToolScope, RunToolTokenService } from "../agents/run-tool-tokens.js";
import { BrowserCdpConnectionEnded, type BrowserService } from "./browser-service.js";
import type {
  TriggerControlScope,
  TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";
import type {
  WatchCapabilityClaims,
  WatchCapabilityTokenService,
} from "../triggers/watch-capability.js";

const maximumCdpMessageBytes = 1_024 * 1_024;
const maximumBufferedBytes = 8 * 1_024 * 1_024;
const maximumQueuedCommands = 64;

const CdpRequestSchema = z.strictObject({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/)
    .max(160),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().min(1).max(512).optional(),
});

interface CdpAuthority {
  readonly agentBindingId: string;
  readonly bindingGeneration?: number;
  readonly environmentId?: EnvironmentId;
  readonly ownerId: UserId;
}

interface CdpRouteOptions<Scope> {
  readonly authenticate: (token: string) => Promise<Scope>;
  readonly authority: (scope: Scope) => CdpAuthority;
  readonly browser: Pick<
    BrowserService,
    | "attachCdpForAgent"
    | "attachActionsForAgent"
    | "agentBackend"
    | "closeTriggerSessionsForBinding"
    | "openAgentSession"
  > &
    Partial<Pick<BrowserService, "usesPoolAdmission">>;
  readonly expiresAt?: (scope: Scope) => number;
  /**
   * Rechecks an open connection by what it authenticated as. Without one, each
   * command re-verifies the token, so the connection ends when the token does.
   */
  readonly reauthorize?: (scope: Scope) => Promise<Scope>;
  /**
   * Trigger and watch connections open their own session and close it with
   * the connection. An agent's sessions outlive every connection to them: the
   * Run's end releases what it held.
   */
  readonly ownsSession: boolean;
  readonly path: string;
  readonly backend?: "actions";
}

export function registerAgentCdpBridge(
  app: FastifyInstance,
  browser: BrowserService,
  tokens: RunToolTokenService,
  _tabs?: unknown,
): void {
  type AgentCdpScope = RunToolScope & { readonly lineage: boolean };
  const route = {
    authenticate: async (token: string): Promise<AgentCdpScope> => {
      const { claims, lineage } = await tokens.authenticateExecution(token);
      return { ...claims, lineage: Boolean(lineage?.agentConnectionId) };
    },
    authority: (scope: AgentCdpScope) => ({
      agentBindingId: `run:${scope.runId}`,
      ownerId: scope.requestedBy,
      ...(scope.lineage ? { bindingGeneration: scope.bindingGeneration } : {}),
    }),
    browser,
    ownsSession: false,
    // An agent's browser connection lasts as long as its Run's grant, which a
    // long Run outlives its first token by.
    reauthorize: async (scope: AgentCdpScope) => {
      await tokens.reauthorize(scope);
      return scope;
    },
  };
  registerCdpRoute<AgentCdpScope>(app, {
    ...route,
    backend: "actions",
    path: hostInternalRoutePaths.browserSessionActions,
  });
  app.get(hostInternalRoutePaths.browserSessionBackend, async (request) => {
    const connection = await authenticateConnection(request, route);
    const sessionId = BrowserSessionIdSchema.parse(connection.sessionId);
    try {
      if (connection.scope.lineage) await route.reauthorize(connection.scope);
      return await browser.agentBackend({ ...route.authority(connection.scope), sessionId });
    } catch (error) {
      if (error instanceof BrowserCdpConnectionEnded)
        throw new OpensteerError({ code: "forbidden", message: error.message });
      throw error;
    }
  });
  registerCdpRoute<AgentCdpScope>(app, {
    ...route,
    path: hostInternalRoutePaths.browserSessionCdp,
  });
  registerCdpRoute<AgentCdpScope>(app, {
    ...route,
    path: hostInternalRoutePaths.browserCdp,
  });
}

export function registerAgentPageBindingRoute(
  app: FastifyInstance,
  tokens: Pick<RunToolTokenService, "authenticate" | "reauthorize">,
  tabs: Pick<TabServicePort, "requireOpenPage">,
  callers: Pick<AgentCallerResolver, "authenticate">,
  runBrowser: (
    claims: RunToolScope,
  ) => Promise<{ driverKind: string; accessMode: ThreadAccessMode }>,
): void {
  app.post(
    `${browserAgentHostRoutePrefix}/pages/bind`,
    { bodyLimit: 16_384 },
    async (request, reply) => {
      try {
        const token = bearerToken(request.headers);
        const claims = await tokens.authenticate(token);
        const caller = await callers.authenticate(token);
        const capability = caller.kind === "run" ? await runBrowser(claims) : null;
        if (!capability || !runHasBrowserPages(capability.driverKind, capability.accessMode))
          return reply.code(403).send({
            error: {
              code: "access_denied",
              message: "Browser control requires full access for this Run.",
              next: "Use a full-access Run to control browser tabs.",
            },
          });
        const { tabId } = PageAgentBindInputSchema.parse(request.body);
        return await tabs.requireOpenPage(await tokens.reauthorize(claims), tabId);
      } catch (error) {
        const normalized = normalizeHostError(error);
        return reply.code(normalized.status).send({ error: normalized.error });
      }
    },
  );
}

/**
 * What the page-bind gate decides on: the Run's engine and the mode it actually has, which a
 * connected agent's lineage lowers to its effective mode.
 */
export async function runBrowserCapability(
  store: Pick<OpensteerStore, "database" | "admitExecution">,
  claims: Pick<RunToolScope, "runId" | "requestedBy">,
): Promise<{ driverKind: string; accessMode: ThreadAccessMode }> {
  const run = await store.database
    .selectFrom("runs")
    .innerJoin("harnessInstances", "harnessInstances.id", "runs.harnessInstanceId")
    .select(["harnessInstances.driverKind", "runs.accessMode"])
    .where("runs.id", "=", claims.runId)
    .where("runs.requestedBy", "=", claims.requestedBy)
    .executeTakeFirst();
  if (!run)
    throw new OpensteerError({
      code: "forbidden",
      message: "This task's browser access has ended.",
    });
  const execution = await store.admitExecution({
    ownerUserId: claims.requestedBy,
    subject: { kind: "binding", bindingId: `run:${claims.runId}` },
  });
  return {
    driverKind: run.driverKind,
    accessMode: execution.agentConnection ? execution.mode : run.accessMode,
  };
}

export function registerTriggerCdpBridge(
  app: FastifyInstance,
  browser: BrowserService,
  tokens: TriggerControlTokenService,
): void {
  registerCdpRoute<TriggerControlScope>(app, {
    authenticate: (token) => tokens.authenticate(token),
    authority: (scope) => ({
      agentBindingId: `trigger:${scope.occurrenceId}`,
      environmentId: scope.environmentId,
      ownerId: scope.requestedBy,
    }),
    browser,
    ownsSession: true,
    path: hostInternalRoutePaths.triggerCdp,
  });
}

export function registerWatchCdpBridge(
  app: FastifyInstance,
  browser: BrowserService,
  tokens: WatchCapabilityTokenService<"opensteer-watch-browser-cdp">,
): void {
  registerCdpRoute<WatchCapabilityClaims<"opensteer-watch-browser-cdp">>(app, {
    authenticate: (token) => tokens.authenticate(token),
    authority: (scope) => ({
      agentBindingId: `watch:${scope.activationId}`,
      environmentId: scope.environmentId,
      ownerId: scope.createdBy,
    }),
    browser,
    expiresAt: (scope) => scope.exp * 1_000,
    ownsSession: true,
    path: hostInternalRoutePaths.watchCdp,
  });
}

async function authenticateConnection<Scope>(
  request: { readonly headers: IncomingHttpHeaders; readonly params: unknown },
  options: Pick<CdpRouteOptions<Scope>, "authenticate">,
) {
  const token = bearerToken(request.headers);
  const scope = await options.authenticate(token);
  const parameters = request.params as { readonly sessionId?: unknown };
  const sessionId = typeof parameters.sessionId === "string" ? parameters.sessionId : undefined;
  return { scope, sessionId, token };
}

const lineageSockets = new WeakMap<
  CdpRouteOptions<unknown>["browser"],
  Map<
    WebSocket,
    {
      readonly authority: CdpAuthority;
      readonly close: () => Promise<void>;
    }
  >
>();

const drainingRunGenerations = new WeakMap<
  CdpRouteOptions<unknown>["browser"],
  Map<string, number>
>();
const endedBrowserAccess = "This task's browser access has ended.";

function runGenerationKey(bindingId: string, generation: number): string {
  return `${bindingId}:${generation}`;
}

function isDrainingRun(
  browser: CdpRouteOptions<unknown>["browser"],
  authority: CdpAuthority,
): boolean {
  return (
    authority.bindingGeneration !== undefined &&
    drainingRunGenerations
      .get(browser)
      ?.has(runGenerationKey(authority.agentBindingId, authority.bindingGeneration)) === true
  );
}

export async function withLegacyRunCdpDrain<T>(
  browser: BrowserService,
  runId: string,
  generation: number,
  finish: () => Promise<T>,
): Promise<T> {
  let generations = drainingRunGenerations.get(browser);
  if (!generations) {
    generations = new Map();
    drainingRunGenerations.set(browser, generations);
  }
  const key = runGenerationKey(`run:${runId}`, generation);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  try {
    await drainLegacyRunCdp(browser, runId, generation);
    return await finish();
  } finally {
    const remaining = generations.get(key)! - 1;
    if (remaining) generations.set(key, remaining);
    else generations.delete(key);
  }
}

export async function drainLegacyRunCdp(
  browser: BrowserService,
  runId: string,
  generation: number,
): Promise<void> {
  await Promise.all(
    [...(lineageSockets.get(browser) ?? [])].flatMap(([socket, binding]) => {
      if (
        binding.authority.agentBindingId !== `run:${runId}` ||
        binding.authority.bindingGeneration !== generation
      )
        return [];
      socket.terminate();
      return [binding.close()];
    }),
  );
}

export async function closeLegacyCdpForConnection(
  browser: BrowserService,
  connectionId: string,
  resolveLineage: OpensteerStore["bindingAgentConnectionId"],
): Promise<void> {
  await Promise.all(
    [...(lineageSockets.get(browser) ?? [])].map(async ([socket, binding]) => {
      const bindingId = binding.authority.agentBindingId;
      if (!bindingId.startsWith("run:") && (await resolveLineage(bindingId)) === connectionId) {
        socket.terminate();
        await binding.close();
      }
    }),
  );
}

function registerCdpRoute<Scope>(app: FastifyInstance, options: CdpRouteOptions<Scope>): void {
  const connections = new WeakMap<
    object,
    { readonly scope: Scope; readonly sessionId: string | undefined; readonly token: string }
  >();
  app.get(
    options.path,
    {
      preValidation: async (request, reply) => {
        const connection = await authenticateConnection(request, options);
        if (isDrainingRun(options.browser, options.authority(connection.scope)))
          return reply.code(403).send({ error: endedBrowserAccess });
        connections.set(request.raw, connection);
      },
      websocket: true,
    },
    (socket, request) => {
      const connection = connections.get(request.raw);
      if (!connection) return socket.close(1008, "Authentication required");
      const authority = options.authority(connection.scope);
      if (isDrainingRun(options.browser, authority)) return socket.close(1008, endedBrowserAccess);
      let sockets = lineageSockets.get(options.browser);
      if (!sockets) {
        sockets = new Map();
        lineageSockets.set(options.browser, sockets);
      }
      const close = attachCdpSocket(socket, options, connection);
      sockets.set(socket, { authority, close });
      socket.once("close", () => {
        void close().then(
          () => sockets.delete(socket),
          () => undefined,
        );
      });
    },
  );
}

/**
 * Relays one CDP client to one Browser Session. A refusal reaches the client
 * whole, as the answer to its next command, before the connection closes: a
 * WebSocket close reason is too short to say what the agent should do next.
 */
function attachCdpSocket<Scope>(
  socket: WebSocket,
  options: CdpRouteOptions<Scope>,
  connection: {
    readonly scope: Scope;
    readonly sessionId: string | undefined;
    readonly token: string;
  },
): () => Promise<void> {
  const authority = options.authority(connection.scope);
  let disconnected = false;
  let commands = Promise.resolve();
  let queuedBytes = 0;
  let queuedCommands = 0;
  const expirationTimer = options.expiresAt
    ? setTimeout(
        () => closeSocket(socket, new Error("CDP capability expired")),
        Math.max(0, options.expiresAt(connection.scope) - Date.now()),
      )
    : undefined;
  expirationTimer?.unref();
  let ownedSessionOpened = false;
  const poolWaiting = options.browser.usesPoolAdmission ? new AbortController() : undefined;
  const attachmentPromise = (async () => {
    if (authority.bindingGeneration !== undefined) {
      await options.reauthorize?.(connection.scope);
      if (disconnected || socket.readyState !== socket.OPEN)
        throw new BrowserCdpConnectionEnded("This task's browser access has ended.");
    }
    let sessionId: BrowserSessionId | undefined;
    if (connection.sessionId !== undefined) {
      const parsed = BrowserSessionIdSchema.safeParse(connection.sessionId);
      if (!parsed.success) {
        throw new BrowserCdpConnectionEnded(
          "This browser binding is invalid. Use tab_list and openPage(tabId).",
        );
      }
      sessionId = parsed.data;
    }
    if (options.ownsSession) {
      const opened = await options.browser.openAgentSession({
        ...authority,
        fresh: true,
        ...(poolWaiting ? { signal: poolWaiting.signal } : {}),
      });
      ownedSessionOpened = true;
      sessionId = opened.session.id;
    }
    if (options.backend === "actions") {
      if (!sessionId)
        throw new BrowserCdpConnectionEnded(
          "Bind a tab with Browser Harness openPage(tabId) before using actions.",
        );
      const attached = await options.browser.attachActionsForAgent(
        { ...authority, sessionId },
        (event) => sendJson(socket, { event }),
        () => closeSocket(socket, new Error("The browser tab became unavailable."), 1000),
      );
      return {
        close: () => attached.close(),
        dispatch: (value: unknown) => attached.dispatch(BrowserActionRequestSchema.parse(value)),
      };
    }
    const attached = await options.browser.attachCdpForAgent(
      {
        ...authority,
        ...(sessionId ? { sessionId } : {}),
        ...(poolWaiting ? { signal: poolWaiting.signal } : {}),
      },
      (event) => {
        sendJson(socket, {
          method: event.method,
          params: event.parameters,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
      },
      () => closeSocket(socket, new Error("The browser tab became unavailable."), 1000),
    );
    const channels = new Set<string>();
    const attaching = new Set<Promise<unknown>>();
    return {
      close: async () => {
        // The runtime owns input release; enqueue detach before retiring this Host attachment.
        await Promise.allSettled(attaching).then(async () => {
          await Promise.allSettled(
            [...channels].map(async (sessionId) => {
              const pending = await attached.dispatch({
                method: "Target.detachFromTarget",
                parameters: { sessionId },
              });
              if (attached.pooledClose) await pending.result;
              else void pending.result.catch(() => undefined);
            }),
          );
          if (attached.pooledClose) await attached.pooledClose();
          else attached.close();
        });
      },
      dispatch: async (value: unknown) => {
        const request = CdpRequestSchema.parse(value);
        const dispatching = attached.dispatch({
          method: request.method,
          ...(request.params ? { parameters: request.params } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
        if (request.method === "Target.attachToTarget") {
          const tracked = dispatching
            .then(({ result }) => result)
            .then((result) => {
              const id = z.object({ sessionId: z.string() }).parse(result).sessionId;
              channels.add(id);
              return result;
            });
          attaching.add(tracked);
          void tracked.then(
            () => attaching.delete(tracked),
            () => attaching.delete(tracked),
          );
        }
        const pending = await dispatching;
        if (request.method === "Target.detachFromTarget")
          void pending.result.then(
            () => channels.delete(String(request.params?.sessionId)),
            () => undefined,
          );
        return pending;
      },
    };
  })();
  // A client that never sends a command still learns why it cannot connect.
  let refusalTimer: NodeJS.Timeout | undefined;
  attachmentPromise.then(
    () => {},
    (error: unknown) => {
      if (disconnected) return;
      refusalTimer = setTimeout(() => closeSocket(socket, error), 10_000);
      refusalTimer.unref();
    },
  );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    disconnected = true;
    poolWaiting?.abort(new BrowserCdpConnectionEnded("The browser connection ended."));
    if (expirationTimer) clearTimeout(expirationTimer);
    if (refusalTimer) clearTimeout(refusalTimer);
    closing = (async () => {
      try {
        await attachmentPromise.then(
          (attachment) => attachment.close(),
          () => undefined,
        );
      } finally {
        // The owned session ends even when the attachment's own cleanup failed.
        if (options.ownsSession && ownedSessionOpened)
          await options.browser.closeTriggerSessionsForBinding(authority.agentBindingId);
      }
    })();
    return closing;
  };
  socket.once("error", () => {
    void close().catch(() => undefined);
  });
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      closeSocket(socket, new Error("CDP messages must be JSON text"));
      return;
    }
    const frame = rawDataBuffer(raw);
    if (
      frame.byteLength >
      (options.backend === "actions" ? browserActionMaxBytes : maximumCdpMessageBytes)
    ) {
      closeSocket(socket, new Error("CDP message is too large"));
      return;
    }
    queuedCommands += 1;
    queuedBytes += frame.byteLength;
    if (queuedCommands > maximumQueuedCommands || queuedBytes > maximumBufferedBytes) {
      closeSocket(socket, new Error("CDP command queue is full"));
      return;
    }
    // A command counts against the queue until its answer is sent.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      queuedCommands -= 1;
      queuedBytes -= frame.byteLength;
    };
    const refuse = (id: number, error: unknown) => {
      const reason =
        error instanceof OpensteerError
          ? BrowserActionErrorCodeSchema.safeParse(error.reason).data
          : undefined;
      const context =
        error instanceof DeviceAccessRefusal
          ? { machineId: error.machineId, capability: error.capability }
          : {};
      const message = safeMessage(error, safeMessageOptions);
      if (options.backend === "actions") {
        const dialog =
          error instanceof OpensteerError
            ? BrowserActionDialogSchema.safeParse(error.details?.dialog).data
            : undefined;
        sendJson(socket, {
          id,
          error: {
            ...context,
            code: reason ?? "forbidden",
            message,
            ...(dialog ? { dialog } : {}),
          },
        });
      } else
        sendJson(socket, {
          id,
          error: { ...context, code: -32_000, message, ...(reason ? { reason } : {}) },
        });
    };
    // Commands are admitted and dispatched one at a time, in the order they
    // arrived; each is answered whenever the browser answers it. A command
    // that a dialog blocks therefore never holds up the dialog's answer or a
    // detach, which the runtime runs past a blocked page.
    let answering = false;
    commands = commands
      .then(async () => {
        if (disconnected || socket.readyState !== socket.OPEN) return;
        const request = (
          options.backend === "actions" ? BrowserActionRequestSchema : CdpRequestSchema
        ).parse(JSON.parse(frame.toString("utf8")) as unknown);
        let attached = false;
        try {
          const attachment = await attachmentPromise;
          attached = true;
          if (disconnected) return;
          const refreshed = options.authority(
            await (options.reauthorize
              ? options.reauthorize(connection.scope)
              : options.authenticate(connection.token)),
          );
          if (
            refreshed.agentBindingId !== authority.agentBindingId ||
            refreshed.ownerId !== authority.ownerId ||
            refreshed.ownerId !== authority.ownerId
          ) {
            throw new Error("CDP authorization scope changed");
          }
          if (disconnected || socket.readyState !== socket.OPEN) return;
          const { result } = await attachment.dispatch(request);
          answering = true;
          void result
            .then(
              (value) => sendJson(socket, { id: request.id, result: value }),
              (error: unknown) => {
                refuse(request.id, error);
                if (error instanceof BrowserCdpConnectionEnded) closeSocket(socket, error);
              },
            )
            .finally(release)
            .catch((error: unknown) => closeSocket(socket, error));
        } catch (error) {
          refuse(request.id, error);
          if (!attached || error instanceof BrowserCdpConnectionEnded) closeSocket(socket, error);
        }
      })
      .finally(() => {
        if (!answering) release();
      })
      .catch((error) => closeSocket(socket, error));
  });
  return close;
}

function bearerToken(headers: IncomingHttpHeaders): string {
  const value = headers.authorization;
  const match = /^Bearer ([^\s]{20,4096})$/u.exec(value ?? "");
  if (!match?.[1])
    throw new OpensteerError({
      code: "unauthorized",
      message: "Browser authorization is missing.",
    });
  return match[1];
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  const data = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > maximumBufferedBytes) {
    socket.close(1013, "CDP client is too slow");
    return;
  }
  socket.send(data);
}

function closeSocket(socket: WebSocket, error: unknown, code = 1008): void {
  if (socket.readyState !== socket.OPEN) return;
  const reason = safeMessage(error, safeMessageOptions);
  // A close reason is at most 123 bytes; cut on a character boundary.
  let bounded = reason;
  while (Buffer.byteLength(bounded, "utf8") > 123) bounded = bounded.slice(0, -1);
  socket.close(code, bounded);
}

const safeMessageOptions = {
  fallback: "CDP bridge failed",
  maximumLength: Number.MAX_SAFE_INTEGER,
} as const;
