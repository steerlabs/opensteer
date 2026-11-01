import { LocalProfileBindingSchema } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProfileStore } from "./local-profile-store.js";

const roots: string[] = [];
const stores: LocalProfileStore[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "native-profiles-"));
  roots.push(root);
  const store = await LocalProfileStore.acquire(root, "chromium");
  stores.push(store);
  const binding = LocalProfileBindingSchema.parse({
    version: 1,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    runnerId: "rnr_00000000-0000-4000-8000-000000000001",
    profileId: "bpr_00000000-0000-4000-8000-000000000001",
    storageInstanceId: store.storageInstanceId,
    bindingId: "00000000-0000-4000-8000-000000000001",
    engine: "chromium",
  });
  return { root, store, binding };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("LocalProfileStore", () => {
  it("opens a shipped native sentinel without reading or rewriting its legacy parent marker", async () => {
    const { root, store, binding } = await setup();
    const native = store.directory(binding);
    await mkdir(native, { recursive: true });
    const sentinel = JSON.stringify({ version: 1, binding });
    await writeFile(path.join(native, "opensteer.v1.json"), sentinel, { mode: 0o600 });
    await writeFile(
      path.join(root, "profiles", binding.profileId, "binding.v1.json"),
      "ignored legacy data",
      { mode: 0o600 },
    );
    expect(await store.requireReady(binding)).toBe(native);
    expect(await readFile(path.join(native, "opensteer.v1.json"), "utf8")).toBe(sentinel);
  });

  it("never recreates missing established storage and retries only unpublished empty creation", async () => {
    const { store, binding } = await setup();
    const files = vi.fn(async () => {});
    const signal = new AbortController().signal;
    await expect(store.provision(binding, true, files, signal)).rejects.toThrow(
      /established.*missing/,
    );
    expect(files).not.toHaveBeenCalled();
    files.mockRejectedValueOnce(new Error("protected files unavailable"));
    await expect(store.provision(binding, false, files, signal)).rejects.toThrow(
      "protected files unavailable",
    );
    expect(await store.inventory()).toEqual([]);
    const directory = await store.provision(binding, false, files, signal);
    expect(await store.requireReady(binding)).toBe(directory);
    const sentinel = await readFile(path.join(directory, "opensteer.v1.json"));
    await store.provision(binding, true, files, signal);
    expect(files).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(directory, "opensteer.v1.json"))).toEqual(sentinel);
  });

  it("discards interrupted identity publication without promoting its contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-atomic-"));
    roots.push(root);
    const temporary = "storage.v1.json.tmp-00000000-0000-4000-8000-000000000001";
    await writeFile(path.join(root, temporary), "incomplete");
    const store = await LocalProfileStore.acquire(root, "chromium");
    stores.push(store);
    expect(await readdir(root)).toEqual(["storage.v1.json"]);
  });
  it.each([
    "unknown.json.tmp-invalid",
    "bpr_00000000-0000-4000-8000-000000000001.json.tmp-invalid",
  ])("does not mistake %s for an atomic sidecar", async (name) => {
    const { root, store } = await setup();
    await mkdir(path.join(root, "tombstones"));
    await writeFile(path.join(root, "tombstones", name), "incomplete");
    await expect(store.inventory()).rejects.toThrow(/invalid/);
  });
  it("accepts existing replay/session metadata without mistaking it for native profile data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-metadata-"));
    roots.push(root);
    await mkdir(path.join(root, ".opensteer-runtime", "session-files"), { recursive: true });
    const store = await LocalProfileStore.acquire(root, "chromium");
    stores.push(store);
    expect(store.storageInstanceId).toEqual(expect.any(String));
  });
  it("re-acquires an Electron root after logical close without erasing retained tombstones", async () => {
    const { root, store, binding: chromium } = await setup();
    await store.close();
    const owner = await LocalProfileStore.acquire(root, "electron");
    stores.push(owner);
    const binding = { ...chromium, engine: "electron" as const };
    const directory = await owner.provision(
      binding,
      false,
      async () => {},
      new AbortController().signal,
    );
    owner.engineOwnsDirectory(binding);
    await writeFile(path.join(directory, "live"), "owned");
    await owner.tombstone(binding, "00000000-0000-4000-8000-000000000003");
    await owner.close();
    const next = await LocalProfileStore.acquire(root, "electron");
    stores.push(next);
    expect(await readFile(path.join(directory, "live"), "utf8")).toBe("owned");
    expect(await next.inventory()).toEqual([
      expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
    ]);
  });
  it("erases an earlier process's Electron tombstone before the next engine can open it", async () => {
    const { root, store, binding: chromium } = await setup();
    await store.close();
    const binding = { ...chromium, engine: "electron" as const };
    const script = `import { LocalProfileStore } from ${JSON.stringify(fileURLToPath(new URL("./local-profile-store.ts", import.meta.url)))};
      const store = await LocalProfileStore.acquire(process.argv[2], "electron");
      const binding = JSON.parse(process.argv[3]);
      await store.provision(binding, false, async () => {}, new AbortController().signal); store.engineOwnsDirectory(binding);
      await store.tombstone(binding, "00000000-0000-4000-8000-000000000003"); await store.close();`;
    // Compile before forking so the process-death deadline measures the owner,
    // rather than loading/transpiling the workspace through a TypeScript loader.
    const fixture = path.join(root, ".opensteer-runtime", "owner.mjs");
    await build({
      stdin: { contents: script, resolveDir: import.meta.dirname, loader: "js" },
      outfile: fixture,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      logLevel: "silent",
    });
    const child = spawn(process.execPath, [fixture, root, JSON.stringify(binding)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      const [code] = await withTimeout(exited, 3000, {
        timeoutError: () => new Error("Earlier Electron owner never exited"),
      });
      expect(code).toBe(0);
      const next = await LocalProfileStore.acquire(root, "electron");
      stores.push(next);
      expect(await next.inventory()).toEqual([
        expect.objectContaining({ phase: "deleted", erasure: "deleted" }),
      ]);
      await expect(
        readFile(path.join(root, "profiles", binding.profileId, "binding.v1.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await withTimeout(exited, 3000, {
        timeoutError: () => new Error("Earlier Electron owner cleanup stalled"),
      });
    }
  });

  it("holds exclusive in-process ownership and preserves root identity", async () => {
    const { root, store } = await setup();
    await expect(LocalProfileStore.acquire(root, "chromium")).rejects.toThrow(/in use/);
    await store.close();
    const next = await LocalProfileStore.acquire(root, "chromium");
    stores.push(next);
    expect(next.storageInstanceId).toBe(store.storageInstanceId);
  });
  it("never regenerates a missing root identity over existing data", async () => {
    const { root, store } = await setup();
    await store.close();
    await rm(path.join(root, "storage.v1.json"));
    await mkdir(path.join(root, "profiles"));
    await expect(LocalProfileStore.acquire(root, "chromium")).rejects.toThrow(/identity/);
  });
  it("refuses missing, corrupt, mismatched markers and missing native data", async () => {
    const { root, store, binding } = await setup();
    await expect(store.requireReady(binding)).rejects.toThrow();
    const directory = await store.provision(
      binding,
      false,
      async () => {},
      new AbortController().signal,
    );
    await store.requireReady(binding);
    await expect(
      store.requireReady({ ...binding, bindingId: "00000000-0000-4000-8000-000000000002" }),
    ).rejects.toThrow();
    await rm(directory, { recursive: true });
    await expect(store.requireReady(binding)).rejects.toThrow();
    await writeFile(path.join(root, "profiles", binding.profileId, "binding.v1.json"), "{");
    await expect(store.inventory()).rejects.toThrow();
  });
  it("persists a tombstone before erasure and processes it on restart", async () => {
    const { root, store, binding } = await setup();
    const directory = await store.provision(
      binding,
      false,
      async () => {},
      new AbortController().signal,
    );
    await store.requireReady(binding);
    await store.tombstone(binding, "00000000-0000-4000-8000-000000000003");
    await expect(store.requireReady(binding)).rejects.toThrow(/deleted/);
    await store.close();
    const next = await LocalProfileStore.acquire(root, "chromium");
    stores.push(next);
    await expect(readFile(path.join(directory, "anything"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await next.inventory()).toEqual([
      {
        phase: "deleted",
        binding,
        deletionId: "00000000-0000-4000-8000-000000000003",
        erasure: "deleted",
      },
    ]);
  });
  it.each(["empty", "replaced"])(
    "refuses %s ready native storage without repairing it",
    async (damage) => {
      const { store, binding } = await setup();
      const directory = await store.provision(
        binding,
        false,
        async () => {},
        new AbortController().signal,
      );
      await store.requireReady(binding);
      const sentinel = path.join(directory, "opensteer.v1.json");
      if (damage === "empty") {
        for (const entry of await readdir(directory))
          await rm(path.join(directory, entry), { recursive: true });
      } else {
        await writeFile(
          sentinel,
          JSON.stringify({
            version: 1,
            binding: { ...binding, bindingId: "00000000-0000-4000-8000-000000000002" },
          }),
        );
      }
      const before = await readdir(directory);
      await expect(store.requireReady(binding)).rejects.toThrow(
        /native browser profile.*missing|native browser profile.*match/i,
      );
      await expect(store.inventory()).rejects.toThrow();
      await expect(store.requireReady(binding)).rejects.toThrow();
      await expect(
        store.provision(binding, true, async () => {}, new AbortController().signal),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual(before);
    },
  );
});
