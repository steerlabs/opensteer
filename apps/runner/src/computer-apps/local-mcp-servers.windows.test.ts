import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { generatedShims } from "@opensteer/shared/test-support/commandShims";
import { echoMcpServerSource, exchangeOverOneMebibyte } from "./local-mcp-servers.test-support.js";
import { prepareIntegrationsModule } from "./prepare.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
});

it("runs a package's .cmd shim found on the approved Path, through plugin-data removal", async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer local mcp ")));
  const bin = path.join(directory, "node_modules", ".bin");
  const script = path.join(directory, "node_modules", "echo-argv", "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(script, { recursive: true });
  await writeFile(path.join(script, "echo-argv.js"), echoMcpServerSource);
  await writeFile(path.join(bin, "echo-mcp.cmd"), generatedShims.npm.node);
  const prepared = prepareIntegrationsModule({ dataDirectory: directory, platform: "win32" });
  expect(prepared?.providers).toEqual([]);
  expect(prepared?.descriptor).toMatchObject({ pluginDataRemoval: 1, platform: "win32" });
  const servers = prepared!.localMcp;
  const data = path.join(directory, "private", "harness-state", "plugin-data", "plugin-1");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "pairing"), "secret");
  try {
    const { serverPid } = await exchangeOverOneMebibyte(servers, {
      args: [],
      command: "echo-mcp",
      cwd: directory,
      env: {
        Path: [
          bin,
          path.dirname(process.execPath),
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
        ].join(";"),
      },
      pluginId: "plugin-1",
    });
    expect(() => process.kill(serverPid, 0)).toThrow();
    await servers.removePluginData("plugin-1");
    await expect(readFile(path.join(data, "pairing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    servers.detach();
    prepared?.close?.();
  }
});
