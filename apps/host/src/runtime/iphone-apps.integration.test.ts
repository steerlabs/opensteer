import { localNamespace } from "../plugins/provider-names.js";
import {
  AgentConnectionStore,
  DROP_STORED_DEFINITION_API_KEY_SQL,
  IntegrationPlatformStore,
  grantedDeviceApprovals,
} from "@opensteer/database";
import type {
  ComputerAppApprovalAnswer,
  ComputerAppApprovalOutcome,
} from "./computer-apps.test-support.js";
import { channelProviderCatalog } from "@opensteer/channel-core";
import { createId } from "@opensteer/core";

import { computerAppIntegrations } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { type ComputerAppSetupSummary } from "@opensteer/integration-core/computer-app-setup";
import { type IntegrationAccess } from "@opensteer/integration-core/access";
import {
  HostIntegrationsInvokeSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  hostApi,
  runEventsCapability,
  type RunnerDescriptor,
  type ComputerAppStatusEntry,
} from "@opensteer/protocol";
import {
  createDeviceLeaveSignature,
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";

import { sql } from "kysely";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { connectAgent } from "./connected-agent.test-support.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  openAuxiliaryStream,
  pluginCall,
  requestComputerAppSetup,
  setComputerApp,
  waitForClose,
  waitForMessage,
} from "./computer-apps.test-support.js";
import {
  closed,
  configurePersonalRemoteAccess,
  connectCallerMachine,
  connectPrimary,
  createMachineAccessDatabase,
  dispatchCallerRun,
  openRealtime,
  resetMachineAccessDatabase,
  revokeMachine,
  startMachineAccessWireHost,
  waitForCondition,
  type MachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

// H1–H16, written before implementation. The phone is scripted, not Swift/EventKit.
const baseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseUrl ? describe : describe.skip;
const methods = [
  "personal.shell.get",
  "machines.list",
  "integrations.get",
  "integration.platform.get",
  "integration.computer.setup.list",
] as const;
/** A `host.resource` push names each changed kind's revision (e522ce7fd); apps live in `machine`. */
function machineRevision(message: Record<string, unknown>) {
  const revisions = message.revisions;
  return (
    message.type === "host.resource" &&
    typeof revisions === "object" &&
    revisions !== null &&
    "machine" in revisions
  );
}
const envelope = z.object({ ok: z.literal(true), data: z.unknown() });
const apps = ["apple-calendar", "apple-contacts", "apple-reminders"];
const iphoneAppAccess = {
  "apple-calendar": "read-write",
  "apple-contacts": "read",
  "apple-reminders": "read-write",
  "iphone-photos": "read",
  "iphone-location": "read",
} as const;
const mismatch = "runner-device-profile-mismatch";

integration.sequential("iPhone integrations Host contract", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let host: MachineAccessWireHost;
  let directory: string;
  const closers: (() => Promise<void>)[] = [];
  const results: { name: string; state: string; errors: string[] }[] = [];
  beforeAll(async () => {
    directory =
      process.env.OPENSTEER_IPHONE_APPS_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-iphone-apps-")));
    await mkdir(directory, { recursive: true });
    database = await createMachineAccessDatabase(baseUrl!);
    console.info(`iPhone Host evidence: ${directory}`);
  }, 120_000);
  beforeEach(async () => {
    await resetMachineAccessDatabase(database.url);
  });
  afterEach(async ({ task }) => {
    const failures: unknown[] = [];
    for (const close of closers.splice(0)) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    results.push({
      name: task.name,
      state: task.result?.state ?? "unknown",
      errors: task.result?.errors?.map(({ message }) => message) ?? [],
    });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(
        {
          boundary: "real PostgreSQL and Host; scripted phone, not Swift/EventKit",
          results,
          passed: results.every(({ state }) => state === "pass"),
        },
        null,
        2,
      ),
    );
    if (failures.length) throw new AggregateError(failures, "iPhone journey cleanup");
  }, 60_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  const start = async (manualRunner = false) => {
    host = await startMachineAccessWireHost(database.url, { remoteAccess: true, manualRunner });
    closers.unshift(() => host.close());
    return host;
  };
  const keep = <T extends { close(): Promise<void> }>(value: T): T => {
    closers.unshift(() => value.close());
    return value;
  };

  /**
   * Calendar on a Mac and on an iPhone, each turned on by the person from its device page: their
   * own request for the data app, allowed, and no task of theirs asking for it.
   */
  const calendarsTurnedOn = async (
    access: IntegrationAccess = "read",
    phoneAccess: IntegrationAccess = access,
  ) => {
    await start(true);
    // The Home's own computer is connected first, as it is whenever other devices join.
    keep(
      await connectCallerMachine(host, {
        name: "Caller",
        token: host.hostingRunnerEnrollmentToken,
      }),
    );
    const macCalls: unknown[] = [];
    // What the Mac reports of Calendar's operations: ready unless a test says otherwise.
    const macStatus: Pick<ComputerAppStatusEntry, "operations"> = status("apple-calendar");
    const mac = keep(
      await connectComputerAppMachine(
        host,
        {
          definitionId: "apple-calendar",
          platforms: ["darwin"],
          inspect: async () => macStatus.operations,
          invoke: async (...args) => {
            macCalls.push(args);
            return { calendars: [] };
          },
        },
        { device: { form: "laptop", platform: "macos" } },
      ),
    );
    const phone = keep(await connectPhone(host, (await mint(host, "data-app-phone")).token));
    const turnOn = async (
      runnerId: string,
      answer: (
        request: ComputerAppSetupSummary,
        answer: ComputerAppApprovalAnswer,
      ) => Promise<ComputerAppApprovalOutcome>,
      key: string,
      approved: IntegrationAccess,
    ) => {
      const setup = await requestComputerAppSetup(
        host,
        runnerId as never,
        approved,
        key,
        "apple-calendar",
      );
      expect(await answer(setup, { kind: "allow", setupRequestId: setup.id })).toEqual({
        kind: "allowed",
      });
      return (
        await host.store.database
          .selectFrom("integrationConnections")
          .select("id")
          .where("deviceId", "=", await host.store.requireSelfDeviceId(runnerId as never))
          .where("integrationDefinitionId", "=", "apple-calendar")
          .where("status", "=", "connected")
          .executeTakeFirstOrThrow()
      ).id;
    };
    const macCalendar = await turnOn(
      mac.runnerId,
      (r, a) => mac.answer(r.id, a),
      "mac-calendar",
      access,
    );
    const phoneCalendar = await turnOn(
      phone.runnerId,
      (r, a) => phone.answer(r, a),
      "phone-calendar",
      phoneAccess,
    );
    // Neither has a grant of the person's own agents: only the person's approval.
    expect(
      await host.store.database
        .selectFrom("integrationGrants")
        .select("id")
        .where("connectionId", "in", [macCalendar, phoneCalendar])
        .execute(),
    ).toEqual([]);
    const path = (slug: string, connectionId: string, tool = "list_calendars") =>
      `tools[${JSON.stringify(localNamespace(slug, `app_device_${connectionId}`))}].${tool}`;
    return {
      mac,
      macCalls,
      macStatus,
      phone,
      macCalendar,
      phoneCalendar,
      macPath: (tool?: string) => path("calendar-studio-mac", macCalendar, tool),
      phonePath: (tool?: string) => path("calendar-test-iphone", phoneCalendar, tool),
    };
  };
  /** One plugin call as a connected agent reads it: the tool's value, or why it failed. */
  const agentPluginCall = async (
    agent: Awaited<ReturnType<typeof connectAgent>>,
    path: string,
    input: Record<string, unknown> = {},
  ) => {
    const raw = await agent.call("plugin_call", { calls: { path, input } });
    const result = raw.structuredContent as Record<string, unknown> | undefined;
    const execution = (result?.result as { execution?: { ok?: boolean; value?: unknown } })
      ?.execution;
    const call = execution?.value as { ok?: boolean; value?: unknown; error?: unknown } | undefined;
    if (execution?.ok && call?.ok) return { value: call.value, raw };
    const error = call?.error ?? result?.error ?? raw;
    const message =
      typeof error === "object" && error !== null && "message" in error ? error.message : error;
    return { failure: typeof message === "string" ? message : JSON.stringify(message), raw };
  };

  const dentist = { title: "Dentist", start: "2026-10-01T09:00", end: "2026-10-01T10:00" };
  /** The Mac's create_event frames, which is what reaching the Mac with a write means here. */
  const creates = (calls: readonly unknown[]) =>
    calls.filter((call) => JSON.stringify(call).includes("create_event")).length;
  const waitingRequests = () =>
    host.store.database
      .selectFrom("requests")
      .select(["id", "status"])
      .where("status", "=", "pending")
      .execute();
  /** The person answers an operation's Request in Needs you. */
  const answerRequest = async (requestId: string, decision: "allow" | "deny") =>
    testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId,
        expectedRevision: (await host.store.requests.revision(requestId as never))!,
        response: { kind: "form", answers: { decision: [decision] } },
      },
      { headers: host.ownerHeaders },
    );
  /** The tools of a plugin's namespace as discover shows them to the agent. */
  const discovered = async (agent: Awaited<ReturnType<typeof connectAgent>>, name: string) => {
    const root = (await agent.call("discover", { query: name })).structuredContent as {
      items: { id: string; name: string; access?: string }[];
    };
    const item = root.items.find((entry) => entry.name === name);
    if (!item) throw new Error(`discover did not list ${name}: ${JSON.stringify(root)}`);
    return { item, detail: await agent.call("discover", { id: item.id }) };
  };

  it("asks a supervised connected agent before it writes to a data app: allowed it writes once, refused nothing", async () => {
    const world = await calendarsTurnedOn("read-write");
    const agent = keep(await connectAgent(host, { scope: "everything" }, "approval-required"));
    const { item, detail } = await discovered(agent, "Calendar on Studio Mac");
    expect(item.access).toBe("read-write");
    // Its write tools are offered as usable: supervised asks, it does not forbid.
    expect(JSON.stringify(detail)).toContain("create_event");
    expect(JSON.stringify(detail)).not.toContain("runs read-only");
    const create = (operationKey: string) =>
      agent.call("plugin_call", {
        calls: { path: world.macPath("create_event"), input: dentist },
        operationKey,
      });
    // The Host holds the call while the person is asked: exactly one Request waits and nothing
    // reached the Mac; the person's answer settles the same call.
    const asked = async (operationKey: string) => {
      const call = create(operationKey);
      await waitForCondition(async () => (await waitingRequests()).length > 0);
      const [request, ...more] = await waitingRequests();
      expect(more).toEqual([]);
      return { call, requestId: request!.id };
    };
    const allowed = await asked("supervised-create");
    expect(creates(world.macCalls)).toBe(0);
    await answerRequest(allowed.requestId, "allow");
    const done = (await allowed.call).structuredContent;
    expect(done, JSON.stringify(done)).toMatchObject({ status: "completed" });
    expect(creates(world.macCalls)).toBe(1);

    const refused = await asked("supervised-refused");
    await answerRequest(refused.requestId, "deny");
    expect(JSON.stringify(await refused.call)).toContain("The person did not allow it.");
    expect(creates(world.macCalls)).toBe(1);
    expect(await waitingRequests()).toEqual([]);
  });

  it("refuses a write a see-only data app or a read grant does not allow, asking nobody", async () => {
    const world = await calendarsTurnedOn("read", "read-write");
    const supervised = keep(await connectAgent(host, { scope: "everything" }, "approval-required"));
    const seeOnly = await agentPluginCall(supervised, world.macPath("create_event"), dentist);
    expect(seeOnly.failure, JSON.stringify(seeOnly.raw)).toBe(
      "Calendar on Studio Mac allows reading only.",
    );
    // A read grant of the person's read-write iPhone Calendar: the write is not in the grant.
    const readGrant = keep(
      await connectAgent(
        host,
        {
          scope: "selected",
          tasks: false,
          resources: [
            {
              kind: "plugin",
              target: {
                kind: "device-account",
                integrationConnectionId: world.phoneCalendar as never,
              },
              access: "read",
            },
          ],
        },
        "approval-required",
      ),
    );
    const outsideGrant = await agentPluginCall(readGrant, world.phonePath("create_event"), dentist);
    expect(outsideGrant.failure, JSON.stringify(outsideGrant.raw)).toBe(
      "That item is unavailable.",
    );
    expect(await waitingRequests()).toEqual([]);
    expect(creates(world.macCalls)).toBe(0);
    expect(creates(world.phone.invocations)).toBe(0);
  });

  it.each([
    ["Everything", { scope: "everything" }],
    ["a read-write selection", "read-write"],
  ] as const)(
    "gives tools the narrowed access when %s is narrowed to read between the lending and the standing",
    async (_, from) => {
      const world = await calendarsTurnedOn("read-write");
      const account = (access: "read" | "read-write") => ({
        scope: "selected" as const,
        tasks: false,
        resources: [
          {
            kind: "plugin" as const,
            target: {
              kind: "device-account" as const,
              integrationConnectionId: world.macCalendar as never,
            },
            access,
          },
        ],
      });
      const agent = keep(await connectAgent(host, typeof from === "string" ? account(from) : from));
      const listing = new IntegrationPlatformStore(host.store.database);
      const watched = listing.grants as unknown as {
        resolveCallableTools: (input: unknown, grants?: unknown) => Promise<unknown>;
      };
      const resolve = watched.resolveCallableTools.bind(listing.grants);
      let narrowed = false;
      watched.resolveCallableTools = async (input, grants) => {
        const resolved = await resolve(input, grants);
        if (grants !== undefined && !narrowed) {
          narrowed = true;
          const { grantRevision } = await host.store.database
            .selectFrom("agentConnections")
            .select("grantRevision")
            .where("id", "=", agent.id)
            .executeTakeFirstOrThrow();
          await new AgentConnectionStore(host.store.database).update(host.ownerId, {
            connectionId: agent.id,
            expectedRevision: grantRevision,
            grant: account("read"),
          });
        }
        return resolved;
      };
      const tools = (
        await listing.listCallableTools({ ownerUserId: host.ownerId, connectionId: agent.id })
      ).filter(({ grant }) => grant.connectionId === world.macCalendar);
      expect(narrowed).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map(({ grant }) => grant.access)).toEqual(tools.map(() => "read"));
    },
  );

  it("lends an Everything connection Calendar the person turned on from a Mac's and an iPhone's page", async () => {
    const world = await calendarsTurnedOn();
    const agent = keep(await connectAgent(host, { scope: "everything" }));
    const onMac = await agentPluginCall(agent, world.macPath());
    expect(onMac, JSON.stringify(onMac.raw)).toMatchObject({ value: { calendars: [] } });
    expect(world.macCalls).toHaveLength(1);
    const onPhone = await agentPluginCall(agent, world.phonePath());
    expect(onPhone, JSON.stringify(onPhone.raw)).toMatchObject({ value: { calendars: [] } });
    expect(world.phone.invocations).toHaveLength(1);
    // At the approval's own access: a read approval lends no change.
    const change = await agentPluginCall(agent, world.macPath("create_event"), {
      title: "Dentist",
      start: "2026-10-01T09:00",
      end: "2026-10-01T10:00",
    });
    expect(change.failure, JSON.stringify(change.raw)).toBeDefined();
    expect(world.macCalls).toHaveLength(1);
  });

  it("lends a selected connection only the data app it names; one it does not name reads as absent", async () => {
    const world = await calendarsTurnedOn();
    const agent = keep(
      await connectAgent(host, {
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "plugin",
            target: { kind: "device-account", integrationConnectionId: world.macCalendar as never },
            access: "read",
          },
        ],
      }),
    );
    const named = await agentPluginCall(agent, world.macPath());
    expect(named, JSON.stringify(named.raw)).toMatchObject({ value: { calendars: [] } });
    const unnamed = await agentPluginCall(agent, world.phonePath());
    const absentId = `con_${randomUUID()}`;
    const absent = await agentPluginCall(
      agent,
      `tools[${JSON.stringify(localNamespace("calendar-test-iphone", `app_device_${absentId}`))}].list_calendars`,
    );
    expect(unnamed.failure).toBeDefined();
    expect(unnamed.failure!.replaceAll(world.phoneCalendar, "ID")).toBe(
      absent.failure!.replaceAll(absentId, "ID"),
    );
    expect(world.phone.invocations).toHaveLength(0);
  });

  it.each(["everything", "selected"] as const)(
    "reads a %s connection's replay of an operation on a removed data app as unavailable, after it is approved again",
    async (scope) => {
      const world = await calendarsTurnedOn();
      const agent = keep(
        await connectAgent(
          host,
          scope === "everything"
            ? { scope: "everything" }
            : {
                scope: "selected",
                tasks: false,
                resources: [
                  {
                    kind: "plugin",
                    target: {
                      kind: "device-account",
                      integrationConnectionId: world.macCalendar as never,
                    },
                    access: "read",
                  },
                ],
              },
        ),
      );
      const input = { calls: { path: world.macPath(), input: {} } };
      const first = await agent.call("plugin_call", input);
      const { operationId } = first.structuredContent as { operationId?: string };
      expect(operationId, JSON.stringify(first)).toMatch(/^aop_/u);
      // The person removes Calendar from the Mac and turns it on again: a new approval.
      expect(
        (
          await command(host, {
            type: "integration.disconnect",
            idempotencyKey: randomUUID(),
            connectionId: world.macCalendar,
          })
        ).ok,
      ).toBe(true);
      const again = await requestComputerAppSetup(
        host,
        world.mac.runnerId as never,
        "read",
        "mac-calendar-again",
        "apple-calendar",
      );
      expect(await world.mac.answer(again.id, { kind: "allow", setupRequestId: again.id })).toEqual(
        { kind: "allowed" },
      );
      const replay = await agent.call("plugin_call", { ...input, operationId });
      expect(replay.structuredContent, JSON.stringify(replay)).toMatchObject({
        error: { code: "not_found", message: "Operation is unavailable." },
      });
      expect(JSON.stringify(replay)).not.toContain("calendars");
    },
  );

  it("lends nothing of a data app the person removed, or on a device that is gone", async () => {
    const world = await calendarsTurnedOn();
    const agent = keep(await connectAgent(host, { scope: "everything" }));
    expect(
      (
        await command(host, {
          type: "integration.disconnect",
          idempotencyKey: randomUUID(),
          connectionId: world.macCalendar,
        })
      ).ok,
    ).toBe(true);
    const removed = await agentPluginCall(agent, world.macPath());
    expect(removed.failure, JSON.stringify(removed.raw)).toBeDefined();
    expect(world.macCalls).toHaveLength(0);
    // A device marked removed lends nothing, whatever its rows still say: the rule reads the
    // device itself, not only the removal's revocation of its rows.
    const covered = async () =>
      (
        await grantedDeviceApprovals(host.store.database, host.ownerId, { scope: "everything" })
      ).map(({ id }) => id);
    expect(await covered()).toEqual([world.phoneCalendar]);
    await host.store.database
      .updateTable("devices")
      .set({ removedAt: new Date() })
      .where("id", "=", await host.store.requireSelfDeviceId(world.phone.runnerId as never))
      .execute();
    expect(await covered()).toEqual([]);
    const gone = await agentPluginCall(agent, world.phonePath());
    expect(gone.failure, JSON.stringify(gone.raw)).toBeDefined();
    expect(world.phone.invocations).toHaveLength(0);
  });

  it("refuses a connected agent a data app while the device's apps are off, in its own words", async () => {
    const world = await calendarsTurnedOn();
    const agent = keep(await connectAgent(host, { scope: "everything" }));
    await host.store.database
      .updateTable("devices")
      .set({
        accessPolicy: sql`${JSON.stringify({ reach: "nobody", commands: false, forwarding: false, shares: [], apps: false })}::jsonb`,
        accessPolicyRevision: sql`access_policy_revision + 1`,
      })
      .where("id", "=", await host.store.requireSelfDeviceId(world.mac.runnerId as never))
      .execute();
    const off = await agentPluginCall(agent, world.macPath());
    expect(JSON.stringify(off.raw)).toContain(
      "Apps access is off on Studio Mac. The person can turn it on in Opensteer.",
    );
    expect(JSON.stringify(off.raw)).not.toContain("computer_access_request");
    expect(world.macCalls).toHaveLength(0);
  });

  /** macOS has not yet let the Mac's helper read calendars: the person allows it on the Mac. */
  const calendarPermission =
    "Calendar needs macOS full access to calendars for Opensteer Computer Use.";
  const macPermissionMissing = async (world: Awaited<ReturnType<typeof calendarsTurnedOn>>) => {
    world.macStatus.operations = world.macStatus.operations.map((operation) => ({
      ...operation,
      state: "permission-required",
      detail: calendarPermission,
      remedy: "calendars",
    }));
    // The Mac reports its apps again, as it does when its helper's state changes.
    await world.mac.disconnectModule();
    await world.mac.reconnectModule();
    const watcher = keep(await connectAgent(host, { scope: "everything" }));
    await waitForCondition(async () => {
      const { item } = await discovered(watcher, "Calendar on Studio Mac");
      return (item as { reachable?: boolean }).reachable === false;
    });
  };
  /** What a connected agent reads for a call: the whole reply, as it is sent. */
  const reply = async (
    agent: Awaited<ReturnType<typeof connectAgent>>,
    path: string,
    input: Record<string, unknown> = {},
  ) => (await agent.call("plugin_call", { calls: { path, input } })).structuredContent;
  const permissionReply = {
    error: {
      code: "unavailable",
      message:
        "Calendar needs macOS full access to calendars for Opensteer Computer Use on Studio Mac.",
      next: "The person finishes this on Studio Mac. Tell them what the message says, and continue without Calendar on Studio Mac until then.",
    },
  };

  it.each([
    ["Everything", { scope: "everything" }],
    ["a read selection of it", "selected"],
  ] as const)(
    "tells a connected agent holding a data app (%s) the macOS permission it still needs, and that the person gives it on that device",
    async (_, grant) => {
      const world = await calendarsTurnedOn("read-write");
      const agent = keep(
        await connectAgent(
          host,
          grant === "selected"
            ? {
                scope: "selected",
                tasks: false,
                resources: [
                  {
                    kind: "plugin",
                    target: {
                      kind: "device-account",
                      integrationConnectionId: world.macCalendar as never,
                    },
                    access: "read",
                  },
                ],
              }
            : grant,
        ),
      );
      await macPermissionMissing(world);
      // Discover says the app is there and cannot be reached now; the call says why and whose
      // move it is, in the Home's words, never that it does not exist.
      expect(
        await reply(agent, world.macPath("list_events"), {
          start: "2026-11-26",
          end: "2026-11-27",
        }),
      ).toEqual(permissionReply);
      expect(await reply(agent, world.macPath())).toEqual(permissionReply);
      expect(world.macCalls).toHaveLength(0);
    },
  );

  it("reads a data app outside a connection's grant exactly like one that does not exist, while its device lacks a permission", async () => {
    const world = await calendarsTurnedOn("read-write");
    const named = (access: "read" | "read-write", connectionId: string) =>
      ({
        kind: "plugin",
        target: { kind: "device-account", integrationConnectionId: connectionId as never },
        access,
      }) as const;
    // One grant names only the iPhone's Calendar; another names the Mac's for reading only.
    const phoneOnly = keep(
      await connectAgent(host, {
        scope: "selected",
        tasks: false,
        resources: [named("read", world.phoneCalendar)],
      }),
    );
    const readOnly = keep(
      await connectAgent(host, {
        scope: "selected",
        tasks: false,
        resources: [named("read", world.macCalendar)],
      }),
    );
    await macPermissionMissing(world);
    const inventedId = `con_${randomUUID()}`;
    const invented = (tool: string) =>
      `tools[${JSON.stringify(localNamespace("calendar-studio-mac", `app_device_${inventedId}`))}].${tool}`;
    const same = (value: unknown, id: string) => JSON.stringify(value).replaceAll(id, "ID");
    // The Mac's Calendar, which the grant does not name, and an app that never existed.
    const uncovered = await phoneOnly.call("plugin_call", {
      calls: { path: world.macPath(), input: {} },
    });
    const absent = await phoneOnly.call("plugin_call", {
      calls: { path: invented("list_calendars"), input: {} },
    });
    expect(same(uncovered, world.macCalendar)).toBe(same(absent, inventedId));
    expect(JSON.stringify(uncovered)).not.toMatch(/macOS|Studio Mac|person/u);
    // A change the grant does not allow, in the app it names for reading.
    const write = await readOnly.call("plugin_call", {
      calls: { path: world.macPath("create_event"), input: dentist },
    });
    const absentWrite = await readOnly.call("plugin_call", {
      calls: { path: invented("create_event"), input: dentist },
    });
    expect(same(write, world.macCalendar)).toBe(same(absentWrite, inventedId));
    expect(JSON.stringify(write)).not.toMatch(/macOS|Studio Mac|person/u);
    expect(world.macCalls).toHaveLength(0);
  });

  it("tells a connected agent holding a data app when the device's helper is not running, or the device is offline", async () => {
    const world = await calendarsTurnedOn();
    const agent = keep(await connectAgent(host, { scope: "everything" }));
    await world.mac.disconnectModule();
    const helperDown = await agentPluginCall(agent, world.macPath());
    expect(helperDown.failure, JSON.stringify(helperDown.raw)).toBe(
      "Opensteer's integrations service is unavailable on Studio Mac.",
    );
    await world.mac.close();
    const offline = await agentPluginCall(agent, world.macPath());
    // In the words a Mac app on an offline Mac reads.
    expect(offline.failure, JSON.stringify(offline.raw)).toBe("Studio Mac is offline.");
    expect(JSON.stringify(offline.raw)).toContain(
      '"next":"The person can bring it online; other work can continue."',
    );
    expect(world.macCalls).toHaveLength(0);
  });

  it("distinguishes same-named iPhone setups, explains availability and removes only the chosen setup", async () => {
    await start();
    const addCalendar = async (key: string) => {
      const phone = keep(await connectPhone(host, (await mint(host, key)).token));
      const setup = await requestComputerAppSetup(
        host,
        phone.runnerId,
        "read",
        key,
        "apple-calendar",
      );
      expect(await phone.answer(setup, { kind: "allow", setupRequestId: setup.id })).toEqual({
        kind: "allowed",
      });
      return phone;
    };
    const earlier = await addCalendar("earlier-calendar");
    const latest = await addCalendar("latest-calendar");
    await earlier.close();
    await waitForCondition(async () =>
      (await machines(host)).some(
        ({ id, status }) => id === earlier.runnerId && status === "offline",
      ),
    );
    const local = async () =>
      (await testRpcData(host.origin, "plugins.installed.list", {}, { headers: host.ownerHeaders }))
        .local;
    expect(await local()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Calendar on Test iPhone · Setup 1",
          computer: { id: earlier.runnerId, name: "Test iPhone" },
          unavailable: "Test iPhone is offline. Open Opensteer there, and update if prompted.",
        }),
        expect.objectContaining({
          title: "Calendar on Test iPhone · Setup 2",
          computer: { id: latest.runnerId, name: "Test iPhone" },
          unavailable: "Agents need access. Request it from a task.",
        }),
      ]),
    );
    const outdated = {
      ...earlier.descriptor,
      modules: { integrations: { ...earlier.descriptor.modules.integrations, protocolVersion: 3 } },
    };
    const pluginNotices = async () =>
      (
        await host.store.database
          .selectFrom("clientSyncState")
          .select("resourceRevisions")
          .executeTakeFirstOrThrow()
      ).resourceRevisions.plugin;
    const beforeRefusal = await pluginNotices();
    expect(
      (await refusal(host, outdated, { privateKey: earlier.primary.privateKey })).frames,
    ).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ reason: "iphone-app-outdated" }),
      }),
    );
    await waitForCondition(async () => (await pluginNotices()) !== beforeRefusal);
    const stale = (await local()).find(({ computer }) => computer?.id === earlier.runnerId)!;
    expect(stale.unavailable).toBe("Update Opensteer on Test iPhone to use its apps.");

    const earlierDevice = await host.store.requireSelfDeviceId(earlier.runnerId);
    const beforeRemoval = await pluginNotices();
    await revokeMachine(host, { runnerId: earlier.runnerId, key: "remove-earlier" });
    await waitForCondition(async () => (await pluginNotices()) !== beforeRemoval);
    expect(
      (await local()).filter(({ title }) => title.startsWith("Calendar on Test iPhone")),
    ).toEqual([
      expect.objectContaining({
        title: "Calendar on Test iPhone",
        computer: { id: latest.runnerId, name: "Test iPhone" },
      }),
    ]);
    expect(
      await host.store.database
        .selectFrom("integrationConnections")
        .select("status")
        .where("deviceId", "=", earlierDevice)
        .where("integrationDefinitionId", "=", "apple-calendar")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "revoked" });
  }, 120_000);

  it.each(["fresh", "pre-overhaul installations"] as const)(
    "allows each iPhone data app with %s",
    async (scenario) => {
      await start();
      const enroll = async (key: string) => {
        const phone = keep(
          await connectPhone(host, (await mint(host, key)).token, iphoneDescriptor(), false),
        );
        await phone.report(Object.keys(iphoneAppAccess).map(status));
        return phone;
      };
      const allowApps = async (phone: Awaited<ReturnType<typeof enroll>>) => {
        for (const [definitionId, access] of Object.entries(iphoneAppAccess)) {
          const request = await requestComputerAppSetup(
            host,
            phone.runnerId,
            access,
            randomUUID(),
            definitionId,
          );
          const review = await testRpcData(
            host.origin,
            "integration.computer.setup.review",
            { setupRequestId: request.id },
            { headers: host.ownerHeaders },
          );
          expect(review.request).toMatchObject({ id: request.id, definitionId, access });
          const answer = await answerSetup(host, request.id, "allow");
          expect(answer.status, `${definitionId}: ${await answer.text()}`).toBe(200);
        }
      };
      const phone = await enroll("first-phone");
      await allowApps(phone);
      if (scenario === "fresh") return;

      // What a pre-overhaul release left: 0033 and 0034 kept these manifests and digests; 0035 corrects them.
      const legacy = await sql`
        update integration_installations
        set manifest = jsonb_set(manifest, '{definition,apiKey}', 'null'::jsonb)
        where source_kind = 'built-in' and manifest->'definition'->>'adapter' = 'computer'
      `.execute(host.store.database);
      expect(legacy.numAffectedRows).toBe(5n);
      await sql.raw(DROP_STORED_DEFINITION_API_KEY_SQL).execute(host.store.database);
      const deployment = await host.store.database
        .selectFrom("deployments")
        .select("id")
        .executeTakeFirstOrThrow();
      const proof = {
        deploymentId: deployment.id,
        issuedAt: new Date().toISOString(),
        runnerId: phone.runnerId,
      };
      const left = await host.runtime.app.inject({
        method: "POST",
        url: "/v1/runner/leave",
        payload: {
          ...proof,
          signature: createDeviceLeaveSignature(phone.primary.privateKey, proof),
        },
      });
      expect(left.statusCode, left.body).toBe(200);
      const replacement = await enroll("replacement-phone");
      expect(replacement.runnerId).not.toBe(phone.runnerId);
      await allowApps(replacement);
    },
    60_000,
  );

  it("explains why a reviewed approval can no longer be allowed", async () => {
    await start();
    const phone = keep(
      await connectPhone(
        host,
        (await mint(host, "approval-refusals")).token,
        iphoneDescriptor(),
        false,
      ),
    );
    const definitionId = "apple-calendar";
    await phone.report([status(definitionId)]);
    const request = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "refusal",
      definitionId,
    );
    const review = () =>
      testRpcRequest(
        host.origin,
        "integration.computer.setup.review",
        { setupRequestId: request.id },
        { headers: host.ownerHeaders },
      );
    expect((await review()).status).toBe(200);
    const expectRefusal = async (reason: string) => {
      const response = await answerSetup(host, request.id, "allow");
      expect(await response.json()).toMatchObject({ error: { code: "conflict", reason } });
      expect(response.status).toBe(409);
    };
    await phone.report([]);
    await expectRefusal("computer-app-not-offered");
    await phone.disconnectStream();
    await waitForCondition(
      async () => (await machines(host)).find(({ id }) => id === phone.runnerId)?.apps === null,
    );
    await expectRefusal("device-offline");
    await phone.reconnect();
    await expectRefusal("computer-app-connecting");
    await phone.report([status(definitionId)]);
    await host.store.database
      .updateTable("computerAppSetupRequests")
      .set({ definitionDigest: "older-catalog-digest" })
      .where("id", "=", request.id)
      .executeTakeFirstOrThrow();
    const stale = await answerSetup(host, request.id, "allow");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { code: "forbidden", reason: "computer-app-approval-changed" },
    });
    await sql`
      update integration_installations
      set manifest = manifest #- '{definition,authMethods}'
      where provenance->>'definitionId' = ${definitionId}
    `.execute(host.store.database);
    const invalid = await answerSetup(host, request.id, "allow");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "bad_request", reason: "computer-app-installation-invalid" },
    });
    expect((await answerSetup(host, request.id, "deny")).status).toBe(200);
    await expectRefusal("computer-app-approval-changed");
    expect(await (await review()).json()).toMatchObject({
      error: { code: "conflict", reason: "computer-app-approval-changed" },
    });

    await phone.report([status("apple-contacts")]);
    const contacts = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "contacts",
      "apple-contacts",
    );
    await host.store.database
      .updateTable("computerAppSetupRequests")
      .set({ access: "read-write" })
      .where("id", "=", contacts.id)
      .executeTakeFirstOrThrow();
    const unavailable = await answerSetup(host, contacts.id, "allow");
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "bad_request", reason: "computer-app-definition-changed" },
    });
  }, 60_000);

  it("admits new iPhone providers only after their authenticated status, without orphan approvals", async () => {
    await start();
    const phone = keep(
      await connectPhone(
        host,
        (await mint(host, "new-providers")).token,
        iphoneDescriptor(),
        false,
      ),
    );
    const requests = async () =>
      (
        await testRpcData(
          host.origin,
          "integration.computer.setup.list",
          {},
          { headers: host.ownerHeaders },
        )
      ).requests;
    const ask = (definitionId = "iphone-location") =>
      command(host, {
        type: "integration.computer.setup.request",
        idempotencyKey: randomUUID(),
        input: { kind: "app", app: null, access: "read", definitionId, runnerId: phone.runnerId },
      });
    const refuse = async (message: string) => {
      const response = await ask();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "conflict", message: expect.stringContaining(message) },
      });
      expect(await requests()).toEqual([]);
    };
    await phone.heartbeat();
    await refuse("still connecting");
    await phone.report([]);
    await refuse("doesn't offer Location");
    await phone.disconnectStream();
    await waitForCondition(
      async () => (await machines(host)).find(({ id }) => id === phone.runnerId)?.apps === null,
    );
    await refuse("keep it open");
    await phone.reconnect();
    await phone.heartbeat();
    await refuse("still connecting");
    await phone.report(
      ["iphone-location", "iphone-photos"].map((definitionId) => ({
        ...status(definitionId),
        operations: status(definitionId).operations.map((operation) => ({
          ...operation,
          state: "permission-required",
          detail: "Not allowed in iPhone Settings.",
          remedy: null,
        })),
      })),
    );
    for (const definitionId of ["iphone-location", "iphone-photos"]) {
      const response = await ask(definitionId);
      expect(response.status).toBe(200);
    }
    expect((await requests()).map(({ definitionId }) => definitionId).sort()).toEqual([
      "iphone-location",
      "iphone-photos",
    ]);
  }, 60_000);

  it("H1 H5 H15 mints isolated immutable profiles and projects pending phones truthfully", async () => {
    await start();
    const minted = await mint(host, "iphone");
    expect(await mint(host, "iphone")).toEqual(minted);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(minted.pairing).toEqual(
      await testRpcData(host.origin, "agentPhone.target.get", {}, { headers: host.ownerHeaders }),
    );
    expect(
      await host.store.database
        .selectFrom("runnerEnrollments")
        .select(["deviceProfile", "allowedModules", "ownerUserId", "runnerKind"])
        .where("id", "=", minted.enrollmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      deviceProfile: "iphone",
      allowedModules: ["browser", "integrations"],
      ownerUserId: host.ownerId,
      runnerKind: "local",
    });
    const pending = await machines(host);
    expect(pending.find(({ id }) => id === minted.enrollmentId)).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      status: "pending",
    });
    const conflict = await command(host, {
      type: "runner.enrollment.createPhone",
      name: "Test iPhone",
      idempotencyKey: "iphone",
    });
    expect(conflict.status).toBe(409);
    await mint(host, "android-first", null);
    expect(
      (
        await command(host, {
          type: "runner.enrollment.createPhone",
          profile: "iphone",
          name: "Test iPhone",
          idempotencyKey: "android-first",
        })
      ).status,
    ).toBe(409);
    const discovery = (await (
      await fetch(`${host.origin.origin}/.well-known/opensteer`)
    ).json()) as {
      capabilities: string[];
      apiVersion: number;
    };
    expect(discovery.capabilities).toContain("iphone-apps-v1");
    const phone = keep(await connectPhone(host, minted.token));
    expect(await host.store.runnerForAuthentication(phone.runnerId)).toMatchObject({
      deviceProfile: "iphone",
      allowedModules: ["browser", "integrations"],
    });
    expect((await machines(host)).find(({ id }) => id === phone.runnerId)).toMatchObject({
      device: { form: "phone", platform: "ios" },
      computerUse: null,
      name: "Test iPhone",
      status: "online",
    });
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "machine.rename",
        machineId: phone.runnerId,
        idempotencyKey: "rename-iphone",
        name: "Renamed iPhone",
      },
      { headers: host.ownerHeaders },
    );
    const reconnect = await connectPrimary(
      host.hostPort,
      { ...phone.descriptor, name: "Untrusted reconnect name", bootId: iphoneDescriptor().bootId },
      { privateKey: phone.primary.privateKey },
    );
    closers.unshift(async () => {
      reconnect.socket.close();
      await closed(reconnect.socket);
    });
    expect((await machines(host)).find(({ id }) => id === phone.runnerId)).toMatchObject({
      name: "Renamed iPhone",
      device: { form: "phone", platform: "ios" },
      computerUse: null,
    });
  });

  it("H2 H3 H16 refuses profile mismatches before consumption and on every reconnect, preserving old profiles", async () => {
    await start();
    const minted = await mint(host, "profile-negative");
    const descriptor = iphoneDescriptor();
    const shell = { platform: "darwin", hostPublicKey: "" };
    const wrong = [
      { runnerKind: "managed" },
      { device: { form: "phone", platform: "android" } },
      { device: { form: "laptop", platform: "ios" } },
      { capabilities: ["browser-page-input-v1"] },
      { device: undefined },
      {
        modules: {
          integrations: { platform: "darwin", protocolVersion: 5, computerAppApprovals: true },
        },
      },
      { modules: { integrations: { platform: "android", protocolVersion: 4 } } },
      ...Object.entries({
        ownerViewVersion: 1,
        macWindowVideoVersion: 1,
        loginText: 1,
        passwordSignIn: 2,
      }).map(([field, version]) => ({
        modules: { integrations: { ...descriptor.modules.integrations, [field]: version } },
      })),
      {
        modules: {
          integrations: descriptor.modules.integrations,
          messaging: {
            capabilities: [
              {
                provider: channelProviderCatalog[0]!.provider,
                manifest: channelProviderCatalog[0]!,
                transportKinds: channelProviderCatalog[0]!.transportKinds,
              },
            ],
          },
        },
      },
      { modules: { integrations: descriptor.modules.integrations, shell } },
      {
        capabilities: [runEventsCapability],
        modules: {
          integrations: descriptor.modules.integrations,
          agents: {
            environmentIds: [createId("environment")],
            maxConcurrentRuns: 1,
            harnessDrivers: [],
            localStorage: {
              storageAuthorityId: `lsa_${randomUUID()}`,
              bindings: [],
              truncated: false,
            },
            workspaceBackings: ["local-directory"],
          },
        },
      },
      { modules: { integrations: { ...descriptor.modules.integrations, protocolVersion: 3 } } },
    ];
    // Schema-valid shell advertisement, so this tests profile admission too.
    const ssh = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32);
    const field = (v: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(v.length);
      return Buffer.concat([length, v]);
    };
    Object.assign(shell, {
      hostPublicKey: `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(ssh)]).toString("base64")}`,
    });
    for (const patch of wrong) {
      const attempted = { ...descriptor, ...patch };
      expect(RunnerDescriptorSchema.safeParse(attempted).success, JSON.stringify(patch)).toBe(true);
      const refused = await refusal(host, attempted, { token: minted.token });
      expect(refused.close.code).toBe(4003);
      expect(refused.frames.find(({ type }) => type === "host.error")).toMatchObject({
        error: {
          code: "forbidden",
          reason: patch === wrong.at(-1) ? "iphone-app-outdated" : mismatch,
        },
      });
      expect(
        (
          await host.store.database
            .selectFrom("runnerEnrollments")
            .select("consumedAt")
            .where("id", "=", minted.enrollmentId)
            .executeTakeFirstOrThrow()
        ).consumedAt,
      ).toBeNull();
    }
    const phone = keep(await connectPhone(host, minted.token, descriptor));
    for (const patch of wrong.slice(0, -1)) {
      expect(
        (
          await refusal(host, { ...descriptor, ...patch }, { privateKey: phone.primary.privateKey })
        ).frames.find(({ type }) => type === "host.error"),
      ).toMatchObject({ error: { reason: mismatch } });
    }
    for (const platform of ["android", "darwin"] as const) {
      const oldMint = await mint(host, `old-${platform}`, null);
      const oldDescriptor = RunnerDescriptorSchema.parse({
        ...iphoneDescriptor(),
        device: {
          form: platform === "android" ? "phone" : "laptop",
          platform: platform === "android" ? "android" : "macos",
        },
        modules: { integrations: { platform, protocolVersion: platform === "android" ? 4 : 5 } },
      });
      const old = await connectPrimary(host.hostPort, oldDescriptor, { token: oldMint.token });
      closers.unshift(async () => {
        old.socket.close();
        await closed(old.socket);
      });
      expect(await host.store.runnerForAuthentication(oldDescriptor.runnerId)).toMatchObject({
        deviceProfile: null,
      });
      for (const patch of [{ device: descriptor.device }, { modules: descriptor.modules }]) {
        const spoofed = { ...oldDescriptor, ...patch };
        const fresh = await mint(host, `old-spoof-${platform}-${Object.keys(patch)[0]}`, null);
        for (const credentials of [{ token: fresh.token }, { privateKey: old.privateKey }]) {
          expect(
            (await refusal(host, spoofed, credentials)).frames.find(
              ({ type }) => type === "host.error",
            ),
          ).toMatchObject({ error: { reason: mismatch } });
        }
      }
      const before = await host.store.runnerForAuthentication(oldDescriptor.runnerId);
      const reconnected = await connectPrimary(
        host.hostPort,
        { ...oldDescriptor, bootId: iphoneDescriptor().bootId },
        { privateKey: old.privateKey },
      );
      closers.unshift(async () => {
        reconnected.socket.close();
        await closed(reconnected.socket);
      });
      expect(
        (await host.store.runnerForAuthentication(oldDescriptor.runnerId))!.connectionGeneration,
      ).toBe(before!.connectionGeneration + 1);
    }
  }, 120_000);

  it("H6 requires the current Personal remote route at mint and admission", async () => {
    host = await startMachineAccessWireHost(database.url);
    closers.unshift(() => host.close());
    expect(
      (
        await testRpcRequest(
          host.origin,
          "agentPhone.target.get",
          {},
          { headers: host.ownerHeaders },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await command(host, {
          type: "runner.enrollment.createPhone",
          profile: "iphone",
          name: "Test iPhone",
          idempotencyKey: "off",
        })
      ).status,
    ).toBe(403);
    await configurePersonalRemoteAccess(host, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    const minted = await mint(host, "personal");
    expect(minted.pairing.hostUrl).toBe("https://personal-iphone.example.test");
    await configurePersonalRemoteAccess(host, { schemaVersion: 1, mode: "off", routeOrigin: null });
    expect(
      (await refusal(host, iphoneDescriptor(), { token: minted.token })).frames.find(
        ({ type }) => type === "host.error",
      ),
    ).toMatchObject({ error: { reason: "personal-remote-access-off" } });
    expect(
      (
        await host.store.database
          .selectFrom("runnerEnrollments")
          .select("consumedAt")
          .where("id", "=", minted.enrollmentId)
          .executeTakeFirstOrThrow()
      ).consumedAt,
    ).toBeNull();
    await configurePersonalRemoteAccess(host, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal-iphone.example.test",
    });
    keep(await connectPhone(host, minted.token));
  });

  it("H4 H7 H8 H9 H13 enforces owner session approvals and revocation", async () => {
    await start();
    const admin = host.ownerHeaders;
    const phone = keep(await connectPhone(host, (await mint(host, "consent")).token));
    await waitForCondition(async () =>
      (await machines(host)).some(
        ({ id, apps: status }) => id === phone.runnerId && status?.length === 3,
      ),
    );
    expect(
      (await machines(host))
        .find(({ id }) => id === phone.runnerId)
        ?.apps?.map(({ definitionId }) => definitionId)
        .sort(),
    ).toEqual([...apps].sort());
    for (const definitionId of ["apple-messages", "android-phone"]) {
      const unsupported = await command(host, {
        type: "integration.computer.setup.request",
        idempotencyKey: randomUUID(),
        input: { kind: "app", app: null, runnerId: phone.runnerId, definitionId, access: "read" },
      });
      expect(unsupported.status).toBe(403);
      expect(await unsupported.json()).toMatchObject({
        error: { message: "This app is not supported on an iPhone." },
      });
    }
    const input = {
      kind: "app" as const,
      app: null,
      access: "read" as const,
      definitionId: "apple-calendar",
      runnerId: phone.runnerId,
    };
    expect(
      (
        await command(host, {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input,
        })
      ).status,
    ).toBe(403);
    // Administrator installs the real catalog; owner approval still required.
    const catalog = await testRpcData(
      host.origin,
      "integration.platform.get",
      {},
      { headers: admin },
    );
    const calendar = catalog.catalog.find(({ definition }) => definition.id === "apple-calendar")!;
    await host.runtime.devices.installDefinition({
      actorUserId: host.ownerId,
      definitionId: "apple-calendar",
      digest: calendar.digest!,
      requestId: "install",
    });
    const request = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read",
      "signed",
      "apple-calendar",
    );
    const allowed = request.id;
    expect(await phone.answer(request, { kind: "allow", setupRequestId: allowed })).toEqual({
      kind: "allowed",
    });
    expect(await phone.answer(request, { kind: "allow", setupRequestId: allowed })).toMatchObject({
      kind: "refused",
    });
    expect(
      (
        await command(host, {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input: { ...input, access: "read-write" },
        })
      ).status,
    ).toBe(403);
    const denied = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "deny",
      "apple-calendar",
    );
    expect(
      await phone.answer(denied, {
        kind: "deny",
        setupRequestId: denied.id,
      }),
    ).toEqual({ kind: "declined" });
    const automatic = await command(host, {
      type: "integration.computer.setup.request",
      idempotencyKey: randomUUID(),
      input: { kind: "policy", appApproval: "automatic", runnerId: phone.runnerId },
    });
    expect(automatic.status).toBe(400);
    expect(await automatic.json()).toMatchObject({
      error: {
        code: "bad_request",
        message: expect.stringContaining("Automatic approval is only for apps on a Mac."),
      },
    });
    const pluginDirectory = join(directory, "refused-plugin");
    await mkdir(pluginDirectory, { recursive: true });

    await expect(
      host.runtime.localServers.installPackage({
        actorUserId: host.ownerId,
        directory: pluginDirectory,
        registration: { name: "iphone-refusal-fixture", launch: { command: "node", args: [] } },
        requestId: "iphone-local-server-refused",
        runnerId: phone.runnerId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Local servers can't run on an iPhone.",
    });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", await host.store.requireSelfDeviceId(phone.runnerId))
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
    expect(
      (
        await command(host, {
          type: "integration.disconnect",
          idempotencyKey: randomUUID(),
          connectionId: connection.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await host.store.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("revoked");
    const revoked = waitForClose(phone.primary.socket);
    await revokeMachine(host, { runnerId: phone.runnerId, key: "iphone-revoke" });
    expect((await revoked).code).toBe(4010);
    const removed = await refusal(host, phone.descriptor, { privateKey: phone.primary.privateKey });
    expect(removed.close.code).toBe(4010);
    expect(removed.frames).toEqual([]);
  }, 120_000);

  it("H10 H11 H12 H14 H15 enforces access and arguments; loses a write once without retransmission or Mac failover; exports raw mixed responses", async () => {
    await start(true);
    const caller = keep(
      await connectCallerMachine(host, {
        name: "Caller",
        token: host.hostingRunnerEnrollmentToken,
      }),
    );
    const realtime = keep(await openRealtime(host, host.ownerHeaders, ["machine"]));
    const macCalls: unknown[] = [];
    const mac = keep(
      await connectComputerAppMachine(
        host,
        {
          definitionId: "apple-calendar",
          platforms: ["darwin"],
          inspect: async () => status("apple-calendar").operations,
          invoke: async (...args) => {
            macCalls.push(args);
            return { calendars: [] };
          },
        },
        { device: { form: "laptop", platform: "macos" } },
      ),
    );
    const phone = keep(await connectPhone(host, (await mint(host, "gateway")).token));
    const setup = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "calendar-write",
      "apple-calendar",
    );
    expect(
      await phone.answer(setup, {
        kind: "allow",
        setupRequestId: setup.id,
      }),
    ).toEqual({ kind: "allowed" });
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", await host.store.requireSelfDeviceId(phone.runnerId))
      .where("integrationDefinitionId", "=", "apple-calendar")
      .executeTakeFirstOrThrow();
    const run = await dispatchCallerRun(host, caller, {
      key: "iphone-gateway",
      title: "Calendar on iPhone",
    });
    closers.unshift(() => run.complete());
    const gateway = keep(await integrationGateway(run.integrationTools));
    await grant(host, gateway, connection.id, "read-write");
    const phoneNamespace = localNamespace("calendar-test-iphone", `app_device_${connection.id}`);
    const phoneCalendar = `tools[${JSON.stringify(phoneNamespace)}]`;
    const createEvent = { title: "no write", start: "2026-10-28T12:00", end: "2026-10-28T13:00" };
    expect((await pluginCall(gateway, `${phoneCalendar}.list_calendars`, {})).value).toEqual({
      calendars: [],
    });
    const before = phone.invocations.length;
    for (const args of [
      { start: "nonsense", end: "2026-10-29" },
      { start: "2026-10-28" },
      { start: "2026-10-28", end: "2026-10-29", unknown: true },
    ])
      expect((await pluginCall(gateway, `${phoneCalendar}.list_events`, args)).raw.isError).toBe(
        true,
      );
    expect(phone.invocations).toHaveLength(before);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "integration.computer.setup.set",
        idempotencyKey: "lower",
        input: {
          kind: "app",
          app: null,
          definitionId: "apple-calendar",
          runnerId: phone.runnerId,
          access: "read",
        },
      },
      { headers: host.ownerHeaders },
    );
    expect(
      (await pluginCall(gateway, `${phoneCalendar}.create_event`, createEvent)).raw,
    ).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "access_denied",
          message: "Calendar on Test iPhone allows reading only.",
          next: `To create_event, call app_access_request with dataApp "calendar", computerId "${phone.runnerId}" and access "read-write"; do not retry this call until it is fulfilled.`,
        },
      },
    });
    expect(phone.invocations).toHaveLength(before);
    const widen = await requestComputerAppSetup(
      host,
      phone.runnerId,
      "read-write",
      "widen",
      "apple-calendar",
    );
    expect(
      await phone.answer(widen, {
        kind: "allow",
        setupRequestId: widen.id,
      }),
    ).toEqual({ kind: "allowed" });
    // Leave a pending real Calendar request on the Mac for the older parser's manifest readers.
    const pending = await requestComputerAppSetup(
      host,
      mac.runnerId,
      "read",
      "corpus",
      "apple-calendar",
    );
    await waitForCondition(async () => realtime.messages.some(machineRevision));
    const rpc: { method: (typeof methods)[number]; data: unknown }[] = [];
    for (const method of methods) {
      const response = await testRpcRequest(
        host.origin,
        method,
        {},
        { headers: host.ownerHeaders },
      );
      expect(response.status).toBe(200);
      const data = envelope.parse(await response.json()).data;
      hostApi[method].success.parse(data);
      rpc.push({ method, data });
    }
    await writeFile(
      join(directory, "responses.json"),
      JSON.stringify(
        {
          failure: null,
          knownMachineId: mac.runnerId,
          iphoneMachineId: phone.runnerId,
          setupRequestId: pending.id,
          rpc,
          frames: realtime.messages.filter(machineRevision),
        },
        null,
        2,
      ),
    );
    await phone.disconnectStream();
    // Unreachable, its tools stay listed as they are; the call says why.
    const away = await gateway.call("plugin_search", { namespace: phoneNamespace });
    expect(away).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: `${phoneCalendar}.list_calendars` }),
      ]),
      unavailableApps: [],
    });
    expect(JSON.stringify(away)).not.toContain("blocked");
    await phone.reconnect();
    // Give the other Mac signed write approval and a live Workspace grant.
    // Losing the phone still cannot route to it.
    const macSetup = await requestComputerAppSetup(
      host,
      mac.runnerId,
      "read-write",
      "mac-write-alternative",
      "apple-calendar",
    );
    const macConnection = await setComputerApp(host, mac, macSetup, macSetup.id);
    const installation = (
      await testRpcData(host.origin, "integration.platform.get", {}, { headers: host.ownerHeaders })
    ).installations.find(
      ({ installation }) => installation.name === "apple-calendar",
    )!.installation;
    const macGrant = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "integration.grant.create",
        idempotencyKey: "alternative-mac-grant",
        input: {
          access: "read-write",
          alias: "Calendar on observation Mac",
          connectionId: macConnection.connection.id,
          installationId: installation.id,
          isDefault: false,
        },
      },
      { headers: host.ownerHeaders },
    );
    if (macGrant.type !== "integration.grant.create") throw new Error("Wrong Mac grant response");
    // The Mac's Calendar is its own provider; the phone's call below never moves to it.
    const macNamespace = localNamespace(
      "calendar-studio-mac",
      `app_device_${macConnection.connection.id}`,
    );
    await mac.heartbeat();
    expect(await gateway.call("plugin_search", { namespace: macNamespace })).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: `tools[${JSON.stringify(macNamespace)}].create_event` }),
      ]),
    });
    await phone.heartbeat();
    phone.dropWriteAnswer = true;
    const lost = await pluginCall(gateway, `${phoneCalendar}.create_event`, {
      title: "one uncertain event",
      start: "2026-10-28T12:00",
      end: "2026-10-28T13:00",
    });
    expect(lost.failure).toBe(
      "Test iPhone did not confirm this. Check whether it happened before trying again.",
    );
    expect(phone.invocations.filter(({ operation }) => operation === "create_event")).toHaveLength(
      1,
    );
    await phone.reconnect();
    await phone.heartbeat();
    expect(phone.invocations.filter(({ operation }) => operation === "create_event")).toHaveLength(
      1,
    );
    expect(macCalls).toHaveLength(0);
    await phone.disconnectStream();
    // Its tools stay listed while Opensteer is closed on it; the call says what to do.
    expect((await pluginCall(gateway, `${phoneCalendar}.list_calendars`, {})).failure).toBe(
      "Test iPhone is an iPhone, and agents can use its apps only while Opensteer is open on it. Ask the person to open Opensteer on Test iPhone, then try again; don't retry in a loop.",
    );
    await phone.close();
    await waitForCondition(
      async () =>
        (await machines(host)).find(({ id }) => id === phone.runnerId)?.status === "offline",
    );
    const offlineCall = await gateway.callRaw("plugin_call", {
      calls: { path: `${phoneCalendar}.list_calendars`, input: {} },
    });
    expect(offlineCall).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "computer_offline",
          message: "Device is offline. Do not request access.",
          next: `computerId=${phone.runnerId}, access=apps. Continue without it and tell the person what the message says.`,
        },
      },
    });
    expect(macCalls).toHaveLength(0);
    await writeFile(
      join(directory, "invocations.json"),
      JSON.stringify(
        {
          phone: phone.invocations,
          mac: macCalls,
          alternativeMac: {
            runnerId: mac.runnerId,
            connectionId: macConnection.connection.id,
            grantId: macGrant.grant.id,
            callableWrite: true,
          },
        },
        null,
        2,
      ),
    );
  }, 120_000);
});

