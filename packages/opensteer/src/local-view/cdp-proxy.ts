import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket from "ws";

import { resolveLocalViewSession } from "./discovery.js";
import { LocalViewRuntimeState } from "./runtime-state.js";
import {
  LocalViewWebSocketServer,
  type LocalViewSocket,
  type LocalViewSocketServer,
} from "./ws-types.js";

const DEFAULT_MAX_PENDING_CLIENT_BUFFER_BYTES = 1_000_000;
const DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS = 10_000;

export interface LocalViewCdpProxyDeps {
  readonly runtimeState: LocalViewRuntimeState;
  readonly createUpstreamSocket?: (url: string) => LocalViewSocket;
  readonly maxPendingClientBufferBytes?: number;
  readonly upstreamOpenTimeoutMs?: number;
}

export class LocalViewCdpProxy {
  private readonly wss: LocalViewSocketServer;
  private readonly createUpstreamSocket: (url: string) => LocalViewSocket;
  private readonly maxPendingClientBufferBytes: number;
  private readonly upstreamOpenTimeoutMs: number;

  constructor(private readonly deps: LocalViewCdpProxyDeps) {
    this.wss = new LocalViewWebSocketServer({ noServer: true });
    this.createUpstreamSocket =
      deps.createUpstreamSocket ?? ((url) => new WebSocket(url) as unknown as LocalViewSocket);
    this.maxPendingClientBufferBytes =
      deps.maxPendingClientBufferBytes ?? DEFAULT_MAX_PENDING_CLIENT_BUFFER_BYTES;
    this.upstreamOpenTimeoutMs = deps.upstreamOpenTimeoutMs ?? DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const isCdpPath = parts.length === 3 && parts[0] === "ws" && parts[1] === "cdp";
    if (!isCdpPath) {
      socket.destroy();
      return;
    }

    const sessionId = parts[2]!;
    this.wss.handleUpgrade(req, socket, head, (clientSocket) => {
      void this.bindProxy(clientSocket, sessionId).catch(() => {
        safeCloseSocket(clientSocket);
      });
    });
  }

  close(): void {
    for (const client of this.wss.clients) {
      safeCloseSocket(client);
    }
    this.wss.close();
  }

  private async bindProxy(clientSocket: LocalViewSocket, sessionId: string): Promise<void> {
    const resolved = await resolveLocalViewSession(sessionId);
    if (!resolved) {
      safeCloseSocket(clientSocket);
      return;
    }

    const upstream = this.createUpstreamSocket(resolved.browserWebSocketUrl);
    const pendingCreateTargetCommandIds = new Set<number>();
    const pendingAttachTargetCommandTargetIds = new Map<number, string>();
    const targetIdByAttachedSessionId = new Map<string, string>();
    const pendingClientMessages: Array<{
      readonly data: WebSocket.RawData;
      readonly isBinary: boolean;
    }> = [];
    let pendingClientBufferBytes = 0;
    let closed = false;
    let upstreamOpenTimeout: NodeJS.Timeout | null = null;

    const closeConnection = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (upstreamOpenTimeout) {
        clearTimeout(upstreamOpenTimeout);
        upstreamOpenTimeout = null;
      }
      pendingClientMessages.length = 0;
      pendingClientBufferBytes = 0;
      safeCloseSocket(upstream);
      safeCloseSocket(clientSocket);
    };

