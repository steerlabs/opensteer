/**
 * What the Linux runtime relies on Chromium for, asked of Chromium itself: a discarded tab can be
 * named and is found by that name (L2), Chromium discards no tab by itself, and a tab a page opens
 * arrives with its opener known (K3). Launched exactly as the Linux runtime launches a native
 * profile (same options, same bundled helper), without the runtime.
 */
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import { cleanup, findChromium } from "./browser-test-lifecycle.js";
import { initializeNativePreferences } from "./native-profile-storage.js";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";
import {
  ChromiumTabLifecycleBridge,
  ensureTabLifecycleExtension,
  type ChromiumTabEntry,
} from "./tab-lifecycle-extension.js";

const executablePath = findChromium();

async function fixtureServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/spa")) {
      response.end(
        `<!doctype html><html><body><input id="draft"><div id="route"></div>
         <script>document.getElementById("route").textContent = location.pathname;</script></body></html>`,
      );
      return;
    }
    if (url.pathname === "/noopener") {
      response.end(
        `<!doctype html><html><body>
         <a id="link" href="/child?via=link" target="_blank" rel="noopener">link</a>
         <button id="open" onclick="window.open('/child?via=open', '_blank', 'noopener')">open</button>
         </body></html>`,
      );
      return;
    }
    if (url.pathname === "/opener") {
      response.end(
        `<!doctype html><html><body><a id="out" href="/child" target="_blank">out</a></body></html>`,
      );
      return;
    }
    response.end(
      `<!doctype html><html><head><title>${url.search}</title></head>
       <body style="margin:0;background:#fff"><h1>${url.pathname}${url.search}</h1></body></html>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address.");
  return (site: number, query: string) =>
    `http://site-${site}.localhost:${address.port}/page?${query}`;
}

interface Running {
  context: BrowserContext;
  helper: Page;
  lifecycle: ChromiumTabLifecycleBridge;
  pid: number;
}

async function launch(directory: string, rewrite?: (worker: string) => string): Promise<Running> {
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  await initializeNativePreferences(directory);
  const extensionDir = await ensureTabLifecycleExtension(directory);
  if (rewrite) {
    const worker = path.join(extensionDir, "sw.js");
    await writeFile(worker, rewrite(await readFile(worker, "utf8")));
  }
  const context = await chromium.launchPersistentContext(
    directory,
    launcher.nativeLaunchOptions(directory, extensionDir, performance.now() + 30_000),
  );
  const process = (context as BrowserContext & { process(): { pid: number } }).process();
  let closed = false;
  context.on("close", () => (closed = true));
  cleanup.push(async () => {
    if (!closed) await context.close().catch(() => undefined);
  });
  const helper = await context.newPage();
  const browserCdp = await context.browser()!.newBrowserCDPSession();
  const lifecycle = new ChromiumTabLifecycleBridge(context, browserCdp, helper);
  return { context, helper, lifecycle, pid: process.pid };
}

/** Profile tabs only: no helper, extension or blank tabs. */
async function profileTabs(lifecycle: ChromiumTabLifecycleBridge): Promise<ChromiumTabEntry[]> {
  return (await lifecycle.inventory()).filter(
    (tab) =>
      tab.url !== "" &&
      tab.url !== "about:blank" &&
      tab.url !== "chrome://newtab/" &&
      !tab.url.startsWith("chrome-extension://"),
  );
}

it("reports the opener of a tab opened with noopener, by a link and by window.open (K3 gate, test 7)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-noopener-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const opener = await running.context.newPage();
  await opener.goto(url(1, "x").replace("/page?x", "/noopener"));
  const openerOf = (page: Page) => (page as unknown as { _opener?: Page | null })._opener ?? null;
  const results: Record<string, unknown> = {};
  for (const [via, selector] of [
    ["link", "#link"],
    ["open", "#open"],
  ] as const) {
    const arrived = running.context.waitForEvent("page");
    await opener.click(selector);
    const page = await arrived;
    await page.waitForLoadState();
    results[via] = {
      url: new URL(page.url()).search,
      openerKnown: openerOf(page) === opener,
      playwrightOpener: (await page.opener()) === opener,
    };
  }
  process.stdout.write(`${JSON.stringify({ event: "k3.noopener", ...results })}\n`);
  expect(results).toEqual({
    link: { url: "?via=link", openerKnown: true, playwrightOpener: true },
    open: { url: "?via=open", openerKnown: true, playwrightOpener: true },
  });
}, 60_000);

