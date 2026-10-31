import { spawn } from "node:child_process";
import { once } from "node:events";
import { withTimeout } from "@opensteer/shared/withTimeout";
import * as atomicFiles from "@opensteer/shared/atomicPrivateFile";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProfileBindingSchema } from "@opensteer/protocol";
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
const seed = { revision: 0, digest: "a".repeat(64) };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("LocalProfileStore", () => {
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
    const directory = await owner.initialize(binding, seed);
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
  it("fences interrupted Electron initialization across runtimes in the same process", async () => {
    const { root, store, binding: chromium } = await setup();
    await store.close();
    const owner = await LocalProfileStore.acquire(root, "electron");
    stores.push(owner);
    const binding = { ...chromium, engine: "electron" as const };
    const directory = await owner.initialize(binding, seed);
    owner.engineOwnsDirectory(binding);
    await writeFile(path.join(directory, "live"), "owned");
    await owner.close();
    const next = await LocalProfileStore.acquire(root, "electron");
    stores.push(next);
    await expect(next.initialize(binding, seed)).rejects.toThrow(/process/);
    expect(await readFile(path.join(directory, "live"), "utf8")).toBe("owned");
  });
  it("erases an earlier process's Electron tombstone before the next engine can open it", async () => {
    const { root, store, binding: chromium } = await setup();
    await store.close();
    const binding = { ...chromium, engine: "electron" as const };
    const script = `import { LocalProfileStore } from ${JSON.stringify(new URL("./local-profile-store.ts", import.meta.url).href)};
      const store = await LocalProfileStore.acquire(process.argv[1], "electron");
      const binding = JSON.parse(process.argv[2]); const seed = JSON.parse(process.argv[3]);
      await store.initialize(binding, seed); store.engineOwnsDirectory(binding);
      await store.tombstone(binding, "00000000-0000-4000-8000-000000000003"); await store.close();`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type",
        "module",
        "-e",
        script,
        root,
        JSON.stringify(binding),
        JSON.stringify(seed),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
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
  it.each(["initializing", "ready"] as const)(
    "recovers only unpromoted data after a %s marker write fails",
    async (phase) => {
      const { root, store, binding } = await setup();
      const replace = atomicFiles.replacePrivateFileAtomically;
      vi.spyOn(atomicFiles, "replacePrivateFileAtomically").mockImplementation(
        async (filename, content) => {
          if (filename.endsWith("binding.v1.json") && JSON.parse(content).phase === phase)
            throw new Error("injected disk failure");
          await replace(filename, content);
        },
      );
      if (phase === "initializing")
        await expect(store.initialize(binding, seed)).rejects.toThrow("disk failure");
      else {
        await store.initialize(binding, seed);
        await expect(store.ready(binding, seed)).rejects.toThrow("disk failure");
      }
      vi.restoreAllMocks();
      await store.close();
      const next = await LocalProfileStore.acquire(root, "chromium");
      stores.push(next);
      const directory = await next.initialize(binding, seed);
      await next.ready(binding, seed);
      expect(await next.requireReady(binding)).toBe(directory);
    },
  );

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
  it("recreates only exact initializing data, and never downgrades ready", async () => {
    const { root, store, binding } = await setup();
    const directory = await store.initialize(binding, seed);
    await writeFile(path.join(directory, "partial"), "partial");
    await expect(store.initialize(binding, seed)).rejects.toThrow(/process/);
    await store.close();
    const restarted = await LocalProfileStore.acquire(root, "chromium");
    stores.push(restarted);
    await restarted.initialize(binding, seed);
    await expect(readFile(path.join(directory, "partial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await restarted.ready(binding, seed);
    await expect(restarted.initialize(binding, seed)).rejects.toThrow(/ready/);
    expect(await restarted.requireReady(binding)).toBe(directory);
    expect(await restarted.inventory()).toEqual([{ phase: "ready", binding, seed }]);
  });
  it("refuses missing, corrupt, mismatched markers and missing native data", async () => {
    const { root, store, binding } = await setup();
    await expect(store.requireReady(binding)).rejects.toThrow();
    const directory = await store.initialize(binding, seed);
    await store.ready(binding, seed);
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
    const directory = await store.initialize(binding, seed);
    await store.ready(binding, seed);
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
});
