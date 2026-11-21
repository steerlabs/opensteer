import {
  classifyClientFailure,
  isMissingClientResource,
  type ClientFailure,
} from "../connections/operation-error.js";

export type ClientIssueCode =
  | "connection"
  | "sign-in"
  | "update-app"
  | "update-server"
  | "web-outdated"
  | "access-lost"
  | "open-failed"
  | "read-failed"
  | "refresh-failed"
  | "not-sent"
  | "unconfirmed"
  | "message-removed-locally"
  | "rejected"
  | "login-storage-unavailable"
  | "draft-changed"
  | "draft-previous-login"
  | "draft-unsaved"
  | "draft-limit"
  | "dictation-recovered"
  | "storage-unavailable"
  | "queue-full"
  | "preparation-required";

export interface ClientIssue {
  readonly code: ClientIssueCode;
  readonly reason?: string;
  readonly name?: string;
  readonly target?: "computer";
  readonly route?: "same-computer" | "private-network" | "connect";
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

interface ClientIssueContext {
  readonly operation: "read" | "refresh" | "action";
  readonly label: string;
}

export function clientIssue(error: unknown, context: ClientIssueContext): ClientIssue | null {
  return clientIssueFromFailure(classifyClientFailure(error), context);
}

export function clientIssueFromFailure(
  failure: ClientFailure,
  context: ClientIssueContext,
): ClientIssue | null {
  if (failure.kind === "cancelled") return null;
  if (failure.reason === "login-storage-unavailable") return { code: "login-storage-unavailable" };
  if (failure.reason === "storage-unavailable") return { code: "storage-unavailable" };
  if (failure.reason === "session-changed") return { code: "sign-in" };
  if (failure.reason === "draft-changed" || failure.reason === "draft-superseded")
    return { code: "draft-changed" };
  if (failure.reason === "draft-previous-login") return { code: "draft-previous-login" };
  if (failure.reason === "draft-files-full" || failure.reason === "draft-text-full")
    return { code: "draft-limit", reason: failure.reason };
  if (failure.reason === "queue-full") return { code: "queue-full" };
  if (failure.code === "unauthorized") return { code: "sign-in" };
  if (["client-too-old", "api-version-mismatch", "unsupported-version"].includes(failure.reason))
    return { code: "update-app" };
  if (failure.reason === "host-too-old") return { code: "update-server" };
  if (failure.kind === "session") return { code: "access-lost" };
  if (context.operation !== "action" && isMissingClientResource(failure))
    return { code: "access-lost", reason: failure.reason };
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
  "request-changed": "This request changed. Review it before answering.",
  "request-review-required": "Review the latest request before answering.",
  forbidden: "You don't have access.",
  "permission-denied": "You don't have access.",
  "access-denied": "You don't have access.",
  not_found: "It may have been deleted, or you don't have access.",
  "thread-not-found": "This task is no longer available.",
  "thread-closed": "This task is closed.",
  "draft-unverified": "The draft may have changed or been discarded. Edit to recover your message.",
  "browser-session-closed": "This tab is closed.",
  "browser-capture-limit": "Too many pages are being watched.",
  "browser-input-owner-conflict": "Someone else is using this page.",
  "personal-remote-access-off": "Turn on Use from anywhere to add a computer.",
  "device-offline": "Open Opensteer on the device and keep it open, then try again.",
  "device-asleep": "This device is asleep. Wait until it wakes, then try again.",
  "computer-app-connecting": "Opensteer on the device is still connecting. Try again in a moment.",
  "computer-app-not-offered":
    "This device doesn't offer the app. Check for an Opensteer update on the device.",
  "computer-app-approval-changed":
    "This request changed or is no longer waiting. Review the current access.",
  "computer-app-definition-changed":
    "The app or its available access changed. Review it and request access again.",
  "computer-app-installation-invalid":
    "The Host couldn't read this app's installation. Check for an Opensteer update on the Host.",
  "resource-exhausted": "Too many messages waiting.",
  "plugin-key-invalid": "Check this key and its fields.",
  "plugin-consent-changed": "What this plugin asks for changed. Review it again.",
  "plugin-webhooks-active": "Remove this plugin's webhook subscriptions first.",
  "plugin-workflows-active": "Stop this plugin's workflow runs first.",
};

/** A read the Host answered, saying a source beyond it can't be reached now. */
const unreachableSources: Readonly<Record<string, string>> = {
  "plugin-catalog-unavailable": "The plugin catalog can't be reached right now.",
};
const unreachableSource = (reason: string | undefined) =>
  reason && Object.hasOwn(unreachableSources, reason) ? unreachableSources[reason] : undefined;

function rejectionDetail(reason: string | undefined): string | undefined {
  return reason && Object.hasOwn(rejectionReasons, reason) ? rejectionReasons[reason] : undefined;
}

/** How a sentence names what it is about. */
const clientTargets = {
  computer: { fallback: "your computer", longestName: 18 },
} as const;

/**
 * The name a sentence says, or "your computer" when there is no
 * safe one. `sentenceStart` capitalizes only that fallback: a real name like
 * "iMac" is said as written.
 */
export function clientDisplayName(
  name: string | null | undefined,
  target: "computer" = "computer",
  sentenceStart = false,
): string {
  const safe = name
    ? Array.from(name)
        .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join("")
        .trim()
    : undefined;
  const words = clientTargets[target];
  if (safe && safe.length <= words.longestName) return safe;
  const fallback = words.fallback;
  return sentenceStart ? `Y${fallback.slice(1)}` : fallback;
}

export function presentClientIssue(issue: ClientIssue): ClientIssuePresentation {
  const name = clientDisplayName(issue.name, issue.target);
  const subject = clientDisplayName(issue.name, issue.target, true);
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
          ? result(
              issue.route === "same-computer"
                ? "Opensteer isn't responding"
                : `Can't reach ${name}`,
              "retry",
            )
          : result("Reconnecting…");
    case "sign-in":
      return result("Signed out", "sign-in");
    case "update-app":
      return result("Update Opensteer", "update");
    case "update-server":
      return result(`${subject} needs an update`);
    case "web-outdated":
      return result("Opensteer was updated", "reload");
    case "access-lost":
      return result(
        "This isn't available",
        null,
        "It may have been deleted, or you don't have access.",
      );
    case "open-failed":
      return result(`Couldn't open ${issue.resource ?? name}`, "retry", "Try again in a moment.");
    case "read-failed":
      return result(
        unreachableSource(issue.reason) ?? `Couldn't load ${issue.resource ?? "this"}.`,
        "retry",
        issue.reason === "not_found" ? (rejectionDetail(issue.reason) ?? null) : null,
      );
    case "refresh-failed":
      return result(
        unreachableSource(issue.reason) ?? `Couldn't refresh ${issue.resource ?? "this"}.`,
        "retry",
      );
    case "not-sent":
      // No reason: a check after a lost answer found it was not done, so it can be tried again.
      return issue.reason === undefined
        ? result(`Not ${issue.done ?? "changed"}.`, "retry")
        : result(
            `Not ${issue.done ?? "changed"}. ${issue.reason === "offline" ? "You're offline." : `Can't reach ${name}.`}`,
          );
    case "message-removed-locally":
      return result(`Removed here. If it already reached ${name}, it may still appear.`);
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
    case "login-storage-unavailable":
      return result("Couldn't access sign-in storage on this device.");
    case "draft-changed":
      return {
        title: "This draft changed while the task was starting.",
        detail: null,
        action: null,
      };
    case "draft-unsaved":
      return result(
        "Couldn't save this draft on this device.",
        null,
        "It stays here until you close Opensteer.",
      );
    case "draft-limit":
      return result(
        issue.reason === "draft-files-full"
          ? "Too many files to combine these drafts. Your edit is still here."
          : "Too much text to combine these drafts. Your edit is still here.",
      );
    case "dictation-recovered":
      return result(
        issue.reason === "unsaved"
          ? "Couldn’t save the dictated text. Copy it before closing Opensteer."
          : "Dictated text was saved separately.",
      );
    case "draft-previous-login":
      return result(
        "This reply belongs to a previous sign-in. Edit the draft to send a new reply.",
      );
    case "storage-unavailable":
      return result("Couldn't save this message on this device. Try again.", "retry");
    case "queue-full":
      return result("Too many messages waiting.");
    case "preparation-required":
      return result("Waiting to upload", null, "Sends once your files upload.");
  }
}

