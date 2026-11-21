/**
 * R2: can Chromium itself carry which Home tab a Chromium tab is? Each saved tab is put in its own
 * tab group whose title is its Home surface id. Launched exactly as the Linux runtime launches a
 * native profile (same options, same bundled helper), without the runtime's restore code.
 */
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
const tabCount = 70;

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

async function launch(directory: string): Promise<Running> {
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  await initializeNativePreferences(directory);
  const extensionDir = await ensureTabLifecycleExtension(directory);
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

const surface = (i: number) => `srf_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

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

/** Opens `count` tabs (every tenth address repeated, so addresses cannot tell them apart) and names each. */
async function openNamedTabs(running: Running, url: (site: number, query: string) => string) {
  const expected = new Map<string, string>();
  const nameMs: number[] = [];
  for (let i = 0; i < tabCount; i++) {
    const page = await running.context.newPage();
    const address = i % 10 === 0 ? url(1, "same") : url((i % 9) + 1, `tab=${i}`);
    await page.goto(address);
    const tabId = await vi.waitFor(
      async () => {
        const targetId = (
          (await (await running.context.newCDPSession(page)).send("Target.getTargetInfo")) as {
            targetInfo: { targetId: string };
          }
        ).targetInfo.targetId;
        const row = (await running.lifecycle.inventory()).find((t) => t.targetId === targetId);
        expect(row).toBeDefined();
        return row!.tabId;
      },
      { timeout: 5_000, interval: 50 },
    );
    const started = performance.now();
    expect(await running.lifecycle.nameTab(tabId, surface(i))).toBe(true);
    nameMs.push(performance.now() - started);
    // What the address alone cannot say: which of the repeated "same" pages this is.
    await page.evaluate((mark) => sessionStorage.setItem("mark", mark), surface(i));
    expected.set(surface(i), address);
  }
  return { expected, nameMs };
}

function expectCarried(tabs: readonly ChromiumTabEntry[], expected: ReadonlyMap<string, string>) {
  const named = tabs.filter((tab) => tab.identity);
  expect(named).toHaveLength(expected.size);
  expect(new Set(named.map((tab) => tab.identity)).size).toBe(expected.size);
  for (const tab of named) expect(tab.url).toBe(expected.get(tab.identity!));
}

async function sessionFilesHold(directory: string, needle: string): Promise<boolean> {
  const sessions = path.join(directory, "Default", "Sessions");
  const files = await readdir(sessions).catch(() => [] as string[]);
  for (const name of files.filter((file) => file.startsWith("Session_"))) {
    const bytes = await readFile(path.join(sessions, name));
    if (
      bytes.includes(Buffer.from(needle, "utf8")) ||
      bytes.includes(Buffer.from(needle, "utf16le"))
    )
      return true;
  }
  return false;
}

/** Checks (c) and (d) after a restart: every title came back on its own tab, none of them loaded. */
async function expectRestoredByTitle(running: Running, expected: ReadonlyMap<string, string>) {
  const restored = await vi.waitFor(
    async () => {
      const tabs = await profileTabs(running.lifecycle);
      expect(tabs.filter((tab) => tab.identity)).toHaveLength(expected.size);
      return tabs;
    },
    { timeout: 20_000, interval: 200 },
  );
  expectCarried(restored, expected);
  // (d) Reading the title needs no page: most restored tabs are still unloaded.
  const states = new Map<string, number>();
  for (const tab of restored) {
    const key = `${tab.status}/${tab.discarded ? "discarded" : "kept"}/${tab.targetId ? "target" : "no-target"}`;
    states.set(key, (states.get(key) ?? 0) + 1);
  }
  process.stdout.write(
    `${JSON.stringify({ event: "r2.restored", ...Object.fromEntries(states) })}\n`,
  );
  const unloaded = restored.filter((tab) => tab.status === "unloaded");
  expect(unloaded.length).toBeGreaterThan(tabCount / 2);
  // And reading it again does not load them.
  const again = await profileTabs(running.lifecycle);
  expect(again.filter((tab) => tab.status === "unloaded").length).toBeGreaterThanOrEqual(
    unloaded.length,
  );
  return restored;
}

it("carries each tab's Home id in Chromium's own tab group title through discard, clean restart and SIGKILL (R2 a-d, f)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  // (a) The API works in this mode.
  const first = await launch(directory);
  const { expected, nameMs } = await openNamedTabs(first, url);
  const inventoryStarted = performance.now();
  const named = await profileTabs(first.lifecycle);
  const inventoryMs = performance.now() - inventoryStarted;
  expectCarried(named, expected);

  // (b) Discard, including a discard that replaces the tab's id, and a tab discarded twice.
  const victims = named.slice(5, 10);
  const replaced: boolean[] = [];
  for (const tab of victims) {
    const newTabId = await first.lifecycle.discardByTabId(tab.tabId);
    expect(newTabId).not.toBeNull();
    replaced.push(newTabId !== tab.tabId);
  }
  const twice = victims[0]!;
  const twiceNow = (await profileTabs(first.lifecycle)).find((t) => t.identity === twice.identity)!;
  expect(await first.lifecycle.activateByTabId(twiceNow.tabId)).toBe(true);
  await vi.waitFor(
    async () => {
      const row = (await profileTabs(first.lifecycle)).find((t) => t.identity === twice.identity);
      expect(row?.discarded).toBe(false);
    },
    { timeout: 10_000, interval: 100 },
  );
  await first.helper.bringToFront();
  const again = (await profileTabs(first.lifecycle)).find((t) => t.identity === twice.identity)!;
  expect(await first.lifecycle.discardByTabId(again.tabId)).not.toBeNull();
  const afterDiscards = await profileTabs(first.lifecycle);
  expectCarried(afterDiscards, expected);
  for (const tab of victims)
    expect(afterDiscards.find((t) => t.identity === tab.identity)?.discarded).toBe(true);

  // (c) Clean close and restart with session restore.
  await vi.waitFor(async () => expect(await sessionFilesHold(directory, surface(69))).toBe(true), {
    timeout: 15_000,
    interval: 250,
  });
  await first.context.close();
  const second = await launch(directory);
  const restored = await expectRestoredByTitle(second, expected);
  // The title names the tab, not just an address: the "same"-address tabs are told apart by it.
  const sameTabs = restored.filter((tab) => tab.url === url(1, "same"));
  expect(sameTabs.length).toBe(tabCount / 10);
  const probe = sameTabs[3]!;
  expect(await second.lifecycle.activateByTabId(probe.tabId)).toBe(true);
  const probePage = await vi.waitFor(
    async () => {
      for (const page of second.context.pages()) {
        if (page === second.helper || page.url() !== url(1, "same")) continue;
        const mark = await page.evaluate(() => sessionStorage.getItem("mark")).catch(() => null);
        if (mark) return { page, mark };
      }
      throw new Error("Activated tab not yet loaded.");
    },
    { timeout: 10_000, interval: 100 },
  );
  expect(probePage.mark).toBe(probe.identity);

  // (c) SIGKILL with about seventy tabs, then restart.
  await second.helper.bringToFront();
  await vi.waitFor(
    async () => {
      expect(await sessionFilesHold(directory, surface(0))).toBe(true);
      const prefs = JSON.parse(
        await readFile(path.join(directory, "Default", "Preferences"), "utf8"),
      ) as { profile?: { exit_type?: string } };
      expect(prefs.profile?.exit_type).toBe("Crashed");
    },
    { timeout: 15_000, interval: 250 },
  );
  process.kill(-second.pid, "SIGKILL");
  await vi.waitFor(() => expect(second.context.pages()).toHaveLength(0), { timeout: 10_000 });
  const third = await launch(directory);
  await expectRestoredByTitle(third, expected);

  // (f) Cost: one helper call per saved tab when it is first tracked, and an inventory that reads
  // every group title at once.
  const sorted = [...nameMs].sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify({
      event: "r2.cost",
      tabs: tabCount,
      nameMedianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1)),
      nameP95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)),
      inventoryWith70GroupsMs: Number(inventoryMs.toFixed(1)),
      discardReplacedTabId: replaced,
    })}\n`,
  );
}, 240_000);

