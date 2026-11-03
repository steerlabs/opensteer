import { mkdtemp, realpath, readFile, rm, utimes, lstat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginSnapshotDigest } from "@opensteer/agent-plugins";
import { cacheRunPlugins, fetchPluginPackage, prunePluginCache } from "./plugin-cache.js";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), "plugin-cache-")));
  dirs.push(stateDirectory);
  const files = [
    {
      path: "skills/test/SKILL.md",
      mode: 0o600,
      bytes: Buffer.from(
        "---\nname: test\ndescription: Test\n---\nRun ${PLUGIN_ROOT}/scripts/test.sh",
      ),
    },
    { path: "scripts/test.sh", mode: 0o700, bytes: Buffer.from("echo test") },
  ];
  // Loader traversal orders scripts before skills.
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = pluginSnapshotDigest(files);
  const snapshot = files.map(({ path, mode, bytes }) => ({
    path,
    mode,
    content: bytes.toString("base64"),
  }));
  return { stateDirectory, digest, snapshot };
}
describe("plugin package cache", () => {
  it("coalesces misses, verifies and atomically publishes a whole package, then hits disk", async () => {
    const f = await fixture();
    const fetchSnapshot = vi.fn(async () => f.snapshot);
    const [a, b] = await Promise.all([
      fetchPluginPackage({ ...f, fetchSnapshot }),
      fetchPluginPackage({ ...f, fetchSnapshot }),
    ]);
    expect(a).toBe(b);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(await readFile(join(a, "scripts/test.sh"), "utf8")).toBe("echo test");
    await fetchPluginPackage({ ...f, fetchSnapshot });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });
  it("verifies an existing entry on first use in this process", async () => {
    const f = await fixture();
    const root = join(f.stateDirectory, "plugins", f.digest);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "unapproved.cjs"), "tampered");
    const fetchSnapshot = vi.fn(async () => f.snapshot);
    await fetchPluginPackage({ ...f, fetchSnapshot });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await expect(lstat(join(root, "unapproved.cjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "scripts/test.sh"), "utf8")).toBe("echo test");
  });
  it("rejects digest mismatches without publishing", async () => {
    const f = await fixture();
    await expect(fetchPluginPackage({ ...f, fetchSnapshot: async () => [] })).rejects.toThrow(
      "digest mismatch",
    );
    await expect(lstat(join(f.stateDirectory, "plugins", f.digest))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retains active and warm references, gives skills sibling scripts, and prunes after release", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(f.snapshot))),
    );
    const run = await cacheRunPlugins({
      ...f,
      signal: new AbortController().signal,
      threadId: "thr_test",
      plan: {
        url: "https://host/plugins",
        token: "test",
        versions: [{ pluginId: "p", name: "test", digest: f.digest }],
      },
    });
    expect(run).toMatchObject({ directories: [join(f.stateDirectory, "plugins", f.digest)] });
    expect(run.skills[0]?.path).toBe(join(f.stateDirectory, "plugins", f.digest, "skills/test"));
    expect(await readFile(join(run.skills[0]!.path, "../../scripts/test.sh"), "utf8")).toBe(
      "echo test",
    );
    const root = join(f.stateDirectory, "plugins", f.digest);
    const old = new Date(0);
    await utimes(root, old, old);
    await prunePluginCache(f.stateDirectory);
    expect((await lstat(root)).isDirectory()).toBe(true);
    await run.cleanup();
    await utimes(root, old, old);
    await prunePluginCache(f.stateDirectory);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("resolves an approved MCP launch entirely against this Runner's cached package and data", async () => {
  const { LocalMcpServers } = await import("../computer-apps/local-mcp-servers.js");
  const f = await fixture();
  const script = {
    path: "server.cjs",
    mode: 0o600,
    bytes: Buffer.from(
      'require("node:fs").writeFileSync(process.env.PLUGIN_DATA+"/observed.json",JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,arg:process.argv[2]})); process.stdin.resume();',
    ),
  };
  const digest = pluginSnapshotDigest([script]);
  const snapshot = [
    { path: script.path, mode: script.mode, content: script.bytes.toString("base64") },
  ];
  const fetchSnapshot = vi.fn(async () => new Response(JSON.stringify(snapshot)));
  vi.stubGlobal("fetch", fetchSnapshot);
  const launch = {
    type: "stdio" as const,
    pluginId: "test",
    packageDigest: digest,
    command: process.execPath,
    cwd: "${PLUGIN_ROOT}",
    args: ["${PLUGIN_ROOT}/server.cjs", "${PLUGIN_DATA}/arg"],
    env: {},
  };
  const mcp = new LocalMcpServers({
    stateDirectory: f.stateDirectory,
  });
  const frames: { type: string }[] = [];
  mcp.attach(async (frame) => {
    frames.push(frame);
  });
  const frame = {
    type: "host.integrations.mcp.open" as const,
    serverId: "server_test",
    sessionId: "test",
    launch,
    packageSource: { url: "https://host/package", token: "test" },
  } as Parameters<typeof mcp.open>[0];
  try {
    const cached = await fetchPluginPackage({
      stateDirectory: f.stateDirectory,
      digest,
      fetchSnapshot: async () => snapshot,
    });
    await writeFile(join(cached, "server.cjs"), 'throw new Error("tampered")');
    await mcp.open(frame);
    expect(await readFile(join(cached, "server.cjs"), "utf8")).toBe(script.bytes.toString("utf8"));
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)?.type).toBe("runner.integrations.mcp.opened");
    const data = join(f.stateDirectory, "plugin-data/test");
    await vi.waitFor(
      async () => {
        expect(JSON.parse(await readFile(join(data, "observed.json"), "utf8"))).toEqual({
          cwd: join(f.stateDirectory, "plugins", digest),
          root: join(f.stateDirectory, "plugins", digest),
          arg: join(data, "arg"),
        });
      },
      { timeout: 2000 },
    );
  } finally {
    await mcp.close({ sessionId: "test" } as Parameters<typeof mcp.close>[0]);
    mcp.detach();
  }
});
