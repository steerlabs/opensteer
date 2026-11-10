import { useEffect, useState, type ReactNode } from "react";
import type { HostClient } from "@opensteer/client/host";
import { useBrowserFeedState } from "../browser/browser-stream.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import { PhoneBrowserTabHost } from "./tab-host.js";

export function LocalPhoneTab(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly manager: PhoneBrowserManager;
  readonly admission: PhonePresentationAdmission;
  readonly status: (message: string) => ReactNode;
}) {
  const { active, hostClient, manager, admission, status } = props;
  const feed = useBrowserFeedState(hostClient, admission.sessionId, admission.surfaceId);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (!active) return;
    try {
      return hostClient.retainBrowserViewer(admission.sessionId, admission.surfaceId, {
        picture: false,
      });
    } catch (error) {
      setFailure(error);
      return;
    }
  }, [active, hostClient, admission.sessionId, admission.surfaceId]);
  if (failure)
    return status(failure instanceof Error ? failure.message : "This tab could not open.");
  if (!active || !feed.admitted) return status(feed.error ?? "Opening…");
  return (
    <PhoneBrowserTabHost
      style={{ flex: 1 }}
      manager={manager}
      admission={admission}
      onError={setFailure}
    />
  );
}
