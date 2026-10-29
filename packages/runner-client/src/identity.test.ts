import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, HarnessIdSchema, type EnvironmentId } from "@opensteer/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRunnerIdentityStore,
  RunnerDataDirectoryLock,
  inspectRunnerIdentity,
  loadOrCreateRunnerIdentity,
  providerContinuationIdentityProjector,
} from "./identity.js";

const directories: string[] = [];

/** An agents Runner has exactly one work location; a module-only one has none. */
function agentEnvironmentIds(identity: { readonly environmentId: EnvironmentId | null }) {
  return identity.environmentId === null ? [] : [identity.environmentId];
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Runner identity", () => {
  it("reports whether a persisted identity has completed enrollment", async () => {
    const directory = await temporaryDirectory();
    await expect(inspectRunnerIdentity(directory)).resolves.toBeNull();

    const store = new FileRunnerIdentityStore({ dataDirectory: directory });
    const identity = await store.loadOrCreate();
    await expect(inspectRunnerIdentity(directory)).resolves.toEqual({
      enrolled: false,
      environmentId: identity.environmentId,
      runnerId: identity.runnerId,
    });

    await store.acceptHostConnection({
      connectionGeneration: 1,
      environmentIds: agentEnvironmentIds(identity),
      reenrolled: false,
      runnerId: identity.runnerId,
    });
    await expect(inspectRunnerIdentity(directory)).resolves.toEqual({
      enrolled: true,
      environmentId: identity.environmentId,
      runnerId: identity.runnerId,
    });
  });

  it("persists stable IDs in a mode-safe file", async () => {
    const directory = await temporaryDirectory();
    const first = await loadOrCreateRunnerIdentity({ dataDirectory: directory });
    const second = await loadOrCreateRunnerIdentity({ dataDirectory: directory });

    expect(second).toEqual(first);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "identity.json"))).mode & 0o777).toBe(0o600);
  });

  it("upgrades a version 2 agent identity without changing its enrolled identity", async () => {
    const directory = await temporaryDirectory();
    const identityPath = join(directory, "identity.json");
    const store = new FileRunnerIdentityStore({ dataDirectory: directory });
    const created = await store.loadOrCreate();
    const currentFile = JSON.parse(await readFile(identityPath, "utf8")) as Record<string, unknown>;
    const legacyFile = { ...currentFile, version: 2 };
    await writeFile(identityPath, `${JSON.stringify(legacyFile, undefined, 2)}\n`, { mode: 0o600 });

    const loaded = await new FileRunnerIdentityStore({
      dataDirectory: directory,
      ...(created.environmentId ? { environmentId: created.environmentId } : {}),
      runnerId: created.runnerId,
    }).loadOrCreate();
    expect(loaded).toMatchObject({
      createdAt: created.createdAt,
      environmentId: created.environmentId,
      lastConnectionGeneration: created.lastConnectionGeneration,
      publicKeyPem: created.publicKeyPem,
      runnerId: created.runnerId,
      version: 3,
    });
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toEqual({
      ...legacyFile,
      version: 3,
    });

    await store.acceptHostConnection({
      connectionGeneration: created.lastConnectionGeneration + 1,
      environmentIds: agentEnvironmentIds(created),
      reenrolled: false,
      runnerId: created.runnerId,
    });
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toEqual({
      ...legacyFile,
      lastConnectionGeneration: created.lastConnectionGeneration + 1,
      version: 3,
    });
  });

  it("does not rewrite a version 2 identity whose key pair is invalid", async () => {
    const directory = await temporaryDirectory();
    const identityPath = join(directory, "identity.json");
    await loadOrCreateRunnerIdentity({ dataDirectory: directory });
    const currentFile = JSON.parse(await readFile(identityPath, "utf8")) as Record<string, unknown>;
    const invalidLegacyFile = {
      ...currentFile,
      privateKeyPem: "not a private key".repeat(8),
      version: 2,
    };
    await writeFile(identityPath, `${JSON.stringify(invalidLegacyFile, undefined, 2)}\n`, {
      mode: 0o600,
    });

    await expect(loadOrCreateRunnerIdentity({ dataDirectory: directory })).rejects.toThrow(
      /invalid key/u,
    );
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toEqual(invalidLegacyFile);
  });

  it("projects private provider paths into stable Runner-scoped identities", async () => {
    const firstDirectory = await temporaryDirectory();
    const firstIdentity = await loadOrCreateRunnerIdentity({ dataDirectory: firstDirectory });
    const reloadedIdentity = await loadOrCreateRunnerIdentity({ dataDirectory: firstDirectory });
    const secondIdentity = await loadOrCreateRunnerIdentity({
      dataDirectory: await temporaryDirectory(),
    });
    const project = providerContinuationIdentityProjector(firstIdentity.privateKey);
    const privateIdentity = {
      continuationKey: "codex:home:/Users/person/.codex",
      driverKind: HarnessIdSchema.parse("codex"),
    };
    const projected = project(privateIdentity);

    expect(projected).toEqual(project(privateIdentity));
    expect(
      providerContinuationIdentityProjector(reloadedIdentity.privateKey)(privateIdentity),
    ).toEqual(projected);
    expect(projected.continuationKey).toMatch(/^runner:v1:[A-Za-z0-9_-]{43}$/);
    expect(projected.continuationKey).not.toContain("person");
    expect(
      project({ ...privateIdentity, continuationKey: "codex:home:/Users/test/.codex" }),
    ).not.toEqual(projected);
    expect(
      project({ ...privateIdentity, driverKind: HarnessIdSchema.parse("claude") }),
    ).not.toEqual(projected);
    expect(
      providerContinuationIdentityProjector(secondIdentity.privateKey)(privateIdentity),
    ).not.toEqual(projected);
  });

  it("fails when configured IDs disagree with persisted identity", async () => {
    const directory = await temporaryDirectory();
    const identity = await loadOrCreateRunnerIdentity({ dataDirectory: directory });
    await expect(
      loadOrCreateRunnerIdentity({
        dataDirectory: directory,
        ...(identity.environmentId ? { environmentId: identity.environmentId } : {}),
        runnerId: createId("runner"),
      }),
    ).rejects.toThrow("does not match");
  });

  it("persists and enforces a monotonic Host connection generation", async () => {
    const directory = await temporaryDirectory();
    const store = new FileRunnerIdentityStore({ dataDirectory: directory });
    const identity = await store.loadOrCreate();
    const accepted = await store.acceptHostConnection({
      connectionGeneration: 1,
      environmentIds: agentEnvironmentIds(identity),
      reenrolled: false,
      runnerId: identity.runnerId,
    });
    expect(accepted.lastConnectionGeneration).toBe(1);
    expect((await store.loadOrCreate()).lastConnectionGeneration).toBe(1);
    await expect(
      store.acceptHostConnection({
        connectionGeneration: 1,
        environmentIds: agentEnvironmentIds(identity),
        reenrolled: false,
        runnerId: identity.runnerId,
      }),
    ).rejects.toThrow(/did not advance/);
  });

  it("keeps a saved work location through a connection that advertises no agents", async () => {
    // A reach-only computer advertises shell alone, so the Host acknowledges no
    // environment. The same computer runs agents again the moment its owner
    // turns that back on, and it must still know where its work happens.
    const directory = await temporaryDirectory();
    const store = new FileRunnerIdentityStore({ dataDirectory: directory });
    const identity = await store.loadOrCreate();

    const accepted = await store.acceptHostConnection({
      connectionGeneration: 1,
      environmentIds: [],
      reenrolled: false,
      runnerId: identity.runnerId,
    });

    expect(accepted.environmentId).toBe(identity.environmentId);
    await expect(
      store.acceptHostConnection({
        connectionGeneration: 2,
        environmentIds: [createId("environment")],
        reenrolled: false,
        runnerId: identity.runnerId,
      }),
    ).rejects.toThrow(/different execution environment/);
  });

  it("starts a new connection generation lineage after re-enrollment", async () => {
    const directory = await temporaryDirectory();
    const store = new FileRunnerIdentityStore({ dataDirectory: directory });
    const identity = await store.loadOrCreate();
    await store.acceptHostConnection({
      connectionGeneration: 7,
      environmentIds: agentEnvironmentIds(identity),
      reenrolled: false,
      runnerId: identity.runnerId,
    });

    const reenrolled = await store.acceptHostConnection({
      connectionGeneration: 1,
      environmentIds: agentEnvironmentIds(identity),
      reenrolled: true,
      runnerId: identity.runnerId,
    });

    expect(reenrolled.lastConnectionGeneration).toBe(1);
    await expect(
      store.acceptHostConnection({
        connectionGeneration: 1,
        environmentIds: agentEnvironmentIds(identity),
        reenrolled: false,
        runnerId: identity.runnerId,
      }),
    ).rejects.toThrow(/did not advance/);
  });
});

