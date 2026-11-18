import { IntegrationGrantStore, IntegrationInstallStore } from "@opensteer/database";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { LocalMcpServers } from "@opensteer/runner";
import { createId, DeviceIdSchema, type RequestId } from "@opensteer/core";
import { computer_list, local_server_add } from "@opensteer/agent-tools/tools";
import { DeviceDriverResolver } from "../computer-use/device-drivers.js";
import { ComputerMcpTransport } from "./computer-mcp-transport.js";
import { DeviceService } from "../devices/device-service.js";
import { LocalServerService } from "./local-server-service.js";
import { ServerInput } from "./server-input.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  expectPluginSettingRefusal,
  integrationGateway,
  pluginPath,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
  type MachineAccessHost,
} from "../runtime/machine-access-protocol.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

integration("local servers as plugin tools", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  }, 60_000);

  it("places and lists a local server by Device ID and waits for its opening before uninstall", async () => {
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const computer = await connectComputerAppMachine(host, []);
    closers.unshift(() => computer.close());
    const id = createId("device");
    const phoneId = createId("device");
    const database = host.store.database;
    await database.transaction().execute(async (tx) => {
      const driver = await tx
        .selectFrom("deviceDrivers")
        .selectAll()
        .where("runnerId", "=", computer.runnerId)
        .where("role", "=", "self")
        .executeTakeFirstOrThrow();
      const device = await tx
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", driver.deviceId)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("devices")
        .values([
          { ...device, id, name: "Second Mac" },
          { ...device, id: phoneId, name: "Screen-only iPhone", kind: "phone", platform: "ios" },
        ])
        .execute();
      await tx
        .updateTable("deviceDrivers")
        .set({ deviceId: id })
        .where("deviceId", "=", driver.deviceId)
        .where("role", "=", "self")
        .execute();
      await tx
        .insertInto("deviceDrivers")
        .values({ ...driver, deviceId: phoneId, role: "screen" })
        .execute();
    });
    const run = await dispatchCallerRun(host, caller, { key: "place", title: "Place the server" });
    closers.unshift(() => run.complete());
    const gateway = await integrationGateway(run.integrationTools);
    closers.unshift(() => gateway.close());
    const { computers } = computer_list.output.parse(await gateway.call("computer_list", {}));
    const byName = (name: string) =>
      DeviceIdSchema.parse(computers.find((computer) => computer.name === name)?.computerId);
    const computerId = byName("Second Mac");
    expect(computerId).toBe(id);
    const launch = { name: "fixture-placement", url: "http://127.0.0.1:12345/mcp" };
    expect(await gateway.call("local_server_add", { ...launch, computerId })).toMatchObject({
      server: { computerId: id, state: "waiting" },
    });
    expect(await gateway.call("local_server_list", {})).toMatchObject({
      servers: [{ name: launch.name, computerId: id }],
    });
    await expect(
      gateway.call("local_server_add", {
        ...launch,
        name: "wrong-device",
        computerId: byName("Screen-only iPhone"),
      }),
    ).rejects.toThrow(/screen-only Device cannot run a server/u);
    const servers = await host.runtime.localServers.options.store.localMcp.list();
    expect(servers).toMatchObject([{ runnerId: computer.runnerId }]);
    const [installed] = servers;
    if (!installed) throw new Error("Placement fixture did not install");
    expect(
      await testRpcData(
        host.origin,
        "plugins.local.get",
        { id: `app_server_${installed.id}` },
        {
          headers: host.ownerHeaders,
        },
      ),
    ).toMatchObject({ waitingForLaunchApproval: true });

    const hub = host.runtime.computerApps;
    const openingEntered = Promise.withResolvers<void>();
    const releaseOpening = Promise.withResolvers<void>();
    const pauseOpen = vi.spyOn(hub, "requireAgentAccess").mockImplementationOnce(async () => {
      openingEntered.resolve();
      await withTimeout(releaseOpening.promise, 10_000, {
        timeoutError: () => new Error("The opening MCP session was never released"),
      });
    });
    const opened = vi.spyOn(hub, "openMcpSession").mockResolvedValueOnce({
      close: async () => {},
      send: async () => {},
    });
    const target = {
      authorize: async () => {},
      deviceId: computerId,
      runnerId: computer.runnerId,
      serverId: installed.id,
      launch: installed.launch,
      secrets: {},
    };
    const transport = new ComputerMcpTransport(hub, target);
    const opening = transport.start();
    void opening.catch(() => {});
    try {
      await withTimeout(openingEntered.promise, 10_000, {
        timeoutError: () => new Error("The MCP session did not reach the Runner access lookup"),
      });
      const queued = Promise.withResolvers<"queued" | "uninstalled">();
      const admit = DeviceDriverResolver.prototype.withAdmission;
      const admission = vi
        .spyOn(DeviceDriverResolver.prototype, "withAdmission")
        .mockImplementation(function (this: DeviceDriverResolver, id, action) {
          if (id === computerId) queued.resolve("queued");
          return admit.call(this, id, action);
        });
      const uninstall = IntegrationInstallStore.prototype.uninstall;
      const mutation = vi
        .spyOn(IntegrationInstallStore.prototype, "uninstall")
        .mockImplementationOnce(function (this: IntegrationInstallStore, input) {
          queued.resolve("uninstalled");
          return uninstall.call(this, input);
        });
      const removing = gateway.call("local_server_remove", { name: launch.name });
      void removing.catch(() => {});
      try {
        expect(
          await withTimeout(queued.promise, 10_000, {
            timeoutError: () => new Error("Uninstall did not reach admission or storage"),
          }),
        ).toBe("queued");
        expect(mutation).not.toHaveBeenCalled();
      } finally {
        releaseOpening.resolve();
        admission.mockRestore();
        try {
          await removing;
        } finally {
          mutation.mockRestore();
        }
      }
      expect(opened).toHaveBeenCalledOnce();
    } finally {
      releaseOpening.resolve();
      try {
        await opening;
      } finally {
        await transport.close();
        pauseOpen.mockRestore();
        opened.mockRestore();
      }
    }
    expect(await gateway.call("local_server_list", {})).toEqual({ servers: [] });

    // Lose the first responses, then let the person replace the registration.
    const add = (args: Record<string, unknown>) =>
      gateway
        .call("local_server_add", args)
        .then(local_server_add.output.required({ server: true }).parse);
    const input = { ...launch, computerId, operationKey: randomUUID() };
    const removal = { name: launch.name, operationKey: randomUUID() };
    const first = await add(input);
    await expect(gateway.call("local_server_remove", removal)).resolves.toEqual({ ok: true });
    const replacement = await add({
      ...input,
      url: "http://127.0.0.1:12346/mcp",
      operationKey: randomUUID(),
    });
    expect(replacement.server.pluginId).not.toBe(first.server.pluginId);
    await expect(gateway.call("local_server_remove", removal)).resolves.toEqual({ ok: true });
    await expect(gateway.call("local_server_list", {})).resolves.toEqual({
      servers: [replacement.server],
    });
    await expect(add(input)).resolves.toEqual(first);
    await expect(gateway.call("local_server_list", {})).resolves.toEqual({
      servers: [replacement.server],
    });
    for (const [tool, args] of [
      ["local_server_add", { ...input, url: "http://127.0.0.1:12347/mcp" }],
      ["local_server_remove", { ...removal, name: "other-server" }],
    ] as const)
      expect(await gateway.callRaw(tool, args)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "conflict" } },
      });
    const [pending] = await database
      .selectFrom("computerAppSetupRequests")
      .select(["id"])
      .where("kind", "=", "server")
      .execute();
    if (!pending) throw new Error("No approval for the replacement server");
    await host.runtime.localServers.options.store.localMcp.decline({
      actorUserId: host.ownerId,
      runnerId: computer.runnerId,
      setupRequestId: pending.id,
    });
    await expect(gateway.call("local_server_list", {})).resolves.toMatchObject({
      servers: [
        {
          state: "declined",
          detail:
            "The computer's owner declined running it there. Register it again with local_server_add to ask again.",
        },
      ],
    });
  }, 60_000);

  it("is registered by an agent, approved by the owner, asks each caller its own question and is removed with its data", async () => {
    const enteredInventory = Promise.withResolvers<void>();
    const releaseInventory = Promise.withResolvers<void>();
    let awaitingInventory = false;
    let callableReads = 0;
    const inventory = IntegrationGrantStore.prototype.listCallableTools;
    const inventorySpy = vi
      .spyOn(IntegrationGrantStore.prototype, "listCallableTools")
      .mockImplementation(async function (this: IntegrationGrantStore, input) {
        const result = await inventory.call(this, input);
        if (awaitingInventory && ++callableReads === 2) {
          awaitingInventory = false;
          enteredInventory.resolve();
          await withTimeout(releaseInventory.promise, 10000, {
            timeoutError: () => new Error("Callable inventory was not released"),
          });
        }
        return result;
      });
    closers.push(async () => {
      inventorySpy.mockRestore();
    });
    const work = await mkdtemp(join(tmpdir(), "opensteer-local-server-tools-"));
    closers.push(() => rm(work, { recursive: true, force: true }));
    const server = await pairingServer(work);
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const localMcp = new LocalMcpServers({ stateDirectory: join(work, "runner-state") });
    const computer = await connectComputerAppMachine(host, [], { desktop: { localMcp } });
    closers.unshift(() => computer.close());
    const first = await dispatchCallerRun(host, caller, { key: "pair-a", title: "Pair the TV" });
    closers.unshift(() => first.complete());
    const gateway = await integrationGateway(first.integrationTools);
    closers.unshift(() => gateway.close());

    // The agent registers the server on the Mac; nothing runs until its owner approves.
    const added = await gateway.call("local_server_add", {
      name: "tv",
      computerId: computer.runnerId,
      launch: { command: "node", args: [server] },
      device: { name: "Living room TV", kind: "tv" },
    });
    expect(added).toMatchObject({
      server: {
        name: "tv",
        path: expect.stringMatching(/^tools\["local-tv-[0-9a-f]{8}"\]$/u),
        kind: "program",
        state: "waiting",
      },
    });
    const pair = `${(added as { server: { path: string } }).server.path}.pair`;
    expect(
      await gateway.call("local_server_add", {
        name: "tv",
        computerId: computer.runnerId,
        launch: { command: "node", args: [server] },
        device: { name: "Living room TV", kind: "tv" },
      }),
    ).toEqual(added);
    expect(await host.store.database.selectFrom("plugins").select("id").execute()).toHaveLength(1);
    expect(
      await host.store.database.selectFrom("pluginVersions").select("id").execute(),
    ).toHaveLength(1);
    const setup = await vi.waitFor(
      async () => {
        const row = await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("kind", "=", "server")
          .executeTakeFirst();
        expect(row, "The launch approval did not open").toBeDefined();
        return row!;
      },
      { timeout: 10_000 },
    );
    expect(
      await computer.answer(setup.id, { setupRequestId: setup.id, kind: "allow" }),
    ).toMatchObject({ kind: "allowed" });
    const installation = await vi.waitFor(
      async () => {
        const row = await host.store.database
          .selectFrom("integrationServers")
          .select(["id", "installationId", "status"])
          .executeTakeFirst();
        expect(row?.status, "The approved server was not discovered").toBe("active");
        return row!;
      },
      { timeout: 15_000 },
    );
    const blocked = await gateway.call("plugin_search", {
      namespace: /"([^"]+)"/u.exec(pair)?.[1],
    });
    expect(blocked.unavailableApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocked: {
            code: "access_required",
            message: expect.any(String),
            next: expect.stringContaining('"server":"tv"'),
          },
        }),
      ]),
    );
    await dispatch(host, {
      type: "integration.grant.create",
      input: {
        access: "read",
        alias: "TV",
        connectionId: null,
        installationId: installation.installationId,
        isDefault: true,
      },
    });
    const readable = await gateway.call("plugin_search", {
      namespace: /"([^"]+)"/u.exec(pair)?.[1],
    });
    expect(
      (readable.items as { path: string; blocked?: unknown }[]).find((item) => item.path === pair),
    ).toMatchObject({
      blocked: { code: "access_required", next: expect.stringContaining('"server":"tv"') },
    });
    expect(
      (readable.items as { path: string; blocked?: unknown }[]).find((item) =>
        item.path.endsWith(".status"),
      ),
    ).not.toHaveProperty("blocked");
    expect(
      JSON.stringify(await gateway.callRaw("plugin_call", { calls: { path: pair, input: {} } })),
    ).toContain("app_access_request");
    await expect(readFile(join(work, "calls"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await dispatch(host, {
      type: "integration.grant.create",
      input: {
        access: "read-write",
        alias: "TV",
        connectionId: null,
        installationId: installation.installationId,
        isDefault: true,
      },
    });
    expect(await gateway.call("local_server_list", {})).toMatchObject({
      servers: [{ name: "tv", state: "approved", device: { name: "Living room TV" } }],
    });
    await vi.waitFor(
      async () => {
        const found = await gateway.call("plugin_search", {
          namespace: /"([^"]+)"/u.exec(pair)?.[1],
        });
        expect(JSON.stringify(found), "The server's tools were not listed").toContain(
          JSON.stringify(pair).slice(1, -1),
        );
      },
      { timeout: 30_000 },
    );
    expect(await pluginPath(gateway, "pair", "pair")).toBe(pair);

    const statusPath = pair.replace(/\.pair$/u, ".status");
    const namespace = /"([^"]+)"/u.exec(pair)![1]!;
    for (const [access, path, label] of [
      ["read-only", pair, "Read-only"],
      ["off", statusPath, "Off"],
    ] as const) {
      await dispatch(host, {
        type: "plugins.access.set",
        pluginId: `app_server_${installation.id}`,
        access,
      });
      await expectPluginSettingRefusal(gateway, namespace, path, {}, label);
    }
    await dispatch(host, {
      type: "plugins.access.set",
      pluginId: `app_server_${installation.id}`,
      access: "all",
    });

    const statusResult = {
      content: [
        { type: "text", text: "TV status" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        { type: "resource", resource: { uri: "tv://status", text: "ready" } },
      ],
      structuredContent: { ready: true },
    };
    expect(
      await gateway.callRaw("plugin_call", { calls: { path: statusPath, input: {} } }),
    ).toMatchObject(statusResult);
    expect(
      await gateway.call("plugin_execute", { code: `return await ${statusPath}({});` }),
    ).toMatchObject({ result: { execution: { ok: true, value: statusResult } } });

    // Two tasks call it at once. Each question reaches the person for its own call only.
    const second = await dispatchCallerRun(host, caller, { key: "pair-b", title: "Pair again" });
    closers.unshift(() => second.complete());
    const otherGateway = await integrationGateway(second.integrationTools);
    closers.unshift(() => otherGateway.close());
    const call = (target: typeof gateway) =>
      target.call("plugin_call", { calls: { path: pair, input: {} } });
    const callA = call(gateway);
    const askedA = await pendingInput(host);
    const callB = call(otherGateway);
    const answers = (code: string) => ({
      code,
      count: 6723672367236723,
      enabled: true,
      ratio: -13.75,
      room: "Den",
    });
    expect(askedA.runId).toBe(first.runId);
    await respond(host, askedA.id, answers("AB89"));
    const resultA = await settled(callA, gateway);
    const askedB = await pendingInput(host, askedA.id);
    expect(askedB.runId).toBe(second.runId);
    await respond(host, askedB.id, answers("CD34"));
    const resultB = await settled(callB, otherGateway);
    // The server echoes the code's last digits; answered values themselves are redacted.
    const redacted = {
      "****": "paired",
      received: {
        code: "****",
        count: "****************",
        enabled: "****",
        ratio: "******",
        room: "***",
      },
    };
    expect(resultA).toMatchObject({
      result: { execution: { value: { value: { digits: "89", ...redacted } } } },
    });
    expect(resultB).toMatchObject({
      result: { execution: { value: { value: { digits: "34", ...redacted } } } },
    });
    expect(JSON.stringify([resultA, resultB])).not.toMatch(/AB89|CD34/u);
    const beforeQueued = await readFile(join(work, "calls"), "utf8");
    const entered = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const originalTurn = ServerInput.prototype.turn;
    const turn = vi.spyOn(ServerInput.prototype, "turn").mockImplementationOnce(async function (
      this: ServerInput,
      client,
      signal,
    ) {
      const release = await originalTurn.call(this, client, signal);
      entered.resolve();
      await withTimeout(releaseTurn.promise, 10000, {
        timeoutError: () => new Error("Queued admission was not released"),
      });
      return release;
    });
    try {
      const queued = gateway.callRaw("plugin_call", {
        calls: { path: pair, input: { mode: "queued" } },
      });
      await withTimeout(entered.promise, 10000, {
        timeoutError: () => new Error("Call did not enter the session queue"),
      });
      const serverRow = await host.store.database
        .selectFrom("integrationServers")
        .select("id")
        .executeTakeFirstOrThrow();
      await dispatch(host, {
        type: "plugins.access.set",
        pluginId: `app_server_${serverRow.id}`,
        access: "off",
      });
      releaseTurn.resolve();
      const refused = await withTimeout(queued, 10000, {
        timeoutError: () => new Error("Revoked queued call did not return"),
      });
      expect(JSON.stringify(refused)).toMatch(/unavailable|authority|access/iu);
      expect(await readFile(join(work, "calls"), "utf8")).toBe(beforeQueued);
      await dispatch(host, {
        type: "plugins.access.set",
        pluginId: `app_server_${serverRow.id}`,
        access: "all",
      });
    } finally {
      releaseTurn.resolve();
      turn.mockRestore();
    }
    const beforeNarrow = await readFile(join(work, "calls"), "utf8");
    const nextTurn = ServerInput.prototype.turn;
    const callSpy = vi.spyOn(ServerInput.prototype, "turn").mockImplementationOnce(async function (
      this: ServerInput,
      ...args
    ) {
      const release = await nextTurn.apply(this, args);
      awaitingInventory = true;
      return release;
    });
    const narrowing = gateway.callRaw("plugin_call", {
      calls: { path: pair, input: { mode: "queued" } },
    });
    try {
      await withTimeout(
        Promise.race([
          enteredInventory.promise,
          narrowing.then((value) => {
            throw new Error(`Call ended before final inventory: ${JSON.stringify(value)}`);
          }),
        ]),
        10000,
        { timeoutError: () => new Error("Call did not reach final callable inventory") },
      );
      await host.store.updateThreadAccessMode({
        threadId: first.threadId,
        requestedBy: host.ownerId,
        accessMode: "approval-required",
      });
      releaseInventory.resolve();
      expect(JSON.stringify(await narrowing)).toMatch(/authority|unavailable/iu);
      expect(await readFile(join(work, "calls"), "utf8")).toBe(beforeNarrow);
    } finally {
      releaseInventory.resolve();
      callSpy.mockRestore();
      inventorySpy.mockRestore();
      await narrowing;
    }
    await host.store.updateThreadAccessMode({
      threadId: first.threadId,
      requestedBy: host.ownerId,
      accessMode: "full-access",
    });
    const failed = await withTimeout(
      gateway.callRaw("plugin_call", {
        calls: { path: pair, input: { mode: "error" } },
      }),
      30_000,
      { timeoutError: () => new Error("The server's reflected error did not return") },
    );
    expect(JSON.stringify(failed)).toContain("****");
    expect(JSON.stringify(failed)).not.toMatch(/AB89|CD34/u);
    // Answers reach only the server: no Request or event keeps the code.
    const stored = await host.store.database.selectFrom("requests").selectAll().execute();
    const transcript = await host.store.database
      .selectFrom("transcriptItems")
      .selectAll()
      .execute();
    const changes = await host.store.database.selectFrom("clientChanges").selectAll().execute();
    const commands = await host.store.database.selectFrom("commands").selectAll().execute();
    const history = await host.store.database.selectFrom("threadInputs").selectAll().execute();
    expect(JSON.stringify([stored, transcript, changes, commands, history])).not.toMatch(
      /AB89|CD34|6723672367236723|-13\.75/u,
    );

    const pause = async (gate: PromiseWithResolvers<void>, release: PromiseWithResolvers<void>) => {
      gate.resolve();
      await withTimeout(release.promise, 10000, {
        timeoutError: () => new Error("Local server change was not released"),
      });
    };
    for (const operation of ["add", "remove"] as const) {
      const gate = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const select = LocalServerService.prototype.pluginComputer;
      const runnerTurn = DeviceService.prototype.withDeviceAdmissions;
      const blocked =
        operation === "add"
          ? vi
              .spyOn(LocalServerService.prototype, "pluginComputer")
              .mockImplementationOnce(async function (this: LocalServerService, ...args) {
                await pause(gate, release);
                return select.apply(this, args);
              })
          : vi
              .spyOn(DeviceService.prototype, "withDeviceAdmissions")
              .mockImplementationOnce(async function (this: DeviceService, runners, work) {
                await pause(gate, release);
                return runnerTurn.call(this, runners, work);
              });
      const attempt = (
        operation === "add"
          ? gateway.call("local_server_add", {
              name: "later",
              computerId: computer.runnerId,
              launch: { command: "node", args: [server] },
            })
          : gateway.call("local_server_remove", { name: "tv" })
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await withTimeout(gate.promise, 10000, {
          timeoutError: () => new Error("Local server change did not reach its wait"),
        });
        await host.store.updateThreadAccessMode({
          threadId: first.threadId,
          requestedBy: host.ownerId,
          accessMode: "approval-required",
        });
        release.resolve();
        expect(await attempt).toHaveProperty("error");
        expect(await gateway.call("local_server_list", {})).toMatchObject({
          servers: [{ name: "tv" }],
        });
      } finally {
        release.resolve();
        blocked.mockRestore();
        await attempt;
        await host.store.updateThreadAccessMode({
          threadId: first.threadId,
          requestedBy: host.ownerId,
          accessMode: "full-access",
        });
      }
    }

    // Removed: its tools are gone and its data removal reaches the Mac.
    const pendingRemoval = call(otherGateway);
    const ending = await pendingInput(host);
    await gateway.call("local_server_remove", { name: "tv" });
    expect(await host.store.requests.get(ending.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "plugin-interrupted",
    });
    await withTimeout(pendingRemoval, 10_000, {
      timeoutError: () => new Error("Removed server's call remained pending"),
    });
    expect(await gateway.call("local_server_list", {})).toEqual({ servers: [] });
    const after = await gateway.call("plugin_search", { query: "pair" });
    expect(after.items).toEqual([]);
    expect(
      await host.store.database.selectFrom("integrationServers").select("id").execute(),
    ).toEqual([]);
    // The Mac that ran it deletes its data when it confirms; delivery is the existing removal path.
    expect(
      await host.store.database.selectFrom("runnerPluginDataRemovals").select("runnerId").execute(),
    ).toEqual([{ runnerId: computer.runnerId }]);
  }, 300_000);
});

