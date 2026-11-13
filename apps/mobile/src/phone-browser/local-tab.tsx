import { useLayoutEffect, useState, type ReactNode } from "react";
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
  const [failure, setFailure] = useState<unknown>(null);
  // While the page is drawn the phone's visible slot is its own, so waking it
  // takes no agent's covered slot.
  useLayoutEffect(() => {
    if (!shown) return;
    return manager.markLocalPresentation(admission.surfaceId);
  }, [shown, manager, admission.surfaceId]);
  useLayoutEffect(() => {
    setFailure(null);
    if (!held || (!liveSession && !available)) {
      setReady(null);
      return;
    }
    const kept = manager.localPresentation(deploymentId, admission.surfaceId);
    setReady((previous) => (previous?.sessionId === kept?.sessionId ? previous : null));
    // Off screen a page keeps what it has and wakes nothing.
    if (!shown) return;
    let cancelled = false;
    void (async () => {
      if (!liveSession) {
        if (!hostClient.activatePersonalTab) throw new Error("This Host cannot reopen saved tabs.");
        const activated = await hostClient.activatePersonalTab(admission.surfaceId, {
          asleep: true,
        });
        if (!activated) throw new Error("This tab could not reopen.");
      }
      if (cancelled) return;
      const current = manager.localPresentation(deploymentId, admission.surfaceId);
      if (!current) throw new Error("This tab is no longer held on this phone.");
      setReady((previous) => (previous?.sessionId === current.sessionId ? previous : current));
    })().catch((error: unknown) => {
      if (!cancelled) setFailure(error);
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
      setFailure(error);
    }
    return;
  }, [held, hostClient, ready]);
  if (failure)
    return status(failure instanceof Error ? failure.message : "This tab could not open.");
  if (!held || !ready || !feed.admitted) return status(feed.error ?? "Opening…");
  return (
    <PhoneBrowserTabHost
      style={{ flex: 1 }}
      manager={manager}
      admission={ready}
      onError={setFailure}
    />
  );
}
