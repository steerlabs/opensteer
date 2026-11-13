import { useLayoutEffect, useState, type ReactNode } from "react";
import type { HostClient } from "@opensteer/client/host";
import { useBrowserTabAwake } from "@opensteer/client/react";
import { useBrowserFeedState } from "../browser/browser-stream.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import { PhoneBrowserTabHost } from "./tab-host.js";

export function LocalPhoneTab(props: {
  readonly active: boolean;
  readonly available: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly manager: PhoneBrowserManager;
  readonly admission: PhonePresentationAdmission;
  readonly liveSession: boolean;
  readonly status: (message: string) => ReactNode;
}) {
  const { active, available, deploymentId, hostClient, manager, admission, liveSession, status } =
    props;
  const [ready, setReady] = useState<PhonePresentationAdmission | null>(null);
  const feed = useBrowserFeedState(
    hostClient,
    ready?.sessionId ?? admission.sessionId,
    admission.surfaceId,
  );
  // The phone opens and leaves tabs asleep until shown, and no viewer is admitted to a sleeping
  // tab: only the Host's activation wakes it, even in a session that is still live.
  const awake = useBrowserTabAwake(hostClient, admission.sessionId, admission.surfaceId);
  const live = liveSession && awake;
  const [failure, setFailure] = useState<unknown>(null);
  useLayoutEffect(() => {
    if (!active) return;
    return manager.markLocalPresentation(admission.surfaceId);
  }, [active, manager, admission.surfaceId]);
  useLayoutEffect(() => {
    setFailure(null);
    if (!active || (!live && !available)) {
      setReady(null);
      return;
    }
    const held = manager.localPresentation(deploymentId, admission.surfaceId);
    setReady((previous) => (previous?.sessionId === held?.sessionId ? previous : null));
    let cancelled = false;
    void (async () => {
      if (!live) {
        if (!hostClient.activatePersonalTab) throw new Error("This Host cannot reopen saved tabs.");
        const activated = await hostClient.activatePersonalTab(admission.surfaceId);
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
    active,
    available,
    deploymentId,
    hostClient,
    manager,
    admission.sessionId,
    admission.surfaceId,
    live,
  ]);
  useLayoutEffect(() => {
    if (!active || !ready) return;
    try {
      return hostClient.retainBrowserViewer(ready.sessionId, ready.surfaceId, { picture: false });
    } catch (error) {
      setFailure(error);
    }
    return;
  }, [active, hostClient, ready]);
  if (failure)
    return status(failure instanceof Error ? failure.message : "This tab could not open.");
  if (!active || !ready || !feed.admitted) return status(feed.error ?? "Opening…");
  return (
    <PhoneBrowserTabHost
      style={{ flex: 1 }}
      manager={manager}
      admission={ready}
      onError={setFailure}
    />
  );
}
