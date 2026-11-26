import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGrant } from "../packages/core/src/index.js";
import { createHelperAppProvider } from "../apps/runner/src/index.js";
import { localNamespace } from "../apps/host/src/plugins/provider-names.js";
import { connectAgent } from "../apps/host/src/runtime/connected-agent.test-support.js";
import { seedDeviceApproval } from "../apps/host/src/mcp/device-approvals.test-support.js";
import {
  connectComputerAppMachine,
  grantAccess,
  integrationGateway,
  requestComputerAppSetup,
  scriptedHelper,
  setComputerApp,
} from "../apps/host/src/runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
  waitForCondition,
} from "../apps/host/src/runtime/machine-access-protocol.test-support.js";

/**
 * What a connection is shown, swept across every tool it is listed.
 *
 * A grant that names an approval the one rule no longer lends (`grantedDeviceApprovals`: the
 * device removed, the approval blocked, revoked and made again as a new row, the app's signer
 * changed, or an app on a device the grant does not name) shows a connection exactly what a grant
 * without it shows: every reply, byte for byte, ids aside. And what the rule does lend but cannot
 * reach now (the Apps switch off, the device offline, a macOS permission missing, the helper not
 * running) is listed with the reason its call gives, for a connected agent and for a Run of the
 * person's own agents alike, and asks the person nothing.
 */

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;

type Agent = Awaited<ReturnType<typeof connectAgent>>;
/** A value standing in for an id that each grant names differently: resolved per grant. */
type Named = "calendar" | "notes" | "device" | "app" | "namespace";
type Value = string | { readonly named: Named; readonly form?: (value: string) => string };
type Args = Record<string, unknown>;

const notesBundle = "com.apple.notes";
const calendarSlug = "calendar-studio-mac";
const calendarTools = ["list_calendars", "list_events", "create_event"] as const;
const dentist = { title: "Dentist", start: "2026-10-01T09:00", end: "2026-10-01T10:00" };
const day = { start: "2026-11-26", end: "2026-11-27" };
const inputOf = (tool: string) =>
  tool === "create_event" ? dentist : tool === "list_events" ? day : {};

/** A discover id for a Mac app, as discover makes it. */
const appId = (deviceId: string, bundleId: string) =>
  `app:${Buffer.from(JSON.stringify([deviceId, bundleId])).toString("base64url")}`;
/** The engine's namespace for a data app approval. */
const namespaceOf = (approvalId: string) =>
  localNamespace(calendarSlug, `app_device_${approvalId}`);
/** A tool's path in each form the engine takes: dot, bracket, and with its name escaped. */
const pathForms = (namespace: string, tool: string) => [
  `tools[${JSON.stringify(namespace)}].${tool}`,
  `tools[${JSON.stringify(namespace)}][${JSON.stringify(tool)}]`,
  `tools[${JSON.stringify(namespace)}].${tool.replaceAll("_", "%5F")}`,
];

/** Fields that carry no id: the sweep never puts one there. */
const notAnId = new Set([
  "code",
  "reason",
  "operationKey",
  "message",
  "title",
  "detail",
  "query",
  "cursor",
  "readOnly",
  "delivery",
  "freshContext",
  "mode",
  "timeoutMs",
  "view",
  "limit",
  "runLimit",
  "maxCharsPerItem",
  "textOffset",
  "questions",
  "calls",
  "command",
  "area",
]);

/**
 * Every tool a connection can be listed, with the calls the sweep makes of it besides one with
 * each id the fixtures know in each of its id fields. A tool a connection is listed that is not
 * here fails the sweep: it must say what it shows before it ships.
 */
