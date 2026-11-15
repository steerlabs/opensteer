import type { TeamPageTarget } from "@opensteer/core";

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

/**
 * Knowledge: every note, or one topic's (`knowledge/:topicId`), with a note open beside the
 * list (`?note=`) and the search that narrows it (`?q=`).
 */
export function knowledgePath(
  teamId: string,
  topicId: string | null = null,
  noteId: string | null = null,
  query = "",
): string {
  const path = teamPath(teamId, topicId ? `knowledge/${encodeURIComponent(topicId)}` : "knowledge");
  const search = new URLSearchParams({
    ...(query ? { q: query } : {}),
    ...(noteId ? { note: noteId } : {}),
  }).toString();
  return search ? `${path}?${search}` : path;
}

/** A verified team's public page in the existing in-app screens. */
export function teamPagePath(
  teamId: string,
  target: Exclude<TeamPageTarget, { kind: "invite" }>,
): string {
  switch (target.kind) {
    case "channel":
      return channelPath(teamId, target.channelId);
    case "message":
      return channelPath(teamId, target.channelId, { messageId: target.messageId });
    case "thread":
      return channelPath(teamId, target.channelId, {
        threadId: target.threadRootId,
        messageId: target.messageId ?? null,
      });
    case "knowledge-topic":
      return knowledgePath(teamId, target.topicId);
    case "knowledge-note":
      return knowledgePath(teamId, target.topicId, target.noteId);
  }
}
