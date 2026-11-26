import { createHash } from "node:crypto";
import { discover, type DiscoverItem } from "@opensteer/agent-tools/discover";
import {
  browser_profile_list,
  computer_apps,
  computer_list,
  opensteer_plugin_list,
  opensteer_task_list,
  opensteer_task_read,
  plugin_describe,
  plugin_search,
  tab_list,
} from "@opensteer/agent-tools/tools";
import {
  agentGrantToolFamilies,
  BrowserProfileIdSchema,
  BrowserSourceIdSchema,
  DeviceIdSchema,
  OpensteerError,
  TabIdSchema,
  ThreadIdSchema,
  type Tab,
  type ToolFailureReceipt,
} from "@opensteer/core";
import { authorizeTarget, type OpensteerStore } from "@opensteer/database";
import { z } from "zod";
import { AgentOperationFailure } from "../../agent-sessions/agent-session-service.js";
import type { BrowserSourceService } from "../../browser/browser-source-service.js";
import { localToolPath } from "../../plugins/provider-names.js";
import { createProfileCommand } from "./browser.js";
import type { TabService } from "../../tabs/tab-service.js";
import type { AgentCaller, ConnectionCaller } from "../agent-caller.js";
import { productToolOutput } from "../tool-output.js";
import type { AgentToolHandlers } from "./types.js";

type DiscoverInput = z.output<typeof discover.input>;
type DiscoverCall = LookupCall<DiscoverInput>;
type LookupCall<Input> = {
  readonly caller: ConnectionCaller;
  readonly input: Input;
  readonly operationKey: string;
  readonly signal?: AbortSignal;
  readonly checkLive?: () => Promise<void>;
  readonly liveCaller?: () => Promise<AgentCaller>;
  readonly discoveryInput?: DiscoverInput;
  readonly discoveryTab?: (tab: Tab) => boolean;
};

type Lookups = Pick<
  Partial<AgentToolHandlers>,
  | "browser_profile_list"
  | "tab_list"
  | "computer_apps"
  | "computer_list"
  | "opensteer_plugin_list"
  | "plugin_search"
  | "plugin_describe"
  | "plugin_skills"
  | "opensteer_task_list"
  | "opensteer_task_read"
>;

const rootCursor = z.object({
  inventory: z.number().int().nonnegative().optional(),
  plugins: z.string().optional(),
  tasks: z.string().optional(),
});
const detailCursor = z.object({ after: z.string() });
const cursorEnvelope = z.tuple([z.string(), z.unknown()]);
const appAddress = z.tuple([DeviceIdSchema, z.string().min(1).max(255)]);
const phoneAppAddress = z.tuple([
  DeviceIdSchema,
  z.string().min(1).max(512),
  z.string().max(200),
  z.string().regex(/^\d{1,5}$/u),
]);
const documentAddress = z.tuple([
  z.string().min(1).max(63),
  z.string().min(1).max(256),
  z.string().min(1).max(256),
  z.string().min(1).max(256),
  z.string().min(1).max(256).optional(),
]);
const skillIndex = z.object({
  skills: z.array(z.object({ name: z.string(), version: z.string(), revision: z.string() })),
});
const skillDocument = z.object({ content: z.string(), files: z.array(z.string()) });
const receipt = discover.output.pick({
  taskId: true,
  operationId: true,
  status: true,
  next: true,
  requestId: true,
  summary: true,
  replayed: true,
});
type ReadReceipt = z.output<typeof receipt>;

function readOutcome(read: ReadReceipt) {
  if (read.replayed)
    return {
      ...read,
      next:
        read.next ?? "This is the stored receipt. Make a fresh discovery call for current items.",
    };
  return read.status && read.status !== "completed" ? read : undefined;
}

function recordedMissing(read: ReadReceipt) {
  if (!read.operationId) return unavailable();
  return {
    ...read,
    error: { code: "not_found" as const, message: "That item is unavailable.", next: null },
  };
}
const inventoryPageSize = 50;

