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
    readonly tab?: "files" | "pinned" | "knowledge" | null;
  } = {},
): string {
  const base = teamPath(teamId, `c/${encodeURIComponent(channelId)}`);
  if (options.threadId)
    return `${base}/t/${encodeURIComponent(options.threadId)}${options.messageId ? `/m/${encodeURIComponent(options.messageId)}` : ""}`;
  if (options.messageId) return `${base}/m/${encodeURIComponent(options.messageId)}`;
  return options.tab ? `${base}/${options.tab}` : base;
}
