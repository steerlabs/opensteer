import { useCallback, useEffect, useRef, useState } from "react";
import {
  KnowledgeTopicIdSchema,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
} from "@opensteer/core";
import {
  TeamNoteVersionSchema,
  type TeamNote,
  type TeamNotePreview,
  type TeamTopic,
} from "@opensteer/protocol";
import {
  teamReferenceCandidates,
  type ComposerLinkCandidate,
} from "../host/composer-references.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { isNoteChangedConflict, noteDeleteCommand, noteRestoreCommand } from "../team/knowledge.js";
import type { TeamSessionClient } from "../team/team-session-client.js";
import { usePagedList } from "./use-paged-list.js";

const sessionIds = new WeakMap<TeamSessionClient, number>();
let lastSessionId = 0;
/** One name per team session, so nothing read for one account is ever shown for another. */
function sessionKey(session: TeamSessionClient | null): string {
  if (!session) return "none";
  let id = sessionIds.get(session);
  if (id === undefined) sessionIds.set(session, (id = ++lastSessionId));
  return String(id);
}

/**
 * Every topic the reader can see, sorted by name, read page after page. A reload keeps the
 * topics on screen until the new answer arrives.
 */
export function useKnowledgeTopics(session: TeamSessionClient | null) {
  const list = usePagedList(
    session
      ? (cursor) =>
          session.rpc["team.knowledge.topics.list"](
            cursor === null ? {} : { after: KnowledgeTopicIdSchema.parse(cursor) },
          )
            .then(unwrapRpcResult)
            .then((page) => ({
              items: page.topics,
              nextCursor: page.hasMore ? (page.topics.at(-1)?.id ?? null) : null,
            }))
      : null,
    `knowledge-topics:${sessionKey(session)}`,
    session,
  );
  const { error, loadingMore, more, nextCursor } = list;
  // `more` is new every render; the cursor names the page it reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (nextCursor !== null && !loadingMore && error === null) more();
  }, [nextCursor, loadingMore, error]);
  const topics: readonly TeamTopic[] | null = list.first === null ? null : list.items;
  return { topics, error: list.error, reload: list.reload };
}

/** `text` once it has stopped changing for `delay` ms, so typing asks the team once. */
export function useSettledText(text: string, delay = 250): string {
  const words = text.trim();
  const [settled, setSettled] = useState(words);
  useEffect(() => {
    if (words === settled) return;
    const timer = setTimeout(() => setSettled(words), words === "" ? 0 : delay);
    return () => clearTimeout(timer);
  }, [words, settled, delay]);
  return settled;
}

/**
 * Notes newest-changed first, or best matches for `query`, in one topic or every readable
 * one. Rows are titles and who saved them, never bodies. A new topic or search keeps the
 * last rows on screen, marked `stale`, until its first page arrives, so nothing flickers;
 * rows never outlive the session they were read in.
 */
export function useKnowledgeNotes(
  session: TeamSessionClient | null,
  input: { readonly topicId: KnowledgeTopicId | null; readonly query: string },
) {
  const { topicId, query } = input;
  const scope = sessionKey(session);
  const key = `knowledge-notes:${scope}:${topicId ?? "*"}:${query}`;
  const list = usePagedList(
    session
      ? (cursor) =>
          session.rpc["team.knowledge.notes.page"]({
            ...(topicId === null ? {} : { topicId }),
            ...(query === "" ? {} : { query }),
            ...(cursor === null ? {} : { cursor }),
          })
            .then(unwrapRpcResult)
            .then((page) => ({ items: page.notes, nextCursor: page.nextCursor }))
      : null,
    key,
    session,
  );
  const settled = useRef<{
    readonly scope: string;
    readonly key: string;
    readonly notes: readonly TeamNotePreview[];
  } | null>(null);
  if (list.first !== null && (settled.current?.key !== key || settled.current.notes !== list.items))
    settled.current = { scope, key, notes: list.items };
  const held = settled.current?.scope === scope ? settled.current : null;
  return {
    /** Null only before anything has ever loaded. */
    notes: held?.notes ?? null,
    /** The rows shown answer an earlier topic or search; the new answer is on its way. */
    stale: held !== null && held.key !== key,
    /** The search the shown rows answer. */
    answered: held?.key === key ? query : null,
    error: list.error,
    hasMore: held?.key === key && list.nextCursor !== null,
    loadingMore: list.loadingMore,
    more: list.more,
    reload: list.reload,
  };
}

/**
 * Team pages an `@` list offers for `query`, null while the list is closed: the channels
 * the reader holds, and knowledge read through the team's own authorized lists only while
 * the list is open. Notes are searched once typing settles.
 */
export function useTeamReferenceCandidates(
  session: TeamSessionClient | null,
  team: Omit<Parameters<typeof teamReferenceCandidates>[0], "topics" | "notes"> | null,
  query: string | null,
): readonly ComposerLinkCandidate[] {
  const open = query !== null && team !== null ? session : null;
  const settled = useSettledText(query ?? "");
  const { topics } = useKnowledgeTopics(open);
  const notes = useKnowledgeNotes(open, { topicId: null, query: settled });
  if (open === null || team === null || query === null) return [];
  return teamReferenceCandidates(
    {
      ...team,
      topics: topics ?? [],
      notes: notes.answered === settled ? (notes.notes ?? []) : [],
    },
    query,
  );
}

