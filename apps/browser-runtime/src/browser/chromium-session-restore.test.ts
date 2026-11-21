import { SurfaceLedger } from "@opensteer/browser-runtime-core";
import { BrowserSurfaceIdSchema, type BrowserSurfaceId } from "@opensteer/protocol/browser";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  browserTestSignal,
  cleanup,
  findChromium,
  TestChromiumLauncher as PlaywrightChromiumLauncher,
} from "./browser-test-lifecycle.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import { ChromiumTabLifecycleBridge } from "./tab-lifecycle-extension.js";

const executablePath = findChromium();

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (url.pathname === "/article") {
      response.end(
        `<!doctype html><html><head><title>Article</title></head><body style="height:8000px">
          <h1>Article</h1>
          <div style="height:7000px">spacer</div>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/form") {
      response.end(
        `<!doctype html><html><head><title>Form</title></head><body>
          <input id="text-input" name="title" type="text" value="" />
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/spa" || url.pathname.startsWith("/spa/")) {
      response.end(
        `<!doctype html><html><head><title>SPA</title></head><body>
          <div id="route"></div>
          <script>document.getElementById("route").textContent = location.pathname;</script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/session-storage") {
      response.end(
        `<!doctype html><html><head><title>SessionStorage</title></head><body>
          <script>window.__readAtLoad = sessionStorage.getItem("wizard_step");</script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/fresh-home") {
      response.end(`<!doctype html><html><body><h1 id="fresh">Fresh Home Tab</h1></body></html>`);
      return;
    }
    if (url.pathname === "/orphan") {
      response.end(`<!doctype html><html><body><h1>Orphan</h1></body></html>`);
      return;
    }
    response.end(`<!doctype html><html><body>ok</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no address.");
  return {
    originForSite: (index: number) => `http://site-${index}.localhost:${address.port}`,
    port: address.port,
  };
}

async function evalValue<T>(
  cdp: { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> },
  expression: string,
): Promise<T> {
  const response = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return response.result?.value as T;
}

async function waitLoaded(
  cdp: { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> },
  expectedPath?: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const state = await evalValue<{ ready: boolean; pathname: string }>(
        cdp,
        "({ ready: document.readyState === 'complete', pathname: location.pathname })",
      );
      expect(state.ready).toBe(true);
      if (expectedPath) expect(state.pathname).toBe(expectedPath);
    },
    { timeout: 10_000, interval: 50 },
  );
}

const surfDupA: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000001",
);
const surfDupB: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000002",
);
const surfForm: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000003",
);
const surfSpa: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000004",
);
const surfSs: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000005",
);
const surfClosedAsleep: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000006",
);
const surfOrphan: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000007",
);
const surfMissing: BrowserSurfaceId = BrowserSurfaceIdSchema.parse(
  "surface_00000000-0000-4000-8000-000000000008",
);

