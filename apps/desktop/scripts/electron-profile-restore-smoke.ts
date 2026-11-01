import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { profileFailureDiagnostic } from "../src/browser/profile-failure-diagnostic.js";
import {
  nativeProfileSmokePhases,
  nativeSmokeWorker,
  runNativeProfileSmokePhase,
} from "./test-support/native-profile-smoke.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Failure inventory written before implementation (design-v3 F1–F12):
 * F1 Data origins, including empty-schema IndexedDB, are filtered out or restored
 * after the first page's scripts. First reads must observe saved state.
 * F2 Parallel helpers exceed the pool or leak after restore failure; a failed
 * launch leaves a page/partition half open and prevents a clean relaunch.
 * F3 Parallel helpers interfere, duplicate origins, race cookies or retain views
 * when the first page is created.
 * F4 Export drops, recaptures or changes an untouched saved origin.
 * F5 Modified/cleared sites keep old state; empty imported sites accumulate.
 * F6 Failed collection deletes a site's previous state or fails to report it.
 * F7 Duplicate or unstable candidate ordering changes budget acceptance.
 * F8 A catch-all service worker executes site code in a helper.
 * F9 Session/secure/CHIPS cookie fidelity or cross-profile isolation changes.
 * F10 A same-process relaunch inherits stale storage or the old visited set.
 * F11 Fresh sessions inherit storage/cookies or stop loading pages.
 * F12 Filtering/parallelism fail the 600ms median for three fresh processes.
 * Additional: first-script IndexedDB is asynchronous (its request begins in the
 * inline head script); network-only helper observation misses Fetch fulfillment;
 * cookie-domain eviction invalidates the shaped fixture; assertions stop evidence
 * or later checks; a claimed restart reuses one process; failure injection changes
 * production code; open IDB connections block cleanup; helpers/processes survive.
 *
 * C1–C8 exercise public launcher/page/CDP APIs and app-level observation only.
 * Inventory F7's full 64MiB/5000-origin boundaries are not claimed covered here.
 * Electron is run exclusively in a VM. Test TLS identity is disposable/public.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:https";
import { app, webContents } from "electron";
import { createBrowserSessionId } from "@opensteer/protocol/browser";
import type { BrowserOriginState, BrowserProfileSnapshot } from "@opensteer/browser-profile";
import type { BrowserPage, LaunchedBrowser } from "@opensteer/browser-runtime-core";
import {
  ElectronBrowserLauncher,
  type ElectronLocalProfileOpenTiming,
} from "../src/browser/electron-browser-launcher.js";
import { key, cert } from "./fixtures/profile-restore-tls.js";

const smokeDownloads = smokeDesktopDownloads();

// The same bundle is a Node phase driver in the committed VM command and an
// Electron entry in the working-tree VM harness. Both use real process restarts.
const phase = process.env.PROFILE_VM_PHASE ?? "main";
const state = realpathSync(
  process.env.PROFILE_VM_STATE ?? mkdtempSync(path.join(tmpdir(), "profile-restore-")),
);
const out =
  process.env.PROFILE_VM_OUT ??
  process.env.OPENSTEER_PROFILE_RESTORE_ARTIFACT_DIR ??
  path.join(process.env.OPENSTEER_QUIT_E2E_ARTIFACT_DIR ?? tmpdir(), "profile-restore");
mkdirSync(out, { recursive: true });

