import { useEffect, useState } from "react";
import { liveTurnLine, type LiveTurn, type LiveTurnLine } from "../host/agent-activity-model.js";

/**
 * The live line's words, kept current: redrawn each second while this reader
 * is in touch with the Host, and held still while it is not. A change to the
 * Run that this reader sees counts as activity from the moment it sees it,
 * since an entry does not always say when it changed.
 */
export function useLiveTurnLine(live: LiveTurn, connected: boolean): LiveTurnLine {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!connected) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connected]);
  // Seen at mount, the Run's state is not news: only a change after it is. Kept
  // as state, set while rendering, so a render React discards records nothing.
  const [seen, setSeen] = useState<{ readonly signature: string; readonly at: number | null }>(
    () => ({ signature: live.signature, at: null }),
  );
  if (seen.signature !== live.signature) setSeen({ signature: live.signature, at: Date.now() });
  return liveTurnLine(live, Math.max(now, seen.at ?? now), {
    connected,
    observedAt: seen.at,
  });
}