/**
 * The lease timings production uses are seconds long; these are the same shape
 * scaled down so a test can wait out a whole staleness window.
 */
const timings = { renewalIntervalMs: 60, staleAfterMs: 300 } as const;

describe("Runner data directory lease", () => {
  it("allows only one daemon to own a runtime directory", async () => {
    const directory = await temporaryDirectory();
    const first = await RunnerDataDirectoryLock.acquire(directory, timings);
    await expect(stat(lockPath(directory))).resolves.toBeDefined();

    // The owner keeps renewing, so a challenger learns it is alive and stops
    // waiting long before the staleness window could expire.
    const started = Date.now();
    await expect(RunnerDataDirectoryLock.acquire(directory, timings)).rejects.toThrow(
      "already using",
    );
    expect(Date.now() - started).toBeLessThan(timings.staleAfterMs);

    await first.release();
    await expect(stat(lockPath(directory))).rejects.toThrow();
    const second = await RunnerDataDirectoryLock.acquire(directory, timings);
    await second.release();
  });

  it("reclaims a lease nothing has renewed for a whole window", async () => {
    const directory = await temporaryDirectory();
    const path = lockPath(directory);
    // What a container leaves behind when it is killed: a lock naming a pid the
    // successor's fresh PID namespace hands right back to it.
    await writeAbandonedLock(path, timings.staleAfterMs * 4);

    const started = Date.now();
    const lock = await RunnerDataDirectoryLock.acquire(directory, timings);
    expect(Date.now() - started).toBeLessThan(timings.staleAfterMs);
    const claimed = JSON.parse(await readFile(path, "utf8")) as { nonce: string };
    expect(claimed.nonce).not.toBe("abandoned");
    await lock.release();
  });

  it("waits out a fresh lease before reclaiming it", async () => {
    const directory = await temporaryDirectory();
    await writeAbandonedLock(lockPath(directory), 0);

    const started = Date.now();
    const lock = await RunnerDataDirectoryLock.acquire(directory, timings);
    // Seconds, not a crash loop: the window is spent once and then the
    // directory is usable.
    expect(Date.now() - started).toBeGreaterThanOrEqual(timings.staleAfterMs - 50);
    await lock.release();
  });

  it("reclaims an unreadable lock on exactly the same terms", async () => {
    const directory = await temporaryDirectory();
    const path = lockPath(directory);
    await writeFile(path, "{ this is not a lock", { mode: 0o600 });
    const past = new Date(Date.now() - timings.staleAfterMs * 4);
    await utimes(path, past, past);

    const lock = await RunnerDataDirectoryLock.acquire(directory, timings);
    const claimed = JSON.parse(await readFile(path, "utf8")) as { nonce: string };
    expect(claimed.nonce).toHaveLength(36);
    await lock.release();
  });

  it("keeps the lock file fresh while it is held", async () => {
    const directory = await temporaryDirectory();
    const lock = await RunnerDataDirectoryLock.acquire(directory, timings);
    const created = (await stat(lockPath(directory))).mtimeMs;

    await sleep(timings.renewalIntervalMs * 4);

    expect((await stat(lockPath(directory))).mtimeMs).toBeGreaterThan(created);
    await lock.release();
  });

  it("tells a displaced owner it lost the directory and leaves the successor alone", async () => {
    const directory = await temporaryDirectory();
    const path = lockPath(directory);
    const owner = await RunnerDataDirectoryLock.acquire(directory, timings);
    let lost: Error | undefined;
    owner.onLost((reason) => {
      lost = reason;
    });

    await rm(path, { force: true });
    const successor = await RunnerDataDirectoryLock.acquire(directory, timings);
    const successorNonce = (JSON.parse(await readFile(path, "utf8")) as { nonce: string }).nonce;
    await sleep(timings.renewalIntervalMs * 4);

    expect(lost?.message).toContain("took the Opensteer Runner lock");

    // Releasing a lock it no longer owns must not evict the successor.
    await owner.release();
    const survivor = JSON.parse(await readFile(path, "utf8")) as { nonce: string };
    expect(survivor.nonce).toBe(successorNonce);

    await successor.release();
    await expect(stat(path)).rejects.toThrow();
  });
});

function lockPath(directory: string): string {
  return join(directory, ".runner.lock");
}

async function writeAbandonedLock(path: string, ageMs: number): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ nonce: "abandoned", pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    await utimes(path, past, past);
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opensteer-runner-test-"));
  directories.push(path);
  return path;
}
