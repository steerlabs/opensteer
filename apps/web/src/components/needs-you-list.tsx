import { useState } from "react";
import { useHostSelector } from "@opensteer/client/react";
import { needsYouEntryKey, type HostClient } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { Dialog } from "./dialog.js";
import { NeedsYouRow } from "./needs-you-row.js";
import { act, failureWords, presentFailure } from "./use-action.js";

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
  const [dismissing, setDismissing] = useState<string | null>(null);
  // A failed ask is answered nowhere; dismissing declines it.
  const dismiss = async (entry: Extract<NeedsYouEntry, { kind: "team-ask" }>) => {
    setDismissing(needsYouEntryKey(entry));
    setFailure(null);
    try {
      await act(
        client,
        { label: "dismiss this", done: "dismissed", happened: "this was dismissed" },
        () =>
          client.decideTeamAsk({
            decision: "decline",
            requestId: entry.requestId,
            teamId: entry.teamId,
          }),
      );
    } catch (error) {
      setFailure(failureWords(error) ?? "Could not dismiss it.");
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
      setFailure(presentFailure(error, "load earlier requests"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog title="Needs you" onClose={onClose}>
      {page?.entries.length === 0 ? <p>Nothing needs you.</p> : null}
      <ul className="side-list" aria-label="Needs you">
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