function unavailable(): never {
  throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function itemUse(
  tool: DiscoverItem["use"]["tool"],
  argument: string,
  value: string,
  computerId?: string,
): DiscoverItem["use"] {
  return { tool, argument, value, ...(computerId ? { computerId } : {}) };
}

function address(id: string) {
  const profile = BrowserProfileIdSchema.safeParse(id);
  if (profile.success) return { kind: "browser-profile", id: profile.data } as const;
  const source = BrowserSourceIdSchema.safeParse(id);
  if (source.success) return { kind: "chrome-tabs", id: source.data } as const;
  const device = DeviceIdSchema.safeParse(id);
  if (device.success) return { kind: "device", id: device.data } as const;
  const task = ThreadIdSchema.safeParse(id);
  if (task.success) return { kind: "task", id: task.data } as const;
  if (id.length > 2048) return unavailable();
  if (id.startsWith("app:")) {
    const parsed = appAddress.safeParse(decode(id.slice(4)));
    if (parsed.success && id === "app:" + encode(parsed.data))
      return { kind: "app", id, computerId: parsed.data[0], bundleId: parsed.data[1] } as const;
    return unavailable();
  }
  if (id.startsWith("phone-app:")) {
    const parsed = phoneAppAddress.safeParse(decode(id.slice(10)));
    if (parsed.success && id === "phone-app:" + encode(parsed.data))
      return { kind: "phone-app", id, parts: parsed.data } as const;
    return unavailable();
  }
  if (id.startsWith("doc:")) {
    const parsed = documentAddress.safeParse(decode(id.slice(4)));
    if (parsed.success && id === "doc:" + encode(parsed.data))
      return { kind: "document", id, parts: parsed.data } as const;
    return unavailable();
  }
  const match = /^tools(?:\.([A-Za-z_$][\w$]*)|\["([A-Za-z0-9_-]+)"\])$/u.exec(id);
  const slug = match?.[1] ?? match?.[2];
  if (slug && slug.length <= 63 && localToolPath(slug) === id)
    return { kind: "plugin", id, slug } as const;
  if (id.startsWith("tools.") || id.startsWith("tools[")) {
    if (id.length <= 256 && /^tools(?:\.[A-Za-z_$][\w$]*|\["(?:[^"\\]|\\.)+"\]){2,}$/u.test(id))
      return { kind: "tool", id } as const;
    return unavailable();
  }
  const tab = TabIdSchema.safeParse(id);
  if (tab.success) return { kind: "tab", id: tab.data } as const;
  return unavailable();
}

function tabItem(
  tab: Pick<Tab, "tabId" | "kind" | "title" | "state"> &
    Partial<Pick<Tab, "computer" | "sharedByPerson" | "bundleId">>,
): DiscoverItem {
  const computer = tab.sharedByPerson?.computerName ?? tab.computer?.name;
  const use =
    tab.kind === "page"
      ? itemUse("browser_use", "tabId", tab.tabId)
      : tab.kind === "window" && tab.bundleId && tab.computer
        ? itemUse("computer_use", "app", tab.bundleId, tab.computer.computerId)
        : itemUse("discover", "id", tab.tabId);
  return {
    id: tab.tabId,
    kind: "tab",
    name: tab.title,
    reachable: tab.state === "open",
    ...(computer ? { computer } : {}),
    untrusted: true,
    use,
  };
}

function taskItem(id: string, title: string | null, status: string): DiscoverItem {
  return {
    id,
    kind: "task",
    name: title ?? "Task",
    status,
    use: itemUse("opensteer_task_read", "taskId", id),
  };
}

function documentItem(parts: z.output<typeof documentAddress>): DiscoverItem {
  const id = "doc:" + encode(parts);
  return {
    id,
    kind: "document",
    name: parts[4] ?? parts[1],
    revision: parts[3],
    untrusted: true,
    use: itemUse("discover", "id", id),
  };
}

function toolItem(path: string, description: string): DiscoverItem {
  return {
    id: path,
    kind: "tool",
    name: path,
    description,
    untrusted: true,
    use: itemUse("plugin_call", "calls.path", path),
  };
}

export function discoverHandler(
  lookups: Lookups,
  sources: {
    readonly tabs: Pick<TabService, "project">;
    readonly browserSources: Pick<BrowserSourceService, "grantableChromeTabs">;
    readonly store: Pick<OpensteerStore, "admitExecution">;
  },
) {
  return async (call: DiscoverCall): Promise<z.output<typeof discover.output>> => {
    // A recorded read's receipt stays with whatever this call returns, a later refusal included.
    let recorded: { taskId: string; operationId: string } | undefined;
    const remember = (read: ReadReceipt) => {
      if (read.taskId && read.operationId)
        recorded = { taskId: read.taskId, operationId: read.operationId };
      return read;
    };
    try {
      return await discoverFor(call, remember);
    } catch (error) {
      if (!recorded || error instanceof AgentOperationFailure) throw error;
      throw new AgentOperationFailure(error, recorded as ToolFailureReceipt);
    }
  };
  async function discoverFor(
    call: DiscoverCall,
    remember: (read: ReadReceipt) => ReadReceipt,
  ): Promise<z.output<typeof discover.output>> {
    const { id, query, cursor, taskId } = call.input;
    const target = id === undefined ? null : address(id);
    // One live check per call; every lookup of this call uses the caller it returned.
    let live: Promise<ConnectionCaller> | undefined;
    const currentCaller = () =>
      (live ??= (async () => {
        if (!call.liveCaller) {
          await call.checkLive?.();
          return call.caller;
        }
        const caller = await call.liveCaller();
        if (caller.kind !== "connection" || caller.connectionId !== call.caller.connectionId)
          return unavailable();
        return caller;
      })());
    const families = agentGrantToolFamilies((await currentCaller()).grant);
    const scope = createHash("sha256")
      .update(JSON.stringify([call.caller.connectionId, id, query]))
      .digest("base64url");
    function cursorPosition() {
      if (cursor === undefined) return undefined;
      const decoded = cursorEnvelope.safeParse(
        cursor.length > 0 && cursor.length <= 4096 ? decode(cursor) : undefined,
      );
      if (!decoded.success || decoded.data[0] !== scope)
        throw new OpensteerError({
          code: "bad_request",
          message: "Use the cursor with the same discover arguments.",
        });
      return decoded.data[1];
    }
    function detailPosition() {
      const position = cursorPosition();
      return position === undefined ? undefined : detailCursor.parse(position).after;
    }
    function recordedCursorError(read: ReadReceipt) {
      try {
        detailPosition();
        return undefined;
      } catch (cause) {
        if (!read.operationId) throw cause;
        return {
          ...read,
          error: {
            code: "bad_request" as const,
            message: "Use the cursor with the same discover arguments.",
            next: null,
          },
        };
      }
    }
    const next = (value: unknown) => encode([scope, value]);
    const matches = (name: string) => !query || name.toLowerCase().includes(query.toLowerCase());

    async function lookup<Input, Output>(
      handler: ((call: LookupCall<Input>) => Promise<unknown>) | undefined,
      input: Input,
      output: z.ZodType<Output>,
      project = (value: unknown) => value,
      discoveryTab?: (tab: Tab) => boolean,
    ): Promise<Output> {
      if (!handler) return unavailable();
      try {
        const caller = await currentCaller();
        return output.parse(
          project(
            await handler({
              ...call,
              caller,
              input,
              discoveryInput: call.input,
              ...(discoveryTab ? { discoveryTab } : {}),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof AgentOperationFailure) throw error;
        const cause = error;
        if (
          cause instanceof OpensteerError &&
          (cause.code === "not_found" ||
            cause.reason === "target-unavailable" ||
            (cause.code === "forbidden" &&
              ["Parent task is unavailable", "task is unavailable to this user"].includes(
                cause.message,
              )))
        )
          return unavailable();
        throw error;
      }
    }

    const profiles = async () =>
      (await lookup(lookups.browser_profile_list, {}, browser_profile_list.output)).profiles.map(
        ({ id: profileId, name, home }): DiscoverItem => ({
          id: profileId,
          kind: "browser-profile",
          name,
          reachable: home?.reachable ?? false,
          ...(home?.name ? { computer: home.name } : {}),
          use: itemUse("browser_use", "profileId", profileId),
        }),
      );
    const cachedTabs = async () =>
      (await sources.tabs.project({ kind: "connection", caller: await currentCaller() })).tabs;
    const chromeSources = async () => {
      const { userId, connectionId } = await currentCaller();
      const execution = await sources.store.admitExecution({
        ownerUserId: userId,
        subject: { kind: "connection", agentConnectionId: connectionId },
      });
      const [paired, live] = await Promise.all([
        sources.browserSources.grantableChromeTabs(userId),
        cachedTabs(),
      ]);
      const reachable = new Set(
        live.flatMap((tab) =>
          tab.sharedByPerson && tab.state === "open" ? [tab.sharedByPerson.sourceId] : [],
        ),
      );
      return paired
        .filter(({ sourceId }) => authorizeTarget(execution, { kind: "chrome-tabs", sourceId }))
        .map(({ sourceId, computerName }): DiscoverItem => ({
          id: sourceId,
          kind: "chrome-tabs",
          name: `Chrome tabs on ${computerName}`,
          computer: computerName,
          reachable: reachable.has(sourceId),
          use: itemUse("discover", "id", sourceId),
        }));
    };
    const computers = (input: z.input<typeof computer_apps.input> = {}) =>
      lookup(
        lookups.computer_apps,
        { ...computer_apps.input.parse(input), ...(taskId ? { taskId } : {}) },
        computer_apps.output.extend({ replayed: receipt.shape.replayed }),
      );
    const appItem = (
      computerId: string,
      computer: string,
      app: { bundleId: string; name: string; access?: "read" | "read-write" | undefined },
    ): DiscoverItem => ({
      id: "app:" + encode([computerId, app.bundleId]),
      kind: "app",
      name: app.name,
      computer,
      reachable: app.access !== undefined,
      ...(app.access ? { access: app.access === "read" ? "read-only" : "read-write" } : {}),
      untrusted: true,
      use: itemUse("computer_use", "app", app.bundleId, computerId),
    });
    let phoneDisplays: Promise<Map<string, NonNullable<DiscoverItem["phoneSetup"]>>> | undefined;
    async function readPhoneDisplays() {
      const displays = new Map<string, NonNullable<DiscoverItem["phoneSetup"]>>();
      if (!lookups.computer_list) return displays;
      let cursor: string | null = null;
      do {
        const page: z.output<typeof computer_list.output> = await lookup(
          lookups.computer_list,
          { cursor: cursor ?? undefined },
          computer_list.output,
        );
        for (const row of page.computers)
          if (row.phoneDisplay) displays.set(row.computerId, row.phoneDisplay.setup);
        cursor = page.nextCursor;
      } while (cursor);
      return displays;
    }
    const phoneItem = async (phone: {
      computerId: string;
      name: string;
      definitionId: string;
      access?: "read" | "read-write" | undefined;
      blocked?: DiscoverItem["blocked"];
    }): Promise<DiscoverItem> => {
      const phoneSetup =
        phone.definitionId === "iphone-screen"
          ? (await (phoneDisplays ??= readPhoneDisplays())).get(phone.computerId)
          : undefined;
      return {
        id: phone.computerId,
        kind: "phone",
        ...(phoneSetup ? { phoneSetup } : {}),
        name: phone.name,
        reachable: phone.access !== undefined && !phone.blocked,
        ...(phone.access ? { access: phone.access === "read" ? "read-only" : "read-write" } : {}),
        ...(phone.blocked ? { blocked: phone.blocked } : {}),
        use: itemUse("computer_use", "computerId", phone.computerId),
      };
    };
    const pluginPage = async (after?: string) => {
      if (!lookups.opensteer_plugin_list)
        return { items: [], cursor: null, pluginsUnavailable: false };
      const result = await lookup(
        lookups.opensteer_plugin_list,
        { cursor: after },
        opensteer_plugin_list.output,
      );
      return {
        items: [...result.plugins, ...result.local].map((plugin): DiscoverItem => {
          const pluginId = localToolPath(plugin.slug);
          return {
            id: pluginId,
            kind: "plugin",
            name: plugin.name,
            access: plugin.access === "all" ? "read-write" : "read-only",
            reachable: plugin.status === "active",
            untrusted: true,
            use: itemUse("discover", "id", pluginId),
          };
        }),
        cursor: result.cursor ?? null,
        pluginsUnavailable: result.pluginsUnavailable === true,
      };
    };
    const findPlugin = async (pluginId: string) => {
      let after: string | undefined;
      do {
        const page = await pluginPage(after);
        const found = page.items.find((item) => item.id === pluginId);
        if (found) return found;
        after = page.cursor ?? undefined;
      } while (after);
      return unavailable();
    };
    const taskPage = async (after?: string, parentTaskId?: z.output<typeof ThreadIdSchema>) => {
      const result = await lookup(
        lookups.opensteer_task_list,
        opensteer_task_list.input.parse({ cursor: after, query, parentTaskId }),
        opensteer_task_list.output,
        productToolOutput,
      );
      return {
        items: result.tasks.map((task) =>
          taskItem(task.id, task.title, task.taskStatus ?? task.status),
        ),
        cursor: result.nextCursor,
      };
    };
    const details = (items: DiscoverItem[], after: string | null = null, item?: DiscoverItem) => ({
      ...(item ? { item } : {}),
      items,
      nextCursor: after === null ? null : next({ after }),
    });

    if (!target) {
      const position = cursorPosition();
      const index =
        position === undefined
          ? { inventory: 0, plugins: "", tasks: "" }
          : rootCursor.parse(position);
      const [browser, devices, plugins, tasks] = await Promise.all([
        index.inventory !== undefined && families.has("browser")
          ? Promise.all([profiles(), chromeSources()]).then(([list, chrome]) => [
              ...list,
              ...chrome,
            ])
          : [],
        index.inventory !== undefined && families.has("computer") ? computers() : undefined,
        index.plugins !== undefined && families.has("plugins")
          ? pluginPage(index.plugins || undefined)
          : undefined,
        index.tasks !== undefined && families.has("tasks")
          ? taskPage(index.tasks || undefined)
          : undefined,
      ]);
      const all = [
        ...browser,
        ...(devices?.computers ?? []).flatMap((computer) =>
          computer.apps.map((app) => appItem(computer.computerId, computer.name, app)),
        ),
        ...(await Promise.all((devices?.phones ?? []).map(phoneItem))),
      ].filter((entry) => matches(entry.name));
      const start = index.inventory ?? 0;
      const end = start + inventoryPageSize;
      const following = {
        ...(end < all.length ? { inventory: end } : {}),
        ...(plugins?.cursor ? { plugins: plugins.cursor } : {}),
        ...(tasks?.cursor ? { tasks: tasks.cursor } : {}),
      };
      const items = [
        ...all.slice(start, end),
        ...(plugins?.items.filter((entry) => matches(entry.name)) ?? []),
        ...(tasks?.items ?? []),
      ];
      // Nothing at all, asked for nothing in particular: say what is true and what can be done.
      const empty =
        position === undefined && !query && items.length === 0 && !plugins?.pluginsUnavailable;
      const everything = (await currentCaller()).grant.scope === "everything";
      return {
        items,
        nextCursor: Object.keys(following).length ? next(following) : null,
        ...(plugins?.pluginsUnavailable
          ? { next: "Installed plugins are currently unavailable." }
          : empty
            ? {
                next: everything
                  ? `This Home has nothing set up yet. To browse, create a browser profile with opensteer_command ${createProfileCommand}; opensteer_commands lists what else you can set up.`
                  : "Nothing shared with you is here yet. What else you can use is the person's to decide.",
              }
            : {}),
      };
    }

    if (
      target.kind === "browser-profile" ||
      target.kind === "chrome-tabs" ||
      target.kind === "tab"
    ) {
      if (target.kind !== "tab" && !families.has("browser")) return unavailable();
      if (target.kind === "tab" && !families.has("browser") && !families.has("computer"))
        return unavailable();
      const item =
        target.kind === "browser-profile"
          ? (await profiles()).find((entry) => entry.id === target.id)
          : target.kind === "chrome-tabs"
            ? (await chromeSources()).find((entry) => entry.id === target.id)
            : (await cachedTabs()).filter((tab) => tab.tabId === target.id).map(tabItem)[0];
      if (!item) return unavailable();
      const page = await lookup(
        lookups.tab_list,
        tab_list.input.parse({
          ...(target.kind === "tab" ? {} : { kind: "page", query }),
          cursor: detailPosition(),
          taskId,
        }),
        tab_list.output.extend({ replayed: receipt.shape.replayed }),
        undefined,
        (tab) => {
          if (target.kind === "tab") return tab.tabId === target.id;
          if (target.kind === "chrome-tabs") return tab.sharedByPerson?.sourceId === target.id;
          return tab.profile?.profileId === target.id;
        },
      );
      const read = remember(receipt.parse(page));
      const outcome = readOutcome(read);
      if (outcome) return outcome;
      const found = page.tabs ?? [];
      if (target.kind === "tab")
        return found[0]
          ? { ...details([], null, tabItem(found[0])), ...read }
          : recordedMissing(read);
      return { ...details(found.map(tabItem), page.nextCursor ?? null, item), ...read };
    }

    if (target.kind === "device" || target.kind === "app" || target.kind === "phone-app") {
      if (!families.has("computer")) return unavailable();
      const deviceId =
        target.kind === "device"
          ? target.id
          : target.kind === "app"
            ? target.computerId
            : target.parts[0];
      const inventory = await computers();
      const machine = inventory.computers?.find((computer) => computer.computerId === deviceId);
      const phone = inventory.phones?.find((candidate) => candidate.computerId === deviceId);
      if (!machine && !phone) return unavailable();
      const phoneApp = (id: string, name: string, search: string, page: string): DiscoverItem => ({
        id: "phone-app:" + encode([deviceId, id, search, page]),
        kind: "app",
        name,
        computer: phone?.name,
        appId: id,
        untrusted: true,
        use: itemUse("computer_use", "computerId", deviceId),
      });
      if (target.kind === "phone-app") {
        if (!phone) return unavailable();
        const [, appId, search, offset] = target.parts;
        const page = await computers({ computerId: deviceId, query: search, cursor: offset });
        const read = remember(receipt.parse(page));
        const outcome = readOutcome(read);
        if (outcome) return outcome;
        const app = page.apps?.find((entry) => entry.appId === appId);
        if (!app) return recordedMissing(read);
        const cursorError = recordedCursorError(read);
        if (cursorError) return cursorError;
        return { ...details([], null, phoneApp(app.appId, app.label, search, offset)), ...read };
      }
      if (target.kind === "app") {
        if (!machine) return unavailable();
        const cached = machine.apps.find((app) => app.bundleId === target.bundleId);
        const page = cached
          ? undefined
          : await computers({ computerId: deviceId, query: target.bundleId.slice(0, 240) });
        const read = page && remember(receipt.parse(page));
        const outcome = read && readOutcome(read);
        if (outcome) return outcome;
        const app =
          cached ?? page?.computer?.apps.find((entry) => entry.bundleId === target.bundleId);
        if (!app) return read ? recordedMissing(read) : unavailable();
        const cursorError = read && recordedCursorError(read);
        if (cursorError) return cursorError;
        const after = detailPosition();
        const item = appItem(deviceId, machine.name, app);
        const windows = (await cachedTabs()).filter(
          (tab) =>
            tab.kind === "window" &&
            tab.computer.computerId === deviceId &&
            tab.bundleId === app.bundleId &&
            matches(tab.title),
        );
        const offset = Number(after ?? "0");
        const limit = offset + inventoryPageSize;
        return {
          ...details(
            windows.slice(offset, limit).map(tabItem),
            limit < windows.length ? String(limit) : null,
            item,
          ),
          ...(page ? receipt.parse(page) : {}),
        };
      }
      const after = detailPosition();
      const item: DiscoverItem = phone
        ? await phoneItem(phone)
        : {
            id: deviceId,
            kind: "device",
            name: machine!.name,
            use: itemUse("discover", "id", deviceId),
          };
      const windows =
        machine && !after?.startsWith("apps:")
          ? (await cachedTabs()).filter(
              (tab) =>
                tab.kind === "window" && tab.computer.computerId === deviceId && matches(tab.title),
            )
          : [];
      const start = machine && after?.startsWith("windows:") ? Number(after.slice(8)) : 0;
      const windowPage = windows.slice(start, start + inventoryPageSize);
      const end = start + windowPage.length;
      if (windowPage.length === inventoryPageSize)
        return details(
          windowPage.map(tabItem),
          end < windows.length ? `windows:${end}` : "apps:0",
          item,
        );

      const offset = machine ? (after?.startsWith("apps:") ? after.slice(5) : undefined) : after;
      const page = await computers({
        computerId: deviceId,
        ...(query ? { query } : {}),
        ...(offset ? { cursor: offset } : {}),
        ...(machine && windowPage.length ? { limit: inventoryPageSize - windowPage.length } : {}),
      });
      const read = remember(receipt.parse(page));
      const outcome = readOutcome(read);
      if (outcome) return outcome;
      const apps = phone
        ? (page.apps ?? []).map((app) => phoneApp(app.appId, app.label, query ?? "", offset ?? "0"))
        : (page.computer?.apps ?? []).map((entry) => appItem(deviceId, machine!.name, entry));
      return {
        ...details(
          [...windowPage.map(tabItem), ...apps],
          page.nextCursor ? (machine ? `apps:${page.nextCursor}` : page.nextCursor) : null,
          item,
        ),
        ...read,
      };
    }

    if (target.kind === "task") {
      if (!families.has("tasks")) return unavailable();
      const read = await lookup(
        lookups.opensteer_task_read,
        opensteer_task_read.input.parse({ taskId: target.id, limit: 1, runLimit: 1 }),
        z.object({ task: z.object({ title: z.string().nullable(), status: z.string() }) }),
        productToolOutput,
      );
      const page = await taskPage(detailPosition(), target.id);
      return details(
        page.items,
        page.cursor,
        taskItem(target.id, read.task.title, read.task.status),
      );
    }

    if (!families.has("plugins")) return unavailable();
    if (target.kind === "tool") {
      const found = await lookup(
        lookups.plugin_describe,
        { paths: [target.id] },
        plugin_describe.output,
      );
      const tool = found.items.find((entry) => entry.path === target.id);
      if (!tool || tool.blocked) return unavailable();
      detailPosition();
      return details([], null, {
        ...toolItem(tool.path, tool.description),
        ...(tool.signature ? { signature: tool.signature } : {}),
      });
    }
    if (target.kind === "document") {
      const [slug, name, version, revision, file] = target.parts;
      await findPlugin(localToolPath(slug));
      const index = await lookup(lookups.plugin_skills, { app: slug }, skillIndex);
      if (
        !index.skills.some(
          (skill) =>
            skill.name === name && skill.version === version && skill.revision === revision,
        )
      )
        return unavailable();
      const document = await lookup(
        lookups.plugin_skills,
        { app: slug, name, version, revision },
        skillDocument,
      );
      if (file && !document.files.includes(file)) return unavailable();
      const content = file
        ? await lookup(
            lookups.plugin_skills,
            { app: slug, name, version, revision, file },
            skillDocument,
          )
        : document;
      detailPosition();
      const references = file
        ? []
        : document.files
            .filter(matches)
            .map((path) => documentItem([slug, name, version, revision, path]));
      return details(references, null, { ...documentItem(target.parts), text: content.content });
    }

    const item = await findPlugin(target.id);
    const after = detailPosition();
    const result = await lookup(
      lookups.plugin_search,
      {
        namespace: target.slug,
        limit: 25,
        ...(after ? { offset: Number(after) } : {}),
        ...(query ? { query } : {}),
      },
      plugin_search.output,
    );
    const tools = result.items.map(({ path, description, input, blocked }): DiscoverItem => ({
      ...toolItem(path, description),
      ...(input ? { input } : {}),
      ...(blocked ? { blocked, use: itemUse("discover", "id", target.id) } : {}),
    }));
    const documents =
      after || target.slug.startsWith("local-")
        ? []
        : (await lookup(lookups.plugin_skills, { app: target.slug }, skillIndex)).skills
            .filter(({ name }) => matches(name))
            .map(({ name, version, revision }) =>
              documentItem([target.slug, name, version, revision]),
            );
    return details(
      [...tools, ...documents],
      result.next?.offset === undefined ? null : String(result.next.offset),
      item,
    );
  }
}
