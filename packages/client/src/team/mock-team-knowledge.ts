import { markdownPreview } from "@opensteer/shared/markdownPreview";
import {
  KnowledgeTopicIdSchema,
  OpensteerError,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
  type UserId,
} from "@opensteer/core";
import {
  hostApi,
  teamKnowledgeLimits,
  type TeamCommandSchema,
  type TeamGroupSchema,
  type TeamMember,
  type TeamNote,
  type TeamNotePreview,
  type TeamTopic,
  type TeamTopicAccessEntry,
} from "@opensteer/protocol";
import type { z } from "zod";

type Command = z.infer<typeof TeamCommandSchema>;
type TeamGroup = z.infer<typeof TeamGroupSchema>;
type KnowledgeCommand = Extract<Command, { type: `team.knowledge.${string}` }>;
export const isMockKnowledgeCommand = (command: Command): command is KnowledgeCommand =>
  command.type.startsWith("team.knowledge.");
interface Topic {
  id: KnowledgeTopicId;
  name: string;
  description: string;
  archivedAt: string | null;
  updatedAt: string;
  createdBy: UserId | null;
  revision: bigint;
  grants: TeamTopicAccessEntry[];
}
interface Note {
  readonly id: KnowledgeNoteId;
  readonly topicId: KnowledgeTopicId;
  /** Oldest first; the last is the note as it is now. */
  readonly versions: TeamNote[];
}

const rank = { read: 1, write: 2, manage: 3 } as const;
const starterTopicId = KnowledgeTopicIdSchema.parse("ktp_00000000-0000-4000-8000-000000000001");

/**
 * The team Host's knowledge, in memory: topics with access lists (people, groups, everyone),
 * notes with numbered versions, and the same refusals the team Host gives. Owners and admins
 * manage every topic but read only what they are granted; an archived topic is read-only.
 */
export class MockTeamKnowledge {
  readonly topics = new Map<KnowledgeTopicId, Topic>();
  readonly notes = new Map<KnowledgeNoteId, Note>();
  /** Notes per page; tests lower it to reach a second page. */
  pageSize: number = teamKnowledgeLimits.pageSize;
  readonly #people: () => readonly TeamMember[];
  readonly #groups: () => ReadonlyMap<string, TeamGroup>;
  readonly #viewer: () => UserId;
  readonly #now: () => string;