const sweep: Record<string, (ids: readonly Value[]) => Args[]> = {
  // A valid question asks the person; its plain and id-carrying calls are swept.
  ask_person: () => [{}],
  discover: (ids) => [
    {},
    { query: "Calendar" },
    { query: "Notes" },
    { query: "Studio Mac" },
    ...ids.map((id) => ({ id })),
  ],
  opensteer_commands: () => [{}, { family: "devices" }, { family: "apps" }, { type: "x" }],
  opensteer_command: () => [{}, { command: { type: "x" } }],
  opensteer_state: () =>
    ["settings", "connections", "devices", "engines", "requests", "activity", "problems"].map(
      (area) => ({ area }),
    ),
  browser_connect: () => [{}],
  browser_use: () => [{ code: "return 1" }],
  // A valid ask opens a Request: the plain and id-carrying calls are swept.
  saved_login_request: () => [{}],
  card_request: () => [{}],
  computer_use: (ids) => [
    {},
    ...ids.flatMap((computerId) =>
      [{ named: "app" } as const, notesBundle, "Notes"].map((app) => ({
        code: "help()",
        computerId,
        app,
        readOnly: true,
      })),
    ),
  ],
  plugin_call: (ids) => ids.map((path) => ({ calls: { path, input: {} } })),
  // A program's Request is for running the program; a blocked tool inside fails with its own
  // reason without reaching the device. No narrower rule: the sweep only asks that a program
  // naming what is not lent reads as one naming what does not exist.
  plugin_execute: (ids) =>
    ids.map((path) => ({
      namespace: { named: "namespace" },
      code: `try { return await ${typeof path === "string" ? path : "tools.x.y"}({}); } catch (error) { return String(error); }`,
    })),
  plugin_resume: () => [{}],
  opensteer_task_create: () => [{}],
  opensteer_task_read: () => [{}],
  opensteer_task_send: () => [{}],
  opensteer_task_wait: () => [{}],
  opensteer_task_interrupt: () => [{}],
};
/** Names a connection is no longer listed: each reads as unknown, whatever it names. */
const retired = [
  "tab_list",
  "tab_open",
  "computer_list",
  "computer_apps",
  "browser_profile_list",
  "plugin_search",
  "plugin_describe",
  "opensteer_plugin_list",
];

