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
  readonly action?: string;
  readonly done?: string;
  readonly thing?: string;
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
  if (failure.code === "unauthorized") return { code: "sign-in" };
  if (failure.reason === "client-too-old") return { code: "update-app" };
  if (failure.reason === "host-too-old") return { code: "update-server" };
  if (failure.kind === "session") return { code: "access-lost" };
  if (context.operation !== "action")
    return {
      code: context.operation === "read" ? "read-failed" : "refresh-failed",
      resource: context.label,
    };
  return failure.kind === "rejection"
    ? { code: "rejected", reason: failure.reason, action: context.label }
    : { code: "unconfirmed", action: context.label };
}

const rejectionReasons: Readonly<Record<string, string>> = {
  "permission-denied": "You don't have access.",
  "access-denied": "You don't have access.",
  not_found: "It may have been deleted, or you don't have access.",
  "thread-not-found": "This task is no longer available.",
  "thread-closed": "This task is closed.",
  "browser-session-closed": "This tab is closed.",
  "resource-exhausted": "Too many messages waiting.",
};

export function clientDisplayName(
  name: string | null | undefined,
  target: "computer" | "team" = "computer",
): string {
  const safe = name?.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
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
      return result(`Couldn't load ${issue.resource ?? "this"}.`, "retry");
    case "refresh-failed":
      return result(`Couldn't refresh ${issue.resource ?? "this"}.`, "retry");
    case "not-sent":
      return result(
        `Not ${issue.done ?? "changed"}. ${issue.reason === "offline" ? "You're offline." : `Can't reach ${name}.`}`,
      );
    case "unconfirmed":
      return result(
        issue.thing && issue.done
          ? `Couldn't confirm ${issue.thing} ${issue.done}.`
          : "Couldn't confirm this change.",
        "check",
      );
    case "rejected": {
      const reason = rejectionReasons[issue.reason ?? ""];
      return result(
        reason
          ? `Not ${issue.done ?? "changed"}. ${reason}`
          : `Couldn't ${issue.action ?? "change this"}${issue.thing ? ` ${issue.thing}` : ""}.`,
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
  if (phase === "sending") return "Sending…";
  if (phase === "waiting") return "Waiting to send";
  return `Not sent. ${rejectionReasons[issue?.reason ?? ""] ?? `${clientDisplayName(issue?.name)} didn't accept it.`}`;
}
