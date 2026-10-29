import {
  conversationTurn,
  type MessageEntry,
  type ThreadActivityIndicator,
  type TranscriptGroup,
} from "@opensteer/client/host";

/**
 * The one line a folded conversation shows under a page: Opensteer typing
 * while a reply is under way, why its work has not started yet, otherwise the
 * start of its latest reply. Null before Opensteer has said anything.
 */
export function latestReplyLine(
  groups: readonly TranscriptGroup[],
  indicator: ThreadActivityIndicator | null,
): { readonly kind: "typing" } | { readonly kind: "text"; readonly text: string } | null {
  if (indicator !== null)
    return indicator.kind === "typing" ? indicator : { kind: "text", text: indicator.label };
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) continue;
    if (group.kind === "message" && group.entry.messageKind === "assistant") {
      const text = oneLine(group.entry);
      if (text !== "") return { kind: "text", text };
      continue;
    }
    if (group.kind !== "turn") continue;
    const view = conversationTurn(group.turn);
    if (view.composing) return { kind: "typing" };
    const reply =
      view.reply ??
      group.turn.work.findLast(
        (entry): entry is MessageEntry =>
          entry.kind === "message" && entry.messageKind === "assistant",
      ) ??
      null;
    const text = reply === null ? "" : oneLine(reply);
    if (text !== "") return { kind: "text", text };
  }
  return null;
}

/** A reply's words as one plain line: the Markdown marks a line cannot draw are dropped. */
function oneLine(message: MessageEntry): string {
  return message.body
    .replaceAll(/[`*_#>|~]+/gu, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\s+/gu, " ")
    .trim();
}
