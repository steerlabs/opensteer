import { withTimeout } from "@opensteer/shared/withTimeout";
import { startHeldRequest } from "../integrations/held-request.test-support.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";

import {
  RunnerAuxiliaryStreamIdSchema,
  type ComputerUseDataGrants,
  type ComputerUseDataInvokeParams,
} from "@opensteer/protocol";

import {
  ComputerUseBridgeError,
  createHelperAppProvider,
  type ComputerAppProvider,
  type ComputerAppValue,
  type HelperDataPort,
} from "@opensteer/runner";
import { computerAppIntegrations } from "@opensteer/integration-catalog";
import { isComputerAppDefinition } from "@opensteer/integration-core";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import type { IntegrationAccess } from "@opensteer/integration-core";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  operation,
  operations,
  requestComputerAppSetup,
  setComputerApp,
  toolText,
  toolReadiness,
} from "./computer-apps.test-support.js";
import {
  connectCallerMachine,
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  dispatchCallerRun,
  resetMachineAccessDatabase,
  revokeMachine,
  additionalOwnerSession,
  startMachineAccessWireHost,
  waitForCondition,
  type MachineAccessHost,
} from "./machine-access-protocol.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

integration("computer apps", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));

  let closeCurrent: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  }, 60_000);

  it("keeps an older Mac connected and explains the required approval upgrade", async () => {
    const directory =
      process.env.OPENSTEER_APPROVAL_COMPAT_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-approval-compat-")));
    const host = await startMachineAccessWireHost(databaseUrl, { remoteAccess: true });
    const closers: (() => Promise<void>)[] = [() => host.close()];
    closeCurrent = async () => {
      for (const close of closers) await close();
    };
    let failure: unknown = null;
    let observed: unknown = null;
    try {
      const computer = await connectComputerAppMachine(host, fakeMessagesProvider(), {
        integrations: { platform: "darwin", protocolVersion: 5 },
      });
      closers.unshift(() => computer.close());
      await computer.heartbeat();
      await expect(
        requestComputerAppSetup(host, computer.runnerId, "read", "old-runner-approval"),
      ).rejects.toThrow("Update Opensteer");
      const listed = await testRpcData(
        host.origin,
        "machines.list",
        {},
        { headers: host.ownerHeaders },
      );
      const machine = listed.machines.find(({ id }) => id === computer.runnerId);
      expect(machine?.modules.integrations).toMatchObject({
        readiness: "unavailable",
        detail: expect.stringContaining("Update Opensteer"),
      });
      await computer.heartbeat();
      observed = machine?.modules;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "result.json"),
        JSON.stringify({ failure, observed, passed: failure === null }, null, 2),
      );
    }
  });

  it("uses one real Host, Runner stream, connection, grant, and gateway lifecycle", async () => {
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
    });
    const closers: (() => Promise<void>)[] = [() => host.close()];
    closeCurrent = async () => {
      for (const close of closers) await close().catch(() => undefined);
    };
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const provider = fakeMessagesProvider();
    const computer = await connectComputerAppMachine(host, provider);
    closers.unshift(() => computer.close());

    const renewed = await computer.heartbeat();
    expect(renewed).toMatchObject({
      auxiliaryStreamId: computer.auxiliaryStreamId,
      module: "integrations",
      runnerId: computer.runnerId,
    });
    expect(Date.parse(renewed.streamLeaseExpiresAt)).toBeGreaterThan(
      Date.parse(computer.streamLeaseExpiresAt),
    );

    await waitForCondition(async () => {
      const machines = await testRpcData(
        host.origin,
        "machines.list",
        {},
        {
          headers: host.ownerHeaders,
        },
      );
      return machines.machines.some(
        (machine) =>
          machine.id === computer.runnerId &&
          machine.apps?.some(
            (app) =>
              app.definitionId === "apple-messages" &&
              app.operations.every(({ state }) => state === "ready"),
          ),
      );
    });

    await expect(
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "messages-read-without-local-approval",
          input: {
            kind: "app",
            app: null,
            access: "read",
            definitionId: "apple-messages",
            runnerId: computer.runnerId,
          },
          type: "integration.computer.setup.set",
        },
        { headers: host.ownerHeaders },
      ),
    ).rejects.toThrow(/HTTP 403.*forbidden/u);
    const setup = await requestComputerAppSetup(host, computer.runnerId, "read", "messages-read");
    const respond = (setupRequestId: string, headers: Record<string, string>) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.computer.setup.respond",
          idempotencyKey: createId("request"),
          setupRequestId,
          decision: "allow",
        },
        { headers },
      );
    const otherOwnerSession = await additionalOwnerSession(host);
    expect(otherOwnerSession.cookie.length).toBeGreaterThan(0);
    expect(otherOwnerSession.cookie === host.ownerHeaders.cookie).toBe(false);
    await respond(setup.id, otherOwnerSession);
    const enabled = {
      connection: await host.store.database
        .selectFrom("integrationConnections")
        .select("id")
        .where("runnerId", "=", computer.runnerId)
        .where("integrationDefinitionId", "=", "apple-messages")
        .where("status", "=", "connected")
        .executeTakeFirstOrThrow(),
    };
    await expect(respond(setup.id, host.ownerHeaders)).rejects.toThrow("no longer waiting");

    const run = await dispatchCallerRun(host, caller, {
      key: "computer-app-run",
      title: "Use Messages",
    });
    closers.unshift(() => run.complete());
    const gateway = await integrationGateway(run.integrationTools);
    closers.unshift(() => gateway.close());

    const held = await startHeldRequest(host, run.runId, () =>
      gateway.call("integration_request", {
        access: "read",
        integration: "apple-messages",
        reason: "Read recent conversations",
      }),
    );
    const [readRequest] = await host.store.requests.listPendingIntegrationAccessRequests(
      host.ownerId,
    );
    if (!readRequest) throw new Error("The read access Request was not created");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "messages-read-access",
        requestId: readRequest.request.id,
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Messages on Studio Mac",
            connectionId: enabled.connection.id,
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      },
      { headers: host.ownerHeaders },
    );
    await expect(held.result).resolves.toMatchObject({ status: "fulfilled" });
    const readSearch = await gateway.call("integration_search", { query: "Messages" });
    const readOperation = operation(readSearch, "query_messages");
    expect(readOperation).toMatchObject({
      account: "Studio Mac",
      connectionId: enabled.connection.id,
    });
    expect(toolReadiness(readSearch, "query_messages").code).toBe("READY");
    expect(operations(readSearch).some(({ name }) => name === "send_message")).toBe(false);
    await expect(
      gateway.call("integration_call", {
        arguments: { sql: "SELECT 1" },
        ...readOperation.address,
      }),
    ).resolves.toMatchObject({ columns: ["guid"], rows: [["chat-1"]], truncated: false });

    const writeSetup = await requestComputerAppSetup(
      host,
      computer.runnerId,
      "read-write",
      "messages-read-write",
    );
    await setComputerApp(host, computer, writeSetup, writeSetup.id);
    const writeHeld = await startHeldRequest(host, run.runId, () =>
      gateway.call("integration_request", {
        access: "read-write",
        integration: "apple-messages",
        reason: "Send a message",
      }),
    );
    const writeRequests = await host.store.requests.listPendingIntegrationAccessRequests(
      host.ownerId,
    );
    const writeRequest = writeRequests.find(({ access }) => access === "read-write");
    if (!writeRequest) throw new Error("The read-write access Request was not created");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "messages-write-access",
        requestId: writeRequest.request.id,
        response: {
          kind: "external",
          value: {
            access: "read-write",
            alias: "Messages on Studio Mac",
            connectionId: enabled.connection.id,
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      },
      { headers: host.ownerHeaders },
    );
    await expect(writeHeld.result).resolves.toMatchObject({ status: "fulfilled" });
    const writeSearch = await gateway.call("integration_search", { query: "Messages" });
    const sendOperation = operation(writeSearch, "send_message");
    await expect(
      gateway.call("integration_call", {
        arguments: { text: "hello", to: { address: "friend@example.test" } },
        ...sendOperation.address,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(provider.sent).toEqual(["hello"]);

    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "messages-narrow",
        input: {
          kind: "app",
          app: null,
          access: "read",
          definitionId: "apple-messages",
          runnerId: computer.runnerId,
        },
        type: "integration.computer.setup.set",
      },
      { headers: host.ownerHeaders },
    );
    const narrowed = await gateway.callRaw("integration_call", {
      arguments: { text: "again", to: { address: "friend@example.test" } },
      ...sendOperation.address,
    });
    expect(toolText(narrowed)).toContain("Studio Mac allows reading only");
    expect(toolText(narrowed)).toContain('access "read-write"');

    const widenSetup = await requestComputerAppSetup(
      host,
      computer.runnerId,
      "read-write",
      "messages-widen-again",
    );
    await setComputerApp(host, computer, widenSetup, widenSetup.id);
    const currentSend = operation(
      await gateway.call("integration_search", { query: "Messages" }),
      "send_message",
    );
    provider.holdNextWrite();
    const appsOffWrite = gateway.callRaw("integration_call", {
      arguments: { text: "apps off", to: { address: "friend@example.test" } },
      ...currentSend.address,
    });
    await withTimeout(provider.writeStarted, 3000, {
      timeoutError: () => new Error("Apps-off write was not admitted"),
    });
    const beforeSwitch = await host.store.database
      .selectFrom("runners")
      .select(["accessPolicy", "accessPolicyRevision"])
      .where("id", "=", computer.runnerId)
      .executeTakeFirstOrThrow();
    const updateSwitch = (apps: boolean, revision: number, key: string) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "machine.access.update",
          idempotencyKey: key,
          runnerId: computer.runnerId,
          expectedRevision: revision,
          policy: { ...beforeSwitch.accessPolicy, apps },
        },
        { headers: host.ownerHeaders },
      );
    await updateSwitch(false, beforeSwitch.accessPolicyRevision, "apps-off-during-write");
    expect(toolText(await appsOffWrite)).toBe(
      "Studio Mac did not confirm this. Check whether it happened before trying again.",
    );
    const offRefusal = await gateway.callRaw("integration_call", {
      arguments: { text: "not admitted", to: { address: "friend@example.test" } },
      ...currentSend.address,
    });
    expect(offRefusal).toMatchObject({
      isError: true,
      structuredContent: {
        error: { reason: "device-access-off", machineId: computer.runnerId, capability: "apps" },
      },
    });
    const connectionAfterOff = await host.store.database
      .selectFrom("integrationConnections")
      .select("status")
      .where("id", "=", enabled.connection.id)
      .executeTakeFirstOrThrow();
    expect(connectionAfterOff.status).toBe("connected");
    await updateSwitch(true, beforeSwitch.accessPolicyRevision + 1, "apps-on-after-write");

    provider.holdNextWrite();
    const uncertain = gateway.callRaw("integration_call", {
      arguments: { text: "uncertain", to: { address: "friend@example.test" } },
      ...currentSend.address,
    });
    await provider.writeStarted;
    await computer.disconnectModule();
    expect(toolText(await uncertain)).toBe(
      "Studio Mac did not confirm this. Check whether it happened before trying again.",
    );

    const offline = await gateway.call("integration_search", { query: "Messages" });
    expect(toolReadiness(offline, "query_messages")).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Opensteer's integrations service is unavailable on Studio Mac.",
    });
    await computer.reconnectModule();
    await waitForCondition(async () => {
      const searched = await gateway.call("integration_search", { query: "Messages" });
      return toolReadiness(searched, "query_messages").code === "READY";
    });

    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "messages-narrow-for-request",
        input: {
          kind: "app",
          app: null,
          access: "read",
          definitionId: "apple-messages",
          runnerId: computer.runnerId,
        },
        type: "integration.computer.setup.set",
      },
      { headers: host.ownerHeaders },
    );
    const pendingHeld = await startHeldRequest(host, run.runId, () =>
      gateway.call("integration_request", {
        access: "read-write",
        integration: "apple-messages",
        reason: "Send a follow-up",
      }),
    );
    const pending = await host.store.requests.listPendingIntegrationAccessRequests(host.ownerId);
    expect(pending).toHaveLength(1);
    await revokeMachine(host, { key: "revoke-computer-app", runnerId: computer.runnerId });
    await expect(host.store.requests.get(pending[0]!.request.id)).resolves.toMatchObject({
      cancellationReason: null,
      status: "pending",
    });
    await expect(
      host.store.database
        .selectFrom("deploymentEvents")
        .select("type")
        .where("runId", "=", run.runId)
        .where("type", "=", "request.cancelled")
        .execute(),
    ).resolves.toEqual([]);
    const connection = await host.store.database
      .selectFrom("integrationConnections")
      .select(["id", "status"])
      .where("id", "=", enabled.connection.id)
      .executeTakeFirstOrThrow();
    expect(connection.status).toBe("revoked");
    await expect(
      host.store.database
        .selectFrom("integrationTools")
        .select("id")
        .where("connectionId", "=", enabled.connection.id)
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      host.store.database
        .selectFrom("integrationGrants")
        .select("id")
        .where("connectionId", "=", enabled.connection.id)
        .where("status", "=", "active")
        .execute(),
    ).resolves.toEqual([]);
    await run.complete();
    await expect(pendingHeld.result).rejects.toThrow();
  }, 180_000);

  it("rejects out-of-sequence, malformed, and stale integration heartbeats", async () => {
    const host = await startMachineAccessWireHost(databaseUrl, { remoteAccess: true });
    const closers: (() => Promise<void>)[] = [() => host.close()];
    closeCurrent = async () => {
      for (const close of closers) await close().catch(() => undefined);
    };
    const computer = await connectComputerAppMachine(host, fakeMessagesProvider());
    closers.unshift(() => computer.close());

    await expect(computer.rejectPreAuthenticationHeartbeat()).resolves.toMatchObject({
      code: 4002,
    });

    await expect(computer.rejectHeartbeat({ sentAt: "not-a-date" })).resolves.toEqual({
      code: 4001,
      reason: "integrations stream transport-disconnected",
    });

    await computer.reconnectModule();
    await expect(computer.rejectHeartbeat({ sentAt: "2000-01-01T00:00:00.000Z" })).resolves.toEqual(
      {
        code: 4001,
        reason: "integrations stream transport-disconnected",
      },
    );

    await computer.reconnectModule();
    await expect(computer.rejectHeartbeat({ module: "browser" })).resolves.toEqual({
      code: 4001,
      reason: "integrations stream transport-disconnected",
    });

    await computer.reconnectModule();
    await expect(
      computer.rejectHeartbeat({
        auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
          "rax_11111111-1111-4111-8111-111111111111",
        ),
      }),
    ).resolves.toEqual({
      code: 4001,
      reason: "integrations stream transport-disconnected",
    });
  });

  it("serves an app from another computer on a Personal Deployment", async () => {
    const host = await startMachineAccessWireHost(databaseUrl, { manualRunner: true });
    const closers: (() => Promise<void>)[] = [() => host.close()];
    closeCurrent = async () => {
      for (const close of closers) await close().catch(() => undefined);
    };
    const caller = await connectCallerMachine(host, {
      environmentId: host.ownerEnvironmentId,
      localDirectory: true,
      name: "Home Mac",
      runnerKind: "main",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    await configurePersonalRemoteAccess(host, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal.computer-apps.test",
    });
    const computer = await connectComputerAppMachine(host, fakeMessagesProvider(), {
      allowedModules: ["integrations", "shell"],
    });
    closers.unshift(() => computer.close());

    const machines = await testRpcData(
      host.origin,
      "machines.list",
      {},
      {
        headers: host.ownerHeaders,
      },
    );
    expect(machines.machines.find(({ id }) => id === computer.runnerId)).toMatchObject({
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      status: "online",
    });
    const personalSetup = await requestComputerAppSetup(
      host,
      computer.runnerId,
      "read",
      "personal-messages-read",
    );
    const enabled = await setComputerApp(host, computer, personalSetup, personalSetup.id);
    const run = await dispatchCallerRun(host, caller, {
      key: "personal-computer-app-run",
      title: "Read Messages",
    });
    closers.unshift(() => run.complete());
    const gateway = await integrationGateway(run.integrationTools);
    closers.unshift(() => gateway.close());
    const held = await startHeldRequest(host, run.runId, () =>
      gateway.call("integration_request", {
        access: "read",
        integration: "apple-messages",
        reason: "Read recent conversations",
      }),
    );
    const [readRequest] = await host.store.requests.listPendingIntegrationAccessRequests(
      host.ownerId,
    );
    if (!readRequest) throw new Error("The Personal read access Request was not created");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "personal-messages-read-access",
        requestId: readRequest.request.id,
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Messages on Studio Mac",
            connectionId: enabled.connection.id,
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      },
      { headers: host.ownerHeaders },
    );
    await expect(held.result).resolves.toMatchObject({ status: "fulfilled" });
    const searched = await gateway.call("integration_search", { query: "Messages" });
    const list = operation(searched, "query_messages");
    expect(list).toMatchObject({ account: "Studio Mac", connectionId: enabled.connection.id });
    expect(toolReadiness(searched, "query_messages").code).toBe("READY");
    await expect(
      gateway.call("integration_call", { arguments: { sql: "SELECT 1" }, ...list.address }),
    ).resolves.toMatchObject({ columns: ["guid"], rows: [["chat-1"]], truncated: false });
  }, 180_000);
  /**
   * Calendar and Reminders served by the signed helper, end to end on real
   * parts: the Host, its gateway, a Runner's `integrations` stream and the
   * Runner's own helper-app providers. Only the helper process is scripted,
   * as the desktop suite proves the hops from the Runner to it.
   *
   * Ways this journey can fail, each asserted below:
   *  1. An app whose macOS grant is missing looks ready to agents, or does
   *     not say which grant on which Mac.
   *  2. Allowing the grant on the Mac does not make the app ready.
   *  3. A read-only grant offers changes, or a change reaches the Mac under it.
   *  4. A read does not reach the helper with the Host's access, contract and
   *     effect, or its answer does not reach the model intact.
   *  5. A malformed date reaches the Mac instead of being refused by the Host.
   *  6. A change reaches the helper without write access and its contract.
   *  7. A change whose answer is lost reads as a failure to retry rather than
   *     unconfirmed, or is sent to the Mac twice.
   *
   * The artifact directory (OPENSTEER_HELPER_APPS_E2E_ARTIFACT_DIR, a new
   * temporary directory by default) receives `result.json`: each step, what
   * the model read, and what reached the helper.
   */
  it("serves Calendar and Reminders from the helper through one real Host, stream and gateway", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_HELPER_APPS_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-helper-apps-e2e-")));
    const steps: { readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) => steps.push({ observed, step });
    const helper = scriptedHelper();
    let failure: unknown = null;
    try {
      const host = await startMachineAccessWireHost(databaseUrl, {
        remoteAccess: true,
        manualRunner: true,
      });
      const closers: (() => Promise<void>)[] = [() => host.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: host.hostingRunnerEnrollmentToken,
      });
      closers.unshift(() => caller.close());
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

      const run = await dispatchCallerRun(host, caller, {
        key: "helper-apps-run",
        title: "Plan the week",
      });
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

      // 1. Full access not yet allowed.
      await waitForCondition(async () => {
        const searched = await gateway.call("integration_search", { query: "Calendar" });
        return toolReadiness(searched, "list_events").code === "INTEGRATION_UNAVAILABLE";
      });
      const blocked = toolReadiness(
        await gateway.call("integration_search", { query: "Calendar" }),
        "list_events",
      );
      record("calendar before its grant", blocked);
      expect(blocked.detail).toBe(
        "Calendar needs macOS full access to calendars for Opensteer Computer Use on Studio Mac.",
      );

      // 2. The person allows it on the Mac.
      helper.grants.calendars = "granted";
      helper.grants.reminders = "granted";
      await waitForCondition(async () => {
        const searched = await gateway.call("integration_search", { query: "Calendar" });
        return toolReadiness(searched, "list_events").code === "READY";
      });
      const calendarSearch = await gateway.call("integration_search", { query: "Calendar" });
      record(
        "calendar once allowed",
        operations(calendarSearch).map(({ name, connectionId }) => ({ name, connectionId })),
      );

      // 3. Read only offers no change.
      expect(
        operations(calendarSearch)
          .map(({ name }) => name)
          .sort(),
      ).toEqual(["list_calendars", "list_events"]);

      // 4. A read, carried whole.
      const page = { events: [], nextCursor: null };
      helper.answer = () => page;
      const listed = await gateway.call("integration_call", {
        arguments: { end: "2026-10-07", start: "2026-10-01" },
        ...operation(calendarSearch, "list_events").address,
      });
      record("list_events", { answer: listed, reached: helper.invocations.at(-1) });
      expect(listed).toEqual(page);
      expect(helper.invocations.at(-1)).toEqual({
        access: "read",
        arguments: { end: "2026-10-07", start: "2026-10-01" },
        contract: contractOf("apple-calendar", "list_events"),
        definitionId: "apple-calendar",
        effect: "read",
        operation: "list_events",
      });

      // 5. A malformed date stops at the Host.
      const before = helper.invocations.length;
      const malformed = await gateway.callRaw("integration_call", {
        arguments: { end: "next week", start: "2026-10-01" },
        ...operation(calendarSearch, "list_events").address,
      });
      record("list_events with a malformed date", toolText(malformed));
      expect(malformed.isError).toBe(true);
      expect(helper.invocations).toHaveLength(before);

      // 6. A change, with write access and its contract.
      const remindersSearch = await gateway.call("integration_search", { query: "Reminders" });
      const created = {
        reminder: {
          completed: false,
          completedAt: null,
          due: "2026-10-02T09:00:00-07:00",
          id: "R1",
          listId: "L1",
          notes: null,
          notesTruncated: false,
          priority: "high",
          recurring: false,
          title: "Renew passport",
          url: null,
        },
      };
      helper.answer = () => created;
      const createArguments = {
        due: "2026-10-02T09:00",
        priority: "high",
        title: "Renew passport",
      };
      await expect(
        gateway.call("integration_call", {
          arguments: createArguments,
          ...operation(remindersSearch, "create_reminder").address,
        }),
      ).resolves.toEqual(created);
      record("create_reminder", { answer: created, reached: helper.invocations.at(-1) });
      expect(helper.invocations.at(-1)).toEqual({
        access: "read-write",
        arguments: createArguments,
        contract: contractOf("apple-reminders", "create_reminder"),
        definitionId: "apple-reminders",
        effect: "write",
        operation: "create_reminder",
      });

      // 7. A change whose answer is lost.
      helper.answer = () => {
        throw new ComputerUseBridgeError(
          "outcome-unknown",
          "The Opensteer desktop app stopped answering; the change may already have been made.",
        );
      };
      const sent = helper.invocations.length;
      const lost = await gateway.callRaw("integration_call", {
        arguments: { completed: true, id: "R1" },
        ...operation(remindersSearch, "update_reminder").address,
      });
      record("update_reminder whose answer was lost", toolText(lost));
      expect(toolText(lost)).toBe(
        "Studio Mac did not confirm this. Check whether it happened before trying again.",
      );
      expect(helper.invocations).toHaveLength(sent + 1);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "result.json"),
        `${JSON.stringify(
          {
            failure: failure instanceof Error ? failure.message : failure,
            helperInvocations: helper.invocations,
            passed: failure === null,
            steps,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 180_000);
});

function fakeMessagesProvider() {
  let started: (() => void) | undefined;
  const state = {
    sent: [] as string[],
    writeStarted: Promise.resolve(),
  };
  const provider: ComputerAppProvider & {
    readonly sent: readonly string[];
    readonly writeStarted: Promise<void>;
    holdNextWrite(): void;
  } = {
    definitionId: "apple-messages",
    holdNextWrite() {
      state.writeStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
    },
    async inspect() {
      return [
        { detail: null, operation: "query_messages", remedy: null, state: "ready" },
        { detail: null, operation: "send_message", remedy: null, state: "ready" },
      ] as const;
    },
    async invoke(operationName, args, signal) {
      if (operationName === "query_messages") {
        return {
          columns: ["guid"],
          rows: [["chat-1"]],
          truncated: false,
        };
      }
      if (operationName !== "send_message") throw new Error("Unexpected operation");
      const text = String(args.text);
      if (started) {
        started();
        started = undefined;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      state.sent.push(text);
      return { accepted: true };
    },
    platforms: ["darwin"],
    get sent() {
      return state.sent;
    },
    get writeStarted() {
      return state.writeStarted;
    },
  };
  return provider;
}

/**
 * The signed helper as the Runner reaches it: the grants its person allowed,
 * and each call it was sent, answered by the step that is running.
 */
function scriptedHelper() {
  const grants: { -readonly [K in keyof ComputerUseDataGrants]: ComputerUseDataGrants[K] } = {
    automation: "unknown",
    calendars: "requestable",
    contacts: "requestable",
    "full-disk-access": "denied",
    reminders: "requestable",
  };
  const invocations: ComputerUseDataInvokeParams[] = [];
  const script: { answer: () => ComputerAppValue } = {
    answer: () => {
      throw new Error("No step expects a call to the helper now");
    },
  };
  const port: HelperDataPort = {
    dataGrants: async () => ({ ...grants }),
    dataInvoke: async (params) => {
      invocations.push(params);
      return script.answer();
    },
  };
  return {
    grants,
    invocations,
    port,
    /** How the helper answers the calls of the step that is running. */
    set answer(answer: () => ComputerAppValue) {
      script.answer = answer;
    },
  };
}

/** The agent asks for access, and the owner fulfils it with the Mac's connection. */
async function grantAccess(
  host: MachineAccessHost,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
  input: {
    readonly access: IntegrationAccess;
    readonly connectionId: string;
    readonly integration: string;
  },
) {
  const held = gateway.call("integration_request", {
    access: input.access,
    integration: input.integration,
    reason: `Use ${input.integration}`,
  });
  const request = await vi.waitFor(
    async () => {
      const pending = await host.store.requests.listPendingIntegrationAccessRequests(host.ownerId);
      const row = pending.at(-1);
      expect(row, "The access Request was not created").toBeDefined();
      return row!;
    },
    { timeout: 10_000 },
  );
  if (!request) throw new Error(`The ${input.integration} access Request was not created`);
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: `${input.integration}-access`,
      requestId: request.request.id,
      response: {
        kind: "external",
        value: {
          access: input.access,
          alias: `${input.integration} on Studio Mac`,
          connectionId: input.connectionId,
          decision: "fulfilled",
          isDefault: true,
        },
      },
      type: "request.respond",
    },
    { headers: host.ownerHeaders },
  );
  await expect(held).resolves.toMatchObject({ status: "fulfilled" });
}

function contractOf(definitionId: string, name: string): string {
  const definition = computerAppIntegrations.find(({ id }) => id === definitionId);
  const found =
    definition && isComputerAppDefinition(definition)
      ? definition.config.operations.find((candidate) => candidate.name === name)
      : undefined;
  if (!found) throw new Error(`The catalog must define ${definitionId}.${name}`);
  return computerAppOperationContract(found);
}
