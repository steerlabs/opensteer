import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTempProfileDir, launchChromium, removeTempProfileDir } from "./lib/cdp-browser.mjs";
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
      // Page may still be initializing or navigating.
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for page readyState=complete");
}

/** Populate each of the 7 required page types with realistic user-like state. */
async function populatePage(browser, sessionId, origin, kind) {
  await browser.send("Page.enable", {}, sessionId);
  if (kind === "article") {
    await browser.navigateAndWait(sessionId, `${origin}/article`);
    await browser.evalInSession(sessionId, "window.scrollTo(0, 3200); window.scrollY");
    // Give Chromium a moment to update scroll state.
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "form") {
    await browser.navigateAndWait(sessionId, `${origin}/form`);
    // Use real CDP input + user-like events so Chromium marks form dirty and updates PageState.
    await browser.evalInSession(
      sessionId,
      `(() => {
        const t = document.getElementById('text-input');
        t.focus();
      })()`,
    );
    await browser.send("Input.insertText", { text: "Quarterly review" }, sessionId);
    await browser.evalInSession(
      sessionId,
      `(() => {
        const ta = document.getElementById('notes');
        ta.focus();
      })()`,
    );
    await browser.send("Input.insertText", { text: "Line one\\nLine two" }, sessionId);
    await browser.evalInSession(
      sessionId,
      `(() => {
        const s = document.getElementById('priority');
        s.value = 'high';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
        const c = document.getElementById('agree');
        c.click();
        const p = document.getElementById('secret');
        p.focus();
      })()`,
    );
    await browser.send("Input.insertText", { text: "s3cr3t-pass" }, sessionId);
    await browser.evalInSession(
      sessionId,
      `(() => {
        const ed = document.getElementById('editor');
        ed.focus();
        document.execCommand('selectAll');
      })()`,
    );
    await browser.send("Input.insertText", { text: "Edited rich note" }, sessionId);
    await browser.evalInSession(sessionId, "document.activeElement?.blur()");
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "spa") {
    await browser.navigateAndWait(sessionId, `${origin}/spa`);
    await browser.evalInSession(
      sessionId,
      `(() => {
        history.pushState({ step: 1 }, "", "/spa/step-1");
        history.pushState({ step: 2 }, "", "/spa/step-2");
        history.pushState({ step: 3 }, "", "/spa/step-3");
        document.getElementById("view").textContent = location.pathname + " " + JSON.stringify(history.state);
      })()`,
    );
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "sessionStorage") {
    await browser.navigateAndWait(sessionId, `${origin}/session-storage`);
    await browser.evalInSession(
      sessionId,
      `(() => {
        sessionStorage.setItem("wizard_step", "step-4-confirmed");
        sessionStorage.setItem("cart_count", "3");
        document.getElementById("out").textContent = sessionStorage.getItem("wizard_step");
      })()`,
    );
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "post") {
    await browser.navigateAndWait(sessionId, `${origin}/post-form`);
    const loaded = browser.waitForEvent(
      (method, _params, sid) => sid === sessionId && method === "Page.loadEventFired",
    );
    await browser.evalInSession(
      sessionId,
      "setTimeout(() => document.getElementById('go').click(), 0); true",
    );
    await loaded;
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "beforeunload") {
    await browser.navigateAndWait(sessionId, `${origin}/beforeunload`);
    // Need a user gesture for beforeunload to be honored by Chrome.
    const box = await browser.evalInSession(
      sessionId,
      `(() => {
        const r = document.getElementById('draft').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    );
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 },
      sessionId,
    );
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 },
      sessionId,
    );
    await browser.send("Input.insertText", { text: "unsaved-guard-text" }, sessionId);
    await browser.evalInSession(sessionId, "document.activeElement?.blur()");
    await delay(150);
    return await inspectPage(browser, sessionId, kind);
  }
  if (kind === "media") {
    await browser.navigateAndWait(sessionId, `${origin}/media`);
    // User gesture click to allow audio playback.
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 },
      sessionId,
    );
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 10, y: 10, button: "left", clickCount: 1 },
      sessionId,
    );
    await browser.evalInSession(sessionId, "window.startAudio()", { awaitPromise: true });
    await delay(300);
    return await inspectPage(browser, sessionId, kind);
  }
  throw new Error(`Unknown kind: ${kind}`);
}

async function inspectPage(browser, sessionId, kind, { testBack = false } = {}) {
  const navHist = await browser.send("Page.getNavigationHistory", {}, sessionId);
  if (kind === "article") {
    const scrollY = await browser.evalInSession(sessionId, "window.scrollY");
    const url = await browser.evalInSession(sessionId, "location.href");
    return { url, scrollY, historyCount: navHist.entries.length };
  }
  if (kind === "form") {
    const form = await browser.evalInSession(
      sessionId,
      `({
        text: document.getElementById('text-input')?.value ?? null,
        textarea: document.getElementById('notes')?.value ?? null,
        select: document.getElementById('priority')?.value ?? null,
        checkbox: document.getElementById('agree')?.checked ?? null,
        password: document.getElementById('secret')?.value ?? null,
        contenteditable: document.getElementById('editor')?.textContent ?? null,
      })`,
    );
    return { ...form, historyCount: navHist.entries.length };
  }
  if (kind === "spa") {
    const beforeBack = await browser.evalInSession(
      sessionId,
      `({
        pathname: location.pathname,
        historyLength: history.length,
        state: history.state,
      })`,
    );
    let afterBack = null;
    if (testBack && navHist.currentIndex > 0) {
      const prevEntry = navHist.entries[navHist.currentIndex - 1];
      await browser.send("Page.navigateToHistoryEntry", { entryId: prevEntry.id }, sessionId);
      await delay(300);
      afterBack = await browser.evalInSession(
        sessionId,
        `({
          href: location.href,
          pathname: location.pathname,
          state: history.state,
          popEvents: window.__popEvents ?? null,
        })`,
      );
      // Restore forward position
      const curEntry = navHist.entries[navHist.currentIndex];
      await browser.send("Page.navigateToHistoryEntry", { entryId: curEntry.id }, sessionId);
      await delay(250);
    }
    return {
      ...beforeBack,
      cdpHistoryUrls: navHist.entries.map((e) => e.url),
      cdpCurrentIndex: navHist.currentIndex,
      afterBack,
    };
  }
  if (kind === "sessionStorage") {
    return await browser.evalInSession(
      sessionId,
      `({
        wizardStep: sessionStorage.getItem("wizard_step"),
        cartCount: sessionStorage.getItem("cart_count"),
        readAtLoad: window.__readAtLoad,
      })`,
    );
  }
  if (kind === "post") {
    return await browser.evalInSession(
      sessionId,
      `({
        url: location.href,
        method: document.getElementById('method')?.textContent ?? null,
        body: document.getElementById('body')?.textContent ?? null,
        nonce: document.getElementById('nonce')?.textContent ?? null,
      })`,
    );
  }
  if (kind === "beforeunload") {
    return await browser.evalInSession(
      sessionId,
      `({
        url: location.href,
        draft: document.getElementById('draft')?.value ?? null,
        beforeUnloadFired: window.__beforeUnloadFired,
        handlerActive: window.__handlerActive,
      })`,
    );
  }
  if (kind === "media") {
    return await browser.evalInSession(
      sessionId,
      `(() => {
        const a = document.getElementById('player');
        return {
          paused: a?.paused ?? null,
          ended: a?.ended ?? null,
          currentTime: a ? Math.round(a.currentTime * 1000) / 1000 : null,
          playResult: window.__playResult,
        };
      })()`,
    );
  }
  throw new Error(`Unknown kind: ${kind}`);
}

const PAGE_KINDS = ["article", "form", "spa", "sessionStorage", "post", "beforeunload", "media"];

/** Helper: call chrome://discards Mojo DetailsProvider from a private helper tab. */
async function openDiscardsHelper(browser) {
  const { targetId } = await browser.send("Target.createTarget", {
    url: "chrome://discards",
    background: true,
  });
  const sessionId = await browser.attach(targetId);
  await browser.send("Page.enable", {}, sessionId);
  await waitForLoad(browser, sessionId);
  // Wait for discards Mojo module to be importable.
  await browser.evalInSession(
    sessionId,
    `(async () => {
      const m = await import('/discards.js');
      const dp = m.getOrCreateDetailsProvider();
      window.__dp = dp;
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
          return infos.map(i => ({
            id: i.id,
            tabUrl: i.tabUrl,
            title: i.title,
            state: i.state,
            loadingState: i.loadingState,
            canDiscard: i.canDiscard,
            cannotDiscardReasons: i.cannotDiscardReasons,
            visibility: i.visibility,
            discardCount: i.discardCount,
          }));
        })()`,
        { awaitPromise: true },
      );
    },
    async discardById(id, reason = 0) {
      // LifecycleUnitDiscardReason: EXTERNAL=0, PROACTIVE=1, URGENT=2, SUGGESTED=3
      return await browser.evalInSession(
        sessionId,
        `(async () => {
          await window.__dp.discardById(${id}, ${reason});
          return true;
        })()`,
        { awaitPromise: true },
      );
    },
    async loadById(id) {
      return await browser.evalInSession(
        sessionId,
        `(() => { window.__dp.loadById(${id}); return true; })()`,
      );
    },
    async close() {
      await browser.detach(sessionId);
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

/** 0. Baseline ("Today"): slept tab (close + navigate) & restart (delete Sessions + navigate). */
async function runBaseline(server) {
  return await withProfile("exp-baseline-", async (dir) => {
    const browser = await launchChromium({ userDataDir: dir, noStartupWindow: false });
    try {
      const results = {};
      for (const kind of PAGE_KINDS) {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const sid = await browser.attach(targetId);
        const before = await populatePage(browser, sid, server.origin, kind);
        const savedUrl = await browser.evalInSession(sid, "location.href");
        const offDlg = browser.onEvent((method, params, eventSid) => {
          if (eventSid === sid && method === "Page.javascriptDialogOpening") {
            void browser.send("Page.handleJavaScriptDialog", { accept: true }, sid).catch(() => {});
          }
        });
        // Simulate current Linux sleep: closeTarget (with runBeforeUnload=false equivalent)
        await browser.send("Target.closeTarget", { targetId });
        await delay(150);
        offDlg();
        await browser.detach(sid);
        // Simulate wake: createPage + Page.navigate(savedUrl)
        server.clearRequests();
        const { targetId: newId } = await browser.send("Target.createTarget", {
          url: "about:blank",
        });
        const newSid = await browser.attach(newId);
        await browser.navigateAndWait(newSid, savedUrl);
        await delay(150);
        const after = await inspectPage(browser, newSid, kind, { testBack: true });
        results[kind] = {
          before,
          after,
          networkRequestsOnWake: server.requests.map((r) => `${r.method} ${r.path}`),
        };
        await browser.detach(newSid);
        await browser.send("Target.closeTarget", { targetId: newId });
      }
      return results;
    } finally {
      await browser.gracefulClose();
    }
  });
}

/** 1. Option A: CDP Capture + Navigate & Inject. */
async function runOptionA(server) {
  const CAPTURE_SCRIPT = `(() => {
    const storage = location.origin === 'null' ? null : {
      origin: location.origin,
      items: Array.from({ length: sessionStorage.length }, (_, i) => {
        const k = sessionStorage.key(i);
        return [k, sessionStorage.getItem(k)];
      }),
    };
    const controls = [];
    const selectorOf = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
      return null;
    };
    for (const el of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
      const sel = selectorOf(el);
      if (!sel) continue;
      if (el.tagName === 'INPUT') {
        if (el.type === 'password') continue; // never capture passwords
        if (el.type === 'checkbox' || el.type === 'radio') {
          controls.push({ sel, kind: 'checked', value: el.checked });
        } else {
          controls.push({ sel, kind: 'value', value: el.value });
        }
      } else if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        controls.push({ sel, kind: 'value', value: el.value });
      } else if (el.isContentEditable) {
        controls.push({ sel, kind: 'html', value: el.innerHTML });
      }
    }
    return {
      url: location.href,
      origin: location.origin,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      historyState: history.state,
      storage,
      controls,
    };
  })()`;

  return await withProfile("exp-option-a-", async (dir) => {
    const browser = await launchChromium({ userDataDir: dir, noStartupWindow: false });
    try {
      const results = {};
      for (const kind of PAGE_KINDS) {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const sid = await browser.attach(targetId);
        const before = await populatePage(browser, sid, server.origin, kind);

        // Capture over CDP (isolated world)
        const { frameTree } = await browser.send("Page.getFrameTree", {}, sid);
        const { executionContextId } = await browser.send(
          "Page.createIsolatedWorld",
          { frameId: frameTree.frame.id, worldName: "opensteer-restore-a" },
          sid,
        );
        const snap = await browser.evalInSession(sid, CAPTURE_SCRIPT, {
          contextId: executionContextId,
        });
        const navHistory = await browser.send("Page.getNavigationHistory", {}, sid);
        // Same-origin tail of history entries up to currentIndex
        const sameOriginEntries = navHistory.entries
          .slice(0, navHistory.currentIndex + 1)
          .filter((e) => {
            try {
              return new URL(e.url).origin === snap.origin;
            } catch {
              return false;
            }
          });

        await browser.detach(sid);
        await browser.send("Target.closeTarget", { targetId });

        // Restore by creating page, injecting init script for sessionStorage, navigating, restoring scroll/forms/same-origin pushState
        server.clearRequests();
        const { targetId: newId } = await browser.send("Target.createTarget", {
          url: "about:blank",
        });
        const newSid = await browser.attach(newId);
        await browser.send("Page.enable", {}, newSid);
        if (snap.storage) {
          await browser.send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
              source: `(() => {
                if (location.origin !== ${JSON.stringify(snap.storage.origin)}) return;
                for (const [k, v] of ${JSON.stringify(snap.storage.items)}) {
                  try { sessionStorage.setItem(k, v); } catch {}
                }
              })()`,
            },
            newSid,
          );
        }
        // Navigate to current URL (or if attempting pushState replay, navigate to base then pushState)
        await browser.navigateAndWait(newSid, snap.url);
        // Inject scroll + form controls + history.replaceState for current state (Note: cannot restore prior pushState entries' state objects because CDP Page.getNavigationHistory does not expose history.state for non-active entries!)
        await browser.evalInSession(
          newSid,
          `(() => {
            const snap = ${JSON.stringify(snap)};
            const entries = ${JSON.stringify(sameOriginEntries.map((e) => e.url))};
            if (entries.length > 1) {
              // Attempt synthetic same-origin history replay (note: history.state of earlier entries is unknown over CDP)
              history.replaceState(null, "", entries[0]);
              for (let i = 1; i < entries.length - 1; i++) {
                history.pushState(null, "", entries[i]);
              }
              history.pushState(snap.historyState, "", entries[entries.length - 1]);
            } else if (snap.historyState !== null) {
              history.replaceState(snap.historyState, "");
            }
            for (const c of snap.controls) {
              const el = document.querySelector(c.sel);
              if (!el) continue;
              if (c.kind === 'checked') {
                el.checked = Boolean(c.value);
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else if (c.kind === 'value') {
                el.value = c.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else if (c.kind === 'html') {
                el.innerHTML = c.value;
              }
            }
            window.scrollTo(snap.scrollX, snap.scrollY);
          })()`,
        );
        await delay(150);
        const after = await inspectPage(browser, newSid, kind, { testBack: true });
        results[kind] = {
          before,
          after,
          capturedBytes: Buffer.byteLength(JSON.stringify({ snap, navHistory })),
          networkRequestsOnWake: server.requests.map((r) => `${r.method} ${r.path}`),
        };
        await browser.detach(newSid);
        await browser.send("Target.closeTarget", { targetId: newId });
      }
      return results;
    } finally {
      await browser.gracefulClose();
    }
  });
}

/** 2. Option B: Chromium Native Session Restore (both clean Browser.close AND SIGKILL crash). */
async function runOptionB(server, { crash = false } = {}) {
  return await withProfile(crash ? "exp-option-b-crash-" : "exp-option-b-", async (dir) => {
    // Write Preferences with restore_on_startup=1 just like native-profile-storage.ts
    await mkdir(path.join(dir, "Default"), { recursive: true });
    await writeFile(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 1 } }),
    );

    const browser1 = await launchChromium({
      userDataDir: dir,
      noStartupWindow: false,
      restoreLastSession: true,
    });
    const beforeMap = {};
    const openedOrder = [];
    try {
      // Close initial blank NTP if present after opening our tabs so only our 7 tabs exist
      const initialTargets = (await browser1.send("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page",
      );
      for (const kind of PAGE_KINDS) {
        const { targetId } = await browser1.send("Target.createTarget", { url: "about:blank" });
        const sid = await browser1.attach(targetId);
        beforeMap[kind] = await populatePage(browser1, sid, server.origin, kind);
        const url = await browser1.evalInSession(sid, "location.href");
        openedOrder.push({ kind, url, targetId });
        await browser1.detach(sid);
      }
      // Also open one extra tab and CLOSE it to test whether closed tabs stay gone on restore.
      const { targetId: closedTabId } = await browser1.send("Target.createTarget", {
        url: `${server.origin}/closed-tab-sentinel`,
      });
      const closedSid = await browser1.attach(closedTabId);
      await waitForLoad(browser1, closedSid);
      await browser1.detach(closedSid);
      await browser1.send("Target.closeTarget", { targetId: closedTabId });

      // Close initial blank tab(s)
      for (const t of initialTargets) {
        await browser1.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }

      // Switch active tab to trigger visibility-change PageState flush on background tabs,
      // and wait briefly for SessionService's debounced write (~2.5s default save delay in Chrome).
      await browser1.send("Target.activateTarget", { targetId: openedOrder[0].targetId });
      await delay(crash ? 3000 : 1000);
    } finally {
      if (crash) await browser1.forceKill();
      else await browser1.gracefulClose();
    }

    // Check what session files Chromium persisted
    const sessionFiles = await readdir(path.join(dir, "Default", "Sessions")).catch(() => []);

    // Relaunch with --restore-last-session (NO --no-startup-window)
    server.clearRequests();
    const browser2 = await launchChromium({
      userDataDir: dir,
      noStartupWindow: false,
      restoreLastSession: true,
    });
    try {
      await delay(1500);
      const targets = (await browser2.send("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page",
      );
      const requestsRightAfterLaunch = server.requests.map((r) => `${r.method} ${r.path}`);

      // Notice we do NOT touch chrome://discards in Option B (uses stock prefs only).
      const closedSentinelCameBack = targets.some((t) => t.url.includes("closed-tab-sentinel"));
      const restoredOrder = targets.map((t) => ({
        targetId: t.targetId,
        url: t.url,
        title: t.title,
      }));

      const results = {};
      for (const item of openedOrder) {
        const match = targets.find((t) => t.url === item.url);
        if (!match) {
          results[item.kind] = { before: beforeMap[item.kind], after: null, missing: true };
          continue;
        }
        server.clearRequests();
        await browser2.send("Target.activateTarget", { targetId: match.targetId });
        const sid = await browser2.attach(match.targetId);
        await browser2.send("Page.enable", {}, sid);
        await waitForLoad(browser2, sid, 10_000).catch(() => {});
        await delay(300);
        const after = await inspectPage(browser2, sid, item.kind, { testBack: true });
        results[item.kind] = {
          before: beforeMap[item.kind],
          after,
          networkRequestsOnActivate: server.requests.map((r) => `${r.method} ${r.path}`),
        };
        await browser2.detach(sid);
      }

      return {
        crash,
        sessionFiles,
        restoredCount: targets.length,
        expectedCount: openedOrder.length,
        closedSentinelCameBack,
        openedUrls: openedOrder.map((o) => o.url),
        restoredUrls: restoredOrder.map((r) => r.url),
        orderPreserved:
          JSON.stringify(openedOrder.map((o) => o.url)) ===
          JSON.stringify(restoredOrder.map((r) => r.url)),
        requestsRightAfterLaunch,
        pages: results,
      };
    } finally {
      await browser2.gracefulClose();
    }
  });
}

/** 3. Option C: Chromium Native Tab Discarding via chrome://discards (+ optional WebContentsDiscard + optional Hybrid C+B restart). */
async function runOptionC(
  server,
  { enableWebContentsDiscard = false, testRestartWhileDiscarded = false } = {},
) {
  return await withProfile(
    `exp-option-c-${enableWebContentsDiscard ? "wcd-" : "def-"}`,
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
      const extraArgs = enableWebContentsDiscard ? ["--enable-features=WebContentsDiscard"] : [];
      const browser = await launchChromium({
        userDataDir: dir,
        noStartupWindow: false,
        restoreLastSession: true,
        extraArgs,
      });

      const targetEvents = [];
      await browser.send("Target.setDiscoverTargets", { discover: true });
      browser.onEvent((method, params) => {
        if (
          method === "Target.targetCreated" ||
          method === "Target.targetDestroyed" ||
          method === "Target.targetInfoChanged"
        ) {
          targetEvents.push({
            method,
            targetId: params.targetId ?? params.targetInfo?.targetId,
            url: params.targetInfo?.url,
            type: params.targetInfo?.type,
          });
        }
      });

      const tabs = [];
      let helper;
      try {
        const initialTargets = (await browser.send("Target.getTargets")).targetInfos.filter(
          (t) => t.type === "page",
        );

        for (const kind of PAGE_KINDS) {
          const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
          const sid = await browser.attach(targetId);
          const before = await populatePage(browser, sid, server.origin, kind);
          const url = await browser.evalInSession(sid, "location.href");
          await browser.detach(sid);
          tabs.push({ kind, targetId, url, before });
        }

        // Open chrome://discards helper tab (making it active so all 7 test tabs are backgrounded)
        helper = await openDiscardsHelper(browser);
        await browser.send("Target.activateTarget", { targetId: helper.targetId });

        // Close initial blank tab(s)
        for (const t of initialTargets) {
          await browser.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
        }
        await delay(500);

        const infosBefore = await helper.getInfos();
        const memBeforeDiscard = browser.measureProcessTreeMemory();

        // Discard each of the 7 tabs using LifecycleUnitDiscardReason.EXTERNAL (0)
        const discardDetails = {};
        for (const tab of tabs) {
          targetEvents.length = 0;
          const infos = await helper.getInfos();
          const entry = infos.find((i) => i.tabUrl === tab.url);
          if (!entry) {
            discardDetails[tab.kind] = { error: "not found in chrome://discards" };
            continue;
          }
          await helper.discardById(entry.id, 0); // EXTERNAL
          await delay(200);
          const afterInfos = await helper.getInfos();
          const afterEntry = afterInfos.find((i) => i.tabUrl === tab.url);
          const currentTargets = (await browser.send("Target.getTargets")).targetInfos.filter(
            (t) => t.type === "page",
          );
          const sameTargetStillExists = currentTargets.some((t) => t.targetId === tab.targetId);
          const matchedTarget = currentTargets.find((t) => t.url === tab.url);
          discardDetails[tab.kind] = {
            discardIdBefore: entry.id,
            stateBefore: entry.state,
            stateAfter: afterEntry?.state ?? null, // LifecycleUnitState.DISCARDED === 4
            canDiscardUrgent: entry.canDiscard,
            cannotDiscardReasonsUrgent: entry.cannotDiscardReasons,
            targetIdBefore: tab.targetId,
            targetIdAfter: matchedTarget?.targetId ?? null,
            targetIdPreserved: sameTargetStillExists,
            cdpEventsDuringDiscard: [...targetEvents],
          };
          tab.currentTargetId = matchedTarget?.targetId ?? tab.targetId;
        }

        await delay(500);
        const memAfterDiscard = browser.measureProcessTreeMemory();

        // If NOT testing restart-while-discarded, wake each tab right now in the same browser!
        const wakeResults = {};
        if (!testRestartWhileDiscarded) {
          for (const tab of tabs) {
            server.clearRequests();
            const t0 = performance.now();
            await browser.send("Target.activateTarget", { targetId: tab.currentTargetId });
            const sid = await browser.attach(tab.currentTargetId);
            await browser.send("Page.enable", {}, sid);
            await waitForLoad(browser, sid, 10_000).catch(() => {});
            const wakeMs = Math.round(performance.now() - t0);
            await delay(250);
            const after = await inspectPage(browser, sid, tab.kind, { testBack: true });
            wakeResults[tab.kind] = {
              before: tab.before,
              after,
              wakeMs,
              networkRequestsOnWake: server.requests.map((r) => `${r.method} ${r.path}`),
            };
            await browser.detach(sid);
          }
          await helper.close();
          await browser.gracefulClose();
          return {
            enableWebContentsDiscard,
            memBeforeDiscard,
            memAfterDiscard,
            infosBeforeCount: infosBefore.length,
            discardDetails,
            pages: wakeResults,
          };
        }

        // Hybrid C + B: Close chrome://discards helper, wait briefly, close browser cleanly,
        // then relaunch with --restore-last-session while all 7 tabs were DISCARDED!
        await helper.close();
        await delay(1000);
        await browser.gracefulClose();
      } catch (err) {
        await helper?.close().catch(() => {});
        await browser.gracefulClose().catch(() => {});
        throw err;
      }

      // Relaunch Chromium on the same profile!
      server.clearRequests();
      const browser2 = await launchChromium({
        userDataDir: dir,
        noStartupWindow: false,
        restoreLastSession: true,
        extraArgs,
      });
      try {
        await delay(1500);
        const targets = (await browser2.send("Target.getTargets")).targetInfos.filter(
          (t) => t.type === "page",
        );
        const wakeResults = {};
        for (const tab of tabs) {
          const match = targets.find((t) => t.url === tab.url);
          if (!match) {
            wakeResults[tab.kind] = { before: tab.before, after: null, missing: true };
            continue;
          }
          server.clearRequests();
          await browser2.send("Target.activateTarget", { targetId: match.targetId });
          const sid = await browser2.attach(match.targetId);
          await browser2.send("Page.enable", {}, sid);
          await waitForLoad(browser2, sid, 10_000).catch(() => {});
          await delay(250);
          const after = await inspectPage(browser2, sid, tab.kind, { testBack: true });
          wakeResults[tab.kind] = {
            before: tab.before,
            after,
            networkRequestsOnWake: server.requests.map((r) => `${r.method} ${r.path}`),
          };
          await browser2.detach(sid);
        }
        return {
          hybridCPlusB: true,
          enableWebContentsDiscard,
          restoredCount: targets.length,
          expectedCount: tabs.length,
          orderPreserved:
            JSON.stringify(tabs.map((t) => t.url)) === JSON.stringify(targets.map((t) => t.url)),
          pages: wakeResults,
        };
      } finally {
        await browser2.gracefulClose();
      }
    },
  );
}

/** 4. Option D: Freezing via Page.setWebLifecycleState('frozen' -> 'active'). */
async function runOptionD(server) {
  return await withProfile("exp-option-d-", async (dir) => {
    const browser = await launchChromium({ userDataDir: dir, noStartupWindow: false });
    try {
      const results = {};
      for (const kind of PAGE_KINDS) {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const sid = await browser.attach(targetId);
        const before = await populatePage(browser, sid, server.origin, kind);
        await browser.evalInSession(
          sid,
          `(() => {
            window.__ticks = 0;
            window.__freezeCount = 0;
            window.__resumeCount = 0;
            document.addEventListener('freeze', () => { window.__freezeCount++; });
            document.addEventListener('resume', () => { window.__resumeCount++; });
            window.__timer = setInterval(() => { window.__ticks++; }, 50);
          })()`,
        );
        await delay(160);
        const ticksBeforeFreeze = await browser.evalInSession(sid, "window.__ticks");

        server.clearRequests();
        let freezeError = null;
        try {
          await browser.send("Page.setWebLifecycleState", { state: "frozen" }, sid);
        } catch (e) {
          freezeError = e.message;
        }
        await delay(400);
        const t0 = performance.now();
        await browser.send("Page.setWebLifecycleState", { state: "active" }, sid).catch(() => {});
        const wakeMs = Math.round(performance.now() - t0);
        const lifecycle = await browser.evalInSession(
          sid,
          `(() => {
            clearInterval(window.__timer);
            return {
              ticksAfter: window.__ticks,
              freezeCount: window.__freezeCount,
              resumeCount: window.__resumeCount,
            };
          })()`,
        );
        const after = await inspectPage(browser, sid, kind, { testBack: true });
        results[kind] = {
          before,
          after,
          freezeError,
          ticksBeforeFreeze,
          ...lifecycle,
          wakeMs,
          networkRequestsOnWake: server.requests.map((r) => `${r.method} ${r.path}`),
        };
        await browser.detach(sid);
        await browser.send("Target.closeTarget", { targetId });
      }
      return results;
    } finally {
      await browser.gracefulClose();
    }
  });
}

async function main() {
  const server = await startFixtureServer();
  try {
    console.log("Fixture server listening at", server.origin);
    const out = {};

    console.log("\n=== Running Baseline (Today: close + navigate) ===");
    out.baseline = await runBaseline(server);

    console.log("\n=== Running Option A (CDP capture + navigate & inject) ===");
    out.optionA = await runOptionA(server);

    console.log("\n=== Running Option B (Session Restore, clean exit) ===");
    out.optionBClean = await runOptionB(server, { crash: false });

    console.log("\n=== Running Option B (Session Restore, SIGKILL crash) ===");
    out.optionBCrash = await runOptionB(server, { crash: true });

    console.log("\n=== Running Option C (Tab Discard via chrome://discards, default) ===");
    out.optionCDefault = await runOptionC(server, { enableWebContentsDiscard: false });

    console.log(
      "\n=== Running Option C (Tab Discard via chrome://discards, WebContentsDiscard) ===",
    );
    out.optionCWcd = await runOptionC(server, { enableWebContentsDiscard: true });

    console.log(
      "\n=== Running Hybrid C + B (Discard tabs, then restart with --restore-last-session) ===",
    );
    out.hybridCPlusB = await runOptionC(server, {
      enableWebContentsDiscard: true,
      testRestartWhileDiscarded: true,
    });

    console.log("\n=== Running Option D (Page.setWebLifecycleState frozen/active) ===");
    out.optionD = await runOptionD(server);

    out.removedProfileDirs = removedDirs;
    await writeFile(
      path.join(path.dirname(new URL(import.meta.url).pathname), "matrix-results.json"),
      JSON.stringify(out, null, 2) + "\n",
    );
    console.log("\nWrote matrix-results.json successfully!");
    console.log("Removed temp profile dirs:", removedDirs.length);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
