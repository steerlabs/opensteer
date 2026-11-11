import type {} from "@fastify/websocket";
import { OpensteerError } from "@opensteer/core";
import {
  BrowserActionRequestSchema,
  BrowserActionErrorCodeSchema,
  BrowserActionDialogSchema,
  browserActionMaxBytes,
} from "@opensteer/protocol/browser-actions";
import { safeMessage } from "@opensteer/shared/safeMessage";
import type { IncomingHttpHeaders } from "node:http";
import type { EnvironmentId, UserId } from "@opensteer/core";
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
  readonly backend?: "actions";
}

export function registerAgentCdpBridge(
  app: FastifyInstance,
  browser: BrowserService,
  tokens: RunToolTokenService,
): void {
  const route = {
    authenticate: (token: string) => tokens.authenticate(token),
    authority: (scope: RunToolScope) => ({
      agentBindingId: `run:${scope.runId}`,
      ownerId: scope.requestedBy,
    }),
    browser,
    ownsSession: false,
    // An agent's browser connection lasts as long as its Run's grant, which a
    // long Run outlives its first token by.
    reauthorize: (scope: RunToolScope) => tokens.reauthorize(scope),
  };
  registerCdpRoute<RunToolScope>(app, {
    ...route,
    backend: "actions",
    path: hostInternalRoutePaths.browserSessionActions,
  });
  app.get(hostInternalRoutePaths.browserSessionBackend, async (request) => {
    const connection = await authenticateConnection(request, route);
    const sessionId = BrowserSessionIdSchema.parse(connection.sessionId);
    try {
      return await browser.agentBackend({ ...route.authority(connection.scope), sessionId });
    } catch (error) {
      if (error instanceof BrowserCdpConnectionEnded)
        throw new OpensteerError({ code: "forbidden", message: error.message });
      throw error;
    }
  });
  registerCdpRoute<RunToolScope>(app, {
    ...route,
    path: hostInternalRoutePaths.browserSessionCdp,
  });
  registerCdpRoute<RunToolScope>(app, {
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

function registerCdpRoute<Scope>(app: FastifyInstance, options: CdpRouteOptions<Scope>): void {
  const connections = new WeakMap<
    object,
    { readonly scope: Scope; readonly sessionId: string | undefined; readonly token: string }
  >();
  app.get(
    options.path,
    {
      preValidation: async (request) => {
        connections.set(request.raw, await authenticateConnection(request, options));
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
    if (options.backend === "actions") {
      if (!sessionId)
        throw new BrowserCdpConnectionEnded("Actions require an exact Browser Session.");
      const attached = await options.browser.attachActionsForAgent(
        { ...authority, sessionId },
        (event) => sendJson(socket, { event }),
        () => closeSocket(socket, new Error("The Browser Session ended."), 1000),
      );
      return {
        close: () => attached.close(),
        dispatch: (value: unknown) => attached.dispatch(BrowserActionRequestSchema.parse(value)),
      };
    }
    const attached = await options.browser.attachCdpForAgent(
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
    return {
      close: () => attached.close(),
      dispatch: (value: unknown) => {
        const request = CdpRequestSchema.parse(value);
        return attached.dispatch({
          method: request.method,
          ...(request.params ? { parameters: request.params } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
      },
    };
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
      const message = safeMessage(error, safeMessageOptions);
      if (options.backend === "actions") {
        const dialog =
          error instanceof OpensteerError
            ? BrowserActionDialogSchema.safeParse(error.details?.dialog).data
            : undefined;
        sendJson(socket, {
          id,
          error: { code: reason ?? "forbidden", message, ...(dialog ? { dialog } : {}) },
        });
      } else
        sendJson(socket, { id, error: { code: -32_000, message, ...(reason ? { reason } : {}) } });
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