it("marks every tab as not discardable by Chromium itself, and answers an activation with the tab it activated (K3, K2)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-autodiscard-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const page = await running.context.newPage();
  await page.goto(url(1, "auto"));
  const worker = running.context.serviceWorkers().find((w) => w.url().endsWith("/sw.js"))!;
  const flags = () =>
    worker.evaluate(async () => {
      const tabs = (
        globalThis as unknown as {
          chrome: {
            tabs: { query(q: object): Promise<{ url?: string; autoDiscardable: boolean }[]> };
          };
        }
      ).chrome.tabs;
      return (await tabs.query({})).map((tab) => ({ url: tab.url, auto: tab.autoDiscardable }));
    });
  await vi.waitFor(
    async () => expect((await flags()).every((tab) => tab.auto === false)).toBe(true),
    {
      timeout: 5_000,
      interval: 50,
    },
  );
  const row = (await profileTabs(running.lifecycle)).find((t) => t.url.includes("auto"))!;
  await running.helper.bringToFront();
  const discarded = await running.lifecycle.discardByTabId(row.tabId);
  const asleep = (await running.lifecycle.inventory()).find((t) => t.tabId === discarded)!;
  const reply = await running.lifecycle.activateByTabId(asleep.tabId);
  const awake = await vi.waitFor(
    async () => {
      const now = (await running.lifecycle.inventory()).find((t) => t.url.includes("auto"))!;
      expect(now.discarded).toBe(false);
      return now;
    },
    { timeout: 10_000, interval: 50 },
  );
  process.stdout.write(
    `${JSON.stringify({ event: "k2.activation-reply", tabs: await flags(), before: row.tabId, discarded, reply, awake: awake.tabId })}\n`,
  );
  expect(reply.ok).toBe(true);
  expect(reply.tabId).toBe(asleep.tabId);
  expect(awake.tabId).toBe(reply.tabId);
}, 60_000);

/** Every tab's own flag, as the helper's worker reads it. */
async function autoDiscardable(running: Running) {
  const worker = await vi.waitFor(() => {
    const found = running.context.serviceWorkers().find((w) => w.url().endsWith("/sw.js"));
    expect(found).toBeDefined();
    return found!;
  });
  return worker.evaluate(async () => {
    const tabs = (
      globalThis as unknown as {
        chrome: {
          tabs: { query(q: object): Promise<{ id: number; autoDiscardable: boolean }[]> };
        };
      }
    ).chrome.tabs;
    return (await tabs.query({})).map((tab) => ({ id: tab.id, auto: tab.autoDiscardable }));
  });
}

/*
 * K3 in every order: Chromium may refuse the worker's mark for a moment, and nothing may leave a
 * tab discardable by Chromium for good. A refused mark is asked again; a tab whose mark was lost
 * (an event that never came, a refusal given up on, a reset) is marked again by the runtime's
 * next inventory read.
 */
it("keeps a tab from Chromium's own discard when its first mark is refused (K3)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-refused-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // A test build of the helper whose first mark of each tab is refused, as Chromium can.
  const mark = "chrome.tabs.update(tabId, { autoDiscardable: false })";
  const running = await launch(directory, (worker) => {
    expect(worker).toContain(mark);
    return (
      `const refusedOnce = new Set();
const markOnce = (tabId, properties) => {
  if (refusedOnce.has(tabId)) return chrome.tabs.update(tabId, properties);
  refusedOnce.add(tabId);
  return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."));
};
` + worker.replace(mark, "markOnce(tabId, { autoDiscardable: false })")
    );
  });
  const page = await running.context.newPage();
  await page.goto(url(1, "refused"));
  await vi.waitFor(
    async () => expect((await autoDiscardable(running)).every((tab) => !tab.auto)).toBe(true),
    { timeout: 5_000, interval: 50 },
  );
}, 60_000);

it("marks again a tab whose mark was lost, at the runtime's next inventory read (K3)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-lost-mark-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const page = await running.context.newPage();
  await page.goto(url(1, "lost"));
  await vi.waitFor(
    async () => expect((await autoDiscardable(running)).every((tab) => !tab.auto)).toBe(true),
    { timeout: 5_000, interval: 50 },
  );
  // The mark lost behind the worker's back.
  const worker = running.context.serviceWorkers().find((w) => w.url().endsWith("/sw.js"))!;
  await worker.evaluate(async () => {
    const tabs = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query(q: object): Promise<{ id: number }[]>;
            update(id: number, p: object): Promise<unknown>;
          };
        };
      }
    ).chrome.tabs;
    for (const tab of await tabs.query({})) await tabs.update(tab.id, { autoDiscardable: true });
  });
  expect((await autoDiscardable(running)).some((tab) => tab.auto)).toBe(true);
  await running.lifecycle.inventory();
  await vi.waitFor(
    async () => expect((await autoDiscardable(running)).every((tab) => !tab.auto)).toBe(true),
    { timeout: 5_000, interval: 50 },
  );
}, 60_000);

