import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createTempProfileDir,
  launchChromium,
  removeTempProfileDir,
} from "./lib/cdp-browser.mjs";
import { startFixtureServer } from "./lib/fixture-server.mjs";

const removedDirs = [];

async function writeHelperExtension(extDir) {
  await mkdir(extDir, { recursive: true });
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
globalThis.__opensteer = {
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
        discarded: t.discarded,
        status: t.status || "",
        targetId: targetByTabId.get(t.id)?.targetId ?? null,
        attached: targetByTabId.get(t.id)?.attached ?? false,
      }));
  },
  async discardByTargetId(targetId) {
    const targets = await chrome.debugger.getTargets();
    const match = targets.find((t) => t.id === targetId && typeof t.tabId === "number");
    if (!match) return { ok: false, reason: "target-not-found" };
    const updated = await chrome.tabs.discard(match.tabId);
    return {
      ok: Boolean(updated?.discarded),
      oldTabId: match.tabId,
      newTabId: updated?.id ?? null,
      discarded: updated?.discarded ?? false,
    };
  },
};
`,
  );
}

async function attachExtensionWorker(browser, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const sw = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.endsWith("/sw.js"),
    );
    if (sw) {
      const sid = await browser.attach(sw.targetId);
      // Wait for sw.js top-level script to finish registering globalThis.__opensteer.
      while (Date.now() < deadline) {
        const ready = await browser
          .evalInSession(sid, "typeof globalThis.__opensteer === 'object'")
          .catch(() => false);
        if (ready) break;
        await delay(50);
      }
      return {
        targetId: sw.targetId,
        sid,
        inventory: () =>
          browser.evalInSession(sid, "globalThis.__opensteer.inventory()", { awaitPromise: true }),
        discardByTargetId: (targetId) =>
          browser.evalInSession(
            sid,
            `globalThis.__opensteer.discardByTargetId(${JSON.stringify(targetId)})`,
            { awaitPromise: true },
          ),
        detach: () => browser.detach(sid),
      };
    }
    await delay(100);
  }
  throw new Error("Extension service worker never appeared");
}

/** Reset Chromium's unclean-exit marker so --restore-last-session auto-restores after SIGKILL/OOM. */
async function normalizeCrashExitType(userDataDir) {
  const prefPath = path.join(userDataDir, "Default", "Preferences");
  const raw = await readFile(prefPath, "utf8");
  const prefs = JSON.parse(raw);
  const previous = {
    exit_type: prefs.profile?.exit_type,
    exited_cleanly: prefs.profile?.exited_cleanly,
  };
  prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
  await writeFile(prefPath, JSON.stringify(prefs));
  return previous;
}

async function main() {
  const server = await startFixtureServer();
  const dir = await createTempProfileDir("exp-hybrid-ext-");
  const extDir = await createTempProfileDir("exp-ext-src-");
  try {
    await writeHelperExtension(extDir);
    await mkdir(path.join(dir, "Default"), { recursive: true });
    await writeFile(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 1 } }),
    );

    const launchOpts = {
      userDataDir: dir,
      noStartupWindow: false,
      restoreLastSession: true,
      disableFieldTrialConfig: true,
      disableExtensions: false,
      extraArgs: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        "--enable-features=WebContentsDiscard",
      ],
    };

    const report = {};

    // Phase 1: Open 6 tabs including TWO duplicate URLs, test discard while CDP attached vs detached,
    // close 1 tab, verify renderer termination and exact order.
    const b1 = await launchChromium(launchOpts);
    let expectedTabs = [];
    try {
      const sw1 = await attachExtensionWorker(b1);
      const initialInv = await sw1.inventory();

      // Open 6 tabs: 2 with IDENTICAL URL (/article), plus form, spa, sessionStorage, and a tab we will close!
      const specs = [
        { surfaceId: "surf_dup_A", url: `${server.originForSite(1)}/article`, scrollY: 1100 },
        { surfaceId: "surf_dup_B", url: `${server.originForSite(1)}/article`, scrollY: 2900 },
        { surfaceId: "surf_form", url: `${server.originForSite(2)}/form`, fill: "Hybrid draft" },
        { surfaceId: "surf_closed", url: `${server.originForSite(3)}/article`, closeMe: true },
        { surfaceId: "surf_spa", url: `${server.originForSite(4)}/spa`, pushSpa: true },
        { surfaceId: "surf_ss", url: `${server.originForSite(5)}/session-storage`, ss: "kept-ss" },
      ];

      for (const spec of specs) {
        const { targetId } = await b1.send("Target.createTarget", { url: "about:blank" });
        const sid = await b1.attach(targetId);
        await b1.navigateAndWait(sid, spec.url);
        if (spec.scrollY) {
          await b1.evalInSession(sid, `window.scrollTo(0, ${spec.scrollY})`);
        }
        if (spec.fill) {
          await b1.evalInSession(sid, "document.getElementById('text-input').focus()");
          await b1.send("Input.insertText", { text: spec.fill }, sid);
          await b1.evalInSession(sid, "document.activeElement.blur()");
        }
        if (spec.pushSpa) {
          await b1.evalInSession(
            sid,
            `history.pushState({step:1},"","/spa/step-1"); history.pushState({step:2},"","/spa/step-2");`,
          );
          spec.finalUrl = `${server.originForSite(4)}/spa/step-2`;
        } else {
          spec.finalUrl = spec.url;
        }
        if (spec.ss) {
          await b1.evalInSession(sid, `sessionStorage.setItem("wizard_step", ${JSON.stringify(spec.ss)})`);
        }
        spec.targetId = targetId;
        await b1.detach(sid);
      }

      // Close initial NTP tab and surf_closed tab
      for (const init of initialInv) {
        if (init.targetId) await b1.send("Target.closeTarget", { targetId: init.targetId }).catch(() => {});
      }
      const closedSpec = specs.find((s) => s.closeMe);
      await b1.send("Target.closeTarget", { targetId: closedSpec.targetId });
      expectedTabs = specs.filter((s) => !s.closeMe);

      // Keep surf_dup_A active. First test what happens when discarding a tab while CDP IS attached
      // (using a throwaway tab so it doesn't distort surf_dup_B's freeze-before-discard check).
      await b1.send("Target.activateTarget", { targetId: expectedTabs[0].targetId });
      await delay(300);
      const liveRenderers = (await b1.send("SystemInfo.getProcessInfo")).processInfo.filter(
        (p) => p.type === "renderer",
      ).length;

      const { targetId: probeTargetId } = await b1.send("Target.createTarget", {
        url: `${server.originForSite(6)}/article`,
        background: true,
      });
      await delay(300);
      const attachedSid = await b1.attach(probeTargetId);
      let detachedEventSeen = false;
      const offDetach = b1.onEvent((method, params) => {
        if (method === "Target.detachedFromTarget" && params.sessionId === attachedSid) {
          detachedEventSeen = true;
        }
      });
      const discardWhileAttached = await sw1.discardByTargetId(probeTargetId);
      await delay(400);
      offDetach();
      let evalAfterDiscardErr = null;
      try {
        await b1.evalInSession(attachedSid, "1+1");
      } catch (e) {
        evalAfterDiscardErr = e.message;
      }
      await b1.detach(attachedSid);
      await b1.send("Target.closeTarget", { targetId: probeTargetId }).catch(() => {});

      // Now sleep all background expectedTabs (surf_dup_B, surf_form, surf_spa, surf_ss):
      // 1) Freeze via Page.setWebLifecycleState("frozen") to synchronously flush Blink PageState
      //    (RenderFrameImpl::SendUpdateState) before fast-kill;
      // 2) Detach CDP session;
      // 3) Discard via chrome.tabs.discard.
      const discardResults = {};
      for (const tab of expectedTabs.slice(1)) {
        const sid = await b1.attach(tab.targetId);
        await b1.send("Page.setWebLifecycleState", { state: "frozen" }, sid);
        await b1.detach(sid);
        discardResults[tab.surfaceId] = await sw1.discardByTargetId(tab.targetId);
      }
      await delay(1000);
      const afterDiscardRenderers = (await b1.send("SystemInfo.getProcessInfo")).processInfo.filter(
        (p) => p.type === "renderer",
      ).length;
      const invBeforeExit = await sw1.inventory();

      report.phase1LiveAndDiscard = {
        liveRenderers,
        afterDiscardRenderers,
        discardWhileAttached,
        detachedEventSeen,
        evalAfterDiscardErr,
        discardResults,
        inventoryBeforeExit: invBeforeExit.map((t) => ({
          index: t.index,
          url: t.url,
          discarded: t.discarded,
          targetId: t.targetId,
        })),
        allTargetIdsPreserved: expectedTabs.every((e) =>
          invBeforeExit.some((t) => t.targetId === e.targetId),
        ),
      };

      // Wait >2.5s so SessionService writes Session_* to disk before we SIGKILL!
      await delay(3000);
      await sw1.detach();
    } finally {
      // Simulate hard crash (SIGKILL) while 4 of 5 tabs are DISCARDED!
      await b1.forceKill();
    }

    // Phase 2: Normalize exit_type after SIGKILL, relaunch with --restore-last-session
    const previousExitPrefs = await normalizeCrashExitType(dir);
    server.clearRequests();
    const b2 = await launchChromium(launchOpts);
    try {
      const sw2 = await attachExtensionWorker(b2);
      await delay(1500);
      const invAfterCrash = await sw2.inventory();
      const eagerRequests = server.requests
        .filter((r) => !r.path.includes("favicon"))
        .map((r) => `${r.host}${r.path}`);

      // Match by exact TabStrip index WITHOUT waking any background tab!
      const indexOrderMatches =
        invAfterCrash.length === expectedTabs.length &&
        invAfterCrash.every((t, i) => t.index === i && t.url === expectedTabs[i].finalUrl);

      // Now wake the TWO duplicate-URL tabs and verify EACH kept its OWN distinct scroll position (1100 vs 2900)!
      const verified = {};
      for (let i = 0; i < expectedTabs.length; i++) {
        const spec = expectedTabs[i];
        const restored = invAfterCrash[i];
        await b2.send("Target.activateTarget", { targetId: restored.targetId });
        const sid = await b2.attach(restored.targetId);
        await b2.send("Page.enable", {}, sid);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const ready = await b2
            .evalInSession(sid, "document.readyState === 'complete' && location.href !== 'about:blank'")
            .catch(() => false);
          if (ready) break;
          await delay(30);
        }
        await delay(200);
        if (spec.scrollY) {
          verified[spec.surfaceId] = {
            expectedScrollY: spec.scrollY,
            actualScrollY: await b2.evalInSession(sid, "window.scrollY"),
          };
        } else if (spec.fill) {
          verified[spec.surfaceId] = {
            expectedFill: spec.fill,
            actualFill: await b2.evalInSession(sid, "document.getElementById('text-input')?.value"),
          };
        } else if (spec.pushSpa) {
          const hist = await b2.send("Page.getNavigationHistory", {}, sid);
          verified[spec.surfaceId] = {
            pathname: await b2.evalInSession(sid, "location.pathname"),
            state: await b2.evalInSession(sid, "history.state"),
            historyCount: hist.entries.length,
          };
        } else if (spec.ss) {
          verified[spec.surfaceId] = {
            expectedSs: spec.ss,
            actualSs: await b2.evalInSession(sid, "sessionStorage.getItem('wizard_step')"),
          };
        }
        await b2.detach(sid);
      }

      report.phase2CrashRestart = {
        previousExitPrefs,
        restoredCount: invAfterCrash.length,
        expectedCount: expectedTabs.length,
        indexOrderMatches,
        eagerRequestsBeforeActivate: eagerRequests,
        inventoryAfterCrash: invAfterCrash.map((t) => ({
          index: t.index,
          url: t.url,
          status: t.status,
          targetId: t.targetId,
        })),
        verified,
      };
      await sw2.detach();
    } finally {
      await b2.gracefulClose();
    }

    console.log(JSON.stringify(report, null, 2));
    await writeFile(
      path.join(path.dirname(new URL(import.meta.url).pathname), "hybrid-extension-results.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  } finally {
    await removeTempProfileDir(dir);
    await removeTempProfileDir(extDir);
    removedDirs.push(dir, extDir);
    await server.close();
    console.log("Removed temp dirs:", removedDirs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
