import { classifyClientFailure } from "../connections/operation-error.js";

export type ClientIssueCode =
  | "connection"
  | "sign-in"
  | "update-app"
  | "update-server"
  | "web-outdated"
  | "access-lost"
  | "read-failed"
  | "refresh-failed"
  | "not-sent"
  | "unconfirmed"
  | "rejected"
  | "storage-unavailable"
  | "queue-full"
  | "preparation-required";

export interface ClientIssue {
  readonly code: ClientIssueCode;
  readonly reason?: string;
  readonly name?: string;
  readonly target?: "computer" | "team";
  readonly resource?: string;
  /** The whole verb phrase, as "Couldn't {action}." says it: "close this tab". */
  readonly action?: string;
  /** Its past participle, as "Not {done}." says it: "closed". */
  readonly done?: string;
  /** The full clause "Couldn't confirm {happened}." says: "your answer was sent". */
  readonly happened?: string;
}
export interface ClientIssuePresentation {
  readonly title: string;
  readonly detail: string | null;
  readonly action: "retry" | "sign-in" | "update" | "reload" | "check" | null;
}

export function clientIssue(
  error: unknown,
  context: {
    readonly operation: "read" | "refresh" | "action";
    readonly label: string;
  },
): ClientIssue | null {
  const failure = classifyClientFailure(error);
  if (failure.kind === "cancelled") return null;
  if (failure.reason === "storage-unavailable") return { code: "storage-unavailable" };
  if (failure.reason === "queue-full") return { code: "queue-full" };
  if (failure.code === "unauthorized") return { code: "sign-in" };
  if (["client-too-old", "api-version-mismatch", "unsupported-version"].includes(failure.reason))
    return { code: "update-app" };
  if (failure.reason === "host-too-old") return { code: "update-server" };
  if (failure.kind === "session") return { code: "access-lost" };
  if (context.operation !== "action")
    return {
      code: context.operation === "read" ? "read-failed" : "refresh-failed",
      resource: context.label,
      reason: failure.reason,
    };
  return failure.kind === "rejection"
    ? { code: "rejected", reason: failure.reason, action: context.label }
    : { code: "unconfirmed", action: context.label };
}

const rejectionReasons: Readonly<Record<string, string>> = {
  forbidden: "You don't have access.",
  "permission-denied": "You don't have access.",
  "access-denied": "You don't have access.",
  not_found: "It may have been deleted, or you don't have access.",
  "thread-not-found": "This task is no longer available.",
  "thread-closed": "This task is closed.",
  "browser-session-closed": "This tab is closed.",
  "personal-remote-access-off": "Turn on Use from anywhere to add a computer.",
  "resource-exhausted": "Too many messages waiting.",
  "integration-key-rejected": "The service turned this key away.",
  "integration-key-unchecked": "Opensteer couldn't check this key. Check it and its permissions.",
};

function rejectionDetail(reason: string | undefined): string | undefined {
  return reason && Object.hasOwn(rejectionReasons, reason) ? rejectionReasons[reason] : undefined;
}

export function clientDisplayName(
  name: string | null | undefined,
  target: "computer" | "team" = "computer",
): string {
  const safe = name
    ? Array.from(name)
        .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join("")
        .trim()
    : undefined;
  return safe && (target === "team" ? safe.length <= 80 : safe.length <= 18)
    ? safe
    : target === "team"
      ? "your team"
      : "your computer";
}

export function presentClientIssue(issue: ClientIssue): ClientIssuePresentation {
  const name = clientDisplayName(issue.name, issue.target);
  const team = issue.target === "team";
  const result = (
    title: string,
    action: ClientIssuePresentation["action"] = null,
    detail: string | null = null,
  ): ClientIssuePresentation => ({ title, detail, action });
  switch (issue.code) {
    case "connection":
      return issue.reason === "offline"
        ? result("Offline")
        : issue.reason === "unreachable"
          ? result(`Can't reach ${name}`, "retry")
          : result(team ? `Reconnecting to ${name}…` : "Reconnecting…");
    case "sign-in":
      return result(team ? `Signed out of ${name}` : "Signed out", "sign-in");
    case "update-app":
      return result(team ? `Update Opensteer to use ${name}` : "Update Opensteer", "update");
    case "update-server":
      return result(team ? `${name}'s server needs an update` : `${name} needs an update`);
    case "web-outdated":
      return result("Opensteer was updated", "reload");
    case "access-lost":
      return team
        ? result(`You're no longer in ${name}`, null, "Ask a team admin to add you back.")
        : result(
            "This isn't available",
            null,
            "It may have been deleted, or you don't have access.",
          );
    case "read-failed":
      return result(
        `Couldn't load ${issue.resource ?? "this"}.`,
        "retry",
        issue.reason === "not_found" ? (rejectionDetail(issue.reason) ?? null) : null,
      );
    case "refresh-failed":
      return result(`Couldn't refresh ${issue.resource ?? "this"}.`, "retry");
    case "not-sent":
      // No reason: a check after a lost answer found it was not done, so it can be tried again.
      return issue.reason === undefined
        ? result(`Not ${issue.done ?? "changed"}.`, "retry")
        : result(
            `Not ${issue.done ?? "changed"}. ${issue.reason === "offline" ? "You're offline." : `Can't reach ${name}.`}`,
          );
    case "unconfirmed":
      return result(`Couldn't confirm ${issue.happened ?? "this change"}.`, "check");
    case "rejected": {
      const reason = rejectionDetail(issue.reason);
      return result(
        reason
          ? `Not ${issue.done ?? "changed"}. ${reason}`
          : `Couldn't ${issue.action ?? "change this"}.`,
      );
    }
    case "storage-unavailable":
      return result("Couldn't save this message on this device. Try again.", "retry");
    case "queue-full":
      return result("Too many messages waiting.");
    case "preparation-required":
      return result("Waiting to upload", null, "Sends once your files upload.");
  }
}

