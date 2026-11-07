import { desktopWindowForContents } from "../../app/electron-window.js";
import { app, Notification } from "electron";
import {
  DesktopBadgeCountInputSchema,
  DesktopNotificationResultSchema,
  DesktopNotificationSupportSchema,
  DesktopNotificationTargetSchema,
  DesktopNotificationTestResultSchema,
  type DesktopNotificationTestResult,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

/**
 * Notifications already shown, by Deployment and notification id. The Host
 * sends each one to every socket the person has open, one per Workspace and
 * window, and only the first copy is shown. Ids are never reused, so only the
 * most recent need remembering.
 */
const shownNotifications = new Set<string>();
const maxShownNotifications = 512;

/**
 * The notification still on screen for each conversation, by Deployment and
 * Thread. A newer one replaces it, so a conversation is one alert, not a
 * stack. Holding it also keeps Electron from collecting it before its click
 * arrives.
 */
const openNotifications = new Map<string, Notification>();
const maxOpenNotifications = 64;

export const handleGetNotificationSupport =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopNotificationSupportSchema.parse({ supported: Notification.isSupported() });
  };

/** Only the bundled main frame can ask for an alert, and only about its own Deployment's ids. */
export const handleShowNotification =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const target = DesktopNotificationTargetSchema.parse(envelope.input);
    if (!Notification.isSupported()) {
      return DesktopNotificationResultSchema.parse({ status: "unsupported" });
    }
    const shownKey = `${target.deploymentId}:${target.notificationId}`;
    if (shownNotifications.has(shownKey)) {
      return DesktopNotificationResultSchema.parse({ status: "shown" });
    }
    shownNotifications.add(shownKey);
    if (shownNotifications.size > maxShownNotifications) {
      const oldest = shownNotifications.values().next().value;
      if (oldest !== undefined) shownNotifications.delete(oldest);
    }
    const threadKey = `${target.deploymentId}:${target.threadId}`;
    const sender = event.sender;
    const notification = new Notification({ body: target.body, title: target.title });
    // A replaced notification closes too; it must not take its successor's place with it.
    const release = () => {
      if (openNotifications.get(threadKey) === notification) openNotifications.delete(threadKey);
    };
    notification.once("close", release);
    notification.once("click", () => {
      release();
      if (sender.isDestroyed()) return;
      const window = desktopWindowForContents(sender);
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      sender.send(desktopBridgeChannels.notificationActivated, target);
    });
    try {
      notification.show();
    } catch (error) {
      shownNotifications.delete(shownKey);
      throw error;
    }
    const previous = openNotifications.get(threadKey);
    openNotifications.delete(threadKey);
    openNotifications.set(threadKey, notification);
    previous?.close();
    if (openNotifications.size > maxOpenNotifications) {
      const oldest = openNotifications.entries().next().value;
      if (oldest) {
        openNotifications.delete(oldest[0]);
        oldest[1].close();
      }
    }
    return DesktopNotificationResultSchema.parse({ status: "shown" });
  };

/** Test notifications not yet settled, held so Electron cannot collect one before it answers. */
const pendingTests = new Set<Notification>();
const testSettleTimeoutMs = 15_000;

/**
 * One real notification. `sent` means the system took it for delivery, which
 * it also does for a person who turned notifications off, so it says nothing
 * about permission; `failed` is the system refusing it outright, as macOS does
 * for an app it will not schedule notifications for.
 */
export const handleTestNotification =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!Notification.isSupported()) {
      return DesktopNotificationTestResultSchema.parse({ outcome: "unsupported" });
    }
    const notification = new Notification({
      body: "You'll hear from your agents like this.",
      title: "Notifications are on",
    });
    pendingTests.add(notification);
    return new Promise<DesktopNotificationTestResult>((resolvePromise) => {
      const settle = (outcome: DesktopNotificationTestResult["outcome"]) => {
        if (!pendingTests.delete(notification)) return;
        clearTimeout(timeout);
        resolvePromise(DesktopNotificationTestResultSchema.parse({ outcome }));
      };
      const timeout = setTimeout(() => settle("failed"), testSettleTimeoutMs);
      notification.once("show", () => settle("sent"));
      notification.once("failed", () => settle("failed"));
      try {
        notification.show();
      } catch {
        settle("failed");
      }
    });
  };

export const handleOpenNotificationSettings =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.notifications.openSettings();
  };

/** The dock count on macOS, and the launcher count where a Linux desktop draws one. */
export const handleSetBadgeCount =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { count } = DesktopBadgeCountInputSchema.parse(envelope.input);
    app.setBadgeCount(count);
  };
