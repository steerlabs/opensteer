import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  AppId,
  AppSlug,
  OwnerId,
  Tool,
  ToolName,
  ToolSearchListing,
  VersionId,
  type PluginEngine,
  type ToolSearchInput,
} from "@opensteer/plugin-engine-sdk/core";
import {
  CurrentMcpExecution,
  describeCatalog,
  executeProgram,
  makeExecutions,
  searchCatalog,
} from "@opensteer/plugin-engine-mcp";
import type { Blocked } from "@opensteer/core";
import { HostToolFailed, compositeBackend } from "./engine-backend.js";
import type { engineAccounts } from "./engine-accounts.js";
import type { HostToolResult, PluginHostProvider } from "./engine-protocol.js";
import { localNamespace, localToolPath } from "./provider-names.js";

/**
 * What an agent finds of local apps it cannot use now: a search that is not about them says
 * nothing of them, and one that is lists their tools with the reason said once.
 */
const gmail = {
  id: AppId.make("app_gmail"),
  slug: AppSlug.make("gmail"),
  name: "Gmail",
  activeVersion: VersionId.make("dpl_gmail"),
};
const cloudTool = (name: string, description: string, readOnly = true) =>
  Schema.decodeUnknownSync(Tool)({
    app: gmail.id,
    version: gmail.activeVersion,
    name,
    description,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    readOnly,
  });
const gmailTools = [
  cloudTool("search_threads", "Search Gmail threads"),
  cloudTool("send_email", "Send a Gmail message", false),
];
const tool = (name: string, description: string, readOnly = true) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  readOnly,
});
const accessRequired = (dataApp: string): Blocked => ({
  code: "access_required",
  message: `${dataApp} on Test iPhone requires an access grant.`,
  next: `Call app_access_request {"dataApp":"${dataApp}","computerId":"dev_phone","access":"read","reason":"<why you need it>"}.`,
});
const provider = (
  id: string,
  name: string,
  tools: PluginHostProvider["tools"],
  blocked?: Blocked,
): PluginHostProvider => ({
  id,
  name,
  slug: localNamespace(name.toLowerCase().replaceAll(/\W+/gu, "-"), id),
  version: `dpl_${id}`,
  tools,
  ...(blocked ? { blocked } : {}),
});
const phoneApps = [
  ["calendar", "Calendar", [tool("list_events", "List calendar events")]],
  ["contacts", "Contacts", [tool("search_contacts", "Search contacts")]],
  ["reminders", "Reminders", [tool("list_reminders", "List reminders")]],
  ["photos", "Photos", [tool("search_photos", "Search photos")]],
  ["location", "Location", [tool("current_location", "Read the current location")]],
] as const;
const waitingForLaunch: Blocked = {
  code: "setup_required",
  message: "Waiting for approval on the computer that runs it.",
  next: "Wait for the person to review it on the computer that runs it.",
};
/** Five iPhone apps without a grant and an Apple TV server awaiting its first launch. */
const blockedLocal = [
  ...phoneApps.map(([app, title, tools]) =>
    provider(
      `app_device_${app}`,
      `${title} on Test iPhone`,
      tools.map((entry) => ({ ...entry })),
      accessRequired(app),
    ),
  ),
  provider("app_server_tv", "Living Room TV", [], waitingForLaunch),
];
/** Calendar on a Mac with access granted, while the Mac is away. */
const offlineMac = provider("app_device_mac_calendar", "Calendar on Studio Mac", [
  tool("list_events", "List calendar events"),
  tool("create_event", "Create a calendar event", false),
]);
const offline: Blocked = {
  code: "runner_offline",
  message: "Studio Mac is offline.",
  next: "Continue without it and tell the person what the message says.",
};

