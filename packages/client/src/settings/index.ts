import { formatRelativeTime } from "../host/thread-list-model.js";
export * from "./other-devices.js";
export * from "./desktop-update-controller.js";
export * from "./desktop-update-view.js";
export {
  DesktopUpdatesError,
  OriginDesktopUpdates,
  followDesktopUpdates,
} from "../connections/desktop-updates-contract.js";
export type { DesktopUpdates } from "../connections/desktop-updates-contract.js";

export const settingsPages = [
  "general",
  "account",
  "devices",
  "messaging",
  "external-agents",
  "ai",
  "plugins",
  "sign-ins",
] as const;
export const settingsRedirects = [
  ["/settings/account/remote-access", "/settings/account"],
  ["/settings/account/sessions", "/settings/devices"],
  ["/settings/devices/remote-access", "/settings/account"],
  ["/settings/devices/sessions", "/settings/devices"],
  ["/settings/apps/messaging", "/settings/messaging"],
  ["/settings/apps/tools", "/settings/plugins"],
  ["/settings/ai-engines", "/settings/ai"],
  ["/settings/connections", "/settings/account"],
  ["/settings/integrations", "/settings/plugins"],
  ["/settings/computers", "/settings/devices"],
  ["/settings/devices/computers", "/settings/devices"],
  ["/settings/remote-access", "/settings/account"],
  ["/settings/this-device", "/settings/devices"],
  ["/settings/browser-profiles", "/settings/sign-ins/browsers"],
  ["/settings/passwords", "/settings/sign-ins/passwords"],
  ["/settings/chrome", "/settings/sign-ins/chrome"],
  ["/settings/apps", "/settings/plugins"],
  ["/computers", "/settings/devices"],
  ["/channels", "/settings/messaging"],
] as const;
const pagesWithoutChildren: ReadonlySet<string> = new Set([
  "/settings/plugins",
  "/settings/account",
]);
export function redirectSettingsPath(path: string): string | null {
  const cut = path.search(/[?#]/u);
  const pathname = cut < 0 ? path : path.slice(0, cut);
  const tail = cut < 0 ? "" : path.slice(cut);
  if (pathname === "/settings" || pathname === "/settings/") return `/settings/general${tail}`;
  const match = settingsRedirects.find(
    ([from]) => pathname === from || pathname.startsWith(`${from}/`),
  );
  if (!match) return null;
  const [from, to] = match;
  // Neither page has children: old integrations used local view state, and
  // Account's remote-access and session pages folded into Account itself.
  return `${to}${pagesWithoutChildren.has(to) ? "" : pathname.slice(from.length)}${tail}`;
}

/** Local machine identity is supplied by the platform, never inferred from a session. */
export function settingsDeviceRows<T extends { id: string; name: string }>(
  devices: readonly T[],
  localMachineId: string | null,
) {
  return devices.map((device) => ({ ...device, thisDevice: device.id === localMachineId }));
}
export function settingsSessionRows<
  T extends { id: string; current: boolean; deviceLabel: string },
>(sessions: readonly T[]) {
  return [...sessions]
    .sort((a, b) => Number(b.current) - Number(a.current))
    .map((session) => ({ ...session, label: session.deviceLabel, thisDevice: session.current }));
}

/** How long ago a signed-in device was last used, in the same words everywhere. */
export function sessionActivityLine(
  session: { readonly current: boolean; readonly lastSeenAt: string },
  now: Date,
): string {
  if (session.current) return "This device";
  const elapsed = Math.max(0, now.getTime() - Date.parse(session.lastSeenAt));
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (!Number.isFinite(elapsed) || minutes < 1) return "Active now";
  if (hours < 1) return `Active ${plural(minutes, "minute")}`;
  if (days < 1) return `Active ${plural(hours, "hour")}`;
  if (days < 7) return `Active ${plural(days, "day")}`;
  return `Active ${formatRelativeTime(session.lastSeenAt, now)}`;
}
