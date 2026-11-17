import { presentClientIssue, type ClientIssue } from "@opensteer/client/feedback";

/** One action's outcome, said beside the control that asked for it. */
export interface ActionLineValue {
  /** Changes for each new outcome: it is said and felt once per key. */
  readonly key: string;
  readonly text: string;
  readonly tone: "muted" | "danger";
  readonly link?: {
    readonly label: string;
    readonly accessibilityLabel?: string;
    readonly onPress: () => void;
  } | null;
  readonly haptic?: "warning" | "error" | null;
}

/**
 * An action's outcome as its line: muted and felt as a warning when it never
 * went out or can't be confirmed, danger and felt as an error when refused.
 */
export function issueLine(
  issue: ClientIssue,
  key: string,
  link?: ActionLineValue["link"],
): ActionLineValue {
  const refused = issue.code === "rejected" || issue.code === "storage-unavailable";
  return {
    haptic: refused ? "error" : "warning",
    key,
    link: link ?? null,
    text: presentClientIssue(issue).title,
    tone: refused ? "danger" : "muted",
  };
}
