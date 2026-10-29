import {
  androidNotificationChannelId,
  maximumNotificationDevicesPerAccount,
} from "@opensteer/core";
import { DeviceLimitReachedError } from "@opensteer/client/connections";
import {
  dismissThreadNotifications,
  notificationDestination,
  type NotificationData,
  type NotificationDestination,
  type VisibleThread,
} from "./notification-routing.js";
import type {
  NotificationDeviceRegistry,
  PushPermissions,
  PushTokenSource,
} from "./push-registration.js";

/**
 * Everything notifications need from the phone, behind one port.
 *
 * It is grouped the way `MobileHostPort` groups the Host: permission, token,
 * registry and presentation are one capability, so mock mode replaces them as
 * one object rather than by threading a development flag through the app.
 */
export interface MobileNotificationPort {
  readonly permissions: PushPermissions;
  readonly registry: NotificationDeviceRegistry;
  /** The Account subject whose bearer the registry will use, or null. */
  readonly signedInSubject: () => Promise<string | null>;
  readonly tokens: PushTokenSource;
  /** Clears what the system is still showing for a Thread that was opened. */
  clearThread(visible: VisibleThread): Promise<void>;
  /** Every tap, including the one that cold-started this process. */
  onOpened(listener: (destination: NotificationDestination) => void): () => void;
  /**
   * Whatever the platform needs in place before a notification can arrive. On
   * Android that is the channel: the operating system takes importance, sound
   * and the entry a person sees in its own settings from the channel, and a
   * message naming one that does not exist is shown under a channel
   * `expo-notifications` invents and calls "Miscellaneous". iOS has no such
   * notion and this does nothing there.
   */
  prepare(): Promise<void>;
  /** Installs the rule deciding whether an arrival interrupts the foreground. */
  presentWhen(decide: (payload: NotificationData) => boolean): void;
}

/** One notification as the operating system delivered it. */
interface ExpoNotification {
  readonly request: {
    readonly content: { readonly data?: unknown };
    readonly identifier: string;
  };
}

interface ExpoNotificationResponse {
  readonly actionIdentifier: string;
  readonly notification: ExpoNotification;
}

interface ExpoPermissionResponse {
  readonly canAskAgain: boolean;
  readonly granted: boolean;
}

/** `expo-notifications`, as this port needs it. */
export interface ExpoNotificationsLike {
  /** Android's importance ladder; only the ordinary rung is used. */
  readonly AndroidImportance: { readonly DEFAULT: number };
  readonly DEFAULT_ACTION_IDENTIFIER: string;
  addNotificationResponseReceivedListener(listener: (response: ExpoNotificationResponse) => void): {
    remove(): void;
  };
  addPushTokenListener(listener: (token: { readonly data: unknown }) => void): {
    remove(): void;
  };
  clearLastNotificationResponse(): void;
  dismissNotificationAsync(identifier: string): Promise<void>;
  getDevicePushTokenAsync(): Promise<{ readonly data: unknown; readonly type: string }>;
  getLastNotificationResponse(): ExpoNotificationResponse | null;
  getPermissionsAsync(): Promise<ExpoPermissionResponse>;
  getPresentedNotificationsAsync(): Promise<readonly ExpoNotification[]>;
  requestPermissionsAsync(request?: {
    readonly ios?: { readonly allowAlert?: boolean; readonly allowSound?: boolean };
  }): Promise<ExpoPermissionResponse>;
  setNotificationChannelAsync(
    channelId: string,
    channel: {
      readonly importance: number;
      readonly lightColor: string;
      readonly name: string;
    },
  ): Promise<unknown>;
  setNotificationHandler(handler: {
    handleNotification(notification: ExpoNotification): Promise<{
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
      shouldShowBanner: boolean;
      shouldShowList: boolean;
    }>;
  }): void;
}

/** What the operating system permits, which even mock mode does not fake. */
export function createExpoPushPermissions(notifications: ExpoNotificationsLike): PushPermissions {
  return {
    current: async () => permissionStateOf(await notifications.getPermissionsAsync()),
    request: async () =>
      permissionStateOf(
        // The badge is never set by this app — four fixed phrases carry no
        // count — so it is not asked for.
        await notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true },
        }),
      ),
  };
}

export interface ExpoApplicationLike {
  readonly ApplicationReleaseType: { readonly APP_STORE: number };
  getIosPushNotificationServiceEnvironmentAsync(): Promise<"development" | "production" | null>;
  getIosApplicationReleaseTypeAsync(): Promise<number>;
}

