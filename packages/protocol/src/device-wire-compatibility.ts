import { DeviceIdSchema, OpensteerError, RunnerIdSchema } from "@opensteer/core";

export const deviceWireApiVersion = 61;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const legacyTarget = (value: unknown) => RunnerIdSchema.safeParse(value).success;

export function deviceWireUpdateRequired(): never {
  throw new OpensteerError({
    code: "bad_request",
    reason: "device-api-update-required",
    message: "Update Opensteer to use this iPhone screen device.",
  });
}

/** Checks only target-bearing input, never arbitrary tool arguments or user text. */
export function assertDeviceWireInput(value: unknown, apiVersion: number): void {
  if (apiVersion >= deviceWireApiVersion) return;
  if (Array.isArray(value)) {
    for (const entry of value) assertDeviceWireInput(entry, apiVersion);
    return;
  }
  const row = object(value);
  if (!row) return;
  if (
    (typeof row.type === "string" && row.type.startsWith("iphone.screen.")) ||
    row.definitionId === "iphone-screen" ||
    ["deviceId", "machineId", "computerId", "runnerId"].some(
      (key) => DeviceIdSchema.safeParse(row[key]).success && !legacyTarget(row[key]),
    )
  )
    deviceWireUpdateRequired();
  for (const [key, entry] of Object.entries(row))
    if (!opaque.has(key)) assertDeviceWireInput(entry, apiVersion);
}

const opaque = new Set(["output", "arguments", "inputSchema", "outputSchema", "config", "schema"]);

/** A wire projection, applied after current-schema validation so legacy fields stay legacy. */
export function projectDeviceWire(
  value: unknown,
  apiVersion: number,
  hiddenTabIds: ReadonlySet<string> = new Set(),
  hiddenSessionIds: ReadonlySet<string> = new Set(),
): unknown {
  if (apiVersion >= deviceWireApiVersion) return value;
  const visit = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value))
      return value.flatMap((entry) => {
        const projected = visit(entry, key);
        return projected === undefined ? [] : [projected];
      });
    const row = object(value);
    if (!row) return value;
    if (
      (key === "sessions" &&
        typeof row.sessionId === "string" &&
        hiddenSessionIds.has(row.sessionId)) ||
      row.definitionId === "iphone-screen" ||
      (key === "definition" && row.id === "iphone-screen") ||
      object(row.definition)?.id === "iphone-screen" ||
      ((key === "machines" || key === "devices") &&
        (row.selfRunnerId === null ||
          (Array.isArray(row.allowedModules) && row.allowedModules.length === 0)))
    )
      return undefined;
    if ((row.type === "phone" || row.type === "computer-app") && !legacyTarget(row.machineId))
      return { type: "text", text: typeof row.name === "string" ? row.name : "Phone" };
    if (
      (row.machineId !== undefined && row.machineId !== null && !legacyTarget(row.machineId)) ||
      (row.computerId !== undefined && row.computerId !== null && !legacyTarget(row.computerId)) ||
      (row.deviceId !== undefined && row.deviceId !== null && !legacyTarget(row.deviceId)) ||
      (typeof row.tabId === "string" && hiddenTabIds.has(row.tabId))
    )
      return undefined;
    const result: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(row)) {
      if (entry === undefined) continue;
      if (
        field === "phone" &&
        object(entry)?.runnerId !== undefined &&
        !legacyTarget(object(entry)?.runnerId)
      )
        continue;
      if (
        field === "computerApp" &&
        object(entry)?.runnerId !== undefined &&
        !legacyTarget(object(entry)?.runnerId)
      ) {
        result[field] = null;
        continue;
      }
      if (field === "tabIds" && Array.isArray(entry)) {
        result[field] = entry.filter((id) => typeof id !== "string" || !hiddenTabIds.has(id));
        continue;
      }
      const projected = opaque.has(field) ? entry : visit(entry, field);
      if (projected === undefined) {
        if (
          field === "payload" ||
          (field === "request" && (row.kind === "request" || key === "data")) ||
          (field === "data" && typeof row.type === "string") ||
          (field === "target" && row.type === "host.show") ||
          (field === "computer" && typeof row.tabId === "string")
        )
          return undefined;
        result[field] = null;
        continue;
      }
      result[field === "deviceId" ? "runnerId" : field] = projected;
    }
    if (
      row.type === "host.computer-presence" &&
      Array.isArray(result.sessions) &&
      result.sessions.length === 0
    )
      return undefined;
    if (
      row.kind === "group" &&
      Array.isArray(object(row.group)?.tabIds) &&
      (object(row.group)!.tabIds as unknown[]).length > 0 &&
      Array.isArray(object(result.group)?.tabIds) &&
      (object(result.group)!.tabIds as unknown[]).length === 0
    )
      return undefined;
    return result;
  };
  return visit(value);
}

