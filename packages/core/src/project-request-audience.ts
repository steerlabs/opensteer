import type { HumanRoot } from "./work-authority.js";

export type ProjectRequestAudience =
  | { state: "ready"; requiredActor: "requester" | "workspace-owner" }
  | { state: "refused"; reason: "no-eligible-manager" | "unsupported-request-kind" };

export function projectRequestAudience(input: {
  origin: HumanRoot | null;
  requestClass: "question" | "harness-approval" | "unsupported";
  eligibleManagerCount: number;
}): ProjectRequestAudience {
  if (input.requestClass === "unsupported")
    return { state: "refused", reason: "unsupported-request-kind" };
  if (input.origin) return { state: "ready", requiredActor: "requester" };
  if (input.eligibleManagerCount < 1) return { state: "refused", reason: "no-eligible-manager" };
  return { state: "ready", requiredActor: "workspace-owner" };
}
