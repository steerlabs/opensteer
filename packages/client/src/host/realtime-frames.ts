import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  browserTabCatalogMaxBytes,
  HostToClientMessageSchema,
  type HostToClientMessage,
  type RealtimeFrameDiagnostic,
} from "@opensteer/protocol";
import { z } from "zod";

export const maxInboundFrameCharacters = browserTabCatalogMaxBytes + 4 * 1024;

export const realtimeEnvelopeTypes = new Set<string>(
  HostToClientMessageSchema.options.map((schema) => schema.shape.type.value),
);

/**
 * What losing a frame costs. `replay`: it moves the cursor or the sync state,
 * so it is never skipped. `reread`: something shown goes stale until it is read
 * again. `none`: nothing is owed, because the frame is momentary or the next
 * frame repairs it.
 */
export type RealtimeFrameLoss = "none" | "replay" | "reread";

const realtimeFrameLosses = {
  "host.error": "replay",
  "host.events": "replay",
  "host.resync-required": "replay",
  "host.snapshot": "replay",
  "host.synchronized": "replay",

  "host.browser-history-changed": "reread",
  "host.browser-presence": "reread",
  "host.browser-sessions-changed": "reread",
  "host.browser-tabs-changed": "reread",
  "host.browser-usage-changed": "reread",
  "host.computer-presence": "reread",
  "host.computer-view.changed": "reread",
  "host.computer-view.removed": "reread",
  "host.connections-changed": "reread",
  "host.machine.access.session.ended": "reread",
  "host.machine.access.session.started": "reread",
  "host.machines.changed": "reread",
  "host.notification-preferences": "reread",
  "host.personal-remote-access-changed": "reread",
  "host.plugins-changed": "reread",
  "host.read-markers": "reread",
  "host.read-states": "reread",
  "host.requests-changed": "reread",
  "host.tasks-changed": "reread",
  "host.triggers-changed": "reread",

  // The next frame of a stream shows the gap, and that rereads the stream.
  "host.live": "none",
  "host.notification": "none",
  "host.place-activity": "none",
  "host.place-activity-cleared": "none",
  // An unanswered probe replaces its socket.
  "host.pong": "none",
  "host.show": "none",
  "host.thread-place-changed": "none",
} as const satisfies Record<HostToClientMessage["type"], RealtimeFrameLoss>;

const realtimeFrameLossByType = new Map<string, RealtimeFrameLoss>(
  Object.entries(realtimeFrameLosses),
);

/** A frame with no readable envelope could have been any frame, so it is treated as the worst. */
export function realtimeFrameLoss(envelopeType: string): RealtimeFrameLoss {
  return realtimeFrameLossByType.get(envelopeType) ?? "replay";
}

function collectFieldNames(value: unknown, names: Set<string>, seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFieldNames(item, names, seen);
    return;
  }
  if (!(value instanceof z.core.$ZodType) || seen.has(value)) return;
  seen.add(value);
  const def = (value as z.core.$ZodTypes)._zod.def;
  if (def.type === "object") {
    for (const [name, field] of Object.entries(def.shape)) {
      names.add(name);
      collectFieldNames(field, names, seen);
    }
  }
  if (def.type === "lazy") collectFieldNames(def.getter(), names, seen);
  for (const child of Object.values(def)) collectFieldNames(child, names, seen);
}

let wireFieldNames: ReadonlySet<string> | undefined;

/**
 * Issue paths can contain record keys supplied by the peer, so a path names
 * only what the wire schemas declare and masks the rest. Walked on first
 * failure: a healthy client never pays for it.
 */
function isWireFieldName(part: string): boolean {
  if (!wireFieldNames) {
    const names = new Set<string>();
    collectFieldNames(HostToClientMessageSchema, names, new Set());
    wireFieldNames = names;
  }
  return wireFieldNames.has(part);
}

export function realtimeEnvelopeType(frame: unknown): string {
  if (typeof frame !== "string" || frame.length > maxInboundFrameCharacters) return "unknown";
  try {
    const value: unknown = JSON.parse(frame);
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      typeof value.type === "string" &&
      realtimeEnvelopeTypes.has(value.type)
    )
      return value.type;
  } catch {
    /* Invalid JSON has no trustworthy envelope. */
  }
  return "unknown";
}

export function describeRealtimeFrameFailure(
  frame: unknown,
  error: unknown,
): Omit<RealtimeFrameDiagnostic, "event"> {
  const issuePaths =
    error instanceof z.ZodError
      ? [
          ...new Set(
            error.issues.slice(0, 8).map(({ path }) =>
              path.length === 0
                ? "$"
                : path
                    .slice(0, 12)
                    .map((part) =>
                      typeof part === "number"
                        ? "[]"
                        : typeof part === "string" && isWireFieldName(part)
                          ? part
                          : "*",
                    )
                    .join("."),
            ),
          ),
        ]
      : ["$"];
  const bytes =
    typeof frame === "string"
      ? new TextEncoder().encode(frame).byteLength
      : frame instanceof ArrayBuffer
        ? frame.byteLength
        : ArrayBuffer.isView(frame)
          ? frame.byteLength
          : 0;
  return {
    envelopeType: realtimeEnvelopeType(frame),
    apiEpoch: hostApiVersion,
    bytes,
    issuePaths,
    category:
      error instanceof z.ZodError ? "schema" : error instanceof SyntaxError ? "json" : "frame",
  };
}