it("keeps a tab's group out of its page, its picture and its popups (R2 e)", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-picture-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const running = await launch(directory);
  const page = await running.context.newPage();
  await page.goto(url(1, "picture"));
  const cdp = await running.context.newCDPSession(page);
  const look = async () => ({
    shot: ((await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string }).data,
    size: await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]),
  });
  const before = await look();
  const targetId = (
    (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } }
  ).targetInfo.targetId;
  const row = (await running.lifecycle.inventory()).find((t) => t.targetId === targetId)!;
  expect(await running.lifecycle.nameTab(row.tabId, surface(1))).toBe(true);
  const after = await look();
  // The picture a person is streamed is the page's own pixels; the group changes none of them.
  expect(after.size).toEqual(before.size);
  expect(after.shot).toBe(before.shot);

  // A tab opened from a named tab is not named by that: it gets no group title of its own.
  await page.goto(url(1, "x").replace("/page?x", "/opener"));
  const popupPromise = running.context.waitForEvent("page");
  await page.click("#out");
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const popupTargetId = (
    (await (await running.context.newCDPSession(popup)).send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    }
  ).targetInfo.targetId;
  await vi.waitFor(
    async () => {
      const tabs = await running.lifecycle.inventory();
      const popupRow = tabs.find((t) => t.targetId === popupTargetId);
      expect(popupRow).toBeDefined();
      process.stdout.write(
        `${JSON.stringify({ event: "r2.popup", identity: popupRow!.identity ?? null })}\n`,
      );
      expect(tabs.filter((t) => t.identity === surface(1))).toHaveLength(1);
    },
    { timeout: 5_000, interval: 100 },
  );
}, 60_000);

