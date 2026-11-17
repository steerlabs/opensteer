import { randomUUID } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import { OpensteerError } from "@opensteer/core";
import { PersonalSyncSocket, type RealtimeHub } from "@opensteer/orchestration";
import { ScopedClientMessageSchema } from "@opensteer/protocol/personal-sync";
import type { HostToClientMessage } from "@opensteer/protocol";
import type { AuthenticatedHostSession } from "../identity/auth.js";
import type { createPersonalReads } from "./personal-reads.js";
import type { PersonalResources } from "./personal-resources.js";
import { installWebSocketLiveness, scheduleWebSocketExpiration } from "./websocket-liveness.js";

const authorityCloseCode = 4003;
const socketBudget = 512 * 1024;

export function attachPersonalSocket(options: {
  socket: WebSocket;
  logFailure: (error: unknown) => void;
  authenticated: AuthenticatedHostSession;
  realtime: RealtimeHub;
  reads: ReturnType<typeof createPersonalReads>;
  resources: PersonalResources;
  refreshOwner: () => void;
  probeMachines: () => void;
  liveText?: import("../runtime/personal-live-text.js").PersonalLiveText;
}) {
  const {
    socket,
    realtime,
    authenticated: { session, surface },
    reads,
    resources,
  } = options;
  const expires = Math.min(Date.parse(session.expiresAt), Date.parse(session.absoluteExpiresAt));
  installWebSocketLiveness(socket);
  let attached = false;
  const send = async (
    data: string,
    guard: () => boolean,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (signal.aborted || socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(data) > socketBudget) {
      socket.close(4009, "Personal socket is over capacity");
      return false;
    }
    if (Date.now() >= expires) {
      socket.close(authorityCloseCode, "Session ended");
      return false;
    }
    if (!guard()) return false;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      socket.send(data, (error) => {
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve(true);
      });
    });
  };
  const sync = new PersonalSyncSocket({
    read: async (scope, cursor, signal, anchorItemId, selectedThreadId) => {
      signal.throwIfAborted();
      try {
        return await reads.readCut(session, surface, scope, cursor, anchorItemId, selectedThreadId);
      } catch (error) {
        if (error instanceof OpensteerError && ["forbidden", "unauthorized"].includes(error.code))
          socket.close(authorityCloseCode, "Deployment subscription forbidden");
        throw error;
      }
    },
    readLive: (scope, request) => options.liveText?.read(scope, request) ?? [],
    onFailure: options.logFailure,
    readResources: (kinds, installed, signal) =>
      resources.watched(session, kinds, installed, signal),
    send,
    close: (reason) => {
      if (socket.readyState === socket.OPEN)
        socket.close(
          reason.startsWith("Personal authority changed") ? authorityCloseCode : 1011,
          reason,
        );
    },
  });
  const sink = {
    id: randomUUID(),
    send: async (message: HostToClientMessage) => {
      const scopes = ["shell", `session:${session.id}`];
      if ("threadId" in message && typeof message.threadId === "string")
        scopes.push(`thread:${message.threadId}`);
      if ("threadIds" in message) scopes.push(...message.threadIds.map((id) => `thread:${id}`));
      const guard = realtime.guardRead(scopes);
      try {
        await send(JSON.stringify(message), guard.current, AbortSignal.timeout(5_000));
      } finally {
        guard.release();
      }
    },
    close: (code: number, reason: string) => socket.close(code, reason),
  };
  const unregister = realtime.registerConnection({
    userId: session.user.id,
    sessionId: session.id,
    sink,
    sync,
  });
  const cancelExpiry = scheduleWebSocketExpiration(expires, () =>
    realtime.closeSession(session.id),
  );
  const close = () => {
    cancelExpiry();
    unregister();
    sync.close("Personal socket closed");
  };
  socket.once("close", close);
  socket.once("error", close);
  socket.on("message", (bytes, binary) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      if (binary || Array.isArray(bytes)) throw new Error("Expected a text frame");
      const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (raw.byteLength > 32 * 1024) throw new Error("Maximum client frame exceeded");
      const message = ScopedClientMessageSchema.parse(JSON.parse(raw.toString("utf8")));
      if (message.type === "client.ping") {
        void sink
          .send({ type: "host.pong", nonce: message.nonce })
          .catch(() => sync.close("Personal ping failed"));
        return;
      }
      if (message.type === "client.attach") {
        if (attached) throw new Error("Already attached");
        attached = true;
        options.refreshOwner();
        if (message.interests.includes("machine")) options.probeMachines();
        sync.attach(message);
        return;
      }
      if (!attached) throw new Error("Attach before subscribing");
      switch (message.type) {
        case "client.subscribe":
          sync.subscribe(message);
          break;
        case "client.unsubscribe":
          sync.unsubscribe(message);
          break;
        case "client.ack":
          sync.ack(message);
          break;
        case "client.resources.watch":
          if (message.interests.includes("owner-profile")) options.refreshOwner();
          if (message.interests.includes("machine")) options.probeMachines();
          sync.watchResources(message);
          break;
        case "client.live.resync":
          sync.resyncLive(message);
          break;
      }
    } catch {
      socket.close(1008, "Invalid personal sync message");
    }
  });
}
