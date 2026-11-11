import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { AgentOrb, WorkingRing } from "../workspace/task-mark.js";
import { AgentWorkFooter } from "./agent-status-card.js";
import { MessageBody, MessageFiles } from "./message-body.js";
import { AuthorAvatar, FaceStack } from "./team-marks.js";
import {
  agentName,
  authorName,
  firstName,
  plural,
  type FileView,
  type MessageView,
  type ThreadSummaryView,
} from "./team-models.js";
import { age, clockTime } from "./team-time.js";

/** "just now", "4m ago", "2h ago", "Mon". */
function sinceWords(iso: string): string {
  const short = age(iso);
  if (short === "now") return "just now";
  if (short === "Yesterday") return "yesterday";
  return /^\d/u.test(short) ? `${short} ago` : short;
}

/** What a reader can do to a message. A missing callback hides its control. */
export interface MessageActions {
  readonly onOpenThread?: ((rootId: string) => void) | undefined;
  /** Opens the message's thread with "to my agent" on. */
  readonly onAskAgent?: ((rootId: string) => void) | undefined;
  readonly onPin?: ((messageId: string, pinned: boolean) => void) | undefined;
  readonly onCopyLink?: ((messageId: string) => void) | undefined;
  readonly onEdit?: ((messageId: string, body: string) => void) | undefined;
  readonly onDelete?: ((messageId: string) => void) | undefined;
  readonly onRetrySend?: ((messageId: string) => void) | undefined;
  readonly onOpenFile?: ((file: FileView) => void) | undefined;
  readonly onOpenTask?: ((messageId: string) => void) | undefined;
}

/**
 * One message in a channel, a DM or a thread: left-aligned, the author's face
 * and name, Markdown words and files. A run of messages from one author
 * drops the face and name after the first.
 */
