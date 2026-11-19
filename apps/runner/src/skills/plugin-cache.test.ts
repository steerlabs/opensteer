import { readdir, readFile, rm, utimes, lstat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheRunPlugins, fetchPluginPackage, prunePluginCache } from "./plugin-cache.js";
import { fixture, fixtureDirectories, launchFixture } from "./plugin-cache.test-support.js";
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    fixtureDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
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

it("launches only what the verified package registers, with secrets only in its declared slots", async () => {
  const f = await launchFixture();
  try {
    for (const [sessionId, changed] of [
      ["arguments", { args: ["${PLUGIN_ROOT}/bin/server.cjs", "--inspect", "${PLUGIN_DATA}/arg"] }],
      ["environment", { env: { NODE_OPTIONS: "--require=/tmp/elsewhere.cjs" } }],
    ] as const) {
      await f.open(sessionId, changed);
      expect(f.frames.at(-1)).toMatchObject({
        type: "runner.integrations.mcp.closed",
        sessionId,
        error: { message: "This launch is not the one its package registers." },
      });
    }
    // Refused before its private copy was kept, so nothing ran from it.
    expect(await readdir(join(f.stateDirectory, "plugin-launches"))).toEqual([]);
    // Fetched once: each later launch is a cache hit, checked all the same.
    expect(f.fetchSnapshot).toHaveBeenCalledTimes(1);
    await f.open("secret", { env: { TEST_TOKEN: "owner value" } });
    expect(f.frames.at(-1)).toMatchObject({
      type: "runner.integrations.mcp.opened",
      sessionId: "secret",
    });
    await f.mcp.close({ sessionId: "secret" } as Parameters<typeof f.mcp.close>[0]);
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
