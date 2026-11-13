/** A team's place in this app (D3 §A3). */
export function teamPath(teamId: string, rest: string): string {
  return `/teams/${encodeURIComponent(teamId)}/${rest}`;
}

export function channelPath(
  teamId: string,
  channelId: string,
  options: {
    readonly threadId?: string | null;
    readonly messageId?: string | null;
    readonly tab?: "files" | "pinned" | null;
  } = {},
): string {
  const base = teamPath(teamId, `c/${encodeURIComponent(channelId)}`);
  if (options.threadId)
    return `${base}/t/${encodeURIComponent(options.threadId)}${options.messageId ? `/m/${encodeURIComponent(options.messageId)}` : ""}`;
  if (options.messageId) return `${base}/m/${encodeURIComponent(options.messageId)}`;
  return options.tab ? `${base}/${options.tab}` : base;
}

/** Knowledge, a topic in it, or a note: `knowledge/:topicId/:noteId/(edit|history)`. */
export function knowledgePath(teamId: string, ...parts: readonly string[]): string {
  return teamPath(teamId, ["knowledge", ...parts.map(encodeURIComponent)].join("/"));
}
