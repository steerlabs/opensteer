import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopPasswordsStatus, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../ui-utils.js";

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
    try {
      const next = await bridge.passwordsStatus();
      if (!live.current || pushed.current) return;
      setStatus(next);
      setReadError(null);
    } catch (reason) {
      if (live.current) setReadError(actionErrorMessage(reason));
    }
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
