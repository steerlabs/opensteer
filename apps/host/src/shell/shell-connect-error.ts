import {
  ShellConnectErrorSchema,
  type ShellConnectError,
  type ShellConnectErrorCode,
} from "@opensteer/protocol";

/**
 * The HTTP status each refusal answers with. The body is what a person reads —
 * the proxy prints `message` verbatim and nothing else — so the status is only
 * for the transport, and every one of them is a 4xx because every refusal is
 * something about the request rather than about this Host.
 */
const shellConnectStatuses: Readonly<Record<ShellConnectErrorCode, number>> = {
  module_unavailable: 409,
  reach_denied: 403,
  run_invalid: 401,
  target_offline: 409,
  target_unknown: 404,
  too_many_sessions: 429,
};

/**
 * A refusal the caller's ssh proxy can print as-is.
 *
 * The message is always a complete sentence naming the computer, because it is
 * the only thing the person running `ssh` will see: OpenSSH prints the
 * ProxyCommand's stderr and then its own generic failure.
 */
export class ShellConnectRejection extends Error {
  readonly code: ShellConnectErrorCode;
  readonly status: number;

  constructor(code: ShellConnectErrorCode, message: string) {
    super(message);
    this.name = "ShellConnectRejection";
    this.code = code;
    this.status = shellConnectStatuses[code];
  }

  body(): ShellConnectError {
    return ShellConnectErrorSchema.parse({ error: { code: this.code, message: this.message } });
  }
}

/**
 * How long ago a computer was last heard from, as the offline sentence says it.
 *
 * Rounded down to the largest whole unit: the number is there so a person can
 * tell "asleep since last night" from "just dropped off", and a precise
 * duration would suggest the Host knows more than it does.
 */
export function describeMachineLastSeen(lastSeenAt: Date | null, now: number): string {
  if (!lastSeenAt) return "never seen";
  const elapsed = Math.max(0, now - lastSeenAt.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "last seen moments ago";
  if (minutes < 60) return `last seen ${count(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${count(hours, "hour")} ago`;
  return `last seen ${count(Math.floor(hours / 24), "day")} ago`;
}

function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
