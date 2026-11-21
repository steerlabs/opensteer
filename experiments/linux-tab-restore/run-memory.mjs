import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createTempProfileDir,
  launchChromium,
  removeTempProfileDir,
} from "./lib/cdp-browser.mjs";
import { startFixtureServer } from "./lib/fixture-server.mjs";

const removedDirs = [];

async function withProfile(prefix, fn) {
  const dir = await createTempProfileDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await removeTempProfileDir(dir);
    removedDirs.push(dir);
  }
}

async function waitForLoad(browser, sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await browser.evalInSession(
        sessionId,
        "document.readyState === 'complete' && location.href !== 'about:blank'",
      );
      if (ready) return;
    } catch {
      // Navigating or initializing.
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for page readyState=complete");
}

async function openDiscardsHelper(browser) {
  const { targetId } = await browser.send("Target.createTarget", {
    url: "chrome://discards",
    background: true,
  });
  const sessionId = await browser.attach(targetId);
  await browser.send("Page.enable", {}, sessionId);
  await waitForLoad(browser, sessionId);
  await browser.evalInSession(
    sessionId,
    `(async () => {
      const m = await import('/discards.js');
      window.__dp = m.getOrCreateDetailsProvider();
      return true;
    })()`,
    { awaitPromise: true },
  );
  return {
    targetId,
    sessionId,
    async getInfos() {
      return await browser.evalInSession(
        sessionId,
        `(async () => {
          const { infos } = await window.__dp.getTabDiscardsInfo();
          return infos.map(i => ({ id: i.id, tabUrl: i.tabUrl, state: i.state }));
        })()`,
        { awaitPromise: true },
      );
    },
    async discardById(id, reason = 0) {
      return await browser.evalInSession(
        sessionId,
        `(async () => { await window.__dp.discardById(${id}, ${reason}); return true; })()`,
        { awaitPromise: true },
      );
    },
    async close() {
      await browser.detach(sessionId);
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

async function measurePrivateFootprint(browser) {
  const { targetId } = await browser.send("Target.createTarget", {
    url: "chrome://discards/graph",
    background: true,
  });
  const sid = await browser.attach(targetId);
  try {
    await browser.send("Page.enable", {}, sid);
    await waitForLoad(browser, sid);
    const dump = await browser.evalInSession(
      sid,
      `(async () => {
        const m = await import("/discards.mojom-webui.js");
        const remote = m.GraphDump.getRemote();
        const cb = new m.GraphChangeStreamCallbackRouter();
        const procs = new Map();
        cb.processCreated.addListener(p => procs.set(String(p.id), p));
        cb.processChanged.addListener(p => procs.set(String(p.id), p));
        await remote.subscribeToChanges(cb.$.bindNewPipeAndPassRemote());
        await new Promise(r => setTimeout(r, 600));
        return [...procs.values()].map(p => {
          const d = JSON.parse(p.descriptionJson || "{}");
          return {
            pid: p.pid?.pid ?? 0,
            type: d.ProcessNodeImpl?.process_type ?? "unknown",
            privKb: Number(p.privateFootprintKb || 0),
          };
        });
      })()`,
      { awaitPromise: true },
    );
    let totalKb = 0;
    let browserKb = 0;
    let rendererKb = 0;
    let rendererCount = 0;
    for (const p of dump) {
      totalKb += p.privKb;
      if (p.type === "Browser") browserKb += p.privKb;
      else if (p.type === "Renderer") {
        rendererKb += p.privKb;
        rendererCount += 1;
      }
    }
    return {
      totalMb: Math.round((totalKb / 1024) * 100) / 100,
      browserMb: Math.round((browserKb / 1024) * 100) / 100,
      rendererMb: Math.round((rendererKb / 1024) * 100) / 100,
      rendererCount,
    };
  } finally {
    await browser.detach(sid);
    await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

function summarizeMs(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values.map((v) => Math.round(v * 10) / 10),
    minMs: Math.round(sorted[0] * 10) / 10,
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
  };
}

/** 10-tab comparison: live vs frozen (Option D) vs discarded (Option C, default & WCD) vs closed (Option A/baseline). */
async function runTenTabComparison(server, { enableWebContentsDiscard }) {
  const N = 10;
  return await withProfile(
    `exp-mem10-${enableWebContentsDiscard ? "wcd-" : "def-"}`,
    async (dir) => {
      await mkdir(path.join(dir, "Default"), { recursive: true });
      await writeFile(
        path.join(dir, "Local State"),
        JSON.stringify({ internal_only_uis_enabled: true }),
      );
      await writeFile(
        path.join(dir, "Default", "Preferences"),
        JSON.stringify({ session: { restore_on_startup: 1 } }),
      );
      const browser = await launchChromium({
        userDataDir: dir,
        noStartupWindow: false,
        restoreLastSession: true,
        extraArgs: enableWebContentsDiscard ? ["--enable-features=WebContentsDiscard"] : [],
      });
      try {
        await delay(500);
        const helper = await openDiscardsHelper(browser);
        await browser.send("Target.activateTarget", { targetId: helper.targetId });
        await delay(500);
        const baselineMem = browser.measureProcessTreeMemory();
        const baselinePriv = await measurePrivateFootprint(browser);

        const tabs = [];
        for (let i = 1; i <= N; i++) {
          const url = `${server.originForSite(i)}/heavy?mb=4&label=tab-${i}`;
          const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
          const sid = await browser.attach(targetId);
          await browser.navigateAndWait(sid, url);
          await browser.evalInSession(
            sid,
            `window.scrollTo(0, 1200); document.getElementById('field').value = 'draft-${i}';`,
          );
          await browser.detach(sid);
          tabs.push({ i, url, targetId });
        }
        await browser.send("Target.activateTarget", { targetId: helper.targetId });
        await delay(1000);
        const liveMem = browser.measureProcessTreeMemory();
        const livePriv = await measurePrivateFootprint(browser);

        // Option D: freeze all 10 tabs
        for (const tab of tabs) {
          const sid = await browser.attach(tab.targetId);
          await browser.send("Page.setWebLifecycleState", { state: "frozen" }, sid);
          await browser.detach(sid);
        }
        await delay(1000);
        const frozenMem = browser.measureProcessTreeMemory();
        const frozenPriv = await measurePrivateFootprint(browser);

        const freezeWakeTimes = [];
        for (let i = 0; i < 5; i++) {
          const tab = tabs[i];
          const sid = await browser.attach(tab.targetId);
          const t0 = performance.now();
          await browser.send("Page.setWebLifecycleState", { state: "active" }, sid);
          await browser.evalInSession(sid, "1+1");
          freezeWakeTimes.push(performance.now() - t0);
          await browser.detach(sid);
        }
        // Unfreeze remaining tabs before discarding
        for (let i = 5; i < N; i++) {
          const sid = await browser.attach(tabs[i].targetId);
          await browser.send("Page.setWebLifecycleState", { state: "active" }, sid);
          await browser.detach(sid);
        }
        await browser.send("Target.activateTarget", { targetId: helper.targetId });
        await delay(300);

        // Option C: discard all 10 tabs via chrome://discards
        for (const tab of tabs) {
          const infos = await helper.getInfos();
          const entry = infos.find((inf) => inf.tabUrl === tab.url);
          if (entry) await helper.discardById(entry.id, 0);
        }
        await delay(2000);
        const discardedMem = browser.measureProcessTreeMemory();
        const discardedPriv = await measurePrivateFootprint(browser);

        // Refresh target IDs (in case WebContentsDiscard=false replaced them)
        const targetsAfterDiscard = (await browser.send("Target.getTargets")).targetInfos.filter(
          (t) => t.type === "page",
        );
        for (const tab of tabs) {
          const found = targetsAfterDiscard.find((t) => t.url === tab.url);
          tab.afterDiscardTargetId = found?.targetId ?? tab.targetId;
        }

        // Measure wake latency on 5 discarded tabs
        const discardWakeTimes = [];
        for (let i = 0; i < 5; i++) {
          const tab = tabs[i];
          const t0 = performance.now();
          await browser.send("Target.activateTarget", { targetId: tab.afterDiscardTargetId });
          const sid = await browser.attach(tab.afterDiscardTargetId);
          await browser.send("Page.enable", {}, sid);
          await waitForLoad(browser, sid);
          discardWakeTimes.push(performance.now() - t0);
          await browser.detach(sid);
        }

        // Close all 10 tabs to compare baseline-closed RSS and cold open+navigate wake time
        for (const tab of tabs) {
          await browser.send("Target.closeTarget", { targetId: tab.afterDiscardTargetId }).catch(() => {});
        }
        await delay(1500);
        const afterCloseMem = browser.measureProcessTreeMemory();

        // Measure Option A/Baseline cold wake time (createTarget + navigate)
        const coldNavWakeTimes = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
          const sid = await browser.attach(targetId);
          await browser.navigateAndWait(sid, tabs[i].url);
          coldNavWakeTimes.push(performance.now() - t0);
          await browser.detach(sid);
          await browser.send("Target.closeTarget", { targetId }).catch(() => {});
        }

        await helper.close();
        return {
          tabCount: N,
          enableWebContentsDiscard,
          baselineMb: {
            total: mb(baselineMem.totalRssBytes),
            browser: mb(baselineMem.browserRssBytes),
            renderer: mb(baselineMem.rendererRssBytes),
            renderers: baselineMem.rendererCount,
            privateFootprint: baselinePriv,
          },
          liveMb: {
            total: mb(liveMem.totalRssBytes),
            browser: mb(liveMem.browserRssBytes),
            renderer: mb(liveMem.rendererRssBytes),
            renderers: liveMem.rendererCount,
            marginalPerLiveTabMb: mb((liveMem.totalRssBytes - baselineMem.totalRssBytes) / N),
            privateFootprint: livePriv,
            marginalPrivatePerTabMb:
              Math.round(((livePriv.totalMb - baselinePriv.totalMb) / N) * 100) / 100,
          },
          frozenMb: {
            total: mb(frozenMem.totalRssBytes),
            browser: mb(frozenMem.browserRssBytes),
            renderer: mb(frozenMem.rendererRssBytes),
            renderers: frozenMem.rendererCount,
            marginalPerFrozenTabMb: mb((frozenMem.totalRssBytes - baselineMem.totalRssBytes) / N),
            privateFootprint: frozenPriv,
            marginalPrivatePerTabMb:
              Math.round(((frozenPriv.totalMb - baselinePriv.totalMb) / N) * 100) / 100,
          },
          discardedMb: {
            total: mb(discardedMem.totalRssBytes),
            browser: mb(discardedMem.browserRssBytes),
            renderer: mb(discardedMem.rendererRssBytes),
            renderers: discardedMem.rendererCount,
            marginalPerDiscardedTabMb: mb(
              (discardedMem.totalRssBytes - baselineMem.totalRssBytes) / N,
            ),
            privateFootprint: discardedPriv,
            marginalPrivatePerTabMb:
              Math.round(((discardedPriv.totalMb - baselinePriv.totalMb) / N) * 100) / 100,
          },
          afterCloseMb: {
            total: mb(afterCloseMem.totalRssBytes),
            browser: mb(afterCloseMem.browserRssBytes),
            renderer: mb(afterCloseMem.rendererRssBytes),
            renderers: afterCloseMem.rendererCount,
          },
          wakeLatency: {
            frozenActive: summarizeMs(freezeWakeTimes),
            discardedActivate: summarizeMs(discardWakeTimes),
            closedCreateAndNavigate: summarizeMs(coldNavWakeTimes),
          },
        };
      } finally {
        await browser.gracefulClose();
      }
    },
  );
}

/** 70-tab scale run: open 70 distinct-origin tabs (discarding in batches of 10), measure RSS, then cold-restart with --restore-last-session! */
async function runSeventyTabRun(server) {
  const TOTAL = 70;
  const BATCH = 10;
  return await withProfile("exp-mem70-", async (dir) => {
    await mkdir(path.join(dir, "Default"), { recursive: true });
    await writeFile(
      path.join(dir, "Local State"),
      JSON.stringify({ internal_only_uis_enabled: true }),
    );
    await writeFile(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 1 } }),
    );

    const extraArgs = ["--enable-features=WebContentsDiscard"];
    const browser1 = await launchChromium({
      userDataDir: dir,
      noStartupWindow: false,
      restoreLastSession: true,
      extraArgs,
    });
    const tabs = [];
    let baselineMem;
    let steady70DiscardedMem;
    let wake70Times = [];
    try {
      const initialTargets = (await browser1.send("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page",
      );
      const helper = await openDiscardsHelper(browser1);
      await browser1.send("Target.activateTarget", { targetId: helper.targetId });
      for (const t of initialTargets) {
        await browser1.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
      await delay(500);
      baselineMem = browser1.measureProcessTreeMemory();
      const baseline70Priv = await measurePrivateFootprint(browser1);

      for (let start = 1; start <= TOTAL; start += BATCH) {
        const batchTabs = [];
        for (let i = start; i < start + BATCH && i <= TOTAL; i++) {
          const url = `${server.originForSite(i)}/heavy?mb=4&label=tab-${i}`;
          const { targetId } = await browser1.send("Target.createTarget", { url: "about:blank" });
          const sid = await browser1.attach(targetId);
          await browser1.navigateAndWait(sid, url);
          await browser1.evalInSession(
            sid,
            `window.scrollTo(0, ${500 + i * 20}); document.getElementById('field').value = 'note-${i}';`,
          );
          await browser1.detach(sid);
          const rec = { i, url, targetId };
          batchTabs.push(rec);
          tabs.push(rec);
        }
        await browser1.send("Target.activateTarget", { targetId: helper.targetId });
        await delay(200);
        for (const tab of batchTabs) {
          const infos = await helper.getInfos();
          const entry = infos.find((inf) => inf.tabUrl === tab.url);
          if (entry) await helper.discardById(entry.id, 0);
        }
      }

      await delay(2500);
      steady70DiscardedMem = browser1.measureProcessTreeMemory();
      const steady70Priv = await measurePrivateFootprint(browser1);

      // Wake 5 spread-out tabs out of the 70 and verify scroll + form came back
      const sampleIndices = [0, 17, 34, 52, 69];
      const sampleVerified = [];
      for (const idx of sampleIndices) {
        const tab = tabs[idx];
        const t0 = performance.now();
        await browser1.send("Target.activateTarget", { targetId: tab.targetId });
        const sid = await browser1.attach(tab.targetId);
        await browser1.send("Page.enable", {}, sid);
        await waitForLoad(browser1, sid);
        const ms = performance.now() - t0;
        wake70Times.push(ms);
        await delay(100);
        const state = await browser1.evalInSession(
          sid,
          "({ scrollY: window.scrollY, field: document.getElementById('field')?.value })",
        );
        sampleVerified.push({ i: tab.i, wakeMs: Math.round(ms * 10) / 10, ...state });
        await browser1.detach(sid);
        // Re-discard so all 70 are discarded before browser restart
        await browser1.send("Target.activateTarget", { targetId: helper.targetId });
        const infos = await helper.getInfos();
        const entry = infos.find((inf) => inf.tabUrl === tab.url);
        if (entry) await helper.discardById(entry.id, 0);
      }

      await helper.close();
      await delay(1000);
      await browser1.gracefulClose();

      // Cold restart of all 70 tabs!
      server.clearRequests();
      const restartStart = performance.now();
      const browser2 = await launchChromium({
        userDataDir: dir,
        noStartupWindow: false,
        restoreLastSession: true,
        extraArgs,
      });
      try {
        const cdpReadyMs = performance.now() - restartStart;
        await delay(3000);
        const targets2 = (await browser2.send("Target.getTargets")).targetInfos.filter(
          (t) => t.type === "page",
        );
        const eagerRequests = server.requests.filter((r) => r.path.startsWith("/heavy"));
        const memAfter70Restart = browser2.measureProcessTreeMemory();
        const privAfter70Restart = await measurePrivateFootprint(browser2);

        // Check an unloaded tab (the last tab, which should NOT have been eagerly loaded)
        const loadedHosts = new Set(eagerRequests.map((r) => r.host));
        const unloadedCandidate =
          tabs.find((t) => !loadedHosts.has(new URL(t.url).host)) ?? tabs[tabs.length - 1];
        const restoredMatch = targets2.find((t) => t.url === unloadedCandidate.url);
        let unloadedWake = null;
        if (restoredMatch) {
          const t0 = performance.now();
          await browser2.send("Target.activateTarget", { targetId: restoredMatch.targetId });
          const sid = await browser2.attach(restoredMatch.targetId);
          await browser2.send("Page.enable", {}, sid);
          await waitForLoad(browser2, sid);
          const ms = performance.now() - t0;
          await delay(150);
          const state = await browser2.evalInSession(
            sid,
            "({ scrollY: window.scrollY, field: document.getElementById('field')?.value })",
          );
          unloadedWake = {
            i: unloadedCandidate.i,
            wasEagerlyLoadedBeforeActivate: loadedHosts.has(new URL(unloadedCandidate.url).host),
            wakeMs: Math.round(ms * 10) / 10,
            ...state,
          };
          await browser2.detach(sid);
        }

        return {
          totalTabs: TOTAL,
          baselineMb: {
            total: mb(baselineMem.totalRssBytes),
            browser: mb(baselineMem.browserRssBytes),
            renderer: mb(baselineMem.rendererRssBytes),
            renderers: baselineMem.rendererCount,
            privateFootprint: baseline70Priv,
          },
          steady70DiscardedMb: {
            total: mb(steady70DiscardedMem.totalRssBytes),
            browser: mb(steady70DiscardedMem.browserRssBytes),
            renderer: mb(steady70DiscardedMem.rendererRssBytes),
            renderers: steady70DiscardedMem.rendererCount,
            marginalPerDiscardedTabMb: mb(
              (steady70DiscardedMem.totalRssBytes - baselineMem.totalRssBytes) / TOTAL,
            ),
            privateFootprint: steady70Priv,
            marginalPrivatePerTabMb:
              Math.round(((steady70Priv.totalMb - baseline70Priv.totalMb) / TOTAL) * 100) / 100,
          },
          wake70FromDiscarded: {
            summary: summarizeMs(wake70Times),
            samples: sampleVerified,
          },
          coldRestart70: {
            cdpReadyMs: Math.round(cdpReadyMs * 10) / 10,
            restoredTargetCount: targets2.length,
            eagerlyLoadedTabCount: loadedHosts.size,
            deferredUnloadedTabCount: targets2.length - loadedHosts.size,
            memAfter3sMb: {
              total: mb(memAfter70Restart.totalRssBytes),
              browser: mb(memAfter70Restart.browserRssBytes),
              renderer: mb(memAfter70Restart.rendererRssBytes),
              renderers: memAfter70Restart.rendererCount,
              privateFootprint: privAfter70Restart,
            },
            unloadedTabWake: unloadedWake,
          },
        };
      } finally {
        await browser2.gracefulClose();
      }
    } finally {
      await browser1.gracefulClose().catch(() => {});
    }
  });
}

async function main() {
  const server = await startFixtureServer();
  try {
    console.log("Fixture server listening at", server.origin);
    const out = {};

    console.log("\n=== 10-tab memory & wake comparison (default discard) ===");
    out.tenTabsDefault = await runTenTabComparison(server, { enableWebContentsDiscard: false });
    console.log(JSON.stringify(out.tenTabsDefault, null, 2));

    console.log("\n=== 10-tab memory & wake comparison (WebContentsDiscard) ===");
    out.tenTabsWcd = await runTenTabComparison(server, { enableWebContentsDiscard: true });
    console.log(JSON.stringify(out.tenTabsWcd, null, 2));

    console.log("\n=== 70-tab discarded + cold restart benchmark ===");
    out.seventyTabs = await runSeventyTabRun(server);
    console.log(JSON.stringify(out.seventyTabs, null, 2));

    out.removedProfileDirs = removedDirs;
    await writeFile(
      path.join(path.dirname(new URL(import.meta.url).pathname), "memory-results.json"),
      JSON.stringify(out, null, 2) + "\n",
    );
    console.log("\nWrote memory-results.json successfully!");
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