export function hiddenDeviceTabIds(
  tabs: readonly { readonly tabId: string; readonly computer: { readonly computerId: string } }[],
): Set<string> {
  return new Set(
    tabs.filter((tab) => !legacyTarget(tab.computer.computerId)).map((tab) => tab.tabId),
  );
}

export function projectDeviceTabs<
  T extends {
    readonly tabs: readonly {
      readonly tabId: string;
      readonly computer: { readonly computerId: string };
    }[];
    readonly layout: object;
  },
>(projection: T, apiVersion: number): T {
  if (apiVersion >= deviceWireApiVersion) return projection;
  // Filtering preserves every field of retained rows and layout items.
  return projectDeviceWire(projection, apiVersion, hiddenDeviceTabIds(projection.tabs)) as T;
}

export const deviceWireRpcNames: ReadonlySet<string> = new Set([
  "bootstrap.get",
  "machines.list",
  "devices.overview.get",
  "integrations.get",
  "integration.platform.get",
  "plugins.directory.get",
  "plugins.overview.get",
  "plugins.detail.get",
  "plugin.list",
  "integration.computer.setup.list",
  "integration.computer.setup.review",
  "integration.computer.apps.approved",
  "needsYou.get",
  "requests.list",
  "thread.requests.list",
  "thread.events.list",
  "node.events.list",
  "thread.messages.list",
  "thread.message.revisions.list",
  "thread.inputQueue.get",
  "thread.live.get",
  "tabs.get",
  "tabs.state",
  "commands.dispatch",
]);

export function deviceWireReferences(value: unknown, field: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => deviceWireReferences(entry, field));
  const row = object(value);
  if (!row) return [];
  return Object.entries(row).flatMap(([key, entry]) =>
    key === field && typeof entry === "string"
      ? [entry]
      : opaque.has(key)
        ? []
        : deviceWireReferences(entry, field),
  );
}

/** Old clients can move a visible group without replacing its unseen members. */
export function preserveDeviceTabGroupOrder<T extends import("./tabs.js").TabOrganizeInput>(
  input: T,
  projection: {
    tabs: import("@opensteer/core").Tab[];
    layout: import("@opensteer/core").TabLayout;
  },
  apiVersion: number,
): T {
  if (apiVersion >= deviceWireApiVersion || !input.group || !("groupId" in input.group))
    return input;
  const groupId = input.group.groupId;
  const group = projection.layout.items.find(
    (item) => item.kind === "group" && item.group.groupId === groupId,
  );
  if (group?.kind !== "group") return input;
  const hidden = hiddenDeviceTabIds(projection.tabs);
  const visible = group.group.tabIds.filter((id) => !hidden.has(id));
  if (input.tabIds.length !== visible.length || visible.some((id) => !input.tabIds.includes(id)))
    return input;
  let index = 0;
  return {
    ...input,
    tabIds: group.group.tabIds.map((id) => (hidden.has(id) ? id : input.tabIds[index++]!)),
  };
}