type Result = {
  status: "pass" | "fail";
  observed: Record<string, unknown>;
  error?: string;
  diagnostic?: unknown;
};
const results: Record<string, Result> = {};
const helpers: { origin: string; id: number; at: number }[] = [];
const destroyedAt = new Map<number, number>();
const creations: number[] = [];
const observations = new Map<string, Record<string, unknown>>();
const swRuns: string[] = [];
const nativeOpenTimings: ElectronLocalProfileOpenTiming[] = [];
const nativeFirstRequests = new Map<string, string>();
const nativeRequestObservers = new Set<() => void>();
const open = new Set<LaunchedBrowser>();
const port = 18766;
const origin = (i: number) => `https://s${i}.example.test:${port}`;
const saved = (i: number): BrowserOriginState => ({
  origin: origin(i),
  localStorage: [{ name: "saved", value: `ls-${i}` }],
  ...(i % 2 === 0
    ? {
        indexedDB: [
          {
            name: "fixture",
            version: 1,
            stores: [
              {
                name: "records",
                autoIncrement: false,
                indexes: [],
                records: [{ keyEncoded: "key", valueEncoded: `idb-${i}` }],
              },
            ],
          },
        ],
      }
    : { indexedDB: [] }),
});
const shaped: BrowserProfileSnapshot = {
  cookies: Array.from({ length: 685 }, (_, i) => ({
    // Chromium keeps at most 180 cookies per site, so the jar spans many sites.
    domain: `cookie${Math.floor(i / 10)}.test`,
    hostOnly: true,
    expires: i % 3 === 0 ? -1 : Math.floor(Date.now() / 1000) + 86400,
    name: `cookie-${i}`,
    value: `value-${i}`,
    path: "/",
    secure: true,
    httpOnly: i % 2 === 0,
    sameSite: "None" as const,
    ...(i % 5 === 0
      ? { partitionKey: "https://example.test", partitionKeyHasCrossSiteAncestor: i % 10 === 0 }
      : {}),
  })),
  origins: Array.from({ length: 84 }, (_, i) =>
    i === 25
      ? {
          origin: origin(i),
          localStorage: [],
          indexedDB: [{ name: "schema-only", version: 1, stores: [] }],
        }
      : i < 26
        ? saved(i)
        : { origin: origin(i), localStorage: [] },
  ),
};
const firstScript = `
const firstLS = localStorage.getItem('saved');
const firstIDB = (async () => {
 const databases = await indexedDB.databases();
 if (!databases.some(d => d.name === 'fixture')) return null;
 return new Promise((resolve,reject) => {
  const r = indexedDB.open('fixture'); r.onerror=()=>reject(String(r.error));
  r.onsuccess=()=>{const db=r.result;const tx=db.transaction('records');const q=tx.objectStore('records').get('key');
   q.onsuccess=()=>resolve(q.result ?? null);q.onerror=()=>reject(String(q.error));tx.oncomplete=()=>db.close();};
 });
})();
window.firstState = firstIDB.then(indexedDB => ({localStorage:firstLS,indexedDB}));
window.firstState.then(async value=>{if(new URL(location.href).searchParams.has('schema'))value.databases=await indexedDB.databases();return value}).then(value=>navigator.sendBeacon('/seen?token='+encodeURIComponent(new URL(location.href).searchParams.get('token')||''),JSON.stringify(value)));
`;
const server = createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url ?? "/", `https://${req.headers.host}`);
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/native-page")
    nativeFirstRequests.set(url.searchParams.get("phase") ?? "", req.headers.cookie ?? "");
  for (const observer of nativeRequestObservers) observer();
  if (url.pathname === "/native-sw.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(nativeSmokeWorker);
    return;
  }
  if (url.pathname === "/native-logout") {
    res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None");
    res.end("signed out");
    return;
  }
  if (url.pathname === "/native-clear-site-data") {
    res.setHeader("Clear-Site-Data", '"cookies", "storage", "cache"');
    res.end("cleared");
    return;
  }
  if (url.pathname === "/seen") {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      observations.set(url.searchParams.get("token") ?? "", JSON.parse(body));
      res.end("ok");
    });
  } else if (url.pathname === "/sw-ran") {
    swRuns.push(url.searchParams.get("path") ?? "");
    res.end("ok");
  } else if (url.pathname === "/clear-site-data") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Clear-Site-Data", '"storage"');
    res.end("cleared");
  } else if (url.pathname === "/redirect") {
    res.writeHead(302, { Location: url.searchParams.get("to")! });
    res.end();
  } else if (url.pathname === "/sw.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(
      `self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate'){const p=new URL(e.request.url).pathname;e.respondWith(new Response('<!doctype html><script>localStorage.setItem("sw-ran","'+p+'");navigator.sendBeacon("/sw-ran?path='+encodeURIComponent(p)+'","ran")</script>',{headers:{'Content-Type':'text/html'}}));}});`,
    );
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><script>${firstScript}</script></head><body>profile fixture</body></html>`,
    );
  }
});

function persist() {
  writeFileSync(
    path.join(out, `results-${phase ?? "driver"}.json`),
    JSON.stringify(
      {
        phase,
        pid: process.pid,
        versions: process.versions,
        results,
        helpers,
        swRuns,
      },
      null,
      2,
    ),
  );
}
async function scenario(id: string, run: (observed: Record<string, unknown>) => Promise<void>) {
  const observed: Record<string, unknown> = {};
  try {
    await run(observed);
    results[id] = { status: "pass", observed };
  } catch (error) {
    results[id] = {
      status: "fail",
      observed,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      diagnostic: profileFailureDiagnostic(error),
    };
  }
  persist();
}
async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  ms = 10000,
): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
// page.cdp() is the page's own session, which closes with the page; detaching
// it would close it for every later command.
async function evaluate<T>(page: BrowserPage, expression: string): Promise<T> {
  const result = await (
    await page.cdp()
  ).send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function navigate(page: BrowserPage, url: string) {
  await (await page.cdp()).send("Page.navigate", { url });
}
async function visit(browser: LaunchedBrowser, i: number, token: string) {
  const page = await browser.context.createPage();
  await navigate(page, `${origin(i)}/?token=${token}`);
  const seen = await until(() => observations.get(token), token);
  return { page, seen };
}
function expectSaved(seen: Record<string, unknown>, i: number) {
  assert.deepEqual(seen, { localStorage: `ls-${i}`, indexedDB: i % 2 === 0 ? `idb-${i}` : null });
}
function counts(start: number) {
  return helpers.slice(start).reduce<Record<string, number>>((all, h) => {
    all[h.origin] = (all[h.origin] ?? 0) + 1;
    return all;
  }, {});
}
async function close(browser: LaunchedBrowser) {
  await bounded(browser.close(), "browser.close");
  open.delete(browser);
}
let launcher: ElectronBrowserLauncher;
async function launch(
  snapshot: BrowserProfileSnapshot = shaped,
  fresh = false,
  identity = createBrowserSessionId(),
) {
  const sessionId = identity;
  const browser = await launcher.launch({
    sessionId,
    partitionKey: `${fresh ? "session" : "profile"}:${sessionId}`,
    initialViewport: { width: 640, height: 480, devicePixelRatio: 1 },
    storage: { kind: "legacy", snapshot },
  });
  open.add(browser);
  return browser;
}
async function using(
  snapshot: BrowserProfileSnapshot,
  run: (browser: LaunchedBrowser) => Promise<void>,
) {
  const browser = await launch(snapshot);
  try {
    await run(browser);
  } finally {
    await close(browser);
  }
}
async function write(page: BrowserPage, value: string) {
  await evaluate(page, `localStorage.setItem('saved',${JSON.stringify(value)})`);
}
async function capture(browser: LaunchedBrowser) {
  const failures: unknown[] = [];
  const snapshot = await browser.exportSnapshot((failure) => failures.push(failure));
  assert.deepEqual(failures, [], "Unexpected partial export");
  return snapshot;
}

async function main() {
  const userData = phase.startsWith("native-")
    ? path.join(state, "native-user-data")
    : mkdtempSync(path.join(tmpdir(), "profile-restore-electron-"));
  mkdirSync(userData, { recursive: true });
  if (phase.startsWith("native-")) {
    mkdirSync(path.join(userData, "session"), { recursive: true });
    configureDesktopApplicationPaths(app, userData);
  } else app.setPath("userData", userData);
  app.commandLine.appendSwitch("headless");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.example.test 127.0.0.1");
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.on("window-all-closed", () => undefined);
  app.on("web-contents-created", (_event, contents) => {
    creations.push(contents.id);
    contents.once("destroyed", () => destroyedAt.set(contents.id, performance.now()));
    contents.on("did-start-navigation", (_e, url) => {
      if (url.startsWith("https:") && new URL(url).pathname === "/.opensteer-profile-state") {
        const site = new URL(url).origin;
        helpers.push({ origin: site, id: contents.id, at: performance.now() });
      }
    });
  });
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    assert.ok(
      existsSync(path.join(import.meta.dirname, "browser-page-preload.cjs")),
      "Stage built browser-page-preload.cjs beside smoke",
    );
    launcher = new ElectronBrowserLauncher({
      downloads: smokeDownloads,
      onLocalProfileOpenTiming: (timing) => nativeOpenTimings.push(timing),
      localProfileRoot: path.join(state, "native-user-data", "session", "browser-profiles"),
      pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
    });
    if (phase.startsWith("native-")) {
      let crash = false;
      await scenario(phase, async (observed) => {
        observed.openTimings = nativeOpenTimings;
        const result = await runNativeProfileSmokePhase({
          phase,
          state,
          launcher,
          origin,
          firstRequest: (name) => nativeFirstRequests.get(name),
        });
        Object.assign(observed, result, { openTimings: nativeOpenTimings });
        crash = result.crash;
      });
      if (crash && Object.values(results).every((result) => result.status === "pass"))
        process.kill(process.pid, "SIGKILL");
    } else if (phase === "restart") {
      await scenario("C6", async (observed) => {
        const prior = JSON.parse(readFileSync(path.join(state, "restart.json"), "utf8")) as {
          pid: number;
          snapshot: BrowserProfileSnapshot;
        };
        observed.previousPid = prior.pid;
        observed.pid = process.pid;
        assert.notEqual(prior.pid, process.pid);
        await using(prior.snapshot, async (browser) => {
          const start = helpers.length;
          const second = await capture(browser);
          observed.helperCounts = counts(start);
          observed.snapshot = second;
          const { seen } = await visit(browser, 0, "restart");
          observed.seen = seen;
          assert.deepEqual(seen, { localStorage: "restart-value", indexedDB: "idb-0" });
          assert.deepEqual(counts(start), { [origin(0)]: 1 });
          assert.deepEqual(second, prior.snapshot);
        });
      });
    } else {
      await launchTrial();
      if (phase === "main") {
        await acceptance();
        await deltaChecks();
      }
    }
  } catch (error) {
    results.setup = {
      status: "fail",
      observed: {},
      error: String(error instanceof Error ? error.stack : error),
    };
  } finally {
    for (const browser of open) {
      try {
        await close(browser);
      } catch (error) {
        results.cleanup = { status: "fail", observed: {}, error: String(error) };
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    persist();
    if (phase === "restart") {
      const phases = ["main", "restart"].map((name) => {
        const file = path.join(out, `results-${name}.json`);
        return existsSync(file)
          ? (JSON.parse(readFileSync(file, "utf8")) as {
              phase: string;
              results: Record<string, Result>;
            })
          : {
              phase: name,
              results: {
                missing: {
                  status: "fail",
                  observed: {},
                  error: "Phase evidence missing",
                } as Result,
              },
            };
      });
      const checks = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => {
          const id = `C${i + 1}`;
          const evidence = phases.flatMap((p) =>
            p.results[id] ? [{ phase: p.phase, ...p.results[id] }] : [],
          );
          if (id === "C6")
            evidence.push(
              ...phases.flatMap((p) =>
                p.results["C6-write"] ? [{ phase: p.phase, ...p.results["C6-write"] }] : [],
              ),
            );
          return [
            id,
            {
              status:
                evidence.length > 0 && evidence.every((r) => r.status === "pass") ? "pass" : "fail",
              evidence,
            },
          ];
        }),
      );
      writeFileSync(path.join(out, "results.json"), JSON.stringify({ checks, phases }, null, 2));
    }
    if (!phase.startsWith("native-")) rmSync(userData, { recursive: true, force: true });
    const failed = Object.values(results).some((r) => r.status === "fail");
    if (phase.startsWith("native-") && !failed) app.quit();
    else app.exit(failed ? 1 : 0);
  }
}

async function launchTrial() {
  await scenario("C1", async (observed) => {
    // A Runtime prepares its engine before it advertises a placement, so a
    // person's first launch after a restart meets a prepared engine.
    await launcher.prepare();
    const start = helpers.length;
    const created = creations.length;
    const t = performance.now();
    const browser = await launch();
    const elapsed = performance.now() - t;
    const liveAtResolve = webContents
      .getAllWebContents()
      .map((c) => ({ id: c.id, url: c.getURL() }));
    try {
      observed.launchMs = elapsed;
      observed.helperCounts = counts(start);
      observed.creations = creations.slice(created);
      const channel = await browser.context.pages()[0]!.cdp();
      type Cookie = {
        name: string;
        value: string;
        session: boolean;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite: string;
        expires: number;
        partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
      };
      let actual: Cookie[];
      try {
        actual = (await channel.send<{ cookies: Cookie[] }>("Network.getAllCookies")).cookies;
      } finally {
        await channel.detach();
      }
      observed.cookies = {
        count: actual.length,
        session: actual.filter((c) => c.session).length,
        partitioned: actual.filter((c) => c.partitionKey).length,
      };
      const failures: string[] = [];
      try {
        assert.equal(actual.length, shaped.cookies.length);
        for (const expected of shaped.cookies) {
          const c = actual.find((c) => c.name === expected.name);
          assert.ok(c, expected.name);
          for (const field of [
            "value",
            "domain",
            "path",
            "secure",
            "httpOnly",
            "expires",
            "sameSite",
          ] as const)
            assert.equal(c[field], expected[field]);
          assert.equal(c.session, expected.expires === -1);
          if (expected.partitionKey)
            assert.deepEqual(c.partitionKey, {
              topLevelSite: expected.partitionKey,
              hasCrossSiteAncestor: expected.partitionKeyHasCrossSiteAncestor,
            });
          else assert.equal(c.partitionKey, undefined);
        }
      } catch (error) {
        failures.push(String(error));
      }
      try {
        assert.deepEqual(
          counts(start),
          Object.fromEntries(shaped.origins.slice(0, 26).map((o) => [o.origin, 1])),
        );
      } catch {
        failures.push("Expected exactly the 26 data-origin helper loads");
      }
      // The first page may open beside the restores, but when launch resolves
      // every helper is gone and the page has loaded nothing but a blank document.
      observed.liveAtResolve = liveAtResolve;
      try {
        assert.equal(liveAtResolve.length, 1);
        assert.equal(liveAtResolve[0]!.url, "about:blank");
        assert.ok(creations.slice(created).includes(liveAtResolve[0]!.id));
      } catch {
        failures.push("Helpers alive, or the first page navigated, when launch resolved");
      }
      const file = path.join(state, "launch-trials.json");
      const trials = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number; ms: number }[])
        : [];
      trials.push({ pid: process.pid, ms: elapsed });
      writeFileSync(file, JSON.stringify(trials));
      observed.trials = trials;
      assert.deepEqual(failures, []);
    } finally {
      await close(browser);
    }
  });
}
async function acceptance() {
  await scenario("C2", async (observed) => {
    await using(shaped, async (browser) => {
      const records: Record<string, unknown> = {};
      observed.paths = records;
      const main = await visit(browser, 0, "main");
      records.main = main.seen;
      expectSaved(main.seen, 0);
      await evaluate(
        main.page,
        `document.body.appendChild(Object.assign(document.createElement('iframe'),{src:${JSON.stringify(origin(2) + "/?token=frame")}}));true`,
      );
      records.frame = await until(() => observations.get("frame"), "frame");
      expectSaved(records.frame as Record<string, unknown>, 2);
      await evaluate(main.page, `window.open(${JSON.stringify(origin(4) + "/?token=popup")});true`);
      records.popup = await until(() => observations.get("popup"), "popup");
      expectSaved(records.popup as Record<string, unknown>, 4);
      await browser.cdp.send("Target.createTarget", { url: origin(6) + "/?token=target" });
      records.target = await until(() => observations.get("target"), "target");
      expectSaved(records.target as Record<string, unknown>, 6);
      const redirect = await browser.context.createPage();
      await navigate(
        redirect,
        origin(90) + "/redirect?to=" + encodeURIComponent(origin(8) + "/?token=redirect"),
      );
      records.redirect = await until(() => observations.get("redirect"), "redirect");
      expectSaved(records.redirect as Record<string, unknown>, 8);
      const reads: unknown[] = [];
      observed.everySavedOrigin = reads;
      for (let i = 0; i < 25; i++) {
        const { page, seen } = await visit(browser, i, `all-${i}`);
        reads.push({ origin: origin(i), seen });
        expectSaved(seen, i);
        await page.close();
      }
      const schema = await browser.context.createPage();
      await navigate(schema, origin(25) + "/?schema&token=schema");
      const seen = await until(() => observations.get("schema"), "schema");
      observed.schema = seen;
      assert.deepEqual(seen, {
        localStorage: null,
        indexedDB: null,
        databases: [{ name: "schema-only", version: 1 }],
      });
    });
  });
  await scenario("C3", async (observed) => {
    await using(shaped, async (browser) => {
      const a = await visit(browser, 0, "modify");
      await write(a.page, "modified");
      const b = await visit(browser, 90, "new");
      await write(b.page, "new-value");
      const c = await visit(browser, 1, "clear");
      await evaluate(c.page, "localStorage.clear()");
      const start = helpers.length;
      const snapshot = await capture(browser);
      observed.helperCounts = counts(start);
      observed.snapshot = snapshot;
      const mismatches: string[] = [];
      try {
        assert.deepEqual(
          counts(start),
          Object.fromEntries(
            [...shaped.origins.slice(0, 26).map((o) => o.origin), origin(90)].map((o) => [o, 1]),
          ),
        );
      } catch {
        mismatches.push("Export did not load exactly the data origins plus the new used origin");
      }
      for (const expected of shaped.origins.slice(2, 26)) {
        try {
          assert.deepEqual(
            snapshot.origins.find((o) => o.origin === expected.origin),
            expected,
          );
        } catch {
          mismatches.push(`Untouched state changed: ${expected.origin}`);
        }
      }
      assert.equal(
        snapshot.origins
          .find((o) => o.origin === origin(0))
          ?.localStorage.find((e) => e.name === "saved")?.value,
        "modified",
      );
      assert.equal(
        snapshot.origins
          .find((o) => o.origin === origin(90))
          ?.localStorage.find((e) => e.name === "saved")?.value,
        "new-value",
      );
      if (
        snapshot.origins.some(
          (o) =>
            o.origin === origin(1) || shaped.origins.slice(26).some((e) => e.origin === o.origin),
        )
      )
        mismatches.push("Cleared/empty origins retained");
      observed.selectiveCaptureErrors = mismatches;
      // Empty IDB names are valid browser state, but the collector deliberately
      // rejects incomplete database metadata. This injects failure via site code.
      await evaluate(
        a.page,
        `new Promise((resolve,reject)=>{const r=indexedDB.open('',1);r.onerror=()=>reject(String(r.error));r.onsuccess=()=>{r.result.close();resolve(true)}})`,
      );
      const failures: unknown[] = [];
      const failed = await browser.exportSnapshot((f) => failures.push(f));
      observed.forcedFailure = { failures, snapshot: failed };
      assert.deepEqual(failures, [{ origin: origin(0), reason: "capture", retained: true }]);
      assert.deepEqual(
        failed.origins.find((o) => o.origin === origin(0)),
        snapshot.origins.find((o) => o.origin === origin(0)),
      );
      assert.deepEqual(mismatches, []);
    });
  });
  await scenario("C4", async (observed) => {
    await using({ cookies: [], origins: [saved(0)] }, async (browser) => {
      const { page } = await visit(browser, 0, "sw-register");
      await evaluate(
        page,
        `(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;while(!navigator.serviceWorker.controller)await new Promise(r=>setTimeout(r,10));return true})()`,
      );
      const start = swRuns.length;
      const hs = helpers.length;
      const snapshot = await capture(browser);
      observed.helperCounts = counts(hs);
      observed.snapshot = snapshot;
      observed.swRuns = swRuns.slice(start);
      assert.deepEqual(swRuns.slice(start), []);
      assert.equal(await evaluate(page, "localStorage.getItem('sw-ran')"), null);
      assert.deepEqual(snapshot.origins, [saved(0)]);
    });
  });
  await scenario("C5", async (observed) => {
    const identity = createBrowserSessionId();
    const baseline = webContents
      .getAllWebContents()
      .map((c) => c.id)
      .sort();
    const slow = saved(4);
    slow.indexedDB![0]!.stores[0]!.records = Array.from({ length: 20_000 }, (_, k) => ({
      keyEncoded: `key-${k}`,
      valueEncoded: "x".repeat(200),
    }));
    const bad = saved(0);
    bad.indexedDB![0]!.stores[0]!.records.push({ keyEncoded: "key", valueEncoded: "duplicate" });
    const start = helpers.length;
    let rejectedAt: number | null = null;
    try {
      const browser = await launch({ cookies: [], origins: [slow, bad] }, false, identity);
      await close(browser);
    } catch (error) {
      rejectedAt = performance.now();
      observed.error = String(error);
    }
    const lanes = helpers.slice(start).map((h) => ({
      origin: h.origin,
      destroyedAt: destroyedAt.get(h.id) ?? null,
    }));
    observed.lanes = lanes;
    observed.rejectedAt = rejectedAt;
    observed.remaining = webContents
      .getAllWebContents()
      .map((c) => c.id)
      .sort();
    assert.notEqual(rejectedAt, null, "launch did not fail");
    const slowLane = lanes.find((lane) => lane.origin === origin(4));
    const badLane = lanes.find((lane) => lane.origin === origin(0));
    assert.ok(slowLane?.destroyedAt && badLane?.destroyedAt, "both lanes ran and ended");
    // The sibling was still restoring when the other lane failed ...
    assert.ok(slowLane.destroyedAt > badLane.destroyedAt, "slow lane was not mid-restore");
    // ... and the start rejected only after every helper was gone.
    for (const lane of lanes) assert.ok(lane.destroyedAt! <= rejectedAt!, lane.origin);
    assert.deepEqual(observed.remaining, baseline);
    const browser = await launch({ cookies: [], origins: [saved(0)] }, false, identity);
    try {
      const { seen } = await visit(browser, 0, "after-failure");
      observed.relaunch = seen;
      expectSaved(seen, 0);
      // Nothing the interrupted restore wrote survives the failed start's cleanup.
      const late = await visit(browser, 4, "after-failure-slow");
      observed.lateWrites = late.seen;
      assert.deepEqual(late.seen, { localStorage: null, indexedDB: null });
    } finally {
      await close(browser);
    }
  });
  await scenario("C6-write", async (observed) => {
    await using({ cookies: [], origins: [saved(0)] }, async (browser) => {
      const { page } = await visit(browser, 0, "restart-write");
      await write(page, "restart-value");
      const snapshot = await capture(browser);
      observed.snapshot = snapshot;
      writeFileSync(
        path.join(state, "restart.json"),
        JSON.stringify({ pid: process.pid, snapshot }),
      );
    });
  });
  await scenario("C7", async (observed) => {
    const identity = createBrowserSessionId();
    const original = { cookies: [], origins: [saved(0)] };
    const first = await launch(original, false, identity);
    try {
      const { page } = await visit(first, 0, "same-process-before");
      await write(page, "must-not-survive");
      const b = await visit(first, 90, "same-process-new");
      await write(b.page, "also-must-not-survive");
    } finally {
      await close(first);
    }
    const second = await launch(original, false, identity);
    try {
      const start = helpers.length;
      const snapshot = await capture(second);
      observed.helperCounts = counts(start);
      observed.snapshot = snapshot;
      const { seen } = await visit(second, 0, "same-process-after");
      observed.seen = seen;
      expectSaved(seen, 0);
      const b = await visit(second, 90, "same-process-isolation");
      assert.deepEqual(b.seen, { localStorage: null, indexedDB: null });
      assert.deepEqual(counts(start), { [origin(0)]: 1 });
      assert.deepEqual(snapshot, original);
    } finally {
      await close(second);
    }
  });
  await scenario("C8", async (observed) => {
    const start = helpers.length;
    const browser = await launch({ cookies: [], origins: [] }, true);
    try {
      const { seen } = await visit(browser, 0, "fresh");
      observed.seen = seen;
      observed.helperCounts = counts(start);
      const channel = await browser.context.pages()[0]!.cdp();
      try {
        const cookies = (await channel.send<{ cookies: unknown[] }>("Network.getAllCookies"))
          .cookies;
        observed.cookies = cookies;
        assert.deepEqual(cookies, []);
      } finally {
        await channel.detach();
      }
      assert.deepEqual(seen, { localStorage: null, indexedDB: null });
      assert.deepEqual(counts(start), {});
    } finally {
      await close(browser);
    }
  });
}
async function deltaChecks() {
  await scenario("C9", async (observed) => {
    // A same-site response can delete a site's storage without any frame there.
    await using({ cookies: [], origins: [saved(0), saved(2)] }, async (browser) => {
      const { page } = await visit(browser, 0, "clear-site-data-source");
      await evaluate(
        page,
        `fetch(${JSON.stringify(origin(2) + "/clear-site-data")},{credentials:'include'}).then(r=>r.text())`,
      );
      const start = helpers.length;
      const snapshot = await capture(browser);
      observed.helperCounts = counts(start);
      observed.snapshot = snapshot;
      const { seen } = await visit(browser, 2, "clear-site-data-target");
      observed.targetAfter = seen;
      assert.deepEqual(seen, { localStorage: null, indexedDB: null }, "browser kept the storage");
      assert.deepEqual(snapshot.origins, [saved(0)]);
    });
  });
  await scenario("C10", async (observed) => {
    const first = { ...saved(0), localStorage: [{ name: "saved", value: "first" }] };
    const emptyLast = { origin: origin(0), localStorage: [] };
    const emptyFirst = { origin: origin(2), localStorage: [] };
    await using(
      { cookies: [], origins: [first, emptyLast, emptyFirst, saved(2)] },
      async (browser) => {
        const zero = await visit(browser, 0, "duplicate-empty-last");
        const two = await visit(browser, 2, "duplicate-data-last");
        observed.seen = { zero: zero.seen, two: two.seen };
        assert.deepEqual(zero.seen, { localStorage: null, indexedDB: null });
        expectSaved(two.seen, 2);
        const snapshot = await capture(browser);
        observed.snapshot = snapshot;
        assert.deepEqual(snapshot.origins, [saved(2)]);
      },
    );
  });
  await scenario("C12", async (observed) => {
    // Storage helpers take no page slot: at the page cap a profile still
    // restores, saves, and opens pages while a save runs.
    const snapshot: BrowserProfileSnapshot = {
      cookies: shaped.cookies.slice(1, 21),
      origins: [saved(0), saved(1), saved(2)],
    };
    const capped = (maxWebContents: number) =>
      new ElectronBrowserLauncher({
        downloads: smokeDownloads,
        pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
        maxWebContents,
      }).launch({
        sessionId: createBrowserSessionId(),
        partitionKey: `profile:${createBrowserSessionId()}`,
        initialViewport: { width: 640, height: 480, devicePixelRatio: 1 },
        storage: { kind: "legacy", snapshot },
      });
    const one = await capped(1);
    try {
      observed.singleSlotLive = webContents.getAllWebContents().map((c) => c.getURL());
      assert.deepEqual(observed.singleSlotLive, ["about:blank"]);
      const page = one.context.pages()[0]!;
      const cookies = (
        await (
          await page.cdp()
        ).send<{ cookies: { name: string; value: string }[] }>("Network.getAllCookies")
      ).cookies;
      assert.deepEqual(
        cookies.map((c) => `${c.name}=${c.value}`).sort(),
        snapshot.cookies.map((c) => `${c.name}=${c.value}`).sort(),
      );
      const reads: unknown[] = [];
      observed.singleSlotReads = reads;
      for (const i of [0, 1, 2]) {
        await navigate(page, `${origin(i)}/?token=single-slot-${i}`);
        const seen = await until(() => observations.get(`single-slot-${i}`), `single-slot-${i}`);
        reads.push(seen);
        expectSaved(seen, i);
      }
      const exported = await capture(one);
      observed.singleSlotExport = exported;
      assert.deepEqual(exported.origins, snapshot.origins);
    } finally {
      await bounded(one.close(), "single-slot close");
    }
    const two = await capped(2);
    try {
      const saving = capture(two);
      const second = await two.context.createPage();
      observed.pageDuringSave = second.url();
      const exported = await saving;
      assert.deepEqual(exported.origins, snapshot.origins);
    } finally {
      await bounded(two.close(), "one-free-slot close");
    }
  });
  await scenario("C11", async (observed) => {
    // Helpers are gone when a restore or a save settles.
    await using({ cookies: [], origins: [saved(0), saved(2), saved(4)] }, async (browser) => {
      const live = () => {
        const ids = new Set(helpers.map((h) => h.id));
        return webContents
          .getAllWebContents()
          .filter((c) => ids.has(c.id))
          .map((c) => c.id);
      };
      observed.afterLaunch = live();
      assert.deepEqual(observed.afterLaunch, []);
      await capture(browser);
      observed.afterExport = live();
      assert.deepEqual(observed.afterExport, []);
    });
  });
}
async function driver() {
  // Inside Electron, require("electron") is the API object, not a path.
  const executable = process.execPath;
  let failed = false;
  try {
    for (const name of ["main", "restart", ...nativeProfileSmokePhases]) {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(executable, [import.meta.filename], {
          stdio: "inherit",
          env: {
            ...process.env,
            PROFILE_VM_PHASE: name,
            PROFILE_VM_STATE: state,
            PROFILE_VM_OUT: out,
          },
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          const crash = ["native-crash", "native-convert-crash"].includes(name);
          const evidence = path.join(out, `results-${name}.json`);
          const passed =
            existsSync(evidence) &&
            Object.values(
              (JSON.parse(readFileSync(evidence, "utf8")) as { results: Record<string, Result> })
                .results,
            ).every((result) => result.status === "pass");
          resolve(crash ? (signal === "SIGKILL" && passed ? 0 : 1) : (code ?? 1));
        });
      });
      failed ||= code !== 0;
    }
    const summary = path.join(out, "results.json");
    if (existsSync(summary)) {
      const result = JSON.parse(readFileSync(summary, "utf8")) as { nativePhases?: unknown[] };
      result.nativePhases = nativeProfileSmokePhases.map(
        (name) =>
          JSON.parse(readFileSync(path.join(out, `results-${name}.json`), "utf8")) as unknown,
      );
      writeFileSync(summary, JSON.stringify(result, null, 2));
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`profile restore driver failed: ${String(error)}\n`);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
  app.exit(failed ? 1 : 0);
}
if (process.env.PROFILE_VM_PHASE) void main();
else {
  const driverData = path.join(state, "driver-user-data");
  mkdirSync(driverData, { recursive: true });
  app.setPath("userData", driverData);
  app.commandLine.appendSwitch("headless");
  void driver();
}
