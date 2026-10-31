import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { addCleanup, deployment } from "./browser-deployment.test-support.js";
import { ownChild } from "../apps/host/src/agents/owned-child.test-support.js";
import { gate } from "../packages/shared/src/observation.test-support.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { closeHttpServerNow } from "../packages/shared/src/httpServer.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import type { BrowserProfileId } from "../packages/core/src/index.js";
import type { NativeProfileOpenTiming } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import type { BrowserOpenTiming } from "../packages/browser-runtime-core/src/runtime.js";
import type { BrowserTabOpenResult } from "../packages/protocol/src/index.js";

afterEach(() => vi.restoreAllMocks());

const bounded = <T>(promise: Promise<T>, message: string, deadlineMs = 15_000) =>
  withTimeout(promise, deadlineMs, { timeoutError: () => new Error(message) });

async function browserProcess(relay?: { hostOrigin: URL; enrollmentToken: string }) {
  const root = await mkdtemp(path.join(tmpdir(), "native-profile-journey-"));
  addCleanup("native profile files", () => rm(root, { recursive: true, force: true }), 2);
  const profileRoot = path.join(root, "profiles");
  const bridgeToken = randomBytes(32).toString("base64url");
  const url = new URL("http://127.0.0.1:0");
  const timings: BrowserOpenTiming[] = [];
  const nativeTimings: NativeProfileOpenTiming[] = [];
  let stop = async () => {};
  let diagnostics = () => "";
  const start = async () => {
    const ready = Promise.withResolvers<void>();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../apps/browser-runtime/dist/main.js", import.meta.url))],
      {
        env: {
          ...process.env,
          ...(relay
            ? {
                OPENSTEER_BROWSER_RELAY_HOST_URL: relay.hostOrigin.origin,
                OPENSTEER_BROWSER_RUNTIME_DATA_DIR: path.join(root, "runner"),
                OPENSTEER_RUNNER_ENROLLMENT_TOKEN: relay.enrollmentToken,
                OPENSTEER_MODE: "development",
              }
            : {}),
          OPENSTEER_BROWSER_RUNTIME_ID: "native-journey",
          OPENSTEER_BROWSER_PROFILE_ROOT: profileRoot,
          OPENSTEER_BROWSER_BRIDGE_TOKEN: bridgeToken,
          OPENSTEER_BROWSER_PORT: url.port,
          OPENSTEER_BROWSER_HEADLESS: "true",
          OPENSTEER_BROWSER_CHROMIUM_SANDBOX: "false",
          OPENSTEER_CHROMIUM_EXECUTABLE: chromium.executablePath(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const owner = ownChild(child);
    let output = "";
    diagnostics = () => output;
    let pending = "";
    child.stdout.on("data", (bytes: Buffer) => {
      pending += bytes.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const value = JSON.parse(line);
        if (value.event === "browser-runtime.ready") {
          url.port = String(value.port);
          ready.resolve();
        }
        if (value.event === "browser.native.open.timing") {
          const { event: _event, ...timing } = value;
          nativeTimings.push(timing);
        }
        if (value.event === "browser.session.open.timing") {
          const { event: _event, ...timing } = value;
          timings.push(timing);
        }
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      output += bytes.toString();
    });
    void owner.exited.then(() =>
      ready.reject(new Error(`Runtime exited before readiness: ${output}`)),
    );
    stop = async () => {
      await owner.close(() => {
        child.kill("SIGTERM");
      }, 15_000);
      expect(child.exitCode, `Browser runtime shutdown failed: ${output}`).toBe(0);
    };
    addCleanup("native runtime process", () => stop(), 0);
    await bounded(ready.promise, "Browser runtime never listened");
  };
  await start();
  const health = async () =>
    z
      .object({ sessionCount: z.number(), profileHostCount: z.number() })
      .parse(
        await (await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) })).json(),
      );
  return {
    root,
    profileRoot,
    runtimeId: "native-journey",
    bridgeToken,
    url,
    timings,
    nativeTimings,
    start,
    health,
    close: () => stop(),
    diagnostics: () => diagnostics(),
  };
}

