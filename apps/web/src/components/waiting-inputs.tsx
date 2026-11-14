import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ContentPart, MessageRevisionView, TeamSource } from "@opensteer/core";
import {
  formatClockTime,
  HostClientRequestError,
  messageAuthorName,
  messageDraftParts,
  messageRevisionRows,
  type HostClient,
  type WaitingAsk,
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import { TranscriptMessage } from "./agent-activity.js";
import { Icon, type IconName } from "./icon.js";
import { sendMessageCommand } from "./pending-sends.js";
import { Popover } from "./popover.js";
import { TeamInputSource } from "../team/task-source-chip.js";

/** A longer list shows what is next in line and folds the rest. */
const foldAfter = 3;

/**
 * Everything waiting to reach the task's agent, at the foot of its
 * conversation in the order it will go: the person's own messages, drawn as
 * the bubbles they will be behind a dashed edge, then teammates' asks awaiting
 * an answer. Each is edited in place. An open edit outlives its message
 * leaving the line, so words typed while a Run took it are never lost.
 */
export const WaitingInputs = memo(function WaitingInputs({
  client,
  disabled,
  inputs,
  onError,
  paused,
  threadId,
  viewerUserId,
}: {
  readonly client: HostClient;
  readonly disabled: boolean;
  readonly inputs: readonly WaitingInput[];
  readonly onError: (error: unknown) => void;
  readonly paused: boolean;
  readonly threadId: string;
  readonly viewerUserId: string | null;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef(new Map<string, WaitingInput>());
  const rows = useMemo(() => {
    const here = new Set(inputs.map((input) => input.messageId));
    for (const id of seen.current.keys())
      if (!here.has(id) && !editing.has(id)) seen.current.delete(id);
    for (const input of inputs) seen.current.set(input.messageId, input);
    // Taken while open: it was at the head of the line, so it stays on top.
    const gone = [...editing].flatMap((id) => {
      const last = here.has(id) ? undefined : seen.current.get(id);
      return last ? [{ gone: true, input: last }] : [];
    });
    return [...gone, ...inputs.map((input) => ({ gone: false, input }))];
  }, [editing, inputs]);

  if (!paused && rows.length === 0) return null;

  const folded = !expanded && rows.length > foldAfter;
  const visible = folded
    ? rows.filter((row, index) => index < foldAfter - 1 || editing.has(row.input.messageId))
    : rows;

  const act = (messageId: string, run: () => Promise<void>) => {
    if (busyId !== null || disabled) return;
    setBusyId(messageId);
    void run()
      .catch(onError)
      .finally(() => setBusyId(null));
  };
  const setOpen = (messageId: string, open: boolean) =>
    setEditing((current) => {
      if (current.has(messageId) === open) return current;
      const next = new Set(current);
      if (open) next.add(messageId);
      else next.delete(messageId);
      return next;
    });

  return (
    <section aria-label="Waiting for your agent" className="queued">
      {paused ? (
        <div className="queued__paused">
          <span aria-hidden className="queued__paused-dot" />
          Paused
          <button
            className="queued__action"
            disabled={disabled || resuming}
            onClick={() => {
              setResuming(true);
              void client
                .resumeThreadInputQueue(threadId)
                .catch(onError)
                .finally(() => setResuming(false));
            }}
            type="button"
          >
            {resuming ? "Resuming…" : "Resume"}
          </button>
        </div>
      ) : null}
      {visible.length > 0 ? (
        <ol className="queued__list">
          {visible.map(({ gone, input }, index) => (
            <WaitingRow
              act={act}
              blocked={disabled || busyId !== null}
              busy={busyId === input.messageId}
              client={client}
              disabled={disabled}
              gone={gone}
              input={input}
              key={input.messageId}
              onOpenChange={(open) => setOpen(input.messageId, open)}
              position={`${index + 1} of ${rows.length}`}
              viewerUserId={viewerUserId}
            />
          ))}
        </ol>
      ) : null}
      {rows.length > foldAfter ? (
        <button
          aria-expanded={expanded}
          className="queued__more"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show ${rows.length - visible.length} more`}
          <Icon name="chevron-down" />
        </button>
      ) : null}
    </section>
  );
});

interface Draft {
  readonly text: string;
  /** The files and places it keeps; an edit can drop them but never add one. */
  readonly parts: readonly ContentPart[];
}

/** Why an open edit can't simply be saved, said in its place. */
type EditNotice = "taken" | "changed" | "failed";

function draftContent(draft: Draft): ContentPart[] {
  const text = draft.text.trim();
  return [...(text ? [{ text, type: "text" as const }] : []), ...draft.parts];
}

/**
 * One waiting message edited in place on this device. Opening takes its edit
 * lease, so no Run takes it meanwhile; every keystroke renews it; saving or
 * cancelling ends it, and so does leaving the task with it open.
 */
function useInPlaceEdit(
  client: HostClient,
  input: WaitingInput,
  onOpenChange: (open: boolean) => void,
) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<EditNotice | null>(null);
  const editor = useRef<Promise<WaitingMessageEditor> | null>(null);
  const base = useRef<Draft | null>(null);
  useEffect(
    () => () => {
      const held = editor.current;
      editor.current = null;
      void held?.then(
        (opened) => opened.cancel(),
        () => undefined,
      );
    },
    [],
  );

  const open = () => {
    if (draft) return;
    const content = input.item.message.content;
    const start = {
      parts: content.filter((part) => part.type !== "text"),
      text: messageDraftParts(content).body,
    };
    base.current = start;
    setDraft(start);
    setNotice(null);
    onOpenChange(true);
    const opening = client.editWaitingMessage(input.threadId, input.messageId);
    editor.current = opening;
    opening.catch((error: unknown) => {
      if (editor.current === opening) setNotice(isConflict(error) ? "changed" : "failed");
    });
  };

  const close = () => {
    const held = editor.current;
    editor.current = null;
    void held?.then(
      (opened) => opened.cancel(),
      () => undefined,
    );
    setDraft(null);
    setNotice(null);
    setSaving(false);
    onOpenChange(false);
  };

  const dirty =
    draft !== null &&
    base.current !== null &&
    (draft.text.trim() !== base.current.text.trim() ||
      draft.parts.length !== base.current.parts.length);

  /** Saves the edit in place; an unchanged one just ends. Resolves to the version now waiting. */
  const save = async (): Promise<number | null> => {
    const opening = editor.current;
    if (!draft || !opening || saving) return null;
    if (!dirty) {
      close();
      return input.revision;
    }
    const content = draftContent(draft);
    if (content.length === 0) return null;
    setSaving(true);
    setNotice(null);
    try {
      const edit = await (await opening).save(content);
      // Saving ended the lease; there is nothing left to cancel.
      editor.current = null;
      close();
      return edit.revision;
    } catch (error) {
      setSaving(false);
      setNotice(isConflict(error) ? "changed" : "failed");
      return null;
    }
  };

  return {
    close,
    dirty,
    draft,
    notice,
    open,
    removePart: (index: number) =>
      draft && setDraft({ ...draft, parts: draft.parts.filter((_, at) => at !== index) }),
    save,
    saving,
    setText: (text: string) => {
      if (!draft) return;
      setDraft({ ...draft, text });
      void editor.current?.then(
        (opened) => opened.touch(),
        () => undefined,
      );
    },
  };
}

function isConflict(error: unknown): boolean {
  return error instanceof HostClientRequestError && error.code === "conflict";
}

function WaitingRow({
  act,
  blocked,
  busy,
  client,
  disabled,
  gone,
  input,
  onOpenChange,
  position,
  viewerUserId,
}: {
  readonly act: (messageId: string, run: () => Promise<void>) => void;
  readonly blocked: boolean;
  readonly busy: boolean;
  readonly client: HostClient;
  readonly disabled: boolean;
  /** No longer waiting, kept only for the edit still open on it. */
  readonly gone: boolean;
  readonly input: WaitingInput;
  readonly onOpenChange: (open: boolean) => void;
  readonly position: string;
  readonly viewerUserId: string | null;
}) {
  const edit = useInPlaceEdit(client, input, onOpenChange);
  const [deciding, setDeciding] = useState<"approve" | "decline" | null>(null);
  const id = input.messageId;
  const otherDevice = input.lease.kind === "other" ? input.lease.deviceLabel : null;
  const editable =
    input.canEdit && otherDevice === null && !disabled && !gone && edit.draft === null;
  const ask = input.kind === "ask" ? input : null;

  const startEditing = () => {
    if (editable && !blocked) edit.open();
  };
  // The words themselves are the way in; files, links and Show more keep their own clicks.
  const clickWords = (event: MouseEvent<HTMLLIElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".message-fold")) return;
    if (target.closest("a, button") || window.getSelection()?.toString()) return;
    startEditing();
  };

  const decide = (decision: "approve" | "decline", ask: WaitingAsk) =>
    act(id, async () => {
      setDeciding(decision);
      try {
        if (decision === "decline") {
          if (edit.draft) edit.close();
          await client.decideTeamAsk({ decision, requestId: ask.requestId, teamId: ask.teamId });
          return;
        }
        // Consent names the words the person is looking at: save them first.
        const revision = edit.draft ? await edit.save() : ask.revision;
        if (revision === null) return;
        await client.decideTeamAsk({
          decision,
          expectedRevision: revision,
          requestId: ask.requestId,
          teamId: ask.teamId,
        });
      } finally {
        setDeciding(null);
      }
    });

  const sendAsNew = () =>
    act(id, async () => {
      if (!edit.draft) return;
      const content = draftContent(edit.draft);
      if (content.length === 0) return;
      await client.dispatch(
        sendMessageCommand(input.threadId, {
          attachments: [],
          body: edit.draft.text,
          content,
          idempotencyKey: globalThis.crypto.randomUUID(),
        }),
      );
      edit.close();
    });

  const files = input.entry.attachments?.length ?? 0;
  const label =
    input.kind === "ask"
      ? `Ask from ${input.asker}, ${position}: ${input.text}`
      : `Queued message ${position}: ${input.text}${
          files === 0 ? "" : `, ${files} ${files === 1 ? "attachment" : "attachments"}`
        }`;
  const approving = ask !== null && (ask.approving || deciding === "approve");

  return (
    <li
      aria-label={label}
      className={[
        "queued__item",
        busy && !ask ? "queued__item--busy" : "",
        editable ? "queued__item--editable" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={clickWords}
    >
      {edit.draft ? (
        <InPlaceEditor
          asker={
            ask?.asker ??
            (input.entry.author.kind === "human" && input.entry.author.userId === viewerUserId
              ? null
              : messageAuthorName(input.entry.author))
          }
          draft={edit.draft}
          source={input.entry.teamSource ?? null}
          onCancel={edit.close}
          onRemovePart={edit.removePart}
          onSave={() => void edit.save()}
          onText={edit.setText}
          saving={edit.saving}
        />
      ) : (
        <TranscriptMessage message={input.entry} queued reveal={null} viewerUserId={viewerUserId} />
      )}
      {edit.draft ? (
        <EditStatus
          ask={ask !== null}
          canSendAsNew={!ask && draftContent(edit.draft).length > 0}
          disabled={blocked}
          notice={gone ? "taken" : edit.notice}
          onCancel={edit.close}
          onSave={() => void edit.save()}
          onSendAsNew={sendAsNew}
          saving={edit.saving}
        />
      ) : null}
      {ask ? (
        <div className="queued__row waiting-ask">
          {approving ? (
            <span className="waiting-ask__line" data-approving role="status">
              <span aria-hidden className="waiting-ask__dot" />
              Approving…
            </span>
          ) : (
            <>
              <span
                className="waiting-ask__line"
                title={
                  ask.consentExpiresAt
                    ? `Lapses unanswered ${new Date(ask.consentExpiresAt).toLocaleString()}`
                    : undefined
                }
              >
                <span aria-hidden className="waiting-ask__dot" />
                {otherDevice ? `Being edited on ${otherDevice}` : ask.consent.line}
              </span>
              <span className="waiting-ask__actions">
                {otherDevice ? (
                  <ReleaseAction
                    disabled={blocked}
                    onRelease={() => act(id, () => client.releaseWaitingMessage(ask.threadId, id))}
                  />
                ) : ask.edit && !edit.draft ? (
                  <>
                    <span aria-hidden className="waiting__sep">
                      ·
                    </span>
                    <EditedMark client={client} input={ask} viewerUserId={viewerUserId} />
                  </>
                ) : null}
                <button
                  className="queued__action waiting-ask__decline"
                  disabled={blocked || gone}
                  onClick={() => decide("decline", ask)}
                  type="button"
                >
                  {deciding === "decline" ? "Declining…" : "Decline"}
                </button>
                <button
                  className="btn btn--small btn--primary waiting-ask__answer"
                  disabled={blocked || gone || otherDevice !== null || edit.saving}
                  onClick={() => decide("approve", ask)}
                  title={
                    otherDevice
                      ? `Being edited on ${otherDevice}`
                      : `Let your agent answer · ${ask.consent.line}`
                  }
                  type="button"
                >
                  {edit.dirty ? "Save and answer" : "Answer"}
                </button>
              </span>
            </>
          )}
        </div>
      ) : edit.draft ? null : (
        <div className={otherDevice ? "queued__row" : "queued__row queued__row--reveal"}>
          {otherDevice ? (
            <>
              <span className="queued__status">Being edited on {otherDevice}</span>
              <ReleaseAction
                disabled={blocked}
                onRelease={() => act(id, () => client.releaseWaitingMessage(input.threadId, id))}
              />
            </>
          ) : input.kind === "message" ? (
            <>
              {input.canSteer ? (
                <button
                  aria-label="Steer the current run with this message"
                  className="queued__action"
                  disabled={blocked}
                  onClick={() => act(id, () => client.steerThreadInput(input.threadId, id))}
                  title="Send into the turn under way"
                  type="button"
                >
                  <Icon name="corner-down-right" />
                  Steer
                </button>
              ) : null}
              {input.canEdit ? (
                <button
                  aria-label="Edit this message"
                  className="queued__action queued__action--icon"
                  disabled={blocked}
                  onClick={startEditing}
                  title="Edit"
                  type="button"
                >
                  <Icon name="pencil" />
                </button>
              ) : null}
              {input.canCancel ? (
                <button
                  aria-label="Remove this message from the queue"
                  className="queued__action queued__action--icon"
                  disabled={blocked}
                  onClick={() => act(id, () => client.cancelThreadInput(input.threadId, id))}
                  title="Remove"
                  type="button"
                >
                  <Icon name="close" />
                </button>
              ) : null}
              <span className="queued__status">{input.next ? "Up next" : "Queued"}</span>
              {input.edit ? (
                <>
                  <span aria-hidden className="waiting__sep">
                    ·
                  </span>
                  <EditedMark client={client} input={input} viewerUserId={viewerUserId} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Another device's edit holds the message; this frees it for the queue, or for editing here. */
function ReleaseAction({
  disabled,
  onRelease,
}: {
  readonly disabled: boolean;
  readonly onRelease: () => void;
}) {
  return (
    <button
      className="queued__action"
      disabled={disabled}
      onClick={onRelease}
      title="End that edit so this can move"
      type="button"
    >
      Release
    </button>
  );
}

/**
 * The message as an auto-growing field in its own footprint: the bubble for
 * the person's own words, the card for a teammate's. Its files and places
 * stay as chips that can be taken off.
 */
function InPlaceEditor({
  asker,
  draft,
  onCancel,
  onRemovePart,
  onSave,
  onText,
  saving,
  source,
}: {
  /** Someone else's words, a teammate's ask, are edited inside their card, under their name. */
  readonly asker: string | null;
  readonly draft: Draft;
  /** Where a teammate's ask came from, kept under its card while it is edited. */
  readonly source: TeamSource | null;
  readonly onCancel: () => void;
  readonly onRemovePart: (index: number) => void;
  readonly onSave: () => void;
  readonly onText: (text: string) => void;
  readonly saving: boolean;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const hint = useId();
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSave();
    }
  };
  const body = (
    <>
      {draft.parts.length > 0 ? (
        <div aria-label="Included with this message" className="waiting-edit__parts" role="group">
          {draft.parts.map((part, index) => {
            const name = partName(part);
            return (
              <span className="waiting-edit__part" key={`${index}:${name}`} title={name}>
                <Icon name={partIcon(part)} />
                <span className="waiting-edit__part-name">{name}</span>
                <button
                  aria-label={`Don’t include ${name}`}
                  className="waiting-edit__part-remove"
                  disabled={saving}
                  onClick={() => onRemovePart(index)}
                  title="Don’t include"
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="waiting-edit__grow" data-value={draft.text}>
        <textarea
          aria-describedby={hint}
          aria-keyshortcuts="Enter Escape"
          aria-label={asker ? `Edit ${asker}’s ask` : "Edit message"}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={saving}
          ref={field}
          rows={1}
          value={draft.text}
        />
      </div>
      <span className="visually-hidden" id={hint}>
        Enter saves, Shift+Enter starts a new line, Escape cancels.
      </span>
    </>
  );
  return asker ? (
    <div className="msg--input msg--queued waiting-edit waiting-edit--card">
      <article className="input-card">
        <header className="input-card__from">
          <span className="input-card__sender">
            <span className="input-card__name">{asker}</span>
          </span>
        </header>
        {body}
      </article>
      {source ? <TeamInputSource source={source} /> : null}
    </div>
  ) : (
    <div className="msg--user-row waiting-edit">
      <div className="waiting-edit__bubble">{body}</div>
    </div>
  );
}

function partIcon(part: ContentPart): IconName {
  switch (part.type) {
    case "artifact":
      return part.mediaType.startsWith("image/") ? "image" : "paperclip";
    case "browser-page":
      return "globe";
    case "computer-app":
      return "app";
    case "phone":
      return "phone";
    case "text":
      return "file";
  }
}

function partName(part: ContentPart): string {
  switch (part.type) {
    case "artifact":
      return part.name;
    case "browser-page":
      return part.title || part.url;
    case "computer-app":
    case "phone":
      return part.name;
    case "text":
      return part.text;
  }
}

/**
 * Under an open edit: that it holds its place while open and the keys that
 * end it, or, when it can't be saved where it is, why and what to do instead.
 */
function EditStatus({
  ask,
  canSendAsNew,
  disabled,
  notice,
  onCancel,
  onSave,
  onSendAsNew,
  saving,
}: {
  readonly ask: boolean;
  readonly canSendAsNew: boolean;
  readonly disabled: boolean;
  readonly notice: EditNotice | null;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onSendAsNew: () => void;
  readonly saving: boolean;
}) {
  if (notice)
    return (
      <div className="queued__row waiting-edit__notice" role="alert">
        <span className="waiting-edit__notice-text">
          {notice === "taken"
            ? "Your agent took this message before you saved."
            : notice === "changed"
              ? `This ${ask ? "ask" : "message"} changed elsewhere before you saved.`
              : "Couldn’t save your edit."}
        </span>
        {notice === "failed" ? (
          <button className="queued__action" disabled={saving} onClick={onSave} type="button">
            Try again
          </button>
        ) : canSendAsNew ? (
          <button
            className="queued__action"
            disabled={disabled}
            onClick={onSendAsNew}
            type="button"
          >
            Send as new message
          </button>
        ) : null}
        <button className="queued__action" onClick={onCancel} type="button">
          Discard
        </button>
      </div>
    );
  return (
    <div className="queued__row waiting-edit__hint">
      <span>
        {saving ? "Saving…" : ask ? "Only your agent sees your edit" : "Waits while you edit"}
      </span>
      <span aria-hidden className="waiting-edit__keys">
        <kbd className="kbd">esc</kbd>
        <kbd className="kbd">↵</kbd>
      </span>
      <span className="waiting-edit__touch">
        <button className="queued__action" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="queued__action" disabled={saving} onClick={onSave} type="button">
          Save
        </button>
      </span>
    </div>
  );
}

/** "Edited", which opens the message's versions, newest first. */
function EditedMark({
  client,
  input,
  viewerUserId,
}: {
  readonly client: HostClient;
  readonly input: WaitingInput;
  readonly viewerUserId: string | null;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        className="waiting__edited"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        title={input.edit ? `Edited ${new Date(input.edit.editedAt).toLocaleString()}` : undefined}
        type="button"
      >
        Edited
      </button>
      {anchor ? (
        <RevisionHistory
          anchor={anchor}
          client={client}
          input={input}
          onClose={() => setAnchor(null)}
          viewerUserId={viewerUserId}
        />
      ) : null}
    </>
  );
}

function RevisionHistory({
  anchor,
  client,
  input,
  onClose,
  viewerUserId,
}: {
  readonly anchor: HTMLElement;
  readonly client: HostClient;
  readonly input: WaitingInput;
  readonly onClose: () => void;
  readonly viewerUserId: string | null;
}) {
  const [revisions, setRevisions] = useState<readonly MessageRevisionView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const { messageId, threadId } = input;
  const load = useCallback(
    (before?: number) => {
      setState("loading");
      client.listMessageRevisions(threadId, messageId, before).then(
        (page) => {
          setRevisions((held) => (before === undefined ? [] : held).concat(page.revisions));
          setHasMore(page.hasMore);
          setState("ready");
        },
        () => setState("failed"),
      );
    },
    [client, messageId, threadId],
  );
  useEffect(() => load(), [load]);
  const rows = useMemo(
    () => messageRevisionRows(revisions, viewerUserId),
    [revisions, viewerUserId],
  );
  return (
    <Popover
      align="end"
      anchor={anchor}
      className="revisions"
      label="Edit history"
      onClose={onClose}
      role="dialog"
    >
      <p className="revisions__title">Edit history</p>
      {rows.length > 0 ? (
        <ol className="revisions__list">
          {rows.map((row) => (
            <li
              className="revisions__row"
              data-current={row.current || undefined}
              key={row.revision}
            >
              <p className="revisions__meta">
                <span className="revisions__who">{row.original ? "Original" : row.by}</span>
                {[row.original && row.by !== "You" ? row.by : null, row.device]
                  .filter((part) => part !== null)
                  .map((part) => ` · ${part}`)
                  .join("")}
                {" · "}
                <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
                  {formatClockTime(row.at)}
                </time>
              </p>
              <p className="revisions__text">{row.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {state === "failed" ? (
        <p className="revisions__note" role="alert">
          Couldn’t load the history.{" "}
          <button
            className="revisions__more"
            onClick={() => load(revisions.at(-1)?.revision)}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : state === "loading" ? (
        <p className="revisions__note">Loading…</p>
      ) : hasMore ? (
        <button
          className="revisions__more"
          onClick={() => load(revisions.at(-1)?.revision)}
          type="button"
        >
          Earlier versions
        </button>
      ) : null}
    </Popover>
  );
}