async function populateTabs(
  ledger: SurfaceLedger,
  server: { originForSite(i: number): string },
  includeOrphan: boolean,
) {
  const dupUrl = `${server.originForSite(1)}/article`;
  const formUrl = `${server.originForSite(2)}/form`;
  const spaUrl = `${server.originForSite(3)}/spa`;
  const spaFinalUrl = `${server.originForSite(3)}/spa/step-2`;
  const ssUrl = `${server.originForSite(4)}/session-storage`;
  const closedUrl = `${server.originForSite(5)}/article`;
  const orphanUrl = `${server.originForSite(6)}/orphan`;

  // Duplicate URL tab A (scrollY = 1100, stays live before shutdown)
  await ledger.openSurface({ surfaceId: surfDupA });
  const aLive = ledger.binding(surfDupA)!;
  await aLive.cdp.send("Page.navigate", { url: dupUrl });
  await waitLoaded(aLive.cdp, "/article");
  await evalValue(aLive.cdp, "window.scrollTo(0, 1100)");

  // Duplicate URL tab B (scrollY = 2900, slept before shutdown!)
  await ledger.openSurface({ surfaceId: surfDupB });
  const bLive = ledger.binding(surfDupB)!;
  await bLive.cdp.send("Page.navigate", { url: dupUrl });
  await waitLoaded(bLive.cdp, "/article");
  await evalValue(bLive.cdp, "window.scrollTo(0, 2900)");

  // Form tab (slept before shutdown)
  await ledger.openSurface({ surfaceId: surfForm });
  const formLive = ledger.binding(surfForm)!;
  await formLive.cdp.send("Page.navigate", { url: formUrl });
  await waitLoaded(formLive.cdp, "/form");
  await evalValue(formLive.cdp, "document.getElementById('text-input').focus()");
  await formLive.cdp.send("Input.insertText", { text: "Persisted draft" });
  await evalValue(formLive.cdp, "document.activeElement.blur()");

  // SPA tab with pushState entries (slept before shutdown)
  await ledger.openSurface({ surfaceId: surfSpa });
  const spaLive = ledger.binding(surfSpa)!;
  await spaLive.cdp.send("Page.navigate", { url: spaUrl });
  await waitLoaded(spaLive.cdp, "/spa");
  await evalValue(
    spaLive.cdp,
    `history.pushState({ step: 1 }, "", "/spa/step-1"); history.pushState({ step: 2 }, "", "/spa/step-2");`,
  );

  // sessionStorage tab (slept before shutdown)
  await ledger.openSurface({ surfaceId: surfSs });
  const ssLive = ledger.binding(surfSs)!;
  await ssLive.cdp.send("Page.navigate", { url: ssUrl });
  await waitLoaded(ssLive.cdp, "/session-storage");
  await evalValue(ssLive.cdp, `sessionStorage.setItem("wizard_step", "step-4-confirmed")`);

  // Tab slept then closed while asleep — must NOT come back on restart!
  await ledger.openSurface({ surfaceId: surfClosedAsleep });
  const closedLive = ledger.binding(surfClosedAsleep)!;
  await closedLive.cdp.send("Page.navigate", { url: closedUrl });
  await waitLoaded(closedLive.cdp, "/article");

  // Optional orphan tab that the Home will drop before restart
  if (includeOrphan) {
    await ledger.openSurface({ surfaceId: surfOrphan });
    const orphanLive = ledger.binding(surfOrphan)!;
    await orphanLive.cdp.send("Page.navigate", { url: orphanUrl });
    await waitLoaded(orphanLive.cdp, "/orphan");
  }

  // Sleep B, form, SPA, sessionStorage, and closedAsleep; then close closedAsleep while asleep.
  for (const id of [surfDupB, surfForm, surfSpa, surfSs, surfClosedAsleep]) {
    expect(await ledger.sleep(id, () => null)).toBe(true);
  }
  await ledger.closeSurface(surfClosedAsleep);

  return { dupUrl, formUrl, spaFinalUrl, ssUrl, closedUrl, orphanUrl };
}

