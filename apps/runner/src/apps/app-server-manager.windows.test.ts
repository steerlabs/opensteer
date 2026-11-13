import { createId } from "@opensteer/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ExecutionContainment } from "../runtime/execution-containment.js";
import { AppServerManager } from "./app-server-manager.js";

it("starts a server from a cmd start string, serves it, and leaves nothing behind when stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensteer app server "));
  const containment = new ExecutionContainment({ bootId: "windows-apps", dataDirectory: root });
  const manager = new AppServerManager({
    planLaunch: async (id) => containment.wrap(id, (launch) => launch),
    privateDirectory: join(root, "private"),
    readyTimeoutMs: 10_000,
    resolveRoot: async () => root,
    terminate: (id, stopEngine) => containment.terminate(id, stopEngine),
  });
  await writeFile(
    join(root, "server.cjs"),
    `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:http").createServer((request, response) => {
      response.end(JSON.stringify({ child: child.pid, greeting: process.env.GREETING }));
    }).listen(Number(process.env.PORT), "127.0.0.1");`,
  );
  let childPid: number | undefined;
  try {
    const port = await manager.start({
      agentHome: { computerId: createId("runner"), path: root },
      appId: "app_windows",
      command: `set "GREETING=hello from cmd" && "${process.execPath}" server.cjs`,
      folder: { computerId: createId("runner"), path: root },
      version: 1,
    } as Parameters<typeof manager.start>[0]);
    const served = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as {
      child: number;
      greeting: string;
    };
    childPid = served.child;
    expect(served.greeting).toBe("hello from cmd");
    expect(() => process.kill(served.child, 0)).not.toThrow();

    await manager.stop("app_windows");

    expect(() => process.kill(served.child, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    await expect(containment.liveRoots("app:app_windows:1")).resolves.toBe(0);
  } finally {
    await manager.stopAll();
    if (childPid) {
      try {
        process.kill(childPid);
      } catch {
        // Already contained.
      }
    }
    await rm(root, { force: true, recursive: true });
  }
});
