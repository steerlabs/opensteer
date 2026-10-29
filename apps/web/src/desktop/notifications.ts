import {
  DesktopNotificationTargetSchema,
  type DesktopNotificationTarget,
} from "@opensteer/protocol/desktop";
import { desktopBridge } from "./desktop-bridge.js";

export type NotificationAvailability = "desktop" | "granted" | "prompt" | "denied" | "unsupported";

/** Browser permission is requested only by the explicit opt-in action. */
export function notificationAvailability(): NotificationAvailability {
  if (desktopBridge()) return "desktop";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission === "default" ? "prompt" : Notification.permission;
}

/** Desktop support is known only to the main process, not the web renderer. */
export async function resolveNotificationAvailability(): Promise<NotificationAvailability> {
  const bridge = desktopBridge();
  if (!bridge) return notificationAvailability();
  const support = await bridge.getNotificationSupport();
  return support.supported ? "desktop" : "unsupported";
}

export async function requestNotificationPermission(): Promise<NotificationAvailability> {
  const availability = notificationAvailability();
  if (availability !== "prompt") return availability;
  const permission = await Notification.requestPermission();
  return permission === "default" ? "prompt" : permission;
}

const browserActivationListeners = new Set<(target: DesktopNotificationTarget) => void>();

/** A click names the notification's destination; navigating is the authenticated app's job. */
export function onNotificationActivated(
  listener: (target: DesktopNotificationTarget) => void,
): () => void {
  const bridge = desktopBridge();
  if (bridge) return bridge.onNotificationActivated(listener);
  browserActivationListeners.add(listener);
  return () => browserActivationListeners.delete(listener);
}

/** This tab's notification still on screen for each conversation. */
const shownByThread = new Map<string, Notification>();

export async function showNotification(
  input: DesktopNotificationTarget,
): Promise<"shown" | "unavailable"> {
  const target = DesktopNotificationTargetSchema.parse(input);
  const bridge = desktopBridge();
  if (bridge) {
    const result = await bridge.showNotification(target);
    return result.status === "shown" ? "shown" : "unavailable";
  }
  if (notificationAvailability() !== "granted") return "unavailable";
  const key = `${target.deploymentId}:${target.notificationId}`;
  if (!(await claimedByThisTab(key))) return "shown";
  // Each notification is its own, so every browser alerts for it; this tab's
  // older one about the same conversation is closed so they do not stack.
  const threadKey = `${target.deploymentId}:${target.threadId}`;
  shownByThread.get(threadKey)?.close();
  const notification = new Notification(target.title, { body: target.body, tag: key });
  shownByThread.set(threadKey, notification);
  notification.onclose = () => {
    if (shownByThread.get(threadKey) === notification) shownByThread.delete(threadKey);
  };
  notification.onclick = () => {
    window.focus();
    for (const listener of browserActivationListeners) listener(target);
    notification.close();
  };
  return "shown";
}

const claimsKey = "opensteer:notifications:shown";
const maxClaims = 200;

/**
 * Every open tab receives the same notification, and one shows it: the first
 * to record its id under a lock this origin's tabs share. A browser without
 * the Locks API, or without storage, shows it from each tab rather than lose it.
 */
async function claimedByThisTab(key: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return true;
  return navigator.locks.request("opensteer-notifications", () => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(claimsKey) ?? "[]");
      const claims = Array.isArray(stored) ? stored.filter((item) => typeof item === "string") : [];
      if (claims.includes(key)) return false;
      localStorage.setItem(claimsKey, JSON.stringify([...claims, key].slice(-maxClaims)));
      return true;
    } catch {
      return true;
    }
  });
}