async function command(host: MachineAccessWireHost, input: unknown, headers = host.ownerHeaders) {
  return testRpcRequest(
    host.origin,
    "commands.dispatch",
    hostApi["commands.dispatch"].payload.parse(input),
    {
      headers,
    },
  );
}
function answerSetup(
  host: MachineAccessWireHost,
  setupRequestId: string,
  decision: "allow" | "deny",
) {
  return command(host, {
    type: "integration.computer.setup.respond",
    idempotencyKey: `iphone-answer:${setupRequestId}:${randomUUID()}`,
    setupRequestId,
    decision,
  });
}
async function mint(
  host: MachineAccessWireHost,
  idempotencyKey: string,
  profile: "iphone" | null = "iphone",
) {
  const minted = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "runner.enrollment.createPhone",
      idempotencyKey,
      name: "Test iPhone",
      ...(profile ? { profile } : {}),
    },
    { headers: host.ownerHeaders },
  );
  if (minted.type !== "runner.enrollment.createPhone") throw new Error("Wrong command");
  return minted;
}
async function machines(host: MachineAccessWireHost) {
  return (await testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders }))
    .machines;
}
function iphoneDescriptor(): RunnerDescriptor {
  return RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [],
    device: { form: "phone", platform: "ios" },
    modules: { integrations: { platform: "ios", protocolVersion: 2 } },
    name: "Test iPhone",
    runnerId: createId("runner"),
    runnerKind: "local",
    runtimeVersion: "scripted-iphone",
  });
}
function status(definitionId: string) {
  const definition = computerAppIntegrations.find(({ id }) => id === definitionId);
  if (!definition || !isComputerAppDefinition(definition)) throw new Error("Missing app");
  return {
    definitionId,
    operations: definition.config.operations.map(({ name }) => ({
      operation: name,
      state: "ready" as const,
      detail: null,
      remedy: null,
    })),
  };
}
async function connectPhone(
  host: MachineAccessWireHost,
  token: string,
  descriptor = iphoneDescriptor(),
  reportOnConnect = true,
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const welcomed = waitForMessage(socket, (frame) => frame.type === "host.welcome");
  const primary = await connectPrimary(host.hostPort, descriptor, { token }, socket);
  expect(await welcomed).toMatchObject({ allowedModules: ["integrations"] });
  let stream: Awaited<ReturnType<typeof openAuxiliaryStream>>;
  const invocations: z.infer<typeof HostIntegrationsInvokeSchema>[] = [];
  const phone = {
    primary,
    descriptor,
    runnerId: descriptor.runnerId,
    invocations,
    dropWriteAnswer: false,
    async answer(
      request: ComputerAppSetupSummary,
      answer: ComputerAppApprovalAnswer,
    ): Promise<ComputerAppApprovalOutcome> {
      if (request.id !== answer.setupRequestId)
        return { kind: "refused", message: "Approval changed" };
      const response = await command(host, {
        type: "integration.computer.setup.respond",
        idempotencyKey: randomUUID(),
        setupRequestId: request.id,
        decision: answer.kind === "allow" ? "allow" : "deny",
      });
      if (!response.ok) return { kind: "refused", message: "The Host refused this decision." };
      return { kind: answer.kind === "allow" ? "allowed" : "declined" };
    },
    async disconnectStream() {
      if (stream.socket.readyState === WebSocket.CLOSED) return;
      stream.socket.close();
      await closed(stream.socket);
    },
    async close() {
      await phone.disconnectStream();
      if (primary.socket.readyState !== WebSocket.CLOSED) {
        primary.socket.close();
        await closed(primary.socket);
      }
    },
    async heartbeat() {
      const renewed = waitForMessage(
        stream.socket,
        (message) => message.type === "host.auxiliary.lease-renewed",
      );
      stream.socket.send(
        JSON.stringify({
          ...stream.fence,
          sentAt: new Date().toISOString(),
          type: "runner.auxiliary.heartbeat",
        }),
      );
      await renewed;
    },
    async report(entries: ComputerAppStatusEntry[]) {
      stream.socket.send(
        JSON.stringify({ ...stream.fence, apps: entries, type: "runner.integrations.status" }),
      );
      await phone.heartbeat();
    },
    async reconnect() {
      stream = await openAuxiliaryStream(host.hostPort, primary, "integrations");
      stream.socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; requestId?: string };
        if (frame.type === "host.integrations.invoke") {
          const invoke = HostIntegrationsInvokeSchema.parse(frame);
          invocations.push(invoke);
          if (phone.dropWriteAnswer && invoke.operation === "create_event") {
            stream.socket.close();
            return;
          }
          stream.socket.send(
            JSON.stringify({
              ...stream.fence,
              requestId: invoke.requestId,
              result: {
                kind: "ok",
                value:
                  invoke.operation === "list_calendars"
                    ? { calendars: [] }
                    : { events: [], nextCursor: null },
              },
              type: "runner.integrations.result",
            }),
          );
        }
      });
      if (reportOnConnect)
        stream.socket.send(
          JSON.stringify({
            ...stream.fence,
            apps: [...apps, "apple-messages", "macos-app", "android-phone"].map(status),
            ownerViewVersion: 1,
            displayAvailable: true,
            passwordSignIn: 2,
            type: "runner.integrations.status",
          }),
        );
    },
  };
  try {
    await phone.reconnect();
    return phone;
  } catch (error) {
    await phone.close();
    throw error;
  }
}
async function refusal(
  host: MachineAccessWireHost,
  descriptor: unknown,
  credentials: { token: string } | { privateKey: KeyObject },
) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const frames: { type: string; [key: string]: unknown }[] = [];
  const ended = waitForClose(socket, "the Host to refuse the Runner's profile");
  void ended.catch(() => undefined);
  try {
    const challenge = RunnerChallengeSchema.parse(
      await waitForMessage(socket, (frame) => frame.type === "host.challenge"),
    );
    socket.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()) as { type: string });
    });
    if ("token" in credentials) {
      const keys = generateKeyPairSync("ed25519");
      const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const credential = {
        enrollmentToken: credentials.token,
        kind: "host-enrollment-token" as const,
      };
      socket.send(
        JSON.stringify({
          type: "runner.enroll",
          proofFormatVersion: 2,
          descriptor,
          challengeId: challenge.challengeId,
          publicKeyPem,
          credential,
          signature: createRunnerEnrollmentSignature(keys.privateKey, {
            challenge,
            descriptor,
            credential,
            publicKeyPem,
          }),
        }),
      );
    } else
      socket.send(
        JSON.stringify({
          type: "runner.authenticate",
          proofFormatVersion: 2,
          descriptor,
          challengeId: challenge.challengeId,
          signature: createRunnerAuthenticationSignature(credentials.privateKey, {
            challenge,
            descriptor,
          }),
        }),
      );
    return { frames, close: await ended };
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closing = waitForClose(socket, "the refused Runner socket to terminate");
      socket.terminate();
      await closing;
    }
  }
}
async function grant(
  host: MachineAccessWireHost,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  connectionId: string,
  access: IntegrationAccess,
) {
  const held = gateway.call("app_access_request", {
    access,
    dataApp: "calendar",
    reason: "Use phone Calendar",
  });
  const pending = () =>
    host.store.integrationRequests.listPendingIntegrationAccessRequests(host.ownerId);
  await waitForCondition(async () => (await pending()).length > 0);
  const request = (await pending()).at(-1)!;
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "request.respond",
      idempotencyKey: randomUUID(),
      requestId: request.request.id,
      expectedRevision: (await host.store.requests.revision(request.request.id))!,
      response: {
        kind: "external",
        value: {
          access,
          alias: "Calendar on iPhone",
          connectionId,
          decision: "fulfilled",
          isDefault: true,
        },
      },
    },
    { headers: host.ownerHeaders },
  );
  await held;
}
