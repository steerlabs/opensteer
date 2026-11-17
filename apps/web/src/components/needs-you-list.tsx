import { useEffect, useState } from "react";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { Dialog } from "./dialog.js";
import { NeedsYouRow } from "./needs-you-row.js";

export function NeedsYouList({
  client,
  onClose,
  onOpen,
}: {
  client: HostClient;
  onClose: () => void;
  onOpen: (entry: NeedsYouEntry) => void;
}) {
  const page = useHostSelector(client, (snapshot) => snapshot.needsYou);
  const summaries = useHostSelector(client, (snapshot) => snapshot.attentionSummaries);
  const count = useHostSelector(client, (snapshot) => snapshot.needsYouCount);
  const ready = useHostSelector(client, (snapshot) => snapshot.connection === "connected");
  useEffect(() => {
    if (ready && count && page === null)
      void client
        .loadEarlierNeedsYou()
        .catch((error: unknown) =>
          setFailure(error instanceof Error ? error.message : "Could not load requests."),
        );
  }, [client, count, page, ready, summaries]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  // A failed ask is answered nowhere; dismissing declines it.
  const dismiss = async (entry: Extract<NeedsYouEntry, { kind: "team-ask" }>) => {
    setDismissing(needsYouEntryKey(entry));
    setFailure(null);
    try {
      await client.decideTeamAsk({
        decision: "decline",
        requestId: entry.requestId,
        teamId: entry.teamId,
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not dismiss it.");
    } finally {
      setDismissing(null);
    }
  };
  const loadMore = async () => {
    setLoading(true);
    setFailure(null);
    try {
      await client.loadEarlierNeedsYou();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not load earlier requests.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog title="Needs you" onClose={onClose}>
      {count === 0 || page?.entries.length === 0 ? <p>Nothing needs you.</p> : null}
      <ul className="side-list" aria-label="Needs you">
        {page === null &&
          summaries?.map((entry) => (
            <li key={entry.id}>
              {entry.title}
              {entry.preview ? <p>{entry.preview}</p> : null}
            </li>
          ))}
        {page?.entries.map((entry) => (
          <NeedsYouRow
            dismissing={dismissing === needsYouEntryKey(entry)}
            entry={entry}
            key={needsYouEntryKey(entry)}
            onDismiss={() => {
              if (entry.kind === "team-ask") void dismiss(entry);
            }}
            onOpen={() => onOpen(entry)}
          />
        ))}
      </ul>
      {failure ? <p role="alert">{failure}</p> : null}
      {page?.window.hasMore ? (
        <button
          className="sidebar__more"
          type="button"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {loading ? "Loading…" : "Earlier requests"}
        </button>
      ) : null}
    </Dialog>
  );
}
