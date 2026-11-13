import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalMcpServers, localMcpEnvironment, type LocalMcpFrame } from "./local-mcp-servers.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-removal-")));
  const data = path.join(directory, "plugin-data", "plugin-1");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "pairing"), "secret");
  return { data, servers: new LocalMcpServers({ stateDirectory: directory }) };
}

it("ends all plugin sessions before deleting state and acknowledges repeated removal", async () => {
  const { data, servers } = await fixture();
  const sent: LocalMcpFrame[] = [];
  servers.attach(async (frame) => {
    sent.push(frame);
  });
  // Real programs exercise the session registry and process teardown.
  const launch = {
    type: "stdio" as const,
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    cwd: directory!,
    env: {},
    pluginId: "plugin-1",
  };
  try {
    for (const sessionId of ["one", "two"])
      await servers.open({ sessionId, launch } as unknown as Parameters<
        LocalMcpServers["open"]
      >[0]);
    const close = servers.close.bind(servers);
    const closing = vi.spyOn(servers, "close").mockImplementation(async (frame) => {
      expect(await readFile(path.join(data, "pairing"), "utf8")).toBe("secret");
      await close(frame);
    });
    await servers.removePluginData("plugin-1");
    expect(closing).toHaveBeenCalledTimes(2);
    await expect(readFile(path.join(data, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
    await servers.removePluginData("plugin-1");
    expect(
      sent.filter((frame) => frame.type === "runner.integrations.plugin-data.removed"),
    ).toHaveLength(2);
  } finally {
    servers.detach();
  }
});

it("refuses traversal ids and symlink parents while preserving outside data", async () => {
  const { data, servers } = await fixture();
  for (const id of ["", "..", "../plugin-1", "/tmp", "a/b", "a\\b"])
    await expect(servers.removePluginData(id)).rejects.toThrow("Invalid plugin id");
  const root = path.dirname(data);
  await rm(root, { recursive: true });
  const outside = path.join(directory!, "outside");
  await mkdir(path.join(outside, "plugin-1"), { recursive: true });
  await writeFile(path.join(outside, "plugin-1", "pairing"), "keep");
  await symlink(outside, root);
  await expect(servers.removePluginData("plugin-1")).rejects.toThrow("real directory");
  expect(await readFile(path.join(outside, "plugin-1", "pairing"), "utf8")).toBe("keep");
  await rm(root);
  await mkdir(root);
  await symlink(path.join(outside, "plugin-1"), data);
  await servers.removePluginData("plugin-1");
  expect(await readFile(path.join(outside, "plugin-1", "pairing"), "utf8")).toBe("keep");
});

it("waits for disconnected sessions to finish writing state before removing it", async () => {
  const { data, servers } = await fixture();
  const { withTimeout } = await import("@opensteer/shared/withTimeout");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  servers.attach(async (frame) => {
    if (frame.type === "runner.integrations.mcp.message") started();
  });
  const launch = {
    type: "stdio" as const,
    pluginId: "plugin-1",
    command: process.execPath,
    args: [
      "-e",
      `const fs = require('node:fs');
      process.on('SIGTERM', () => { fs.writeFileSync(process.env.PAIRING, 'last write'); process.exit(0); });
      process.stdin.resume();
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'})+'\\n');`,
    ],
    cwd: directory!,
    env: { PAIRING: path.join(data, "pairing") },
  };
  try {
    await servers.open({ sessionId: "disconnect", launch } as unknown as Parameters<
      LocalMcpServers["open"]
    >[0]);
    await withTimeout(ready, 1_000, {
      timeoutError: () => new Error("Plugin process did not report ready"),
    });
    servers.detach();
    await servers.removePluginData("plugin-1");
    await expect(readFile(path.join(data, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    servers.detach();
  }
});

it("confirms removal when the state directory has never existed", async () => {
  const { servers } = await fixture();
  await rm(directory!, { recursive: true });
  const sent: LocalMcpFrame[] = [];
  servers.attach(async (frame) => {
    sent.push(frame);
  });
  await servers.removePluginData("plugin-1");
  expect(sent).toEqual([{ type: "runner.integrations.plugin-data.removed", pluginId: "plugin-1" }]);
});

it("gives a Windows local program the baseline under its approved variables, one spelling each", () => {
  const environment = localMcpEnvironment(
    { Path: "C:\\plugin\\bin", TOOL_MODE: "fast" },
    {
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      NODE_OPTIONS: "--require evil.js",
      OPENSTEER_RUNNER_TOKEN: "private",
      PATH: "C:\\Windows\\system32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
    },
    "win32",
  );
  expect(environment).toMatchObject({
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    Path: "C:\\plugin\\bin",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    TOOL_MODE: "fast",
  });
  expect(Object.keys(environment).filter((name) => name.toUpperCase() === "PATH")).toEqual([
    "Path",
  ]);
  expect(environment).not.toHaveProperty("NODE_OPTIONS");
  expect(environment).not.toHaveProperty("OPENSTEER_RUNNER_TOKEN");
});
