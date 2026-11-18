import { localNamespace } from "../apps/host/src/plugins/provider-names.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerAppHub } from "../apps/host/src/computer-apps/computer-app-hub.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ComputerUseBridgeError, createHelperAppProvider } from "../apps/runner/src/index.js";
import { TriggerStore } from "../packages/database/src/index.js";
import { DeviceToolHandlers } from "../apps/host/src/mcp/handlers/devices.js";
import { AccessRequests } from "../apps/host/src/devices/access-requests.js";
import { deviceDefinitions } from "../packages/integration-catalog/src/devices.js";
import type { AgentCaller } from "../apps/host/src/mcp/agent-caller.js";
import type { ThreadId } from "../packages/core/src/index.js";
import { pluginFixtureFiles, pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  contractOf,
  expectPluginSettingRefusal,
  grantAccess,
  integrationGateway,
  pluginCall,
  pluginPath,
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

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
let registryDirectory: string;
let registry: Awaited<ReturnType<typeof pluginFixtureRegistry>>;

integration("device data apps as plugin tools", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
    registryDirectory = await mkdtemp(join(tmpdir(), "opensteer-device-plugins-"));
    registry = await pluginFixtureRegistry(registryDirectory, undefined, pluginFixtureFiles(1));
  }, 120_000);
  afterAll(async () => {
    await registry?.close();
    await rm(registryDirectory, { recursive: true, force: true });
    await database?.drop();
  }, 120_000);
  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  }, 60_000);

  async function start() {
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
      pluginEngine: {
        npmRegistry: registry.origin,
        catalogUrl: `${registry.origin}/catalog`,
        selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
      },
    });
    closers.unshift(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const helper = scriptedHelper();
    helper.grants.calendars = "granted";
    helper.grants.reminders = "granted";
    const computer = await connectComputerAppMachine(
      host,
      [
        createHelperAppProvider("apple-calendar", helper.port),
        createHelperAppProvider("apple-reminders", helper.port),
      ],
      { statusIntervalMs: 200 },
    );
    closers.unshift(() => computer.close());
    const calendarSetup = await requestComputerAppSetup(
      host,
      computer.runnerId,
      "read",
      "calendar-read",
      "apple-calendar",
    );
    const calendar = await setComputerApp(host, computer, calendarSetup, calendarSetup.id);
    const remindersSetup = await requestComputerAppSetup(
      host,
      computer.runnerId,
      "read-write",
      "reminders-write",
      "apple-reminders",
    );
    const reminders = await setComputerApp(host, computer, remindersSetup, remindersSetup.id);
    const run = await dispatchCallerRun(host, caller, { key: "device-plugins", title: "Plan" });
    closers.unshift(() => run.complete());
    const gateway = await integrationGateway(run.integrationTools);
    closers.unshift(() => gateway.close());
    await grantAccess(host, gateway, {
      access: "read",
      connectionId: calendar.connection.id,
      integration: "apple-calendar",
    });
    await grantAccess(host, gateway, {
      access: "read-write",
      connectionId: reminders.connection.id,
      integration: "apple-reminders",
    });
    return { host, helper, computer, gateway, calendar, reminders, run };
  }

  it("refuses device plugin access revoked while waiting for Device admission", async () => {
    const { host, helper, gateway, calendar } = await start();
    const path = await pluginPath(gateway, "list_events", "list_events");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = ComputerAppHub.prototype.withDeviceAdmission;
    const admission = vi
      .spyOn(ComputerAppHub.prototype, "withDeviceAdmission")
      .mockImplementationOnce(async function (this: ComputerAppHub, device, work) {
        entered.resolve();
        await withTimeout(release.promise, 10000, {
          timeoutError: () => new Error("Device admission was not released"),
        });
        return original.call(this, device, work);
      });
    const before = helper.invocations.length;
    let pending: ReturnType<typeof gateway.call> | undefined;
    try {
      pending = gateway.call("plugin_call", {
        calls: { path, input: { start: "2026-10-01", end: "2026-10-02" } },
      });
      void pending.catch(() => undefined);
      await withTimeout(entered.promise, 10000, {
        timeoutError: () => new Error("Device call did not enter admission"),
      });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "plugins.access.set",
          idempotencyKey: randomUUID(),
          pluginId: `app_device_${calendar.connection.id}`,
          access: "off",
        },
        { headers: host.ownerHeaders },
      );
      release.resolve();
      expect(
        JSON.stringify(
          await withTimeout(pending, 10000, {
            timeoutError: () => new Error("Revoked device call did not end"),
          }),
        ),
      ).toMatch(/authority changed|unavailable/iu);
      expect(helper.invocations).toHaveLength(before);
    } finally {
      release.resolve();
      admission.mockRestore();
      if (pending)
        await withTimeout(
          pending.catch(() => undefined),
          10_000,
          {
            timeoutError: () => new Error("Device call did not drain after admission was released"),
          },
        );
    }
  });

  it("refuses a write when task mode narrows during the final Runner send lookup", async () => {
    const { host, helper, gateway, run } = await start();
    const path = await pluginPath(gateway, "create_reminder", "create_reminder");
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const original = ComputerAppHub.prototype.send;
    const send = vi.spyOn(ComputerAppHub.prototype, "send").mockImplementationOnce(async function (
      this: ComputerAppHub,
      input,
    ) {
      entered.resolve();
      await withTimeout(released.promise, 10000, {
        timeoutError: () => new Error("Runner lookup was not released"),
      });
      return original.call(this, input);
    });
    const before = helper.invocations.length;
    const pending = gateway.call("plugin_call", {
      calls: { path, input: { title: "Must not be sent" } },
    });
    try {
      await withTimeout(entered.promise, 10000, {
        timeoutError: () => new Error("Call did not reach Runner lookup"),
      });
      await host.store.updateThreadAccessMode({
        threadId: run.threadId,
        requestedBy: host.ownerId,
        accessMode: "approval-required",
      });
      released.resolve();
      expect(JSON.stringify(await pending)).toMatch(/authority|unavailable/iu);
      expect(helper.invocations).toHaveLength(before);
    } finally {
      released.resolve();
      send.mockRestore();
      await pending;
    }
  });

  it("finds, describes and calls device tools, mixes them with a cloud plugin, and refuses what approvals do not allow", async () => {
    const { host, helper, computer, gateway, calendar, reminders } = await start();
    const owner = { caller: "personal", mode: "automatic" as const };
    const installed = await host.runtime.plugins!.install(
      { kind: "files", name: "Fixture", files: pluginFixtureFiles(1) },
      owner,
    );
    expect(installed.status).toBe("installed");

    // Found by search, described, and called on the Mac that holds it.
    const listEvents = await pluginPath(gateway, "list_events", "list_events");
    expect(listEvents).toBe(
      `tools[${JSON.stringify(localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`))}].list_events`,
    );
    const described = await gateway.call("plugin_describe", { paths: [listEvents] });
    expect(JSON.stringify(described)).toContain("end: string");
    const page = { events: [], nextCursor: null };
    helper.answer = () => page;
    const listed = await pluginCall(gateway, listEvents, {
      end: "2026-10-07",
      start: "2026-10-01",
    });
    expect(listed.value).toEqual(page);
    expect(helper.invocations.at(-1)).toEqual({
      access: "read",
      arguments: { end: "2026-10-07", start: "2026-10-01" },
      contract: contractOf("apple-calendar", "list_events"),
      definitionId: "apple-calendar",
      effect: "read",
      operation: "list_events",
    });

    // One program mixes the device tool with a cloud plugin's tool.
    const mixed = await gateway.call("plugin_execute", {
      code: `const events = await tools[${JSON.stringify(localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`))}].list_events({ start: "2026-10-01", end: "2026-10-02" });
return { events, cloud: await tools.fixture.read({ amount: 2 }) };`,
    });
    expect(mixed).toMatchObject({
      status: "completed",
      result: { execution: { ok: true, value: { events: page, cloud: 3 } } },
    });

    // The Mac approved Calendar for reading only: a change is refused before it reaches the Mac.
    const createEvent = await pluginPath(gateway, "create_event", "create_event");
    const discovery = await gateway.call("plugin_search", {
      namespace: localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`),
    });
    expect(
      (discovery.items as { path: string; blocked?: unknown }[]).find(
        (item) => item.path === listEvents,
      ),
    ).not.toHaveProperty("blocked");
    expect(
      (discovery.items as { path: string; blocked?: unknown }[]).find(
        (item) => item.path === createEvent,
      ),
    ).toMatchObject({
      blocked: {
        code: "access_denied",
        message: expect.stringContaining("allows reading only"),
        next: expect.stringContaining("app_access_request"),
      },
    });
    const blockedDescription = await gateway.call("plugin_describe", { paths: [createEvent] });
    expect((blockedDescription.items as { blocked?: unknown }[])[0]).toMatchObject({
      blocked: { code: "access_denied", next: expect.stringContaining('dataApp "calendar"') },
    });
    let sent = helper.invocations.length;
    const readOnly = await pluginCall(gateway, createEvent, {
      start: "2026-10-01T09:00",
      end: "2026-10-01T10:00",
      title: "Dentist",
    });
    expect(readOnly.raw).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "access_denied",
          message: "Calendar on Studio Mac allows reading only.",
          next: `To create_event, call app_access_request with dataApp "calendar", computerId "${computer.runnerId}" and access "read-write"; do not retry this call until it is fulfilled.`,
        },
      },
    });
    expect(helper.invocations).toHaveLength(sent);

    // The person sees both apps in Plugins with what agents type, and sets Reminders to
    // read-only there: its write is refused, its read is not, and agents' list says so.
    const reminderPlugin = `app_device_${reminders.connection.id}`;
    const reminderNamespace = localNamespace("reminders-studio-mac", reminderPlugin);
    const owned = await testRpcData(
      host.origin,
      "plugins.installed.list",
      {},
      { headers: host.ownerHeaders },
    );
    expect(owned.local).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `app_device_${calendar.connection.id}`,
          kind: "device-app",
          name: localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`),
          computer: expect.objectContaining({ id: computer.runnerId }),
          unavailable: null,
          access: "all",
          toolCount: expect.any(Number),
        }),
        expect.objectContaining({ id: reminderPlugin, name: reminderNamespace }),
      ]),
    );
    // The list counts a local tool's tools; its own page reads them.
    const calendarTool = await testRpcData(
      host.origin,
      "plugins.local.get",
      { id: `app_device_${calendar.connection.id}` },
      { headers: host.ownerHeaders },
    );
    expect(calendarTool.tools).toEqual(
      expect.arrayContaining([
        { name: "list_events", readOnly: true },
        { name: "create_event", readOnly: false },
      ]),
    );
    expect(calendarTool.toolCount).toBe(calendarTool.tools.length);
    const setAccess = (access: "all" | "read-only" | "off") =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "plugins.access.set",
          idempotencyKey: randomUUID(),
          pluginId: reminderPlugin,
          access,
        },
        { headers: host.ownerHeaders },
      );
    await setAccess("read-only");
    const reread = await testRpcData(
      host.origin,
      "plugins.installed.list",
      {},
      { headers: host.ownerHeaders },
    );
    expect(reread.local.find(({ id }) => id === reminderPlugin)?.access).toBe("read-only");
    const agentList = await gateway.call("opensteer_plugin_list", {});
    expect(agentList.local).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reminderPlugin,
          slug: reminderNamespace,
          access: "read-only",
          status: "active",
        }),
      ]),
    );
    const create = `tools[${JSON.stringify(reminderNamespace)}].create_reminder`;
    await expectPluginSettingRefusal(
      gateway,
      reminderNamespace,
      create,
      { title: "Renew passport" },
      "Read-only",
    );
    expect(helper.invocations).toHaveLength(sent);
    await setAccess("off");
    const whileOff = await testRpcData(
      host.origin,
      "plugins.installed.list",
      {},
      { headers: host.ownerHeaders },
    );
    expect(whileOff.local.find(({ id }) => id === reminderPlugin)?.access).toBe("off");
    expect(
      await testRpcData(
        host.origin,
        "plugins.local.get",
        { id: reminderPlugin },
        { headers: host.ownerHeaders },
      ),
    ).toMatchObject({ access: "off" });
    await expectPluginSettingRefusal(
      gateway,
      reminderNamespace,
      create,
      { title: "Renew passport" },
      "Off",
    );
    expect(helper.invocations).toHaveLength(sent);
    await setAccess("all");
    expect(
      await testRpcData(
        host.origin,
        "plugins.local.get",
        { id: reminderPlugin },
        { headers: host.ownerHeaders },
      ),
    ).toMatchObject({ access: "all" });

    // A change whose answer is lost is an unknown outcome, sent once and never again.
    helper.answer = () => {
      throw new ComputerUseBridgeError(
        "outcome-unknown",
        "The Opensteer desktop app stopped answering; the change may already have been made.",
      );
    };
    sent = helper.invocations.length;
    const lost = await pluginCall(
      gateway,
      `tools[${JSON.stringify(reminderNamespace)}].update_reminder`,
      {
        completed: true,
        id: "R1",
      },
    );
    expect(lost.raw).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "outcome_unknown",
          message:
            "Studio Mac did not confirm this. Check whether it happened before trying again.",
          next: "Check current state before repeating the write.",
        },
      },
    });
    expect(helper.invocations).toHaveLength(sent + 1);

    // Offline: the provider says so instead of listing tools, and nothing is rerouted.
    await computer.close();
    await waitForCondition(async () => {
      const found = await gateway.call("plugin_search", { query: "list_events" });
      return !JSON.stringify(found.items).includes(
        localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`),
      );
    }, 30_000);
    const offlineSearch = await gateway.call("plugin_search", {
      namespace: localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`),
    });
    expect(JSON.stringify(offlineSearch)).toContain("Studio Mac is offline");
    expect(offlineSearch.unavailableApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocked: {
            code: "unavailable",
            message: expect.stringContaining("Studio Mac is offline"),
            next: "Continue without it and tell the person what the message says.",
          },
        }),
      ]),
    );
    sent = helper.invocations.length;
    const offline = await pluginCall(gateway, listEvents, {
      end: "2026-10-07",
      start: "2026-10-01",
    });
    expect(offline.raw).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "computer_offline",
          message: "Device is offline. Do not request access.",
          next: `computerId=${computer.runnerId}, access=apps. Continue without it and tell the person what the message says.`,
        },
      },
    });
    expect(helper.invocations).toHaveLength(sent);
  }, 240_000);

  it("serves a Trigger program's device call with the Trigger's own authority", async () => {
    const { host, helper, gateway, run, calendar, computer } = await start();
    await pluginPath(gateway, "list_events", "list_events");
    const page = { events: [{ id: "E1" }], nextCursor: null };
    helper.answer = () => page;
    const caller = await triggerCaller(host, run.threadId);
    const result = await host.runtime.pluginTools!.handlers().plugin_execute!({
      caller,
      operationKey: "trigger-device-call",
      input: {
        code: `return await tools[${JSON.stringify(localNamespace("calendar-studio-mac", `app_device_${calendar.connection.id}`))}].list_events({ start: "2026-10-01", end: "2026-10-02" });`,
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      result: { execution: { ok: true, value: page } },
    });
    expect(helper.invocations.at(-1)).toMatchObject({ operation: "list_events", access: "read" });

    const devices = host.runtime.devices;
    const handlers = new DeviceToolHandlers({
      devices,
      access: new AccessRequests({
        definitions: deviceDefinitions,
        devices,
        store: devices.store,
      }),
    });
    expect(
      await gateway.call("local_server_add", {
        name: "policy-fixture",
        computerId: computer.runnerId,
        launch: { command: "node", args: ["fixture-server.js"] },
      }),
    ).toMatchObject({ server: { name: "policy-fixture" } });
    for (const [operationKey, target] of [
      ["trigger-calendar-access", { dataApp: "calendar" }],
      ["trigger-server-access", { server: "policy-fixture" }],
    ] as const) {
      const call = {
        caller,
        operationKey,
        input: { ...target, access: "read-write", reason: "Use this tool on the morning schedule" },
      } as const;
      const asked = await handlers.app_access_request(call);
      expect(asked).toMatchObject({
        kind: "integration.access",
        status: "pending",
        replayed: false,
        next: expect.stringContaining("A later occurrence can check access"),
      });
      expect(await handlers.app_access_request(call)).toMatchObject({
        requestId: asked.requestId,
        replayed: true,
        status: "pending",
      });
      expect(
        await host.store.database
          .selectFrom("requests")
          .select(["originatingOccurrenceId", "originatingRunId", "mode"])
          .where("id", "=", asked.requestId!)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        originatingOccurrenceId: caller.program.occurrenceId,
        originatingRunId: null,
        mode: "durable",
      });
      expect(
        await host.store.database
          .selectFrom("requestContinuations")
          .select("status")
          .where("requestId", "=", asked.requestId!)
          .executeTakeFirst(),
      ).toBeUndefined();
    }
  }, 240_000);
});

