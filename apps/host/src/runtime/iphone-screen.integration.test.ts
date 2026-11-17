import {
  apiVersionQueryParameter,
  apiCurrentQueryParameter,
  hostApiVersion,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { testRpcData } from "../server/test-host-api-request.js";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createId, DeviceIdSchema, type DeviceId } from "@opensteer/core";
import { IntegrationPlatformStore } from "@opensteer/database";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import { createIntegrationId, integrationDefinitionSummary } from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import {
  RunnerDescriptorSchema,
  RunnerBootIdSchema,
  runnerIntegrationsProtocolVersion,
  machineAccessPolicyDefault,
  type IphoneScreenObservation,
  type DeviceScreenDriverAssignment,
  type RunnerIntegrationsDeviceStatus,
} from "@opensteer/protocol";
import {
  ComputerAppModuleHandler,
  type PhoneScreenDriver,
  type PhoneScreenDriverConnection,
  type PhoneScreenContext,
  type PhoneScreenDisplayFrame,
} from "@opensteer/runner";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { callMcpTool } from "../mcp/call-tool.test-support.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { openAuxiliaryStream } from "./computer-apps.test-support.js";
import {
  closed,
  connectPrimary,
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

const baseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseUrl ? describe : describe.skip;

function observation(): IphoneScreenObservation {
  return {
    capturedAt: "2026-11-16T12:00:00Z",
    elementCount: 0,
    foreground: null,
    geometry: { width: 360, height: 640 },
    locked: false,
    secureLock: null,
    observationId: "phone-observation",
    rotation: 0,
    screen: "on",
    screenshot: null,
    screenshotUnavailable: "not-requested",
    tree: "",
    truncated: false,
  };
}
function fakeScreenPort() {
  let sink: Parameters<PhoneScreenDriver["connect"]>[0] | undefined;
  const assignments = new Map<DeviceId, DeviceScreenDriverAssignment>();
  const observes: PhoneScreenContext[] = [];
  const actions: PhoneScreenContext[] = [];
  const displays: PhoneScreenDisplayFrame[] = [];
  const recorded: Parameters<PhoneScreenDriverConnection["stopRecorded"]>[0][] = [];
  const status = async (
    deviceId: DeviceId,
    availability: RunnerIntegrationsDeviceStatus["availability"] = { state: "ready", reason: null },
    inputVersion: 1 | null = 1,
  ) => {
    const assignment = assignments.get(deviceId);
    if (!sink || !assignment) throw new Error("Screen port has no assigned Device");
    await sink.emit({
      type: "runner.integrations.device-status",
      deviceId,
      driverGeneration: assignment.generation,
      definitionId: "iphone-screen",
      operations: ["observe", "act", "close", "installed_apps"].map((operation) => ({
        operation,
        detail: null,
        remedy: null,
        state: availability.state === "ready" ? "ready" : "unavailable",
      })),
      availability,
      navigationButtons: [{ id: "home", label: "Home" }],
      actions: ["tap", "navigate", "launch", "wait"],
      wake: false,
      lock: false,
      displayVersion: 1,
      ownerViewVersion: 1,
      inputVersion,
      powerVersion: null,
    });
  };
  const driver: PhoneScreenDriver = {
    connect: (options) => {
      sink = options;
      return {
        replaceAssignments: (next) => {
          assignments.clear();
          for (const assignment of next) assignments.set(assignment.deviceId, assignment);
          for (const assignment of next) void status(assignment.deviceId);
        },
        observe: async (context) => {
          observes.push(context);
          return { observation: observation() };
        },
        act: async (context) => {
          actions.push(context);
          return { observation: observation(), error: null, performed: ["Waited 10 ms"] };
        },
        close: async () => ({}),
        installedApps: async () => ({
          apps: [{ appId: "fixture.app", label: "Fixture" }],
          total: 1,
        }),
        ownerView: async (frame) => ({
          viewId: frame.viewId,
          generation: frame.generation,
          state: frame.operation === "close" ? "closed" : "ready",
          captureTargetId: null,
        }),
        display: (frame) => {
          displays.push(frame);
        },
        cancel: () => undefined,
        stopRecorded: (frame) => {
          recorded.push(frame);
        },
        detach: () => {
          assignments.clear();
        },
      };
    },
    shutdown: () => undefined,
  };
  return {
    driver,
    assignments,
    observes,
    actions,
    displays,
    recorded,
    status,
    stop: async (context: PhoneScreenContext) => {
      if (!sink) throw new Error("Screen port is not connected");
      await sink.emit({
        type: "runner.integrations.computer-use-event",
        deviceId: context.deviceId,
        driverGeneration: context.driverGeneration,
        event: {
          event: "session.stopped",
          params: { sessionId: context.sessionId, runId: context.runId, reason: "user" },
        },
      });
    },
  };
}

integration("iPhone screen routing on an authenticated Mac", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  const closers: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseUrl!);
  }, 120_000);
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  }, 60_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);

  it("keeps two iPhones independent through approval, control, viewing, Stop, detach and removal", async () => {
    await resetMachineAccessDatabase(database.url);
    const host = await startMachineAccessWireHost(database.url, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Hosting computer",
      token: host.hostingRunnerEnrollmentToken,
      computerTool: 1,
    });
    closers.unshift(() => caller.close());
    const macId = createId("runner");
    const primary = await connectPrimary(
      host.hostPort,
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: {
          integrations: {
            platform: "darwin",
            protocolVersion: runnerIntegrationsProtocolVersion,
            screenDrivers: 1,
          },
        },
        device: { platform: "macos", form: "desktop", app: "opensteer" },
        name: "Driver Mac",
        runnerId: macId,
        runnerKind: "local",
        runtimeVersion: "integration",
      }),
      {
        token: await enrollmentToken(host, {
          allowedModules: ["integrations"],
          idempotencyKey: randomUUID(),
          name: "Driver Mac",
        }),
      },
    );
    closers.unshift(async () => {
      primary.socket.close();
      await closed(primary.socket);
    });
    const { socket, fence, welcome } = await openAuxiliaryStream(
      host.hostPort,
      primary,
      "integrations",
    );
    expect(welcome.screenDrivers).toBe(1);
    const port = fakeScreenPort();
    const handler = new ComputerAppModuleHandler({
      phoneScreens: port.driver,
      providers: [],
      logger: { error() {}, info() {} },
      statusIntervalMs: 60_000,
    });
    handler.attach({
      fence,
      screenDrivers: welcome.screenDrivers!,
      browserAttachPublicKeys: undefined,
      send: (frame, binary) =>
        new Promise<void>((resolve, reject) =>
          socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve())),
        ),
    });
    socket.on("message", (bytes: WebSocket.RawData, binary: boolean) => {
      const frame = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer);
      if (!binary && JSON.parse(frame.toString()).type.startsWith("host.auxiliary.")) return;
      void handler.handleFrame(frame, binary);
    });
    socket.once("close", () => handler.detach());
    closers.unshift(async () => {
      socket.close();
      await closed(socket);
    });
    const { computerApps, computerUse, computerViews, displayStreams } = host.runtime;
    const attach = (name: string) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "iphone.screen.attach",
          idempotencyKey: randomUUID(),
          driverRunnerId: macId,
          target: { kind: "new", name },
        },
        { headers: host.ownerHeaders },
      ).then((result) => {
        if (result.type !== "iphone.screen.attach") throw new Error("Unexpected attach result");
        return result;
      });
    const first = await attach("First iPhone");
    const second = await attach("Second iPhone");
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(second.deviceId)?.availability.state).toBe("ready"),
      { timeout: 5_000 },
    );
    expect(await host.store.getDevice(first.deviceId)).toMatchObject({
      kind: "phone",
      accessPolicy: { apps: false },
    });
    await expect(
      computerViews.openForTab(
        host.ownerId,
        {
          tabId: "tab_first",
          tabGeneration: 1,
          computerId: first.deviceId,
          target: { kind: "phone", display: "main" },
        },
        randomUUID(),
      ),
    ).rejects.toThrow(/approval/);
    const platform = new IntegrationPlatformStore(host.store.database);
    const definition = getIntegrationDefinition("iphone-screen")!;
    const installationId = createIntegrationId("installation");
    await platform.install({
      actorUserId: host.ownerId,
      adapterSnapshot: null,
      requestId: randomUUID(),
      installation: {
        id: installationId,
        name: definition.id,
        title: definition.name,
        description: definition.description,
        manifest: { definition: integrationDefinitionSummary(definition) },
        provenance: {
          definitionId: definition.id,
          definitionDigest: integrationDefinitionDigest(definition),
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in",
        trust: "built-in",
        status: "active",
        version: "integration",
      },
      servers: [
        {
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          connectionRequirement: { kind: "computer", definitionId: definition.id },
          transport: { type: "computer", definitionId: definition.id },
          catalog: { definitions: {}, tools: [] },
        },
      ],
    });
    for (const phone of [first, second]) {
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "machine.access.update",
          deviceId: phone.deviceId,
          expectedRevision: 1,
          policy: { ...machineAccessPolicyDefault, browser: false, apps: true },
          idempotencyKey: randomUUID(),
        },
        { headers: host.ownerHeaders },
      );
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input: {
            kind: "app",
            deviceId: phone.deviceId,
            definitionId: "iphone-screen",
            access: "read-write",
            app: null,
          },
        },
        { headers: host.ownerHeaders },
      );
    }
    const macDevice = await host.store.getDevice(await host.store.requireSelfDeviceId(macId));
    if (!macDevice) throw new Error("The authenticated Mac has no self Device");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "machine.access.update",
        deviceId: macDevice.id,
        expectedRevision: macDevice.accessPolicyRevision,
        policy: { ...macDevice.accessPolicy, apps: false },
        idempotencyKey: randomUUID(),
      },
      { headers: host.ownerHeaders },
    );
    const projected = await testRpcData(
      host.origin,
      "machines.list",
      {},
      { headers: host.ownerHeaders },
    );
    expect(projected.machines.find(({ id }) => id === first.deviceId)).toMatchObject({
      selfRunnerId: null,
      allowedModules: [],
      modules: {},
      capabilities: { apps: { state: "ready", enabled: true }, browser: { supported: false } },
      phoneDisplay: {
        definitionId: "iphone-screen",
        driver: { runnerId: macId },
        control: { state: "ready" },
      },
    });
    const approved = await testRpcData(
      host.origin,
      "integrations.get",
      {},
      { headers: host.ownerHeaders },
    );
    expect(
      approved.connections.some(
        ({ computer }) =>
          computer && "deviceId" in computer && computer.deviceId === first.deviceId,
      ),
    ).toBe(true);
    const connection = approved.connections.find(
      ({ computer }) => computer && "deviceId" in computer && computer.deviceId === first.deviceId,
    );
    if (!connection) throw new Error("The first iPhone has no approved connection");
    await platform.createGrant({
      access: "read-write",
      alias: "First iPhone",
      connectionId: connection.id,
      createdBy: host.ownerId,
      installationId,
      isDefault: true,
      ownerUserId: host.ownerId,
      providerAuthorizations: {},
    });
    const run = await dispatchCallerRun(host, caller, {
      key: "iphone-screen-run",
      title: "Use the phones",
    });
    closers.unshift(() => run.complete());
    const claims = JSON.parse(
      Buffer.from(run.toolsToken.split(".")[1]!, "base64url").toString(),
    ) as RunToolScope;
    const target = {
      kind: "display" as const,
      definitionId: "iphone-screen" as const,
      access: "read-write" as const,
    };
    const observe = async (deviceId: DeviceId, context = claims) => {
      const lease = await computerUse.prepare(
        { deviceId, deviceName: "iPhone", ownerUserId: host.ownerId },
        context,
      );
      try {
        const sent = await computerApps.withDeviceAdmission(deviceId, () =>
          computerUse.sendObserve(lease, target, false),
        );
        const result = await sent.settle();
        if (result.error) throw result.error;
        return sent.sessionId;
      } finally {
        computerUse.release(lease);
      }
    };
    await port.status(first.deviceId, { state: "ready", reason: null }, null);
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(first.deviceId)?.inputVersion).toBeNull(),
      { timeout: 5_000 },
    );
    const facts = await callMcpTool(host.origin, run.toolsToken, "computer_use", {
      code: `return (await phones()).find((phone) => phone.computerId === ${JSON.stringify(first.deviceId)}).actions`,
    });
    expect(facts.isError, JSON.stringify(facts)).toBeUndefined();
    expect(facts.content).toContainEqual({
      type: "text",
      text: '["tap","navigate","launch","wait"]',
    });
    const phoneRow = async () => {
      const result = await callMcpTool(host.origin, run.toolsToken, "integration_search", {
        query: "Phone display",
      });
      const data = JSON.parse(result.content.find((item) => item.type === "text")!.text) as {
        catalog: {
          definitionId: string;
          phones?: {
            computerId: string;
            definitionId: string;
            access?: string;
            blocked?: { code: string; message: string; next: string };
          }[];
        }[];
      };
      return data.catalog
        .find((row) => row.definitionId === "iphone-screen")!
        .phones!.find((row) => row.computerId === first.deviceId)!;
    };
    expect(await phoneRow()).toEqual({
      computerId: first.deviceId,
      definitionId: "iphone-screen",
      name: "First iPhone",
      access: "read-write",
    });
    await port.status(first.deviceId, { state: "unavailable", reason: { kind: "locked" } }, null);
    await vi.waitFor(
      () =>
        expect(computerApps.deviceStatus(first.deviceId)?.availability.reason?.kind).toBe("locked"),
      { timeout: 5_000 },
    );
    const locked = await phoneRow();
    expect(locked).toEqual({
      computerId: first.deviceId,
      definitionId: "iphone-screen",
      name: "First iPhone",
      blocked: {
        code: "permission_required",
        message: "First iPhone is locked.",
        next: "Ask the person to unlock the iPhone physically, then observe again. Never enter or ask for its passcode.",
      },
    });
    const bindLocked = await callMcpTool(host.origin, run.toolsToken, "computer_use", {
      code: `await phone(${JSON.stringify(first.deviceId)})`,
    });
    expect(bindLocked.isError).toBe(true);
    expect(bindLocked.structuredContent).toMatchObject({ error: locked.blocked });
    await port.status(first.deviceId, { state: "ready", reason: null }, null);
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(first.deviceId)?.availability.state).toBe("ready"),
      { timeout: 5_000 },
    );
    const firstSession = await observe(first.deviceId);
    await observe(second.deviceId);
    expect(port.observes.map(({ deviceId }) => deviceId)).toEqual([
      first.deviceId,
      second.deviceId,
    ]);
    expect(port.observes.every(({ driverGeneration }) => driverGeneration === 1)).toBe(true);
    const lease = await computerUse.prepare(
      { deviceId: first.deviceId, deviceName: "First iPhone", ownerUserId: host.ownerId },
      claims,
    );
    const sent = await computerUse.sendAct(
      lease,
      target,
      { observationId: "phone-observation", actions: [{ type: "wait", ms: 10 }] },
      false,
      undefined,
      (action) => computerApps.withDeviceAdmission(first.deviceId, action),
    );
    expect((await sent.settle()).error).toBeNull();
    expect(port.actions[0]?.deviceId).toBe(first.deviceId);
    await port.status(first.deviceId);
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(first.deviceId)?.inputVersion).toBe(1),
      { timeout: 5_000 },
    );
    const views = [];
    for (const [index, phone] of [first, second].entries()) {
      const view = await computerViews.openForTab(
        host.ownerId,
        {
          tabId: `tab_phone_${index}`,
          tabGeneration: 1,
          computerId: phone.deviceId,
          target: { kind: "phone", display: "main" },
        },
        randomUUID(),
      );
      views.push(view);
      const viewer = new WebSocket(
        `${host.origin.toString().replace("http", "ws").replace(/\/$/, "")}/v1/computer-use/views/${view.viewId}/${view.generation}/display?sharedInput=1&phoneOwnerControl=1&${apiVersionQueryParameter}=${minimumHostApiVersion}&${apiCurrentQueryParameter}=${hostApiVersion}`,
        { headers: host.ownerHeaders },
      );
      viewer.on("error", () => undefined);
      closers.unshift(async () => {
        viewer.close();
        await closed(viewer);
      });
      await withTimeout(once(viewer, "open"), 5_000, {
        timeoutError: () => new Error("Owner display did not open"),
      });
    }
    await vi.waitFor(
      () =>
        expect(
          port.displays.filter((frame) => frame.type === "host.integrations.display.start"),
        ).toHaveLength(2),
      { timeout: 5_000 },
    );
    const starts = port.displays.filter(
      (frame) => frame.type === "host.integrations.display.start",
    );
    expect(starts.map(({ deviceId }) => deviceId)).toEqual([first.deviceId, second.deviceId]);
    expect(new Set(starts.map(({ streamId }) => streamId)).size).toBe(2);
    const staleTicket = starts[0]!.dataTicket;
    expect(displayStreams.claimDataSocket(starts[1]!.dataTicket).runnerId).toBe(macId);
    await computerUse.stop(firstSession, host.ownerId);
    await expect(observe(first.deviceId)).rejects.toThrow(/stopped/);
    await observe(second.deviceId);
    await vi.waitFor(
      async () =>
        expect(await host.store.activeComputerUseStops()).toEqual([
          { runId: run.runId, deviceId: first.deviceId },
        ]),
      { timeout: 5_000 },
    );
    // Replay after session memory is gone must still be validated and acknowledged for this Device.
    await port.stop(port.observes[0]!);
    await vi.waitFor(
      () =>
        expect(port.recorded).toContainEqual(
          expect.objectContaining({
            deviceId: first.deviceId,
            driverGeneration: 1,
            runId: run.runId,
          }),
        ),
      { timeout: 5_000 },
    );
    await port.status(second.deviceId, { state: "unavailable", reason: { kind: "locked" } });
    await vi.waitFor(
      () =>
        expect(computerApps.deviceStatus(second.deviceId)?.availability.reason?.kind).toBe(
          "locked",
        ),
      { timeout: 5_000 },
    );
    expect(computerApps.deviceStatus(first.deviceId)?.availability.state).toBe("ready");
    await port.status(second.deviceId);
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(second.deviceId)?.availability.state).toBe("ready"),
      { timeout: 5_000 },
    );
    await computerViews.openForTab(
      host.ownerId,
      {
        tabId: "tab_phone_1",
        tabGeneration: 1,
        computerId: second.deviceId,
        target: { kind: "phone", display: "main" },
      },
      randomUUID(),
    );
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "iphone.screen.detach",
        deviceId: first.deviceId,
        expectedGeneration: 1,
        idempotencyKey: randomUUID(),
      },
      { headers: host.ownerHeaders },
    );
    expect(() => displayStreams.claimDataSocket(staleTicket)).toThrow();
    expect(computerApps.deviceStatus(second.deviceId)?.availability.state).toBe("ready");
    expect((await host.store.activeComputerUseStops())[0]?.deviceId).toBe(first.deviceId);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "machine.revoke",
        machineId: second.deviceId,
        idempotencyKey: randomUUID(),
      },
      { headers: host.ownerHeaders },
    );
    expect((await host.store.runnerForAuthentication(macId))?.revokedAt).toBeNull();
    expect(await computerViews.list(host.ownerId, second.deviceId)).toEqual([]);
    await vi.waitFor(() => expect(port.assignments.size).toBe(0), { timeout: 5_000 });
    expect(await host.store.getDevice(DeviceIdSchema.parse(macId))).toMatchObject({
      removedAt: null,
    });
    const replacement = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "iphone.screen.attach",
        driverRunnerId: macId,
        idempotencyKey: randomUUID(),
        target: { kind: "existing", deviceId: first.deviceId, expectedGeneration: 2 },
      },
      { headers: host.ownerHeaders },
    );
    if (replacement.type !== "iphone.screen.attach")
      throw new Error("Unexpected replacement result");
    expect(replacement.generation).toBe(3);
    await vi.waitFor(
      () => expect(computerApps.deviceStatus(first.deviceId)?.driverGeneration).toBe(3),
      { timeout: 5_000 },
    );
    await expect(observe(first.deviceId)).rejects.toThrow(/stopped/);
    socket.close();
    await closed(socket);
    await vi.waitFor(() => expect(computerApps.attached(first.deviceId)).toBe(false), {
      timeout: 5_000,
    });
    expect(await host.store.listDeviceDrivers({ deviceId: first.deviceId })).toMatchObject([
      { runnerId: macId, generation: 3, detachedAt: null },
    ]);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      { type: "machine.revoke", machineId: macId, idempotencyKey: randomUUID() },
      { headers: host.ownerHeaders },
    );
    expect((await host.store.getDevice(first.deviceId))?.removedAt).toBeNull();
    expect(
      await host.store.listDeviceDrivers({ deviceId: first.deviceId, includeDetached: true }),
    ).toMatchObject([{ generation: 4, detachedAt: expect.any(Date) }]);
    expect(await host.store.activeComputerUseStops()).toEqual([
      { runId: run.runId, deviceId: first.deviceId },
    ]);
  }, 60_000);
});