/** `computer` is the verified name of the computer the message went to, when the issue has none. */
export function presentMessageDelivery(
  phase: "waiting" | "sending" | "rejected",
  issue?: ClientIssue,
  computer?: string | null,
): string {
  if (issue?.code === "unconfirmed")
    return presentClientIssue({ happened: "this message was sent", ...issue }).title;
  if (phase === "sending") return "Sending…";
  if (phase === "waiting") return "Waiting to send";
  return `Not sent. ${presentMessageRejection(
    issue && !issue.name && computer ? { ...issue, name: computer } : issue,
  )}`;
}

export function presentMessageRejection(issue?: ClientIssue): string {
  return (
    rejectionDetail(issue?.reason) ??
    `${clientDisplayName(issue?.name, issue?.target, true)} didn't accept it.`
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
  return detail ? `${title}${title.endsWith(".") ? "" : "."} ${detail}` : title;
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
    ? "This message is already on its way."
    : "Couldn't change this message on this device. Try again.";
}

/** What Edit came to, when the message could not go back to the draft. */
export function presentMessageTakeBack(outcome: "restored" | "occupied" | "sent"): string | null {
  if (outcome === "occupied") return "Couldn't add this to your draft.";
  if (outcome === "sent") return "This message is already on its way.";
  return null;
}

export const connectedLabel = "Connected";
export function presentConnectionStarting(
  name?: string | null,
  target: "computer" = "computer",
): string {
  return `Connecting to ${clientDisplayName(name, target)}…`;
}

export function presentConnectionGate(
  state: import("../connections/connection-controller.js").ClientConnectionState,
): ClientIssuePresentation {
  const name = clientDisplayName(state.name, state.target);
  const subject = clientDisplayName(state.name, state.target, true);
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
  const route = state.route ?? issue.route ?? null;
  const sameComputer = route === "same-computer";
  const value = {
    ...issue,
    ...(state.name ? { name: state.name } : {}),
    ...(route ? { route } : {}),
    target: state.target,
  };
  if (issue.code === "connection") {
    if (issue.reason === "offline")
      return {
        title: "You're offline",
        detail: "Your tasks will show up when you're back online.",
        action: null,
      };
    if (issue.reason === "unreachable")
      return sameComputer
        ? {
            title: "Opensteer isn't responding",
            detail: "Opensteer on this computer isn't responding right now.",
            action: "retry",
          }
        : {
            title: `Can't reach ${name}`,
            detail: "Make sure it's on and connected to the internet.",
            action: "retry",
          };
    if (state.phase === "connecting")
      return {
        title: presentConnectionStarting(state.name, state.target),
        detail: sameComputer
          ? "Opensteer on this computer is taking longer than usual to respond."
          : "This is taking longer than usual.",
        action: null,
      };
    return {
      title: "Reconnecting…",
      detail: sameComputer
        ? "Opensteer on this computer is reconnecting on its own."
        : "Opensteer is reconnecting on its own.",
      action: null,
    };
  }
  if (issue.code === "sign-in")
    return issue.reason === "account-required"
      ? {
          title: "Sign in to your Opensteer account",
          detail: `Use the Account linked to ${name}.`,
          action: "sign-in",
        }
      : { title: `Sign in to ${name}`, detail: "You were signed out.", action: "sign-in" };
  if (issue.code === "update-app")
    return {
      title: "Update Opensteer",
      detail: `${subject} needs a newer version of this app.`,
      action: "update",
    };
  if (issue.code === "update-server")
    return {
      title: `${subject} needs an update`,
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
  const subject = clientDisplayName(issue.name, issue.target, true);
  switch (issue.code) {
    case "connection":
      return issue.reason === "offline"
        ? {
            title: `This ${device} is offline`,
            detail: "Messages you send will go out when you're back online.",
            action: null,
          }
        : issue.reason === "unreachable"
          ? issue.route === "same-computer"
            ? {
                title: "Opensteer isn't responding",
                detail:
                  "Opensteer on this computer isn't responding right now. Opensteer keeps trying.",
                action: "retry",
              }
            : {
                title: "Can't reach it",
                detail: "Make sure it's on and connected to the internet. Opensteer keeps trying.",
                action: "retry",
              }
          : {
              title: "Reconnecting…",
              detail:
                issue.route === "same-computer"
                  ? "Opensteer on this computer is reconnecting on its own."
                  : "Opensteer is reconnecting on its own. Messages you send will go out when it's back.",
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
        detail: `${subject} runs a newer Opensteer.`,
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

/**
 * A saved view's own fact: when it was captured. The connection's words are
 * the pill's alone, so this never repeats them.
 */
export function presentSavedView(capturedAt: string, now = new Date()): string {
  const then = new Date(capturedAt);
  if (Number.isNaN(then.getTime())) return "Saved view";
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  const when =
    days <= 0
      ? then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : days === 1
        ? "yesterday"
        : days < 7
          ? then.toLocaleDateString(undefined, { weekday: "long" })
          : then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `Saved view · Last updated ${when}`;
}

export const clientReadPlaceholderLabel = "Not loaded yet";
