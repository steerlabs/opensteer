import type { HostClient } from "@opensteer/client/host";
import { sharedDisplayStreams } from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import type { TabId } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { operationDetail } from "../client/mobile-client.js";
import { useAppForeground } from "../ui/foreground.js";
import { tabsClient } from "./tabs-host.js";

export type TabViewerState =
  | { readonly status: "activating" }
  | { readonly status: "ready"; readonly viewer: TabViewer }
  | { readonly status: "failed"; readonly error: string };

/**
 * The viewer for one tab on this screen: the Host opens or wakes it and says
 * how to show it. It asks once when the tab comes into view, and again only
 * after this phone reconnects or returns to the foreground, never on its own.
 * Only that first ask is the person's Open, so only it may arm a phone's
 * one-shot wake; an answer for a tab no longer here arms nothing.
 */
export function useTabViewer(
  hostClient: HostClient,
  tabId: TabId,
  enabled: boolean,
): { readonly state: TabViewerState; readonly retry: () => void } {
  const connected = useHostSelector(hostClient, selectConnected);
  const foreground = useAppForeground();
  const live = enabled && connected && foreground;
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{
    readonly tabId: TabId;
    readonly state: TabViewerState;
  } | null>(null);
  // The person's Open is spent by the first answer for this tab.
  const explicit = useRef<{ readonly tabId: TabId; open: boolean }>({ open: true, tabId });
  if (explicit.current.tabId !== tabId) explicit.current = { open: true, tabId };
  useEffect(() => {
    if (!live) return;
    let current = true;
    const opening = explicit.current;
    void tabsClient(hostClient)
      .activateTab(tabId)
      .then(
        (viewer) => {
          const source = phoneSource(viewer);
          if (!current) {
            if (source !== null) sharedDisplayStreams(hostClient).cancelAutoWake(source);
            return;
          }
          if (source !== null) {
            if (opening.open) sharedDisplayStreams(hostClient).armAutoWake(source);
            else sharedDisplayStreams(hostClient).cancelAutoWake(source);
          }
          opening.open = false;
          setAnswer({ state: { status: "ready", viewer }, tabId });
        },
        (error: unknown) => {
          if (current)
            setAnswer({
              state: {
                error: operationDetail(error, "This tab could not open."),
                status: "failed",
              },
              tabId,
            });
        },
      );
    return () => {
      current = false;
    };
  }, [attempt, hostClient, live, tabId]);
  // Try again and Reopen are the person's Open too.
  const retry = useCallback(() => {
    explicit.current.open = true;
    setAnswer(null);
    setAttempt((value) => value + 1);
  }, []);
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