it("restores duplicate-URL tabs, slept tabs, session cookies, closes orphans, and opens missing Home tabs by address after clean exit", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-clean-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);

  const browser1 = await launcher.launch(request);
  const ledger1 = new SurfaceLedger(browser1.context, { savedLineageId: "profile-test" });
  await ledger1.start();
  const urls = await populateTabs(ledger1, server, true);
  await browser1.context.sessionRestore!.flush!();

  // Verify session cookies survive alongside session restore!
  await browser1.replaceSiteCookies(
    "http://127.0.0.1",
    [
      {
        name: "session_tok",
        value: "kept-across-restart",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    browserTestSignal(),
  );

  // Wait until Chromium has written a non-empty Session_* file to Default/Sessions/.
  await vi.waitFor(
    async () => {
      const files = await readdir(path.join(directory, "Default", "Sessions")).catch(() => []);
      const sessionFiles = files.filter((name) => name.startsWith("Session_"));
      expect(sessionFiles.length).toBeGreaterThan(0);
      const sizes = await Promise.all(
        sessionFiles.map((name) =>
          stat(path.join(directory, "Default", "Sessions", name)).then((s) => s.size),
        ),
      );
      expect(Math.max(...sizes)).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 100 },
  );
  await ledger1.close();
  await browser1.close();

  // Cold restart on the same native profile!
  const browser2 = await launcher.launch(request);
  cleanup.push(() => browser2.close());
  const internal2 = browser2 as unknown as {
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };

  // Session cookies must still survive!
  const cookieRes = (await browser2.cdp.send("Storage.getCookies")) as {
    cookies: readonly { name: string; value: string; session: boolean }[];
  };
  expect(cookieRes.cookies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "session_tok",
        value: "kept-across-restart",
        session: true,
      }),
    ]),
  );

  // Reconcile against the Home's authoritative tab list:
  // - surfDupA, surfDupB, surfForm, surfSpa, surfSs exist in Home
  // - surfOrphan is NOT in Home -> must be closed in Chromium!
  // - surfClosedAsleep was closed while asleep -> must NOT be in Chromium!
  // - surfMissing is in Home with no restored tab -> must open by address!
  const freshHomeUrl = `${server.originForSite(7)}/fresh-home`;
  const savedTabIds = new Set<BrowserSurfaceId>([
    surfDupA,
    surfDupB,
    surfForm,
    surfSpa,
    surfSs,
    surfMissing,
  ]);
  await browser2.context.sessionRestore!.reconcile(savedTabIds);

  // Orphan tab and tab closed while asleep must be absent from Chromium!
  const invAfterReconcile = await internal2.contextHandle.lifecycle.inventory();
  expect(invAfterReconcile.some((t) => t.url === urls.orphanUrl)).toBe(false);
  expect(invAfterReconcile.some((t) => t.url === urls.closedUrl)).toBe(false);

  const ledger2 = new SurfaceLedger(browser2.context, { savedLineageId: "profile-test" });
  await ledger2.start();
  cleanup.push(() => ledger2.close());

  // Claim BOTH duplicate-URL tabs and verify each came back with its OWN scrollY (1100 vs 2900)!
  await ledger2.openSurface({ surfaceId: surfDupA });
  const aRestored = ledger2.binding(surfDupA)!;
  expect(aRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(aRestored.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(aRestored.cdp, "window.scrollY")).toBe(1100),
    { timeout: 3_000, interval: 50 },
  );

  await ledger2.openSurface({ surfaceId: surfDupB });
  const bRestored = ledger2.binding(surfDupB)!;
  expect(bRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(bRestored.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(bRestored.cdp, "window.scrollY")).toBe(2900),
    { timeout: 3_000, interval: 50 },
  );

  // Form tab came back with typed draft
  await ledger2.openSurface({ surfaceId: surfForm });
  const formRestored = ledger2.binding(surfForm)!;
  expect(formRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(formRestored.cdp, "/form");
  expect(
    await evalValue<string>(formRestored.cdp, "document.getElementById('text-input').value"),
  ).toBe("Persisted draft");

  // SPA tab came back with pushState history & state
  const spaOpened = await ledger2.openSurface({ surfaceId: surfSpa });
  expect(spaOpened.id).toBe(surfSpa);
  const spaRestored = ledger2.binding(surfSpa)!;
  expect(spaRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(spaRestored.cdp, "/spa/step-2");
  expect(await evalValue<unknown>(spaRestored.cdp, "history.state")).toEqual({ step: 2 });

  // sessionStorage tab came back before load scripts
  await ledger2.openSurface({ surfaceId: surfSs });
  const ssRestored = ledger2.binding(surfSs)!;
  expect(ssRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(ssRestored.cdp, "/session-storage");
  expect(await evalValue<string | null>(ssRestored.cdp, "window.__readAtLoad")).toBe(
    "step-4-confirmed",
  );

  // Missing Home tab has no restored Chromium tab -> opens fresh and navigates by address
  await ledger2.openSurface({ surfaceId: surfMissing });
  const missingLive = ledger2.binding(surfMissing)!;
  expect(missingLive.page.restoredFromSession).toBe(false);
  await missingLive.cdp.send("Page.navigate", { url: freshHomeUrl });
  await waitLoaded(missingLive.cdp, "/fresh-home");
  expect(
    await evalValue<string>(missingLive.cdp, "document.getElementById('fresh').textContent"),
  ).toBe("Fresh Home Tab");
});

it("recovers session tabs including duplicate URLs after a SIGKILL crash", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-sigkill-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);

  const browser1 = await launcher.launch(request);
  const ledger1 = new SurfaceLedger(browser1.context, { savedLineageId: "profile-test" });
  await ledger1.start();
  await populateTabs(ledger1, server, false);
  await browser1.context.sessionRestore!.flush!();

  // Wait for Chromium to flush Session_* (2.5 s) and Preferences exit_type="Crashed" (up to 10 s)
  // before hard-killing with SIGKILL.
  await vi.waitFor(
    async () => {
      const prefs = JSON.parse(
        await readFile(path.join(directory, "Default", "Preferences"), "utf8"),
      ) as { profile?: { exit_type?: string } };
      expect(prefs.profile?.exit_type).toBe("Crashed");
      const files = await readdir(path.join(directory, "Default", "Sessions")).catch(() => []);
      const sessionFiles = files.filter((name) => name.startsWith("Session_"));
      expect(sessionFiles.length).toBeGreaterThan(0);
      const sizes = await Promise.all(
        sessionFiles.map((name) =>
          stat(path.join(directory, "Default", "Sessions", name)).then((s) => s.size),
        ),
      );
      expect(Math.max(...sizes)).toBeGreaterThan(0);
    },
    { timeout: 15_000, interval: 250 },
  );
  const internal1 = browser1 as unknown as {
    playwrightContext: { process(): { pid: number } };
  };
  const pid1 = internal1.playwrightContext.process().pid;
  await ledger1.close();
  // Hard crash the Chromium process group with SIGKILL!
  process.kill(-pid1, "SIGKILL");
  await browser1.close().catch(() => undefined);

  const rawPrefs = JSON.parse(
    await readFile(path.join(directory, "Default", "Preferences"), "utf8"),
  ) as { profile?: { exit_type?: string } };
  expect(rawPrefs.profile?.exit_type).toBe("Crashed");

  // Relaunch through PlaywrightChromiumLauncher -> must normalize exit_type and auto-restore!
  const browser2 = await launcher.launch(request);
  cleanup.push(() => browser2.close());
  await browser2.context.sessionRestore!.reconcile(
    new Set<BrowserSurfaceId>([surfDupA, surfDupB, surfForm, surfSpa, surfSs]),
  );

  const ledger2 = new SurfaceLedger(browser2.context, { savedLineageId: "profile-test" });
  await ledger2.start();
  cleanup.push(() => ledger2.close());

  await ledger2.openSurface({ surfaceId: surfDupA });
  const aRestored = ledger2.binding(surfDupA)!;
  await waitLoaded(aRestored.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(aRestored.cdp, "window.scrollY")).toBe(1100),
    { timeout: 3_000, interval: 50 },
  );

  await ledger2.openSurface({ surfaceId: surfDupB });
  const bRestored = ledger2.binding(surfDupB)!;
  await waitLoaded(bRestored.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(bRestored.cdp, "window.scrollY")).toBe(2900),
    { timeout: 3_000, interval: 50 },
  );

  await ledger2.openSurface({ surfaceId: surfForm });
  const formRestored = ledger2.binding(surfForm)!;
  await waitLoaded(formRestored.cdp, "/form");
  expect(
    await evalValue<string>(formRestored.cdp, "document.getElementById('text-input').value"),
  ).toBe("Persisted draft");

  await ledger2.openSurface({ surfaceId: surfSs });
  const ssRestored = ledger2.binding(surfSs)!;
  await waitLoaded(ssRestored.cdp, "/session-storage");
  expect(await evalValue<string | null>(ssRestored.cdp, "window.__readAtLoad")).toBe(
    "step-4-confirmed",
  );
});

