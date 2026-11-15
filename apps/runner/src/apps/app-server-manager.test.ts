import { createId } from "@opensteer/core";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AppRuntimeSpec } from "@opensteer/protocol";
import { AppServerManager, type AppServerState } from "./app-server-manager.js";
import { freePort, freePorts } from "./free-port.test-support.js";

const crashServer = `require('node:http').createServer((q,s)=>{s.end('ok');if(q.url==='/crash')s.on('finish',()=>process.exit(0))}).listen(process.env.PORT,'127.0.0.1')`;

function provenManager(root: string, starts: string[] = [], readyTimeoutMs = 2_000) {
  return new AppServerManager({
    resolveRoot: async () => root,
    privateDirectory: join(root, "private"),
    planLaunch: async (id) => {
      starts.push(id);
      return (launch) => launch;
    },
    terminate: async (_id, stopEngine) => {
      await stopEngine();
      return "proven";
    },
    readyTimeoutMs,
  });
}

async function specFor(root: string, command: string, port?: number): Promise<AppRuntimeSpec> {
  const computerId = createId("runner");
  return {
    appId: `app_${crypto.randomUUID()}`,
    version: 1,
    generation: 1,
    port: port ?? (await freePort()),
    folder: { computerId, path: root },
    agentHome: { computerId, path: root },
    command,
  };
}

