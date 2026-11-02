import { mkdtemp, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { AppServerManager } from "./app-server-manager.js";

it("shares starts, refuses stale generations, lazily restarts crashes and stops on connection loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-"));
  const starts: string[] = [];
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    planLaunch: async (id) => {
      starts.push(id);
      return (launch) => launch;
    },
    terminate: async (_id, stopEngine) => stopEngine(),
    readyTimeoutMs: 2_000,
  });
  const spec = {
    appId: "app_test",
    version: 1,
    folder: ".",
    command: `${process.execPath} server.cjs`,
    binding: {},
  } as Parameters<typeof manager.start>[0];
  await writeFile(
    join(root, "server.cjs"),
    `require('node:http').createServer((q,s)=>{s.end('ok');if(q.url==='/crash')s.on('finish',()=>process.exit(0))}).listen(process.env.PORT,'127.0.0.1')`,
  );
  try {
    const ports = await Promise.all([
      manager.start(spec),
      manager.start(spec),
      manager.start(spec),
    ]);
    expect(new Set(ports).size).toBe(1);
    expect(starts).toHaveLength(1);
    const exited = manager.exited(spec.appId);
    await fetch(`http://127.0.0.1:${ports[0]}/crash`);
    await exited;
    expect(await manager.start(spec)).toBeGreaterThan(0);
    expect(starts).toHaveLength(2);
    const previousPort = await manager.start(spec);
    await manager.start({ ...spec, version: 2 });
    await expect(fetch(`http://127.0.0.1:${previousPort}`)).rejects.toThrow();
    await expect(manager.start(spec)).rejects.toThrow(/stale/i);
    expect(starts).toHaveLength(3);
    const port = await manager.start({ ...spec, version: 2 });
    const otherPort = await manager.start({ ...spec, appId: `app_${crypto.randomUUID()}` });
    await manager.stopAll();
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${otherPort}`)).rejects.toThrow();
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("returns bounded log tails on exit and readiness timeout and rejects escaping folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer-app-server-"));
  const manager = new AppServerManager({
    resolveRoot: async () => root,
    planLaunch: async () => (l) => l,
    terminate: async (_id, stopEngine) => stopEngine(),
    readyTimeoutMs: 200,
  });
  const spec = {
    appId: "app_test",
    version: 1,
    folder: ".",
    command: "",
    binding: {},
  } as Parameters<typeof manager.start>[0];
  try {
    await writeFile(
      join(root, "fail.cjs"),
      "console.error('x'.repeat(20000)+'failure tail');process.exit(1)",
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
    await symlink(tmpdir(), join(root, "escape"));
    for (const folder of ["../escape", "/tmp", "escape", "a/../b", "a\\b"])
      await expect(manager.start({ ...spec, folder })).rejects.toThrow(/relative|outside|escape/i);
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
    terminate: async (_id, stopEngine) => stopEngine(),
  });
  const spec = {
    appId: "unused",
    version: 1,
    folder: ".",
    command: "exit 1",
    binding: {},
  } as Parameters<typeof manager.start>[0];
  const starts = Array.from({ length: 32 }, () =>
    manager.start({ ...spec, appId: `app_${crypto.randomUUID()}` }),
  );
  const settled = Promise.allSettled(starts);
  try {
    await withTimeout(admitted.promise, 1_000, {
      timeoutError: () => new Error("Concurrent server slots were not reserved"),
    });
    await expect(manager.start({ ...spec, appId: `app_${crypto.randomUUID()}` })).rejects.toThrow(
      "32 app servers",
    );
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
    folder: ".",
    command: `${process.execPath} parent.cjs`,
    binding: {},
  } as Parameters<typeof manager.start>[0];
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
    folder: ".",
    command: `exec ${process.execPath} server.cjs`,
    binding: {},
  } as Parameters<typeof manager.start>[0];
  const starts: Promise<number>[] = [];
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
      starts.push(manager.start({ ...spec, appId: `app_reserved_${index}` }));
    settled = Promise.allSettled(starts);
    await withTimeout(slotsReserved.promise, 1_000, {
      timeoutError: () => new Error("Server slots were not reserved"),
    });
    await expect(manager.start({ ...spec, appId: "app_over_limit" })).rejects.toThrow(
      "32 app servers",
    );
    allowCleanup.resolve();
    await exited;
    expect(await readdir(privateDirectory)).toHaveLength(31);
    expect(() => process.kill(childPid!, 0)).toThrow();
    expect(manager.logTail(spec.appId)).toContain("crash tail");
    starts.push(manager.start({ ...spec, appId: "app_replacement" }));
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