/** The person's form answer through the same command every client sends. */
function respond(host: MachineAccessHost, requestId: RequestId, content: Record<string, unknown>) {
  return dispatch(host, {
    type: "request.respond",
    requestId,
    response: { kind: "external", value: { action: "accept", content } },
  });
}

/** A held call returns the result; one handed to its task is collected with plugin_resume. */
async function settled(
  call: Promise<Record<string, unknown>>,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
) {
  const first = await withTimeout(call, 30_000, {
    timeoutError: () => new Error("The plugin call did not return"),
  });
  if (first.status !== "pending") return first;
  return vi.waitFor(
    async () => {
      const resumed = await gateway.call("plugin_resume", { executionId: first.executionId });
      expect(resumed.status, "The answered call did not complete").toBe("completed");
      return resumed;
    },
    { timeout: 20_000 },
  );
}

async function pendingInput(host: MachineAccessHost, after?: RequestId) {
  return vi.waitFor(
    async () => {
      const rows = await host.store.database
        .selectFrom("requests")
        .select(["id", "originatingRunId as runId"])
        .where("kind", "=", "plugin.input")
        .where("status", "=", "pending")
        .execute();
      expect(rows.length, "More than one question is open on a shared session").toBeLessThan(2);
      const row = rows.find(({ id }) => id !== after);
      expect(row, "The server's question did not reach Needs you").toBeDefined();
      return row!;
    },
    { timeout: 20_000 },
  );
}