  constructor(options: {
    readonly people: () => readonly TeamMember[];
    readonly groups: () => ReadonlyMap<string, TeamGroup>;
    readonly viewer: () => UserId;
    readonly now?: () => string;
  }) {
    this.#people = options.people;
    this.#groups = options.groups;
    this.#viewer = options.viewer;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.addTopic({
      id: starterTopicId,
      name: "General",
      description: "Anything the team should know that has no better home.",
      access: [{ subject: { kind: "everyone" }, level: "write" }],
      createdBy: null,
      at: "2026-09-01T09:00:00.000Z",
    });
  }

  get starterTopicId(): KnowledgeTopicId {
    return starterTopicId;
  }

  /** A topic as the team has it; `createdBy` manages it, as the team Host adds its creator. */
  addTopic(input: {
    readonly id: KnowledgeTopicId;
    readonly name: string;
    readonly description: string;
    readonly access: readonly TeamTopicAccessEntry[];
    readonly createdBy: UserId | null;
    readonly at?: string;
    readonly archivedAt?: string | null;
  }): void {
    const grants = checkedGrants([
      ...input.access,
      ...(input.createdBy
        ? [{ subject: { kind: "person", userId: input.createdBy }, level: "manage" } as const]
        : []),
    ]);
    this.topics.set(input.id, {
      id: input.id,
      name: input.name,
      description: input.description,
      archivedAt: input.archivedAt ?? null,
      updatedAt: input.at ?? this.#now(),
      createdBy: input.createdBy,
      revision: 1n,
      grants,
    });
  }

  /** Appends a version as `writer` wrote it, with no access check: a seed, or another person. */
  addVersion(input: {
    readonly noteId: KnowledgeNoteId;
    readonly topicId: KnowledgeTopicId;
    readonly title: string;
    readonly body: string;
    readonly writer: TeamNote["writer"];
    readonly at?: string;
    readonly deleted?: boolean;
    readonly source?: TeamNote["source"];
  }): TeamNote {
    const held = this.notes.get(input.noteId);
    const note = held ?? { id: input.noteId, topicId: input.topicId, versions: [] };
    const version: TeamNote = {
      id: input.noteId,
      topicId: note.topicId,
      version: note.versions.length + 1,
      title: input.title,
      body: input.body,
      deleted: input.deleted ?? false,
      writtenAt: input.at ?? this.#now(),
      writer: input.writer,
      source: input.source ?? null,
    };
    note.versions.push(version);
    this.notes.set(note.id, note);
    return version;
  }

  can(topicId: KnowledgeTopicId, userId: UserId = this.#viewer()): TeamTopic["can"] {
    const topic = this.topics.get(topicId);
    const member = this.#people().find((row) => row.userId === userId && row.state === "active");
    if (!topic || !member) return { read: false, write: false, manage: false };
    const mine = topic.grants.filter(
      (grant) =>
        grant.subject.kind === "everyone" ||
        (grant.subject.kind === "person" && grant.subject.userId === userId) ||
        (grant.subject.kind === "group" && this.#inGroup(grant.subject.groupId, userId)),
    );
    return {
      read: mine.length > 0,
      write: mine.some((grant) => grant.level !== "read") && topic.archivedAt === null,
      manage: mine.some((grant) => grant.level === "manage") || member.role !== "member",
    };
  }

  #inGroup(groupId: string, userId: UserId, seen = new Set<string>()): boolean {
    const group = this.#groups().get(groupId);
    if (!group || seen.has(groupId)) return false;
    seen.add(groupId);
    return (
      group.people.includes(userId) ||
      group.children.some((child) => this.#inGroup(child, userId, seen))
    );
  }

  #readers(topic: Topic): TeamTopic["audience"] {
    const active = this.#people().filter((row) => row.state === "active");
    if (topic.grants.some((grant) => grant.subject.kind === "everyone"))
      return { everyone: true, people: active.length };
    return {
      everyone: false,
      people: active.filter((member) => this.can(topic.id, member.userId).read).length,
    };
  }

  #view(topic: Topic): TeamTopic | null {
    const can = this.can(topic.id);
    if (!can.read && !can.manage) return null;
    return {
      id: topic.id,
      name: topic.name,
      description: topic.description,
      archivedAt: topic.archivedAt,
      updatedAt: topic.updatedAt,
      noteCount: can.read
        ? [...this.notes.values()].filter(
            (note) => note.topicId === topic.id && !note.versions.at(-1)!.deleted,
          ).length
        : 0,
      audience: this.#readers(topic),
      can,
    };
  }

  #visible(topicId: KnowledgeTopicId): TeamTopic {
    const topic = this.topics.get(topicId);
    const view = topic && this.#view(topic);
    if (!view) throw missingTopic();
    return view;
  }

  #readable(noteId: KnowledgeNoteId): Note {
    const note = this.notes.get(noteId);
    if (!note || !this.can(note.topicId).read) throw missingNote();
    return note;
  }

  read(name: string, input: unknown): unknown {
    switch (name) {
      case "team.knowledge.topics.list": {
        const { after } = hostApi[name].payload.parse(input);
        const sorted = [...this.topics.values()].sort(byName);
        const start = after ? sorted.findIndex((topic) => topic.id === after) + 1 : 0;
        const shown = sorted
          .slice(start)
          .map((topic) => this.#view(topic))
          .filter((topic) => topic !== null);
        return {
          topics: shown.slice(0, teamKnowledgeLimits.pageSize),
          hasMore: shown.length > teamKnowledgeLimits.pageSize,
        };
      }
      case "team.knowledge.topic.get":
        return this.#visible(hostApi[name].payload.parse(input).topicId);
      case "team.knowledge.topic.access.get": {
        const { topicId } = hostApi[name].payload.parse(input);
        const view = this.#visible(topicId);
        const topic = this.topics.get(topicId)!;
        return { revision: String(topic.revision), entries: topic.grants, can: view.can };
      }
      case "team.knowledge.notes.page":
        return this.#page(hostApi[name].payload.parse(input));
      case "team.knowledge.note.get":
        return this.#readable(hostApi[name].payload.parse(input).noteId).versions.at(-1);
      case "team.knowledge.note.history": {
        const { noteId, before } = hostApi[name].payload.parse(input);
        const versions = [...this.#readable(noteId).versions]
          .reverse()
          .filter((version) => before === undefined || version.version < before);
        return {
          versions: versions.slice(0, teamKnowledgeLimits.pageSize),
          hasMore: versions.length > teamKnowledgeLimits.pageSize,
        };
      }
      default:
        throw new Error(`Mock read not implemented: ${name}`);
    }
  }

  #page(input: {
    topicId?: KnowledgeTopicId | undefined;
    query?: string | undefined;
    cursor?: string | undefined;
  }) {
    if (input.topicId && !this.can(input.topicId).read) throw missingTopic();
    const current = [...this.notes.values()]
      .filter(
        (note) =>
          (!input.topicId || note.topicId === input.topicId) &&
          this.can(note.topicId).read &&
          !note.versions.at(-1)!.deleted,
      )
      .map((note) => note.versions.at(-1)!);
    const newest = (a: TeamNote, b: TeamNote) =>
      b.writtenAt.localeCompare(a.writtenAt) || b.id.localeCompare(a.id);
    const size = this.pageSize;
    if (input.query !== undefined) {
      const words = searchWords(input.query);
      const offset = input.cursor ? cursorOffset(input.cursor) : 0;
      const ranked = current
        .map((note) => ({ note, score: matchScore(note, words) }))
        .filter((row) => words.length > 0 && row.score > 0)
        .sort((a, b) => b.score - a.score || newest(a.note, b.note))
        .map((row) => row.note);
      return {
        notes: ranked.slice(offset, offset + size).map(preview),
        nextCursor: ranked.length > offset + size ? `rank:${offset + size}` : null,
      };
    }
    const after = input.cursor ? recentCursor(input.cursor) : null;
    const sorted = current
      .sort(newest)
      .filter(
        (note) =>
          !after ||
          note.writtenAt < after.at ||
          (note.writtenAt === after.at && note.id < after.id),
      );
    const page = sorted.slice(0, size);
    const last = page.at(-1);
    return {
      notes: page.map(preview),
      nextCursor: sorted.length > size && last ? `recent:${last.writtenAt}:${last.id}` : null,
    };
  }

  command(command: KnowledgeCommand, viewer: TeamNote["writer"]): unknown {
    const userId = viewer.userId;
    switch (command.type) {
      case "team.knowledge.topic.create": {
        const held = this.topics.get(command.id);
        if (held) {
          if (held.createdBy === userId) return { type: command.type };
          throw new OpensteerError({
            code: "conflict",
            message: "That topic ID is already in use.",
          });
        }
        this.#knownSubjects(command.access);
        this.addTopic({
          id: command.id,
          name: command.name,
          description: command.description,
          access: command.access,
          createdBy: userId,
        });
        return { type: command.type };
      }
      case "team.knowledge.topic.update": {
        const topic = this.#managed(command.topicId);
        topic.name = command.name;
        topic.description = command.description;
        topic.updatedAt = this.#now();
        return { type: command.type };
      }
      case "team.knowledge.topic.access.set": {
        const topic = this.#managed(command.topicId);
        this.#knownSubjects(command.access);
        if (String(topic.revision) !== command.expectedRevision)
          throw new OpensteerError({
            code: "conflict",
            reason: "knowledge-topic-access-changed",
            message: "This topic's list changed; reload it and try again.",
          });
        topic.grants = checkedGrants(command.access);
        topic.revision += 1n;
        topic.updatedAt = this.#now();
        return { type: command.type };
      }
      case "team.knowledge.topic.archive":
      case "team.knowledge.topic.restore": {
        const topic = this.#managed(command.topicId);
        topic.archivedAt = command.type === "team.knowledge.topic.archive" ? this.#now() : null;
        topic.updatedAt = this.#now();
        return { type: command.type };
      }
      case "team.knowledge.note.write":
      case "team.knowledge.note.delete": {
        const held = this.notes.get(command.noteId);
        const topicId =
          held?.topicId ?? (command.type === "team.knowledge.note.write" ? command.topicId : null);
        if (!held && (command.expectedVersion !== null || !topicId))
          throw new OpensteerError({
            code: "not_found",
            reason: "team-note-not-found",
            message: "That note doesn't exist or you can't read it.",
          });
        this.#authorizeWrite(topicId!);
        const head = held?.versions.at(-1);
        const target =
          command.type === "team.knowledge.note.delete"
            ? { title: head?.title ?? "", body: head?.body ?? "", deleted: true }
            : { title: command.title, body: command.body, deleted: false };
        const done = (version: number) => ({ type: command.type, noteId: command.noteId, version });
        if (!head) {
          const created = this.addVersion({
            noteId: command.noteId,
            topicId: topicId!,
            ...target,
            writer: viewer,
          });
          return done(created.version);
        }
        // A retry of a write this viewer made returns its first outcome, even after later edits.
        const made = (command.expectedVersion ?? 0) + 1;
        const base =
          command.expectedVersion === null ? null : held!.versions[command.expectedVersion - 1];
        const written = held!.versions[made - 1];
        const intended =
          command.type === "team.knowledge.note.delete"
            ? base && { title: base.title, body: base.body, deleted: true }
            : { title: command.title, body: command.body, deleted: false };
        if (
          written &&
          intended &&
          (command.expectedVersion !== null ||
            (command.type === "team.knowledge.note.write" && command.topicId === held!.topicId)) &&
          written.writer.userId === viewer.userId &&
          written.writer.kind === viewer.kind &&
          written.title === intended.title &&
          written.body === intended.body &&
          written.deleted === intended.deleted
        )
          return done(made);
        if (command.expectedVersion === null || head.version !== command.expectedVersion)
          throw new OpensteerError({
            code: "conflict",
            reason: "knowledge-note-changed",
            message: `${head.writer.name} changed this note while you were editing it.`,
          });
        if (head.deleted && target.deleted) return done(head.version);
        return done(
          this.addVersion({
            noteId: command.noteId,
            topicId: held!.topicId,
            ...target,
            writer: viewer,
          }).version,
        );
      }
      default:
        throw new Error("Unknown knowledge command.");
    }
  }

  #managed(topicId: KnowledgeTopicId): Topic {
    const topic = this.topics.get(topicId);
    if (!topic) throw missingTopic();
    const can = this.can(topicId);
    if (can.manage) return topic;
    if (!can.read) throw missingTopic();
    throw new OpensteerError({
      code: "forbidden",
      message: "Only this topic's managers can change it.",
    });
  }

  #authorizeWrite(topicId: KnowledgeTopicId): void {
    const can = this.can(topicId);
    if (!can.read) throw missingTopic();
    if (can.write) return;
    throw new OpensteerError({
      code: "forbidden",
      reason: "knowledge-topic-read-only",
      message: this.topics.get(topicId)?.archivedAt
        ? "That topic is archived, so nothing new can be saved in it."
        : "You can read this topic but not write in it.",
    });
  }

  #knownSubjects(access: readonly TeamTopicAccessEntry[]): void {
    const people = this.#people();
    for (const { subject } of access)
      if (
        (subject.kind === "person" &&
          !people.some((row) => row.userId === subject.userId && row.state === "active")) ||
        (subject.kind === "group" && !this.#groups().has(subject.groupId))
      )
        throw new OpensteerError({
          code: "bad_request",
          reason: "team-topic-unknown-subject",
          message: "Every person and group on a topic's list must be in the team.",
        });
  }
}

