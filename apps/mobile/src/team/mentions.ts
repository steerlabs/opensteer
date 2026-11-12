import type { MentionView } from "./team-models.js";

/**
 * Finding structured mentions in a message's Markdown by their plain handles
 * (`@maya`, `@maya-agent`), so each can be drawn in the reader's own words.
 */
export interface MentionFinder {
  readonly byHandle: ReadonlyMap<string, MentionView>;
  /** Tests a whole block; not global, so `test` holds no position between calls. */
  readonly pattern: RegExp;
  readonly source: string;
}

export function mentionFinder(mentions: readonly MentionView[]): MentionFinder | null {
  if (mentions.length === 0) return null;
  const byHandle = new Map(mentions.map((mention) => [mention.handle.toLowerCase(), mention]));
  // Longest first, so `@maya-agent` is never read as `@maya` and a stray "-agent".
  const handles = [...byHandle.keys()]
    .sort((left, right) => right.length - left.length)
    .map((handle) => handle.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
  const source = `(^|[^\\w@])@(${handles.join("|")})(?![\\w-])`;
  return { byHandle, pattern: new RegExp(source, "i"), source };
}

/** A text node cut into plain runs and the mentions between them. */
export function mentionRuns(
  text: string,
  finder: MentionFinder,
): readonly (string | MentionView)[] {
  const runs: (string | MentionView)[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(finder.source, "gi"))) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const mention = finder.byHandle.get((match[2] ?? "").toLowerCase());
    if (mention === undefined) continue;
    if (start > last) runs.push(text.slice(last, start));
    runs.push(mention);
    last = start + 1 + (match[2]?.length ?? 0);
  }
  if (last < text.length) runs.push(text.slice(last));
  return runs;
}