integration("what a connection is shown", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
  }, 120_000);
  afterAll(async () => database?.drop(), 120_000);
  beforeEach(async () => resetMachineAccessDatabase(database!.url));
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  }, 60_000);
  const keep = <T extends { close(): Promise<void> }>(value: T): T => {
    closers.unshift(() => value.close());
    return value;
  };

  /**
   * The Home's own computer, which homes a browser profile; Studio Mac with Calendar (a data app,
   * through the helper) and Notes (a Mac app), each approved by the person.
   */
  async function world() {
    const host = await startMachineAccessWireHost(database!.url, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => host.close());
    const caller = keep(
      await connectCallerMachine(host, {
        name: "Caller",
        token: host.hostingRunnerEnrollmentToken,
      }),
    );
    const helper = scriptedHelper();
    helper.grants.calendars = "granted";
    const computer = keep(
      await connectComputerAppMachine(
        host,
        [createHelperAppProvider("apple-calendar", helper.port)],
        { statusIntervalMs: 200 },
      ),
    );
    const approveCalendar = async (key: string) => {
      const setup = await requestComputerAppSetup(
        host,
        computer.runnerId,
        "read-write",
        key,
        "apple-calendar",
      );
      return (await setComputerApp(host, computer, setup, setup.id)).connection.id;
    };
    const calendar = await approveCalendar("calendar");
    const mac = await host.store.requireSelfDeviceId(computer.runnerId as never);
    const callerDevice = await host.store.requireSelfDeviceId(caller.runnerId as never);
    const seedNotes = async () => {
      const id = `con_${randomUUID()}`;
      await seedDeviceApproval(host.store.database, {
        id,
        ownerUserId: host.ownerId,
        deviceId: mac,
        name: "Notes",
        app: { bundleId: notesBundle, displayName: "Notes" },
      });
      return id;
    };
    const notes = await seedNotes();
    const profileId = `bpr_${randomUUID()}`;
    await host.store.database
      .insertInto("browserProfiles")
      .values({
        id: profileId as never,
        ownerId: host.ownerId,
        homeRunnerId: caller.runnerId,
        name: "Work",
      } as never)
      .execute();
    const waitingRequests = () =>
      host.store.database
        .selectFrom("requests")
        .select("id")
        .where("status", "=", "pending")
        .execute();
    return {
      host,
      caller,
      helper,
      computer,
      calendar,
      notes,
      mac,
      callerDevice,
      profileId,
      approveCalendar,
      seedNotes,
      waitingRequests,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** What a grant names of the person's approvals, resolved to ids and the ids derived from them. */
  interface Naming {
    readonly calendar?: string;
    readonly notes?: { readonly id: string; readonly device: string; readonly teamId?: string };
  }
  const grantOf = (profileId: string, naming: Naming): AgentGrant =>
    ({
      scope: "selected",
      tasks: false,
      resources: [
        { kind: "browser-profile", profileId },
        ...(naming.notes
          ? [
              {
                kind: "computer-app",
                approvalId: naming.notes.id,
                deviceId: naming.notes.device,
                app: {
                  kind: "mac-app",
                  bundleId: notesBundle,
                  teamId: naming.notes.teamId ?? null,
                },
              },
            ]
          : []),
        ...(naming.calendar
          ? [
              {
                kind: "plugin",
                target: { kind: "device-account", integrationConnectionId: naming.calendar },
                access: "read-write",
              },
            ]
          : []),
      ],
    }) as AgentGrant;
  /** Each id a grant names, and each id derived from one, with the placeholder it reads as. */
  const namedValues = (naming: Naming): Partial<Record<Named, string>> => ({
    ...(naming.calendar
      ? { calendar: naming.calendar, namespace: namespaceOf(naming.calendar) }
      : {}),
    ...(naming.notes
      ? {
          notes: naming.notes.id,
          device: naming.notes.device,
          app: appId(naming.notes.device, notesBundle),
        }
      : {}),
  });
  /** A reply with what each grant names in its own ids read as the same placeholders. */
  const normalised = (reply: unknown, values: Partial<Record<Named, string>>, own: string) => {
    let text = JSON.stringify(reply) ?? "undefined";
    const replacements: [string, string][] = [
      ...Object.entries(values).map(([name, value]) => [value!, `<${name}>`] as [string, string]),
      [own, "<connection>"],
    ];
    for (const [value, placeholder] of replacements.sort((a, b) => b[0].length - a[0].length))
      text = text
        .replaceAll(value, placeholder)
        .replaceAll(JSON.stringify(value).slice(1, -1), placeholder);
    return (
      text
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<time>")
        // What each call mints for itself: a task for the work and its operation.
        .replace(/\b(thr|aop|opr)_[0-9a-f-]{36}\b/gu, "<$1>")
    );
  };
  /** Where two replies first part, with a little of each around it. */
  const parting = (left: string, right: string) => {
    let at = 0;
    while (at < left.length && left[at] === right[at]) at++;
    return `\n  A: …${left.slice(Math.max(0, at - 120), at + 280)}\n  vs …${right.slice(Math.max(0, at - 120), at + 280)}`;
  };
  /** One call as the agent reads it: its reply, or what refused it. */
  const reply = (agent: Agent, tool: string, args: Args) =>
    agent.call(tool, args).catch((error: unknown) => ({
      refused: error instanceof Error ? error.message : String(error),
    }));
  /** The call's arguments with what each grant names resolved to that grant's own ids. */
  const resolve = (value: unknown, values: Partial<Record<Named, string>>): unknown => {
    if (Array.isArray(value)) return value.map((each) => resolve(each, values));
    if (value && typeof value === "object") {
      if ("named" in value && typeof value.named === "string") {
        const named = value as { named: Named; form?: (value: string) => string };
        const id = values[named.named] ?? `missing-${named.named}`;
        return named.form ? named.form(id) : id;
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, each]) => [key, resolve(each, values)]),
      );
    }
    return value;
  };

  const invalidations: readonly [
    string,
    (world: World) => Promise<{ readonly naming: Naming; readonly known: readonly string[] }>,
  ][] = [
    [
      "the device is removed",
      async (w) => {
        await w.host.store.database
          .updateTable("devices")
          .set({ removedAt: new Date() })
          .where("id", "=", w.mac as never)
          .execute();
        return {
          naming: { calendar: w.calendar, notes: { id: w.notes, device: w.mac } },
          known: [],
        };
      },
    ],
    [
      "the device belongs to someone else",
      async (w) => {
        const other = `usr_${randomUUID()}`;
        await w.host.store.database
          .insertInto("users")
          .values({
            id: other,
            displayName: "Other",
            email: `other-${other}@invalid.test`,
            emailVerified: true,
          } as never)
          .execute();
        await w.host.store.database
          .updateTable("devices")
          .set({ ownerUserId: other } as never)
          .where("id", "=", w.mac as never)
          .execute();
        return {
          naming: { calendar: w.calendar, notes: { id: w.notes, device: w.mac } },
          known: [],
        };
      },
    ],
    [
      "the approval is blocked",
      async (w) => {
        await w.host.store.database
          .updateTable("integrationConnections")
          .set({ computerBlockedAt: new Date() })
          .where("id", "in", [w.calendar, w.notes] as never)
          .execute();
        return {
          naming: { calendar: w.calendar, notes: { id: w.notes, device: w.mac } },
          known: [],
        };
      },
    ],
    [
      "the approval was revoked and made again as a new row",
      async (w) => {
        await w.host.store.database
          .updateTable("integrationConnections")
          .set({ status: "revoked" })
          .where("id", "in", [w.calendar, w.notes] as never)
          .execute();
        const calendar = await w.approveCalendar("calendar-again");
        const notes = await w.seedNotes();
        // The new rows are the person's and lent to Everything; the grant names the old ones.
        expect([calendar, notes]).not.toContain(w.calendar);
        return {
          naming: { calendar: w.calendar, notes: { id: w.notes, device: w.mac } },
          known: [
            calendar,
            notes,
            namespaceOf(calendar),
            ...calendarTools.flatMap((tool) => pathForms(namespaceOf(calendar), tool)),
          ],
        };
      },
    ],
    [
      "the app's signer changed",
      async (w) => {
        await w.host.store.database
          .updateTable("integrationConnections")
          .set({
            computerApp: sql`jsonb_set(computer_app, '{teamId}', '"NEWSIGNER1"')`,
          } as never)
          .where("id", "=", w.notes as never)
          .execute();
        return { naming: { notes: { id: w.notes, device: w.mac } }, known: [] };
      },
    ],
    [
      "the grant names the app on another device",
      async (w) => ({ naming: { notes: { id: w.notes, device: w.callerDevice } }, known: [] }),
    ],
  ];

  it.each(invalidations)(
    "shows a grant naming an approval the rule does not lend (%s) exactly what a grant without it shows",
    async (_, invalidate) => {
      const w = await world();
      const everything = keep(await connectAgent(w.host, { scope: "everything" }));
      // Every id the fixtures know, as an Everything connection is shown them before the change.
      const harvested = new Set<string>([w.calendar, w.notes, w.mac, w.callerDevice, w.profileId]);
      const root = (await everything.call("discover", {})).structuredContent as {
        items: { id: string }[];
      };
      for (const { id } of root.items) {
        harvested.add(id);
        const detail = (await everything.call("discover", { id })).structuredContent as {
          items?: { id: string }[];
        };
        for (const item of detail.items ?? []) harvested.add(item.id);
      }
      const { naming, known } = await invalidate(w);
      for (const id of known) harvested.add(id);
      // Grant A names the approval; B names only the browser profile; C names, in A's shape, an
      // approval and a device that never existed.
      const invented: Naming = {
        ...(naming.calendar ? { calendar: `con_${randomUUID()}` } : {}),
        ...(naming.notes
          ? {
              notes: {
                id: `con_${randomUUID()}`,
                device: `rnr_${randomUUID()}`,
                ...(naming.notes.teamId ? { teamId: naming.notes.teamId } : {}),
              },
            }
          : {}),
      };
      const grants = {
        a: { naming, values: namedValues(naming) },
        b: { naming: {}, values: namedValues(naming) },
        c: { naming: invented, values: namedValues(invented) },
      };
      const agents = {
        a: keep(await connectAgent(w.host, grantOf(w.profileId, grants.a.naming))),
        b: keep(await connectAgent(w.host, grantOf(w.profileId, grants.b.naming))),
        c: keep(await connectAgent(w.host, grantOf(w.profileId, grants.c.naming))),
      };
      const listed = {
        a: new Set((await agents.a.tools()).map(({ name }) => name)),
        b: new Set((await agents.b.tools()).map(({ name }) => name)),
        c: new Set((await agents.c.tools()).map(({ name }) => name)),
      };
      // The tool list follows what the grant names, not what is lent: A's is C's.
      expect([...listed.a].sort()).toEqual([...listed.c].sort());
      const stateOfB = (await agents.b.tools()).find(({ name }) => name === "opensteer_state");
      const areasOfB = new Set(
        (stateOfB?.inputSchema as { properties?: { area?: { enum?: string[] } } } | undefined)
          ?.properties?.area?.enum ?? [],
      );
      const schemas = new Map(
        [...(await agents.a.tools()), ...(await everything.tools())].map((tool) => [
          tool.name,
          tool,
        ]),
      );
      // A connection-facing tool the sweep does not know fails here.
      expect([...schemas.keys()].filter((name) => !(name in sweep))).toEqual([]);

      // What each id-carrying call names: the fixtures' ids, and what each grant names, as that
      // grant's own (an id built from one A names is named that way, so each grant echoes its own).
      const own = Object.values(grants.a.values);
      const fixtures = [...harvested].filter((id) => !own.some((value) => id.includes(value!)));
      const ids: Value[] = [
        ...fixtures,
        { named: "calendar" },
        { named: "notes" },
        { named: "device" },
        { named: "app" },
        { named: "namespace", form: (namespace) => `tools[${JSON.stringify(namespace)}]` },
      ];
      const paths: Value[] = [
        ...ids.filter((id) => typeof id !== "string" || id.startsWith("tools")),
        ...calendarTools.flatMap((tool) =>
          [0, 1, 2].map((form) => ({
            named: "namespace" as const,
            form: (namespace: string) => pathForms(namespace, tool)[form]!,
          })),
        ),
      ];
      const calls: [string, Args][] = [];
      for (const name of [...listed.a, ...retired]) {
        const plain = sweep[name]?.(
          name.startsWith("plugin_") || name === "discover" ? paths.concat(ids) : ids,
        ) ?? [{}];
        for (const args of plain) calls.push([name, args]);
        const properties = Object.keys(
          (schemas.get(name)?.inputSchema as { properties?: Record<string, unknown> } | undefined)
            ?.properties ?? {},
        ).filter((property) => !notAnId.has(property));
        for (const property of properties)
          for (const id of ids) calls.push([name, { ...plain[0], [property]: id }]);
      }
      // A plugin call with each tool's own input, reads and a write.
      for (const tool of calendarTools)
        for (const form of [0, 1, 2])
          calls.push([
            "plugin_call",
            {
              calls: {
                path: {
                  named: "namespace",
                  form: (namespace: string) => pathForms(namespace, tool)[form]!,
                },
                input: inputOf(tool),
              },
            },
          ]);

      // Connecting the browser profile itself starts its browser, which this Home has none of: it
      // names no approval and is the same profile in every grant, so it is not swept.
      const startsTheProfile = ([name, args]: [string, Args]) =>
        name === "browser_connect" &&
        (args.profileId === w.profileId || (args.profileId === undefined && !args.tabId));
      const swept = calls.filter((call) => !startsTheProfile(call));
      const seen = { a: 0, b: 0, c: 0 };
      for (let start = 0; start < swept.length; start += 16)
        await Promise.all(
          swept.slice(start, start + 16).map(async ([name, args]) => {
            const replyOf = async (key: "a" | "b" | "c") => {
              const values = grants[key].values;
              const raw = await reply(agents[key], name, resolve(args, values) as Args);
              return normalised(raw, values, agents[key].id);
            };
            const [a, b, c] = await Promise.all([replyOf("a"), replyOf("b"), replyOf("c")]);
            const label = `${name} ${JSON.stringify(resolve(args, grants.a.values))}`;
            // Against a grant naming an approval that never existed: always the same.
            expect(a === c, `${label} (C)${parting(a, c)}`).toBe(true);
            seen.c++;
            // Against the browser profile alone: the same wherever both are listed the tool, and
            // the reply is not the connection's own grant (what the person consented to, as the
            // tool list is: that it names an approval is the grant, not what is lent).
            const ownGrant = name === "opensteer_state" && args.area === "connections";
            // The devices area, like computer_use, is there for a grant that names a device app.
            const shape = name === "opensteer_state" && !areasOfB.has(String(args.area));
            if (listed.a.has(name) === listed.b.has(name) && !ownGrant && !shape) {
              expect(a === b, `${label} (B)${parting(a, b)}`).toBe(true);
              seen.b++;
            }
            seen.a++;
          }),
        );
      expect(seen.b).toBeGreaterThan(0);
      // Nothing reached the device, and no one was asked.
      expect(w.helper.invocations).toEqual([]);
      expect(await w.waitingRequests()).toEqual([]);
    },
  );

  /** What the Home says keeps a call from running, as a connected agent or a Run reads it. */
  const callError = (raw: unknown) => {
    const result = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    const execution = (result?.result as { execution?: { value?: { error?: unknown } } })
      ?.execution;
    return execution?.value?.error ?? result?.error;
  };
  const states: readonly [string, (world: World) => Promise<void>][] = [
    [
      "the device's Apps switch is off",
      async (w) => {
        await w.host.store.database
          .updateTable("devices")
          .set({
            accessPolicy: sql`jsonb_set(access_policy, '{apps}', 'false')`,
            accessPolicyRevision: sql`access_policy_revision + 1`,
          } as never)
          .where("id", "=", w.mac as never)
          .execute();
      },
    ],
    ["the device is offline", (w) => w.computer.close()],
    [
      "a macOS permission is missing",
      async (w) => {
        w.helper.grants.calendars = "requestable";
      },
    ],
    ["the helper is not running", (w) => w.computer.disconnectModule()],
  ];

  it.each(states)(
    "lists a data app that is lent but cannot be reached (%s) with its call's reason, to a connected agent and a Run, asking no one",
    async (_, change) => {
      const w = await world();
      // A supervised connected agent holding Calendar, and a supervised Run of the person's own
      // agents whose task was given it.
      const agent = keep(
        await connectAgent(
          w.host,
          grantOf(w.profileId, { calendar: w.calendar }),
          "approval-required",
        ),
      );
      const first = await dispatchCallerRun(w.host, w.caller, { key: "calendar", title: "Plan" });
      const firstGateway = keep(await integrationGateway(first.integrationTools));
      await grantAccess(w.host, firstGateway, {
        access: "read-write",
        connectionId: w.calendar,
        integration: "apple-calendar",
      });
      await first.complete();
      await w.host.store.updateThreadAccessMode({
        threadId: first.threadId,
        requestedBy: w.host.ownerId,
        accessMode: "approval-required",
      });
      const run = await dispatchCallerRun(w.host, w.caller, {
        key: "calendar-supervised",
        title: "Plan",
        threadId: first.threadId,
      });
      closers.unshift(() => run.complete());
      const gateway = keep(await integrationGateway(run.integrationTools));
      const namespace = `tools[${JSON.stringify(namespaceOf(w.calendar))}]`;
      const path = (tool: string) => pathForms(namespaceOf(w.calendar), tool)[0]!;
      /** Each tool's reason, as the listing says it and as its call says it. */
      const reasons = async () => {
        const page = (await agent.call("discover", { id: namespace })).structuredContent as {
          items?: { id: string; blocked?: unknown }[];
        };
        const search = (await gateway.call("plugin_search", { query: "calendar" })) as {
          items: { path: string; blocked?: unknown }[];
          namespaces: { blocked?: unknown }[];
        };
        const appBlocked = search.namespaces.find(({ blocked }) => blocked)?.blocked;
        return Promise.all(
          calendarTools.map(async (tool) => ({
            tool,
            connection: {
              listed: page.items?.find(({ id }) => id === path(tool))?.blocked,
              called: callError(
                await agent.call("plugin_call", {
                  calls: { path: path(tool), input: inputOf(tool) },
                }),
              ),
            },
            run: {
              listed: search.items.find((item) => item.path === path(tool))?.blocked ?? appBlocked,
              called: callError(
                await gateway.callRaw("plugin_call", {
                  calls: { path: path(tool), input: inputOf(tool) },
                }),
              ),
            },
          })),
        );
      };
      await change(w);
      let last: unknown;
      await waitForCondition(async () => {
        const seen = await reasons();
        last = seen;
        return seen.every(({ connection, run }) => connection.listed && run.listed);
      }).catch((error: unknown) => {
        throw new Error(`${String(error)}: ${JSON.stringify(last)}`);
      });
      for (const { tool, connection, run } of await reasons()) {
        expect(connection.listed, `${tool}: ${JSON.stringify(connection)}`).toEqual(
          connection.called,
        );
        expect(run.listed, `${tool}: ${JSON.stringify(run)}`).toEqual(run.called);
      }
      expect(w.helper.invocations).toEqual([]);
      expect(await w.waitingRequests()).toEqual([]);
    },
  );

  /** Every statement this process sends while `action` runs. */
  const statements = async (action: () => Promise<unknown>) => {
    const sent: string[] = [];
    const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
    const query = prototype.query;
    const spy = vi.spyOn(prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0];
      sent.push(
        typeof first === "string"
          ? first
          : first && typeof first === "object" && "text" in first
            ? String(first.text)
            : "",
      );
      return Reflect.apply(query, this, args);
    });
    try {
      await action();
    } finally {
      spy.mockRestore();
    }
    return sent;
  };

  it("lists a Run's data apps with no read of each device on the healthy path (rule 7)", async () => {
    const w = await world();
    const run = await dispatchCallerRun(w.host, w.caller, { key: "cost", title: "Plan" });
    closers.unshift(() => run.complete());
    const gateway = keep(await integrationGateway(run.integrationTools));
    await grantAccess(w.host, gateway, {
      access: "read-write",
      connectionId: w.calendar,
      integration: "apple-calendar",
    });
    // Warm, as a Run's first listing is.
    await gateway.call("plugin_search", { query: "calendar" });
    const sent = await statements(() => gateway.call("plugin_search", { query: "calendar" }));
    console.info(`A Run's plugin_search sends ${sent.length} statements.`);
    // The device's switch and name come with the approval's row the listing reads anyway; its
    // state is the Home's own. No statement reads a device by itself.
    expect(
      sent.filter((sql) => /^select [^;]*from "devices" where "id" = \$1/su.test(sql)),
    ).toEqual([]);
  });
});