    upstreamOpenTimeout = setTimeout(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        return;
      }
      closeConnection();
    }, this.upstreamOpenTimeoutMs);

    clientSocket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const outboundData = data;

      if (!isBinary) {
        const message = parseCdpProtocolMessage(data);
        if (message) {
          const activatedTargetId = readActivateTargetCommandTargetId(message);
          if (activatedTargetId) {
            this.deps.runtimeState.setPageActivationIntent(sessionId, activatedTargetId);
          }

          const createTargetCommandId = readCreateTargetCommandId(message);
          if (createTargetCommandId !== null) {
            pendingCreateTargetCommandIds.add(createTargetCommandId);
          }

          const attachTargetCommand = readAttachTargetCommand(message);
          if (attachTargetCommand) {
            pendingAttachTargetCommandTargetIds.set(
              attachTargetCommand.id,
              attachTargetCommand.targetId,
            );
          }

          const interactionTargetId = readInteractionTargetId(message, targetIdByAttachedSessionId);
          if (interactionTargetId) {
            this.deps.runtimeState.setPageActivationIntent(sessionId, interactionTargetId);
          }
        }
      }

      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(outboundData, { binary: isBinary });
        return;
      }
      if (upstream.readyState !== WebSocket.CONNECTING) {
        closeConnection();
        return;
      }

      const sizeBytes = rawDataSizeBytes(outboundData);
      if (pendingClientBufferBytes + sizeBytes > this.maxPendingClientBufferBytes) {
        closeConnection();
        return;
      }
      pendingClientMessages.push({ data: outboundData, isBinary });
      pendingClientBufferBytes += sizeBytes;
    });

    upstream.on("open", () => {
      if (upstreamOpenTimeout) {
        clearTimeout(upstreamOpenTimeout);
        upstreamOpenTimeout = null;
      }
      for (const pendingMessage of pendingClientMessages.splice(0)) {
        upstream.send(pendingMessage.data, { binary: pendingMessage.isBinary });
      }
      pendingClientBufferBytes = 0;
    });

    upstream.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        const message = parseCdpProtocolMessage(data);
        if (message) {
          const createdTargetId = readCreateTargetResultTargetId(
            message,
            pendingCreateTargetCommandIds,
          );
          if (createdTargetId) {
            this.deps.runtimeState.setPageActivationIntent(sessionId, createdTargetId);
          }

          const attachedTarget = readAttachTargetResult(
            message,
            pendingAttachTargetCommandTargetIds,
          );
          if (attachedTarget) {
            targetIdByAttachedSessionId.set(attachedTarget.sessionId, attachedTarget.targetId);
          }

          const detachedSessionId = readDetachedTargetSessionId(message);
          if (detachedSessionId) {
            targetIdByAttachedSessionId.delete(detachedSessionId);
          }
        }
      }

      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });

    clientSocket.on("close", closeConnection);
    clientSocket.on("error", closeConnection);
    upstream.on("close", closeConnection);
    upstream.on("error", closeConnection);
  }
}

interface ParsedCdpProtocolMessage {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

function parseCdpProtocolMessage(data: WebSocket.RawData): ParsedCdpProtocolMessage | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as ParsedCdpProtocolMessage | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readCreateTargetCommandId(message: ParsedCdpProtocolMessage): number | null {
  return message.method === "Target.createTarget" && typeof message.id === "number"
    ? message.id
    : null;
}

function readCreateTargetResultTargetId(
  message: ParsedCdpProtocolMessage,
  pendingCommandIds: Set<number>,
): string | null {
  if (typeof message.id !== "number" || !pendingCommandIds.has(message.id)) {
    return null;
  }
  pendingCommandIds.delete(message.id);
  const targetId = message.result?.targetId;
  return typeof targetId === "string" && targetId.length > 0 ? targetId : null;
}

function readActivateTargetCommandTargetId(message: ParsedCdpProtocolMessage): string | null {
  const targetId =
    message.method === "Target.activateTarget" ? message.params?.targetId : undefined;
  return typeof targetId === "string" && targetId.length > 0 ? targetId : null;
}

function readAttachTargetCommand(message: ParsedCdpProtocolMessage): {
  readonly id: number;
  readonly targetId: string;
} | null {
  if (message.method !== "Target.attachToTarget" || typeof message.id !== "number") {
    return null;
  }
  const targetId = message.params?.targetId;
  if (typeof targetId !== "string" || targetId.length === 0) {
    return null;
  }
  return {
    id: message.id,
    targetId,
  };
}

function readAttachTargetResult(
  message: ParsedCdpProtocolMessage,
  pendingTargetIds: Map<number, string>,
): {
  readonly sessionId: string;
  readonly targetId: string;
} | null {
  if (typeof message.id !== "number") {
    return null;
  }
  const targetId = pendingTargetIds.get(message.id);
  if (!targetId) {
    return null;
  }
  pendingTargetIds.delete(message.id);
  const sessionId = message.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  return {
    sessionId,
    targetId,
  };
}

function readInteractionTargetId(
  message: ParsedCdpProtocolMessage,
  targetIdByAttachedSessionId: Map<string, string>,
): string | null {
  const sessionId = message.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  if (
    !message.method ||
    (!message.method.startsWith("Input.") && !message.method.startsWith("Page."))
  ) {
    return null;
  }
  return targetIdByAttachedSessionId.get(sessionId) ?? null;
}

function readDetachedTargetSessionId(message: ParsedCdpProtocolMessage): string | null {
  if (message.method !== "Target.detachedFromTarget") {
    return null;
  }
  const sessionId = message.params?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data.toString("utf8");
}

function rawDataSizeBytes(data: WebSocket.RawData): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, entry) => total + entry.byteLength, 0);
  }
  return data.byteLength;
}

function safeCloseSocket(socket: LocalViewSocket): void {
  try {
    socket.close();
  } catch {}
}
