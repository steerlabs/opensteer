import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, session, webContents } from "electron";
import { createId } from "@opensteer/core";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserPreparationTicketClaimsSchema,
  type BrowserPreparationTicketClaims,
  LocalProfileBindingSchema,
  createBrowserSessionId,
} from "@opensteer/protocol/browser";
import type { BrowserCookie, BrowserProfileSnapshot } from "@opensteer/browser-profile";
import {
  BrowserRuntime,
  type BrowserAttachment,
  type BrowserLauncher,
  type BrowserPage,
  type CdpSession,
  type LaunchedBrowser,
  type BrowserOpenTiming,
} from "@opensteer/browser-runtime-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type {
  ElectronBrowserLauncher,
  ElectronLocalProfileOpenTiming,
} from "../../src/browser/electron-browser-launcher.js";
import { isNetworkService } from "../../src/browser/electron-local-profile.js";

export const nativeProfileSmokePhases = [
  "native-create",
  "native-quit-reopen",
  "native-update-reopen",
  "native-crash",
  "native-crash-reopen",
  "native-convert-crash",
  "native-convert-reopen",
  "native-network",
  "native-logout",
  "native-logout-reopen",
  "native-clear",
  "native-clear-reopen",
  "native-prepare-convert",
  "native-prepare-ready",
] as const;

export function nativeSmokeCookies(origin: string): BrowserCookie[] {
  const domain = new URL(origin).hostname;
  const common = { domain, hostOnly: true, path: "/", secure: true, sameSite: "None" as const };
  return [
    {
      ...common,
      name: "persistent",
      value: "persistent",
      httpOnly: true,
      expires: Math.floor(Date.now() / 1000) + 86_400,
    },
    { ...common, name: "sid", value: "session", httpOnly: true, expires: -1 },
    { ...common, name: "visible", value: "session-visible", httpOnly: false, expires: -1 },
    ...["https://one.test", "https://two.test"].map((partitionKey, i) => ({
      ...common,
      name: "duplicate",
      value: `partition-${i}`,
      httpOnly: true,
      expires: -1,
      partitionKey,
      partitionKeyHasCrossSiteAncestor: true,
    })),
  ];
}

