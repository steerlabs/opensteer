import { useState } from "react";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { Dialog } from "./dialog.js";

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
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
      {page?.entries.length === 0 ? <p>Nothing needs you.</p> : null}
      {page?.entries.map((entry) => (
        <p key={needsYouEntryKey(entry)}>
          <button type="button" onClick={() => onOpen(entry)}>
            {entry.kind === "team-ask"
              ? `${entry.presentation.asker.displayName}${entry.presentation.asker.actor === "agent" ? "'s agent" : ""} · #${entry.presentation.audience.channelName}`
              : entry.title}
          </button>
        </p>
      ))}
      {failure ? <p role="alert">{failure}</p> : null}
      {page?.window.hasMore ? (
        <button type="button" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : "Earlier requests"}
        </button>
      ) : null}
    </Dialog>
  );
}
