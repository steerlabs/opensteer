import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import {
  displayViewerCloseCodes,
  ComputerUseSessionIdSchema,
  ComputerViewIdSchema,
  type DisplaySource,
  DisplaySourceSchema,
  DisplayViewerClientMessageSchema,
  displayMaxEnvelopeBytes,
} from "@opensteer/protocol";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostAuthenticator } from "../identity/auth.js";
import { normalizeHostError } from "../server/http-errors.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import {
  installWebSocketLiveness,
  scheduleWebSocketExpiration,
} from "../server/websocket-liveness.js";
import { ComputerUseError } from "./computer-use-service.js";
import type { DisplayStreamHub } from "./display-stream-hub.js";

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
const maxViewerMessageBytes = 256 * 1_024;

export function registerComputerUseDisplayRoutes(
  app: FastifyInstance,
  options: {
    readonly hub: DisplayStreamHub;
    readonly authenticator: Pick<HostAuthenticator, "authenticateSession">;
  },
): void {
  const attachViewer = (
    socket: WebSocket,
    request: IncomingMessage,
    source: DisplaySource,
    login: AuthenticatedSession,
  ) => {
    installWebSocketLiveness(socket);
    const pending: { bytes: Buffer; binary: boolean }[] = [];
    let pendingBytes = 0;
    let attachment: Awaited<ReturnType<DisplayStreamHub["attachViewer"]>> | undefined;
    let checking = false;
    const closeForError = (error: unknown) => {
      const code =
        error instanceof ComputerUseError && error.retryable
          ? displayViewerCloseCodes.tryAgain
          : error instanceof OpensteerError && error.code === "unauthorized"
            ? displayViewerCloseCodes.loginEnded
            : error instanceof ComputerUseError ||
                (error instanceof OpensteerError && error.code === "forbidden")
              ? displayViewerCloseCodes.accessEnded
              : displayViewerCloseCodes.tryAgain;
      attachment?.close("authorization-ended", code);
      socket.close(code, "Display authorization ended");
    };
    const cancelExpiry = scheduleWebSocketExpiration(
      Math.min(Date.parse(login.expiresAt), Date.parse(login.absoluteExpiresAt)),
      () => {
        attachment?.close("login-expired", displayViewerCloseCodes.loginEnded);
        socket.close(displayViewerCloseCodes.loginEnded, "Display login expired");
      },
    );
    const recheck = setInterval(() => {
      if (checking) {
        attachment?.close("authorization-unavailable", displayViewerCloseCodes.tryAgain);
        socket.close(displayViewerCloseCodes.tryAgain, "Display authorization unavailable");
        return;
      }
      checking = true;
      void (async () => {
        const current = await options.authenticator.authenticateSession(request.headers, {
          mutation: true,
        });
        if (current.id !== login.id || current.user.id !== login.user.id) {
          throw new OpensteerError({ code: "unauthorized", message: "Login ended" });
        }
        await options.hub.authorize(source, login.user.id);
      })()
        .catch(closeForError)
        .finally(() => {
          checking = false;
        });
    }, 5_000);
    recheck.unref();
    const cleanup = (trigger: string, code?: number) => {
      cancelExpiry();
      clearInterval(recheck);
      pending.length = 0;
      pendingBytes = 0;
      attachment?.close(trigger, code);
    };
    socket.once("close", (code) => cleanup("socket-close", code));
    socket.once("error", () => cleanup("socket-error"));
    const handle = (bytes: Buffer, binary: boolean) => {
      let message;
      try {
        if (binary) throw new Error("JSON commands required");
        message = DisplayViewerClientMessageSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        socket.close(displayViewerCloseCodes.protocolViolation, "Invalid display command");
        return;
      }
      try {
        attachment?.handle(message);
      } catch (error) {
        closeForError(error);
      }
    };
    socket.on("message", (raw, binary) => {
      const bytes = rawDataBuffer(raw);
      if (bytes.byteLength > maxViewerMessageBytes) {
        socket.close(displayViewerCloseCodes.tooLarge, "Display input too large");
        return;
      }
      // Once attached, all messages are synchronous. Acks never queue behind
      // input or an authority read; the bounded inbox covers admission only.
      if (attachment) {
        handle(bytes, binary);
        return;
      }
      if (pending.length >= 64 || pendingBytes + bytes.byteLength > maxViewerMessageBytes) {
        socket.close(displayViewerCloseCodes.tryAgain, "Display input queue exceeded");
        return;
      }
      pending.push({ bytes, binary });
      pendingBytes += bytes.byteLength;
    });
    void (async () => {
      attachment = await options.hub.attachViewer(source, login.user.id, socket, {
        displayWindow:
          new URL(request.url ?? "", "http://host.invalid").searchParams.get("displayWindow") ===
          "1",
        displayCut:
          new URL(request.url ?? "", "http://host.invalid").searchParams.get("displayCut") === "1",
        sharedInput:
          new URL(request.url ?? "", "http://host.invalid").searchParams.get("sharedInput") === "1",
        editing:
          new URL(request.url ?? "", "http://host.invalid").searchParams.get("editing") === "1",
      });
      if (socket.readyState !== socket.OPEN) {
        cleanup("socket-not-open");
        return;
      }
      // Drain messages received during admission before accepting live ones.
      for (const item of pending.splice(0)) handle(item.bytes, item.binary);
      pendingBytes = 0;
    })().catch(closeForError);
  };

  // Each route owns its receiver limit, so fragmented messages are rejected
  // before the Host-wide browser payload budget has been buffered.
  const viewerSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: maxViewerMessageBytes,
  });
  const dataSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: displayMaxEnvelopeBytes,
  });
  const inherited = app.server.listeners("upgrade") as UpgradeListener[];
  if (!inherited.length) throw new Error("Display routes need WebSocket upgrade handling");
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let path: string;
    try {
      path = new URL(request.url ?? "", "http://host.invalid").pathname;
    } catch {
      socket.destroy();
      return;
    }
    const viewer = /^\/v1\/computer-use\/sessions\/([^/]+)\/display$/.exec(path);
    const owner = /^\/v1\/computer-use\/views\/([^/]+)\/([1-9][0-9]*)\/display$/.exec(path);
    if (
      request.method !== "GET" ||
      (!viewer && !owner && path !== hostInternalRoutePaths.computerUseDisplay)
    ) {
      for (const listener of inherited) listener.call(app.server, request, socket, head);
      return;
    }
    socket.on("error", () => undefined);
    const refuse = (error: unknown) => {
      const failure = normalizeHostError(error);
      const bytes = Buffer.from(JSON.stringify({ error: failure.error }));
      if (!socket.destroyed && socket.writable)
        socket.end(
          `HTTP/1.1 ${failure.status} ${STATUS_CODES[failure.status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${bytes.byteLength}\r\n\r\n${bytes.toString()}`,
        );
    };
    if (viewer || owner) {
      void (async () => {
        const login = await options.authenticator.authenticateSession(request.headers, {
          mutation: true,
        });
        const source = DisplaySourceSchema.parse(
          viewer
            ? {
                kind: "task-session",
                sessionId: ComputerUseSessionIdSchema.parse(viewer[1]),
                ...(new URL(request.url ?? "", "http://host.invalid").searchParams.has("appKey")
                  ? {
                      appKey: new URL(request.url ?? "", "http://host.invalid").searchParams.get(
                        "appKey",
                      )!,
                    }
                  : {}),
              }
            : {
                kind: "owner-view",
                viewId: ComputerViewIdSchema.parse(owner![1]),
                generation: Number(owner![2]),
              },
        );
        if (source.kind === "owner-view" && !Number.isSafeInteger(source.generation))
          throw new OpensteerError({ code: "forbidden", message: "Invalid view generation" });
        try {
          await options.hub.authorize(source, login.user.id);
        } catch (error) {
          if (error instanceof ComputerUseError)
            throw new OpensteerError({
              code: error.retryable ? "workspace_unavailable" : "forbidden",
              message: error.message,
            });
          throw error;
        }
        if (socket.destroyed || !socket.writable) return;
        viewerSockets.handleUpgrade(request, socket, head, (client) => {
          client.on("error", () => undefined);
          attachViewer(client, request, source, login);
        });
      })().catch(refuse);
      return;
    }
    let claims: ReturnType<DisplayStreamHub["claimDataSocket"]> | undefined;
    let upgraded = false;
    const failed = () => {
      if (claims && !upgraded) options.hub.failDataSocket(claims);
    };
    try {
      const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
      if (!match?.[1])
        throw new OpensteerError({
          code: "unauthorized",
          message: "A display data ticket is required",
        });
      // Claim atomically before upgrade; a failed upgrade never restores the nonce.
      const claimed = options.hub.claimDataSocket(match[1]);
      claims = claimed;
      socket.once("close", failed);
      socket.once("error", failed);
      dataSockets.handleUpgrade(request, socket, head, (data: WebSocket) => {
        upgraded = true;
        socket.removeListener("close", failed);
        socket.removeListener("error", failed);
        data.on("error", () => undefined);
        options.hub.attachDataSocket(claimed, data);
      });
      // With no asynchronous verifyClient hook, a refused handshake returns
      // without the callback. Tell viewers now rather than waiting for expiry.
      failed();
    } catch (error) {
      failed();
      refuse(error);
    }
  });
  app.addHook("preClose", async () => {
    options.hub.close();
    for (const client of [...viewerSockets.clients, ...dataSockets.clients])
      client.close(displayViewerCloseCodes.hostShutdown, "Host stopping");
  });
}
