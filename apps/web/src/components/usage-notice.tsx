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

const DismissedSchema = z.array(z.string().max(512)).max(64);

const dismissals = new Map<string, UsageNoticeDismissals>();

/** This browser profile's dismissals kept under one key, shared by everything on screen. */
export function browserNoticeDismissals(
  storageKey: "opensteer.usage-notices.dismissed",
): UsageNoticeDismissals {
  let store = dismissals.get(storageKey);
  if (!store) {
    store = createUsageNoticeDismissals({
      read: () => {
        const parsed = DismissedSchema.safeParse(
          JSON.parse(localStorage.getItem(storageKey) ?? "[]"),
        );
        return parsed.success ? parsed.data : [];
      },
      write: (keys) => localStorage.setItem(storageKey, JSON.stringify(keys)),
    });
    dismissals.set(storageKey, store);
  }
  return store;
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
  const store = browserNoticeDismissals("opensteer.usage-notices.dismissed");
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
