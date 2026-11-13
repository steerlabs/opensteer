import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  createId,
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
} from "@opensteer/core";
import type { TeamNote, TeamNoteWriter, TeamTopic } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import { usePagedList } from "@opensteer/client/react";
import {
  isNoteChangedConflict,
  noteByline,
  noteDraftReady,
  noteWriteCommand,
  noteWriterName,
  topicAudienceLabel,
  type NoteDraft,
} from "@opensteer/client/team";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icon.js";
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
import { useTeamRead, type TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

/**
 * A team's knowledge: topics, the notes in them, and each note's versions. Lists carry
 * previews only; a note's body is read when it is opened. Everything a person may do comes
 * from the topic's `can`, as the team Host answers it.
 */
export function TeamKnowledge({
  rest,
  view,
}: {
  readonly rest: readonly string[];
  readonly view: TeamView;
}) {
  const [topic, note, page] = rest;
  const topicId = KnowledgeTopicIdSchema.safeParse(topic);
  if (!topic) return <KnowledgeHome view={view} />;
  if (!topicId.success) return <KnowledgeMissing view={view} />;
  if (note === "new")
    return <NoteEditor key={`${topic}:new`} noteId={null} topicId={topicId.data} view={view} />;
  const noteId = KnowledgeNoteIdSchema.safeParse(note);
  if (note && !noteId.success) return <KnowledgeMissing view={view} />;
  if (noteId.success && page === "edit")
    return (
      <NoteEditor key={`${note}:edit`} noteId={noteId.data} topicId={topicId.data} view={view} />
    );
  if (noteId.success && page === "history")
    return <NoteHistory key={note} noteId={noteId.data} topicId={topicId.data} view={view} />;
  if (noteId.success)
    return <NotePage key={note} noteId={noteId.data} topicId={topicId.data} view={view} />;
  return <TopicPage key={topic} topicId={topicId.data} view={view} />;
}

/* ---- Reads ---- */

function useTopic(view: TeamView, topicId: KnowledgeTopicId) {
  const topic = useTeamRead(
    () => view.client.rpc["team.knowledge.topic.get"]({ topicId }).then(unwrapRpcResult),
    `topic:${view.team.teamId}:${topicId}`,
  );
  useOnReturn(topic.reload);
  return topic;
}

function useNotes(view: TeamView, topicId: KnowledgeTopicId | null, query: string) {
  const notes = usePagedList(
    (cursor) =>
      view.client.rpc["team.knowledge.notes.page"]({
        ...(topicId ? { topicId } : {}),
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      })
        .then(unwrapRpcResult)
        .then((page) => ({ items: page.notes, nextCursor: page.nextCursor })),
    `notes:${view.team.teamId}:${topicId ?? ""}:${query}`,
  );
  useOnReturn(notes.reload);
  return notes;
}

/** Reads again when the person comes back to the window: no live subscription to keep. */
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

function useSearchText(): readonly [string, string, (text: string) => void] {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(text.trim());
  useEffect(() => {
    const words = text.trim();
    if (words === query) return;
    const timer = setTimeout(() => {
      setQuery(words);
      setParams(
        (held) => {
          const next = new URLSearchParams(held);
          if (words) next.set("q", words);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);
  return [text, query, setText];
}

function writerAuthor(view: TeamView, writer: TeamNoteWriter): AuthorView {
  const face = { ...person(view.words, writer.userId), name: writer.name };
  return writer.kind === "agent"
    ? { kind: "agent", owner: face }
    : { kind: "person", person: face };
}

/* ---- Pieces ---- */

function KnowledgeShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="knowledge">
      <div className="knowledge__inner">{children}</div>
    </div>
  );
}

function BackLink({ children, to }: { readonly children: ReactNode; readonly to: string }) {
  return (
    <Link className="page__back knowledge__back" to={to}>
      <Icon name="arrow-left" />
      {children}
    </Link>
  );
}

function SearchField({
  label,
  onChange,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <label className="team-search-field knowledge__search">
      <Icon name="search" />
      <input
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={label}
        type="search"
        value={value}
      />
    </label>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="knowledge__empty">{children}</p>;
}

function KnowledgeMissing({ view }: { readonly view: TeamView }) {
  return (
    <KnowledgeShell>
      <BackLink to={knowledgePath(view.team.teamId)}>Knowledge</BackLink>
      <Empty>This doesn’t exist, or you can’t read it.</Empty>
    </KnowledgeShell>
  );
}

function NoteList({
  notes,
  showTopic,
  view,
}: {
  readonly notes: ReturnType<typeof useNotes>;
  readonly showTopic?: ReadonlyMap<string, string> | undefined;
  readonly view: TeamView;
}) {
  return (
    <>
      <ul className="knowledge-notes">
        {notes.items.map((note) => (
          <li key={note.id}>
            <Link
              className="knowledge-note"
              to={knowledgePath(view.team.teamId, note.topicId, note.id)}
            >
              <span className="knowledge-note__title">{note.title}</span>
              {note.preview ? (
                <span className="knowledge-note__preview">{note.preview}</span>
              ) : null}
              <span className="knowledge-note__meta">
                <AuthorAvatar author={writerAuthor(view, note.writer)} size={16} />
                <span>
                  {noteWriterName(note.writer, view.words.viewerUserId)} ·{" "}
                  {recentWhen(note.writtenAt)}
                  {showTopic?.get(note.topicId) ? ` · ${showTopic.get(note.topicId)}` : ""}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {notes.nextCursor ? (
        <button
          className="btn btn--small knowledge__more"
          disabled={notes.loadingMore}
          onClick={notes.more}
          type="button"
        >
          {notes.loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
      {notes.error && notes.items.length > 0 ? (
        <p className="knowledge__error" role="alert">
          {actionErrorMessage(notes.error)}
        </p>
      ) : null}
    </>
  );
}

/* ---- Knowledge: every topic, and search across them ---- */

function KnowledgeHome({ view }: { readonly view: TeamView }) {
  const navigate = useNavigate();
  const [text, query, setText] = useSearchText();
  const [creating, setCreating] = useState(false);
  const topics = usePagedList(
    (cursor) =>
      view.client.rpc["team.knowledge.topics.list"](
        cursor ? { after: KnowledgeTopicIdSchema.parse(cursor) } : {},
      )
        .then(unwrapRpcResult)
        .then((page) => ({
          items: page.topics,
          nextCursor: page.hasMore ? (page.topics.at(-1)?.id ?? null) : null,
        })),
    `topics:${view.team.teamId}`,
  );
  useOnReturn(topics.reload);
  const results = useNotes(view, null, query);
  const names = new Map(topics.items.map((topic) => [topic.id, topic.name]));
  const open = topics.items.filter((topic) => !topic.archivedAt);
  const archived = topics.items.filter((topic) => topic.archivedAt);
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  return (
    <KnowledgeShell>
      <header className="knowledge__head">
        <div className="knowledge__titles">
          <h1 className="knowledge__title">Knowledge</h1>
          <p className="knowledge__lead">
            What {teamName} and its agents know, kept in topics. Agents read and save here for the
            people who ask them.
          </p>
        </div>
        <button className="btn btn--small" onClick={() => setCreating(true)} type="button">
          <Icon name="plus" />
          New topic
        </button>
      </header>
      <SearchField label="Search every topic" onChange={setText} value={text} />
      {query ? (
        results.loading ? (
          <LoadingRows label="Searching" />
        ) : results.error && results.items.length === 0 ? (
          <Empty>{actionErrorMessage(results.error)}</Empty>
        ) : results.items.length === 0 ? (
          <Empty>No notes match “{query}”.</Empty>
        ) : (
          <NoteList notes={results} showTopic={names} view={view} />
        )
      ) : topics.loading && topics.items.length === 0 ? (
        <LoadingRows label="Loading topics" />
      ) : topics.error && topics.items.length === 0 ? (
        <Empty>{actionErrorMessage(topics.error)}</Empty>
      ) : (
        <>
          <TopicRows topics={open} view={view} />
          {topics.nextCursor ? (
            <button
              className="btn btn--small knowledge__more"
              disabled={topics.loadingMore}
              onClick={topics.more}
              type="button"
            >
              {topics.loadingMore ? "Loading…" : "More topics"}
            </button>
          ) : null}
          {archived.length > 0 ? (
            <details className="knowledge__archived">
              <summary>
                <Icon name="chevron-right" />
                Archived <span className="knowledge__count">{archived.length}</span>
              </summary>
              <TopicRows topics={archived} view={view} />
            </details>
          ) : null}
        </>
      )}
      {creating ? (
        <NewTopicDialog
          onClose={() => setCreating(false)}
          onCreated={(topicId) => void navigate(knowledgePath(view.team.teamId, topicId))}
          view={view}
        />
      ) : null}
    </KnowledgeShell>
  );
}

function TopicRows({
  topics,
  view,
}: {
  readonly topics: readonly TeamTopic[];
  readonly view: TeamView;
}) {
  if (topics.length === 0) return <Empty>No topics yet.</Empty>;
  return (
    <ul className="knowledge-topics">
      {topics.map((topic) => (
        <li key={topic.id}>
          <Link className="knowledge-topic" to={knowledgePath(view.team.teamId, topic.id)}>
            <span className="knowledge-topic__text">
              <span className="knowledge-topic__name">{topic.name}</span>
              {topic.description ? (
                <span className="knowledge-topic__description">{topic.description}</span>
              ) : null}
            </span>
            <span className="knowledge-topic__facts">
              <Audience topic={topic} />
              <span className="knowledge-topic__count">
                {topic.can.read ? (
                  `${topic.noteCount} ${topic.noteCount === 1 ? "note" : "notes"}`
                ) : (
                  <>
                    <Icon name="lock" />
                    You manage it
                  </>
                )}
              </span>
            </span>
            <Icon className="knowledge-topic__go" name="chevron-right" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Audience({ topic }: { readonly topic: Pick<TeamTopic, "audience"> }) {
  return (
    <span className="knowledge-audience">
      <Icon name={topic.audience.everyone ? "globe" : "users"} />
      {topicAudienceLabel(topic.audience)}
    </span>
  );
}

/* ---- A topic and its notes ---- */

function TopicPage({
  topicId,
  view,
}: {
  readonly topicId: KnowledgeTopicId;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const topic = useTopic(view, topicId);
  const [text, query, setText] = useSearchText();
  const notes = useNotes(view, topicId, query);
  const [sheet, setSheet] = useState<"access" | "edit" | null>(null);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const back = <BackLink to={knowledgePath(view.team.teamId)}>Knowledge</BackLink>;
  if (topic.error)
    return (
      <KnowledgeShell>
        {back}
        <Empty>This topic doesn’t exist, or you can’t read it.</Empty>
      </KnowledgeShell>
    );
  const current = topic.value;
  if (!current)
    return (
      <KnowledgeShell>
        {back}
        <LoadingRows label="Loading topic" />
      </KnowledgeShell>
    );
  const archive = (archived: boolean) =>
    void view.client.rpc["commands.dispatch"]({
      type: archived ? "team.knowledge.topic.archive" : "team.knowledge.topic.restore",
      topicId,
    })
      .then(unwrapRpcResult)
      .then(topic.reload)
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
  return (
    <KnowledgeShell>
      {back}
      <header className="knowledge__head">
        <div className="knowledge__titles">
          <h1 className="knowledge__title">{current.name}</h1>
          {current.description ? <p className="knowledge__lead">{current.description}</p> : null}
        </div>
        <div className="knowledge__actions">
          <button
            aria-label={`Who can use ${current.name}: ${topicAudienceLabel(current.audience)}`}
            className="btn btn--small btn--ghost knowledge__audience-button"
            onClick={() => setSheet("access")}
            type="button"
          >
            <Audience topic={current} />
          </button>
          {current.can.manage ? (
            <button
              aria-expanded={menu}
              aria-haspopup="menu"
              aria-label="Topic options"
              className="icon-btn icon-btn--small"
              onClick={() => setMenu((open) => !open)}
              ref={menuAnchor}
              type="button"
            >
              <Icon name="more" />
            </button>
          ) : null}
          {current.can.write ? (
            <Link
              className="btn btn--small btn--primary"
              to={knowledgePath(view.team.teamId, topicId, "new")}
            >
              <Icon name="plus" />
              New note
            </Link>
          ) : null}
        </div>
      </header>
      {menu && menuAnchor.current ? (
        <Popover
          align="end"
          anchor={menuAnchor.current}
          below
          label="Topic options"
          onClose={() => setMenu(false)}
          role="menu"
        >
          <button
            className="picker__row"
            onClick={() => {
              setMenu(false);
              setSheet("edit");
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
              archive(!current.archivedAt);
            }}
            role="menuitem"
            type="button"
          >
            <Icon name={current.archivedAt ? "undo" : "folder"} />
            {current.archivedAt ? "Restore" : "Archive"}
          </button>
        </Popover>
      ) : null}
      {current.archivedAt ? (
        <div className="notice notice--warn knowledge__notice">
          <Icon name="folder" />
          <div>Archived — nothing new can be saved here.</div>
          {current.can.manage ? (
            <button className="btn btn--small" onClick={() => archive(false)} type="button">
              Restore
            </button>
          ) : null}
        </div>
      ) : null}
      {current.can.read ? (
        <>
          <SearchField label={`Search ${current.name}`} onChange={setText} value={text} />
          {notes.loading && notes.items.length === 0 ? (
            <LoadingRows label="Loading notes" />
          ) : notes.error && notes.items.length === 0 ? (
            <Empty>{actionErrorMessage(notes.error)}</Empty>
          ) : notes.items.length === 0 ? (
            <Empty>
              {query
                ? `No notes match “${query}”.`
                : "No notes yet. Notes people and their agents save here will show up here."}
            </Empty>
          ) : (
            <NoteList notes={notes} view={view} />
          )}
        </>
      ) : (
        <div className="notice knowledge__notice">
          <Icon name="lock" />
          <div>You manage this topic but can’t read its notes.</div>
          <button className="btn btn--small" onClick={() => setSheet("access")} type="button">
            Access
          </button>
        </div>
      )}
      {sheet === "access" ? (
        <TopicAccessDialog
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            topic.reload();
            notes.reload();
          }}
          topic={current}
          view={view}
        />
      ) : sheet === "edit" ? (
        <EditTopicDialog
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            topic.reload();
          }}
          topic={current}
          view={view}
        />
      ) : null}
    </KnowledgeShell>
  );
}

/* ---- A note ---- */

function useNote(view: TeamView, noteId: KnowledgeNoteId) {
  const note = useTeamRead(
    () => view.client.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult),
    `note:${view.team.teamId}:${noteId}`,
  );
  useOnReturn(note.reload);
  return note;
}

function NotePage({
  noteId,
  topicId,
  view,
}: {
  readonly noteId: KnowledgeNoteId;
  readonly topicId: KnowledgeTopicId;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const note = useNote(view, noteId);
  const topic = useTopic(view, topicId);
  const [deleting, setDeleting] = useState(false);
  const teamId = view.team.teamId;
  const back = (
    <BackLink to={knowledgePath(teamId, topicId)}>{topic.value?.name ?? "Topic"}</BackLink>
  );
  if (note.error)
    return (
      <KnowledgeShell>
        {back}
        <Empty>This note doesn’t exist, or you can’t read it.</Empty>
      </KnowledgeShell>
    );
  const current = note.value;
  if (!current)
    return (
      <KnowledgeShell>
        {back}
        <LoadingRows label="Loading note" />
      </KnowledgeShell>
    );
  const write = topic.value?.can.write === true;
  const writeNote = (command: Parameters<(typeof view.client.rpc)["commands.dispatch"]>[0]) =>
    view.client.rpc["commands.dispatch"](command)
      .then(unwrapRpcResult)
      .then(note.reload)
      .catch((error: unknown) => {
        toast.error(actionErrorMessage(error));
        note.reload();
      });
  return (
    <KnowledgeShell>
      {back}
      <article className="knowledge-doc">
        <header className="knowledge-doc__head">
          <h1 className="knowledge-doc__title">{current.title}</h1>
          <div className="knowledge__actions">
            <Link
              className="btn btn--small btn--ghost"
              to={knowledgePath(teamId, topicId, noteId, "history")}
            >
              <Icon name="history" />
              History
            </Link>
            {write && !current.deleted ? (
              <>
                <button
                  aria-label="Delete note"
                  className="icon-btn icon-btn--small"
                  onClick={() => setDeleting(true)}
                  title="Delete"
                  type="button"
                >
                  <Icon name="trash" />
                </button>
                <Link
                  className="btn btn--small"
                  to={knowledgePath(teamId, topicId, noteId, "edit")}
                >
                  <Icon name="pencil" />
                  Edit
                </Link>
              </>
            ) : null}
          </div>
        </header>
        <NoteMeta note={current} view={view} />
        {current.deleted ? (
          <div className="notice knowledge__notice">
            <Icon name="trash" />
            <div>This note was deleted. Its history is kept.</div>
            {write ? (
              <button
                className="btn btn--small"
                onClick={() =>
                  void writeNote(
                    noteWriteCommand({
                      noteId,
                      topicId,
                      base: current,
                      draft: { title: current.title, body: current.body },
                    }),
                  )
                }
                type="button"
              >
                Restore
              </button>
            ) : null}
          </div>
        ) : current.body.trim() ? (
          <div className="knowledge-doc__body">
            <Markdown text={current.body} />
          </div>
        ) : (
          <Empty>This note has a title and nothing else yet.</Empty>
        )}
      </article>
      {deleting ? (
        <Dialog
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleting(false)} type="button">
                Cancel
              </button>
              <button
                autoFocus
                className="btn btn--danger"
                onClick={() => {
                  setDeleting(false);
                  void view.client.rpc["commands.dispatch"]({
                    type: "team.knowledge.note.delete",
                    noteId,
                    expectedVersion: current.version,
                  })
                    .then(unwrapRpcResult)
                    .then(() => void navigate(knowledgePath(teamId, topicId)))
                    .catch((error: unknown) => {
                      toast.error(actionErrorMessage(error));
                      note.reload();
                    });
                }}
                type="button"
              >
                Delete
              </button>
            </>
          }
          labelledBy="knowledge-delete-title"
          onClose={() => setDeleting(false)}
          title="Delete this note?"
        >
          <p className="team-dialog__text">
            “{current.title}” leaves {topic.value?.name ?? "this topic"}. Its history is kept, and
            anyone who can write here can restore it.
          </p>
        </Dialog>
      ) : null}
    </KnowledgeShell>
  );
}

function NoteMeta({ note, view }: { readonly note: TeamNote; readonly view: TeamView }) {
  const navigate = useNavigate();
  const source = note.source;
  const channel = source
    ? view.snapshot.sidebar?.channels.find((row) => row.channel.id === source.channelId)?.channel
    : undefined;
  return (
    <p className="knowledge-doc__meta">
      <AuthorAvatar author={writerAuthor(view, note.writer)} size={20} />
      <span>
        {noteByline(note, view.words.viewerUserId)} ·{" "}
        <time dateTime={note.writtenAt} title={new Date(note.writtenAt).toLocaleString()}>
          {recentWhen(note.writtenAt)}
        </time>
      </span>
      {source ? (
        <button
          className="knowledge-doc__source"
          onClick={() =>
            void navigate(
              channelPath(view.team.teamId, source.channelId, { messageId: source.messageId }),
            )
          }
          type="button"
        >
          <Icon name="message" />
          {channel ? `From a message in #${channel.name}` : "From a team message"}
        </button>
      ) : null}
    </p>
  );
}

/* ---- Writing ---- */

function NoteEditor({
  noteId,
  topicId,
  view,
}: {
  readonly noteId: KnowledgeNoteId | null;
  readonly topicId: KnowledgeTopicId;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [id] = useState(() => noteId ?? KnowledgeNoteIdSchema.parse(createId("knowledgeNote")));
  const topic = useTopic(view, topicId);
  const existing = useTeamRead(
    noteId
      ? () => view.client.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult)
      : null,
    `note:${view.team.teamId}:${noteId ?? "new"}`,
  );
  /** The version this draft is written on; null for a new note. */
  const [base, setBase] = useState<TeamNote | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(noteId ? null : { title: "", body: "" });
  const [theirs, setTheirs] = useState<TeamNote | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!existing.value || draft) return;
    setBase(existing.value);
    setDraft({ title: existing.value.title, body: existing.value.body });
  }, [existing.value]);
  const teamId = view.team.teamId;
  const leave = noteId ? knowledgePath(teamId, topicId, noteId) : knowledgePath(teamId, topicId);
  const back = (
    <BackLink to={leave}>
      {noteId ? (existing.value?.title ?? "Note") : (topic.value?.name ?? "Topic")}
    </BackLink>
  );
  if (existing.error)
    return (
      <KnowledgeShell>
        {back}
        <Empty>This note doesn’t exist, or you can’t read it.</Empty>
      </KnowledgeShell>
    );
  if (!draft)
    return (
      <KnowledgeShell>
        {back}
        <LoadingRows label="Loading note" />
      </KnowledgeShell>
    );
  const ready = noteDraftReady(base, draft) && !saving && topic.value?.can.write !== false;
  const save = () => {
    if (!ready) return;
    setSaving(true);
    void view.client.rpc["commands.dispatch"](
      noteWriteCommand({ noteId: id, topicId, base, draft }),
    )
      .then(unwrapRpcResult)
      .then(() => void navigate(knowledgePath(teamId, topicId, id), { replace: true }))
      .catch(async (error: unknown) => {
        if (!isNoteChangedConflict(error)) {
          toast.error(actionErrorMessage(error));
          return;
        }
        // Keep the draft and write the next save on top of what is there now.
        const current = await view.client.rpc["team.knowledge.note.get"]({ noteId: id }).then(
          unwrapRpcResult,
        );
        setBase(current);
        setTheirs(current);
        setShowTheirs(false);
      })
      .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      .finally(() => setSaving(false));
  };
  return (
    <KnowledgeShell>
      {back}
      <form
        className="knowledge-editor"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {topic.value && !topic.value.can.write ? (
          <div className="notice notice--warn knowledge__notice">
            <Icon name="lock" />
            <div>
              {topic.value.archivedAt
                ? "Archived — nothing new can be saved here."
                : "You can read this topic but not write in it."}
            </div>
          </div>
        ) : null}
        {theirs ? (
          <div className="notice notice--warn knowledge__notice knowledge-conflict">
            <Icon name="alert-circle" />
            <div>
              <p className="knowledge-conflict__text">
                {noteWriterName(theirs.writer, view.words.viewerUserId)} changed this note while you
                were editing it. Your draft is still here; saving now puts it on top of their
                version.
              </p>
              {showTheirs ? (
                <div className="knowledge-conflict__theirs">
                  <p className="knowledge-conflict__title">{theirs.title}</p>
                  {theirs.deleted ? (
                    <p className="knowledge__empty">They deleted it.</p>
                  ) : (
                    <Markdown text={theirs.body} />
                  )}
                </div>
              ) : null}
            </div>
            <button
              aria-expanded={showTheirs}
              className="btn btn--small"
              onClick={() => setShowTheirs((shown) => !shown)}
              type="button"
            >
              {showTheirs ? "Hide their version" : "Show their version"}
            </button>
          </div>
        ) : null}
        <input
          aria-label="Title"
          autoFocus={!noteId}
          className="knowledge-editor__title"
          maxLength={200}
          onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
          placeholder="Title"
          value={draft.title}
        />
        <textarea
          aria-label="Note"
          autoFocus={!!noteId}
          className="knowledge-editor__body"
          onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
          placeholder="Write what the team should know. Markdown works."
          value={draft.body}
        />
        <footer className="knowledge-editor__foot">
          <span className="knowledge-editor__hint">
            {base ? `Saving makes version ${base.version + 1}.` : "Saved notes keep every version."}
          </span>
          <button className="btn btn--ghost" onClick={() => void navigate(leave)} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!ready} type="submit">
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </KnowledgeShell>
  );
}

/* ---- History ---- */

function NoteHistory({
  noteId,
  topicId,
  view,
}: {
  readonly noteId: KnowledgeNoteId;
  readonly topicId: KnowledgeTopicId;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const topic = useTopic(view, topicId);
  const versions = usePagedList(
    (cursor) =>
      view.client.rpc["team.knowledge.note.history"]({
        noteId,
        ...(cursor ? { before: Number(cursor) } : {}),
      })
        .then(unwrapRpcResult)
        .then((page) => ({
          items: page.versions,
          nextCursor: page.hasMore ? String(page.versions.at(-1)?.version ?? "") || null : null,
        })),
    `history:${view.team.teamId}:${noteId}`,
  );
  const [chosen, setChosen] = useState<number | null>(null);
  const teamId = view.team.teamId;
  const latest = versions.items[0];
  const selected = versions.items.find((version) => version.version === chosen) ?? latest;
  const back = (
    <BackLink to={knowledgePath(teamId, topicId, noteId)}>{latest?.title ?? "Note"}</BackLink>
  );
  if (versions.error && versions.items.length === 0)
    return (
      <KnowledgeShell>
        {back}
        <Empty>This note doesn’t exist, or you can’t read it.</Empty>
      </KnowledgeShell>
    );
  if (!latest || !selected)
    return (
      <KnowledgeShell>
        {back}
        <LoadingRows label="Loading history" />
      </KnowledgeShell>
    );
  const restorable =
    topic.value?.can.write === true && selected.version !== latest.version && !selected.deleted;
  const restore = () =>
    void view.client.rpc["commands.dispatch"](
      noteWriteCommand({
        noteId,
        topicId,
        base: latest,
        draft: { title: selected.title, body: selected.body },
      }),
    )
      .then(unwrapRpcResult)
      .then(() => {
        toast.success(`Restored version ${selected.version}.`);
        void navigate(knowledgePath(teamId, topicId, noteId));
      })
      .catch((error: unknown) => {
        toast.error(actionErrorMessage(error));
        setChosen(null);
        versions.reload();
      });
  return (
    <KnowledgeShell>
      {back}
      <header className="knowledge__head">
        <div className="knowledge__titles">
          <h1 className="knowledge__title">History</h1>
          <p className="knowledge__lead">Every version of “{latest.title}”, newest first.</p>
        </div>
      </header>
      <div className="knowledge-history">
        <ol className="knowledge-history__list">
          {versions.items.map((version) => (
            <li key={version.version}>
              <button
                aria-current={version.version === selected.version ? "true" : undefined}
                className="knowledge-history__row"
                onClick={() => setChosen(version.version)}
                type="button"
              >
                <span className="knowledge-history__top">
                  <span className="knowledge-history__version">Version {version.version}</span>
                  {version.version === latest.version ? (
                    <span className="knowledge-tag">Current</span>
                  ) : null}
                  {version.deleted ? (
                    <span className="knowledge-tag knowledge-tag--deleted">Deleted</span>
                  ) : null}
                </span>
                <span className="knowledge-history__who">
                  <AuthorAvatar author={writerAuthor(view, version.writer)} size={16} />
                  {noteWriterName(version.writer, view.words.viewerUserId)} ·{" "}
                  {recentWhen(version.writtenAt)}
                </span>
              </button>
            </li>
          ))}
          {versions.nextCursor ? (
            <li>
              <button
                className="btn btn--small knowledge__more"
                disabled={versions.loadingMore}
                onClick={versions.more}
                type="button"
              >
                {versions.loadingMore ? "Loading…" : "Older versions"}
              </button>
            </li>
          ) : null}
        </ol>
        <section aria-label={`Version ${selected.version}`} className="knowledge-history__view">
          <header className="knowledge-history__view-head">
            <h2 className="knowledge-history__title">{selected.title}</h2>
            {restorable ? (
              <button className="btn btn--small" onClick={restore} type="button">
                <Icon name="undo" />
                Restore this version
              </button>
            ) : null}
          </header>
          <NoteMeta note={selected} view={view} />
          {selected.deleted ? (
            <Empty>This version deleted the note.</Empty>
          ) : selected.body.trim() ? (
            <Markdown text={selected.body} />
          ) : (
            <Empty>No text in this version.</Empty>
          )}
        </section>
      </div>
    </KnowledgeShell>
  );
}