it("names a tab after Chromium discarded it: no page arrives while it sleeps, it keeps its target, and wakes by that name with its state (L2)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-discard-then-name-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const page = await running.context.newPage();
  await page.goto(url(1, "sleeper"));
  await page.evaluate(() => sessionStorage.setItem("mark", "kept"));
  const targetOf = async (p: Page) =>
    (
      (await (await running.context.newCDPSession(p)).send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      }
    ).targetInfo.targetId;
  const targetId = await targetOf(page);
  const row = (await running.lifecycle.inventory()).find((t) => t.targetId === targetId)!;
  const arrivals: string[] = [];
  running.context.on("page", (p) => arrivals.push(p.url()));
  await running.helper.bringToFront();
  const discardedId = await running.lifecycle.discardByTabId(row.tabId);
  // Chromium's answer names the tab after the discard; its target may or may not change.
  const asleep = (await running.lifecycle.inventory()).find((t) => t.tabId === discardedId)!;
  expect(asleep).toMatchObject({ discarded: true, identity: null });
  expect(await running.lifecycle.nameTab(asleep.tabId, "opensteer-sleep:l2")).toBe(true);
  const named = (await running.lifecycle.inventory()).filter(
    (t) => t.identity === "opensteer-sleep:l2",
  );
  expect(named).toMatchObject([{ tabId: asleep.tabId, discarded: true, status: "unloaded" }]);
  expect(arrivals).toEqual([]);
  const arrived = running.context.waitForEvent("page");
  const reply = await running.lifecycle.activateByTabId(asleep.tabId);
  const woken = await arrived;
  await woken.waitForLoadState();
  expect(reply).toEqual({ ok: true, tabId: asleep.tabId, discarded: false });
  const wokenTarget = await targetOf(woken);
  const awake = (await running.lifecycle.inventory()).find((t) => t.targetId === wokenTarget)!;
  expect(awake).toMatchObject({ tabId: asleep.tabId, identity: "opensteer-sleep:l2" });
  expect(await woken.evaluate(() => sessionStorage.getItem("mark"))).toBe("kept");
  expect(await running.lifecycle.unnameTab(awake.tabId)).toBe(true);
  expect((await running.lifecycle.inventory()).find((t) => t.tabId === awake.tabId)?.identity).toBe(
    null,
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "l2.discard-then-name",
      before: row.tabId,
      asleep: asleep.tabId,
      targetKeptThroughDiscard: asleep.targetId === targetId,
      wokenTargetIsAsleepTarget: wokenTarget === asleep.targetId,
    })}\n`,
  );
}, 60_000);

it("keeps a group title given before the discard through it, also when the discard gives the tab a new id, and finds the tab by it (Q2)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-name-then-discard-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const outcomes: unknown[] = [];
  for (let round = 0; round < 3; round++) {
    const page = await running.context.newPage();
    await page.goto(url(round + 1, `name-first=${round}`));
    await page.evaluate(() => sessionStorage.setItem("mark", "kept"));
    const targetId = (
      (await (await running.context.newCDPSession(page)).send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      }
    ).targetInfo.targetId;
    const row = (await running.lifecycle.inventory()).find((t) => t.targetId === targetId)!;
    const name = `opensteer-sleep:q2-${round}`;
    await running.helper.bringToFront();
    expect(await running.lifecycle.nameTab(row.tabId, name)).toBe(true);
    const asleepId = await running.lifecycle.discardByTabId(row.tabId);
    const carriers = (await running.lifecycle.inventory()).filter((t) => t.identity === name);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatchObject({ tabId: asleepId, discarded: true });
    const arrived = running.context.waitForEvent("page");
    await running.lifecycle.activateByTabId(carriers[0]!.tabId);
    const woken = await arrived;
    await woken.waitForLoadState();
    expect(await woken.evaluate(() => sessionStorage.getItem("mark"))).toBe("kept");
    outcomes.push({ before: row.tabId, after: asleepId, idReplaced: asleepId !== row.tabId });
  }
  process.stdout.write(`${JSON.stringify({ event: "q2.name-then-discard", outcomes })}\n`);
}, 90_000);

it("reports no opener for a woken tab that another page opened (M1)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-m1-probe-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const openerOf = (page: Page) => (page as unknown as { _opener?: Page | null })._opener ?? null;
  const opener = await running.context.newPage();
  await opener.goto(url(1, "x").replace("/page?x", "/opener"));
  const childPromise = running.context.waitForEvent("page");
  await opener.click("#out");
  const child = await childPromise;
  await child.waitForLoadState();
  const before = {
    opener: openerOf(child) === opener,
    playwright: (await child.opener()) === opener,
  };
  const targetId = (
    (await (await running.context.newCDPSession(child)).send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string; openerId?: string };
    }
  ).targetInfo;
  const row = (await running.lifecycle.inventory()).find((t) => t.targetId === targetId.targetId)!;
  await running.helper.bringToFront();
  const asleep = await running.lifecycle.nameAndDiscard(row.tabId, "opensteer-sleep:m1");
  const arrived = running.context.waitForEvent("page");
  await running.lifecycle.activateByTabId(asleep!);
  const woken = await arrived;
  await woken.waitForLoadState();
  const info = (
    (await (await running.context.newCDPSession(woken)).send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string; openerId?: string };
    }
  ).targetInfo;
  const after = {
    syncOpenerIsOriginalOpener: openerOf(woken) === opener,
    syncOpenerPresent: openerOf(woken) !== null,
    playwrightOpener: (await woken.opener()) === opener,
    cdpOpenerId: info.openerId ?? null,
    openerTarget: (
      (await (await running.context.newCDPSession(opener)).send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      }
    ).targetInfo.targetId,
  };
  process.stdout.write(
    `${JSON.stringify({ event: "m1.woken-opener", before, beforeCdp: targetId.openerId ?? null, after })}\n`,
  );
}, 60_000);

it("loads a sleeping tab when the active tab beside it closes, and puts a tab opened from a page next to it into its group, carrying its name (run 10)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-run10-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const gesture = async (page: Page, expression: string) =>
    (await running.context.newCDPSession(page)).send("Runtime.evaluate", {
      expression,
      userGesture: true,
    });
  const first = await running.context.newPage();
  await first.goto(url(1, "first"));
  const bystander = await running.context.newPage();
  await bystander.goto(url(2, "bystander"));
  const sleeper = await running.context.newPage();
  await sleeper.goto(url(3, "sleeper"));
  await first.bringToFront();
  const sleeperTab = (await running.lifecycle.inventory()).find((t) => t.url.includes("?sleeper"))!;
  await running.lifecycle.nameAndDiscard(sleeperTab.tabId, "opensteer-sleep:run10");
  const strip = async () =>
    (await running.lifecycle.inventory())
      .filter((t) => t.url.includes("/page?"))
      .map((t) => ({
        page: new URL(t.url).search.slice(1),
        named: t.identity === "opensteer-sleep:run10",
        discarded: t.discarded,
        active: t.active,
      }));
  const seen: unknown[] = [];
  // The run-10 loop: a popup from `first` opens a successor and closes itself; the successor is
  // closed. Each popup lands just left of the sleeping tab, so its close activates that tab.
  for (let round = 1; round <= 3; round++) {
    const second = running.context.waitForEvent("page");
    await gesture(
      first,
      `void window.open(${JSON.stringify(url(4, `second-r${round}`))}, "_blank")`,
    );
    const secondPage = await second;
    await secondPage.waitForLoadState();
    seen.push({ round, step: "second opened", strip: await strip() });
    const third = running.context.waitForEvent("page");
    await gesture(
      secondPage,
      `window.open(${JSON.stringify(url(5, `third-r${round}`))}, "_blank"); window.close();`,
    );
    const thirdPage = await third;
    await thirdPage.waitForLoadState();
    await thirdPage.close();
    await vi.waitFor(async () => expect((await strip()).some((t) => t.active)).toBe(true));
    seen.push({ round, step: "third closed", strip: await strip() });
  }
  process.stdout.write(`${JSON.stringify({ event: "run10.chromium", seen })}\n`);
  const after = (round: number, step: string) =>
    (seen as { round: number; step: string; strip: { page: string }[] }[]).find(
      (entry) => entry.round === round && entry.step === step,
    )!.strip;
  // Round 2: the successor, next to the sleeping tab, closes; Chromium activates the sleeping
  // tab, and it loads (no longer discarded), still under its name.
  expect(after(2, "third closed")).toContainEqual({
    page: "sleeper",
    named: true,
    discarded: false,
    active: true,
  });
  // Round 3: the popup from `first` opens next to the now active sleeping tab, inside its group,
  // and carries its name: a newcomer that is not the sleeping tab.
  expect(after(3, "second opened")).toContainEqual({
    page: "second-r3",
    named: true,
    discarded: false,
    active: true,
  });
}, 90_000);

it("moves a discarded named tab without loading it or changing its id or name, closes a popup whose moved sleeping opener is away onto a live tab, and loads an active discarded tab only once another tab was active (run 11)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-run11-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const rows = async () =>
    (await running.lifecycle.inventory()).filter((t) => t.url.includes("/page?"));
  const row = async (query: string) => (await rows()).find((t) => t.url.includes(`?${query}`))!;
  const gesture = async (page: Page, expression: string) =>
    (await running.context.newCDPSession(page)).send("Runtime.evaluate", {
      expression,
      userGesture: true,
    });

  // A discarded, named tab moved to the left end: still discarded, same id, same name, not loaded.
  const a = await running.context.newPage();
  await a.goto(url(1, "a"));
  const c = await running.context.newPage();
  await c.goto(url(2, "c"));
  await c.evaluate(() => sessionStorage.setItem("mark", "c-kept"));
  await a.bringToFront();
  const cId = await running.lifecycle.nameAndDiscard((await row("c")).tabId, "opensteer-sleep:c");
  // A tab that loads gives Playwright a page: none may arrive for it until it is activated.
  let loadsOfC = 0;
  const countC = (page: Page) => {
    if (page.url().includes("?c")) loadsOfC++;
  };
  running.context.on("page", countC);
  expect(await running.lifecycle.moveTab(cId!, 0)).toEqual({ tabId: cId, index: 0 });
  const asleepAtLeft = {
    tabId: cId,
    index: 0,
    discarded: true,
    status: "unloaded",
    identity: "opensteer-sleep:c",
  };
  expect(await row("c")).toMatchObject(asleepAtLeft);
  // Moved to the right end, before it is activated: still asleep, never loaded by the moves.
  const moved = await running.lifecycle.moveTab(cId!, -1);
  expect(moved?.tabId).toBe(cId);
  expect(await row("c")).toMatchObject({ ...asleepAtLeft, index: moved!.index });
  expect(loadsOfC).toBe(0);
  running.context.off("page", countC);
  // Activated, it wakes as itself.
  const woken = running.context.waitForEvent("page");
  await running.lifecycle.activateByTabId(cId!);
  const cPage = await woken;
  await cPage.waitForLoadState();
  expect(await cPage.evaluate(() => sessionStorage.getItem("mark"))).toBe("c-kept");

  // A popup whose opener sleeps: moved away, closing the popup activates a live tab; left in
  // place, it activates the sleeping opener beside it, which loads.
  const closed: Record<string, unknown> = {};
  for (const moveIt of [true, false]) {
    const tag = moveIt ? "moved" : "inplace";
    const w = await running.context.newPage();
    await w.goto(url(3, `w-${tag}`));
    const x = await running.context.newPage();
    await x.goto(url(4, `x-${tag}`));
    const popup = running.context.waitForEvent("page");
    await gesture(x, `void window.open(${JSON.stringify(url(5, `y-${tag}`))}, "_blank")`);
    const y = await popup;
    await y.waitForLoadState();
    const xId = await running.lifecycle.nameAndDiscard(
      (await row(`x-${tag}`)).tabId,
      `opensteer-sleep:x-${tag}`,
    );
    if (moveIt) await running.lifecycle.moveTab(xId!, 0);
    await y.close();
    await vi.waitFor(async () => expect((await rows()).some((t) => t.active)).toBe(true));
    const active = (await rows()).find((t) => t.active)!;
    closed[tag] = { active: new URL(active.url).search.slice(1), discarded: active.discarded };
  }
  expect(closed).toEqual({
    moved: { active: "w-moved", discarded: false },
    inplace: { active: "x-inplace", discarded: false },
  });

  // A tab discarded while it is the active tab stays active and discarded; activating it again
  // does not load it; once another tab was active, activating it loads it with its state.
  const d = await running.context.newPage();
  await d.goto(url(6, "d"));
  await d.evaluate(() => sessionStorage.setItem("mark", "d-kept"));
  const dId = await running.lifecycle.nameAndDiscard((await row("d")).tabId, "opensteer-sleep:d");
  expect(await row("d")).toMatchObject({ active: true, discarded: true });
  expect(await running.lifecycle.activateByTabId(dId!)).toEqual({
    ok: true,
    tabId: dId,
    discarded: true,
  });
  await a.bringToFront();
  const dWoken = running.context.waitForEvent("page");
  expect(await running.lifecycle.activateByTabId(dId!)).toMatchObject({ discarded: false });
  const dPage = await dWoken;
  await dPage.waitForLoadState();
  expect(await dPage.evaluate(() => sessionStorage.getItem("mark"))).toBe("d-kept");
}, 120_000);
