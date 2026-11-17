import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ComputerUseBridgeError, createHelperAppProvider } from "../apps/runner/src/index.js";
import { TriggerStore } from "../packages/database/src/index.js";
import type { AgentCaller } from "../apps/host/src/mcp/agent-caller.js";
import type { ThreadId } from "../packages/core/src/index.js";
import { pluginFixtureFiles, pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.js";
import {
  connectComputerAppMachine,
  contractOf,
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
    expect(listEvents).toBe('tools["calendar-studio-mac"].list_events');
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
      code: `const events = await tools["calendar-studio-mac"].list_events({ start: "2026-10-01", end: "2026-10-02" });
return { events, cloud: await tools.fixture.read({ amount: 2 }) };`,
    });
    expect(mixed).toMatchObject({
      status: "completed",
      result: { execution: { ok: true, value: { events: page, cloud: 3 } } },
    });

    // The Mac approved Calendar for reading only: a change is refused before it reaches the Mac.
    const createEvent = await pluginPath(gateway, "create_event", "create_event");
    let sent = helper.invocations.length;
    const readOnly = await pluginCall(gateway, createEvent, {
      start: "2026-10-01T09:00",
      end: "2026-10-01T10:00",
      title: "Dentist",
    });
    expect(readOnly.failure).toContain("allows reading only");
    expect(readOnly.failure).toContain(`account \\"${calendar.connection.id}\\"`);
    expect(helper.invocations).toHaveLength(sent);

    // The person sets Reminders to read-only for agents: its write is refused, its read is not.
    const reminderPlugin = `app_device_${reminders.connection.id}`;
    await host.runtime.pluginAgentSettings!.setAccess(host.ownerId, reminderPlugin, "read-only");
    const create = 'tools["reminders-studio-mac"].create_reminder';
    const refused = await pluginCall(gateway, create, { title: "Renew passport" });
    expect(refused.failure).toBeDefined();
    expect(helper.invocations).toHaveLength(sent);
    await host.runtime.pluginAgentSettings!.setAccess(host.ownerId, reminderPlugin, "all");

    // A change whose answer is lost is an unknown outcome, sent once and never again.
    helper.answer = () => {
      throw new ComputerUseBridgeError(
        "outcome-unknown",
        "The Opensteer desktop app stopped answering; the change may already have been made.",
      );
    };
    sent = helper.invocations.length;
    const lost = await pluginCall(gateway, 'tools["reminders-studio-mac"].update_reminder', {
      completed: true,
      id: "R1",
    });
    expect(lost.failure).toContain(
      "Studio Mac did not confirm this. Check whether it happened before trying again.",
    );
    expect(lost.failure).toContain("Retryable");
    expect(helper.invocations).toHaveLength(sent + 1);

    // Offline: the provider says so instead of listing tools, and nothing is rerouted.
    await computer.close();
    await waitForCondition(async () => {
      const found = await gateway.call("plugin_search", { query: "list_events" });
      return !JSON.stringify(found.items).includes("calendar-studio-mac");
    }, 30_000);
    const offlineSearch = await gateway.call("plugin_search", {
      namespace: "calendar-studio-mac",
    });
    expect(JSON.stringify(offlineSearch)).toContain("Studio Mac is offline");
    sent = helper.invocations.length;
    const offline = await pluginCall(gateway, listEvents, {
      end: "2026-10-07",
      start: "2026-10-01",
    });
    expect(offline.failure).toContain("Studio Mac is offline");
    expect(helper.invocations).toHaveLength(sent);
  }, 240_000);

  it("serves a Trigger program's device call with the Trigger's own authority", async () => {
    const { host, helper, gateway, run } = await start();
    await pluginPath(gateway, "list_events", "list_events");
    const page = { events: [{ id: "E1" }], nextCursor: null };
    helper.answer = () => page;
    const caller = await triggerCaller(host, run.threadId);
    const result = await host.runtime.pluginTools!.handlers().plugin_execute!({
      caller,
      operationKey: "trigger-device-call",
      input: {
        code: 'return await tools["calendar-studio-mac"].list_events({ start: "2026-10-01", end: "2026-10-02" });',
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      result: { execution: { ok: true, value: page } },
    });
    expect(helper.invocations.at(-1)).toMatchObject({ operation: "list_events", access: "read" });
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
  } as AgentCaller;
}
