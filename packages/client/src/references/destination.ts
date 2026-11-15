import type { TeamPageLink, TeamPageTarget } from "@opensteer/core";
import type { AvailableReference } from "@opensteer/protocol";
import type { ReferenceDestination } from "./contracts.js";

export function refTarget(value: AvailableReference): ReferenceDestination {
  switch (value.kind) {
    case "task":
      return { kind: value.kind, threadId: value.id };
    case "run":
      return {
        kind: value.kind,
        threadId: value.threadId,
        runId: value.id,
        anchorMessageId: value.anchorMessageId,
      };
    case "message":
      return {
        kind: value.kind,
        threadId: value.threadId,
        messageId: value.id,
        location: value.location,
      };
    case "request":
      return {
        kind: value.kind,
        threadId: value.threadId,
        requestId: value.id,
        status: value.requestStatus,
      };
    case "automation":
      return { kind: value.kind, triggerId: value.id };
    case "computer":
      return { kind: value.kind, runnerId: value.id };
    case "attachment":
      return { kind: value.kind, attachmentId: value.id };
    case "tab":
      return { kind: value.kind, tabId: value.id };
  }
}

export type TeamPageDestination = Exclude<TeamPageTarget, { kind: "invite" }>;
export function teamPageTarget(page: TeamPageLink): TeamPageDestination | null {
  switch (page.target.kind) {
    case "invite":
      return null;
    case "channel":
    case "message":
    case "thread":
    case "knowledge-topic":
    case "knowledge-note":
      return page.target;
  }
}