it("keeps A2's own state when [A1, A2] share a URL and A1 is deleted in Home while down", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-f5-dup-delete-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);
  const dupUrl = `${server.originForSite(1)}/article`;

  const browser1 = await launcher.launch(request);
  const ledger1 = new SurfaceLedger(browser1.context, { savedLineageId: "profile-f5" });
  await ledger1.start();

  await ledger1.openSurface({ surfaceId: surfDupA });
  const aLive = ledger1.binding(surfDupA)!;
  await aLive.cdp.send("Page.navigate", { url: dupUrl });
  await waitLoaded(aLive.cdp, "/article");
  await evalValue(aLive.cdp, "window.scrollTo(0, 1100)");

  await ledger1.openSurface({ surfaceId: surfDupB });
  const bLive = ledger1.binding(surfDupB)!;
  await bLive.cdp.send("Page.navigate", { url: dupUrl });
  await waitLoaded(bLive.cdp, "/article");
  await evalValue(bLive.cdp, "window.scrollTo(0, 2900)");

  await browser1.context.sessionRestore!.flush!();
  await vi.waitFor(
    async () => {
      const files = await readdir(path.join(directory, "Default", "Sessions")).catch(() => []);
      const sf = files.filter((n) => n.startsWith("Session_"));
      expect(sf.length).toBeGreaterThan(0);
      const sizes = await Promise.all(
        sf.map((n) => stat(path.join(directory, "Default", "Sessions", n)).then((s) => s.size)),
      );
      expect(Math.max(...sizes)).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 100 },
  );
  await ledger1.close();
  await browser1.close();

  // Cold restart with ONLY surfDupB remaining in Home (surfDupA deleted while down).
  const browser2 = await launcher.launch(request);
  cleanup.push(() => browser2.close());
  await browser2.context.sessionRestore!.reconcile(
    new Set<BrowserSurfaceId>([surfDupB]),
    "profile-f5",
  );

  const internal2 = browser2 as unknown as {
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const invAfter = await internal2.contextHandle.lifecycle.inventory();
  expect(invAfter.filter((t) => t.url === dupUrl)).toHaveLength(1);

  const ledger2 = new SurfaceLedger(browser2.context, { savedLineageId: "profile-f5" });
  await ledger2.start();
  cleanup.push(() => ledger2.close());

  await ledger2.openSurface({ surfaceId: surfDupB });
  const bRestored = ledger2.binding(surfDupB)!;
  expect(bRestored.page.restoredFromSession).toBe(true);
  await waitLoaded(bRestored.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(bRestored.cdp, "window.scrollY")).toBe(2900),
    { timeout: 3_000, interval: 50 },
  );
});