function fixture(input: {
  readonly providers: readonly PluginHostProvider[];
  readonly grants?: Readonly<Record<string, "all" | "read-only" | "off">>;
  readonly direct?: boolean;
}) {
  const engine = {
    apps: {
      list: ({ ids }: { ids?: readonly string[] }) =>
        Effect.succeed(ids === undefined || ids.includes(gmail.id) ? [gmail] : []),
      get: () => Effect.succeed(gmail),
    },
    tools: {
      list: () =>
        Effect.succeed({
          version: gmail.activeVersion,
          accounts: { app: {}, user: {} },
          items: gmailTools,
          routers: [],
        }),
      searchable: () =>
        Effect.succeed({
          listing: ToolSearchListing.make("gmail-listing"),
          version: gmail.activeVersion,
          accounts: { app: {}, user: {} },
          routers: [],
        }),
      search: (search: ToolSearchInput) =>
        Effect.succeed({
          items: search.targets.flatMap((_, index) =>
            gmailTools
              .filter((entry) =>
                search.query
                  .toLowerCase()
                  .split(/\W+/u)
                  .filter(Boolean)
                  .every((word) =>
                    `gmail ${entry.name} ${entry.description}`.toLowerCase().includes(word),
                  ),
              )
              .map((entry) => ({ target: index, also: [], tool: entry })),
          ),
          remaining: 0,
          missing: [],
        }),
    },
  } as unknown as PluginEngine;
  const accounts = {
    accounts: () => Effect.succeed({ app: {}, user: {} }),
    resolved: () => Effect.succeed({ userLinks: {} }),
  } as unknown as ReturnType<typeof engineAccounts>;
  const calls: { plugin: string; tool: string }[] = [];
  const backend = compositeBackend(
    engine,
    accounts,
    OwnerId.make("owner"),
    { caller: "fixture", mode: "automatic" },
    {
      authorize: () => Effect.succeed({ allowed: true, grants: { ...input.grants } }),
      providers: () => Effect.succeed([...input.providers]),
      // As LocalProviders answers: what keeps the provider, or what the device said at the call.
      call: ({ plugin, tool: name }) =>
        Effect.sync((): HostToolResult => {
          calls.push({ plugin, tool: name });
          const local = input.providers.find(({ id }) => id === plugin)!;
          return { kind: "blocked", blocked: local.blocked ?? offline };
        }),
    },
    input.direct,
  );
  const search = (query: { query?: string; namespace?: string }) =>
    Effect.runPromise(searchCatalog(backend, query));
  const describe = (paths: string[]) => Effect.runPromise(describeCatalog(backend, { paths }));
  /** One program run by the engine's own execution manager, as plugin_execute runs it. */
  const program = (code: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeExecutions({
            timeoutMs: 10_000,
            maxToolCalls: 10,
            interactionTtlMs: 60_000,
          });
          return yield* manager.execute(
            "fixture",
            backend,
            executeProgram(code),
            "result",
            "client",
          );
        }),
      ),
    );
  const call = (app: string, name: string, kind: "query" | "mutation" = "query") =>
    Effect.runPromise(
      backend
        .callTool({ app: AppId.make(app), tool: ToolName.make(name), kind, input: {} })
        .pipe(
          Effect.provideService(CurrentMcpExecution, "fixture"),
          Effect.match({ onFailure: (failed) => ({ failed }), onSuccess: (value) => ({ value }) }),
        ),
    );
  return { search, describe, program, call, calls };
}

const occurrences = (value: unknown, text: string) => JSON.stringify(value).split(text).length - 1;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const namespaceOf = (local: PluginHostProvider) => localToolPath(local.slug);