function recordStates(manager: AppServerManager) {
  const states: AppServerState[] = [];
  const waiters: Array<{ match: (state: AppServerState) => boolean; resolve: () => void }> = [];
  manager.observe((state) => {
    states.push(state);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(state)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  return {
    states,
    next(match: (state: AppServerState) => boolean, what: string) {
      const reached = Promise.withResolvers<void>();
      waiters.push({ match, resolve: reached.resolve });
      return withTimeout(reached.promise, 2_000, {
        timeoutError: () => new Error(`App state never reported ${what}`),
      });
    },
  };
}

it("starts on the fixed port, shares starts, adopts a newer generation and fences stopped generations until the connection ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-"));
  const starts: string[] = [];
  const manager = provenManager(root, starts);
  const reports = recordStates(manager);
  const spec = await specFor(root, `${process.execPath} server.cjs`);
  await writeFile(join(root, "server.cjs"), crashServer);
  try {
    const ports = await Promise.all([
      manager.start(spec),
      manager.start(spec),
      manager.start(spec),
    ]);
    expect(ports).toEqual([spec.port, spec.port, spec.port]);
    expect(starts).toHaveLength(1);
    expect(manager.running(spec)).toBe(true);
    const crashed = reports.next((state) => state.state === "failed", "the crash");
    await fetch(`http://127.0.0.1:${spec.port}/crash`);
    await crashed;
    await manager.exited(spec.appId);
    expect(manager.running(spec)).toBe(false);
    // Nothing restarts a crashed server until the Host asks again.
    expect(starts).toHaveLength(1);
    await manager.start(spec);
    expect(starts).toHaveLength(2);

    // A newer generation of the same runtime adopts the live process.
    const newer = { ...spec, generation: 2 };
    expect(await manager.start(newer)).toBe(spec.port);
    expect(starts).toHaveLength(2);
    expect(manager.running(spec)).toBe(false);
    expect(manager.running(newer)).toBe(true);
    await manager.stop(spec.appId, 2);
    expect(reports.states.at(-1)).toEqual({
      appId: spec.appId,
      version: 1,
      generation: 2,
      state: "stopped",
    });
    await expect(fetch(`http://127.0.0.1:${spec.port}`)).rejects.toThrow();
    // A start the Host sent before its Stop cannot recreate the server.
    await expect(manager.start(newer)).rejects.toThrow(/stopped after the start/);
    await manager.start({ ...spec, generation: 3 });
    await manager.stopAll();
    await expect(fetch(`http://127.0.0.1:${spec.port}`)).rejects.toThrow();
    // A new connection starts from the Host's current generations again.
    expect(await manager.start(spec)).toBe(spec.port);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a port another program holds without touching that program", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-port-"));
  const manager = provenManager(root);
  const reports = recordStates(manager);
  const foreign = createServer((_request, response) => response.end("foreign"));
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  if (!address || typeof address === "string") throw new Error("Missing foreign port");
  const spec = await specFor(root, `${process.execPath} server.cjs`, address.port);
  await writeFile(join(root, "server.cjs"), crashServer);
  try {
    await expect(manager.start(spec)).rejects.toThrow(`Port ${address.port} is in use`);
    expect(reports.states).toEqual([
      expect.objectContaining({ appId: spec.appId, state: "failed" }),
    ]);
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("foreign");
    expect(manager.running(spec)).toBe(false);
  } finally {
    await manager.stopAll();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("lets Stop abort a pending start, which reports no failure and cannot run later", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-pending-"));
  const launched = Promise.withResolvers<void>();
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    privateDirectory: join(root, "private"),
    planLaunch: async () => {
      launched.resolve();
      return (launch) => launch;
    },
    terminate: async (_id, stopEngine) => {
      await stopEngine();
      return "proven";
    },
    readyTimeoutMs: 20_000,
  });
  const reports = recordStates(manager);
  const spec = await specFor(root, `${process.execPath} hang.cjs`);
  await writeFile(join(root, "hang.cjs"), "setInterval(()=>{},10000)");
  try {
    const starting = manager.start(spec, AbortSignal.timeout(20_000));
    await withTimeout(launched.promise, 2_000, {
      timeoutError: () => new Error("The start never launched"),
    });
    await withTimeout(manager.stop(spec.appId, 1), 2_000, {
      timeoutError: () => new Error("Stop waited for the pending start's readiness"),
    });
    await expect(starting).rejects.toThrow("App server stopped");
    await expect(manager.start(spec)).rejects.toThrow(/stopped after the start/);
    expect(reports.states.filter((state) => state.state === "failed")).toEqual([]);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles a complete set: stops absent and stopped apps, starts desired ones and fences what it stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-sync-"));
  const manager = provenManager(root);
  const reports = recordStates(manager);
  await writeFile(join(root, "server.cjs"), crashServer);
  const [kept, absent, desired] = await Promise.all(
    [0, 1, 2].map(() => specFor(root, `${process.execPath} server.cjs`)),
  );
  try {
    await manager.start(kept!);
    await manager.start(absent!);
    const stoppedKept = { ...kept!, generation: 2 };
    await manager.sync(
      [
        { spec: stoppedKept, desiredState: "stopped" },
        { spec: desired!, desiredState: "running" },
      ],
      AbortSignal.timeout(5_000),
    );
    expect(manager.running(desired!)).toBe(true);
    expect(manager.running(kept!)).toBe(false);
    expect(manager.running(absent!)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${absent!.port}`)).rejects.toThrow();
    expect(await (await fetch(`http://127.0.0.1:${desired!.port}`)).text()).toBe("ok");
    expect(reports.states).toContainEqual({
      appId: desired!.appId,
      version: 1,
      generation: 1,
      state: "running",
    });
    // A late start of a deleted or stopped generation cannot recreate it.
    await expect(manager.start(absent!)).rejects.toThrow(/stopped after the start/);
    await expect(manager.start(stoppedKept)).rejects.toThrow(/stopped after the start/);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("returns bounded log tails on exit and readiness timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-"));
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    planLaunch: async () => (l) => l,
    terminate: async (_id, stopEngine) => {
      await stopEngine();
      return "proven";
    },
    readyTimeoutMs: 200,
  });
  const spec = {
    appId: "app_test",
    version: 1,
    generation: 1,
    port: await freePort(),
    folder: { computerId: createId("runner"), path: root },
    agentHome: { computerId: createId("runner"), path: root },
    command: "",
  } satisfies AppRuntimeSpec;
  try {
    await writeFile(
      join(root, "fail.cjs"),
      // Past any lifetime output cap, so the tail must still be the newest output.
      "process.stderr.write('x'.repeat(2*1024*1024),()=>{console.error('failure tail');process.exit(1)})",
    );
    const failed = await manager
      .start({ ...spec, command: `${process.execPath} fail.cjs` })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ logTail: expect.stringContaining("failure tail") });
    expect(Buffer.byteLength((failed as { logTail: string }).logTail)).toBeLessThanOrEqual(
      16 * 1_024,
    );
    await writeFile(
      join(root, "hang.cjs"),
      "console.error('never ready');setInterval(()=>{},10000)",
    );
    await expect(
      manager.start({ ...spec, command: `${process.execPath} hang.cjs` }),
    ).rejects.toMatchObject({ logTail: expect.stringContaining("never ready") });
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("reserves the Runner's server limit across concurrent apps and refuses launches queued before connection loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-limit-"));
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    privateDirectory: join(root, "private"),
    planLaunch: async () => {
      if (++count === 32) admitted.resolve();
      await withTimeout(release.promise, 2_000, {
        timeoutError: () => new Error("Launch planner was not released"),
      });
      return (launch) => launch;
    },
    terminate: async (_id, stopEngine) => {
      await stopEngine();
      return "proven";
    },
  });
  const spec = {
    appId: "unused",
    version: 1,
    generation: 1,
    port: await freePort(),
    folder: { computerId: createId("runner"), path: root },
    agentHome: { computerId: createId("runner"), path: root },
    command: "exit 1",
  } satisfies AppRuntimeSpec;
  const ports = await freePorts(33);
  const starts = ports
    .slice(0, 32)
    .map((port) => manager.start({ ...spec, port, appId: `app_${crypto.randomUUID()}` }));
  const settled = Promise.allSettled(starts);
  try {
    await withTimeout(admitted.promise, 1_000, {
      timeoutError: () => new Error("Concurrent server slots were not reserved"),
    });
    await expect(
      manager.start({ ...spec, port: ports[32]!, appId: `app_${crypto.randomUUID()}` }),
    ).rejects.toThrow("32 app servers");
    const stopped = manager.stopAll();
    release.resolve();
    await stopped;
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(count).toBe(32);
  } finally {
    release.resolve();
    await settled;
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("inventories detached descendants without the execution marker before stopping the server group", async () => {
  const { ExecutionContainment } = await import("../runtime/execution-containment.js");
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-containment-"));
  const containment = new ExecutionContainment({ bootId: "app-server-test", dataDirectory: root });
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    privateDirectory: join(root, "private"),
    planLaunch: async (id) => containment.wrap(id, (launch) => launch),
    terminate: (id, stopEngine?: () => Promise<unknown>) => containment.terminate(id, stopEngine),
    readyTimeoutMs: 2_000,
  });
  let childPid: number | undefined;
  const spec = {
    appId: `app_${crypto.randomUUID()}`,
    version: 1,
    generation: 1,
    port: await freePort(),
    folder: { computerId: createId("runner"), path: root },
    agentHome: { computerId: createId("runner"), path: root },
    command: `${process.execPath} parent.cjs`,
  } satisfies AppRuntimeSpec;
  try {
    await writeFile(
      join(root, "parent.cjs"),
      `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});require('node:http').createServer((q,s)=>s.end(String(child.pid))).listen(process.env.PORT,'127.0.0.1');`,
    );
    const port = await manager.start(spec);
    childPid = Number(await (await fetch(`http://127.0.0.1:${port}`)).text());
    expect(Number.isInteger(childPid)).toBe(true);
    expect(childPid).toBeGreaterThan(0);
    process.kill(childPid, 0);
    await manager.stopAll();
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already contained. */
      }
    }
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("cleans a crashed server and descendants before releasing its capacity and launch directory", async () => {
  const { ExecutionContainment } = await import("../runtime/execution-containment.js");
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-crash-"));
  const privateDirectory = join(root, "private");
  const containment = new ExecutionContainment({ bootId: "crash-test", dataDirectory: root });
  const cleanupStarted = Promise.withResolvers<void>();
  const allowCleanup = Promise.withResolvers<void>();
  const releaseLaunches = Promise.withResolvers<void>();
  const slotsReserved = Promise.withResolvers<void>();
  const replacementReserved = Promise.withResolvers<void>();
  let reservations = 0;
  let childPid: number | undefined;
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    privateDirectory,
    planLaunch: async (id) => {
      if (!id.startsWith("app:app_crash:")) {
        if (++reservations === 31) slotsReserved.resolve();
        if (reservations === 32) replacementReserved.resolve();
        await withTimeout(releaseLaunches.promise, 3_000, {
          timeoutError: () => new Error("Launch reservations were not released"),
        });
      }
      return containment.wrap(id, (launch) => launch);
    },
    terminate: async (id, stopEngine?: () => Promise<unknown>) => {
      if (id.startsWith("app:app_crash:")) {
        cleanupStarted.resolve();
        await withTimeout(allowCleanup.promise, 2_000, {
          timeoutError: () => new Error("Crash cleanup was not released"),
        });
      }
      return containment.terminate(id, stopEngine);
    },
    readyTimeoutMs: 2_000,
  });
  const spec = {
    appId: "app_crash",
    version: 1,
    generation: 1,
    port: await freePort(),
    folder: { computerId: createId("runner"), path: root },
    agentHome: { computerId: createId("runner"), path: root },
    command: `exec ${process.execPath} server.cjs`,
  } satisfies AppRuntimeSpec;
  const starts: Promise<number>[] = [];
  const ports = await freePorts(33);
  let settled: Promise<PromiseSettledResult<number>[]> | undefined;
  try {
    await writeFile(
      join(root, "server.cjs"),
      `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();require('node:http').createServer((q,s)=>{s.end(String(child.pid));if(q.url==='/crash'){console.error('crash tail');s.on('finish',()=>process.exit(1));}}).listen(process.env.PORT,'127.0.0.1');`,
    );
    const port = await manager.start(spec);
    const exited = manager.exited(spec.appId);
    childPid = Number(await (await fetch(`http://127.0.0.1:${port}/crash`)).text());
    expect(childPid).toBeGreaterThan(0);
    await withTimeout(cleanupStarted.promise, 1_000, {
      timeoutError: () => new Error("Crashed server never queued containment cleanup"),
    });
    for (let index = 0; index < 31; index++)
      starts.push(manager.start({ ...spec, port: ports[index]!, appId: `app_reserved_${index}` }));
    settled = Promise.allSettled(starts);
    await withTimeout(slotsReserved.promise, 1_000, {
      timeoutError: () => new Error("Server slots were not reserved"),
    });
    await expect(
      manager.start({ ...spec, port: ports[31]!, appId: "app_over_limit" }),
    ).rejects.toThrow("32 app servers");
    allowCleanup.resolve();
    await exited;
    expect(await readdir(privateDirectory)).toHaveLength(31);
    expect(() => process.kill(childPid!, 0)).toThrow();
    expect(manager.logTail(spec.appId)).toContain("crash tail");
    starts.push(manager.start({ ...spec, port: ports[32]!, appId: "app_replacement" }));
    settled = Promise.allSettled(starts);
    await withTimeout(replacementReserved.promise, 1_000, {
      timeoutError: () => new Error("Cleaned server did not release its capacity"),
    });
    const stopping = manager.stopAll();
    releaseLaunches.resolve();
    await stopping;
    await settled;
    expect(reservations).toBe(32);
    expect(await readdir(privateDirectory)).toEqual([]);
  } finally {
    allowCleanup.resolve();
    releaseLaunches.resolve();
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already contained. */
      }
    }
    await settled;
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["stop", "replacement", "crash", "stopAll"] as const)(
  "retains ownership, capacity and launch files after unknown containment during %s until a proven stop",
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-app-unknown-"));
    const privateDirectory = join(root, "private");
    const releaseLaunches = Promise.withResolvers<void>();
    const slotsReserved = Promise.withResolvers<void>();
    const replacementReserved = Promise.withResolvers<void>();
    const cleanupAttempted = Promise.withResolvers<void>();
    let reservations = 0;
    let proof: "unknown" | "proven" = "unknown";
    const manager = new AppServerManager({
      resolveRoot: async () => root,
      privateDirectory,
      planLaunch: async (id) => {
        if (!id.startsWith("app:app_uncertain:")) {
          if (++reservations === 31) slotsReserved.resolve();
          if (reservations === 32) replacementReserved.resolve();
          await withTimeout(releaseLaunches.promise, 3_000, {
            timeoutError: () => new Error("Launch reservations were not released"),
          });
        }
        return (launch) => launch;
      },
      terminate: async (_id, stopEngine) => {
        await stopEngine();
        cleanupAttempted.resolve();
        return proof;
      },
      readyTimeoutMs: 2_000,
    });
    const spec = {
      appId: "app_uncertain",
      version: 1,
      generation: 1,
      port: await freePort(),
      folder: { computerId: createId("runner"), path: root },
      agentHome: { computerId: createId("runner"), path: root },
      command: `exec ${process.execPath} server.cjs`,
    } satisfies AppRuntimeSpec;
    const starts: Promise<number>[] = [];
    const ports = await freePorts(33);
    let settled: Promise<PromiseSettledResult<number>[]> | undefined;
    try {
      await writeFile(
        join(root, "server.cjs"),
        `require('node:http').createServer((q,s)=>{s.end('ok');if(q.url==='/crash')s.on('finish',()=>process.exit(1))}).listen(process.env.PORT,'127.0.0.1')`,
      );
      const port = await manager.start(spec);
      const [launchDirectory] = await readdir(privateDirectory);
      if (operation === "crash") {
        await fetch(`http://127.0.0.1:${port}/crash`);
        await withTimeout(cleanupAttempted.promise, 1_000, {
          timeoutError: () => new Error("Crashed server never attempted containment cleanup"),
        });
      } else {
        const stopping =
          operation === "replacement"
            ? manager.start({ ...spec, version: 2 })
            : operation === "stopAll"
              ? manager.stopAll()
              : manager.stop(spec.appId, 1);
        await expect(stopping).rejects.toThrow(/cannot prove.*stopped/i);
      }
      // Stop fenced generation 1, so later attempts use the next generation.
      await expect(manager.start({ ...spec, generation: 2, version: 2 })).rejects.toThrow(
        /cannot prove.*stopped/i,
      );
      await expect(manager.start({ ...spec, generation: 2 })).rejects.toThrow(
        /cannot prove.*stopped/i,
      );
      expect(await readdir(privateDirectory)).toEqual([launchDirectory]);
      for (let index = 0; index < 31; index++)
        starts.push(
          manager.start({ ...spec, port: ports[index]!, appId: `app_reserved_${index}` }),
        );
      settled = Promise.allSettled(starts);
      await withTimeout(slotsReserved.promise, 1_000, {
        timeoutError: () => new Error("Server slots were not reserved"),
      });
      await expect(
        manager.start({ ...spec, port: ports[31]!, appId: "app_over_limit" }),
      ).rejects.toThrow("32 app servers");

      proof = "proven";
      await manager.stop(spec.appId, 2);
      expect(await readdir(privateDirectory)).not.toContain(launchDirectory);
      starts.push(manager.start({ ...spec, port: ports[32]!, appId: "app_replacement" }));
      settled = Promise.allSettled(starts);
      await withTimeout(replacementReserved.promise, 1_000, {
        timeoutError: () => new Error("Proven cleanup did not release its server slot"),
      });
      expect(reservations).toBe(32);
    } finally {
      proof = "proven";
      const stopping = manager.stopAll();
      releaseLaunches.resolve();
      await stopping;
      await settled;
      await rm(root, { recursive: true, force: true });
    }
  },
);
