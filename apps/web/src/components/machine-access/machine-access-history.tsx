import type { ShellSessionHistoryEntry } from "@opensteer/protocol";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../../app-model.js";
import { formatRelativeTime } from "@opensteer/client/host";
import type { HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import {
  machineAccessAuditLabel,
  machineAccessEndReasonLabel,
  machineAccessSessionBytes,
  machineAccessSessionLabel,
} from "./machine-access-editor.js";

const historyPageSize = 20;

interface HistoryPage {
  readonly nextCursor: string | null;
  readonly sessions: readonly ShellSessionHistoryEntry[];
}

/**
 * Past sessions and the requests they made.
 *
 * Nothing is fetched until somebody asks: a computer's history is the one part
 * of this page that costs a durable read, and most visits to the Computers
 * page are about something else entirely.
 */
export function MachineAccessHistory({
  client,
  machineId,
  machineRevision,
}: {
  readonly client: HostClient;
  readonly machineId: string;
  readonly machineRevision: number;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await client.loadMachineAccessHistory({
          ...(before === undefined ? {} : { before }),
          limit: historyPageSize,
          runnerId: machineId,
        });
        setPage((current) =>
          before !== undefined && current
            ? { nextCursor: next.nextCursor, sessions: [...current.sessions, ...next.sessions] }
            : { nextCursor: next.nextCursor, sessions: [...next.sessions] },
        );
      } catch (reason) {
        setError(actionErrorMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [client, machineId],
  );

  // Reading the list again on every revision is what keeps a session that just
  // ended from staying "open" in a history somebody is looking at.
  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, machineRevision, open]);

  const headingId = `machine-access-history-${machineId}`;
  return (
    <div className="machine-access__history">
      <button
        aria-controls={headingId}
        aria-expanded={open}
        className="btn btn--ghost btn--small machine-access__history-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon
          className={open ? "machine-access__chevron is-open" : "machine-access__chevron"}
          name="chevron-right"
        />
        History
      </button>
      {open ? (
        <div className="machine-access__history-list" id={headingId}>
          {page === null ? (
            <p className="machine-access__empty">{busy ? "Loading…" : "Nothing to show yet."}</p>
          ) : page.sessions.length === 0 ? (
            <p className="machine-access__empty">No computer has reached this one yet.</p>
          ) : (
            page.sessions.map((session) => (
              <HistorySession
                expanded={expanded.includes(session.id)}
                key={session.id}
                onToggle={() =>
                  setExpanded((current) =>
                    current.includes(session.id)
                      ? current.filter((id) => id !== session.id)
                      : [...current, session.id],
                  )
                }
                session={session}
              />
            ))
          )}
          {page?.nextCursor ? (
            <div className="machine-access__history-more">
              <button
                className="btn btn--small"
                disabled={busy}
                onClick={() => void load(page.nextCursor ?? undefined)}
                type="button"
              >
                {busy ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HistorySession({
  expanded,
  onToggle,
  session,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly session: ShellSessionHistoryEntry;
}) {
  return (
    <div className="machine-access__history-session">
      <button
        aria-expanded={expanded}
        className="machine-access__history-summary"
        onClick={onToggle}
        type="button"
      >
        <Icon
          className={expanded ? "machine-access__chevron is-open" : "machine-access__chevron"}
          name="chevron-right"
        />
        <span className="machine-access__history-body">
          <span className="machine-access__history-title">
            {machineAccessSessionLabel(session)}
          </span>
          <span className="machine-access__history-detail">
            Started{" "}
            <time dateTime={session.startedAt}>{formatRelativeTime(session.startedAt)}</time>
            {session.endedAt === null ? (
              <> · still open</>
            ) : (
              <>
                {" · ended "}
                <time dateTime={session.endedAt}>{formatRelativeTime(session.endedAt)}</time>
                {session.endReason ? `, ${machineAccessEndReasonLabel(session.endReason)}` : ""}
              </>
            )}
            {" · "}
            {formatBytes(machineAccessSessionBytes(session))}
          </span>
        </span>
      </button>
      {expanded ? (
        <ul className="machine-access__audit">
          {session.events.length === 0 ? (
            <li className="machine-access__empty">No requests were recorded.</li>
          ) : (
            session.events.map((event, index) => (
              <li key={index}>{machineAccessAuditLabel(event)}</li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
