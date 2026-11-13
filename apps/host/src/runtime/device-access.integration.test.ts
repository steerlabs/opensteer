import { RequestIdSchema } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { callMcpTool } from "../mcp/call-tool.test-support.js";
import {
  acceptCallerRun,
  connectCallerMachine,
  connectTargetMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startMachineAccessWireHost,
  updateAccessPolicy,
  waitForExecute,
} from "./machine-access-protocol.test-support.js";

it("holds device access through MCP and resumes with rebuilt routes after the policy commit", async () => {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  const closers: (() => Promise<unknown>)[] = [() => database.drop()];
  try {
    const host = await startMachineAccessWireHost(database.url, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Home",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const target = await connectTargetMachine(host, {
      name: "Workshop",
      token: await enrollmentToken(host, {
        allowedModules: ["shell"],
        idempotencyKey: "disabled-workshop",
        name: "Workshop",
      }),
    });
    closers.unshift(() => target.close());
    const run = await dispatchCallerRun(host, caller, {
      key: "request-files",
      title: "Read project",
    });
    expect(run.machineAccess.machines).toEqual([]);
    expect(run.integrationTools.instructions).toContain(target.runnerId);
    expect(run.integrationTools.instructions).toContain('"files":"disabled"');
    const opened = Promise.withResolvers<string>();
    const create = host.store.requests.createDeviceAccessRequest.bind(host.store.requests);
    vi.spyOn(host.store.requests, "createDeviceAccessRequest").mockImplementation(
      async (...args) => {
        const result = await create(...args);
        opened.resolve(result.request.id);
        return result;
      },
    );
    const stopped = Promise.withResolvers<void>();
    const stop = host.store.stopHeldRun.bind(host.store);
    vi.spyOn(host.store, "stopHeldRun").mockImplementation(async (...args) => {
      const result = await stop(...args);
      if (args[1] === "device-access") stopped.resolve();
      return result;
    });
    const held = callMcpTool(host.origin, run.toolsToken, "device_access_request", {
      machineId: target.runnerId,
      access: "files",
      reason: "Read project",
    });
    void held.catch(() => undefined);
    const requestId = await withTimeout(opened.promise, 5000, {
      timeoutError: () => new Error("MCP never created the device access Request"),
    });
    expect(
      await host.store.database
        .selectFrom("agentControlRequests")
        .select("action")
        .where("runId", "=", run.runId)
        .execute(),
    ).toEqual([{ action: "device.access.request" }]);
    await updateAccessPolicy(host, {
      runnerId: target.runnerId,
      expectedRevision: 1,
      key: "enable-workshop",
      policy: { reach: "owner", commands: true, forwarding: true, shares: [] },
    });
    await withTimeout(stopped.promise, 5000, {
      timeoutError: () => new Error("Fulfilled access never stopped the Run with stale routes"),
    });
    const next = waitForExecute(caller.primary.socket);
    await run.reportInterrupted();
    const command = await next;
    expect(command.command.context.runId).not.toBe(run.runId);
    expect(command.command.context.machineAccess.machines).toEqual(
      expect.arrayContaining([expect.objectContaining({ runnerId: target.runnerId })]),
    );
    expect(command.command.context.agentTools.instructions).toContain('"files":"enabled"');
    const continued = await acceptCallerRun(host, caller, command);
    await continued.complete();
    await held.catch(() => undefined);
    expect((await host.store.requests.get(RequestIdSchema.parse(requestId)))?.status).toBe(
      "fulfilled",
    );
  } finally {
    await cleanup();
  }
  async function cleanup() {
    vi.restoreAllMocks();
    const errors: unknown[] = [];
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Device access test cleanup failed");
  }
}, 60000);
