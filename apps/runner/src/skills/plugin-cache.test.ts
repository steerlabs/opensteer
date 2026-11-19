import {
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rm,
  utimes,
  lstat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maximumPluginPackageFiles, pluginSnapshotDigest } from "@opensteer/agent-plugins";
import { LocalMcpServers } from "../computer-apps/local-mcp-servers.js";
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

async function launchFixture(extra: { path: string; mode: number; bytes: Buffer }[] = []) {
  const f = await fixture();
  const script = {
    path: "bin/server.cjs",
    mode: 0o600,
    bytes: Buffer.from(
      'require("node:fs").writeFileSync(process.env.PLUGIN_DATA+"/observed.json",JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,arg:process.argv[2]})); require("node:fs").writeFileSync(process.env.PLUGIN_ROOT+"/bin/server.cjs","rewritten by the server"); process.stdin.resume();',
    ),
  };
  // `bin.cjs` sorts before `bin/` by path and after `bin` by name.
  const files = [script, { path: "bin.cjs", mode: 0o600, bytes: Buffer.from("") }, ...extra];
  const digest = pluginSnapshotDigest(files);
  const snapshot = files.map(({ path, mode, bytes }) => ({
    path,
    mode,
    content: bytes.toString("base64"),
  }));
  const delivered = { snapshot };
  const fetchSnapshot = vi.fn(async () => new Response(JSON.stringify(delivered.snapshot)));
  vi.stubGlobal("fetch", fetchSnapshot);
  const mcp = new LocalMcpServers({ stateDirectory: f.stateDirectory });
  const frames: { type: string; error?: { message: string } }[] = [];
  mcp.attach(async (frame) => {
    frames.push(frame as (typeof frames)[number]);
  });
  const open = (sessionId: string) =>
    mcp.open({
      type: "host.integrations.mcp.open" as const,
      serverId: "server_test",
      sessionId,
      launch: {
        type: "stdio" as const,
        pluginId: "test",
        packageDigest: digest,
        command: process.execPath,
        cwd: "${PLUGIN_ROOT}",
        args: ["${PLUGIN_ROOT}/bin/server.cjs", "${PLUGIN_DATA}/arg"],
        env: {},
      },
      packageSource: { url: "https://host/package", token: "test" },
    } as Parameters<typeof mcp.open>[0]);
  const data = join(f.stateDirectory, "plugin-data/test");
  const observed = () =>
    vi.waitFor(
      async () =>
        JSON.parse(await readFile(join(data, "observed.json"), "utf8")) as {
          cwd: string;
          root: string;
          arg: string;
        },
      { timeout: 2000 },
    );
  return {
    ...f,
    mcp,
    frames,
    open,
    observed,
    digest,
    snapshot,
    delivered,
    fetchSnapshot,
    script,
    data,
  };
}

it("launches an approved MCP server from a private copy of its verified package, one per session", async () => {
  const f = await launchFixture();
  try {
    const cached = await fetchPluginPackage({
      stateDirectory: f.stateDirectory,
      digest: f.digest,
      fetchSnapshot: async () => f.snapshot,
    });
    await writeFile(join(cached, "bin/server.cjs"), 'throw new Error("tampered")');
    await f.open("one");
    expect(f.frames.at(-1)?.type).toBe("runner.integrations.mcp.opened");
    // The altered cache was fetched again, and the launch ran from a copy of what was verified.
    expect(f.fetchSnapshot).toHaveBeenCalledTimes(1);
    const first = await f.observed();
    expect(first.root).toMatch(new RegExp(`^${join(f.stateDirectory, "plugin-launches")}/`));
    expect(first).toEqual({ cwd: first.root, root: first.root, arg: join(f.data, "arg") });
    expect(await readFile(join(cached, "bin/server.cjs"), "utf8")).toBe(
      f.script.bytes.toString("utf8"),
    );
    // What the server wrote to its own folder reaches neither the cache nor the next launch.
    await vi.waitFor(
      async () =>
        expect(await readFile(join(first.root, "bin/server.cjs"), "utf8")).toBe(
          "rewritten by the server",
        ),
      { timeout: 2000 },
    );
    await rm(join(f.data, "observed.json"));
    await f.open("two");
    const second = await f.observed();
    expect(second.root).not.toBe(first.root);
    expect(f.frames.at(-1)?.type).toBe("runner.integrations.mcp.opened");
    await Promise.all(
      ["one", "two"].map((sessionId) =>
        f.mcp.close({ sessionId } as Parameters<typeof f.mcp.close>[0]),
      ),
    );
    for (const { root } of [first, second])
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.mcp.detach();
  }
});

it("refuses to launch a package its Host delivers altered", async () => {
  const f = await launchFixture();
  f.delivered.snapshot = f.snapshot.map((file) =>
    file.path === "bin/server.cjs"
      ? { ...file, content: Buffer.from("altered").toString("base64") }
      : file,
  );
  try {
    await f.open("one");
    expect(f.frames.at(-1)).toMatchObject({
      type: "runner.integrations.mcp.closed",
      error: { message: expect.stringContaining("digest mismatch") },
    });
    expect(await readdir(join(f.stateDirectory, "plugin-launches")).catch(() => [])).toEqual([]);
  } finally {
    f.mcp.detach();
  }
});

it("launches a package of the most files a package may hold", async () => {
  const extra = Array.from({ length: maximumPluginPackageFiles - 2 }, (_, index) => ({
    path: `files/${index}`,
    mode: 0o600,
    bytes: Buffer.alloc(0),
  }));
  const f = await launchFixture(extra);
  try {
    await f.open("one");
    expect(f.frames.at(-1)?.type).toBe("runner.integrations.mcp.opened");
    expect((await readdir(join((await f.observed()).root, "files"))).length).toBe(extra.length);
  } finally {
    await f.mcp.close({ sessionId: "one" } as Parameters<typeof f.mcp.close>[0]);
    f.mcp.detach();
  }
}, 60_000); // Writes and verifies over 30,000 real files.
