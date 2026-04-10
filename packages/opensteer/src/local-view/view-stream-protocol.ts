import type {
  OpensteerViewStreamClientMessage,
  OpensteerViewStreamControlMessage,
  OpensteerViewStreamTab,
} from "@opensteer/protocol";
import WebSocket from "ws";

import type { LocalViewSocket } from "./ws-types.js";

export function buildHelloMessage(args: {
  readonly sessionId: string;
  readonly fps: number;
  readonly quality: number;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
}): OpensteerViewStreamControlMessage {
  return {
    type: "hello",
    sessionId: args.sessionId,
    ts: Date.now(),
    mimeType: "image/jpeg",
    fps: args.fps,
    quality: args.quality,
    viewport: args.viewport,
  };
}

export function buildTabsMessage(args: {
  readonly sessionId: string;
  readonly tabs: readonly OpensteerViewStreamTab[];
  readonly activeTabIndex: number;
}): OpensteerViewStreamControlMessage {
  return {
    type: "tabs",
    sessionId: args.sessionId,
    ts: Date.now(),
    tabs: args.tabs,
    activeTabIndex: args.activeTabIndex,
  };
}

export function buildStatusMessage(args: {
  readonly sessionId: string;
  readonly status: string;
}): OpensteerViewStreamControlMessage {
  return {
    type: "status",
    sessionId: args.sessionId,
    ts: Date.now(),
    status: args.status,
  };
}

export function buildErrorMessage(args: {
  readonly sessionId: string;
  readonly error: string;
}): OpensteerViewStreamControlMessage {
  return {
    type: "error",
    sessionId: args.sessionId,
    ts: Date.now(),
    error: args.error,
  };
}

export function sendControlMessage(
  ws: LocalViewSocket,
  message: OpensteerViewStreamControlMessage,
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(message), { binary: false });
  } catch {}
}

export function parseViewClientMessage(raw: string): OpensteerViewStreamClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<OpensteerViewStreamClientMessage> | null;
    if (parsed?.type !== "stream-config") {
      return null;
    }

    const renderWidth = normalizeRenderDimension(parsed.renderWidth);
    const renderHeight = normalizeRenderDimension(parsed.renderHeight);
    if (renderWidth === null || renderHeight === null) {
      return null;
    }

    return {
      type: "stream-config",
      renderWidth,
      renderHeight,
    };
  } catch {
    return null;
  }
}

function normalizeRenderDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  if (normalized < 100) {
    return null;
  }

  return Math.min(8_192, normalized);
}
