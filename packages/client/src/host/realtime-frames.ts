import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  isRealtimeWireField,
  realtimeEnvelopeTypes,
  type HostToClientMessage,
  type RealtimeFrameDiagnostic,
} from "@opensteer/protocol";
import { z } from "zod";

export const maxInboundFrameCharacters = 2 * 1024 * 1024 + 4 * 1024;

/**
 * How long a viewer socket must stay up before its failures are forgotten.
 * Every connect brings a snapshot, a dialog reply and often a picture, so a
 * frame read fine proves nothing until the socket has outlasted them.
 */
export const healthySocketMs = 30_000;

/**
 * What losing a frame costs, which is what repairs it. `replay`: subscribing
 * from the same cursor sends it again, so it is never skipped. `snapshot`: no
 * subscribe from that cursor would, so only a fresh snapshot answers for it.
 * `none`: nothing is owed. Every other value names the read that answers for
 * what it carried.
 */
export type RealtimeFrameLoss =
  | "bootstrap"
  | "browser-stream"
  | "browser-history"
  | "browser-usage"
  | "machines"
  | "none"
  | "place-activity"
  | "replay"
  | "snapshot"
  | "triggers";

const realtimeFrameLosses = {
  "host.error": "replay",
  "host.events": "replay",
  "host.snapshot": "replay",
  "host.synchronized": "replay",
  "host.node-watched": "replay",
  // Every subscribe streams all of these.
  "host.read-markers": "replay",
  // Synchronizing reissues this invalidation whatever frame carried it.
  "host.personal-remote-access-changed": "replay",

  // Resent only for Threads with events in the replay, which may be none.
  "host.read-states": "snapshot",
  // Asked for by a live condition that is gone by the next subscribe.
  "host.resync-required": "snapshot",
  // Nothing resends these. They carry only `type`, so they cannot be unreadable.
  "host.connections-changed": "snapshot",
  "host.plugins-changed": "snapshot",

  "host.browser-groups": "browser-stream",
  "host.browser-tabs": "browser-stream",
  "host.app-tabs-changed": "bootstrap",
  "host.browser-sessions-changed": "bootstrap",
  "host.computer-presence": "bootstrap",
  "host.computer-view.changed": "bootstrap",
  "host.computer-view.removed": "bootstrap",
  "host.notification-preferences": "bootstrap",
  "host.requests-changed": "bootstrap",
  "host.tasks-changed": "bootstrap",

  "host.browser-history-changed": "browser-history",
  "host.browser-usage-changed": "browser-usage",
  "host.machine.access.session.ended": "machines",
  "host.machine.access.session.started": "machines",
  "host.machines.changed": "machines",
  // Only a clear or a newer record removes an agent, so a lost one leaves a ghost.
  "host.place-activity": "place-activity",
  "host.place-activity-cleared": "place-activity",
  "host.triggers-changed": "triggers",

  // The next frame of a stream shows the gap, and its durable event replaces it.
  "host.live": "none",
  "host.notification": "none",
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
                        : typeof part === "string" && isRealtimeWireField(part)
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
