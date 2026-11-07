import { HostClientRequestError } from "../host/client.js";
export * from "./plugin-add-consent.js";
export * from "./catalog.js";
export * from "./other-devices.js";
export * from "./desktop-update-controller.js";
export * from "./desktop-update-view.js";
export {
  DesktopUpdatesError,
  OriginDesktopUpdates,
  followDesktopUpdates,
} from "../connections/desktop-updates-contract.js";
export type { DesktopUpdates } from "../connections/desktop-updates-contract.js";
import {
  PluginTargetSchema,
  type PluginTarget,
  type PluginRow,
  type PluginDetailView,
} from "@opensteer/protocol";

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
  ["/settings/devices/remote-access", "/settings/account/remote-access"],
  ["/settings/devices/sessions", "/settings/account/sessions"],
  ["/settings/apps/messaging", "/settings/messaging"],
  ["/settings/apps/tools", "/settings/plugins"],
  ["/settings/ai-engines", "/settings/ai"],
  ["/settings/connections", "/settings/account"],
  ["/settings/integrations", "/settings/plugins"],
  ["/settings/computers", "/settings/devices/computers"],
  ["/settings/remote-access", "/settings/account/remote-access"],
  ["/settings/this-device", "/settings/devices"],
  ["/settings/browser-profiles", "/settings/sign-ins/browsers"],
  ["/settings/passwords", "/settings/sign-ins/passwords"],
  ["/settings/chrome", "/settings/sign-ins/chrome"],
  ["/settings/apps", "/settings/plugins"],
  ["/computers", "/settings/devices/computers"],
  ["/channels", "/settings/messaging"],
] as const;
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
  // Old integrations used local view state, not routable target identities.
  return `${to}${to === "/settings/plugins" ? "" : pathname.slice(from.length)}${tail}`;
}
export function pluginTargetKey(target: PluginTarget): string {
  switch (target.kind) {
    case "service":
    case "device-app":
      return JSON.stringify({ definitionId: target.definitionId });
    case "plugin":
      return JSON.stringify({ pluginId: target.pluginId });
    case "skill":
      return JSON.stringify({ workspaceId: target.workspaceId, fullName: target.fullName });
    case "specialist":
      return JSON.stringify({ pluginId: target.pluginId, ownerUserId: target.ownerUserId });
  }
}
export function pluginPath(target: PluginTarget): string {
  return `/settings/plugins/${target.kind}/${encodeURIComponent(pluginTargetKey(target))}`;
}
export function pluginTargetFromPath(kind: string, id: string): PluginTarget | null {
  try {
    const result = PluginTargetSchema.safeParse({ ...JSON.parse(id), kind });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
const repairLabels = {
  "needs-sign-in": "Needs sign-in",
  "needs-scopes": "Review account access",
  "needs-admin": "Needs administrator",
  "needs-app-approval": "Approve app access",
  "needs-os-permission": "Allow system permission",
  "choose-resource": "Choose a resource",
  "invalid-installation": "Repair installation",
  "removal-failed": "Removal failed",
} as const;
export function pluginState(row: PluginRow): {
  group: "Needs you" | "On" | "Turned off";
  label: string;
} {
  if (!row.placement.enabled) return { group: "Turned off", label: "Turned off" };
  if (
    (row.target.kind === "service" || row.target.kind === "device-app") &&
    row.accountCount === 0 &&
    row.issues.includes("needs-sign-in")
  )
    return { group: "Needs you", label: "Connect" };
  for (const issue of row.issues)
    if (issue in repairLabels)
      return { group: "Needs you", label: repairLabels[issue as keyof typeof repairLabels] };
  return {
    group: "On",
    label: row.issues.some((issue) => issue === "waiting-device" || issue === "waiting-setup")
      ? "Waiting"
      : "On",
  };
}
export function pluginPlacementLabel(row: PluginRow, personal: boolean): string {
  if (personal && row.placement.personalEverywhere) return "Everywhere";
  return (
    [
      row.placement.mainIncluded ? "Main" : "",
      row.placement.projectCount ? `${row.placement.projectCount} Projects` : "",
    ]
      .filter(Boolean)
      .join(" and ") || "No places selected"
  );
}
export function pluginGroups(rows: readonly PluginRow[], query = "") {
  const result: Record<"Needs you" | "On" | "Turned off", PluginRow[]> = {
    "Needs you": [],
    On: [],
    "Turned off": [],
  };
  const term = query.trim().toLocaleLowerCase();
  for (const row of rows) {
    if (term && !`${row.title} ${row.description ?? ""}`.toLocaleLowerCase().includes(term))
      continue;
    result[pluginState(row).group].push(row);
  }
  for (const group of Object.values(result)) group.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}
export function pluginAccountRows(detail: PluginDetailView) {
  return detail.accounts.map((account) => ({
    ...account,
    key: account.connectionId,
    label: account.displayName,
  }));
}

/** A visible page owns one reader. Invalidation bursts collapse into one trailing read. */
export function createSettingsRead<T>(
  read: () => Promise<T>,
  publish: (value: T) => void,
  fail: (reason: unknown) => void,
) {
  let generation = 0;
  let running = false;
  let dirty = false;
  let disposed = false;
  async function refresh() {
    if (disposed) return;
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const own = generation;
        try {
          const value = await read();
          if (!disposed && own === generation) publish(value);
        } catch (error) {
          if (!disposed && own === generation) fail(error);
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    refresh,
    reconnect() {
      generation++;
      return refresh();
    },
    dispose() {
      disposed = true;
      generation++;
      dirty = false;
    },
  };
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

/** Only a definite Host refusal releases the original idempotent attempt. */
export function settingsMutationRejected(reason: unknown): boolean {
  return (
    reason instanceof HostClientRequestError &&
    ["conflict", "bad_request", "forbidden", "not_found", "unauthorized"].includes(reason.code)
  );
}

export function pluginPlacementAccounts<
  T extends { connectionId: string; access: "read" | "read-write" },
>(existing: readonly T[], reviewed: readonly T[], requiresAccount: boolean): T[] {
  if (existing.length) return [...existing];
  if (requiresAccount && !reviewed.length)
    throw new Error("Choose an account and its access first.");
  return [...reviewed];
}

/** Record an explicit directory choice without granting account access. */
export async function addPluginService(
  client: import("../host/client.js").HostClient,
  target: PluginTarget,
) {
  const { unwrapRpcResult, mutationIdempotencyKey } = await import("../host/index.js");
  let revision = 0;
  try {
    revision = unwrapRpcResult(await client.rpc["plugins.detail.get"]({ target })).row.placement
      .revision;
  } catch (reason) {
    if (!(reason instanceof HostClientRequestError) || reason.code !== "forbidden") throw reason;
  }
  await client.dispatch({
    type: "settings.plugin.enabled.set",
    target,
    enabled: true,
    expectedRevision: revision,
    idempotencyKey: mutationIdempotencyKey("plugin-add"),
  });
}