it("probe: a grouped tab keeps the same history and form state through discard and clean restart as an ungrouped one", async () => {
  const url = await fixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-identity-state-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const first = await launch(directory);
  const prepare = async (site: number, name: string | null) => {
    const page = await first.context.newPage();
    await page.goto(url(site, "x").replace("/page?x", "/spa"));
    await page.evaluate(() => {
      history.pushState({ step: 1 }, "", "/spa/step-1");
      history.pushState({ step: 2 }, "", "/spa/step-2");
    });
    await page.fill("#draft", `typed-${site}`);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const cdp = await first.context.newCDPSession(page);
    const targetId = (
      (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } }
    ).targetInfo.targetId;
    const row = (await first.lifecycle.inventory()).find((t) => t.targetId === targetId)!;
    if (name) expect(await first.lifecycle.nameTab(row.tabId, name)).toBe(true);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await cdp.detach();
    expect(await first.lifecycle.discardByTabId(row.tabId)).not.toBeNull();
  };
  await prepare(1, null);
  await prepare(2, surface(2));
  await first.context.close();
  const second = await launch(directory);
  const tabs = await vi.waitFor(
    async () => {
      const rows = (await profileTabs(second.lifecycle)).filter((t) => t.url.includes("/spa"));
      expect(rows).toHaveLength(2);
      return rows;
    },
    { timeout: 20_000, interval: 200 },
  );
  const result: Record<string, unknown> = {};
  for (const row of tabs) {
    expect(await second.lifecycle.activateByTabId(row.tabId)).toBe(true);
    const page = await vi.waitFor(
      async () => {
        const found = second.context
          .pages()
          .find((p) => p !== second.helper && new URL(p.url()).host === new URL(row.url).host);
        expect(found).toBeDefined();
        await found!.waitForLoadState("load");
        return found!;
      },
      { timeout: 10_000, interval: 100 },
    );
    result[row.identity ?? "ungrouped"] = await page.evaluate(() => ({
      path: location.pathname,
      state: history.state,
      length: history.length,
      draft: (document.getElementById("draft") as HTMLInputElement).value,
    }));
  }
  process.stdout.write(`${JSON.stringify({ event: "r2.state", ...result })}\n`);
  expect(result[surface(2)]).toEqual(
    result.ungrouped && { ...(result.ungrouped as object), draft: "typed-2" },
  );
}, 120_000);
