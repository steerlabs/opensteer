import { memo, useMemo, useState } from "react";
import type { ArtifactContentPart, PlaceContentPart, ThreadInputQueue } from "@opensteer/core";
import {
  messageDraftParts,
  queuedMessages,
  type HostClient,
  type QueuedMessage,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { TranscriptMessage } from "./agent-activity.js";
import { Icon } from "./icon.js";

/** A longer queue shows the messages next in line and folds the rest. */
const foldAfter = 3;

/**
 * The messages waiting behind a task's current turn, at the foot of its
 * conversation. Each is drawn as it will be once sent, unfilled behind a
 * dashed edge, in the order Runs will take them. Only people's messages appear
 * (see `queuedMessages`). Steer, Edit and Remove sit under each one, only when
 * the Host will honour them.
 */
export const QueuedMessages = memo(function QueuedMessages({
  client,
  disabled,
  onEdit,
  onError,
  queue,
  viewerUserId,
  workspaces,
}: {
  readonly client: HostClient;
  readonly disabled: boolean;
  /** Puts a message taken back from the queue, files included, into the composer to be reworded. */
  readonly onEdit: (message: {
    readonly attachments: readonly ArtifactContentPart[];
    readonly places: readonly PlaceContentPart[];
    readonly text: string;
  }) => void;
  readonly onError: (error: unknown) => void;
  readonly queue: ThreadInputQueue;
  readonly viewerUserId: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const shown = useMemo(() => queuedMessages(queue), [queue]);

  if (!queue.paused && shown.length === 0) return null;

  const folded = !expanded && shown.length > foldAfter;
  const visible = folded ? shown.slice(0, foldAfter - 1) : shown;

  const act = (messageId: string, run: () => Promise<void>) => {
    if (busyId !== null || disabled) return;
    setBusyId(messageId);
    void run()
      .catch(onError)
      .finally(() => setBusyId(null));
  };

  const row = ({ entry, item, next, text }: QueuedMessage, index: number) => {
    const id = item.message.id;
    const files = entry.attachments?.length ?? 0;
    const blocked = disabled || busyId !== null;
    return (
      <li
        aria-label={`Queued message ${index + 1} of ${shown.length}: ${text}${
          files === 0 ? "" : `, ${files} ${files === 1 ? "attachment" : "attachments"}`
        }`}
        className={busyId === id ? "queued__item queued__item--busy" : "queued__item"}
        key={id}
      >
        <TranscriptMessage
          message={entry}
          queued
          reveal={null}
          viewerUserId={viewerUserId}
          workspaces={workspaces}
        />
        <div className="queued__row">
          {item.canSteer ? (
            <button
              aria-label="Steer the current run with this message"
              className="queued__action"
              disabled={blocked}
              onClick={() => act(id, () => client.steerThreadInput(queue.threadId, id))}
              title="Send into the turn under way"
              type="button"
            >
              <Icon name="corner-down-right" />
              Steer
            </button>
          ) : null}
          {item.canCancel ? (
            <>
              <button
                aria-label="Edit this message"
                className="queued__action queued__action--icon"
                disabled={blocked}
                onClick={() =>
                  act(id, async () => {
                    await client.cancelThreadInput(queue.threadId, id);
                    // Every place goes back as a chip; none is an empty choice that sticks.
                    const draft = messageDraftParts(item.message.content);
                    onEdit({
                      attachments: draft.attachments,
                      places: draft.places,
                      text: draft.body,
                    });
                  })
                }
                title="Edit"
                type="button"
              >
                <Icon name="pencil" />
              </button>
              <button
                aria-label="Remove this message from the queue"
                className="queued__action queued__action--icon"
                disabled={blocked}
                onClick={() => act(id, () => client.cancelThreadInput(queue.threadId, id))}
                title="Remove"
                type="button"
              >
                <Icon name="close" />
              </button>
            </>
          ) : null}
          <span className="queued__status">{next ? "Up next" : "Queued"}</span>
        </div>
      </li>
    );
  };

  return (
    <section aria-label="Queued messages" className="queued">
      {queue.paused ? (
        <div className="queued__paused">
          <span aria-hidden className="queued__paused-dot" />
          Paused
          <button
            className="queued__action"
            disabled={disabled || resuming}
            onClick={() => {
              setResuming(true);
              void client
                .resumeThreadInputQueue(queue.threadId)
                .catch(onError)
                .finally(() => setResuming(false));
            }}
            type="button"
          >
            {resuming ? "Resuming…" : "Resume"}
          </button>
        </div>
      ) : null}
      {visible.length > 0 ? <ol className="queued__list">{visible.map(row)}</ol> : null}
      {shown.length > foldAfter ? (
        <button
          aria-expanded={expanded}
          className="queued__more"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show ${shown.length - visible.length} more`}
          <Icon name="chevron-down" />
        </button>
      ) : null}
    </section>
  );
});