/** A running Trigger occurrence of this person's, as its program calls tools. */
async function triggerCaller(
  host: Awaited<ReturnType<typeof startMachineAccessWireHost>>,
  threadId: ThreadId,
) {
  const database = host.store.database;
  const anchor = (await host.store.getThreadForOwner(threadId, host.ownerId))!;
  const triggers = new TriggerStore(database);
  const created = await triggers.create({
    actorThreadId: null,
    anchorThreadId: anchor.id,
    createdBy: host.ownerId,
    idempotencyKey: randomUUID(),
    name: "Morning plan",
    source: {
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
    },
    program: { language: "javascript", source: "export default ()=>null", toolContractVersion: 5 },
  });
  const occurrence = await triggers.enqueueManual({
    actorThreadId: null,
    ownerId: host.ownerId,
    triggerId: created.trigger.id,
    idempotencyKey: randomUUID(),
  });
  await host.store.claimCommand(occurrence.commandId, "device-plugin-test");
  const runnerId = host.hostingComputerId;
  const started = await triggers.startExecution({
    commandId: occurrence.commandId,
    runnerBootId: "fixture-boot",
    runnerId,
  });
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: "program" as const,
    key: `trigger:${occurrence.id}`,
    userId: host.ownerId,
    accessMode: anchor.accessMode,
    anchor,
    program: {
      kind: "trigger" as const,
      aud: "opensteer-trigger-control" as const,
      exp: now + 3600,
      iat: now,
      iss: "opensteer-host" as const,
      jti: randomUUID(),
      environmentId: anchor.environmentId,
      executionGeneration: started.executionGeneration,
      occurrenceId: occurrence.id,
      requestedBy: host.ownerId,
      runnerBootId: "fixture-boot",
      runnerId,
      threadId: anchor.id,
      toolContractVersion: 5,
    },
  } satisfies AgentCaller;
}
