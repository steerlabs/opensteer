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
import type { NativeProfileOpenTiming } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { ownChild } from "../apps/host/src/agents/owned-child.test-support.js";
import type { BrowserOpenTiming } from "../packages/browser-runtime-core/src/runtime.js";
import type { BrowserProfileId } from "../packages/core/src/index.js";
import { RealtimeHub } from "../packages/orchestration/src/realtime-hub.js";
import type { BrowserTabOpenResult } from "../packages/protocol/src/index.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { closeHttpServerNow } from "../packages/shared/src/httpServer.js";
import { gate } from "../packages/shared/src/observation.test-support.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { addCleanup, deployment } from "./browser-deployment.test-support.js";

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

it("creates native profiles lazily, retains sign-ins through restart, and erases them on their owner", async () => {
  await access(chromium.executablePath());
  const broadNotices = vi.spyOn(RealtimeHub.prototype, "publishBrowserSessionsChanged");
  const browser = await browserProcess();
  let journeyAssertionsComplete = false;
  let warmTimings: BrowserOpenTiming[] = [];
  let coldTimings: BrowserOpenTiming[] = [];
  let coldNativeTimings: NativeProfileOpenTiming[] = [];
  let warmWallMs: number | undefined;
  let coldWallMs: number | undefined;
  addCleanup(
    "native profile timing receipts",
    async () => {
      await writeFile(
        path.join(tmpdir(), "native-profile-integration-timings.json"),
        JSON.stringify(
          {
            journeyAssertionsComplete,
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
    },
    2,
  );
  // The Runner uses precisely the desktop Personal/enrolled loopback composition.
  const stack = await deployment(browser, undefined, { personal: true });
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
  const profile = await stack.host.browser.createProfile({
    name: "Native",
    ownerId: owner.id,
    workspaceId: stack.mainWorkspaceId,
    idempotencyKey: randomUUID(),
  });
  const row = () =>
    stack.host.store.database
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", profile.id)
      .executeTakeFirstOrThrow();
  expect(await row()).toMatchObject({ storageState: "unbound", initialized: false });
  expect((await browser.health()).profileHostCount).toBe(0);
  const seeded = await open(profile.id, "/seed?id=seed");
  expect(await site.observed("seed")).toEqual(expected);
  await close(seeded);
  const binding = await stack.host.store.getBrowserProfileStorage(profile.id);
  expect(binding).toMatchObject({ kind: "local", initialized: true });
  const firstOpening = open(profile.id, "/delayed?id=initial");
  void firstOpening.catch(() => undefined);
  let converted: BrowserTabOpenResult;
  try {
    converted = await firstOpening;
    await site.navigation.entered;
    expect(site.responseCompleted(), "tab.open waited for the delayed HTTP response").toBe(false);
    site.navigation.release();
  } finally {
    site.navigation.release();
    await bounded(
      firstOpening.catch(() => undefined),
      "Admitted initial did not settle during cleanup",
    );
  }
  expect(await site.observed("initial")).toEqual(expected);
  await vi.waitFor(
    async () => {
      const history = await stack.api["browser.history.get"]({ profileId: profile.id });
      expect(history, "Native initial navigation did not record its committed visit").toMatchObject(
        {
          ok: true,
          data: {
            entries: [
              expect.objectContaining({
                url: site.origin + "/delayed?id=initial",
                visitCount: 1,
              }),
              expect.objectContaining({ url: site.origin + "/seed?id=seed", visitCount: 1 }),
            ],
          },
        },
      );
    },
    { timeout: 5000 },
  );
  await close(converted);
  await vi.waitFor(
    async () =>
      expect((await browser.health()).sessionCount, "Closed profile still holds a session").toBe(0),
    { timeout: 5000 },
  );
  const warmStart = browser.timings.length;
  const warmWallStart = performance.now();
  const warm = await open(profile.id, "/read?id=warm");
  warmWallMs = performance.now() - warmWallStart;
  expect(await site.observed("warm")).toEqual(expected);
  expect(browser.timings.some((timing) => timing.acquisition === "warm")).toBe(true);
  warmTimings = browser.timings.slice(warmStart);
  await close(warm);
  const visitsBeforeRestart = site.visits();
  await browser.close();
  await browser.start();
  await stack.restartRunner();
  const coldStart = browser.timings.length;
  const coldNativeStart = browser.nativeTimings.length;
  const coldWallStart = performance.now();
  const cold = await open(profile.id, "/read?id=cold");
  coldWallMs = performance.now() - coldWallStart;
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
  expect(browser.timings.some((timing) => timing.acquisition === "cold")).toBe(true);
  coldTimings = browser.timings.slice(coldStart);
  coldNativeTimings = browser.nativeTimings.slice(coldNativeStart);
  await close(cold);

  expect(await stack.host.store.getBrowserProfileStorage(profile.id)).toEqual(binding);
  // A reconnect may confirm established storage, never replace its immutable binding.
  const deleted = await stack.api["commands.dispatch"]({
    type: "browser.profile.delete",
    profileId: profile.id,
    idempotencyKey: randomUUID(),
  });
  expect(deleted.ok).toBe(true);
  expect(
    await stack.host.store.database
      .selectFrom("browserHistoryEntries")
      .selectAll()
      .where("profileId", "=", profile.id)
      .execute(),
  ).toEqual([]);
  expect(
    await stack.host.store.database
      .selectFrom("browserHistoryIcons")
      .selectAll()
      .where("profileId", "=", profile.id)
      .execute(),
  ).toEqual([]);
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
      expect(broadNotices).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        "browser.profile-reconciled",
      );
      expect(broadNotices).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        "browser.profile-deletions",
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
  const tombstone = JSON.parse(
    await readFile(path.join(browser.profileRoot, "tombstones", `${profile.id}.json`), "utf8"),
  );
  expect(tombstone).toMatchObject({ phase: "deleted", erasure: "deleted" });
  journeyAssertionsComplete = true;
  vi.restoreAllMocks();
}, 90_000);

it("advertises exact prepared storage through the standalone browser-only Runner", async () => {
  const enrollmentToken = randomBytes(32).toString("base64url");
  const stack = await deployment(undefined, enrollmentToken);
  const browser = await browserProcess({ hostOrigin: stack.hostOrigin, enrollmentToken });
  const bridge = new LocalBrowserRuntimeBridge(browser);
  const capabilities = await bridge.capabilities();
  expect(capabilities).toEqual({
    wireVersion: 1,
    localProfileStorage: { storageInstanceId: expect.any(String), engine: "chromium" },
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
