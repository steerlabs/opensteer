import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageEdit, MessageRevisionView } from "@opensteer/core";
import { formatClockTime, messageRevisionRows, type HostClient } from "@opensteer/client/host";
import { Popover } from "./popover.js";

/**
 * "Edited", which opens the message's versions, newest first: while it waits
 * and after a Run took it, since the version the agent received is the last.
 */
export function EditedMark({
  client,
  edit,
  label = "Edited",
  messageId,
  threadId,
  viewerUserId,
}: {
  readonly client: HostClient;
  readonly edit: MessageEdit;
  readonly label?: string;
  readonly messageId: string;
  readonly threadId: string;
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
        title={`Edited ${new Date(edit.editedAt).toLocaleString()}`}
        type="button"
      >
        {label}
      </button>
      {anchor ? (
        <RevisionHistory
          anchor={anchor}
          client={client}
          messageId={messageId}
          onClose={() => setAnchor(null)}
          threadId={threadId}
          viewerUserId={viewerUserId}
        />
      ) : null}
    </>
  );
}

function RevisionHistory({
  anchor,
  client,
  messageId,
  onClose,
  threadId,
  viewerUserId,
}: {
  readonly anchor: HTMLElement;
  readonly client: HostClient;
  readonly messageId: string;
  readonly onClose: () => void;
  readonly threadId: string;
  readonly viewerUserId: string | null;
}) {
  const [revisions, setRevisions] = useState<readonly MessageRevisionView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
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