describe("local apps an agent cannot use now", () => {
  it("say nothing in a search about a cloud plugin, whatever keeps them", async () => {
    const { search } = fixture({ providers: [...blockedLocal, offlineMac] });
    const found = await search({ query: "gmail" });
    expect(found.items.map(({ path }) => path)).toEqual([
      "tools.gmail.search_threads",
      "tools.gmail.send_email",
    ]);
    expect(found.namespaces).toEqual([{ path: "tools.gmail", app: "Gmail" }]);
    expect(found.unavailableApps).toEqual([]);
    expect(JSON.stringify(found)).not.toMatch(/local-|iPhone|Living Room|Studio Mac/u);
    // When each of the six failed its listing, this same search carried six unavailableApps
    // entries, each saying its reason three times: 5,625 bytes. It is 362 now.
    expect(bytes(found)).toBe(362);
  });

  it("list a blocked app's tools when a search matches them, with its reason said once", async () => {
    const { search } = fixture({ providers: blockedLocal });
    const calendar = blockedLocal[0]!;
    const reason = calendar.blocked!;
    for (const query of [{ query: "calendar events" }, { namespace: namespaceOf(calendar) }]) {
      const found = await search(query);
      expect(found.items).toEqual([
        expect.objectContaining({
          path: `${namespaceOf(calendar)}.list_events`,
          description: "List calendar events",
        }),
      ]);
      expect(found.items[0]).not.toHaveProperty("blocked");
      expect(found.namespaces).toEqual([
        { path: namespaceOf(calendar), app: calendar.name, blocked: reason },
      ]);
      expect(occurrences(found, reason.message)).toBe(1);
      expect(occurrences(found, "app_access_request")).toBe(1);
      expect(found.unavailableApps).toEqual([]);
    }
  });

  it("list nothing for a server awaiting its first launch, even when named", async () => {
    const { search } = fixture({ providers: blockedLocal });
    const tv = blockedLocal.at(-1)!;
    const found = await search({ namespace: namespaceOf(tv) });
    expect(found).toMatchObject({ items: [], unavailableApps: [] });
    expect(await search({ query: "tv" })).toMatchObject({ items: [], unavailableApps: [] });
  });

  it("refuse each call with the provider's reason and next step, each once", async () => {
    for (const local of blockedLocal.filter(({ tools }) => tools.length > 0)) {
      const name = local.tools[0]!.name;
      const program = await fixture({ providers: blockedLocal }).call(local.id, name);
      const failed = (program as { failed: InstanceType<typeof HostToolFailed> }).failed;
      expect(failed).toBeInstanceOf(HostToolFailed);
      expect(failed.code).toBe(local.blocked!.code);
      expect(failed.description).toBe(local.blocked!.message);
      expect(failed.recovery.instructions).toBe(local.blocked!.next);
      expect(occurrences([failed.description, failed.recovery], local.blocked!.message)).toBe(1);
      const direct = await fixture({ providers: blockedLocal, direct: true }).call(local.id, name);
      expect(direct).toMatchObject({
        value: {
          status: "completed",
          toolError: true,
          value: { kind: "blocked", blocked: local.blocked },
        },
      });
    }
  });

  it("make Off one marker on the namespace and refuse its calls as before", async () => {
    const calendar = blockedLocal[0]!;
    const off = { ...calendar, blocked: undefined };
    const { search, call, calls } = fixture({ providers: [off], grants: { [off.id]: "off" } });
    const found = await search({ namespace: namespaceOf(off) });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).not.toHaveProperty("blocked");
    expect(found.namespaces[0]).toMatchObject({
      blocked: { code: "access_denied", message: "This plugin is Off for agents." },
    });
    expect(await search({ query: "gmail" })).toMatchObject({ unavailableApps: [] });
    expect(await call(off.id, "list_events")).toMatchObject({
      value: { value: { kind: "blocked", blocked: { code: "access_denied" } }, toolError: true },
    });
    expect(calls).toEqual([]);
  });

  it("mark only the writes of a Read-only app, on the tools themselves", async () => {
    const { search, call } = fixture({
      providers: [offlineMac],
      grants: { [offlineMac.id]: "read-only" },
    });
    const found = await search({ namespace: namespaceOf(offlineMac) });
    expect(found.namespaces[0]).not.toHaveProperty("blocked");
    const [read, write] = found.items;
    expect(read).toMatchObject({ path: `${namespaceOf(offlineMac)}.list_events` });
    expect(read).not.toHaveProperty("blocked");
    expect(write).toMatchObject({
      path: `${namespaceOf(offlineMac)}.create_event`,
      description: "Create a calendar event",
      blocked: { code: "access_denied", message: "This plugin is set to Read-only." },
    });
    expect(await call(offlineMac.id, "create_event", "mutation")).toMatchObject({
      value: { value: { kind: "blocked", blocked: { code: "access_denied" } } },
    });
  });

  it("list an offline device's tools as usual and say it is offline at the call", async () => {
    const { search, call, calls } = fixture({ providers: [offlineMac], direct: true });
    const found = await search({ query: "calendar" });
    expect(found.items.map(({ path }) => path)).toEqual([
      `${namespaceOf(offlineMac)}.list_events`,
      `${namespaceOf(offlineMac)}.create_event`,
    ]);
    expect(JSON.stringify(found)).not.toMatch(/blocked|offline/u);
    expect(found.unavailableApps).toEqual([]);
    expect(await call(offlineMac.id, "list_events")).toMatchObject({
      value: { toolError: true, value: { kind: "blocked", blocked: offline } },
    });
    expect(calls).toEqual([{ plugin: offlineMac.id, tool: "list_events" }]);
  });

  it("mark a program's own search and describe as plugin_search and plugin_describe are marked", async () => {
    const calendar = blockedLocal[0]!;
    const { search, describe, program } = fixture({
      providers: [offlineMac, calendar],
      grants: { [offlineMac.id]: "read-only" },
    });
    const write = `${namespaceOf(offlineMac)}.create_event`;
    const readOnly = { code: "access_denied", message: "This plugin is set to Read-only." };
    const outside = {
      mac: await search({ namespace: namespaceOf(offlineMac) }),
      calendar: await search({ namespace: namespaceOf(calendar) }),
      described: await describe([write]),
    };
    const inside = await program(
      `return {
        mac: await tools.search({ namespace: ${JSON.stringify(offlineMac.slug)} }),
        calendar: await tools.search({ namespace: ${JSON.stringify(calendar.slug)} }),
        described: await tools.search.describe({ paths: [${JSON.stringify(write)}] }),
      };`,
    );
    expect(inside).toMatchObject({ status: "completed", execution: { ok: true } });
    const value = (inside as unknown as { execution: { value: typeof outside } }).execution.value;
    for (const found of [outside, value]) {
      expect(found.mac.items.find(({ path }) => path === write)).toMatchObject({
        blocked: readOnly,
      });
      expect(found.mac.items.find(({ path }) => path !== write)).not.toHaveProperty("blocked");
      expect(found.described.items).toMatchObject([{ path: write, blocked: readOnly }]);
      expect(found.calendar.namespaces).toEqual([
        expect.objectContaining({ blocked: calendar.blocked }),
      ]);
    }
    expect(value.mac.items).toEqual(outside.mac.items);
    expect(value.mac.namespaces).toEqual(outside.mac.namespaces);
    expect(value.calendar.namespaces).toEqual(outside.calendar.namespaces);
    expect(value.described.items).toEqual(outside.described.items);
  });

  it("fail a program's refused call with the Host's code, message and next step", async () => {
    const calendar = blockedLocal[0]!;
    const { program } = fixture({ providers: blockedLocal });
    const result = await program(`return await ${namespaceOf(calendar)}.list_events({});`);
    expect(result).toMatchObject({
      status: "completed",
      execution: {
        ok: false,
        error: {
          kind: "ToolFailure",
          response: {
            code: calendar.blocked!.code,
            message: calendar.blocked!.message,
            recovery: { instructions: calendar.blocked!.next },
          },
        },
      },
    });
  });

  it("name a tool the caller is kept from without its input type or signature", async () => {
    const calendar = blockedLocal[0]!;
    const { search, describe, program } = fixture({
      providers: [offlineMac, calendar],
      grants: { [offlineMac.id]: "read-only" },
    });
    const read = `${namespaceOf(offlineMac)}.list_events`;
    const write = `${namespaceOf(offlineMac)}.create_event`;
    const kept = `${namespaceOf(calendar)}.list_events`;
    const outside = {
      mac: await search({ namespace: namespaceOf(offlineMac) }),
      calendar: await search({ namespace: namespaceOf(calendar) }),
      described: await describe([read, write, kept]),
    };
    const inside = (await program(
      `return {
        mac: await tools.search({ namespace: ${JSON.stringify(offlineMac.slug)} }),
        calendar: await tools.search({ namespace: ${JSON.stringify(calendar.slug)} }),
        described: await tools.search.describe({ paths: ${JSON.stringify([read, write, kept])} }),
        global: await search({ query: "calendar events" }),
      };`,
    )) as unknown as {
      execution: {
        value: typeof outside & {
          global: { items: { path: string; description: string; signature: string }[] };
        };
      };
    };
    for (const found of [outside, inside.execution.value]) {
      // A tool it may call keeps its type; a blocked write, and every tool of a blocked app, do not.
      expect(found.mac.items.find(({ path }) => path === read)).toHaveProperty("input");
      expect(found.mac.items.find(({ path }) => path === write)).toEqual({
        path: write,
        description: "Create a calendar event",
        blocked: expect.objectContaining({ code: "access_denied" }),
      });
      expect(found.calendar.items).toEqual([{ path: kept, description: "List calendar events" }]);
      expect(found.described.items).toEqual([
        expect.objectContaining({ path: read, signature: expect.stringContaining("text") }),
        {
          path: write,
          description: "Create a calendar event",
          blocked: expect.objectContaining({ code: "access_denied" }),
        },
        { path: kept, description: "List calendar events" },
      ]);
    }
    const global = inside.execution.value.global.items;
    expect(global.find(({ path }) => path === kept)).toEqual({
      path: kept,
      description: `List calendar events\nBlocked (access_required): ${calendar.blocked!.message} Next: ${calendar.blocked!.next}`,
      signature: kept,
    });
  });
});