/** One entry per subject, the highest level winning, as the team Host keeps a list. */
function checkedGrants(access: readonly TeamTopicAccessEntry[]): TeamTopicAccessEntry[] {
  const bySubject = new Map<string, TeamTopicAccessEntry>();
  for (const entry of access) {
    if (entry.subject.kind === "everyone" && entry.level === "manage")
      throw new OpensteerError({
        code: "bad_request",
        reason: "team-topic-everyone-manage",
        message: "Everyone can read or write a topic; managing it is for people and groups.",
      });
    const key =
      entry.subject.kind === "person"
        ? entry.subject.userId
        : entry.subject.kind === "group"
          ? entry.subject.groupId
          : "everyone";
    const held = bySubject.get(key);
    if (!held || rank[entry.level] > rank[held.level]) bySubject.set(key, entry);
  }
  return [...bySubject.values()];
}

function byName(a: Topic, b: Topic): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
}

function preview(note: TeamNote): TeamNotePreview {
  const { body, deleted: _deleted, ...rest } = note;
  return { ...rest, preview: markdownPreview(body, teamKnowledgeLimits.previewChars) };
}

function searchWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
}

/** Every word must start a word of the note, as the team Host's prefix search does. */
function matchScore(note: TeamNote, words: readonly string[]): number {
  const title = searchWords(note.title);
  const body = searchWords(note.body);
  let score = 0;
  for (const word of words) {
    const inTitle = title.filter((held) => held.startsWith(word)).length;
    const inBody = body.filter((held) => held.startsWith(word)).length;
    if (inTitle + inBody === 0) return 0;
    score += inTitle * 4 + inBody;
  }
  return score;
}

function cursorOffset(cursor: string): number {
  const offset = Number(cursor.replace(/^rank:/u, ""));
  if (!cursor.startsWith("rank:") || !Number.isSafeInteger(offset) || offset < 0)
    throw invalidCursor();
  return offset;
}

function recentCursor(cursor: string): { at: string; id: string } {
  const match = /^recent:(.+):(knt_.+)$/u.exec(cursor);
  if (!match) throw invalidCursor();
  return { at: match[1]!, id: match[2]! };
}

function invalidCursor(): OpensteerError {
  return new OpensteerError({ code: "bad_request", message: "That page cursor isn't valid." });
}

function missingTopic(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    reason: "knowledge-topic-not-found",
    message: "That topic doesn't exist or you can't read it.",
  });
}

function missingNote(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    reason: "knowledge-note-not-found",
    message: "That note doesn't exist or you can't read it.",
  });
}
