import { safeMessage } from "@opensteer/shared/safeMessage";
import type { IncomingHttpHeaders } from "node:http";
import type { EnvironmentId, UserId, WorkspaceId } from "@opensteer/core";
import { BrowserSessionIdSchema, type BrowserSessionId } from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { z } from "zod";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import type {
  AgentControlRunScope,
  AgentControlTokenService,
} from "../agents/agent-control-service.js";
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
  readonly environmentId?: EnvironmentId;
  readonly ownerId: UserId;
  readonly workspaceId: WorkspaceId;
}

interface CdpRouteOptions<Scope> {
  readonly authenticate: (token: string) => Promise<Scope>;
  readonly authority: (scope: Scope) => CdpAuthority;
  readonly browser: Pick<
    BrowserService,
    "attachCdpForAgent" | "closeTriggerSessionsForBinding" | "openAgentSession"
  >;
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
}

export function registerAgentCdpBridge(
  app: FastifyInstance,
  browser: BrowserService,
  tokens: AgentControlTokenService,
): void {
  const route = {
    authenticate: (token: string) => tokens.authenticate(token),
    authority: (scope: AgentControlRunScope) => ({
      agentBindingId: `run:${scope.runId}`,
      ownerId: scope.requestedBy,
      workspaceId: scope.workspaceId,
    }),
    browser,
    ownsSession: false,
    // An agent's browser connection lasts as long as its Run's grant, which a
    // long Run outlives its first token by.
    reauthorize: (scope: AgentControlRunScope) => tokens.reauthorize(scope),
  };
  registerCdpRoute<AgentControlRunScope>(app, {
    ...route,
    path: hostInternalRoutePaths.browserSessionCdp,
  });
  registerCdpRoute<AgentControlRunScope>(app, {
    ...route,
    path: hostInternalRoutePaths.browserCdp,
  });
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
      workspaceId: scope.workspaceId,
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
      workspaceId: scope.workspaceId,
    }),
    browser,
    expiresAt: (scope) => scope.exp * 1_000,
    ownsSession: true,
    path: hostInternalRoutePaths.watchCdp,
  });
}

function registerCdpRoute<Scope>(app: FastifyInstance, options: CdpRouteOptions<Scope>): void {
  const connections = new WeakMap<
    object,
    { readonly scope: Scope; readonly sessionId: string | undefined; readonly token: string }
  >();
  app.get(
    options.path,
    {
      preValidation: async (request) => {
        const token = bearerToken(request.headers);
        const scope = await options.authenticate(token);
        const parameters = request.params as { readonly sessionId?: unknown };
        const sessionId =
          typeof parameters.sessionId === "string" ? parameters.sessionId : undefined;
        connections.set(request.raw, { scope, sessionId, token });
      },
      websocket: true,
    },
    (socket, request) => {
      const connection = connections.get(request.raw);
      if (!connection) return socket.close(1008, "Authentication required");
      attachCdpSocket(socket, options, connection);
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
): void {
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
  const attachmentPromise = (async () => {
    let sessionId: BrowserSessionId | undefined;
    if (connection.sessionId !== undefined) {
      const parsed = BrowserSessionIdSchema.safeParse(connection.sessionId);
      if (!parsed.success) {
        throw new BrowserCdpConnectionEnded(
          `"${connection.sessionId.slice(0, 80)}" is not a Browser Session ID. browser_session_open and browser_session_list return session IDs.`,
        );
      }
      sessionId = parsed.data;
    }
    if (options.ownsSession) {
      const opened = await options.browser.openAgentSession({ ...authority, fresh: true });
      ownedSessionOpened = true;
      sessionId = opened.session.id;
    }
    return options.browser.attachCdpForAgent(
      { ...authority, ...(sessionId ? { sessionId } : {}) },
      (event) => {
        sendJson(socket, {
          method: event.method,
          params: event.parameters,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
      },
      () => closeSocket(socket, new Error("The Browser Session ended."), 1000),
    );
  })();
  // A client that never sends a command still learns why it cannot connect.
  let refusalTimer: NodeJS.Timeout | undefined;
  attachmentPromise.then(
    (attachment) => {
      if (disconnected) attachment.close();
    },
    (error: unknown) => {
      refusalTimer = setTimeout(() => closeSocket(socket, error), 10_000);
      refusalTimer.unref();
    },
  );
  const close = () => {
    if (disconnected) return;
    disconnected = true;
    if (expirationTimer) clearTimeout(expirationTimer);
    if (refusalTimer) clearTimeout(refusalTimer);
    void attachmentPromise.then((attachment) => attachment.close()).catch(() => undefined);
    if (options.ownsSession) {
      void attachmentPromise
        .catch(() => undefined)
        .then(() =>
          ownedSessionOpened
            ? options.browser.closeTriggerSessionsForBinding(authority.agentBindingId)
            : undefined,
        )
        .catch(() => undefined);
    }
  };
  socket.once("close", close);
  socket.once("error", close);
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      closeSocket(socket, new Error("CDP messages must be JSON text"));
      return;
    }
    const frame = rawDataBuffer(raw);
    if (frame.byteLength > maximumCdpMessageBytes) {
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
    const refuse = (id: number, error: unknown) =>
      sendJson(socket, {
        error: { code: -32_000, message: safeMessage(error, safeMessageOptions) },
        id,
      });
    // Commands are admitted and dispatched one at a time, in the order they
    // arrived; each is answered whenever the browser answers it. A command
    // that a dialog blocks therefore never holds up the dialog's answer or a
    // detach, which the runtime runs past a blocked page.
    let answering = false;
    commands = commands
      .then(async () => {
        if (disconnected || socket.readyState !== socket.OPEN) return;
        const request = CdpRequestSchema.parse(JSON.parse(frame.toString("utf8")) as unknown);
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
            refreshed.workspaceId !== authority.workspaceId
          ) {
            throw new Error("CDP authorization scope changed");
          }
          if (disconnected || socket.readyState !== socket.OPEN) return;
          const { result } = await attachment.dispatch({
            method: request.method,
            ...(request.params ? { parameters: request.params } : {}),
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          });
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
}

function bearerToken(headers: IncomingHttpHeaders): string {
  const value = headers.authorization;
  const match = /^Bearer ([^\s]{20,4096})$/u.exec(value ?? "");
  if (!match?.[1]) throw new Error("CDP authorization is missing");
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
