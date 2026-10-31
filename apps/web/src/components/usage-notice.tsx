import { useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { z } from "zod";
import {
  createUsageNoticeDismissals,
  usageLimitNotice,
  usageLimitNoticeText,
  type UsageLimitNotice,
  type UsageLimitNoticeInput,
  type UsageNoticeDismissals,
} from "@opensteer/client/host";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";

const dismissedKey = "opensteer.usage-notices.dismissed";
const DismissedSchema = z.array(z.string().max(512)).max(64);

let dismissals: UsageNoticeDismissals | null = null;

/** This browser profile's dismissals, shared by every composer on screen. */
function usageNoticeDismissals(): UsageNoticeDismissals {
  dismissals ??= createUsageNoticeDismissals({
    read: () => {
      const parsed = DismissedSchema.safeParse(
        JSON.parse(localStorage.getItem(dismissedKey) ?? "[]"),
      );
      return parsed.success ? parsed.data : [];
    },
    write: (keys) => localStorage.setItem(dismissedKey, JSON.stringify(keys)),
  });
  return dismissals;
}

/**
 * The quiet line under a composer whose AI has run out of plan capacity. It
 * sits outside the composer's surface so it can never tint the field, and
 * dismissing it changes nothing but whether it is shown.
 */
export function UsageNotice({
  action,
  entries,
  placements,
  returnFocusTo,
  selection,
}: {
  /** A way forward the owner can offer, such as switching account in place. */
  readonly action?: ReactNode;
  readonly entries?: UsageLimitNoticeInput["entries"];
  readonly placements: UsageLimitNoticeInput["placements"];
  /** Where the keyboard goes once the line is dismissed: the words being written. */
  readonly returnFocusTo: RefObject<HTMLTextAreaElement | null>;
  readonly selection: UsageLimitNoticeInput["selection"];
}) {
  const { snapshot } = useShell();
  const deploymentId = snapshot.deploymentId;
  const userId = snapshot.user?.id;
  const notice =
    deploymentId && userId
      ? usageLimitNotice({
          ...(entries ? { entries } : {}),
          placements,
          scope: { deploymentId, userId },
          selection,
        })
      : null;
  return <UsageNoticeLine notice={notice} action={action} returnFocusTo={returnFocusTo} />;
}

export function UsageNoticeLine({
  notice,
  action,
  returnFocusTo,
}: {
  readonly notice: UsageLimitNotice | null;
  readonly action?: ReactNode;
  readonly returnFocusTo: RefObject<HTMLTextAreaElement | null>;
}) {
  const store = usageNoticeDismissals();
  const dismissed = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (notice === null || dismissed === null || dismissed.has(notice.key)) return null;
  return (
    <div className="usage-notice" role="status">
      <span className="usage-notice__text" title={notice.accountTitle}>
        {usageLimitNoticeText(notice)}
      </span>
      {action}
      <button
        aria-label="Dismiss usage notice"
        className="usage-notice__dismiss"
        onClick={() => {
          returnFocusTo.current?.focus();
          store.dismiss(notice.key);
        }}
        title="Dismiss"
        type="button"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