function dispatch(host: MachineAccessHost, command: Record<string, unknown>) {
  return testRpcData(
    host.origin,
    "commands.dispatch",
    { ...command, idempotencyKey: randomUUID() } as never,
    { headers: host.ownerHeaders },
  );
}

/** A TV's pairing server: each call asks for the code shown on screen and answers with it. */
async function pairingServer(work: string) {
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  const path = join(work, "server.cjs");
  await writeFile(
    path,
    `
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${sdk("types.js")});
const server = new Server({ name: "tv", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "pair", description: "Pair with the TV", inputSchema: { type: "object" } },{ name:"status",description:"Read the TV status",inputSchema:{type:"object"},annotations:{readOnlyHint:true} }] }));
let acceptedCode;
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  require("node:fs").appendFileSync(${JSON.stringify(join(work, "calls"))}, "call\\n");
  if (params.name === "status") return { content: [
    { type: "text", text: "TV status" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    { type: "resource", resource: { uri: "tv://status", text: "ready" } },
  ], structuredContent: { ready: true } };
  if (params.arguments?.mode === "queued") return { content: [{ type: "text", text: "queued write ran" }] };
  if (params.arguments?.mode === "error") throw new Error("Pairing failed with " + acceptedCode);
  const properties = { code: { type: "string", title: "Pairing code", minLength: 4, maxLength: 4 }, count: { type: "integer" }, enabled: { type: "boolean" }, ratio: { type: "number" }, room: { type: "string", enum: ["Living room", "Den"] } };
  const result = await server.elicitInput({ message: "Enter the code shown on your TV", requestedSchema: { type: "object", properties, required: Object.keys(properties) } }, { timeout: 180000, maxTotalTimeout: 180000 });
  if (result.action !== "accept") return { content: [{ type: "text", text: result.action }] };
  acceptedCode = result.content.code;
  return { content: [{ type: "text", text: "paired" }], structuredContent: { digits: result.content.code.slice(2), received: result.content, [result.content.code]: "paired" } };
});
server.connect(new StdioServerTransport());
`,
  );
  return path;
}
