import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { MobileNotifications } from "../notifications/mobile-notifications.js";
import type { PushRegistrationState } from "../notifications/push-registration.js";

const MobileNotificationsContext = createContext<MobileNotifications | null>(null);

/**
 * Notifications, reached from the two screens that have anything to do with
 * them: Settings, which shows and changes the registration, and Thread, which
 * reports what is on screen so an alert about it is not also a banner over it.
 */
export function MobileNotificationsProvider(props: {
  readonly children: ReactNode;
  readonly notifications: MobileNotifications;
}): ReactNode {
  return (
    <MobileNotificationsContext.Provider value={props.notifications}>
      {props.children}
    </MobileNotificationsContext.Provider>
  );
}

export function useMobileNotifications(): MobileNotifications {
  const notifications = useContext(MobileNotificationsContext);
  if (notifications === null) {
    throw new Error("This screen was rendered outside the Opensteer app root.");
  }
  return notifications;
}

export function usePushRegistration(): PushRegistrationState {
  const { registration } = useMobileNotifications();
  return useSyncExternalStore(
    registration.subscribe,
    registration.getSnapshot,
    registration.getSnapshot,
  );
}
