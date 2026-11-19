import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot, TranscriptEntry } from "../host/client.js";
import { useHostSelector } from "./use-host-snapshot.js";

type Transcripts = Readonly<Record<string, readonly TranscriptEntry[]>>;
const none: Transcripts = {};

/** Workers of assignments still at work, sorted: the transcripts a step could come from. */
function workingWorkers(snapshot: HostSnapshot): string {
  return Object.values(snapshot.assignments)
    .filter(({ status, currentRunId }) => currentRunId !== null && status === "open")
    .map(({ workerThread }) => workerThread.id)
    .sort()
    .join(" ");
}

/**
 * The transcripts of working assignees whose detail this client already holds
 * live, so a card can name the step a worker is taking. A worker nobody has
 * open is not subscribed for this: its card says "Working", as on main.
 */
export function useWorkerTranscripts(client: HostClient): Transcripts {
  const key = useHostSelector(client, workingWorkers);
  const ids = useMemo(() => (key ? key.split(" ") : []), [key]);
  const held = useRef<{ entries: readonly (readonly TranscriptEntry[])[]; value: Transcripts }>({
    entries: [],
    value: none,
  });
  const subscribe = useCallback(
    (listener: () => void) => {
      // A worker's transcript can be opened later, so the client's own changes are heard too.
      const releases = [
        client.subscribe(listener),
        ...ids.flatMap((id) => {
          const source = client.getThreadTranscript(id);
          return source ? [source.subscribe(listener)] : [];
        }),
      ];
      return () => releases.forEach((release) => release());
    },
    [client, ids],
  );
  const read = useCallback((): Transcripts => {
    const live = ids.flatMap((id) => {
      const view = client.getThreadTranscript(id)?.getSnapshot();
      return view?.synchronized ? [[id, view.entries] as const] : [];
    });
    const entries = live.map(([, value]) => value);
    if (
      entries.length === held.current.entries.length &&
      entries.every((value, index) => value === held.current.entries[index])
    )
      return held.current.value;
    held.current = { entries, value: live.length ? Object.fromEntries(live) : none };
    return held.current.value;
  }, [client, ids]);
  return useSyncExternalStore(subscribe, read, read);
}
