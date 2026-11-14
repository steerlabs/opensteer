import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import {
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
  type TeamChannelId,
} from "@opensteer/core";
import type { TeamNote, TeamNotePreview, TeamNoteWriter, TeamTopic } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import {
  useKnowledgeNote,
  useKnowledgeNotes,
  useKnowledgeTopics,
  useSettledText,
} from "@opensteer/client/react";
import {
  isNoteChangedConflict,
  noteByline,
  noteSourceWords,
  noteWriterName,
  topicAudienceLabel,
} from "@opensteer/client/team";
import { Icon, type IconName } from "../components/icon.js";
import { LoadingRows } from "../components/loading-rows.js";
import { Markdown } from "../components/markdown.js";
import { Popover } from "../components/popover.js";
import { AuthorAvatar } from "../components/team/team-marks.js";
import type { AuthorView } from "../components/team/team-models.js";
import { recentWhen } from "../components/team/team-time.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { EditTopicDialog, NewTopicDialog, TopicAccessDialog } from "./team-knowledge-topics.js";
import { channelPath, knowledgePath } from "./team-paths.js";
import type { TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

/**
 * A team's knowledge as records: topics on the left, the notes in the chosen topic (or all of
 * them) as a table, and the open note beside it. Agents write notes; people read them, decide
 * who may, and delete or restore. Everything a person may do comes from the topic's `can`.
 */
export function TeamKnowledge({
  rest,
  view,
}: {
  readonly rest: readonly string[];
  readonly view: TeamView;
}) {
  const [topic, note] = rest;
  // Notes once had pages of their own (`:topic/:note/edit|history`); they open beside the list now.
  if (topic && note) return <Navigate replace to={knowledgePath(view.team.teamId, topic, note)} />;
  const topicId = topic ? KnowledgeTopicIdSchema.safeParse(topic) : null;
  return (
    <Knowledge
      invalidTopic={topicId?.success === false}
      key={view.team.teamId}
      topicId={topicId?.success ? topicId.data : null}
      view={view}
    />
  );
}

function Knowledge({
  invalidTopic,
  topicId,
  view,
}: {
  readonly invalidTopic: boolean;
  readonly topicId: KnowledgeTopicId | null;
  readonly view: TeamView;
}) {
  const session = view.client;
  const teamId = view.team.teamId;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const openNote = KnowledgeNoteIdSchema.safeParse(params.get("note"));
  const noteId = openNote.success ? openNote.data : null;
  // The address holds the search the list answers; the field writes to it once typing settles,
  // and follows it when Back or Forward changes it.
  const query = params.get("q") ?? "";
  const [text, setText] = useState(query);
  const settled = useSettledText(text);
  const topics = useKnowledgeTopics(session);
  const notes = useKnowledgeNotes(session, { topicId, query });
  const [dialog, setDialog] = useState<"new" | "access" | "edit" | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (settled === query) return;
    setParams(
      (held) => {
        const next = new URLSearchParams(held);
        if (settled) next.set("q", settled);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [settled]);
  useEffect(() => {
    if (query !== settled) setText(query);
  }, [query]);

  /** Bumped on each refresh, so the open note reads again with the list. */
  const [round, setRound] = useState(0);
  const refreshList = () => {
    topics.reload();
    notes.reload();
  };
  const refresh = () => {
    refreshList();
    setRound((next) => next + 1);
  };
  useOnReturn(refresh);

  const href = (topic: KnowledgeTopicId | null, note: string | null = null) =>
    knowledgePath(teamId, topic, note, query);
  const show = (note: string | null, replace = false) =>
    void navigate(href(topicId, note), { replace });

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, [contenteditable='true']");
      if (target?.closest("[role='dialog'], [role='menu']")) return;
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        search.current?.focus();
      } else if (event.key === "Escape" && noteId && !typing) {
        show(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const all = topics.topics ?? [];
  const topic = topicId ? (all.find((row) => row.id === topicId) ?? null) : null;
  const missing = invalidTopic || (topicId !== null && topics.topics !== null && topic === null);
  const readable = topicId === null || topic?.can.read === true;
  const count = topicId
    ? (topic?.noteCount ?? 0)
    : all.reduce((sum, row) => sum + (row.can.read ? row.noteCount : 0), 0);
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const rows = notes.notes;

  /** Arrow keys walk the table and open each note in turn, as a mail list does. */
  const walk = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !rows?.length) return;
    event.preventDefault();
    const at = rows.findIndex((row) => row.id === noteId);
    const next =
      rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    show(next.id, noteId !== null);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-note-id="${next.id}"] a`)?.focus(),
    );
  };

  return (
    <div className="kb-frame">
      <div className="kb" data-note={noteId ? "" : undefined}>
        <TopicRail
          current={topicId}
          href={href}
          onNewTopic={() => setDialog("new")}
          search={search}
          setText={setText}
          text={text}
          topics={topics.topics}
        />
        <section aria-label="Notes" className="kb-list" data-stale={notes.stale ? "" : undefined}>
          {missing ? (
            <p className="knowledge__empty">This topic doesn’t exist, or you can’t read it.</p>
          ) : (
            <>
              <ListHead
                onAccess={() => setDialog("access")}
                onChanged={refresh}
                onEdit={() => setDialog("edit")}
                teamName={teamName}
                topic={topic}
                topicId={topicId}
                view={view}
              />
              {!readable && topic ? (
                <div className="notice knowledge__notice kb-notice">
                  <Icon name="lock" />
                  <div>You manage this topic but can’t read its notes.</div>
                  <button
                    className="btn btn--small"
                    onClick={() => setDialog("access")}
                    type="button"
                  >
                    Access
                  </button>
                </div>
              ) : (
                <div className="kb-scroll" ref={list}>
                  {rows === null ? (
                    notes.error ? (
                      <p className="knowledge__empty">{actionErrorMessage(notes.error)}</p>
                    ) : (
                      <LoadingRows label="Loading notes" rows={6} />
                    )
                  ) : rows.length === 0 && !notes.stale ? (
                    <p className="knowledge__empty">
                      {query
                        ? `No notes match “${query}”.`
                        : topicId
                          ? "No notes yet. Agents save what the team should know here."
                          : "No notes yet. Ask your agent to save what the team should know."}
                    </p>
                  ) : (
                    <NoteTable
                      all={topicId === null}
                      onOpen={(note) => show(note.id, noteId !== null)}
                      onWalk={walk}
                      openId={noteId}
                      rows={rows}
                      topics={all}
                      view={view}
                      href={(note) => href(topicId, note.id)}
                    />
                  )}
                  {notes.hasMore ? (
                    <NearEnd busy={notes.loadingMore} onMore={notes.more} root={list} />
                  ) : null}
                  {notes.error && rows !== null ? (
                    <p className="kb-error" role="alert">
                      {actionErrorMessage(notes.error)}
                    </p>
                  ) : null}
                </div>
              )}
              <footer className="kb-foot">
                <span>
                  {query
                    ? `${rows?.length ?? 0}${notes.hasMore ? "+" : ""} ${rows?.length === 1 ? "match" : "matches"}`
                    : `${count} ${count === 1 ? "note" : "notes"}`}
                </span>
                <span>{query ? "Best match first" : "Newest first"}</span>
              </footer>
            </>
          )}
        </section>
        {noteId ? (
          <NotePanel
            key={noteId}
            noteId={noteId}
            onChanged={refreshList}
            round={round}
            onClose={() => show(null)}
            topicHref={(topic) => href(topic)}
            topics={all}
            view={view}
          />
        ) : null}
      </div>
      {dialog === "new" ? (
        <NewTopicDialog
          onClose={() => setDialog(null)}
          onCreated={(created) => {
            topics.reload();
            void navigate(href(created));
          }}
          view={view}
        />
      ) : dialog === "access" && topic ? (
        <TopicAccessDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
          topic={topic}
          view={view}
        />
      ) : dialog === "edit" && topic ? (
        <EditTopicDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            topics.reload();
          }}
          topic={topic}
          view={view}
        />
      ) : null}
    </div>
  );
}

/* ---- Topics ---- */

function topicIcon(topic: TeamTopic): IconName {
  if (!topic.can.read) return "lock";
  return topic.audience.everyone ? "globe" : "users";
}

function TopicRail({
  current,
  href,
  onNewTopic,
  search,
  setText,
  text,
  topics,
}: {
  readonly current: KnowledgeTopicId | null;
  readonly href: (topic: KnowledgeTopicId | null) => string;
  readonly onNewTopic: () => void;
  readonly search: RefObject<HTMLInputElement | null>;
  readonly setText: (text: string) => void;
  readonly text: string;
  readonly topics: readonly TeamTopic[] | null;
}) {
  const open = topics?.filter((topic) => !topic.archivedAt) ?? [];
  const archived = topics?.filter((topic) => topic.archivedAt) ?? [];
  const [showArchived, setShowArchived] = useState(() =>
    archived.some((topic) => topic.id === current),
  );
  const total = (topics ?? []).reduce(
    (sum, topic) => sum + (topic.can.read ? topic.noteCount : 0),
    0,
  );
  const row = (topic: TeamTopic) => (
    <Link
      aria-current={topic.id === current ? "page" : undefined}
      className="kb-topic"
      key={topic.id}
      title={topic.description || undefined}
      to={href(topic.id)}
    >
      <Icon name={topicIcon(topic)} />
      <span className="kb-topic__name">{topic.name}</span>
      {topic.can.read ? <span className="kb-topic__count">{topic.noteCount}</span> : null}
    </Link>
  );
  return (
    <aside aria-label="Topics" className="kb-rail">
      <label className="team-search-field kb-search">
        <Icon name="search" />
        <input
          aria-label="Search notes"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text) {
              event.stopPropagation();
              setText("");
            }
          }}
          placeholder="Search notes"
          ref={search}
          type="search"
          value={text}
        />
        {text ? null : <kbd className="kb-search__key">/</kbd>}
      </label>
      <div className="kb-rail__head">
        <span>Topics</span>
        <button
          aria-label="New topic"
          className="icon-btn icon-btn--small"
          onClick={onNewTopic}
          title="New topic"
          type="button"
        >
          <Icon name="plus" />
        </button>
      </div>
      <nav aria-label="Topics" className="kb-rail__topics">
        <Link
          aria-current={current === null ? "page" : undefined}
          className="kb-topic"
          to={href(null)}
        >
          <Icon name="list" />
          <span className="kb-topic__name">All notes</span>
          {topics ? <span className="kb-topic__count">{total}</span> : null}
        </Link>
        <span aria-hidden className="kb-rail__gap" />
        {topics === null ? <LoadingRows label="Loading topics" rows={4} /> : open.map(row)}
        {archived.length > 0 ? (
          <>
            <button
              aria-expanded={showArchived}
              className="kb-topic kb-topic--fold"
              onClick={() => setShowArchived((now) => !now)}
              type="button"
            >
              <Icon name="folder" />
              <span className="kb-topic__name">Archived</span>
              <span className="kb-topic__count">{archived.length}</span>
            </button>
            {showArchived ? archived.map(row) : null}
          </>
        ) : null}
      </nav>
    </aside>
  );
}

function ListHead({
  onAccess,
  onChanged,
  onEdit,
  teamName,
  topic,
  topicId,
  view,
}: {
  readonly onAccess: () => void;
  readonly onChanged: () => void;
  readonly onEdit: () => void;
  readonly teamName: string;
  readonly topic: TeamTopic | null;
  readonly topicId: KnowledgeTopicId | null;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  if (topicId === null)
    return (
      <header className="kb-head">
        <div className="kb-head__text">
          <h2 className="kb-head__name">All notes</h2>
          <p className="kb-head__desc">Everything you and your agent can read in {teamName}.</p>
        </div>
      </header>
    );
  if (!topic)
    return (
      <header className="kb-head">
        <div className="kb-head__text">
          <span className="kb-head__placeholder" />
        </div>
      </header>
    );
  const archive = (archived: boolean) =>
    void view.client.rpc["commands.dispatch"]({
      type: archived ? "team.knowledge.topic.archive" : "team.knowledge.topic.restore",
      topicId: topic.id,
    })
      .then(unwrapRpcResult)
      .then(onChanged)
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
  return (
    <>
      <header className="kb-head">
        <div className="kb-head__text">
          <h2 className="kb-head__name">{topic.name}</h2>
          {topic.description ? <p className="kb-head__desc">{topic.description}</p> : null}
        </div>
        <div className="kb-head__actions">
          <button
            aria-label={`Who can use ${topic.name}: ${topicAudienceLabel(topic.audience)}`}
            className="btn btn--small kb-audience"
            onClick={onAccess}
            type="button"
          >
            <Icon name={topic.audience.everyone ? "globe" : "users"} />
            {topicAudienceLabel(topic.audience)}
          </button>
          {topic.can.manage ? (
            <button
              aria-expanded={menu}
              aria-haspopup="menu"
              aria-label="Topic options"
              className="icon-btn icon-btn--small"
              onClick={() => setMenu((open) => !open)}
              ref={anchor}
              type="button"
            >
              <Icon name="more" />
            </button>
          ) : null}
        </div>
      </header>
      {menu && anchor.current ? (
        <Popover
          align="end"
          anchor={anchor.current}
          below
          label="Topic options"
          onClose={() => setMenu(false)}
          role="menu"
        >
          <button
            className="picker__row"
            onClick={() => {
              setMenu(false);
              onEdit();
            }}
            role="menuitem"
            type="button"
          >
            <Icon name="pencil" />
            Edit name and description
          </button>
          <button
            className="picker__row"
            onClick={() => {
              setMenu(false);
              archive(!topic.archivedAt);
            }}
            role="menuitem"
            type="button"
          >
            <Icon name={topic.archivedAt ? "undo" : "folder"} />
            {topic.archivedAt ? "Restore" : "Archive"}
          </button>
        </Popover>
      ) : null}
      {topic.archivedAt ? (
        <div className="notice notice--warn knowledge__notice kb-notice">
          <Icon name="folder" />
          <div>Archived. Agents can read it but save nothing new here.</div>
          {topic.can.manage ? (
            <button className="btn btn--small" onClick={() => archive(false)} type="button">
              Restore
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ---- The table ---- */

function NoteTable({
  all,
  href,
  onOpen,
  onWalk,
  openId,
  rows,
  topics,
  view,
}: {
  readonly all: boolean;
  readonly href: (note: TeamNotePreview) => string;
  readonly onOpen: (note: TeamNotePreview) => void;
  readonly onWalk: (event: KeyboardEvent<HTMLTableSectionElement>) => void;
  readonly openId: KnowledgeNoteId | null;
  readonly rows: readonly TeamNotePreview[];
  readonly topics: readonly TeamTopic[];
  readonly view: TeamView;
}) {
  const names = new Map(topics.map((topic) => [topic.id as string, topic]));
  const viewer = view.words.viewerUserId;
  return (
    <table className="kb-table">
      <thead>
        <tr>
          <th className="kb-c-title">Title</th>
          {all ? <th className="kb-c-topic">Topic</th> : null}
          <th className="kb-c-who">Saved by</th>
          <th className="kb-c-when">Updated</th>
          <th className="kb-c-source">Source</th>
        </tr>
      </thead>
      <tbody onKeyDown={onWalk}>
        {rows.map((note) => {
          const topic = names.get(note.topicId);
          return (
            <tr
              aria-selected={note.id === openId}
              data-note-id={note.id}
              key={note.id}
              onClick={(event) => {
                if ((event.target as Element).closest("a, button")) return;
                onOpen(note);
              }}
            >
              <td className="kb-c-title">
                <Link
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                      return;
                    event.preventDefault();
                    onOpen(note);
                  }}
                  title={note.preview || note.title}
                  to={href(note)}
                >
                  {note.title}
                </Link>
              </td>
              {all ? (
                <td className="kb-c-topic">
                  {topic ? (
                    <span className="kb-cell">
                      <Icon name={topicIcon(topic)} />
                      {topic.name}
                    </span>
                  ) : null}
                </td>
              ) : null}
              <td className="kb-c-who">
                <span className="kb-cell">
                  <AuthorAvatar author={writerAuthor(view, note.writer)} size={18} />
                  <span className="kb-who__name">{noteWriterName(note.writer, viewer)}</span>
                </span>
              </td>
              <td className="kb-c-when">
                <time dateTime={note.writtenAt} title={new Date(note.writtenAt).toLocaleString()}>
                  {recentWhen(note.writtenAt)}
                </time>
              </td>
              <td className="kb-c-source">
                {note.source ? sourceWords(view, note.source.channelId) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Reads the next page as its end scrolls near, with a button for when it can't tell. */
function NearEnd({
  busy,
  onMore,
  root,
}: {
  readonly busy: boolean;
  readonly onMore: () => void;
  readonly root: RefObject<HTMLDivElement | null>;
}) {
  const marker = useRef<HTMLDivElement | null>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const node = marker.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.current();
      },
      { root: root.current, rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  return (
    <div className="kb-more" ref={marker}>
      <button className="btn btn--small btn--ghost" disabled={busy} onClick={onMore} type="button">
        {busy ? "Loading…" : "Show more"}
      </button>
    </div>
  );
}

/* ---- The open note ---- */

function NotePanel({
  noteId,
  onChanged,
  onClose,
  round,
  topicHref,
  topics,
  view,
}: {
  readonly noteId: KnowledgeNoteId;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  /** Changes whenever the page reads again (a return to the window, an access change). */
  readonly round: number;
  readonly topicHref: (topic: KnowledgeTopicId) => string;
  readonly topics: readonly TeamTopic[];
  readonly view: TeamView;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const read = useKnowledgeNote(view.client, noteId, null);
  const opened = useRef(round);
  const { reload } = read;
  useEffect(() => {
    if (round === opened.current) return;
    opened.current = round;
    reload();
  }, [round, reload]);
  const [viewing, setViewing] = useState<number | null>(null);
  const { note, history } = read;
  const topic = note ? topics.find((row) => row.id === note.topicId) : undefined;
  const canWrite = topic?.can.write === true;
  const viewer = view.words.viewerUserId;
  const older = viewing === null ? null : history?.versions.find((v) => v.version === viewing);
  const shown = older ?? note;

  const failed = (error: unknown) =>
    toast.error(
      isNoteChangedConflict(error)
        ? "Someone changed this note. You’re seeing the newest version now."
        : actionErrorMessage(error),
    );
  const restore = (from: TeamNote) =>
    void read.restore(from).then(() => {
      setViewing(null);
      onChanged();
      toast.success(
        from.version === note?.version ? "Note restored." : `Restored version ${from.version}.`,
      );
    }, failed);
  const remove = () =>
    void read.remove().then(() => {
      onChanged();
      toast.success("Note deleted.");
    }, failed);

  return (
    <aside aria-label="Note" className="kb-note">
      <div className="kb-note__bar">
        {topic ? (
          <Link className="kb-note__crumb" to={topicHref(topic.id)}>
            <Icon name={topicIcon(topic)} />
            {topic.name}
          </Link>
        ) : (
          <span className="kb-note__crumb" />
        )}
        <button
          aria-label="Close note"
          className="icon-btn icon-btn--small"
          onClick={onClose}
          title="Close (Esc)"
          type="button"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="kb-note__scroll">
        {read.error && !note ? (
          <p className="knowledge__empty">This note doesn’t exist, or you can’t read it.</p>
        ) : !shown || !note ? (
          <LoadingRows label="Loading note" rows={4} />
        ) : (
          <>
            {older ? (
              <div className="kb-viewing">
                <Icon name="history" />
                <span>Version {older.version}</span>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => setViewing(null)}
                  type="button"
                >
                  Current
                </button>
                {canWrite && !older.deleted ? (
                  <button
                    className="btn btn--small"
                    disabled={read.busy !== null}
                    onClick={() => restore(older)}
                    type="button"
                  >
                    <Icon name="undo" />
                    Restore
                  </button>
                ) : null}
              </div>
            ) : null}
            <h2 className="kb-note__title">{shown.title}</h2>
            <p className="kb-note__meta">
              <AuthorAvatar author={writerAuthor(view, shown.writer)} size={18} />
              <span>
                {noteByline(shown, viewer)} ·{" "}
                <time dateTime={shown.writtenAt} title={new Date(shown.writtenAt).toLocaleString()}>
                  {recentWhen(shown.writtenAt)}
                </time>
              </span>
              {shown.source ? (
                <button
                  className="kb-source"
                  onClick={() =>
                    void navigate(
                      channelPath(view.team.teamId, shown.source!.channelId, {
                        messageId: shown.source!.messageId,
                      }),
                    )
                  }
                  title="Open the message that asked for this"
                  type="button"
                >
                  <Icon name="message" />
                  {sourceWords(view, shown.source.channelId)}
                </button>
              ) : null}
            </p>
            {note.deleted && !older ? (
              <div className="notice knowledge__notice kb-deleted">
                <Icon name="trash" />
                <div>Deleted. Its history is kept.</div>
                {canWrite ? (
                  <button
                    className="btn btn--small"
                    disabled={read.busy !== null}
                    onClick={() => restore(note)}
                    type="button"
                  >
                    Restore
                  </button>
                ) : null}
              </div>
            ) : shown.deleted ? (
              <p className="knowledge__empty">This version deleted the note.</p>
            ) : (
              <div className="kb-note__body">
                {shown.body.trim() ? (
                  <Markdown text={shown.body} />
                ) : (
                  <p className="kb-quiet">No text, just a title.</p>
                )}
              </div>
            )}
            <Versions
              history={history}
              note={note}
              onMore={read.moreHistory}
              onPick={(version) => setViewing(version === note.version ? null : version)}
              onShow={read.showHistory}
              view={view}
              viewing={viewing ?? note.version}
            />
          </>
        )}
      </div>
      {note && canWrite && !note.deleted ? (
        <footer className="kb-note__foot">
          <span className="kb-note__hint">Agents keep notes current. Ask yours to change one.</span>
          <button
            className="btn btn--small btn--ghost btn--danger"
            disabled={read.busy !== null}
            onClick={remove}
            type="button"
          >
            <Icon name="trash" />
            Delete
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

function Versions({
  history,
  note,
  onMore,
  onPick,
  onShow,
  view,
  viewing,
}: {
  readonly history: ReturnType<typeof useKnowledgeNote>["history"];
  readonly note: TeamNote;
  readonly onMore: () => void;
  readonly onPick: (version: number) => void;
  readonly onShow: () => void;
  readonly view: TeamView;
  readonly viewing: number;
}) {
  const viewer = view.words.viewerUserId;
  return (
    <section aria-label="Versions" className="kb-versions">
      <div className="kb-versions__head">
        <span>Versions</span>
        {history === null ? (
          <button className="link-button" onClick={onShow} type="button">
            Show {note.version}
          </button>
        ) : (
          <span>{note.version}</span>
        )}
      </div>
      {history === null ? null : (
        <ol className="kb-versions__list">
          {history.versions.map((version) => (
            <li key={version.version}>
              <button
                aria-current={version.version === viewing ? "true" : undefined}
                className="kb-version"
                onClick={() => onPick(version.version)}
                type="button"
              >
                <span className="kb-version__n">v{version.version}</span>
                <span className="kb-cell">
                  <AuthorAvatar author={writerAuthor(view, version.writer)} size={16} />
                  {noteWriterName(version.writer, viewer)}
                </span>
                <span className="kb-quiet">{recentWhen(version.writtenAt)}</span>
                {version.version === note.version ? (
                  <span className="kb-tag">Current</span>
                ) : version.deleted ? (
                  <span className="kb-tag kb-tag--deleted">Deleted</span>
                ) : null}
              </button>
            </li>
          ))}
          {history.loading ? (
            <li>
              <LoadingRows label="Loading versions" rows={2} />
            </li>
          ) : history.error ? (
            <li className="kb-error" role="alert">
              {actionErrorMessage(history.error)}{" "}
              <button className="link-button" onClick={onMore} type="button">
                Try again
              </button>
            </li>
          ) : history.hasMore ? (
            <li>
              <button
                className="btn btn--small btn--ghost kb-versions__more"
                onClick={onMore}
                type="button"
              >
                Older versions
              </button>
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

/* ---- Pieces ---- */

/** Reads again when the person comes back to the window: knowledge has no live stream. */
function useOnReturn(read: () => void) {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    let last = Date.now();
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 2_000) return;
      last = Date.now();
      latest.current();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
}

function writerAuthor(view: TeamView, writer: TeamNoteWriter): AuthorView {
  const face = { ...person(view.words, writer.userId), name: writer.name };
  return writer.kind === "agent"
    ? { kind: "agent", owner: face }
    : { kind: "person", person: face };
}

function sourceWords(view: TeamView, channelId: TeamChannelId): string {
  return noteSourceWords(
    view.snapshot.sidebar?.channels.find((row) => row.channel.id === channelId)?.channel,
  );
}
