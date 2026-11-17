import { hostMessageOutbox } from "@opensteer/client/host";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import type { ContentPart, TeamSource } from "@opensteer/core";
import {
  followWaitingDraft,
  HostClientRequestError,
  messageAuthorName,
  mutationIdempotencyKey,
  openWaitingDraft,
  reloadWaitingDraft,
  removeWaitingDraftPart,
  setWaitingDraftText,
  waitingDraftContent,
  waitingDraftSave,
  type HostClient,
  type WaitingAsk,
  type WaitingDraft,
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import { TranscriptMessage } from "./agent-activity.js";
import type { PendingSubmission } from "./composer.js";
import { ComposerEditor, type ComposerEditorControl } from "./composer-editor.js";
import { personalReferenceCandidates, useReferencePicker } from "./composer-reference-picker.js";
import { Icon, type IconName } from "./icon.js";
import { EditedMark } from "./message-revisions.js";
import { sendMessageCommand } from "./pending-sends.js";
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
  resumable,
  threadId,
  viewerUserId,
}: {
  readonly client: HostClient;
  /** The reader can't act here at all. Each action is otherwise the Host's to offer. */
  readonly disabled: boolean;
  readonly inputs: readonly WaitingInput[];
  readonly onError: (error: unknown) => void;
  readonly paused: boolean;
  /** Where words sent as a new message are kept until the Host answers them, as the composer's are. */
  /** The Host runs this task's queue again on Resume: not while it is archived. */
  readonly resumable: boolean;
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
            disabled={disabled || resuming || !resumable}
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

/**
 * Why an open edit can't simply be saved, said in its place: the message was
 * taken, it changed elsewhere, the save failed, or words sent as a new
 * message went unanswered.
 */
type EditNotice = "taken" | "changed" | "failed" | "unconfirmed";

/** One opening of the editor on this device: its lease, and what it has under way. */
interface EditSession {
  /** Replaced when a lease that never opened is taken again; the words stay. */
  opening: Promise<WaitingMessageEditor>;
  /** Left: unmounted, or closed by the person. */
  closed: boolean;
  /** A save is out; it ends the lease, and nothing closes the editor before it answers. */
  saving: boolean;
  /** The words sent as a new message, kept under one key until the Host answers them. */
  sending: PendingSubmission | null;
}

/** The lease goes as soon as the editor holds it; one that never opened has nothing to end. */
function release(session: EditSession): void {
  void session.opening.then(
    (editor) => editor.cancel(),
    () => undefined,
  );
}

/**
 * One waiting message edited in place on this device. Opening takes its edit
 * lease, so no Run takes it meanwhile; every keystroke renews it; saving or
 * cancelling ends it, and so does leaving the task with it open. The draft is
 * bound to the version it was written against (`WaitingDraft`): untouched, it
 * follows a save made elsewhere; touched, that save is a conflict to settle.
 */
function useInPlaceEdit(
  client: HostClient,
  input: WaitingInput,
  gone: boolean,
  onOpenChange: (open: boolean) => void,
  trigger: RefObject<HTMLButtonElement | null>,
) {
  const [kept, setKept] = useState<WaitingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Exclude<EditNotice, "taken"> | null>(null);
  const session = useRef<EditSession | null>(null);
  const field = useRef<ComposerEditorControl | null>(null);
  const returnFocus = useRef(false);
  const row = useRef<HTMLLIElement | null>(null);
  const draft =
    kept && !gone && !saving
      ? followWaitingDraft(kept, { content: input.item.message.content, revision: input.revision })
      : kept;

  useEffect(
    () => () => {
      const held = session.current;
      session.current = null;
      if (!held) return;
      held.closed = true;
      if (!held.saving) release(held);
    },
    [],
  );
  useEffect(() => {
    if (draft || !returnFocus.current) return;
    returnFocus.current = false;
    trigger.current?.focus();
  }, [draft, trigger]);

  const open = () => {
    if (session.current) return;
    const held: EditSession = {
      closed: false,
      opening: client.editWaitingMessage(input.threadId, input.messageId),
      saving: false,
      sending: null,
    };
    session.current = held;
    setKept(openWaitingDraft({ content: input.item.message.content, revision: input.revision }));
    setNotice(null);
    onOpenChange(true);
    held.opening.catch((error: unknown) => {
      if (session.current === held) setNotice(isConflict(error) ? "changed" : "failed");
    });
  };

  /** Ends `held` if it is still the edit open here; a save under way ends it itself. */
  const finish = (held: EditSession | null, keepLease = false) => {
    if (!held || held.saving || session.current !== held) return;
    session.current = null;
    held.closed = true;
    if (!keepLease) release(held);
    // Focus left inside the editor goes back to what opened it.
    returnFocus.current = row.current?.contains(document.activeElement) ?? false;
    setKept(null);
    setNotice(null);
    setSaving(false);
    onOpenChange(false);
  };
  const close = () => finish(session.current);

  /**
   * The draft with the words the field holds right now, including input it
   * has not reported yet; null while an IME is still composing them.
   */
  const typed = async (): Promise<WaitingDraft | null> => {
    const editor = field.current;
    if (!draft || !editor) return draft;
    const now = await editor.flushPendingInput(editor.readSnapshot().generation).catch(() => null);
    if (now?.composing) return null;
    return now && now.text !== draft.text ? setWaitingDraftText(draft, now.text) : draft;
  };

  /** Saves the edit in place; an unchanged one just ends. Resolves to the version now waiting. */
  const save = async (): Promise<number | null> => {
    const held = session.current;
    if (!held || !draft || held.saving) return null;
    held.saving = true;
    const current = await typed();
    held.saving = false;
    if (!current || session.current !== held) return null;
    const plan = waitingDraftSave(current);
    if (plan === null) return null;
    if (plan.kind === "unchanged") {
      finish(held);
      return plan.revision;
    }
    held.saving = true;
    setSaving(true);
    setNotice(null);
    // The words as sent, kept through the save, so a refusal hands them back unchanged.
    setKept(current);
    try {
      const editor = await held.opening.catch(() => {
        held.opening = client.editWaitingMessage(input.threadId, input.messageId);
        return held.opening;
      });
      const edit = await editor.save(plan.content, plan.expectedRevision);
      held.saving = false;
      // Saving ended the lease; there is nothing left to cancel.
      finish(held, true);
      return edit.revision;
    } catch (error) {
      held.saving = false;
      if (held.closed) release(held);
      else if (session.current === held) {
        setSaving(false);
        setNotice(isConflict(error) ? "changed" : "failed");
      }
      return null;
    }
  };

  /**
   * Sends the words as a new message, kept first the way the composer keeps
   * one: an answer that went missing is sent again under the same key, never
   * as a second message, and a reload sends it from the composer.
   */
  const sendAsNew = async (): Promise<void> => {
    const held = session.current;
    if (!held || !draft) return;
    const outbox = hostMessageOutbox(client);
    if (!outbox) throw new Error("Message storage is unavailable.");
    let submission = held.sending;
    if (!submission) {
      const current = await typed();
      if (!current || session.current !== held || held.sending) return;
      const content = waitingDraftContent(current);
      if (content.length === 0) return;
      submission = {
        attachments: [],
        body: current.text.trim(),
        content,
        idempotencyKey: mutationIdempotencyKey("message"),
      };
      held.sending = submission;
    }
    await outbox.enqueue(sendMessageCommand(input.threadId, submission));
    held.sending = null;
    finish(held);
  };

  const shownNotice: EditNotice | null =
    notice === "unconfirmed" ? notice : gone ? "taken" : draft?.conflict ? "changed" : notice;

  return {
    close,
    draft,
    field,
    notice: shownNotice,
    open,
    reload: () => {
      if (draft?.conflict) {
        setKept(reloadWaitingDraft(draft));
        setNotice(null);
      }
    },
    removePart: (index: number) => {
      if (!draft) return;
      setKept(removeWaitingDraftPart(draft, index));
      void session.current?.opening.then(
        (opened) => opened.touch(),
        () => undefined,
      );
    },
    row,
    save,
    saving,
    sendAsNew,
    setText: (text: string) => {
      if (!draft) return;
      setKept(setWaitingDraftText(draft, text));
      void session.current?.opening.then(
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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const edit = useInPlaceEdit(client, input, gone, onOpenChange, trigger);
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
          edit.close();
          await client.decideTeamAsk({ decision, requestId: ask.requestId, teamId: ask.teamId });
          return;
        }
        // Consent names the version on screen: the editor's, saved first when changed.
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

  const files = input.entry.attachments?.length ?? 0;
  const label =
    input.kind === "ask"
      ? `Ask from ${input.asker}, ${position}: ${input.text}`
      : `Queued message ${position}: ${input.text}${
          files === 0 ? "" : `, ${files} ${files === 1 ? "attachment" : "attachments"}`
        }`;
  const approving = ask !== null && (ask.approving || deciding === "approve");
  const editButton = (name: string) => (
    <button
      aria-label={name}
      className="queued__action queued__action--icon"
      disabled={blocked}
      onClick={startEditing}
      ref={trigger}
      title="Edit"
      type="button"
    >
      <Icon name="pencil" />
    </button>
  );

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
      ref={edit.row}
    >
      {edit.draft ? (
        <InPlaceEditor
          asker={
            ask?.asker ??
            (input.entry.author.kind === "human" && input.entry.author.userId === viewerUserId
              ? null
              : messageAuthorName(input.entry.author))
          }
          client={client}
          draft={edit.draft}
          field={edit.field}
          locked={edit.saving || edit.notice === "unconfirmed"}
          source={input.entry.teamSource ?? null}
          onCancel={edit.close}
          onRemovePart={edit.removePart}
          onSave={() => void edit.save()}
          onText={edit.setText}
        />
      ) : (
        <TranscriptMessage message={input.entry} queued reveal={null} viewerUserId={viewerUserId} />
      )}
      {edit.draft ? (
        <EditStatus
          ask={ask !== null}
          canReload={edit.draft.conflict !== null}
          canSendAsNew={!ask && waitingDraftContent(edit.draft).length > 0}
          disabled={blocked}
          notice={edit.notice}
          onCancel={edit.close}
          onReload={edit.reload}
          onSave={() => void edit.save()}
          onSendAsNew={() => act(id, edit.sendAsNew)}
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
                    <EditedMark
                      client={client}
                      edit={ask.edit}
                      messageId={id}
                      threadId={ask.threadId}
                      viewerUserId={viewerUserId}
                    />
                  </>
                ) : null}
                {ask.canEdit && !otherDevice && !edit.draft
                  ? editButton(`Edit ${ask.asker}’s ask`)
                  : null}
                <button
                  className="queued__action waiting-ask__decline"
                  disabled={blocked || gone || edit.saving}
                  onClick={() => decide("decline", ask)}
                  type="button"
                >
                  {deciding === "decline" ? "Declining…" : "Decline"}
                </button>
                <button
                  className="btn btn--small btn--primary waiting-ask__answer"
                  disabled={
                    blocked ||
                    gone ||
                    otherDevice !== null ||
                    edit.saving ||
                    edit.draft?.conflict != null
                  }
                  onClick={() => decide("approve", ask)}
                  title={
                    otherDevice
                      ? `Being edited on ${otherDevice}`
                      : `Let your agent answer · ${ask.consent.line}`
                  }
                  type="button"
                >
                  {edit.draft?.dirty ? "Save and answer" : "Answer"}
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
              {input.canEdit ? editButton("Edit this message") : null}
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
                  <EditedMark
                    client={client}
                    edit={input.edit}
                    messageId={id}
                    threadId={input.threadId}
                    viewerUserId={viewerUserId}
                  />
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
  client,
  draft,
  field,
  locked,
  onCancel,
  onRemovePart,
  onSave,
  onText,
  source,
}: {
  /** Someone else's words, a teammate's ask, are edited inside their card, under their name. */
  readonly asker: string | null;
  readonly client: HostClient;
  readonly draft: WaitingDraft;
  readonly field: RefObject<ComposerEditorControl | null>;
  /** The words are on their way, as an edit or a new message, and stay as sent. */
  readonly locked: boolean;
  /** Where a teammate's ask came from, kept under its card while it is edited. */
  readonly source: TeamSource | null;
  readonly onCancel: () => void;
  readonly onRemovePart: (index: number) => void;
  readonly onSave: () => void;
  readonly onText: (text: string) => void;
}) {
  const hint = useId();
  const fieldElement = useRef<HTMLElement | null>(null);
  // A link is words: `@` offers references, never places or files, which an edit cannot add.
  const picker = useReferencePicker({
    editor: field,
    field: fieldElement,
    hostClient: null,
    links: (query) => personalReferenceCandidates(client, query),
    places: null,
  });
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (picker.keyDown(event)) return true;
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!locked) onSave();
      return true;
    }
    return false;
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
                  disabled={locked}
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
      <div className="waiting-edit__entry">
        {picker.list}
        <ComposerEditor
          autoFocus
          className="waiting-edit__field"
          fieldAttributes={{
            "aria-describedby": hint,
            "aria-keyshortcuts": "Enter Escape",
            "aria-label": asker ? `Edit ${asker}’s ask` : "Edit message",
            "aria-expanded": String(picker.expanded),
          }}
          fieldRef={(element) => {
            fieldElement.current = element;
          }}
          onBlur={picker.close}
          onChange={onText}
          onKeyDown={onKeyDown}
          onSelectionChange={picker.read}
          readOnly={locked}
          ref={field}
          scope="personal"
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
  canReload,
  canSendAsNew,
  disabled,
  notice,
  onCancel,
  onReload,
  onSave,
  onSendAsNew,
  saving,
}: {
  readonly ask: boolean;
  /** A newer version came in under the words; it can replace them. */
  readonly canReload: boolean;
  readonly canSendAsNew: boolean;
  readonly disabled: boolean;
  readonly notice: EditNotice | null;
  readonly onCancel: () => void;
  readonly onReload: () => void;
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
              : notice === "unconfirmed"
                ? "Opensteer couldn’t confirm your message was sent."
                : "Couldn’t save your edit."}
        </span>
        {notice === "failed" ? (
          <button className="queued__action" disabled={saving} onClick={onSave} type="button">
            Try again
          </button>
        ) : notice === "unconfirmed" ? (
          <button
            className="queued__action"
            disabled={disabled}
            onClick={onSendAsNew}
            type="button"
          >
            Send again
          </button>
        ) : (
          <>
            {canReload ? (
              <button className="queued__action" onClick={onReload} type="button">
                Reload
              </button>
            ) : null}
            {canSendAsNew ? (
              <button
                className="queued__action"
                disabled={disabled}
                onClick={onSendAsNew}
                type="button"
              >
                Send as new message
              </button>
            ) : null}
          </>
        )}
        <button className="queued__action" disabled={saving} onClick={onCancel} type="button">
          {notice === "unconfirmed" ? "Close" : "Discard"}
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
        <button className="queued__action" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="queued__action" disabled={saving} onClick={onSave} type="button">
          Save
        </button>
      </span>
    </div>
  );
}
