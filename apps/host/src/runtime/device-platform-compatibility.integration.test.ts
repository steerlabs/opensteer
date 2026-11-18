import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { TabStore } from "@opensteer/database";
import { DeviceIdSchema } from "@opensteer/core";
import { hostApiVersion, hostApiVersionHeader } from "@opensteer/deployment-authority";
import { openAuxiliaryStream } from "./computer-apps.test-support.js";
import { runnerIntegrationsProtocolVersion } from "@opensteer/protocol";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { RunnerDescriptorSchema, hostApi } from "@opensteer/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { requestComputerAppSetup } from "./computer-apps.test-support.js";
import {
  closed,
  connectPrimary,
  createMachineAccessDatabase,
  enrollmentToken,
  openRealtime,
  startMachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const methods = [
  "personal.shell.get",
  "machines.list",
  "integrations.get",
  "integration.platform.get",
  "plugins.directory.get",
  "plugins.overview.get",
  "integration.computer.setup.list",
  "tabs.state",
  "devices.overview.get",
  "needsYou.get",
  "requests.list",
] as const;
const envelope = z.object({ ok: z.literal(true), data: z.unknown() });

integration("device platform release compatibility", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
  let closeCurrent: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await createMachineAccessDatabase(databaseUrl!);
  }, 120_000);
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  });
  afterAll(async () => {
    await database?.drop();
  }, 120_000);

  it("refuses stale Device commands and exposes current Device state through v63", async () => {
    const directory =
      process.env.OPENSTEER_PLATFORM_COMPAT_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-platform-compat-")));
    const rpc: { method: (typeof methods)[number]; data: unknown }[] = [];
    const frames: unknown[] = [];
    let failure: string | null = null;
    const host = await startMachineAccessWireHost(database!.url, { remoteAccess: true });
    const closers: (() => Promise<void>)[] = [() => host.close()];
    closeCurrent = async () => {
      const failures: unknown[] = [];
      for (const close of closers) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Compatibility journey cleanup");
    };
    const runnerId = createId("runner");
    let setupRequestId: string | null = null;
    try {
      const oldHeaders = {
        ...host.ownerHeaders,
        [hostApiVersionHeader]: String(hostApiVersion - 1),
      };
      const realtime = await openRealtime(host, host.ownerHeaders);
      closers.unshift(() => realtime.close());
      const primary = await connectPrimary(
        host.hostPort,
        RunnerDescriptorSchema.parse({
          bootId: "rbt_00000000-0000-4000-8000-000000000001",
          capabilities: [],
          device: { form: "laptop", platform: "macos" },
          modules: {
            integrations: {
              computerAppApprovals: true,
              platform: "darwin",
              protocolVersion: runnerIntegrationsProtocolVersion,
              screenDrivers: 1,
            },
          },
          name: "Compatibility Mac",
          runnerId,
          runnerKind: "local",
          runtimeVersion: "compatibility-journey",
        }),
        {
          token: await enrollmentToken(host, {
            allowedModules: ["integrations"],
            idempotencyKey: "compatibility-mac",
            name: "Compatibility Mac",
          }),
        },
      );
      closers.unshift(async () => {
        primary.socket.close();
        await closed(primary.socket);
      });
      const auxiliary = await openAuxiliaryStream(host.hostPort, primary, "integrations");
      closers.unshift(async () => {
        auxiliary.socket.close();
        await closed(auxiliary.socket);
      });
      const screen = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "iphone.screen.attach",
          idempotencyKey: "compatibility-screen",
          driverRunnerId: runnerId,
          target: { kind: "new", name: "Compatibility iPhone" },
        },
        { headers: host.ownerHeaders },
      );
      if (screen.type !== "iphone.screen.attach") throw new Error("Expected a screen Device");
      const currentMachines = await testRpcData(
        host.origin,
        "machines.list",
        {},
        { headers: host.ownerHeaders },
      );
      expect(
        currentMachines.machines.find((machine) => machine.id === screen.deviceId),
      ).toMatchObject({
        name: "Compatibility iPhone",
        selfRunnerId: null,
        allowedModules: [],
      });
      const refused = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          type: "machine.rename",
          idempotencyKey: "old-screen-mutation",
          machineId: screen.deviceId,
          name: "Changed",
        },
        { headers: oldHeaders },
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        ok: false,
        error: {
          reason: "unsupported-version",
        },
      });
      const oldAttach = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          type: "iphone.screen.attach",
          idempotencyKey: "old-screen-attach",
          driverRunnerId: runnerId,
          target: { kind: "new", name: "Must not be created" },
        },
        { headers: oldHeaders },
      );
      expect(oldAttach.status).toBe(400);
      expect(await host.store.getDevice(screen.deviceId)).toMatchObject({
        name: "Compatibility iPhone",
      });
      const tabStore = new TabStore(host.store.database);
      const visibleTabId = createId("tab"),
        anchorTabId = createId("tab"),
        phoneTabId = createId("tab");
      for (const id of [visibleTabId, anchorTabId])
        await tabStore.open(
          {
            id,
            ownerId: host.ownerId,
            computerId: DeviceIdSchema.parse(runnerId),
            kind: "window",
            title: "Mac window",
            openedBy: "person",
            windowId: createId("window"),
            windowApp: { bundleId: "test.compatibility", displayName: "Fixture", teamId: null },
          },
          `fixture-${id}`,
        );
      await tabStore.open(
        {
          id: phoneTabId,
          ownerId: host.ownerId,
          computerId: screen.deviceId,
          kind: "phone",
          title: "iPhone",
          openedBy: "person",
        },
        "fixture-phone",
      );
      const grouped = await tabStore.organize(
        host.ownerId,
        { tabIds: [visibleTabId, phoneTabId], group: { name: "Mixed", color: "blue" } },
        "fixture-group",
      );
      const group = grouped.layout.items.find((item) => item.kind === "group");
      if (group?.kind !== "group") throw new Error("Expected a mixed group");
      host.runtime.tabs.changed(host.ownerId);
      realtime.socket.on("message", (raw) => {
        const decoded = ScopedHostMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!decoded.success) return;
        const frame = decoded.data;
        if (frame.type === "host.snapshot" || frame.type === "host.changes") {
          const { subscriptionId, generation, throughSequence } = frame;
          realtime.socket.send(
            JSON.stringify({ type: "client.ack", subscriptionId, generation, throughSequence }),
          );
        }
      });
      realtime.socket.send(
        JSON.stringify({
          type: "client.attach",
          apiVersion: hostApiVersion,
          generation: 1,
          interests: ["tab", "machine"],
          installed: {},
        }),
      );
      await vi.waitFor(
        () => {
          expect(realtime.messages).toContainEqual(
            expect.objectContaining({
              type: "host.resource",
              kind: "tab",
              view: expect.objectContaining({
                entries: expect.arrayContaining([
                  expect.objectContaining({ id: visibleTabId }),
                  expect.objectContaining({ id: phoneTabId }),
                  expect.objectContaining({ id: anchorTabId }),
                ]),
              }),
            }),
          );
        },
        { timeout: 5_000 },
      );
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "tab.organize",
          idempotencyKey: "group-move",
          tabIds: [phoneTabId],
          group: { groupId: group.group.groupId },
          beforeTabId: visibleTabId,
        },
        { headers: host.ownerHeaders },
      );
      expect((await tabStore.snapshot(host.ownerId)).layout.items[0]).toMatchObject({
        kind: "group",
        group: { tabIds: [phoneTabId, visibleTabId] },
      });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "tab.close",
          idempotencyKey: "visible-close",
          tabIds: [visibleTabId],
        },
        { headers: host.ownerHeaders },
      );
      expect((await tabStore.snapshot(host.ownerId)).rows.map((tab) => tab.id)).toContain(
        phoneTabId,
      );
      expect(realtime.socket.readyState).toBe(1);
      const catalog = await testRpcData(
        host.origin,
        "integration.platform.get",
        {},
        {
          headers: host.ownerHeaders,
        },
      );
      const calendar = catalog.catalog.find(({ definition }) => definition.id === "apple-calendar");
      expect(calendar).toBeDefined();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "compatibility-calendar-install",
          input: { definitionId: "apple-calendar", digest: calendar!.digest },
          type: "integration.catalog.install",
        },
        { headers: host.ownerHeaders },
      );
      const request = await requestComputerAppSetup(
        host,
        runnerId,
        "read",
        "compatibility-calendar",
        "apple-calendar",
      );
      setupRequestId = request.id;
      const machineResource = realtime.messages.find(
        (message) => message.type === "host.resource" && message.kind === "machine",
      );
      expect(ScopedHostMessageSchema.parse(machineResource)).toMatchObject({
        type: "host.resource",
        kind: "machine",
      });
      frames.push(machineResource);
      for (const method of methods) {
        const response = await testRpcRequest(
          host.origin,
          method,
          {},
          { headers: host.ownerHeaders },
        );
        expect(response.status, method).toBe(200);
        const raw = envelope.parse(await response.json()).data;
        hostApi[method].success.parse(raw);
        rpc.push({ method, data: raw });
      }
      const machineList = hostApi["machines.list"].success.parse(
        rpc.find(({ method }) => method === "machines.list")?.data,
      );
      expect(machineList.machines.some(({ id }) => id === screen.deviceId)).toBe(true);
      expect(machineList.machines.find(({ id }) => id === runnerId)).toMatchObject({
        device: { form: "laptop", platform: "macos" },
        name: "Compatibility Mac",
      });
      const pending = hostApi["integration.computer.setup.list"].success.parse(
        rpc.find(({ method }) => method === "integration.computer.setup.list")?.data,
      );
      expect(pending.requests.some(({ id }) => id === setupRequestId)).toBe(true);
      expect(rpc.map(({ method }) => method)).toEqual([...methods]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "responses.json"),
        JSON.stringify({ failure, knownMachineId: runnerId, setupRequestId, rpc, frames }, null, 2),
      );
    }
  });
});
