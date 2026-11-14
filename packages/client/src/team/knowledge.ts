import type { TeamChannelKind } from "@opensteer/core";
import type {
  TeamNote,
  TeamNoteWriter,
  TeamTopicAccessEntry,
  TeamTopicAudience,
  TeamTopicLevel,
  TeamTopicSubject,
} from "@opensteer/protocol";

/** Who can read a topic, in a few words: "Everyone", "4 people". */
export function topicAudienceLabel(audience: TeamTopicAudience): string {
  if (audience.everyone) return "Everyone";
  if (audience.people === 0) return "No one";
  return audience.people === 1 ? "1 person" : `${audience.people} people`;
}

/** A note's writer in this viewer's words: "You", "Maya Chen", "Your agent", "Maya's agent". */
export function noteWriterName(writer: TeamNoteWriter, viewerUserId: string): string {
  const you = writer.userId === viewerUserId;
  if (writer.kind === "human") return you ? "You" : writer.name;
  return you ? "Your agent" : `${writer.name.split(/\s+/u)[0] || writer.name}'s agent`;
}

/** Who made a version and how: "Saved by you", "Edited by Maya Chen", "Deleted by your agent". */
export function noteByline(
  version: Pick<TeamNote, "version" | "deleted" | "writer">,
  viewerUserId: string,
): string {
  const verb = version.deleted ? "Deleted by" : version.version === 1 ? "Saved by" : "Edited by";
  const name = noteWriterName(version.writer, viewerUserId);
  return `${verb} ${version.writer.userId === viewerUserId ? name.toLowerCase() : name}`;
}

/**
 * Writes `from` (an older version, or the deleted note itself) again as the newest version.
 * People don't author notes, agents do; restoring is the one write people make. A `current`
 * that is no longer the newest is refused with {@link isNoteChangedConflict}.
 */
export function noteRestoreCommand(
  current: Pick<TeamNote, "id" | "topicId" | "version">,
  from: Pick<TeamNote, "title" | "body">,
) {
  return {
    type: "team.knowledge.note.write",
    noteId: current.id,
    topicId: current.topicId,
    expectedVersion: current.version,
    title: from.title,
    body: from.body,
  } as const;
}

export function noteDeleteCommand(current: Pick<TeamNote, "id" | "version">) {
  return {
    type: "team.knowledge.note.delete",
    noteId: current.id,
    expectedVersion: current.version,
  } as const;
}

/** Where an agent was asked to save a note: "#support", "a direct message". */
export function noteSourceWords(
  channel: { readonly kind: TeamChannelKind; readonly name: string } | undefined,
): string {
  if (!channel) return "a team message";
  return channel.kind === "dm" || channel.kind === "group_dm"
    ? "a direct message"
    : `#${channel.name}`;
}

/** Someone else wrote the note after the version this write was based on. */
export function isNoteChangedConflict(error: unknown): boolean {
  return refusal(error, "conflict") && reasonOf(error) === "knowledge-note-changed";
}

/** A topic's list moved on since it was read; read it again before changing it. */
export function isTopicAccessConflict(error: unknown): boolean {
  return refusal(error, "conflict") && reasonOf(error) === "knowledge-topic-access-changed";
}

function refusal(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function reasonOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "reason" in error
    ? error.reason
    : undefined;
}

/* ---- A topic's access list, as an editor changes it ---- */

export type TopicEveryoneLevel = "none" | "read" | "write";
type Entry = Pick<TeamTopicAccessEntry, "subject" | "level">;

export function topicSubjectKey(subject: TeamTopicSubject): string {
  return subject.kind === "person"
    ? `person:${subject.userId}`
    : subject.kind === "group"
      ? `group:${subject.groupId}`
      : "everyone";
}

/** How everyone in the team may use the topic, as the list says. */
export function topicEveryoneLevel(entries: readonly Entry[]): TopicEveryoneLevel {
  const entry = entries.find((row) => row.subject.kind === "everyone");
  return entry?.level === "write" ? "write" : entry ? "read" : "none";
}

export function withTopicEveryone(
  entries: readonly Entry[],
  level: TopicEveryoneLevel,
): TeamTopicAccessEntry[] {
  const rest = entries.filter((row) => row.subject.kind !== "everyone");
  return level === "none" ? rest : [{ subject: { kind: "everyone" }, level }, ...rest];
}

/** Sets one person's or group's level, adding them when they aren't on the list yet. */
export function withTopicSubject(
  entries: readonly Entry[],
  subject: Exclude<TeamTopicSubject, { kind: "everyone" }>,
  level: TeamTopicLevel,
): TeamTopicAccessEntry[] {
  const key = topicSubjectKey(subject);
  return entries.some((row) => topicSubjectKey(row.subject) === key)
    ? entries.map((row) => (topicSubjectKey(row.subject) === key ? { ...row, level } : row))
    : [...entries, { subject, level }];
}

export function withoutTopicSubject(
  entries: readonly Entry[],
  subject: TeamTopicSubject,
): TeamTopicAccessEntry[] {
  const key = topicSubjectKey(subject);
  return entries.filter((row) => topicSubjectKey(row.subject) !== key);
}

/** The same people at the same levels, in any order. */
export function sameTopicAccess(left: readonly Entry[], right: readonly Entry[]): boolean {
  const levels = (entries: readonly Entry[]) =>
    new Map(entries.map((row) => [topicSubjectKey(row.subject), row.level]));
  const a = levels(left);
  const b = levels(right);
  return a.size === b.size && [...a].every(([key, level]) => b.get(key) === level);
}
