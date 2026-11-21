import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const removedDirs = [];

function countDescendantRenderers(rootPid) {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = output
    .trim()
    .split("\n")
    .map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line.trim());
      return m ? { pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] } : null;
    })
    .filter(Boolean);
  const byParent = new Map();
  for (const r of rows) {
    const arr = byParent.get(r.ppid) ?? [];
    arr.push(r);
    byParent.set(r.ppid, arr);
  }
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  let count = 0;
  let rssKb = 0;
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of byParent.get(cur) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      if (child.cmd.includes("--type=renderer")) {
        count++;
        rssKb += child.rssKb;
      }
      queue.push(child.pid);
    }
  }
  return { count, rssMb: Math.round(rssKb / 1024) };
}

async function createHelperExtension() {
  const extDir = await mkdtemp(path.join(tmpdir(), "os-gate-ext-"));
  await writeFile(
    path.join(extDir, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Opensteer Tab Lifecycle Helper",
        version: "0.1.0",
        permissions: ["tabs", "debugger"],
        background: { service_worker: "sw.js" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(extDir, "sw.js"),
    `
// Minimal internal lifecycle bridge: zero host permissions, zero content scripts.
chrome.tabs.onCreated.addListener(() => {});
globalThis.__opensteer = {
  ping() {
    return "pong:" + chrome.runtime.id;
  },
  async inventory() {
    const [tabs, targets] = await Promise.all([
      chrome.tabs.query({}),
      chrome.debugger.getTargets(),
    ]);
    const targetByTabId = new Map();
    for (const t of targets) {
      if (t.type === "page" && typeof t.tabId === "number") {
        targetByTabId.set(t.tabId, { targetId: t.id, attached: t.attached });
      }
    }
    return tabs
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        index: t.index,
        url: t.url || t.pendingUrl || "",
        title: t.title || "",
        active: t.active,
        discarded: Boolean(t.discarded),
        status: t.status || "",
        targetId: targetByTabId.get(t.id)?.targetId ?? null,
        attached: targetByTabId.get(t.id)?.attached ?? false,
      }));
  },
  async discardByTabId(tabId) {
    const updated = await chrome.tabs.discard(tabId);
    return {
      ok: Boolean(updated?.discarded),
      oldTabId: tabId,
      newTabId: updated?.id ?? null,
      discarded: Boolean(updated?.discarded),
    };
  },
  async activateByTabId(tabId) {
    const updated = await chrome.tabs.update(tabId, { active: true });
    return { tabId: updated?.id ?? null, discarded: Boolean(updated?.discarded), status: updated?.status ?? "" };
  },
  async reloadByTabId(tabId) {
    await chrome.tabs.reload(tabId);
    return true;
  },
};
`,
  );
  return extDir;
}

function nativeArgs(dir, extDir, { webContentsDiscard = false, noStartupWindow = false } = {}) {
  return [
    `--user-data-dir=${dir}`,
    "--remote-debugging-pipe",
    "--disable-field-trial-config",
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-background-networking",
    ...(noStartupWindow ? ["--no-startup-window"] : []),
    "--restore-last-session",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    ...(webContentsDiscard ? ["--enable-features=WebContentsDiscard"] : []),
    "--headless=new",
    "--no-sandbox",
  ];
}

async function getHelperWorker(context, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sw = context.serviceWorkers().find((w) => w.url().endsWith("/sw.js"));
    if (sw) {
      const ready = await sw.evaluate(() => typeof globalThis.__opensteer === "object").catch(() => false);
      if (ready) return sw;
    }
    await delay(50);
  }
  throw new Error("Helper extension service worker never became ready on context.serviceWorkers()");
}

async function evalHelper(sw, expr) {
  return await sw.evaluate(expr);
}

async function startFixtureServer() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ host: req.headers.host, path: url.pathname + url.search });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (url.pathname === "/form-scroll") {
      const label = url.searchParams.get("label") ?? "tab";
      res.end(`<!doctype html><html><body style="height:6000px">
        <h1>${label}</h1>
        <input id="field" type="text" value="" />
        <div style="height:5000px">spacer</div>
        <script>window.__payload = new Uint8Array(1024 * 1024).fill(7);</script>
      </body></html>`);
      return;
    }
    res.end("<!doctype html><html><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    port,
    requests,
    clearRequests: () => {
      requests.length = 0;
    },
    urlFor: (siteIdx, label) => `http://site-${siteIdx}.localhost:${port}/form-scroll?label=${label}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function runGate1ExtensionLifecycle(extDir) {
  const dir = await mkdtemp(path.join(tmpdir(), "os-gate1-"));
  removedDirs.push(dir);
  await mkdir(path.join(dir, "Default"), { recursive: true });
  await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: chromium.executablePath(),
    ignoreDefaultArgs: true,
    args: nativeArgs(dir, extDir),
    headless: true,
    chromiumSandbox: false,
    acceptDownloads: false,
    viewport: null,
    timeout: 20_000,
  });
  try {
    const sw1 = await getHelperWorker(context);
    const swUrl = sw1.url();
    const extOrigin = swUrl.replace(/\/sw\.js$/u, "");
    const ping1 = await sw1.evaluate(() => globalThis.__opensteer.ping());
    const inv1 = await sw1.evaluate(() => globalThis.__opensteer.inventory());
    const browserCdp = await context.browser().newBrowserCDPSession();

    // Stop the service worker via ServiceWorker.stopWorker (using an extension-origin CDP session,
    // which cleanly terminates the MV3 service worker as Chrome does after idle timeout).
    let swClosedEvent = false;
    sw1.on("close", () => {
      swClosedEvent = true;
    });
    const extPage = await context.newPage();
    const extCdp = await context.newCDPSession(extPage);
    const extVersions = [];
    extCdp.on("ServiceWorker.workerVersionUpdated", (evt) => {
      for (const v of evt.versions ?? []) {
        if (v.scriptURL === swUrl && v.runningStatus === "running") extVersions.push(v);
      }
    });
    await extCdp.send("ServiceWorker.enable");
    await extPage.goto(`${extOrigin}/manifest.json`);
    await delay(300);
    const runningVer = extVersions.at(-1);
    if (!runningVer) throw new Error("Running extension service worker version not observed");
    await extCdp.send("ServiceWorker.stopWorker", { versionId: runningVer.versionId });
    await extCdp.detach().catch(() => {});
    await extPage.close();
    await delay(500);

    const workersAfterStop = context.serviceWorkers().filter((w) => w.url() === swUrl).length;
    const { targetInfos: targetsAfterStop } = await browserCdp.send("Target.getTargets");
    const targetsRunningAfterStop = targetsAfterStop.filter(
      (t) => t.type === "service_worker" && t.url === swUrl,
    ).length;

    // Now wake the stopped service worker via chrome.tabs.onCreated (no extension page needed)!
    let wakeMethod = "chrome.tabs.onCreated";
    const triggerPage = await context.newPage();
    await triggerPage.close();
    let sw2 = null;
    try {
      sw2 = await getHelperWorker(context, 4_000);
    } catch {
      wakeMethod = "extension-page-wake";
      const wakePage = await context.newPage();
      await wakePage.goto(`${extOrigin}/manifest.json`);
      sw2 = await getHelperWorker(context, 4_000);
      await wakePage.close();
    }
    const ping2 = await sw2.evaluate(() => globalThis.__opensteer.ping());
    const inv2 = await sw2.evaluate(() => globalThis.__opensteer.inventory());

    await browserCdp.detach().catch(() => {});
    return {
      loaded: true,
      swUrl,
      ping1,
      initialTabCount: inv1.length,
      stoppedMethod: "ServiceWorker.stopWorker",
      swClosedEvent,
      workersAfterStop,
      targetsRunningAfterStop,
      wakeMethod,
      restarted: sw2 !== null && sw2 !== sw1,
      ping2,
      inv2Count: inv2.length,
    };
  } finally {
    await context.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGate2DiscardWake(server, extDir, { webContentsDiscard }) {
  const dir = await mkdtemp(path.join(tmpdir(), `os-gate2-${webContentsDiscard ? "wcd-" : "def-"}`));
  removedDirs.push(dir);
  await mkdir(path.join(dir, "Default"), { recursive: true });
  await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: chromium.executablePath(),
    ignoreDefaultArgs: true,
    args: nativeArgs(dir, extDir, { webContentsDiscard }),
    headless: true,
    chromiumSandbox: false,
    acceptDownloads: false,
    viewport: null,
    timeout: 20_000,
  });
  try {
    const rootPid = context.process().pid;
    const sw = await getHelperWorker(context);
    const baselineRenderers = countDescendantRenderers(rootPid);

    // Keep an active anchor tab so the target tab can be backgrounded & discarded.
    const anchor = context.pages()[0] ?? (await context.newPage());
    const targetPage = await context.newPage();
    const url = server.urlFor(1, webContentsDiscard ? "wcd" : "default");
    await targetPage.goto(url, { waitUntil: "load" });
    await targetPage.evaluate(() => {
      document.getElementById("field").focus();
    });
    const pageCdp = await context.newCDPSession(targetPage);
    await pageCdp.send("Input.insertText", { text: "Gate2 typed draft" });
    await targetPage.evaluate(() => {
      document.activeElement.blur();
      window.scrollTo(0, 2400);
    });
    const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
    const targetIdBefore = targetInfo.targetId;

    // Activate anchor so targetPage is in background
    await anchor.bringToFront();
    await delay(300);
    const liveRenderers = countDescendantRenderers(rootPid);

    // Freeze via pageCdp to flush PageState, then detach our custom CDP session (Playwright's internal CRPage session stays!)
    await pageCdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await pageCdp.detach();

    const invBefore = await sw.evaluate(() => globalThis.__opensteer.inventory());
    const tabBefore = invBefore.find((t) => t.targetId === targetIdBefore);

    const events = [];
    targetPage.on("close", () => events.push("targetPage.close"));
    targetPage.on("crash", () => events.push("targetPage.crash"));
    const newPages = [];
    context.on("page", (p) => {
      events.push(`context.page:${p.url()}`);
      newPages.push(p);
    });

    const discardRes = await sw.evaluate((id) => globalThis.__opensteer.discardByTabId(id), tabBefore.tabId);
    await delay(1000);

    const discardedRenderers = countDescendantRenderers(rootPid);
    const invAfterDiscard = await sw.evaluate(() => globalThis.__opensteer.inventory());
    const tabAfterDiscard = invAfterDiscard.find((t) => t.tabId === discardRes.newTabId);
    const oldPageClosedAfterDiscard = targetPage.isClosed();
    const contextPagesCountAfterDiscard = context.pages().length;

    // Now test waking the discarded tab!
    const t0 = performance.now();
    const wakeRes = await sw.evaluate((id) => globalThis.__opensteer.activateByTabId(id), discardRes.newTabId);
    await delay(500);

    const invAfterWake = await sw.evaluate(() => globalThis.__opensteer.inventory());
    const tabAfterWake = invAfterWake.find((t) => t.tabId === discardRes.newTabId);

    // Pick whichever Playwright Page object corresponds to the woken tab
    const activePlaywrightPage = newPages.at(-1) ?? (targetPage.isClosed() ? null : targetPage);
    let pageUsableAfterWake = false;
    let evalResult = null;
    let newCdpWorks = false;
    let screenshotWorks = false;
    let usabilityError = null;
    if (activePlaywrightPage) {
      try {
        await activePlaywrightPage.waitForLoadState("load", { timeout: 5_000 });
        await delay(150);
        evalResult = await activePlaywrightPage.evaluate(() => ({
          url: location.href,
          scrollY: window.scrollY,
          field: document.getElementById("field")?.value ?? null,
        }));
        const postCdp = await context.newCDPSession(activePlaywrightPage);
        const info2 = await postCdp.send("Target.getTargetInfo");
        newCdpWorks = Boolean(info2?.targetInfo?.targetId);
        const shot = await postCdp.send("Page.captureScreenshot", { format: "png" });
        screenshotWorks = typeof shot?.data === "string" && shot.data.length > 100;
        await postCdp.detach();
        pageUsableAfterWake = true;
      } catch (e) {
        usabilityError = e.message;
      }
    }
    const wakeMs = Math.round(performance.now() - t0);

    return {
      webContentsDiscard,
      tabIdBefore: tabBefore.tabId,
      tabIdAfterDiscard: discardRes.newTabId,
      tabIdPreserved: tabBefore.tabId === discardRes.newTabId,
      targetIdBefore,
      targetIdAfterDiscard: tabAfterDiscard?.targetId ?? null,
      targetIdPreserved: targetIdBefore === tabAfterDiscard?.targetId,
      discardRes,
      eventsDuringDiscard: [...events],
      oldPageClosedAfterDiscard,
      newPagesCreatedCount: newPages.length,
      contextPagesCountAfterDiscard,
      baselineRenderers,
      liveRenderers,
      discardedRenderers,
      wakeRes,
      tabStatusAfterWake: tabAfterWake?.status ?? null,
      tabDiscardedAfterWake: tabAfterWake?.discarded ?? null,
      wakeMs,
      pageUsableAfterWake,
      newCdpWorks,
      screenshotWorks,
      evalResult,
      usabilityError,
    };
  } finally {
    await context.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGate3SeventyRestoredTabs(server, extDir, { webContentsDiscard }) {
  const TOTAL = 70;
  const BATCH = 10;
  const dir = await mkdtemp(path.join(tmpdir(), `os-gate3-70-${webContentsDiscard ? "wcd-" : "def-"}`));
  removedDirs.push(dir);
  await mkdir(path.join(dir, "Default"), { recursive: true });
  await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));

  // Phase 1: create 70 distinct-origin tabs, freeze + discard in waves of 10, close cleanly.
  const ctx1 = await chromium.launchPersistentContext(dir, {
    executablePath: chromium.executablePath(),
    ignoreDefaultArgs: true,
    args: nativeArgs(dir, extDir, { webContentsDiscard }),
    headless: true,
    chromiumSandbox: false,
    acceptDownloads: false,
    viewport: null,
    timeout: 30_000,
  });
  try {
    const sw1 = await getHelperWorker(ctx1);
    const anchor = ctx1.pages()[0] ?? (await ctx1.newPage());
    for (let start = 1; start <= TOTAL; start += BATCH) {
      const batchTabIds = [];
      for (let i = start; i < start + BATCH && i <= TOTAL; i++) {
        const page = await ctx1.newPage();
        await page.goto(server.urlFor(i, `tab-${i}`), { waitUntil: "load" });
        await page.evaluate(() => {
          document.getElementById("field").focus();
        });
        const cdp = await ctx1.newCDPSession(page);
        await cdp.send("Input.insertText", { text: `draft-${i}` });
        await page.evaluate((idx) => {
          document.activeElement.blur();
          window.scrollTo(0, 500 + idx * 20);
        }, i);
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        await anchor.bringToFront();
        await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
        await cdp.detach();
        const inv = await sw1.evaluate(() => globalThis.__opensteer.inventory());
        const match = inv.find((t) => t.targetId === targetInfo.targetId);
        if (match) batchTabIds.push(match.tabId);
      }
      for (const tabId of batchTabIds) {
        await sw1.evaluate((id) => globalThis.__opensteer.discardByTabId(id), tabId);
      }
    }
    await anchor.close();
    await delay(1000);
  } finally {
    await ctx1.close().catch(() => {});
  }

  // Phase 2: cold restart through Playwright's launchPersistentContext with 70 restored tabs!
  server.clearRequests();
  const tLaunch = performance.now();
  let ctx2;
  let launchError = null;
  try {
    ctx2 = await chromium.launchPersistentContext(dir, {
      executablePath: chromium.executablePath(),
      ignoreDefaultArgs: true,
      args: nativeArgs(dir, extDir, { webContentsDiscard }),
      headless: true,
      chromiumSandbox: false,
      acceptDownloads: false,
      viewport: null,
      timeout: 25_000,
    });
    const launchMs = Math.round(performance.now() - tLaunch);
    const rootPid = ctx2.process().pid;
    const sw2 = await getHelperWorker(ctx2);
    await delay(3000);
    const inv2 = await sw2.evaluate(() => globalThis.__opensteer.inventory());
    const renderersAfter3s = countDescendantRenderers(rootPid);
    const unloadedCount = inv2.filter((t) => t.status === "unloaded" || t.discarded).length;
    const loadedRequests = server.requests.filter((r) => r.path.startsWith("/form-scroll"));
    const playwrightPagesCount = ctx2.pages().length;

    // Pick an unloaded tab and try waking it
    const unloaded = inv2.find((t) => t.status === "unloaded" || t.discarded) ?? inv2[inv2.length - 1];
    let wokeCheck = null;
    if (unloaded) {
      const tWake = performance.now();
      await sw2.evaluate((id) => globalThis.__opensteer.activateByTabId(id), unloaded.tabId);
      await delay(600);
      // Find its Playwright Page by matching URL or targetId
      const matchingPage = ctx2.pages().find((p) => p.url() === unloaded.url);
      if (matchingPage) {
        await matchingPage.waitForLoadState("load", { timeout: 5_000 });
        await delay(150);
        const state = await matchingPage.evaluate(() => ({
          url: location.href,
          scrollY: window.scrollY,
          field: document.getElementById("field")?.value ?? null,
        }));
        wokeCheck = {
          index: unloaded.index,
          tabId: unloaded.tabId,
          wakeMs: Math.round(performance.now() - tWake),
          ...state,
        };
      } else {
        wokeCheck = { index: unloaded.index, tabId: unloaded.tabId, error: "no-matching-playwright-page" };
      }
    }

    return {
      webContentsDiscard,
      launchSucceeded: true,
      launchMs,
      playwrightPagesCount,
      inventoryCount: inv2.length,
      unloadedCount,
      eagerServerRequestCount: loadedRequests.length,
      renderersAfter3s,
      wokeCheck,
    };
  } catch (e) {
    launchError = e.message;
    return {
      webContentsDiscard,
      launchSucceeded: false,
      elapsedMs: Math.round(performance.now() - tLaunch),
      launchError,
      eagerServerRequestCount: server.requests.filter((r) => r.path.startsWith("/form-scroll")).length,
    };
  } finally {
    await ctx2?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const server = await startFixtureServer();
  const extDir = await createHelperExtension();
  removedDirs.push(extDir);
  try {
    const report = {};
    console.log("=== Gate 1: Helper extension lifecycle through launchPersistentContext ===");
    report.gate1 = await runGate1ExtensionLifecycle(extDir);
    console.log(JSON.stringify(report.gate1, null, 2));

    console.log("\n=== Gate 2A: Discard & wake through Playwright (default mode, NO WebContentsDiscard) ===");
    report.gate2Default = await runGate2DiscardWake(server, extDir, { webContentsDiscard: false });
    console.log(JSON.stringify(report.gate2Default, null, 2));

    console.log("\n=== Gate 2B: Discard & wake through Playwright (WebContentsDiscard enabled) ===");
    report.gate2Wcd = await runGate2DiscardWake(server, extDir, { webContentsDiscard: true });
    console.log(JSON.stringify(report.gate2Wcd, null, 2));

    console.log("\n=== Gate 3A: 70 restored unloaded tabs through launchPersistentContext (default mode) ===");
    report.gate3Default = await runGate3SeventyRestoredTabs(server, extDir, { webContentsDiscard: false });
    console.log(JSON.stringify(report.gate3Default, null, 2));

    console.log("\n=== Gate 3B: 70 restored unloaded tabs through launchPersistentContext (WebContentsDiscard) ===");
    report.gate3Wcd = await runGate3SeventyRestoredTabs(server, extDir, { webContentsDiscard: true });
    console.log(JSON.stringify(report.gate3Wcd, null, 2));

    await writeFile(
      path.join(path.dirname(new URL(import.meta.url).pathname), "step2-gate-results.json"),
      JSON.stringify({ ...report, removedDirs }, null, 2) + "\n",
    );
  } finally {
    await rm(extDir, { recursive: true, force: true });
    await server.close();
    console.log("\nRemoved temp dirs:", removedDirs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
