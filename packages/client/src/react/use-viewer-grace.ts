import { useEffect, useState } from "react";
import { browserViewerGraceMs } from "../host/lifecycle.js";

/**
 * Whether a view may stay a browser viewer: while the person can see it, and for
 * `browserViewerGraceMs` after they stop, so a quick look elsewhere reconnects nothing. A view
 * that starts unseen is not one. The Host client applies the same rule to the whole app being
 * hidden; this is for a view the app keeps while something else is on screen, such as a page
 * under another screen.
 */
export function useViewerGrace(seen: boolean): boolean {
  const [recent, setRecent] = useState(seen);
  useEffect(() => {
    if (seen) {
      setRecent(true);
      return;
    }
    // Unseen from the start, or the grace already over: nothing to wait for.
    if (!recent) return;
    const timer = setTimeout(() => setRecent(false), browserViewerGraceMs);
    return () => clearTimeout(timer);
  }, [recent, seen]);
  return seen || recent;
}