/** Served by the isolated HTTPS fixture; navigations still reach the real server. */
export const nativeSmokeWorker = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(clients.claim()));
self.addEventListener('cookiechange', event => event.waitUntil((async () => {
  const cache = await caches.open('native-cookie-events');
  await cache.put('/last-cookie-event', new Response('observed'));
})()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname !== '/native-worker-state') return;
  event.respondWith((async () => {
    const cookie = await cookieStore.get('visible');
    const cache = await caches.open('native-cache');
    const value = await cache.match('/cached');
    const events = await caches.open('native-cookie-events');
    return Response.json({ cookie: cookie?.value ?? null, cached: value ? await value.text() : null,
      cookieChange: !!(await events.match('/last-cookie-event')) });
  })());
});`;

export async function runNativeProfileSmokePhase(input: {
  phase: string;
  state: string;
  launcher: ElectronBrowserLauncher;
  origin(index: number): string;
  firstRequest(phase: string): string | undefined;
}): Promise<{ crash: boolean; cookieCount: number; cookieChange?: boolean }> {
  const { phase, state, launcher, origin } = input;
  const converted = phase.startsWith("native-convert");
  const root = path.join(state, "native-user-data", "session", "browser-profiles");
  const record = path.join(state, converted ? "converted-binding.json" : "native-binding.json");
  const initialize = phase === "native-create" || phase === "native-convert-crash";
  const binding = initialize
    ? {
        version: 1 as const,
        deploymentId: createId("deployment"),
        profileId: createId("browserProfile"),
        runnerId: createId("runner"),
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "electron" as const,
      }
    : LocalProfileBindingSchema.parse(JSON.parse(await readFile(record, "utf8")));
  const directory = path.join(root, "profiles", binding.profileId, "native");
  const cleared = phase === "native-clear-reopen";
  const loggedOut = phase === "native-logout-reopen" || phase === "native-clear";
  const expected = nativeSmokeCookies(origin(0)).filter((cookie) =>
    cleared ? cookie.partitionKey !== undefined : !loggedOut || cookie.name !== "sid",
  );
  if (initialize) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshot: BrowserProfileSnapshot = {
      cookies: expected,
      origins: converted
        ? [0, 2, 4].map((index) => ({
            origin: origin(index),
            localStorage: [{ name: "saved", value: `converted-${index}` }],
            indexedDB: [
              {
                name: "native-db",
                version: 1,
                stores: [
                  {
                    name: "records",
                    autoIncrement: false,
                    indexes: [],
                    records: [{ keyEncoded: "key", valueEncoded: `converted-${index}` }],
                  },
                ],
              },
            ],
          }))
        : [],
    };
    await launcher.localProfiles.importAndFlush({
      directory,
      binding,
      snapshot,
      signal: new AbortController().signal,
    });
    await writeFile(record, JSON.stringify(binding), { mode: 0o600 });
    // The parent kills/awaits this owned process only after the engine's ready barrier.
    await writeFile(
      path.join(state, `${phase}-ready.json`),
      JSON.stringify({ ready: true, pid: process.pid }),
      { mode: 0o600 },
    );
    if (converted) return { crash: true, cookieCount: expected.length };
  }
  const sessionId = createBrowserSessionId();
  const browser = await launcher.launch({
    initialViewport: { width: 640, height: 480, devicePixelRatio: 1 },
    sessionId,
    partitionKey: `profile:${binding.profileId}`,
    storage: { kind: "local", directory, binding },
  });
  let crash = false;
  let cookieCount = expected.length;
  try {
    const page = browser.context.pages()[0]!;
    await load(page, `${origin(0)}/native-page?phase=${encodeURIComponent(phase)}`);
    const first = input.firstRequest(phase);
    assert.ok(first !== undefined, "first outgoing navigation was not observed");
    if (cleared || loggedOut)
      assert.ok(!first.includes("sid="), "logout resurrected an HttpOnly session cookie");
    if (!cleared) {
      if (!loggedOut)
        assert.ok(
          first.includes("sid=session"),
          "first navigation missed the mirrored HttpOnly cookie",
        );
      assert.ok(
        first.includes("persistent=persistent"),
        "first navigation missed the persistent cookie",
      );
    }
    await assertCookies(browser, expected);
    if (phase === "native-create") {
      await evaluate(
        page,
        `(async () => {
        localStorage.setItem('saved', 'native-value');
        await new Promise((resolve, reject) => {
          const r = indexedDB.open('native-db', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('records');
          r.onerror = () => reject(new Error('database open failed'));
          r.onsuccess = () => { const db = r.result; const tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').put('native-value', 'key'); tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onabort = () => reject(new Error('database commit failed')); };
        });
        const cache = await caches.open('native-cache'); await cache.put('/cached', new Response('native-value'));
        const registration = await navigator.serviceWorker.register('/native-sw.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
        await registration.cookies.subscribe([{ name: 'visible', url: location.origin + '/' }]);
        return true;
      })()`,
      );
    } else if (converted) {
      for (const index of [0, 2, 4]) {
        await load(
          page,
          `${origin(index)}/native-page?phase=${encodeURIComponent(phase)}-${index}`,
        );
        assert.deepEqual(await readStorage(page), {
          localStorage: `converted-${index}`,
          indexedDB: `converted-${index}`,
        });
      }
    } else if (!cleared) {
      assert.deepEqual(await readStorage(page), {
        localStorage: "native-value",
        indexedDB: "native-value",
      });
    } else assert.deepEqual(await readStorage(page), { localStorage: null, indexedDB: null });
    let cookieChange: boolean | undefined;
    if (!converted && !cleared) {
      const worker = await evaluate<{
        cookie: string | null;
        cached: string | null;
        cookieChange: boolean;
      }>(page, `fetch('/native-worker-state').then(r => r.json())`);
      assert.equal(
        worker.cookie,
        "session-visible",
        "service worker missed the restored session cookie",
      );
      assert.equal(worker.cached, "native-value", "CacheStorage did not persist");
      cookieChange = worker.cookieChange;
    }
    if (phase === "native-network") {
      const mirror = path.join(path.dirname(directory), "session-cookies.v1.json");
      // The duplicate CHIPS identities belong to other top-level sites. A
      // first-party sign-in must leave those partitions untouched.
      const siteCookies = expected.filter((cookie) => cookie.partitionKey === undefined);
      await browser.replaceSiteCookies(
        "https://example.test",
        siteCookies,
        new AbortController().signal,
      );
      const before = await readFile(mirror, "utf8");
      const utility = app.getAppMetrics().find((metric) => isNetworkService(metric));
      assert.ok(utility, "owned Network Service utility PID was not found");
      const gone = new Promise<void>((resolve) => {
        const listener = (_event: Electron.Event, details: Electron.Details) => {
          if (!isNetworkService(details)) return;
          app.off("child-process-gone", listener);
          resolve();
        };
        app.on("child-process-gone", listener);
      });
      process.kill(utility.pid, "SIGKILL");
      await deadline(gone, "Network Service loss notification");
      // createPage awaits recovery, including the mirror's readback, rather than polling the jar.
      const after = await deadline(browser.context.createPage(), "Network Service cookie recovery");
      await load(after, `${origin(0)}/native-page?phase=native-network-after`);
      assert.ok(
        input.firstRequest("native-network-after")?.includes("sid=session"),
        "first post-restart request missed the session cookie",
      );
      await assertCookies(browser, expected);
      const survivingWorker = await evaluate<{
        cookie: string | null;
        cached: string | null;
        cookieChange: boolean;
      }>(page, `fetch('/native-worker-state').then(r => r.json())`);
      assert.equal(
        survivingWorker.cookie,
        "session-visible",
        "surviving worker missed Network Service cookie recovery",
      );
      assert.equal(
        survivingWorker.cached,
        "native-value",
        "Network Service restart lost CacheStorage",
      );
      cookieChange = survivingWorker.cookieChange;
      await browser.replaceSiteCookies(
        "https://example.test",
        siteCookies,
        new AbortController().signal,
      );
      assert.equal(
        await readFile(mirror, "utf8"),
        before,
        "Network Service restart shrank or rewrote the mirror",
      );
    }
    if (phase === "native-logout" || phase === "native-clear") {
      const mirror = path.join(path.dirname(directory), "session-cookies.v1.json");
      await observePublication(mirror, async () => {
        await evaluate(
          page,
          `fetch('${phase === "native-logout" ? "/native-logout" : "/native-clear-site-data"}', {credentials:'include'}).then(r => r.text())`,
        );
      });
      const remaining =
        phase === "native-clear"
          ? expected.filter((cookie) => cookie.partitionKey !== undefined)
          : expected.filter((cookie) => cookie.name !== "sid");
      await assertCookies(browser, remaining);
      cookieCount = remaining.length;
    }
    crash = phase === "native-crash";
    return {
      crash,
      cookieCount,
      ...(cookieChange !== undefined ? { cookieChange } : {}),
    };
  } finally {
    if (!crash) await browser.close();
  }
}

export const nativePreparationWorker = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(clients.claim()));
fetch('/native-dormant-worker-probe').then(
  () => console.info('native-probe-admitted'),
  () => console.info('native-probe-cancelled')
);`;

/** Real runtime acquisition/attach, with only the Host's ticket and seed endpoints supplied by the fixture. */
export async function runNativeProfilePreparationSmoke(input: {
  phase: string;
  state: string;
  launcher: ElectronBrowserLauncher;
  timings: ElectronLocalProfileOpenTiming[];
  origin(index: number): string;
  siteRequestCount(): number;
  dormantProbeCount(): number;
  navigationObserved(phase: string): Promise<void>;
}): Promise<Record<string, unknown> & { crash: boolean }> {
  const { phase, state, launcher, origin } = input;
  const converting = phase === "native-prepare-convert";
  const root = path.join(state, "native-user-data", "session", "browser-preparation");
  const record = path.join(state, "prepared-binding.json");
  const entered = Promise.withResolvers<void>();
  const seed = Promise.withResolvers<void>();
  const counts = { loads: 0, imports: 0, completions: 0, launches: 0 };
  let launched: LaunchedBrowser | undefined;
  let launchAt = 0;
  let pagesAtPreparedLaunch = -1;
  const measured: BrowserLauncher = {
    prepare: () => launcher.prepare(),
    localProfiles: {
      ...launcher.localProfiles,
      importAndFlush: async (request) => {
        counts.imports++;
        await launcher.localProfiles.importAndFlush(request);
      },
    },
    launch: async (request, signal) => {
      counts.launches++;
      launchAt = performance.now();
      launched = await launcher.launch(request, signal);
      assert.equal(request.preparation, true, "open bypassed the shared preparation acquisition");
      pagesAtPreparedLaunch = launched.context.pages().length;
      assert.equal(pagesAtPreparedLaunch, 0, "prepared launch created a user page");
      assert.equal(
        input.timings.some((timing) => timing.stage === "page-create-started"),
        false,
        "prepared launch allocated a user page",
      );
      return launched;
    },
  };
  const runtimeTimings: BrowserOpenTiming[] = [];
  const runtimeId = "electron-preparation-smoke";
  let identity: BrowserPreparationTicketClaims["identity"];
  const common = {
    audience: "opensteer-browser-runtime",
    runtimeId,
    subject: "preparation-smoke",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    nonce: randomUUID(),
  };
  const runtime = new BrowserRuntime({
    launcher: measured,
    runtimeId,
    localProfiles: { root },
    initialViewport: { width: 640, height: 480, devicePixelRatio: 1 },
    sessionFilesRoot: path.join(state, "prepare-sessions"),
    onOpenTiming: (timing) => runtimeTimings.push(timing),
    profileStateClient: {
      load: async () => {
        throw new Error("Native preparation used the legacy seed path.");
      },
      commit: async () => {
        throw new Error("Native preparation used the legacy commit path.");
      },
    },
    initializationClient: {
      load: async () => {
        counts.loads++;
        entered.resolve();
        await deadline(seed.promise, "conversion seed admission");
        return {
          cookies: nativeSmokeCookies(origin(0)),
          origins: [
            { origin: origin(0), localStorage: [{ name: "saved", value: "prepared-conversion" }] },
          ],
        };
      },
      complete: async () => {
        counts.completions++;
      },
    },
    ticketVerifier: {
      verifyPreparation: async () =>
        BrowserPreparationTicketClaimsSchema.parse({
          ...common,
          purpose: "profile-prepare",
          identity,
        }),
      verify: async () =>
        BrowserAttachTicketClaimsSchema.parse({
          ...common,
          access: "full-control",
          identity,
          sessionId: createBrowserSessionId(),
          navigationVersion: 1,
          initialNavigationVersion: 1,
          initialNavigation: {
            operationKey: randomUUID(),
            url: `${origin(0)}/native-page?phase=${phase}`,
          },
        }),
    },
  });
  let prepared: Awaited<ReturnType<BrowserRuntime["prepareProfile"]>> | undefined;
  let attachment: BrowserAttachment | undefined;
  try {
    await runtime.prepare();
    const binding = converting
      ? LocalProfileBindingSchema.parse({
          version: 1,
          deploymentId: createId("deployment"),
          profileId: createId("browserProfile"),
          runnerId: createId("runner"),
          storageInstanceId: runtime.localProfileStorage!.storageInstanceId,
          bindingId: randomUUID(),
          engine: "electron",
        })
      : LocalProfileBindingSchema.parse(JSON.parse(await readFile(record, "utf8")));
    identity = {
      kind: "profile-local",
      binding,
      ...(converting
        ? {
            initialization: {
              seed: { revision: 1, digest: "a".repeat(64) },
              initializationUrl: "https://host.test/init",
              initializationToken: "a".repeat(43),
            },
          }
        : {}),
    };
    const requestsBefore = input.siteRequestCount();
    const preparing = runtime.prepareProfile("prepare", {
      localProfiles: true,
      profilePrepare: true,
    });
    void preparing.catch(() => undefined);
    let attachStarted: number;
    if (converting) {
      await deadline(entered.promise, "preparation seed request");
      assert.equal(runtime.health().sessionCount, 0);
      assert.equal(input.siteRequestCount(), requestsBefore);
      attachStarted = performance.now();
      const attaching = runtime.attach(
        "open",
        { sendServer: async () => {}, sendFrame: async () => {} },
        { localProfiles: true, initialNavigation: true },
      );
      seed.resolve();
      [prepared, attachment] = await deadline(
        Promise.all([preparing, attaching]),
        "racing conversion/open",
      );
      assert.deepEqual(
        counts,
        { loads: 1, imports: 1, completions: 1, launches: 1 },
        "racing open imported or launched twice",
      );
      await writeFile(record, JSON.stringify(binding), { mode: 0o600 });
    } else {
      prepared = await deadline(preparing, "ready profile preparation");
      assert.equal(prepared.retained, true);
      assert.equal(runtime.health().sessionCount, 0);
      assert.equal(launched!.context.pages().length, 0);
      assert.equal(input.siteRequestCount(), requestsBefore, "preparation issued a site request");
      assert.equal(
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("https:"))
          .length,
        0,
        "prepared a site renderer",
      );
      const directory = path.join(root, "profiles", binding.profileId, "native");
      const native = session.fromPath(directory);
      const workerProbe = Promise.withResolvers<void>();
      void workerProbe.promise.catch(() => undefined);
      const onConsole = (_event: Electron.Event, details: Electron.MessageDetails) => {
        if (details.message === "native-probe-cancelled") workerProbe.resolve();
        if (details.message === "native-probe-admitted")
          workerProbe.reject(new Error("Dormant worker request was admitted."));
      };
      native.serviceWorkers.on("console-message", onConsole);
      try {
        await deadline(
          native.serviceWorkers.startWorkerForScope(`${origin(0)}/`),
          "prepared service worker start",
        );
        await deadline(workerProbe.promise, "worker request cancellation before admission");
      } finally {
        native.serviceWorkers.off("console-message", onConsole);
      }
      assert.equal(input.siteRequestCount(), requestsBefore, "dormant worker reached the site");
      await restartNetworkService();
      await deadline(launched!.profile!.ready(), "prepared Network Service recovery");
      await assert.rejects(
        deadline(
          native.fetch(`${origin(0)}/native-dormant-session-probe`),
          "dormant request cancellation after recovery",
        ),
        /ERR_(FAILED|BLOCKED_BY_CLIENT|ABORTED)/u,
      );
      assert.equal(input.siteRequestCount(), requestsBefore, "recovery admitted a dormant Session");
      attachStarted = performance.now();
      attachment = await deadline(
        runtime.attach(
          "open",
          { sendServer: async () => {}, sendFrame: async () => {} },
          { localProfiles: true, initialNavigation: true },
        ),
        "prepared first open",
      );
      assert.deepEqual(
        counts,
        { loads: 0, imports: 0, completions: 0, launches: 1 },
        "click reacquired native storage",
      );
    }
    assert.equal(prepared.retained, true);
    assert.equal(pagesAtPreparedLaunch, 0);
    await deadline(input.navigationObserved(phase), "first submitted navigation reaching the site");
    const page = launched!.context.pages()[0]!;
    await assertCookies(launched!, nativeSmokeCookies(origin(0)));
    const firstPage = input.timings.find((timing) => timing.stage === "first-page-created")!;
    const submitted = runtimeTimings.find((timing) => timing.stage === "navigation-submitted")!;
    assert.ok(firstPage && submitted, "first-open timing receipt is incomplete");
    if (converting) {
      // Wait for the document before registering the worker the next process will start without a page.
      await load(page, `${origin(0)}/native-page?phase=${phase}-worker`);
      assert.equal(await evaluate(page, "localStorage.getItem('saved')"), "prepared-conversion");
      await evaluate(
        page,
        `(async () => {
        await navigator.serviceWorker.register('/native-prepare-sw.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
      })()`,
      );
    } else
      assert.equal(input.dormantProbeCount(), 0, "cancelled dormant traffic replayed on admission");
    return {
      crash: false,
      counts,
      pagesAtPreparedLaunch,
      sessionCountAfterOpen: runtime.health().sessionCount,
      ...(converting ? {} : { workerCancelledBeforeAdmit: true }),
      attachToPageCreatedMs: launchAt + firstPage.elapsedMs - attachStarted,
      attachToNavigationSubmittedMs: submitted.elapsedSinceStartMs,
      runtimeTimings,
    };
  } finally {
    seed.resolve();
    await attachment?.close();
    await prepared?.close();
    await runtime.shutdown();
    launcher.close();
  }
}

async function restartNetworkService(): Promise<void> {
  const utility = app.getAppMetrics().find((metric) => isNetworkService(metric));
  assert.ok(utility, "owned Network Service utility PID was not found");
  const listener = (_event: Electron.Event, details: Electron.Details) => {
    if (isNetworkService(details)) gone.resolve();
  };
  const gone = Promise.withResolvers<void>();
  app.on("child-process-gone", listener);
  try {
    process.kill(utility.pid, "SIGKILL");
    await deadline(gone.promise, "Network Service loss notification");
  } finally {
    app.off("child-process-gone", listener);
  }
}

export async function assertCookies(
  browser: LaunchedBrowser,
  expected: BrowserCookie[],
): Promise<void> {
  const channel = await browser.context.pages()[0]!.cdp();
  const result = await channel.send<{
    cookies: {
      name: string;
      value: string;
      domain: string;
      session: boolean;
      httpOnly: boolean;
      partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
    }[];
  }>("Network.getAllCookies");
  assert.equal(result.cookies.length, expected.length, "persistent cookie count changed");
  for (const cookie of expected) {
    const actual = result.cookies.find(
      (value) =>
        value.name === cookie.name &&
        value.partitionKey?.topLevelSite === cookie.partitionKey &&
        value.partitionKey?.hasCrossSiteAncestor === cookie.partitionKeyHasCrossSiteAncestor,
    );
    assert.ok(actual, "complete cookie identity did not round-trip");
    assert.equal(actual.value, cookie.value, "cookie value changed");
    assert.equal(actual.session, cookie.expires < 0, "cookie lifetime changed");
    assert.equal(actual.httpOnly, cookie.httpOnly, "HttpOnly changed");
  }
}

async function readStorage(
  page: BrowserPage,
): Promise<{ localStorage: string | null; indexedDB: string | null }> {
  return evaluate(
    page,
    `(async () => {
    const ls = localStorage.getItem('saved'); const databases = await indexedDB.databases();
    if (!databases.some(d => d.name === 'native-db')) return {localStorage:ls,indexedDB:null};
    const value = await new Promise((resolve,reject) => {const r = indexedDB.open('native-db'); r.onerror = () => reject(new Error('database open failed'));
      r.onsuccess = () => { const db = r.result; const tx = db.transaction('records'); const q = tx.objectStore('records').get('key');
        let value; q.onsuccess = () => {value=q.result ?? null;}; tx.oncomplete = () => {db.close();resolve(value);}; tx.onabort = () => reject(new Error('database read failed')); }; });
    return {localStorage:ls,indexedDB:value};
  })()`,
  );
}
async function evaluate<T = unknown>(page: BrowserPage, expression: string): Promise<T> {
  const result = await deadline(
    (await page.cdp()).send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    ),
    "page fixture operation",
  );
  assert.equal(result.exceptionDetails, undefined, "page fixture operation failed");
  return result.result.value;
}
async function load(page: BrowserPage, url: string): Promise<void> {
  const channel: CdpSession = await page.cdp();
  await channel.send("Page.enable");
  let loaded!: () => void;
  const complete = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  channel.on("Page.loadEventFired", loaded);
  try {
    await channel.send("Page.navigate", { url });
    await deadline(complete, "page load event");
  } finally {
    channel.off("Page.loadEventFired", loaded);
  }
}
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return withTimeout(promise, 10_000, {
    timeoutError: () => new Error(`Timed out waiting for ${label}.`),
  });
}

/** Await the mirror itself: a controlled cookie import would hide missed website invalidations. */
async function observePublication(file: string, operation: () => Promise<void>): Promise<void> {
  const before = await readFile(file, "utf8");
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const changed = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const watcher = watch(path.dirname(file), (_event, name) => {
    if (name !== path.basename(file)) return;
    void readFile(file, "utf8").then((value) => {
      if (value !== before) resolve();
    }, reject);
  });
  watcher.on("error", reject);
  const cancel = new AbortController();
  const observed = withTimeout(changed, 10_000, {
    signal: cancel.signal,
    timeoutError: () => new Error("Website cookie removal was never published to the mirror."),
  });
  void observed.catch(() => undefined);
  try {
    await operation();
    await observed;
  } finally {
    watcher.close();
    cancel.abort();
  }
}
