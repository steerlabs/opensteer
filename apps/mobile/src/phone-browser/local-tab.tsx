import { classifyClientFailure } from "@opensteer/client/connections";
import { useClientConnection } from "@opensteer/client/react";
import { TabIdSchema } from "@opensteer/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@opensteer/client/host";
import { useBrowserFeedState } from "../browser/browser-stream.js";
import type { PagePresence } from "../ui/page-presence.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import { PhoneBrowserTabHost } from "./tab-host.js";

/**
 * This phone's own tab, drawn by its own browser once the Host admits this
 * screen's viewer. The viewer and the page stay for as long as the screen is on
 * its stack in the foreground: a sheet or a screen over it only takes input
 * away, and the native host parks and returns the page as it leaves and
 * rejoins the window, so showing it again needs nothing of the Host.
 */
export function LocalPhoneTab(props: {
  readonly presence: PagePresence;
  readonly available: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly manager: PhoneBrowserManager;
  readonly admission: PhonePresentationAdmission;
  readonly liveSession: boolean;
  readonly status: (message: string) => ReactNode;
}) {
  const { available, deploymentId, hostClient, manager, admission, liveSession, status } = props;
  const { held, shown } = props.presence;
  const [ready, setReady] = useState<PhonePresentationAdmission | null>(null);
  const feed = useBrowserFeedState(
    hostClient,
    ready?.sessionId ?? admission.sessionId,
    admission.surfaceId,
  );
  // Only a failure of this tab itself; a lost connection is the shell's to say,
  // and recovery asks again.
  const [failed, setFailed] = useState(false);
  const fail = useCallback((error: unknown): void => {
    if (ownsFailure(error)) setFailed(true);
  }, []);
  // The connection revision an activation was lost under; the next one asks again.
  const lost = useRef<number | null>(null);
  const [retry, setRetry] = useState(0);
  const { readyRevision } = useClientConnection(hostClient.connection);
  useEffect(() => {
    if (lost.current === null || lost.current === readyRevision) return;
    lost.current = null;
    setRetry((value) => value + 1);
  }, [readyRevision]);
  // While the page is drawn the phone's visible slot is its own, so waking it
  // takes no agent's covered slot.
  useLayoutEffect(() => {
    if (!shown) return;
    return manager.markLocalPresentation(admission.surfaceId);
  }, [shown, manager, admission.surfaceId]);
  useLayoutEffect(() => {
    setFailed(false);
    if (!held || (!liveSession && !available)) {
      setReady(null);
      return;
    }
    const kept = manager.localPresentation(deploymentId, admission.surfaceId);
    setReady((previous) => (previous?.sessionId === kept?.sessionId ? previous : null));
    // Off screen a page keeps what it has and wakes nothing.
    if (!shown) return;
    let cancelled = false;
    const started = hostClient.connection.getSnapshot().readyRevision;
    void (async () => {
      if (!liveSession) {
        // The Host restores the saved page here and binds this phone's view of it.
        await hostClient.activateTab(TabIdSchema.parse(admission.surfaceId));
      }
      if (cancelled) return;
      const current = manager.localPresentation(deploymentId, admission.surfaceId);
      if (!current) throw new Error("This tab is no longer held on this phone.");
      setReady((previous) => (previous?.sessionId === current.sessionId ? previous : current));
    })().catch((error: unknown) => {
      if (cancelled) return;
      if (ownsFailure(error)) return setFailed(true);
      if (hostClient.connection.getSnapshot().readyRevision === started) lost.current = started;
      else setRetry((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [
    available,
    deploymentId,
    held,
    hostClient,
    manager,
    admission.sessionId,
    admission.surfaceId,
    liveSession,
    retry,
    shown,
  ]);
  useLayoutEffect(() => {
    if (!held || !ready) return;
    try {
      return hostClient.retainBrowserViewer(ready.sessionId, ready.surfaceId, {
        picture: false,
        asleep: true,
      });
    } catch (error) {
      fail(error);
    }
    return;
  }, [fail, held, hostClient, ready]);
  // Said as a fact about the tab; why it couldn't open is the connection's to say.
  if (failed) return status("This tab could not open.");
  if (!held || !ready || !feed.admitted) return status(feed.error ?? "Opening…");
  return (
    <PhoneBrowserTabHost
      style={{ flex: 1 }}
      manager={manager}
      admission={ready}
      onError={fail}
    />
  );
}

function ownsFailure(error: unknown): boolean {
  const { kind } = classifyClientFailure(error);
  return kind !== "transport" && kind !== "session" && kind !== "cancelled" && kind !== "service";
}
