import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopPasswordsStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { outcomeWords, runAction } from "./use-action.js";

/** The Mac's own Passwords status, followed while mounted. */
export function useDesktopPasswordsStatus(
  bridge: Pick<OpensteerDesktopBridge, "onPasswordsStatusChanged" | "passwordsStatus">,
) {
  const [status, setStatus] = useState<DesktopPasswordsStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // A change pushed by the Passwords window is newer than any read still in flight.
  const pushed = useRef(false);
  const live = useRef(true);
  const read = useCallback(async () => {
    pushed.current = false;
    const outcome = await runAction(null, {
      label: "read Passwords",
      execute: () => bridge.passwordsStatus(),
    });
    if (!live.current) return;
    if (outcome.kind !== "confirmed") {
      setReadError(outcomeWords(outcome));
      return;
    }
    if (pushed.current) return;
    setStatus(outcome.value);
    setReadError(null);
  }, [bridge]);

  useEffect(() => {
    live.current = true;
    const stop = bridge.onPasswordsStatusChanged((next) => {
      pushed.current = true;
      setStatus(next);
      setReadError(null);
    });
    void read();
    return () => {
      live.current = false;
      stop();
    };
  }, [bridge, read]);

  return { read, readError, status };
}
