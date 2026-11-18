import type { ClientIssue } from "../feedback/client-issue.js";
import type { ClientConnectionState } from "./connection-controller.js";

export function connectionNotice(state: ClientConnectionState): ClientIssue | null {
  if (!state.showInterruption || state.phase === "idle" || state.phase === "ready") return null;
  const issue = state.issue;
  return issue && { ...issue, ...(state.name ? { name: state.name } : {}), target: state.target };
}
export function showsClientLive(state: ClientConnectionState): boolean {
  return state.phase !== "idle" && state.phase !== "blocked" && !state.showInterruption;
}