export function presentMessageDelivery(
  phase: "waiting" | "sending" | "rejected",
  issue?: ClientIssue,
): string {
  if (issue?.code === "unconfirmed")
    return presentClientIssue({ happened: "this message was sent", ...issue }).title;
  if (phase === "sending") return "Sending…";
  if (phase === "waiting") return "Waiting to send";
  return `Not sent. ${presentMessageRejection(issue)}`;
}

export function presentMessageRejection(issue?: ClientIssue): string {
  return (
    rejectionDetail(issue?.reason) ??
    `${clientDisplayName(issue?.name, issue?.target)} didn't accept it.`
  );
}

export function presentActionFailure(error: unknown, _context?: string): string {
  const issue = clientIssue(error, { operation: "action", label: "complete this action" });
  return issue ? presentClientIssue(issue).title : "";
}

export function presentReadFailure(error: unknown, resource: string): string {
  const issue = clientIssue(error, { operation: "read", label: resource });
  if (!issue) return "";
  const { title, detail } = presentClientIssue(issue);
  return detail ? `${title} ${detail}` : title;
}
export function presentDeliveryActions(): {
  readonly edit: string;
  readonly delete: string;
  readonly discard: string;
  readonly retry: string;
} {
  return { edit: "Edit", delete: "Delete", discard: "Don't send", retry: "Send again" };
}

/**
 * Why Edit, Delete or Don't send didn't happen. They touch only this device,
 * so a failure is its storage; a send that began first leaves the message,
 * whose own status says so.
 */
export function presentMessageActionFailure(error: unknown): string | null {
  return classifyClientFailure(error).reason === "message-unconfirmed"
    ? null
    : presentClientIssue({ code: "storage-unavailable" }).title;
}

/** What Edit came to, when the message could not go back to the draft. */
export function presentMessageTakeBack(outcome: "restored" | "occupied" | "sent"): string | null {
  return outcome === "occupied" ? "Couldn't add this to your draft." : null;
}

export const connectedLabel = "Connected";
export function presentConnectionStarting(
  name?: string | null,
  target: "computer" | "team" = "computer",
): string {
  return `Connecting to ${clientDisplayName(name, target)}…`;
}

export function presentConnectionGate(
  state: import("../connections/connection-controller.js").ClientConnectionState,
): ClientIssuePresentation {
  const name = clientDisplayName(state.name, state.target);
  if (!state.showInterruption)
    return {
      title: presentConnectionStarting(state.name, state.target),
      detail: null,
      action: null,
    };
  const issue = state.issue;
  if (!issue)
    return {
      title: presentConnectionStarting(state.name, state.target),
      detail: null,
      action: null,
    };
  const value = { ...issue, ...(state.name ? { name: state.name } : {}), target: state.target };
  if (issue.code === "connection")
    return issue.reason === "offline"
      ? {
          title: "You're offline",
          detail: "Your tasks will show up when you're back online.",
          action: null,
        }
      : {
          title: `Can't reach ${name}`,
          detail:
            state.target === "team"
              ? "Your own tasks still work."
              : "Make sure it's on and connected to the internet.",
          action: "retry",
        };
  if (issue.code === "sign-in")
    return { title: `Sign in to ${name}`, detail: "You were signed out.", action: "sign-in" };
  if (issue.code === "update-app")
    return {
      title: "Update Opensteer",
      detail: `${name} needs a newer version of this app.`,
      action: "update",
    };
  if (issue.code === "update-server")
    return {
      title: `${name} needs an update`,
      detail: "Update Opensteer on it to use it from here.",
      action: null,
    };
  return presentClientIssue(value);
}
export function presentConnectionDetail(
  issue: ClientIssue,
  device: "phone" | "device" = "device",
): ClientIssuePresentation {
  const name = clientDisplayName(issue.name, issue.target);
  switch (issue.code) {
    case "connection":
      return issue.reason === "offline"
        ? {
            title: `This ${device} is offline`,
            detail: "Messages you send will go out when you're back online.",
            action: null,
          }
        : issue.reason === "unreachable"
          ? {
              title: "Can't reach it",
              detail: "Make sure it's on and connected to the internet. Opensteer keeps trying.",
              action: "retry",
            }
          : {
              title: "Reconnecting…",
              detail:
                "Opensteer is reconnecting on its own. Messages you send will go out when it's back.",
              action: null,
            };
    case "sign-in":
      return {
        title: "Signed out",
        detail: `Sign in again to keep using ${name}.`,
        action: "sign-in",
      };
    case "update-app":
      return {
        title: "This app needs an update",
        detail: `${name} runs a newer Opensteer.`,
        action: "update",
      };
    case "update-server":
      return {
        title: "Needs an update",
        detail: `Update Opensteer on ${name} to keep using it from here.`,
        action: null,
      };
    default:
      return presentClientIssue(issue);
  }
}
export const clientIssueActions = {
  retry: "Retry",
  tryNow: "Try now",
  tryAgain: "Try again",
  signIn: "Sign in",
  update: "Update",
  reload: "Reload",
  check: "Check",
} as const;

export function presentSavedViewConnection(issue: ClientIssue | null): string {
  return issue ? `${presentClientIssue(issue).title} · Saved view` : "Updating…";
}

export const clientReadPlaceholderLabel = "Not loaded yet";