it("fails closed on launch inventory failure by closing every restored non-helper page target", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-f9-fail-closed-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);
  const savedUrl = `${server.originForSite(1)}/article`;

  const browser1 = await launcher.launch(request);
  const ledger1 = new SurfaceLedger(browser1.context, { savedLineageId: "profile-f9" });
  await ledger1.start();
  await ledger1.openSurface({ surfaceId: surfDupA });
  const live1 = ledger1.binding(surfDupA)!;
  await live1.cdp.send("Page.navigate", { url: savedUrl });
  await waitLoaded(live1.cdp, "/article");
  await browser1.context.sessionRestore!.flush!();
  await vi.waitFor(
    async () => {
      const files = await readdir(path.join(directory, "Default", "Sessions")).catch(() => []);
      const sf = files.filter((n) => n.startsWith("Session_"));
      expect(sf.length).toBeGreaterThan(0);
      const sizes = await Promise.all(
        sf.map((n) => stat(path.join(directory, "Default", "Sessions", n)).then((s) => s.size)),
      );
      expect(Math.max(...sizes)).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 100 },
  );
  await ledger1.close();
  await browser1.close();

  // Fail launch-time inventory once -> launcher must fail closed, close every restored page target, and leave zero unowned pages!
  const invSpy = vi
    .spyOn(ChromiumTabLifecycleBridge.prototype, "inventory")
    .mockRejectedValueOnce(new Error("Helper worker failed at launch"));
  const browser2 = await launcher.launch(request);
  invSpy.mockRestore();
  cleanup.push(() => browser2.close());

  expect(browser2.context.pages()).toHaveLength(0);
  expect(browser2.context.sessionRestore).toBeUndefined();
  const internal2 = browser2 as unknown as {
    browserCdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
  };
  const targets = (await internal2.browserCdp.send("Target.getTargets")) as {
    targetInfos: readonly { type: string; url: string }[];
  };
  const pageTargets = targets.targetInfos.filter((t) => t.type === "page");
  // Only the private blank anchor page should remain; the restored /article page must be closed!
  expect(pageTargets.some((t) => t.url.includes("/article"))).toBe(false);
  expect(pageTargets.length).toBeLessThanOrEqual(1);
});