export function createExpoNotificationPort(options: {
  readonly application: ExpoApplicationLike;
  /**
   * Whether this Android build was given the Firebase configuration an FCM
   * token comes from. Always true on iOS, whose token needs nothing but the
   * entitlement. `app.config.ts` decides it from
   * `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE` and carries the answer in `extra`.
   */
  readonly androidPushConfigured: boolean;
  readonly brandColor: string;
  readonly channelName: string;
  readonly notifications: ExpoNotificationsLike;
  readonly platform: "android" | "ios";
  readonly registry: NotificationDeviceRegistry;
  readonly signedInSubject: () => Promise<string | null>;
}): MobileNotificationPort {
  const { notifications, registry } = options;
  const pushCredentials = options.platform !== "android" || options.androidPushConfigured;
  return {
    permissions: createExpoPushPermissions(notifications),
    registry,
    signedInSubject: options.signedInSubject,
    tokens: {
      apsEnvironment: async () => {
        const environment =
          await options.application.getIosPushNotificationServiceEnvironmentAsync();
        if (environment !== null) return environment;
        if (
          (await options.application.getIosApplicationReleaseTypeAsync()) ===
          options.application.ApplicationReleaseType.APP_STORE
        )
          return "production";
        throw new Error("This build has no push entitlement");
      },
      current: async () => {
        // Asked before the operating system is, because the answer is already
        // known: a build with no Firebase configuration has no sender to mint
        // a token against, and the registration says so in words a person can
        // act on rather than relaying whatever Firebase throws.
        if (!pushCredentials) {
          throw new Error("This build was made without Android push credentials.");
        }
        const token = await notifications.getDevicePushTokenAsync();
        if (typeof token.data !== "string") {
          throw new Error("This phone did not return a push token the Account could send to.");
        }
        return token.data;
      },
      subscribe: (listener) => {
        const subscription = notifications.addPushTokenListener((token) => {
          if (typeof token.data === "string") listener(token.data);
        });
        return () => subscription.remove();
      },
    },

    async clearThread(visible): Promise<void> {
      await dismissThreadNotifications({
        dismiss: (identifier) => notifications.dismissNotificationAsync(identifier),
        presented: async () =>
          (await notifications.getPresentedNotificationsAsync()).map((notification) => ({
            identifier: notification.request.identifier,
            payload: { data: notification.request.content.data },
          })),
        visible,
      });
    },

    onOpened(listener): () => void {
      // The same dedupe `useLastNotificationResponse` performs: a cold start
      // has the response waiting *and* delivers it to the listener, and the
      // person tapped once.
      let handledIdentifier: string | null = null;
      const accept = (response: ExpoNotificationResponse): void => {
        // Swiping a notification away arrives here too, under the system's own
        // action identifier. Only a tap asks to be taken somewhere.
        if (response.actionIdentifier !== notifications.DEFAULT_ACTION_IDENTIFIER) return;
        if (response.notification.request.identifier === handledIdentifier) return;
        handledIdentifier = response.notification.request.identifier;
        const destination = notificationDestination({
          data: response.notification.request.content.data,
        });
        if (destination !== null) listener(destination);
      };
      const pending = notifications.getLastNotificationResponse();
      if (pending !== null) {
        accept(pending);
        // Read once: the next launch must not reopen a Thread from a tap that
        // has already been answered.
        notifications.clearLastNotificationResponse();
      }
      const subscription = notifications.addNotificationResponseReceivedListener(accept);
      return () => subscription.remove();
    },

    async prepare(): Promise<void> {
      if (options.platform !== "android") return;
      await notifications.setNotificationChannelAsync(androidNotificationChannelId, {
        importance: notifications.AndroidImportance.DEFAULT,
        lightColor: options.brandColor,
        name: options.channelName,
      });
    },

    presentWhen(decide): void {
      notifications.setNotificationHandler({
        handleNotification: async (notification) => {
          const present = decide({ data: notification.request.content.data });
          return {
            shouldPlaySound: present,
            shouldSetBadge: false,
            shouldShowBanner: present,
            shouldShowList: present,
          };
        },
      });
    },
  };
}

function permissionStateOf(response: ExpoPermissionResponse) {
  return { canAskAgain: response.canAskAgain, granted: response.granted };
}

/**
 * Development entry: the Account and the push provider are replaced, and the
 * operating system is not.
 *
 * It exists for the same reason `createMockHostPort` does — every state of the
 * Notifications settings has to be reachable on a simulator, which can neither
 * mint a push token nor sign in to an Account. The permission is the one thing
 * a simulator answers truthfully, so it is passed through: granting and
 * refusing it are two of the states this is here to show. Nothing outside the
 * app root knows any of this exists.
 */
export function createMockNotificationPort(options: {
  readonly permissions: PushPermissions;
}): MobileNotificationPort {
  const devices = new Map<string, unknown>();
  // The mock Account starts full, so the refusal a real Account gives the
  // seventeenth phone is the first thing the Notifications settings shows; the
  // slot is freed by the refusal, so "Try again" then registers and the two
  // preference switches are reachable in the same run. Both states matter and a
  // simulator can reach neither on its own.
  let occupied = maximumNotificationDevicesPerAccount;
  return {
    permissions: options.permissions,
    registry: {
      register: async (installationId, request) => {
        if (occupied >= maximumNotificationDevicesPerAccount) {
          occupied -= 1;
          throw new DeviceLimitReachedError();
        }
        devices.set(installationId, request);
        return request;
      },
      unregister: async (installationId) => devices.delete(installationId),
    },
    // Mock mode has no Account to sign in to, and the point of it is that every
    // screen can be exercised without one.
    signedInSubject: async () => "acct_00000000-0000-4000-8000-000000000000",
    tokens: {
      apsEnvironment: async () => "development",
      current: async () => "f".repeat(64),
      subscribe: () => () => undefined,
    },
    clearThread: async () => undefined,
    onOpened: () => () => undefined,
    // The operating system is not mocked, and a simulator is not sent to.
    prepare: async () => undefined,
    presentWhen: () => undefined,
  };
}