async function stateSite() {
  const observed = new Map<string, PromiseWithResolvers<unknown>>();
  const visits = new Map<string, number>();
  const result = (id: string) => {
    let value = observed.get(id);
    if (!value) {
      value = Promise.withResolvers<unknown>();
      observed.set(id, value);
    }
    return value;
  };
  let navigation: ReturnType<typeof gate> | undefined;
  const navigationGate = () =>
    (navigation ??= gate({ label: "delayed first navigation", deadlineMs: 20_000 }));
  let responseCompleted = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    if (url.pathname === "/observed") {
      let body = "";
      request.on("data", (bytes: Buffer) => {
        body += bytes.toString();
      });
      request.on("end", () => {
        result(url.searchParams.get("id")!).resolve(JSON.parse(body));
        response.end("ok");
      });
      return;
    }
    const id = url.searchParams.get("id");
    if (id) visits.set(id, (visits.get(id) ?? 0) + 1);
    const deliver = () => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Profile fixture</title><script>
        (async () => {
          const id = new URL(location.href).searchParams.get('id');
          const seed = location.pathname === '/seed';
          if (seed) {
            document.cookie = 'persistent=kept; Max-Age=3600; SameSite=Lax; Path=/';
            document.cookie = 'session=kept; SameSite=Lax; Path=/';
            localStorage.setItem('fixture', 'local-kept');
          }
          const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('fixture', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('records');
            open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
          });
          if (seed) await new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put('idb-kept', 'fixture');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
          });
          const indexed = await new Promise((resolve, reject) => {
            const read = db.transaction('records').objectStore('records').get('fixture');
            read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
          });
          db.close();
          await fetch('/observed?id=' + id, { method: 'POST', body: JSON.stringify({ cookies: document.cookie.split('; ').sort(), local: localStorage.getItem('fixture'), indexed }) });
        })().catch(error => fetch('/observed?id=' + new URL(location.href).searchParams.get('id'), { method: 'POST', body: JSON.stringify({ error: String(error) }) }));
      </script>`);
      if (url.pathname === "/delayed") responseCompleted = true;
    };
    if (url.pathname === "/delayed")
      void bounded(navigationGate().enter(), "Delayed response gate was never released")
        .then(deliver)
        .catch(() => response.destroy());
    else deliver();
  });
  server.listen(0, "127.0.0.1");
  await bounded(once(server, "listening"), "Fixture site never listened");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no port");
  addCleanup("profile fixture site", async () => {
    navigation?.release();
    await closeHttpServerNow(server);
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get navigation() {
      return navigationGate();
    },
    responseCompleted: () => responseCompleted,
    visits: () => Object.fromEntries(visits),
    observed: (id: string) => bounded(result(id).promise, `Page ${id} never reported its storage`),
  };
}

it("converts, retains, restarts, reconciles and erases native profiles through the real Host and Runner", async () => {
  await access(chromium.executablePath());
  const browser = await browserProcess();
  // The Runner uses precisely the desktop Personal/enrolled loopback composition.
  const stack = await deployment(browser);
  const site = await stateSite();
  await vi.waitFor(
    async () => {
      const bootstrap = await stack.api["bootstrap.get"]({});
      expect(
        bootstrap.ok && bootstrap.data.browser.available,
        "Runner browser module never became available",
      ).toBe(true);
    },
    { timeout: 15_000 },
  );
  const owner = await stack.host.store.firstUser();
  if (!owner) throw new Error("Fixture owner is missing");
  const open = async (
    profileId: BrowserProfileId | undefined,
    suffix: string,
  ): Promise<BrowserTabOpenResult> => {
    const reply = await bounded(
      stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        identity: profileId ? { kind: "profile", profileId } : { kind: "guest" },
        url: site.origin + suffix,
        idempotencyKey: randomUUID(),
      }),
      "browser.tab.open did not return after navigation submission",
    );
    if (!reply.ok || reply.data.type !== "browser.tab.open")
      throw new Error(
        `${JSON.stringify(reply)} ${browser.diagnostics()}; ${JSON.stringify(browser.timings)}`,
      );
    return reply.data;
  };
  const close = async (opened: BrowserTabOpenResult) => {
    const catalog = await stack.api["browser.tabs.get"]({ sessionId: opened.sessionId });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const reply = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId: opened.sessionId,
      surfaceId: opened.tabId,
      expectedGeneration: catalog.data.generation,
      expectedRevision: catalog.data.inventoryRevision ?? catalog.data.revision,
      idempotencyKey: randomUUID(),
    });
    expect(reply.ok, `Last tab failed to close: ${JSON.stringify(reply)}`).toBe(true);
  };
  const expected = {
    cookies: ["persistent=kept", "session=kept"],
    local: "local-kept",
    indexed: "idb-kept",
  };
  const guest = await open(undefined, "/seed?id=seed");
  expect(await site.observed("seed")).toEqual(expected);
  const profile = await stack.host.browser.saveSessionAsProfile({
    name: "Converted",
    ownerId: owner.id,
    sessionId: guest.sessionId,
  });
  await close(guest);
  const row = () =>
    stack.host.store.database
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", profile.id)
      .executeTakeFirstOrThrow();
  const frozen = await stack.host.store.database
    .selectFrom("browserProfileRevisions")
    .selectAll()
    .where("profileId", "=", profile.id)
    .executeTakeFirstOrThrow();
  expect(await row()).toMatchObject({ storageState: "vault", revision: 1 });
  const legacyLoad = vi.spyOn(stack.host.browser, "loadProfileState");
  const legacyCommit = vi.spyOn(stack.host.browser, "commitProfileState");
  const complete = vi.spyOn(stack.host.browser, "completeProfileInitialization");
  const other = await stack.host.browser.createProfile({
    name: "Independent",
    ownerId: owner.id,
    workspaceId: stack.mainWorkspaceId,
    idempotencyKey: randomUUID(),
  });
  const preparedOther = await open(other.id, "/read?id=prepare-independent");
  await site.observed("prepare-independent");
  await close(preparedOther);
  const seedGate = gate({ label: "slow conversion seed", deadlineMs: 15_000 });
  const loadSeed = stack.host.browser.loadProfileInitialization.bind(stack.host.browser);
  const seeds = vi
    .spyOn(stack.host.browser, "loadProfileInitialization")
    .mockImplementation(async (id, token) => {
      if (id === profile.id) await bounded(seedGate.enter(), "Seed conversion was never released");
      const result = await loadSeed(id, token);
      return result;
    });
  const firstOpening = open(profile.id, "/delayed?id=conversion");
  void firstOpening.catch(() => undefined);
  let converted: BrowserTabOpenResult;
  try {
    await seedGate.entered;
    const independent = await bounded(
      open(other.id, "/read?id=independent"),
      "Profile B was serialized behind profile A",
      5000,
    );
    await site.observed("independent");
    await close(independent);
    seedGate.release();
    converted = await firstOpening;
    await site.navigation.entered;
    expect(site.responseCompleted(), "tab.open waited for the delayed HTTP response").toBe(false);
    site.navigation.release();
  } finally {
    seedGate.release();
    site.navigation.release();
    await bounded(
      firstOpening.catch(() => undefined),
      "Admitted conversion did not settle during cleanup",
    );
  }
  expect(await site.observed("conversion")).toEqual(expected);
  expect(await row()).toMatchObject({
    storageState: "local",
    revision: 1,
    frozenSeedRevision: "1",
    storageEngine: "chromium",
  });
  expect(
    await stack.host.store.database
      .selectFrom("browserProfileRevisions")
      .selectAll()
      .where("profileId", "=", profile.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(frozen);
  expect(legacyLoad).not.toHaveBeenCalled();
  expect(legacyCommit).not.toHaveBeenCalled();
  await close(converted);
  await vi.waitFor(
    async () =>
      expect((await browser.health()).sessionCount, "Closed profile still holds a session").toBe(0),
    { timeout: 5000 },
  );
  const requests = { seeds: seeds.mock.calls.length, complete: complete.mock.calls.length };
  const warmStart = browser.timings.length;
  const warmWallStart = performance.now();
  const warm = await open(profile.id, "/read?id=warm");
  const warmWallMs = performance.now() - warmWallStart;
  expect(await site.observed("warm")).toEqual(expected);
  expect(seeds).toHaveBeenCalledTimes(requests.seeds);
  expect(complete).toHaveBeenCalledTimes(requests.complete);
  expect(legacyLoad).not.toHaveBeenCalled();
  expect(legacyCommit).not.toHaveBeenCalled();
  expect(browser.timings.some((timing) => timing.acquisition === "warm")).toBe(true);
  const warmTimings = browser.timings.slice(warmStart);
  await close(warm);
  const visitsBeforeRestart = site.visits();
  await browser.close();
  await browser.start();
  await stack.restartRunner();
  const coldStart = browser.timings.length;
  const coldNativeStart = browser.nativeTimings.length;
  const coldWallStart = performance.now();
  const cold = await open(profile.id, "/read?id=cold");
  const coldWallMs = performance.now() - coldWallStart;
  expect(await site.observed("cold")).toEqual(expected);
  expect(site.visits(), "Chromium restored a tab independently of Opensteer").toEqual({
    ...visitsBeforeRestart,
    cold: 1,
  });
  const tabs = await stack.api["browser.tabs.get"]({ sessionId: cold.sessionId });
  expect(tabs).toMatchObject({
    ok: true,
    data: { tabs: [expect.objectContaining({ id: cold.tabId })] },
  });
  expect(seeds).toHaveBeenCalledTimes(requests.seeds);
  expect(complete).toHaveBeenCalledTimes(requests.complete);
  expect(browser.timings.some((timing) => timing.acquisition === "cold")).toBe(true);
  const coldTimings = browser.timings.slice(coldStart);
  const coldNativeTimings = browser.nativeTimings.slice(coldNativeStart);
  await close(cold);

  // Simulate a DB-only rollback while the owning engine is stopped. The new
  // authenticated stream must reconcile before any new execution ticket.
  await browser.close();
  await stack.host.store.database
    .updateTable("browserProfiles")
    .set({
      storageState: "vault",
      storageBindingVersion: null,
      storageDeploymentId: null,
      storageRunnerId: null,
      storageInstanceId: null,
      storageBindingId: null,
      storageEngine: null,
      frozenSeedRevision: null,
      frozenSeedDigest: null,
      initializationTokenHash: null,
      initializationTokenExpiresAt: null,
    })
    .where("id", "=", profile.id)
    .execute();
  expect((await row()).storageState).toBe("vault");
  await browser.start();
  await stack.restartRunner();
  await vi.waitFor(
    async () =>
      expect(
        (await row()).storageState,
        "Reconnect inventory failed to advance the restored Host row before a ticket",
      ).toBe("local"),
    { timeout: 10_000 },
  );
  const reconciled = await open(profile.id, "/read?id=reconciled");
  expect(await site.observed("reconciled")).toEqual(expected);
  expect(seeds).toHaveBeenCalledTimes(requests.seeds);
  await close(reconciled);

  // A released runtime advertises neither feature. Its real auxiliary welcome
  // and loopback attach consequently remain on the legacy protocol.
  const capabilities = vi
    .spyOn(LocalBrowserRuntimeBridge.prototype, "capabilities")
    .mockResolvedValue({});
  await stack.restartRunner();
  const refused = await stack.api["commands.dispatch"]({
    type: "browser.tab.open",
    identity: { kind: "profile", profileId: profile.id },
    idempotencyKey: randomUUID(),
  });
  expect(refused).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Update this computer") },
  });
  const vault = await stack.host.browser.createProfile({
    name: "Legacy",
    ownerId: owner.id,
    workspaceId: stack.mainWorkspaceId,
    idempotencyKey: randomUUID(),
  });
  const legacy = await open(vault.id, "/read?id=legacy");
  await site.observed("legacy");
  expect(legacyLoad).toHaveBeenCalledTimes(1);
  expect(
    (
      await stack.host.store.database
        .selectFrom("browserProfiles")
        .select("storageState")
        .where("id", "=", vault.id)
        .executeTakeFirstOrThrow()
    ).storageState,
  ).toBe("vault");
  await close(legacy);
  capabilities.mockRestore();
  await stack.restartRunner();
  const deleted = await stack.api["commands.dispatch"]({
    type: "browser.profile.delete",
    profileId: profile.id,
    idempotencyKey: randomUUID(),
  });
  expect(deleted.ok).toBe(true);
  await vi.waitFor(
    async () => {
      const deletion = await stack.host.store.database
        .selectFrom("browserProfileDeletions")
        .select("state")
        .where("profileId", "=", profile.id)
        .executeTakeFirstOrThrow();
      expect(deletion.state, "Runtime did not acknowledge physical profile erasure").toBe(
        "deleted",
      );
    },
    { timeout: 10_000 },
  );
  await expect(
    access(path.join(browser.profileRoot, "profiles", profile.id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const bootstrap = await stack.api["bootstrap.get"]({});
  expect(
    bootstrap.ok &&
      bootstrap.data.browser.profileDeletions?.some(
        (deletion) => deletion.profileId === profile.id,
      ),
  ).toBeFalsy();
  expect(
    await stack.host.store.database
      .selectFrom("browserProfileRevisions")
      .selectAll()
      .where("profileId", "=", profile.id)
      .execute(),
  ).toEqual([]);
  const tombstone = JSON.parse(
    await readFile(path.join(browser.profileRoot, "tombstones", `${profile.id}.json`), "utf8"),
  );
  expect(tombstone).toMatchObject({ phase: "deleted", erasure: "deleted" });
  await writeFile(
    path.join(tmpdir(), "native-profile-integration-timings.json"),
    JSON.stringify(
      {
        warm: warmTimings,
        cold: coldTimings,
        timings: browser.timings,
        nativeTimings: browser.nativeTimings,
        coldNativeTimings,
        warmWallMs,
        coldWallMs,
      },
      null,
      2,
    ),
  );
  vi.restoreAllMocks();
}, 90_000);

it("advertises exact prepared storage through the standalone browser-only Runner", async () => {
  const enrollmentToken = randomBytes(32).toString("base64url");
  const stack = await deployment(undefined, enrollmentToken);
  const browser = await browserProcess({ hostOrigin: stack.hostOrigin, enrollmentToken });
  const bridge = new LocalBrowserRuntimeBridge(browser);
  const capabilities = await bridge.capabilities();
  expect(capabilities).toEqual({
    localProfiles: 1,
    localProfileStorage: { storageInstanceId: expect.any(String), engine: "chromium" },
    initialNavigationVersion: 1,
  });
  await vi.waitFor(
    async () => {
      const bootstrap = await stack.api["bootstrap.get"]({});
      expect(
        bootstrap.ok && bootstrap.data.browser.available,
        "Standalone browser auxiliary stream never became ready",
      ).toBe(true);
    },
    { timeout: 15_000 },
  );
  const created = await stack.api["commands.dispatch"]({
    type: "browser.profile.create",
    input: { name: "Standalone" },
    idempotencyKey: randomUUID(),
  });
  if (!created.ok || created.data.type !== "browser.profile.create")
    throw new Error("Standalone profile was not created");
  const opened = await bounded(
    stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: created.data.profile.id },
      idempotencyKey: randomUUID(),
    }),
    "Standalone browser did not negotiate native attachment",
  );
  expect(opened).toMatchObject({ ok: true, data: { type: "browser.tab.open" } });
  const row = await stack.host.store.database
    .selectFrom("browserProfiles")
    .select(["storageState", "storageInstanceId", "storageEngine"])
    .where("id", "=", created.data.profile.id)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({
    storageState: "local",
    storageInstanceId: capabilities.localProfileStorage?.storageInstanceId,
    storageEngine: "chromium",
  });
  if (opened.ok && opened.data.type === "browser.tab.open") {
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Standalone fixture has no owner");
    await stack.host.browser.stop(owner.id, opened.data.sessionId);
  }
  await browser.close();
}, 60_000);