interface NoteHistory {
  /** The session and note these versions were read for. */
  readonly key: string;
  readonly versions: readonly TeamNote[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: unknown;
}

/**
 * One note, and its topic when `topicId` is given (a caller holding the topic list passes
 * null), read together. Its versions are read only when asked for: most opens never need
 * them, and a busy note's history is every body it ever had. Restoring writes an old version
 * again as the newest; a stale view is refused and read again. A refusal (the note is gone,
 * or the reader lost its topic) drops everything read, so nothing outlives the access it
 * was read under.
 */
export function useKnowledgeNote(
  session: TeamSessionClient | null,
  noteId: KnowledgeNoteId,
  topicId: KnowledgeTopicId | null,
) {
  const [read, setRead] = useState<{
    readonly key: string;
    readonly note: TeamNote;
    readonly topic: TeamTopic | null;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const [history, setHistory] = useState<NoteHistory | null>(null);
  const [busy, setBusy] = useState<"restore" | "delete" | null>(null);
  const key = `${sessionKey(session)}:${noteId}:${topicId ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const noteLoad = useRef(0);
  const historyLoad = useRef(0);
  /** Versions were asked for, so a reload reads them again too. */
  const historyOpen = useRef(false);

  /** The team refused a read: drop all that was read for this note, and every read on its way. */
  const drop = useCallback((failure: unknown) => {
    noteLoad.current++;
    historyLoad.current++;
    historyOpen.current = false;
    setError(failure);
    setRead(null);
    setHistory(null);
  }, []);

  useEffect(() => {
    if (!session) return;
    const load = ++noteLoad.current;
    const live = () => load === noteLoad.current;
    setError(null);
    void Promise.all([
      session.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult),
      topicId === null
        ? null
        : session.rpc["team.knowledge.topic.get"]({ topicId }).then(unwrapRpcResult),
    ]).then(
      ([note, topic]) => live() && setRead({ key, note, topic }),
      (failure: unknown) => {
        if (!live()) return;
        if (refused(failure)) drop(failure);
        else setError(failure);
      },
    );
    return () => {
      noteLoad.current++;
    };
  }, [session, key, noteId, topicId, generation, drop]);

  useEffect(() => {
    historyLoad.current++;
    historyOpen.current = false;
    setHistory(null);
  }, [key]);

  const loadHistory = useCallback(
    (after: readonly TeamNote[] = []) => {
      if (!session) return;
      historyOpen.current = true;
      const load = ++historyLoad.current;
      const before = after.at(-1)?.version;
      const at = keyRef.current;
      setHistory((now) => ({
        key: at,
        versions: after,
        hasMore: now?.key === at && now.hasMore,
        loading: true,
        error: null,
      }));
      void session.rpc["team.knowledge.note.history"]({
        noteId,
        ...(before === undefined ? {} : { before: TeamNoteVersionSchema.parse(before) }),
      })
        .then(unwrapRpcResult)
        .then(
          (page) =>
            load === historyLoad.current &&
            setHistory({
              key: at,
              versions: [...after, ...page.versions],
              hasMore: page.hasMore,
              loading: false,
              error: null,
            }),
          (failure: unknown) => {
            if (load !== historyLoad.current) return;
            if (refused(failure)) drop(failure);
            else
              setHistory({
                key: at,
                versions: after,
                hasMore: true,
                loading: false,
                error: failure,
              });
          },
        );
    },
    [session, noteId, drop],
  );

  const current = read?.key === key ? read : null;
  const versions = history?.key === key ? history : null;
  const reload = useCallback(() => {
    setGeneration((next) => next + 1);
    if (historyOpen.current) loadHistory();
  }, [loadHistory]);

  /** Runs a write against the version on screen; a stale one reads the note again. */
  const write = async (
    kind: "restore" | "delete",
    command: Parameters<TeamSessionClient["rpc"]["commands.dispatch"]>[0],
  ): Promise<void> => {
    if (!session) return;
    setBusy(kind);
    try {
      unwrapRpcResult(await session.rpc["commands.dispatch"](command));
      reload();
    } catch (failure) {
      if (isNoteChangedConflict(failure)) reload();
      throw failure;
    } finally {
      setBusy(null);
    }
  };

  return {
    note: current?.note ?? null,
    topic: current?.topic ?? null,
    error,
    /** Null until the versions are asked for. */
    history: versions,
    showHistory: () => loadHistory(),
    moreHistory: () => versions && !versions.loading && loadHistory(versions.versions),
    busy,
    reload,
    /** Writes `version` again as the newest version; restoring the current one undeletes it. */
    restore: (version: Pick<TeamNote, "title" | "body">) =>
      current ? write("restore", noteRestoreCommand(current.note, version)) : Promise.resolve(),
    remove: () => (current ? write("delete", noteDeleteCommand(current.note)) : Promise.resolve()),
  };
}

/** The team refused the read itself, not the network: what was read must go. */
function refused(failure: unknown): boolean {
  const code =
    typeof failure === "object" && failure !== null && "code" in failure ? failure.code : null;
  return code === "not_found" || code === "forbidden";
}
