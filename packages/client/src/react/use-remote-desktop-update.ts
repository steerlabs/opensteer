import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopUpdates } from "../connections/desktop-updates-contract.js";
import {
  DesktopUpdateController,
  emptyDesktopUpdateSnapshot,
} from "../settings/desktop-update-controller.js";
import { desktopUpdateView, type DesktopUpdateAction } from "../settings/desktop-update-view.js";

const noSubscription = () => () => undefined;
const emptySnapshot = () => emptyDesktopUpdateSnapshot;

/** Reads nothing until `visible`, and stops reading as soon as it is not. */
export function useRemoteDesktopUpdate(
  updates: DesktopUpdates | null,
  computerName: string,
  visible: boolean,
  signIn?: () => Promise<unknown>,
) {
  const controller = useMemo(
    () => (updates === null ? null : new DesktopUpdateController(updates)),
    [updates],
  );
  const read = controller?.getSnapshot ?? emptySnapshot;
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscription, read, read);
  useEffect(() => (visible ? controller?.show() : undefined), [controller, visible]);
  return {
    view: desktopUpdateView({ ...snapshot, computerName, now: Date.now() }),
    run: (action: DesktopUpdateAction) => {
      if (action.kind === "retry" && snapshot.failure === "unauthorized" && signIn) {
        void signIn()
          .then(() => controller?.retry())
          .catch(() => undefined);
        return;
      }
      if (action.kind === "retry") controller?.retry();
      else controller?.request(action.intent);
    },
  };
}
