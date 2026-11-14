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

interface NoteHistory {
  readonly versions: readonly TeamNote[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: unknown;
}

/**
 * One note, and its topic when `topicId` is given (a caller holding the topic list passes
 * null), read together. Its versions are read only when asked for: most opens never need
 * them, and a busy note's history is every body it ever had. Restoring writes an old version
 * again as the newest; a stale view is refused and read again.
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
  const historyLoad = useRef(0);
  /** Versions were asked for, so a reload reads them again too. */
  const historyOpen = useRef(false);

  useEffect(() => {
    if (!session) return;
    let live = true;
    setError(null);
    void Promise.all([
      session.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult),
      topicId === null
        ? null
        : session.rpc["team.knowledge.topic.get"]({ topicId }).then(unwrapRpcResult),
    ]).then(
      ([note, topic]) => live && setRead({ key, note, topic }),
      (failure: unknown) => live && setError(failure),
    );
    return () => {
      live = false;
    };
  }, [session, key, noteId, topicId, generation]);

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
      setHistory((now) => ({
        versions: after,
        hasMore: now?.hasMore ?? false,
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
              versions: [...after, ...page.versions],
              hasMore: page.hasMore,
              loading: false,
              error: null,
            }),
          (failure: unknown) =>
            load === historyLoad.current &&
            setHistory({ versions: after, hasMore: true, loading: false, error: failure }),
        );
    },
    [session, noteId],
  );

  const current = read?.key === key ? read : null;
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
    history,
    showHistory: () => loadHistory(),
    moreHistory: () => history && !history.loading && loadHistory(history.versions),
    busy,
    reload,
    /** Writes `version` again as the newest version; restoring the current one undeletes it. */
    restore: (version: Pick<TeamNote, "title" | "body">) =>
      current ? write("restore", noteRestoreCommand(current.note, version)) : Promise.resolve(),
    remove: () => (current ? write("delete", noteDeleteCommand(current.note)) : Promise.resolve()),
  };
}
