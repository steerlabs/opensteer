import {
  compactionHintRevision,
  compactionOfferVisible,
  scheduleCompactionReveal,
} from "../host/idle-compaction.js";
import type { UsageNoticeDismissals } from "../host/usage-notice.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  defaultIdleCompactionPolicy,
  type CompactionReturnHint,
  type IdleCompactionPolicy,
} from "@opensteer/core";
import type { HostClient } from "../host/client.js";

export function useCompactionOffer(
  hint: CompactionReturnHint | null | undefined,
  scope: string,
  dismissals: UsageNoticeDismissals,
) {
  const revision = compactionHintRevision(hint, scope);
  const keys = useSyncExternalStore(dismissals.subscribe, dismissals.getSnapshot, () => null);
  const hidden = keys === null || keys.has(revision);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    return scheduleCompactionReveal(hint, hidden, setNow);
  }, [hint?.eligible, hint?.eligibleAt, hidden, revision]);
  return {
    visible: compactionOfferVisible(hint, hidden, now),
    dismiss: () => dismissals.dismiss(revision),
  };
}
export function useIdleCompactionSettings(client: HostClient | null) {
  const readPolicy = () =>
    client?.getSnapshot().personalSettings?.idleCompactionPolicy ?? defaultIdleCompactionPolicy;
  const policy = useSyncExternalStore(
    client?.subscribe ?? (() => () => {}),
    readPolicy,
    readPolicy,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    policy,
    pending,
    error,
    save: (next: IdleCompactionPolicy) => {
      if (!client || pending) return;
      setPending(true);
      setError(null);
      void client
        .setIdleCompactionPolicy(next)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not save setting."))
        .finally(() => setPending(false));
    },
  };
}
export type IdleCompactionSettings = ReturnType<typeof useIdleCompactionSettings>;
