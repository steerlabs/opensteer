import { presentActionFailure } from "@opensteer/client/feedback";
import type { HostClient } from "@opensteer/client/host";
import { sharedDisplayStreams } from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import type { TabId } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import { useCallback, useEffect, useState, type RefObject } from "react";
import { useAppForeground } from "../ui/foreground.js";

export type TabViewerState =
  | { readonly status: "activating" }
  | { readonly status: "ready"; readonly viewer: TabViewer }
  | { readonly status: "failed"; readonly error: string };

/**
 * The person's Open of one tab: arriving at it, Try again or Reopen.
 * It lives as long as the route, so a viewer remounting as its tab comes and
 * goes never renews it; only the tab's next ask may spend it.
 */
export type OpenIntent = RefObject<TabId | null>;

/**
 * The viewer for one tab on this screen: the Host opens or wakes it and says
 * how to show it. It asks once when the tab comes into view, and again only
 * after this phone reconnects or returns to the foreground, never on its own.
 * Only an ask that spends the person's Open may arm a phone's one-shot wake;
 * an answer for a tab no longer here arms nothing.
 */
export function useTabViewer(
  hostClient: HostClient,
  tabId: TabId,
  enabled: boolean,
  intent: OpenIntent,
): { readonly state: TabViewerState; readonly retry: () => void } {
  const connected = useHostSelector(hostClient, selectConnected);
  const foreground = useAppForeground();
  const live = enabled && connected && foreground;
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{
    readonly tabId: TabId;
    readonly state: TabViewerState;
  } | null>(null);
  useEffect(() => {
    if (!live) return;
    let current = true;
    const wake = intent.current === tabId;
    if (wake) intent.current = null;
    void hostClient.activateTab(tabId, { wake }).then(
      (viewer) => {
        // An answer for a tab no longer here wakes nothing.
        const source = phoneSource(viewer);
        if (!current) {
          if (source !== null && wake) sharedDisplayStreams(hostClient).cancelAutoWake(source);
          return;
        }
        setAnswer({ state: { status: "ready", viewer }, tabId });
      },
      (error: unknown) => {
        if (current)
          setAnswer({
            state: {
              error: presentActionFailure(error, "This tab could not open."),
              status: "failed",
            },
            tabId,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, hostClient, intent, live, tabId]);
  // Try again and Reopen are the person's Open too.
  const retry = useCallback(() => {
    intent.current = tabId;
    setAnswer(null);
    setAttempt((value) => value + 1);
  }, [intent, tabId]);
  // Asking again keeps what is shown; a tab is never shown with another's viewer.
  return {
    retry,
    state: answer?.tabId === tabId ? answer.state : { status: "activating" },
  };
}

const selectConnected = (snapshot: { readonly connection: string }) =>
  snapshot.connection === "connected";

function phoneSource(viewer: TabViewer) {
  return viewer.kind === "phone"
    ? {
        generation: viewer.view.generation,
        kind: "owner-view" as const,
        viewId: viewer.view.viewId,
      }
    : null;
}
