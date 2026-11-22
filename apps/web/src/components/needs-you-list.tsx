import { useEffect, useState } from "react";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { Dialog } from "./dialog.js";
import { NeedsYouRow } from "./needs-you-row.js";
import { presentFailure } from "./use-action.js";

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
    if (ready && count && page == null) void client.loadEarlierNeedsYou().catch(() => undefined);
  }, [client, count, page, ready, summaries]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loadMore = async () => {
    setLoading(true);
    setFailure(null);
    try {
      await client.loadEarlierNeedsYou();
    } catch (error) {
      setFailure(presentFailure(error, "load earlier requests"));
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
          <NeedsYouRow entry={entry} key={needsYouEntryKey(entry)} onOpen={() => onOpen(entry)} />
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