export const MessageRow = memo(function MessageRow({
  actions = {},
  editing = false,
  flash = false,
  grouped = false,
  highlight,
  inThread = false,
  message,
  onEditingChange,
  open = false,
}: {
  readonly actions?: MessageActions | undefined;
  /** Being edited in place (↑ in an empty composer starts this). */
  readonly editing?: boolean;
  /** A deep link landed here: flash it once. */
  readonly flash?: boolean;
  readonly grouped?: boolean;
  readonly highlight?: readonly string[] | undefined;
  /** In a thread pane: no "Reply in thread", no summary. */
  readonly inThread?: boolean;
  readonly message: MessageView;
  readonly onEditingChange?: ((editing: boolean) => void) | undefined;
  /** Its thread is open beside the channel. */
  readonly open?: boolean;
}) {
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const author = message.author;
  const failed = message.send?.kind === "failed";
  const canReply = !inThread && actions.onOpenThread !== undefined && !message.send;
  const pinned = Boolean(message.pinnedBy);
  const more =
    (message.canEdit && actions.onEdit) || (message.canDelete && actions.onDelete) ? true : false;
  return (
    <article
      className={[
        "tmsg",
        grouped ? "tmsg--grouped" : "",
        pinned ? "tmsg--pinned" : "",
        open ? "tmsg--open" : "",
        flash ? "tmsg--flash" : "",
        failed ? "tmsg--failed" : "",
        menuAt ? "tmsg--menu" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-message-id={message.id}
    >
      <div className="tmsg__gutter">
        {grouped ? (
          <time className="tmsg__gutter-time" dateTime={message.at}>
            {clockTime(message.at)}
          </time>
        ) : (
          <AuthorAvatar author={author} size={36} />
        )}
      </div>
      <div className="tmsg__main">
        {grouped ? null : (
          <header className="tmsg__head">
            <span className="tmsg__name">{authorName(author)}</span>
            <time className="tmsg__time" dateTime={message.at}>
              {message.send?.kind === "sending" ? "Sending…" : clockTime(message.at)}
            </time>
            {message.edited ? <span className="tmsg__edited">edited</span> : null}
          </header>
        )}
        {pinned ? (
          <p className="tmsg__pinned">
            <Icon name="pushpin" /> Pinned by {message.pinnedBy}
          </p>
        ) : null}
        {editing && actions.onEdit ? (
          <EditField
            body={message.body}
            onCancel={() => onEditingChange?.(false)}
            onSave={(body) => {
              actions.onEdit?.(message.id, body);
              onEditingChange?.(false);
            }}
          />
        ) : message.body ? (
          <MessageBody highlight={highlight} mentions={message.mentions} text={message.body} />
        ) : null}
        <MessageFiles files={message.files} onOpen={actions.onOpenFile} />
        {message.send?.kind === "queued" ? (
          <p className="tmsg__state">
            <Icon name="clock" /> Waiting for connection · sends when you’re back
          </p>
        ) : message.send?.kind === "failed" ? (
          <p className="tmsg__state tmsg__state--failed" role="alert">
            <Icon name="alert-circle" /> Not sent: {message.send.reason}
            {actions.onRetrySend ? (
              <button onClick={() => actions.onRetrySend?.(message.id)} type="button">
                Try again
              </button>
            ) : null}
            {actions.onDelete ? (
              <button onClick={() => actions.onDelete?.(message.id)} type="button">
                Delete
              </button>
            ) : null}
          </p>
        ) : null}
        {message.work ? (
          <AgentWorkFooter
            durationMs={message.work.durationMs}
            onOpenTask={
              message.work.openable && actions.onOpenTask
                ? () => actions.onOpenTask?.(message.id)
                : undefined
            }
            steps={message.work.steps}
          />
        ) : null}
        {!inThread && message.thread && message.thread.replyCount > 0 ? (
          <ThreadSummary
            onOpen={() => actions.onOpenThread?.(message.id)}
            open={open}
            summary={message.thread}
          />
        ) : null}
      </div>
      {message.send || editing ? null : (
        <div aria-label="Message actions" className="tmsg__actions" role="toolbar">
          {canReply ? (
            <button
              aria-label="Reply in thread"
              className="icon-btn icon-btn--small"
              onClick={() => actions.onOpenThread?.(message.id)}
              title="Reply in thread"
              type="button"
            >
              <Icon name="reply" />
            </button>
          ) : null}
          {actions.onAskAgent ? (
            <button
              className="tmsg__ask"
              onClick={() => actions.onAskAgent?.(message.id)}
              title="Ask my agent about this · opens the thread"
              type="button"
            >
              <AgentOrb size={16} />
              Ask my agent
            </button>
          ) : null}
          {actions.onPin ? (
            <button
              aria-label={pinned ? "Unpin" : "Pin"}
              aria-pressed={pinned}
              className="icon-btn icon-btn--small"
              onClick={() => actions.onPin?.(message.id, !pinned)}
              title={pinned ? "Unpin" : "Pin to channel"}
              type="button"
            >
              <Icon name="pushpin" />
            </button>
          ) : null}
          {actions.onCopyLink ? (
            <button
              aria-label="Copy link"
              className="icon-btn icon-btn--small"
              onClick={() => actions.onCopyLink?.(message.id)}
              title="Copy link"
              type="button"
            >
              <Icon name="link" />
            </button>
          ) : null}
          {more ? (
            <button
              aria-expanded={menuAt !== null}
              aria-haspopup="menu"
              aria-label="More"
              className="icon-btn icon-btn--small"
              onClick={(event) => setMenuAt(menuAt ? null : event.currentTarget)}
              title="More"
              type="button"
            >
              <Icon name="more" />
            </button>
          ) : null}
        </div>
      )}
      {menuAt ? (
        <Popover align="end" anchor={menuAt} below label="Message" onClose={() => setMenuAt(null)}>
          {message.canEdit && actions.onEdit ? (
            <button
              className="picker__row"
              onClick={() => {
                setMenuAt(null);
                onEditingChange?.(true);
              }}
              role="menuitem"
              type="button"
            >
              Edit
            </button>
          ) : null}
          {message.canDelete && actions.onDelete ? (
            <button
              className="picker__row picker__row--danger"
              onClick={() => {
                setMenuAt(null);
                actions.onDelete?.(message.id);
              }}
              role="menuitem"
              type="button"
            >
              Delete
            </button>
          ) : null}
        </Popover>
      ) : null}
    </article>
  );
});

/** Editing in place. It never wakes an agent again: a new ask is a new message. */
function EditField({
  body,
  onCancel,
  onSave,
}: {
  readonly body: string;
  readonly onCancel: () => void;
  readonly onSave: (body: string) => void;
}) {
  const [text, setText] = useState(body);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (text.trim()) onSave(text.trim());
    }
  };
  return (
    <div className="tmsg__edit">
      <textarea
        aria-label="Edit message"
        className="tmsg__edit-field"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        ref={ref}
        rows={Math.min(8, text.split("\n").length)}
        value={text}
      />
      <p className="tmsg__edit-hint">
        Enter to save · Esc to cancel. Editing never wakes an agent again; a new ask is a new
        message.
      </p>
    </div>
  );
}

/**
 * Under a root: who replied, how many, and the one live fact about an agent
 * at work in it. An agent's face is its owner's, with the orb.
 */
export function ThreadSummary({
  onOpen,
  open,
  summary,
}: {
  readonly onOpen: () => void;
  readonly open: boolean;
  readonly summary: ThreadSummaryView;
}) {
  const fact = summary.agent;
  return (
    <button
      aria-expanded={open}
      className="thread-summary"
      onClick={onOpen}
      title="Open thread"
      type="button"
    >
      <FaceStack authors={summary.repliers} />
      <span className="thread-summary__count">
        {plural(summary.replyCount, "reply", "replies")}
      </span>
      {fact?.kind === "working" ? (
        <span className="thread-summary__fact">
          <span aria-hidden className="thread-summary__ring">
            <WorkingRing />
          </span>
          {agentName(fact.owner)} is working
        </span>
      ) : fact?.kind === "waiting-owner" ? (
        <span className="thread-summary__fact thread-summary__fact--attention">
          {agentName(fact.owner)} is waiting for {fact.owner.you ? "you" : firstName(fact.owner)}
        </span>
      ) : fact?.kind === "waiting-computer" ? (
        <span className="thread-summary__fact">
          {agentName(fact.owner)} will start when{" "}
          {fact.owner.you ? "your" : `${firstName(fact.owner)}’s`} computer is back
        </span>
      ) : fact?.kind === "replied" ? (
        <span className="thread-summary__fact">
          {agentName(fact.owner)} replied · {clockTime(fact.at)}
        </span>
      ) : (
        <span className="thread-summary__fact">Last reply {sinceWords(summary.lastReplyAt)}</span>
      )}
    </button>
  );
}
