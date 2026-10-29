import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { HostToClientMessageSchema, RunnerDescriptorSchema, hostApi } from "@opensteer/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { requestComputerAppSetup } from "./computer-apps.test-support.js";
import {
  closed,
  connectPrimary,
  createMachineAccessDatabase,
  enrollmentToken,
  openRealtime,
  startMachineAccessHost,
  waitForCondition,
} from "./machine-access.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const methods = [
  "bootstrap.get",
  "machines.list",
  "integrations.get",
  "integration.platform.get",
  "integration.computer.setup.list",
] as const;
const envelope = z.object({ ok: z.literal(true), data: z.unknown() });

/*
 * Capture actual responses, not re-encoded parsed views: an older parser must
 * see precisely what the Host emitted. Include the later-parsed installation
 * manifest and an actual machine notification, beside a known Mac and pending
 * app approval. The release check runs the previous release's own parsers over
 * this corpus; current-schema success alone is not compatibility evidence.
 */
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

  it("exports live Host responses and a machine event for previous-release readers", async () => {
    const directory =
      process.env.OPENSTEER_PLATFORM_COMPAT_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-platform-compat-")));
    const rpc: { method: (typeof methods)[number]; data: unknown }[] = [];
    const frames: unknown[] = [];
    let failure: string | null = null;
    const host = await startMachineAccessHost(database!.url);
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
              protocolVersion: 5,
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
      await waitForCondition(async () =>
        realtime.messages.some((message) => message.type === "host.machines.changed"),
      );
      const changed = realtime.messages.find((message) => message.type === "host.machines.changed");
      HostToClientMessageSchema.parse(changed);
      frames.push(changed);
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