it("handles a fresh native launch with no restored tabs cleanly under the Playwright defer-restore patch", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-no-restore-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);

  const browser = await launcher.launch(request);
  cleanup.push(() => browser.close());

  // Fresh profile with --restore-last-session exposes zero spurious pages and keeps session cookies working.
  expect(browser.context.pages()).toHaveLength(0);
  await browser.context.sessionRestore!.reconcile(new Set());

  const ledger = new SurfaceLedger(browser.context, { savedLineageId: "profile-fresh" });
  await ledger.start();
  cleanup.push(() => ledger.close());

  const opened = await ledger.openSurface();
  const live = ledger.binding(opened.id)!;
  expect(live.page.restoredFromSession).toBe(false);
  await live.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/fresh-home` });
  await waitLoaded(live.cdp, "/fresh-home");
  expect(await evalValue<string>(live.cdp, "document.getElementById('fresh').textContent")).toBe(
    "Fresh Home Tab",
  );
});

it("discards all parked saved tabs on reconcile so Chromium never runs unowned background pages (R1)", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-session-restore-r1-parked-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);
  const surfaceIds = Array.from({ length: 6 }, (_, i) =>
    BrowserSurfaceIdSchema.parse(`srf_00000000-0000-4000-8000-00000000r10${i}`),
  );
  const urls = surfaceIds.map((_, i) => `${server.originForSite(i + 1)}/article?tab=p${i}`);

  const browser1 = await launcher.launch(request);
  cleanup.push(() => browser1.close());
  const ledger1 = new SurfaceLedger(browser1.context, { savedLineageId: "lineage-r1" });
  await ledger1.start();
  for (let i = 0; i < surfaceIds.length; i++) {
    await ledger1.openSurface({ surfaceId: surfaceIds[i]! });
    const live = ledger1.binding(surfaceIds[i]!)!;
    await live.cdp.send("Page.navigate", { url: urls[i]! });
    await waitLoaded(live.cdp, "/article");
    if (i === 4) {
      await evalValue(
        live.cdp,
        `window.scrollTo(0, 1200); sessionStorage.setItem("r1_key", "r1-preserved"); window.scrollY;`,
      );
      // Force Blink's throttled UpdateState IPC to flush scrollY=1200 into Chromium's
      // NavigationEntry before the test closes the browser (while keeping p4 live).
      await live.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      await live.cdp.send("Page.setWebLifecycleState", { state: "active" });
    }
  }
  await browser1.context.sessionRestore!.flush!();
  await vi.waitFor(
    async () => {
      const sessionsDir = path.join(directory, "Default", "Sessions");
      const files = (await readdir(sessionsDir).catch(() => [])).filter((n) =>
        n.startsWith("Session_"),
      );
      expect(files.length).toBeGreaterThan(0);
      const { readFile } = await import("node:fs/promises");
      const all = (
        await Promise.all(files.map((n) => readFile(path.join(sessionsDir, n), "latin1")))
      ).join("\n");
      for (let i = 0; i < surfaceIds.length; i++) {
        expect(all).toContain(`tab=p${i}`);
      }
    },
    { timeout: 10_000, interval: 100 },
  );
  await ledger1.close();
  await browser1.close();

  const browser2 = await launcher.launch(request);
  cleanup.push(() => browser2.close());

  // Claim ONLY tab 0, then reconcile all 6 saved tabs.
  const ledger2 = new SurfaceLedger(browser2.context, { savedLineageId: "lineage-r1" });
  await ledger2.start();
  cleanup.push(() => ledger2.close());
  await ledger2.openSurface({ surfaceId: surfaceIds[0]! });
  await browser2.context.sessionRestore!.reconcile(new Set(surfaceIds), "lineage-r1");

  const lifecycle2 = (
    browser2 as unknown as {
      contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
    }
  ).contextHandle.lifecycle;
  const inv = await lifecycle2.inventory();
  const profileTabs = inv.filter(
    (t) => t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
  );
  expect(profileTabs).toHaveLength(6);
  const liveProfileTabs = profileTabs.filter((t) => !t.discarded && t.targetId !== null);
  expect(liveProfileTabs).toHaveLength(1);
  expect(liveProfileTabs[0]!.url).toContain("tab=p0");
  const parkedTabs = profileTabs.filter((t) => !t.url.includes("tab=p0"));
  expect(parkedTabs.map((t) => ({ discarded: t.discarded, status: t.status }))).toEqual(
    parkedTabs.map(() => ({ discarded: true, status: "unloaded" })),
  );
  // Only the claimed tab has a live Playwright Page in the context (zero parked live pages).
  expect(browser2.context.pages()).toHaveLength(1);
  expect(browser2.context.pages()[0]!.url()).toContain("tab=p0");

  // Claim parked tab 4 later -> wakes with scroll state, sessionStorage, AND page policy script intact!
  await ledger2.openSurface({ surfaceId: surfaceIds[4]! });
  const live4 = ledger2.binding(surfaceIds[4]!)!;
  expect(live4.page.restoredFromSession).toBe(true);
  await waitLoaded(live4.cdp, "/article");
  await vi.waitFor(
    async () => {
      expect(await evalValue<number>(live4.cdp, "window.scrollY")).toBe(1200);
    },
    { timeout: 5_000, interval: 100 },
  );
  expect(await evalValue<string | null>(live4.cdp, `sessionStorage.getItem("r1_key")`)).toBe(
    "r1-preserved",
  );
  // Verify page policy script is active on both the initial restored tab and woken parked tab (R9).
  for (const id of [surfaceIds[0]!, surfaceIds[4]!]) {
    const live = ledger2.binding(id)!;
    const policyMsg = await evalValue<string>(
      live.cdp,
      `Promise.race([
        navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } }).then(() => "allowed", (e) => e.message),
        new Promise((r) => setTimeout(() => r("HUNG_NO_POLICY"), 1000)),
      ])`,
    );
    expect(policyMsg, `policy missing on ${id}`).toBe("Passkeys aren't available in this browser.");
  }
}, 60_000);
