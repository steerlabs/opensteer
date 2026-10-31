import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  agentCdpAllowlist,
  defaultBrowserViewport,
  ExecutionContextInventory,
  SessionCdpRouter,
  type CdpParameters,
} from "@opensteer/browser-core";
import {
  captureBrowserProfileSnapshot,
  encodeBrowserProfileSnapshot,
  decodeBrowserProfileSnapshot,
  type BrowserOriginCaptureFailure,
  type BrowserProfileSnapshot,
  type BrowserCookie,
} from "@opensteer/browser-profile/snapshot";
import {
  BrowserSessionIdSchema,
  type BrowserClientMessage,
  type BrowserSurfaceId,
} from "@opensteer/protocol";
import {
  BrowserController,
  BrowserRuntime,
  SessionFiles,
  stageFileMethod,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import {
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  testSessionFilesRoot,
  validClaims,
  validProfileClaims,
} from "@opensteer/browser-runtime-core/test-support";
import { runPasskeyPolicyScenario } from "@opensteer/browser-runtime-core/test-support/passkey-policy";
import { runStateImportScenario } from "@opensteer/browser-runtime-core/test-support/state-import";
import { PublicBrowserEgressProxy } from "../egress-proxy.js";
import {
  TestChromiumLauncher as PlaywrightChromiumLauncher,
  browserTestSignal,
  cleanup,
  waitForLedgerState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

import {
  executablePath,
  serveFollowFixture,
  startHarnessBridge,
  runHarness,
  testSignIns,
  boundarySecrets,
  serveBoundaryFixture,
  sendAsAgent,
  foundSecrets,
  evaluationValue,
  shownDialog,
  asJsonRecord,
  asRecord,
  waitForAsync,
  waitFor,
} from "./chromium.test-support.js";
async function verifyNativeProfilePersistence(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "os-native-chromium-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const site = createServer((request, response) => {
    if (request.url === "/worker.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(
        "self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
      );
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Native storage</title>");
    }
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) =>
      site.close((error) => (error ? reject(error) : resolve())),
    );
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing test site");
  const origin = `http://127.0.0.1:${address.port}`;
  const launcher = new PlaywrightChromiumLauncher({
    chromiumSandbox: false,
    executablePath,
    headless: true,
  });
  const { nativeProfileRequest } = await import("./native-profile.test-support.js");
  const request = nativeProfileRequest(directory);
  const open = () => launcher.launch(request);
  let browser = await open();
  cleanup.push(() => browser.close());
  const firstProcesses = asRecord(await browser.cdp.send("SystemInfo.getProcessInfo"))
    .processInfo as Array<{ type: string; id: number }>;
  const firstPid = firstProcesses.find((p) => p.type === "browser")!.id;
  expect(browser.context.pages()).toHaveLength(0);
  const targets = (await browser.cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  for (const target of targets.targetInfos.filter((target) => target.type === "page")) {
    await expect(browser.cdp.attach(target.targetId)).rejects.toThrow(/not an attachable page/);
  }
  const page = await browser.context.createPage();
  const cdp = await page.cdp();
  await cdp.send("Page.enable");
  const loaded = Promise.withResolvers<void>();
  cdp.on("Page.loadEventFired", () => loaded.resolve());
  await cdp.send("Page.navigate", { url: origin });
  await withTimeout(loaded.promise, 5000, {
    timeoutError: () => new Error("Native profile fixture never loaded"),
  });
  await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `(async () => {
      localStorage.setItem("native", "retained");
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open("native", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("values");
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      const tx = db.transaction("values", "readwrite", { durability: "strict" });
      tx.objectStore("values").put("retained", "native");
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      db.close();
      await (await caches.open("native")).put("/cached", new Response("retained"));
      await navigator.serviceWorker.register("/worker.js");
      await navigator.serviceWorker.ready;
    })()`,
  });
  const cookie = (name: string, expires: number, value = "retained"): BrowserCookie => ({
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
    expires,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
  await browser.replaceSiteCookies(
    "http://127.0.0.1",
    [cookie("session", -1), cookie("persistent", Math.floor(Date.now() / 1000) + 3600)],
    browserTestSignal(),
  );
  await browser.close();
  expect(() => process.kill(firstPid, 0)).toThrow();
  browser = await open();
  expect(browser.context.pages()).toHaveLength(0);
  const assertState = async (sessionValue = "retained") => {
    const cookies = asRecord(await browser.cdp.send("Storage.getCookies")).cookies as Array<{
      name: string;
      value: string;
      session: boolean;
    }>;
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "session", value: sessionValue, session: true }),
        expect.objectContaining({ name: "persistent", value: "retained", session: false }),
      ]),
    );
    const page = await browser.context.createPage();
    const cdp = await page.cdp();
    await cdp.send("Page.enable");
    const loaded = Promise.withResolvers<void>();
    cdp.on("Page.loadEventFired", () => loaded.resolve());
    await cdp.send("Page.navigate", { url: origin });
    await withTimeout(loaded.promise, 5000, {
      timeoutError: () => new Error("Reopened profile fixture never loaded"),
    });
    const state = await cdp.send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
        const db = await new Promise((resolve, reject) => { const open = indexedDB.open("native"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        const value = await new Promise((resolve, reject) => { const r = db.transaction("values").objectStore("values").get("native"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
        return { local: localStorage.getItem("native"), indexedDB: value, cache: await (await caches.match("/cached")).text(), worker: (await navigator.serviceWorker.getRegistration()).active.state };
      })()`,
      },
    );
    expect(state.exceptionDetails).toBeUndefined();
    expect(state.result.value).toEqual({
      local: "retained",
      indexedDB: "retained",
      cache: "retained",
      worker: "activated",
    });
  };
  await assertState();
  // The replacement must flush while the browser remains open; kill that exact owner immediately.
  await browser.replaceSiteCookies(
    "http://127.0.0.1",
    [
      cookie("session", -1, "committed-before-crash"),
      cookie("persistent", Math.floor(Date.now() / 1000) + 3600),
    ],
    browserTestSignal(),
  );
  const processes = asRecord(await browser.cdp.send("SystemInfo.getProcessInfo"))
    .processInfo as Array<{ type: string; id: number }>;
  const pid = processes.find((p) => p.type === "browser")!.id;
  const closed = Promise.withResolvers<void>();
  browser.onClose(() => closed.resolve());
  process.kill(pid, "SIGKILL");
  await withTimeout(closed.promise, 5000, {
    timeoutError: () => new Error("Crashed Chromium never disconnected"),
  });
  await browser.close();
  browser = await open();
  expect(browser.context.pages()).toHaveLength(0);
  await assertState("committed-before-crash");
  const guest = await launcher.launch({
    ...request,
    storage: { kind: "guest" },
    partitionKey: `session:${request.sessionId}`,
  });
  expect(asRecord(await guest.cdp.send("Storage.getCookies")).cookies).toEqual([]);
  await guest.close();
  await launcher.localProfiles!.release(directory);
  expect(browser.context.isConnected?.()).toBe(false);
}

async function verifyNativeProfileConversion(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "os-native-convert-"));
  const rejectedDirectory = await mkdtemp(join(tmpdir(), "os-native-reject-"));
  const launcher = new PlaywrightChromiumLauncher({
    chromiumSandbox: false,
    executablePath,
    headless: true,
  });
  cleanup.push(async () => {
    await launcher.localProfiles.release(directory);
    await launcher.localProfiles.release(rejectedDirectory);
    await rm(directory, { recursive: true, force: true });
    await rm(rejectedDirectory, { recursive: true, force: true });
  });
  const { nativeProfileRequest } = await import("./native-profile.test-support.js");
  const request = nativeProfileRequest(directory);
  const cookie = {
    domain: "native-import.invalid",
    path: "/",
    name: "session",
    value: "converted",
    httpOnly: true,
    secure: true,
    expires: -1,
    sameSite: "None" as const,
  };
  const seed: BrowserProfileSnapshot = {
    cookies: [
      cookie,
      ...["https://one.example", "https://two.example"].map((partitionKey) => ({
        ...cookie,
        name: "chips",
        partitionKey,
        partitionKeyHasCrossSiteAncestor: false,
        value: partitionKey,
      })),
    ],
    origins: ["https://native-import.invalid", "https://second-import.invalid"].map((origin) => ({
      origin,
      localStorage: [{ name: "converted", value: origin }],
      indexedDB: [
        {
          name: "converted",
          version: 1,
          stores: [
            {
              name: "values",
              autoIncrement: false,
              indexes: [],
              records: [{ key: "record", value: { converted: true } }],
            },
          ],
        },
      ],
    })),
  };
  await launcher.localProfiles.importAndFlush({
    directory,
    binding: request.storage.binding,
    snapshot: seed,
    signal: browserTestSignal(),
  });
  const browser = await launcher.launch(request);
  cleanup.push(() => browser.close());
  expect(browser.context.pages()).toHaveLength(0);
  const snapshot = await browser.exportSnapshot();
  const page = await browser.context.createPage();
  const cdp = await page.cdp();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", (value) => {
    const event = asRecord(value);
    void cdp.send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/html" }],
      body: Buffer.from("<!doctype html><html></html>").toString("base64"),
    });
  });
  await cdp.send("Page.enable");
  for (const state of seed.origins) {
    const loaded = Promise.withResolvers<void>();
    const listener = () => loaded.resolve();
    cdp.on("Page.loadEventFired", listener);
    await cdp.send("Page.navigate", { url: state.origin });
    await withTimeout(loaded.promise, 5000, {
      timeoutError: () => new Error("Converted origin helper did not load"),
    });
    cdp.off("Page.loadEventFired", listener);
    const result = await cdp.send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
        const db = await new Promise((resolve, reject) => { const open = indexedDB.open("converted"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        const record = await new Promise((resolve, reject) => { const read = db.transaction("values").objectStore("values").get("record"); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); db.close();
        return { local: localStorage.getItem("converted"), record };
      })()`,
      },
    );
    expect(result.exceptionDetails).toBeUndefined();
    expect(result.result.value).toEqual({ local: state.origin, record: { converted: true } });
  }
  expect(snapshot.cookies).toEqual(
    expect.arrayContaining(seed.cookies.map((cookie) => expect.objectContaining(cookie))),
  );
  await browser.close();
  await expect(
    launcher.localProfiles.importAndFlush({
      directory: rejectedDirectory,
      binding: nativeProfileRequest(rejectedDirectory).storage.binding,
      snapshot: { cookies: [{ ...cookie, secure: false }], origins: [] },
      signal: browserTestSignal(),
    }),
  ).rejects.toThrow(/rejected an imported profile cookie/);
}

describe("real Chromium runtime", () => {
  it("persists full-navigation fragments and detects durable URL overflow in the real engine", async () => {
    const site = await serveFollowFixture();
    cleanup.push(() => site.close());
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch({
      initialViewport: { devicePixelRatio: 1, ...defaultBrowserViewport },
      partitionKey: `session:${randomUUID()}`,
      sessionId: validClaims().sessionId,
      storage: { kind: "guest" },
    });
    cleanup.push(() => browser.close());
    const pageCdp = await browser.context.pages()[0]!.cdp();
    const overflowReceived = Promise.withResolvers<void>();
    let releaseOverflow: (() => void) | undefined;
    const on = pageCdp.on.bind(pageCdp);
    const off = pageCdp.off.bind(pageCdp);
    const listeners = new Map<(value: unknown) => void, (value: unknown) => void>();
    vi.spyOn(pageCdp, "on").mockImplementation((event, listener) => {
      if (event !== "Page.frameNavigated") return on(event, listener);
      const wrapped = (value: unknown) => {
        const frame = asRecord(asRecord(value)?.frame);
        if (typeof frame?.urlFragment === "string" && frame.urlFragment.length > 16384) {
          releaseOverflow = () => listener(value);
          overflowReceived.resolve();
        } else listener(value);
      };
      listeners.set(listener, wrapped);
      on(event, wrapped);
    });
    vi.spyOn(pageCdp, "off").mockImplementation((event, listener) =>
      off(event, listeners.get(listener) ?? listener),
    );
    const ledger = new SurfaceLedger(browser.context);
    await ledger.start();
    cleanup.push(() => ledger.close());
    const binding = ledger.binding(ledger.snapshot()[0]!.id)!;
    const fragmentUrl = `${site.origin}/plain#/document/42`;
    await binding.cdp.send("Page.navigate", { url: fragmentUrl });
    await waitForLedgerState(ledger, () => ledger.durableSnapshot()[0]?.url === fragmentUrl);
    expect(ledger.durableSnapshot()[0]?.url).toBe(fragmentUrl);
    const reloaded = new Promise<void>((resolve) => {
      const loaded = () => {
        binding.cdp.off("Page.loadEventFired", loaded);
        resolve();
      };
      binding.cdp.on("Page.loadEventFired", loaded);
    });
    await binding.cdp.send("Page.reload");
    await withBrowserTestSignal(reloaded);
    expect(ledger.durableSnapshot()[0]?.url).toBe(fragmentUrl);
    const longUrl = `${site.origin}/plain?q=${"x".repeat(9000)}#/document/43`;
    await binding.cdp.send("Page.navigate", { url: longUrl });
    await waitForLedgerState(ledger, () => ledger.durableSnapshot()[0]?.url === longUrl);
    expect(ledger.durableSnapshot()[0]?.url).toBe(longUrl);
    const overflowUrl = `${site.origin}/plain#${"x".repeat(16400)}`;
    await binding.cdp.send("Page.navigate", { url: overflowUrl });
    await waitFor(() => binding.page.url() === overflowUrl);
    await withBrowserTestSignal(overflowReceived.promise);
    // Live Playwright URL can lead the ledger's CDP acknowledgement on another channel.
    const release = setImmediate(() => releaseOverflow?.());
    cleanup.push(async () => {
      clearImmediate(release);
      releaseOverflow = undefined;
    });
    await waitForLedgerState(
      ledger,
      () => ledger.durableSnapshot()[0]?.url === "opensteer:unavailable-url",
    );
    expect(ledger.durableSnapshot()[0]?.url).toBe("opensteer:unavailable-url");
    const artifact = join(
      process.env.OPENSTEER_DURABLE_URL_EVIDENCE_DIR ?? tmpdir(),
      "durable-url-engine.json",
    );
    await mkdir(join(artifact, ".."), { recursive: true });
    await writeFile(
      artifact,
      JSON.stringify(
        {
          engine: "Playwright Chromium",
          executablePath,
          fragmentUrl,
          longUrlLength: longUrl.length,
          overflowUrlLength: overflowUrl.length,
          descriptor: ledger.durableSnapshot()[0],
        },
        null,
        2,
      ),
    );
  });
  it("streams independent X/Y/Z targets and reads page references without selecting a popup", async () => {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const elapsed = () => performance.now() - started;
    const site = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      const mode = new URL(request.url ?? "/", "http://fixture").searchParams.get("mode");
      response.end(
        `<!doctype html><title>${mode ?? "page"}</title><style>body{margin:0;background:${mode === "y" ? "#10a020" : mode === "z" ? "#2040e0" : "#e09020"}}textarea{position:fixed;inset:0;width:100%;height:100%}</style>${mode === "password" ? '<input type="password">' : mode === "card" ? '<input autocomplete="cc-number">' : mode === "otp" ? '<input autocomplete="one-time-code">' : mode === "iframe" ? `<iframe src="http://localhost:${(site.address() as { port: number }).port}/?mode=password"></iframe>` : '<textarea aria-label="Editing"></textarea>'}<script>window.clicks=0;addEventListener('mousedown',()=>window.clicks++);</script>`,
      );
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const claims = validClaims();
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch({
      initialViewport: { devicePixelRatio: 1, width: 800, height: 600 },
      partitionKey: `session:${claims.sessionId}`,
      sessionId: claims.sessionId,
      storage: { kind: "guest" },
    });
    cleanup.push(() => browser.close());
    const root = browser.context.pages()[0];
    if (!root) throw new Error("Missing root");
    const router = new SessionCdpRouter(browser.cdp);
    cleanup.push(() => router.close());
    const files = new SessionFiles(join(tmpdir(), `opensteer-targeted-${randomUUID()}`));
    const ledger = new SurfaceLedger(browser.context, {
      claimTarget: (targetId) => router.claimTarget(claims.sessionId, targetId),
      rootPages: [root],
      initialViewport: { devicePixelRatio: 1, width: 800, height: 600 },
    });
    const targetId = await root.targetId();
    router.registerSession(
      claims.sessionId,
      targetId,
      (id) => ledger.resolveTarget(id),
      files.root,
    );
    await ledger.start();
    cleanup.push(() => ledger.close());
    const sink = new FakeSink();
    const controller = new BrowserController({
      cdpRouter: router,
      claims,
      ledger,
      files,
      sink,
      exportSnapshot: () => browser.exportSnapshot(),
      replaceSiteCookies: (site, cookies, signal) =>
        browser.replaceSiteCookies(site, cookies, signal),
      signIns: testSignIns(),
    });
    await controller.start();
    cleanup.push(() => controller.close());
    const actorToken = randomUUID();
    const request = (method: string, parameters?: CdpParameters, sessionId?: string) =>
      sendAsAgent(
        (message) =>
          controller.handle({
            ...message,
            ...(message.type === "cdp.command" ? { actorToken } : {}),
          }),
        sink.messages,
        method,
        parameters,
        sessionId,
      );
    const attach = async (id: string) =>
      String(
        asRecord(await request("Target.attachToTarget", { targetId: id, flatten: true })).sessionId,
      );
    const x = ledger.surfaceIdForTarget(targetId)!;
    const xSession = await attach(targetId);
    await controller.handle({ type: "navigation.go", surfaceId: x, url: `${origin}/?mode=x` });
    const create = async (mode: string) => {
      const id = String(
        asRecord(await request("Target.createTarget", { url: `${origin}/?mode=${mode}` })).targetId,
      );
      await waitForAsync(async () => ledger.surfaceIdForTarget(id) !== undefined);
      return {
        targetId: id,
        surfaceId: ledger.surfaceIdForTarget(id)!,
        cdpSession: await attach(id),
      };
    };
    const y = await create("y");
    const z = await create("z");
    for (const surfaceId of [x, y.surfaceId, z.surfaceId])
      await controller.handle({ type: "stream.subscribe", surfaceId });
    await waitFor(() =>
      [x, y.surfaceId, z.surfaceId].every((id) =>
        sink.frames.some((frame) => frame.header.surfaceId === id),
      ),
    );
    timings.firstFramesMs = elapsed();
    expect(ledger.active()?.surface.id).toBe(x);
    const sizesBefore = [x, y.surfaceId, z.surfaceId].map((id) => ledger.viewportOf(id));
    await controller.handle({
      type: "input.pointer",
      targeted: true,
      surfaceId: x,
      action: "down",
      button: "left",
      x: 0.5,
      y: 0.5,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    await controller.handle({
      type: "input.pointer",
      targeted: true,
      surfaceId: x,
      action: "up",
      button: "left",
      x: 0.5,
      y: 0.5,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    await controller.handle({
      type: "clipboard.paste",
      targeted: true,
      surfaceId: x,
      text: "person editing X",
    });
    await request(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 120, y: 90, button: "left", clickCount: 1 },
      y.cdpSession,
    );
    await request(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 120, y: 90, button: "left", clickCount: 1 },
      y.cdpSession,
    );
    expect(
      evaluationValue(
        await request(
          "Runtime.evaluate",
          { expression: "document.querySelector('textarea').value", returnByValue: true },
          xSession,
        ),
      ),
    ).toBe("person editing X");
    expect(
      evaluationValue(
        await request(
          "Runtime.evaluate",
          { expression: "window.clicks", returnByValue: true },
          y.cdpSession,
        ),
      ),
    ).toBe(1);
    expect(ledger.active()?.surface.id).toBe(x);
    expect([x, y.surfaceId, z.surfaceId].map((id) => ledger.viewportOf(id))).toEqual(sizesBefore);
    const pointer = sink.messages.findLast(
      (message) =>
        message.type === "browser.activity" &&
        message.surfaceId === y.surfaceId &&
        message.pointer !== null,
    );
    expect(pointer).toMatchObject({
      actorToken,
      surfaceId: y.surfaceId,
      pointer: { x: 0.15, y: 0.15 },
    });
    expect(
      sink.frames.findLast((frame) => frame.header.surfaceId === y.surfaceId)?.header
        .geometryRevision,
    ).toBe(pointer?.type === "browser.activity" ? pointer.geometryRevision : -1);
    const candidates: unknown[] = [];
    const candidateFor = async (
      mode: string,
      surfaceId: BrowserSurfaceId,
      url: string,
      title: string,
    ) => {
      // A title is the document's own, published once the page itself names it.
      await waitFor(
        () =>
          ledger.binding(surfaceId)?.surface.title === title.slice(0, 1_000) &&
          ledger.committedUrl(surfaceId) === url,
      );
      const surface = ledger.binding(surfaceId)!.surface;
      expect(surface.documentId).toBeTruthy();
      const checkedAfter = Date.now();
      const since = elapsed();
      const candidate = asRecord(await request("Opensteer.contextCandidate", { surfaceId }));
      const durationMs = elapsed() - since;
      expect(candidate).toEqual({
        sessionId: claims.sessionId,
        tabId: surfaceId,
        documentId: surface.documentId,
        title: title.slice(0, 256),
        url: url.length <= 2048 ? url : "",
        eligibility: "eligible",
        reason: null,
        checkedAt: expect.any(String),
      });
      expect(Date.parse(String(candidate.checkedAt))).toBeGreaterThanOrEqual(checkedAfter);
      expect(Date.parse(String(candidate.checkedAt))).toBeLessThanOrEqual(Date.now());
      expect(durationMs).toBeLessThan(1_000);
      candidates.push({ mode, durationMs, ...candidate });
      return candidate;
    };
    for (const mode of ["password", "card", "otp", "iframe", "safe"]) {
      const url = `${origin}/?mode=${mode}`;
      await controller.handle({ type: "navigation.go", surfaceId: y.surfaceId, url });
      await waitForAsync(
        async () =>
          evaluationValue(
            await request(
              "Runtime.evaluate",
              { expression: "document.readyState", returnByValue: true },
              y.cdpSession,
            ),
          ) === "complete",
      );
      await waitFor(() => ledger.binding(y.surfaceId)?.surface.title === mode);
      await candidateFor(mode, y.surfaceId, url, mode);
    }
    const waitingForPerson = request(
      "Runtime.evaluate",
      {
        expression: "new Promise((resolve) => { window.finishAgentWait = resolve; })",
        awaitPromise: true,
      },
      y.cdpSession,
    );
    const personChannel = await ledger.binding(y.surfaceId)!.page.cdp();
    await waitForAsync(async () => {
      const value = await personChannel.send("Runtime.evaluate", {
        expression: "typeof window.finishAgentWait === 'function'",
        returnByValue: true,
      });
      return evaluationValue(value) === true;
    });
    const independentCandidate = await candidateFor(
      "agent-awaiting-person",
      y.surfaceId,
      `${origin}/?mode=safe`,
      "safe",
    );
    const independentOpen = asRecord(
      await request("Opensteer.openTab", { idempotencyKey: randomUUID() }),
    );
    await request("Opensteer.closeTab", {
      surfaceId: independentOpen.tabId,
      inventoryRevision: ledger.inventoryRevision,
    });
    await personChannel.send("Runtime.evaluate", {
      expression: "window.finishAgentWait(true)",
      returnByValue: true,
    });
    await waitingForPerson;
    await request(
      "Runtime.evaluate",
      {
        expression: `document.body.innerHTML = '<div id="shadow"></div>'; document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML = '<input type="password">'; Document.prototype.querySelector = () => null; true`,
        returnByValue: true,
      },
      y.cdpSession,
    );
    await candidateFor("shadow-root-form", y.surfaceId, `${origin}/?mode=safe`, "safe");
    const longTitle = "Page reference ".repeat(24).trim();
    const titledDocument = ledger.binding(y.surfaceId)!.surface.documentId;
    // Agents' discovery is their own; the page's title is read with it off.
    await request("Target.setDiscoverTargets", { discover: false });
    await request(
      "Runtime.evaluate",
      { expression: `document.title = ${JSON.stringify(longTitle)}`, returnByValue: true },
      y.cdpSession,
    );
    // Chromium reports no title change: Target.targetInfoChanged follows the
    // address, not a script's rename (measured on Chromium 151), and Playwright
    // has no title event. A metadata hint asks the page again.
    await ledger.refresh(y.surfaceId);
    await candidateFor("bounded-title", y.surfaceId, `${origin}/?mode=safe`, longTitle);
    expect(ledger.binding(y.surfaceId)!.surface.documentId).toBe(titledDocument);
    const longUrl = `${origin}/?mode=safe#${"x".repeat(2048)}`;
    await request("Page.navigate", { url: longUrl }, y.cdpSession);
    await waitFor(() => ledger.binding(y.surfaceId)?.page.url() === longUrl);
    await candidateFor("overlong-address", y.surfaceId, longUrl, longTitle);
    const changing = await create("changing");
    await waitForAsync(
      async () =>
        evaluationValue(
          await request(
            "Runtime.evaluate",
            {
              expression:
                "document.readyState === 'complete' && location.href.includes('mode=changing')",
              returnByValue: true,
            },
            changing.cdpSession,
          ),
        ) === true,
    );
    await request(
      "Runtime.evaluate",
      {
        expression: `document.body.innerHTML = '<iframe id="changing"></iframe>'; true`,
        returnByValue: true,
      },
      changing.cdpSession,
    );
    const changingDiagnostic = ledger.binding(changing.surfaceId)!.cdp;
    const frameTree = asRecord(await changingDiagnostic.send("Page.getFrameTree"));
    const childFrames = asRecord(frameTree.frameTree).childFrames;
    if (!Array.isArray(childFrames) || childFrames.length !== 1)
      throw new Error("Missing changing frame.");
    const frameId = asRecord(asRecord(childFrames[0]).frame).id;
    await waitFor(() => ledger.binding(changing.surfaceId)?.surface.title === "changing");
    const churnStarted = elapsed();
    const changed = changingDiagnostic.send("Page.navigate", {
      frameId,
      url: "about:blank?changed",
    });
    await candidateFor(
      "frame-navigation",
      changing.surfaceId,
      `${origin}/?mode=changing`,
      "changing",
    );
    timings.churnCheckMs = elapsed() - churnStarted;
    await changed;
    await ledger.closeSurface(changing.surfaceId);
    const paused = await create("paused");
    await waitForAsync(
      async () =>
        evaluationValue(
          await request(
            "Runtime.evaluate",
            {
              expression:
                "document.readyState === 'complete' && location.href.includes('mode=paused')",
              returnByValue: true,
            },
            paused.cdpSession,
          ),
        ) === true,
    );
    timings.churnRecoveryMs = elapsed() - churnStarted;
    await waitFor(() => ledger.binding(paused.surfaceId)?.surface.title === "paused");
    const diagnostic = await ledger.binding(paused.surfaceId)!.page.cdp();
    await diagnostic.send("Runtime.addBinding", { name: "rendererStarted" });
    const rendererStarted = new Promise<void>((resolve) => {
      const called = (parameters: unknown) => {
        if (asRecord(parameters).name !== "rendererStarted") return;
        diagnostic.off("Runtime.bindingCalled", called);
        resolve();
      };
      diagnostic.on("Runtime.bindingCalled", called);
    });
    const unresponsive = diagnostic
      .send("Runtime.evaluate", { expression: "rendererStarted(''); while (true) {}" })
      .catch(() => undefined);
    await withBrowserTestSignal(rendererStarted);
    try {
      const unresponsiveStarted = elapsed();
      await candidateFor(
        "unresponsive-renderer",
        paused.surfaceId,
        `${origin}/?mode=paused`,
        "paused",
      );
      timings.unresponsiveCheckMs = elapsed() - unresponsiveStarted;
    } finally {
      await diagnostic.send("Runtime.terminateExecution");
      await unresponsive;
    }
    await ledger.closeSurface(paused.surfaceId);
    const frameBudgetStarted = elapsed();
    const inaccessiblePage = await create("inaccessible");
    await waitForAsync(
      async () =>
        evaluationValue(
          await request(
            "Runtime.evaluate",
            {
              expression:
                "document.readyState === 'complete' && location.href.includes('mode=inaccessible')",
              returnByValue: true,
            },
            inaccessiblePage.cdpSession,
          ),
        ) === true,
    );
    await request(
      "Runtime.evaluate",
      {
        expression:
          "document.body.replaceChildren(...Array.from({ length: 257 }, () => document.createElement('iframe'))); true",
        returnByValue: true,
      },
      inaccessiblePage.cdpSession,
    );
    await waitFor(
      () => ledger.binding(inaccessiblePage.surfaceId)?.surface.title === "inaccessible",
    );
    await candidateFor(
      "257-frames",
      inaccessiblePage.surfaceId,
      `${origin}/?mode=inaccessible`,
      "inaccessible",
    );
    await ledger.closeSurface(inaccessiblePage.surfaceId);
    timings.frameBudgetMs = elapsed() - frameBudgetStarted;
    const crashedPage = await create("crashed");
    await waitFor(() => ledger.binding(crashedPage.surfaceId)?.surface.title === "crashed");
    const crashDiagnostic = ledger.binding(crashedPage.surfaceId)!.cdp;
    const rendererCrashed = new Promise<void>((resolve) => {
      const crashed = () => {
        crashDiagnostic.off("Inspector.targetCrashed", crashed);
        resolve();
      };
      crashDiagnostic.on("Inspector.targetCrashed", crashed);
    });
    const crash = crashDiagnostic.send("Page.crash").catch(() => undefined);
    await withBrowserTestSignal(rendererCrashed);
    const crashStarted = elapsed();
    await candidateFor(
      "crashed-renderer",
      crashedPage.surfaceId,
      `${origin}/?mode=crashed`,
      "crashed",
    );
    timings.crashCheckMs = elapsed() - crashStarted;
    // Page.close can wait on a crashed renderer; browser-owned target closure does not.
    await browser.cdp.send("Target.closeTarget", { targetId: crashedPage.targetId });
    await crash;
    await waitForAsync(() => ledger.binding(crashedPage.surfaceId) === null);
    const openKey = randomUUID();
    const openParameters = { idempotencyKey: openKey, url: `${origin}/?mode=authoritative` };
    const opened = asRecord(await request("Opensteer.openTab", openParameters));
    const openedAgain = asRecord(await request("Opensteer.openTab", openParameters));
    expect(openedAgain).toEqual(opened);
    expect(ledger.snapshot().filter((surface) => surface.id === opened.tabId)).toHaveLength(1);
    expect(ledger.active()?.surface.id).toBe(x);
    expect([x, y.surfaceId, z.surfaceId].map((id) => ledger.viewportOf(id))).toEqual(sizesBefore);
    await expect(
      request("Opensteer.openTab", {
        ...openParameters,
        url: "file:///etc/passwd",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      request("Opensteer.openTab", { ...openParameters, url: `${origin}/different` }),
    ).rejects.toThrow();
    const beforePopup = ledger.snapshot().length;
    await request(
      "Runtime.evaluate",
      { expression: `window.open('${origin}/?mode=popup')` },
      y.cdpSession,
    );
    await waitFor(() => ledger.snapshot().length > beforePopup);
    expect(ledger.active()?.surface.id).toBe(x);
    const directory =
      process.env.OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-shared-browser-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "targeted-concurrency.json"),
      JSON.stringify(
        {
          engine: "chromium",
          generatedAt: new Date().toISOString(),
          x,
          y,
          z,
          sizesBefore,
          selectedAfter: ledger.active()?.surface.id,
          frames: sink.frames.map(({ header }) => header),
          activity: sink.messages.filter((message) => message.type === "browser.activity"),
          candidates,
          timings,
          independentHostControls: { candidate: independentCandidate, opened: independentOpen },
          authoritativeOpen: {
            opened,
            openedAgain,
            selectedAfter: ledger.active()?.surface.id,
            sizesAfter: [x, y.surfaceId, z.surfaceId].map((id) => ledger.viewportOf(id)),
          },
        },
        null,
        2,
      ),
    );
    for (const [name, id] of [
      ["x", x],
      ["y", y.surfaceId],
      ["z", z.surfaceId],
    ] as const) {
      const frame = sink.frames.findLast((frame) => frame.header.surfaceId === id);
      if (frame) await writeFile(join(directory, `targeted-${name}.jpg`), frame.data);
    }
    // The viewer already holds the inventories sent before this window, so a frame of
    // a geometry they announced is in order whenever it lands.
    const announcedBefore =
      sink.messages
        .flatMap((message) => (message.type === "browser.surfaces.changed" ? [message] : []))
        .at(-1)
        ?.surfaces.find((surface) => surface.id === y.surfaceId)?.geometryRevision ?? -1;
    const order: { type: string; revision: number }[] = [];
    let releaseList: (() => void) | undefined;
    let blockList = false;
    sink.sendServerImplementation = async (message) => {
      if (message.type === "browser.surfaces.changed") {
        if (blockList) {
          blockList = false;
          await new Promise<void>((resolve) => {
            releaseList = resolve;
          });
        }
        order.push({
          type: "inventory",
          revision:
            message.surfaces.find((surface) => surface.id === y.surfaceId)?.geometryRevision ?? 0,
        });
      }
    };
    sink.sendFrameImplementation = async (frame) => {
      if (frame.header.surfaceId === y.surfaceId)
        order.push({ type: "frame", revision: frame.header.geometryRevision ?? 0 });
    };
    const framesBeforePaint = sink.frames.length;
    await request(
      "Runtime.evaluate",
      { expression: "document.body.style.background = 'rgb(1, 2, 3)'; true", returnByValue: true },
      y.cdpSession,
    );
    await waitFor(() =>
      sink.frames.slice(framesBeforePaint).some((frame) => frame.header.surfaceId === y.surfaceId),
    );
    expect(order).toContainEqual({ type: "frame", revision: announcedBefore });
    // Hold the next list only now: one held during the repaint would also hold its frame.
    blockList = true;
    const resizeFirst = request(
      "Emulation.setDeviceMetricsOverride",
      { width: 900, height: 700, deviceScaleFactor: 1, mobile: false },
      y.cdpSession,
    );
    await waitFor(() => releaseList !== undefined);
    const resizeSecond = controller.handle({
      type: "viewport.set",
      surfaceId: y.surfaceId,
      width: 1280,
      height: 800,
    });
    releaseList!();
    await Promise.all([resizeFirst, resizeSecond]);
    const beforeResize = sink.frames.length;
    await request(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      y.cdpSession,
    );
    const resized = ledger.binding(y.surfaceId)!.surface.geometryRevision;
    await waitFor(() =>
      sink.frames
        .slice(beforeResize)
        .some(
          (frame) =>
            frame.header.surfaceId === y.surfaceId &&
            frame.header.geometryRevision === resized &&
            frame.header.viewportWidth === 1280,
        ),
    );
    let announced = announcedBefore;
    for (const event of order) {
      if (event.type === "inventory") announced = event.revision;
      else expect(event.revision).toBeLessThanOrEqual(announced);
    }
    await writeFile(join(directory, "geometry-order.json"), JSON.stringify(order, null, 2));
    sink.sendServerImplementation = null;
    sink.sendFrameImplementation = null;
    const stableInventory = ledger.inventoryRevision;
    await request(
      "Runtime.evaluate",
      { expression: "document.title = 'new title'; true", returnByValue: true },
      z.cdpSession,
    );
    expect(ledger.inventoryRevision).toBe(stableInventory);
    const inventoryRevision = () => ledger.inventoryRevision;
    const staleSignature = inventoryRevision();
    const race = await create("race");
    await expect(
      request("Opensteer.closeTab", {
        surfaceId: y.surfaceId,
        inventoryRevision: staleSignature,
      }),
    ).rejects.toThrow();
    expect(ledger.binding(race.surfaceId)).not.toBeNull();
    const closed = asRecord(
      await request("Opensteer.closeTab", {
        surfaceId: y.surfaceId,
        inventoryRevision: inventoryRevision(),
      }),
    );
    expect(closed.outcome).toBe("tab-closed");
    for (const surface of ledger.snapshot())
      if (surface.id !== x)
        await request("Target.closeTarget", { targetId: ledger.binding(surface.id)!.targetId });
    const beforeOpenRace = inventoryRevision();
    const openFirstRace = await Promise.allSettled([
      request("Opensteer.openTab", { idempotencyKey: randomUUID() }),
      request("Opensteer.closeTab", { surfaceId: x, inventoryRevision: beforeOpenRace }),
    ]);
    expect(openFirstRace[0].status).toBe("fulfilled");
    expect(openFirstRace[1].status).toBe("rejected");
    expect(ledger.snapshot()).toHaveLength(2);
    for (const surface of ledger.snapshot())
      if (surface.id !== x)
        await request("Target.closeTarget", { targetId: ledger.binding(surface.id)!.targetId });
    const closeFirstRace = await Promise.allSettled([
      request("Opensteer.closeTab", { surfaceId: x, inventoryRevision: inventoryRevision() }),
      request("Opensteer.openTab", { idempotencyKey: randomUUID() }),
    ]);
    expect(closeFirstRace[0].status).toBe("fulfilled");
    expect(closeFirstRace[1].status).toBe("rejected");
    expect(ledger.sealed).toBe(true);
    expect(ledger.snapshot()).toHaveLength(1);
    const last = asRecord(
      closeFirstRace[0].status === "fulfilled" ? closeFirstRace[0].value : null,
    );
    expect(last.outcome).toBe("session-closed");
    expect(
      sink.messages.some(
        (message) => message.type === "browser.status" && message.state === "closed",
      ),
    ).toBe(true);
    await writeFile(
      join(directory, "targeted-close-race.json"),
      JSON.stringify(
        {
          staleCloseRefused: true,
          concurrentTabSurvived: race.surfaceId,
          closed,
          last,
          openFirstRace: openFirstRace.map(({ status }) => status),
          closeFirstRace: closeFirstRace.map(({ status }) => status),
          creationAfterFinalCloseRefused: true,
        },
        null,
        2,
      ),
    );
  }, 60_000);

  it("shares one browser between a person and an agent, page by page, without either waiting", async () => {
    const site = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/popup"
          ? "<!doctype html><title>Person popup</title><p>Popup</p>"
          : request.url === "/opener"
            ? `<!doctype html><title>Sign-in page</title>
<style>html,body{margin:0;height:100%}#open{position:fixed;inset:0;width:100%;height:100%}</style>
<button id="open">Sign in with a popup</button>
<script>document.getElementById("open").addEventListener("click", () => window.open("/popup", "_blank"));</script>`
            : `<!doctype html><title>Shared page</title>
<style>html,body{margin:0;height:100%}#field{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
<input id="field" aria-label="Shared field">
<script>
window.pointerLog = [];
for (const type of ["mousedown", "mouseup", "mousemove"]) {
  addEventListener(type, (event) => {
    if (event.isTrusted) window.pointerLog.push({ type, buttons: event.buttons });
  }, true);
}
</script>`,
      );
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const claims = validProfileClaims();
    // A session's pages start at the documented default until the person's
    // view gives it a size.
    const agentSize = {
      width: defaultBrowserViewport.width,
      height: defaultBrowserViewport.height,
    };
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch({
      initialViewport: { devicePixelRatio: 1, ...agentSize },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    });
    cleanup.push(() => browser.close());
    const root = browser.context.pages()[0];
    if (!root) throw new Error("Missing root page");
    // The Browser Runtime's own wiring: the router owns the session's first
    // page, and the ledger claims every page it registers for the session.
    const files = new SessionFiles(join(tmpdir(), `opensteer-shared-files-${randomUUID()}`));
    const cdpRouter = new SessionCdpRouter(browser.cdp);
    cleanup.push(() => cdpRouter.close());
    const ledger = new SurfaceLedger(browser.context, {
      claimTarget: (targetId) => cdpRouter.claimTarget(claims.sessionId, targetId),
      rootPages: [root],
    });
    const rootTargetId = await root.targetId();
    cdpRouter.registerSession(
      claims.sessionId,
      rootTargetId,
      (targetId) => ledger.resolveTarget(targetId),
      files.root,
    );
    await ledger.start();
    cleanup.push(() => ledger.close());
    const sink = new FakeSink();
    const controller = new BrowserController({
      cdpRouter,
      claims,
      exportSnapshot: () => browser.exportSnapshot(),
      files,
      ledger,
      replaceSiteCookies: (site, cookies, deadline) =>
        browser.replaceSiteCookies(site, cookies, deadline),
      signIns: testSignIns(),
      sink,
    });
    await controller.start();
    cleanup.push(() => controller.close());
    const request = (method: string, parameters?: CdpParameters, sessionId?: string) =>
      sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        method,
        parameters,
        sessionId,
      );
    const evaluate = async (sessionId: string, expression: string, awaitPromise = false) =>
      evaluationValue(
        await request(
          "Runtime.evaluate",
          { awaitPromise, expression, returnByValue: true },
          sessionId,
        ),
      );
    const pageSize = (sessionId: string) =>
      evaluate(sessionId, "({ width: innerWidth, height: innerHeight })");
    const rootAttach = asRecord(
      await request("Target.attachToTarget", {
        flatten: true,
        targetId: rootTargetId,
      }),
    );
    const agentSessionId = String(rootAttach.sessionId);
    await request("Page.navigate", { url: `${origin}/agent` }, agentSessionId);
    await waitForAsync(
      async () => (await evaluate(agentSessionId, "document.readyState")) === "complete",
    );
    const rootSurfaceId = ledger.surfaceIdForTarget(rootTargetId);
    if (!rootSurfaceId) throw new Error("Missing root surface");

    // The person opens a tab at the size of their view. The agent sees it,
    // attaches to it, and hears once that the person navigated it.
    await controller.handle({ type: "stream.subscribe" });
    await controller.handle({
      type: "surface.open",
      url: `${origin}/person`,
      viewport: { width: 1000, height: 700 },
    });
    const person = ledger.active();
    if (!person || person.surface.id === rootSurfaceId) throw new Error("Missing person tab");
    await waitFor(() => person.page.url() === `${origin}/person`);
    const listed = asRecord(await request("Target.getTargets"));
    const listedPerson = (listed.targetInfos as unknown[])
      .map(asRecord)
      .find((info) => info.targetId === person.targetId);
    expect(listedPerson).toMatchObject({
      surfaceId: person.surface.id,
      userActivity: { kind: "navigation", sinceLastAgentCommand: true },
    });
    const personAttach = asRecord(
      await request("Target.attachToTarget", {
        flatten: true,
        targetId: person.targetId,
      }),
    );
    expect(personAttach).toMatchObject({
      surfaceId: person.surface.id,
      userActivity: { kind: "navigation", sinceLastAgentCommand: true },
    });
    const personSessionId = String(personAttach.sessionId);
    await waitForAsync(
      async () => (await evaluate(personSessionId, "document.readyState")) === "complete",
    );
    const personStartSize = await pageSize(personSessionId);
    expect(personStartSize).toEqual({ width: 1000, height: 700 });
    expect(await pageSize(agentSessionId)).toEqual(agentSize);

    // Agent activation names its own target and never moves the person's view.
    await request("Target.activateTarget", { targetId: rootTargetId });
    await request("Page.bringToFront", {}, agentSessionId);
    expect(ledger.active()?.surface.id).toBe(person.surface.id);

    // Fit sizes the person's page only; a tab the agent opens afterwards
    // starts at the size the person's view last followed, which no Fit or
    // sized tab changes.
    await controller.handle({
      type: "viewport.set",
      surfaceId: person.surface.id,
      width: 900,
      height: 650,
    });
    const personFitSize = await pageSize(personSessionId);
    const agentSizeAfterFit = await pageSize(agentSessionId);
    expect(personFitSize).toEqual({ width: 900, height: 650 });
    expect(agentSizeAfterFit).toEqual(agentSize);
    const created = asRecord(await request("Target.createTarget", { url: "about:blank" }));
    const createdAttach = asRecord(
      await request("Target.attachToTarget", {
        flatten: true,
        targetId: created.targetId,
      }),
    );
    const agentTabSize = await pageSize(String(createdAttach.sessionId));
    expect(agentTabSize).toEqual(agentSize);
    expect(ledger.active()?.surface.id).toBe(person.surface.id);

    // A popup from the person's tab belongs to the session and starts at its
    // opener's size.
    await evaluate(
      personSessionId,
      `window.open(${JSON.stringify(`${origin}/popup`)}, "_blank") !== null`,
    );
    let popupTargetId: string | null = null;
    await waitForAsync(async () => {
      const infos = asRecord(await request("Target.getTargets")).targetInfos as unknown[];
      const popup = infos.map(asRecord).find((info) => info.openerId === person.targetId);
      popupTargetId = typeof popup?.targetId === "string" ? popup.targetId : null;
      return popupTargetId !== null;
    });
    const popupAttach = asRecord(
      await request("Target.attachToTarget", {
        flatten: true,
        targetId: popupTargetId,
      }),
    );
    const popupSize = await pageSize(String(popupAttach.sessionId));
    expect(popupSize).toEqual({ width: 900, height: 650 });
    // The agent's command opened it, so it waits behind the person's view.
    const agentPopupStayedBehind = ledger.active()?.surface.id === person.surface.id;
    expect(agentPopupStayedBehind).toBe(true);

    // The agent waits in the person's page for the person's click, then for
    // their paste. Each arrives while the evaluation is pending.
    const awaitInput = (event: "mousedown" | "input") =>
      evaluate(
        personSessionId,
        `new Promise((resolve) => {
            const field = document.getElementById("field");
            field.addEventListener(${JSON.stringify(event)}, (e) => resolve({ trusted: e.isTrusted, length: field.value.length }), { once: true });
            document.body.dataset.waiting = ${JSON.stringify(event)};
          })`,
        true,
      );
    const readWaiting = async () =>
      (
        await person.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          expression: "document.body.dataset.waiting ?? null",
          returnByValue: true,
        })
      ).result?.value;
    const pointer = (
      action: "down" | "up" | "move",
      x = 0.5,
      y = 0.5,
      shown: { readonly height: number; readonly width: number } = {
        height: 650,
        width: 900,
      },
    ) =>
      controller.handle({
        action,
        button: action === "move" ? "none" : "left",
        ...(action === "move" ? {} : { clickCount: 1 }),
        surfaceId: person.surface.id,
        type: "input.pointer",
        viewportHeight: shown.height,
        viewportWidth: shown.width,
        x,
        y,
      });
    const clickWait = awaitInput("mousedown");
    await waitForAsync(async () => (await readWaiting()) === "mousedown");
    const clickStarted = Date.now();
    await pointer("down");
    await pointer("up");
    const clickResult = await clickWait;
    const clickLatencyMs = Date.now() - clickStarted;
    expect(clickResult).toMatchObject({ trusted: true });
    expect(clickLatencyMs).toBeLessThan(1000);

    // Browser Harness tells the agent, once, what the person did there.
    const harnessBridge = await startHarnessBridge(request, sink);
    cleanup.push(() => harnessBridge.close());
    const pageInfoProgram = "console.log(JSON.stringify(await pageInfo()))";
    const afterClick = await runHarness(
      harnessBridge.url,
      claims.sessionId,
      person.targetId,
      pageInfoProgram,
    );
    expect(afterClick.stderr).toMatch(
      /^\[opensteer\] The person clicked in this page \d+s ago\. Look at the page again before continuing\.\n$/u,
    );
    expect(JSON.parse(afterClick.stdout)).toMatchObject({
      surfaceId: person.surface.id,
      userActivity: { kind: "click", sinceLastAgentCommand: true },
    });
    const unchanged = await runHarness(
      harnessBridge.url,
      claims.sessionId,
      person.targetId,
      pageInfoProgram,
    );
    expect(unchanged.stderr).toBe("");
    expect(JSON.parse(unchanged.stdout)).toMatchObject({
      userActivity: { kind: "click", sinceLastAgentCommand: false },
    });
    // The person clicks while the agent's script waits in the page; the
    // agent's next pageInfo reports it, and says so once on stderr.
    const waitingRun = runHarness(
      harnessBridge.url,
      claims.sessionId,
      person.targetId,
      `await js(${JSON.stringify(`new Promise((resolve) => {
          addEventListener("mousedown", () => resolve(true), { once: true });
          document.body.dataset.waiting = "harness";
        })`)});
        console.log(JSON.stringify(await pageInfo()));
        console.log(JSON.stringify(await pageInfo()));`,
    );
    await waitForAsync(async () => (await readWaiting()) === "harness");
    await pointer("down");
    await pointer("up");
    const midRun = await waitingRun;
    const [midRunInfo, midRunInfoAgain] = midRun.stdout.trim().split("\n").map(asJsonRecord);
    expect(midRun.stderr).toMatch(/^\[opensteer\] The person clicked in this page \d+s ago\./u);
    expect(midRun.stderr.trim().split("\n")).toHaveLength(1);
    expect(midRunInfo).toMatchObject({
      userActivity: { kind: "click", sinceLastAgentCommand: true },
    });
    expect(midRunInfoAgain).toMatchObject({
      userActivity: { kind: "click", sinceLastAgentCommand: false },
    });

    const secret = `person-paste-${randomUUID()}`;
    const pasteWait = awaitInput("input");
    await waitForAsync(async () => (await readWaiting()) === "input");
    const pasteStarted = Date.now();
    await controller.handle({
      type: "clipboard.paste",
      surfaceId: person.surface.id,
      text: secret,
    });
    const pasteResult = await pasteWait;
    const pasteLatencyMs = Date.now() - pasteStarted;
    expect(pasteResult).toMatchObject({
      trusted: true,
      length: secret.length,
    });
    expect(pasteLatencyMs).toBeLessThan(1000);
    const typingInfo = asRecord(
      await request("Target.getTargetInfo", { targetId: person.targetId }),
    );
    expect(typingInfo).toMatchObject({
      targetInfo: {
        userActivity: { kind: "typing", sinceLastAgentCommand: true },
      },
    });
    const afterTyping = await runHarness(
      harnessBridge.url,
      claims.sessionId,
      person.targetId,
      pageInfoProgram,
    );
    expect(afterTyping.stderr).toMatch(/^\[opensteer\] The person typed in this page \d+s ago\./u);
    const activityLeaks = [
      JSON.stringify(typingInfo),
      afterTyping.stdout,
      afterTyping.stderr,
    ].filter((entry) => entry.includes(secret));
    expect(activityLeaks).toEqual([]);

    // A person's press is never left held by an agent resizing their page at
    // the same moment: the resize lands before, during and after each press,
    // and every press the page sees is released. Each request changes the
    // page's metrics; one that changes nothing ends no press.
    await person.cdp.send("Runtime.evaluate", {
      expression: "window.pointerLog = []",
    });
    const raceRounds = 24;
    for (let round = 0; round < raceRounds; round += 1) {
      const x = 0.1 + (round % 12) * 0.06;
      const racedMetrics = {
        deviceScaleFactor: round % 2 === 0 ? 1 : 2,
        height: 650,
        mobile: false,
        width: 900,
      };
      await Promise.all([
        pointer("down", x, 0.4),
        delay(round % 8).then(() =>
          request("Emulation.setDeviceMetricsOverride", racedMetrics, personSessionId),
        ),
      ]);
      await pointer("move", x + 0.01, 0.45);
      await pointer("up", x + 0.01, 0.45);
    }
    await pointer("move", 0.9, 0.9);
    const pointerLog = (
      await person.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "window.pointerLog",
        returnByValue: true,
      })
    ).result?.value as { type: string; buttons: number }[];
    const presses = pointerLog.filter((entry) => entry.type === "mousedown").length;
    const releases = pointerLog.filter((entry) => entry.type === "mouseup").length;
    const heldThroughMove = pointerLog.filter(
      (entry) => entry.type === "mousemove" && entry.buttons === 1,
    ).length;
    const releasedByAgentResize = presses - heldThroughMove;
    expect(presses).toBe(raceRounds);
    expect(releases).toBe(presses);
    expect(releasedByAgentResize).toBeGreaterThan(0);
    expect(pointerLog.at(-1)).toEqual({ type: "mousemove", buttons: 0 });

    // The agent sizes the person's page in one Browser Harness run. The size
    // outlives that run's CDP session: the person's reload and their frames
    // still show it.
    const viewerSize = async () =>
      (
        await person.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          expression: "({ width: innerWidth, height: innerHeight })",
          returnByValue: true,
        })
      ).result?.value;
    const viewerLoaded = (url: string) =>
      waitForAsync(async () => {
        const state = (
          await person.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
            expression:
              "({ href: location.href, ready: document.readyState, marked: 'reloadMark' in window })",
            returnByValue: true,
          })
        ).result?.value;
        return (
          asRecord(state).href === url &&
          asRecord(state).ready === "complete" &&
          asRecord(state).marked === false
        );
      });
    await controller.handle({
      type: "navigation.go",
      url: `${origin}/opener`,
    });
    await viewerLoaded(`${origin}/opener`);
    const emulated = { height: 768, width: 1024 };
    const emulating = await runHarness(
      harnessBridge.url,
      claims.sessionId,
      person.targetId,
      `await cdp("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        console.log(JSON.stringify(await js("({ width: innerWidth, height: innerHeight })")));`,
    );
    expect(JSON.parse(emulating.stdout)).toEqual(emulated);
    await person.cdp.send("Runtime.evaluate", {
      expression: "window.reloadMark = true",
    });
    const framesBeforeReload = sink.frames.length;
    await controller.handle({ type: "navigation.reload" });
    await viewerLoaded(`${origin}/opener`);
    const sizeAfterAgentDetached = await viewerSize();
    expect(sizeAfterAgentDetached).toEqual(emulated);
    await waitFor(() =>
      sink.frames
        .slice(framesBeforeReload)
        .some((frame) => frame.header.surfaceId === person.surface.id),
    );
    const frameAfterReload = sink.frames
      .slice(framesBeforeReload)
      .filter((frame) => frame.header.surfaceId === person.surface.id)
      .at(-1)?.header;
    expect(frameAfterReload).toMatchObject({
      viewportHeight: 768,
      viewportWidth: 1024,
    });

    // Legacy input brings an answering popup forward at its opener's size.
    const previousPopups = new Set(ledger.snapshot().map((surface) => surface.id));
    await pointer("down", 0.5, 0.5, emulated);
    await pointer("up", 0.5, 0.5, emulated);
    await waitFor(() =>
      ledger
        .snapshot()
        .some((surface) => surface.openerId != null && !previousPopups.has(surface.id)),
    );
    const popupSurface = ledger
      .snapshot()
      .find((surface) => surface.openerId != null && !previousPopups.has(surface.id));
    const personPopup = popupSurface ? ledger.binding(popupSurface.id) : null;
    expect(ledger.active()?.surface.id).toBe(personPopup?.surface.id);
    if (!personPopup) throw new Error("Missing the person's popup");
    const personPopupInfo = asRecord(
      asRecord(
        await request("Target.getTargetInfo", {
          targetId: personPopup.targetId,
        }),
      ).targetInfo,
    );
    expect(personPopupInfo.openerId).toBe(person.targetId);
    const personPopupAttach = asRecord(
      await request("Target.attachToTarget", {
        flatten: true,
        targetId: personPopup.targetId,
      }),
    );
    const personPopupSize = await pageSize(String(personPopupAttach.sessionId));
    expect(personPopupSize).toEqual(emulated);
    const latestSurfaces = sink.messages
      .filter((message) => message.type === "browser.surfaces.changed")
      .at(-1);
    expect(latestSurfaces).toMatchObject({
      surfaces: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          id: personPopup.surface.id,
          openerId: person.surface.id,
        }),
      ]),
    });

    // A closed page fails instead of being replaced.
    await request("Target.closeTarget", { targetId: rootTargetId });
    await expect(evaluate(agentSessionId, "location.href")).rejects.toThrow();

    // The agent hears of every page the session holds, the person's tab and
    // popup included, once each, and of their changes and of the person
    // closing one.
    await controller.handle({
      surfaceId: personPopup.surface.id,
      type: "surface.close",
    });
    const targetEvents = (method: string, targetId: string) =>
      sink.messages.filter(
        (message) =>
          message.type === "cdp.event" &&
          message.event.method === method &&
          (asRecord(message.event.parameters.targetInfo).targetId ??
            message.event.parameters.targetId) === targetId,
      ).length;
    await waitFor(() => targetEvents("Target.targetDestroyed", personPopup.targetId) === 1);
    const announced = {
      personTab: targetEvents("Target.targetCreated", person.targetId),
      personTabChanges: targetEvents("Target.targetInfoChanged", person.targetId),
      personPopup: targetEvents("Target.targetCreated", personPopup.targetId),
      personPopupClosed: targetEvents("Target.targetDestroyed", personPopup.targetId),
      agentTab: targetEvents("Target.targetCreated", String(created.targetId)),
    };
    expect(announced).toMatchObject({
      personTab: 1,
      personPopup: 1,
      personPopupClosed: 1,
      agentTab: 1,
    });
    expect(announced.personTabChanges).toBeGreaterThan(0);

    const directory =
      process.env.OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-shared-browser-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "chromium-shared-browser.json"),
      `${JSON.stringify(
        {
          engine: "chromium",
          executablePath,
          browser: await request("Browser.getVersion"),
          generatedAt: new Date().toISOString(),
          agentPage: {
            targetId: rootTargetId,
            size: agentSize,
            sizeAfterPersonFit: agentSizeAfterFit,
          },
          personPage: {
            openedBy: "surface.open",
            targetId: person.targetId,
            surfaceId: person.surface.id,
            listedToAgent: true,
            attachedByAgent: true,
            startSize: personStartSize,
            fitSize: personFitSize,
            popupListedAndAttached: popupTargetId !== null,
            popupSize,
            agentPopupStayedBehind,
          },
          agentTabAfterPersonFit: { size: agentTabSize },
          agentActivationKeptPersonView: true,
          concurrentInput: { clickLatencyMs, pasteLatencyMs },
          activity: {
            harnessLineAfterClick: afterClick.stderr.trim(),
            pageInfoAfterClick: asJsonRecord(afterClick.stdout).userActivity,
            harnessLineRepeated: unchanged.stderr.trim() !== "",
            clickDuringWaitingScript: {
              harnessLine: midRun.stderr.trim(),
              pageInfo: midRunInfo?.userActivity,
              nextPageInfo: midRunInfoAgain?.userActivity,
            },
            harnessLineAfterTyping: afterTyping.stderr.trim(),
            omitsTypedContent: activityLeaks.length === 0,
          },
          agentEmulationAfterHarnessExit: {
            requested: emulated,
            harnessSaw: JSON.parse(emulating.stdout),
            viewerSizeAfterPersonReload: sizeAfterAgentDetached,
            frameAfterReload: {
              viewportWidth: frameAfterReload?.viewportWidth,
              viewportHeight: frameAfterReload?.viewportHeight,
            },
          },
          personPopup: {
            cameForward: true,
            openerId: personPopupInfo.openerId,
            size: personPopupSize,
          },
          targetEventsToAgent: announced,
          pointerRace: {
            rounds: raceRounds,
            presses,
            releases,
            releasedByAgentResize,
            finalButtons: pointerLog.at(-1)?.buttons,
          },
          closedTargetRejected: true,
        },
        null,
        2,
      )}\n`,
    );
  }, 60_000);

  it("closes a session at once while an agent's script waits in its page, and keeps serving", async () => {
    const site = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end('<!doctype html><title>Waiting page</title><button id="go">Go</button>');
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    // Three sessions of one profile, so they share one Browser Host.
    const verifier = new FakeTicketVerifier();
    for (const index of [1, 2, 3]) {
      verifier.setClaims(
        `ticket-${index}`,
        validClaims({
          sessionId: BrowserSessionIdSchema.parse(
            `bsn_00000000-0000-4000-8000-00000000010${index}`,
          ),
        }),
      );
    }
    const runtime = new BrowserRuntime({
      launcher: new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath,
        headless: true,
      }),
      profileStateClient: new FakeProfileStateClient(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    cleanup.push(() => runtime.shutdown());
    const open = async (ticket: string) => {
      const sink = new FakeSink();
      const attachment = await runtime.attach(ticket, sink);
      const deliver = (message: BrowserClientMessage) => attachment.handle(JSON.stringify(message));
      const agent = (method: string, parameters?: CdpParameters, sessionId?: string) =>
        sendAsAgent(deliver, sink.messages, method, parameters, sessionId);
      const inventory = asRecord(await agent("Target.getTargets"));
      const attached = asRecord(
        await agent("Target.attachToTarget", {
          flatten: true,
          targetId: inventory.rootTargetId,
        }),
      );
      const pageSessionId = String(attached.sessionId);
      const evaluate = async (expression: string) =>
        evaluationValue(
          await agent("Runtime.evaluate", { expression, returnByValue: true }, pageSessionId),
        );
      await agent("Page.navigate", { url: `${origin}/` }, pageSessionId);
      await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
      return { attachment, deliver, evaluate, pageSessionId, sink };
    };
    const first = await open("ticket-1");
    const second = await open("ticket-2");

    // The agent's script waits for a click that never comes, as Browser
    // Harness's js() lets it; then the person closes the session.
    const waitingRequestId = randomUUID();
    const waiting = first.deliver({
      command: {
        method: "Runtime.evaluate",
        parameters: {
          awaitPromise: true,
          expression:
            "new Promise((resolve) => { document.getElementById('go').onclick = resolve; })",
        },
        sessionId: first.pageSessionId,
      },
      requestId: waitingRequestId,
      type: "cdp.command",
    });
    await delay(250, browserTestSignal());
    const answered = () =>
      first.sink.messages.find(
        (message) =>
          (message.type === "cdp.result" || message.type === "cdp.error") &&
          message.requestId === waitingRequestId,
      );
    expect(answered()).toBeUndefined();
    const closeStarted = Date.now();
    await withTimeout(first.attachment.close(), 15_000, {
      timeoutError: () => new Error("Closing the session waited for the agent's script."),
    });
    const closeMs = Date.now() - closeStarted;
    await withTimeout(waiting, 5_000, {
      timeoutError: () => new Error("The agent's waiting script never settled."),
    });
    const waitingAnswer = answered();
    const statuses = first.sink.messages
      .filter((message) => message.type === "browser.status")
      .map((message) => (message.type === "browser.status" ? message.state : null));
    const afterClosed = first.sink.messages.slice(
      first.sink.messages.findIndex(
        (message) => message.type === "browser.status" && message.state === "closed",
      ) + 1,
    );
    expect(closeMs).toBeLessThan(3_000);
    expect(waitingAnswer?.type).toBe("cdp.error");
    expect(statuses).toEqual(["closing", "closed"]);
    expect(afterClosed).toEqual([]);

    // The Runtime is not held: another session of the profile opens, and
    // the one that stayed keeps working.
    const reopenStarted = Date.now();
    const third = await withTimeout(open("ticket-3"), 15_000, {
      timeoutError: () => new Error("The Runtime could not open another session."),
    });
    const reopenMs = Date.now() - reopenStarted;
    expect(await third.evaluate("document.title")).toBe("Waiting page");
    expect(await second.evaluate("document.title")).toBe("Waiting page");
    const health = runtime.health();
    expect(health).toMatchObject({
      profileHostCount: 1,
      sessionCount: 2,
      state: "ready",
    });
    const shutdownStarted = Date.now();
    await withTimeout(runtime.shutdown(), 20_000, {
      timeoutError: () => new Error("The Runtime did not shut down."),
    });
    const shutdownMs = Date.now() - shutdownStarted;

    const directory =
      process.env.OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-shared-browser-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "chromium-session-teardown.json"),
      `${JSON.stringify(
        {
          engine: "chromium",
          executablePath,
          generatedAt: new Date().toISOString(),
          waitingScript: {
            expression: "new Promise((resolve) => { go.onclick = resolve })",
            answer:
              waitingAnswer?.type === "cdp.error"
                ? { type: waitingAnswer.type, error: waitingAnswer.error }
                : (waitingAnswer ?? null),
          },
          closeMs,
          statuses,
          messagesAfterClosed: afterClosed.length,
          reopenMs,
          healthAfterReopen: health,
          otherSessionStillServing: true,
          shutdownMs,
        },
        null,
        2,
      )}\n`,
    );
  }, 60_000);

  it("preserves imported host-only, unspecified SameSite, and both partition ancestor values", async () => {
    const launcher = new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    });
    const base = {
      domain: "app.example.com",
      expires: -1,
      hostOnly: true,
      httpOnly: true,
      path: "/",
      secure: true,
      value: "synthetic-session",
    } as const;
    const cookies: BrowserCookie[] = [
      { ...base, name: "__Host-session" },
      {
        ...base,
        domain: ".example.com",
        hostOnly: false,
        name: "domain-session",
        path: "/account",
        sameSite: "None",
      },
      {
        ...base,
        name: "partitioned",
        sameSite: "None",
        partitionKey: "https://example.com",
        partitionKeyHasCrossSiteAncestor: false,
      },
      {
        ...base,
        name: "partitioned",
        sameSite: "None",
        partitionKey: "https://example.com",
        partitionKeyHasCrossSiteAncestor: true,
      },
    ];
    const claims = validProfileClaims();
    const browser = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies, origins: [] } },
    });
    cleanup.push(() => browser.close());
    const exported = await browser.exportSnapshot();
    expect(exported.cookies).toHaveLength(cookies.length);
    expect(exported.cookies).toEqual(expect.arrayContaining(cookies));
    expect(exported.cookies.find((cookie) => cookie.name === "__Host-session")).not.toHaveProperty(
      "sameSite",
    );
  });

  it("checkpoints and restores cookies, local storage, and IndexedDB across placements", async () => {
    const site = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<!doctype html><title>Portable profile</title>");
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP address missing.");
    const origin = `http://127.0.0.1:${address.port}`;
    const launcher = new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    });
    const claims = validProfileClaims();
    const first = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    });
    const firstPage = first.context.pages()[0];
    if (!firstPage) throw new Error("Expected an initial Chromium page.");
    const firstCdp = await firstPage.cdp();
    await firstCdp.send("Page.navigate", { url: origin });
    await waitFor(() => firstPage.url() === `${origin}/`);
    const populated = await firstCdp.send<{
      exceptionDetails?: unknown;
      result?: { value?: unknown };
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve, reject) => {
          document.cookie = "session=portable-cookie; SameSite=Lax";
          localStorage.setItem("account", "client-a");
          localStorage.setItem("empty", "");
          localStorage.setItem("large", "界".repeat(3 * 1024 * 1024));
          const request = indexedDB.open("opensteer-auth", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("tokens");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction("tokens", "readwrite");
            transaction.objectStore("tokens").put("portable-token", "access");
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
          };
        })`,
    });
    // CDP resolves protocol errors as exceptionDetails. A completed send is
    // insufficient evidence that the fixture committed its IndexedDB write.
    expect(populated.exceptionDetails).toBeUndefined();
    expect(populated.result?.value).toBe(true);
    await firstPage.close();
    const normalOrigin = `http://localhost:${address.port}`;
    const normalPage = await first.context.createPage();
    const normalCdp = await normalPage.cdp();
    await normalCdp.send("Page.navigate", { url: normalOrigin });
    await waitFor(() => normalPage.url() === `${normalOrigin}/`);
    const written = await normalCdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: "localStorage.setItem('normal', 'normal-durable')",
    });
    expect(written.exceptionDetails).toBeUndefined();
    const collected = await first.exportSnapshot();
    const collectedStorage = collected.origins.find(
      (entry) => entry.origin === origin,
    )?.localStorage;
    expect(collectedStorage?.find((entry) => entry.name === "account")?.value).toBe("client-a");
    expect(collectedStorage?.find((entry) => entry.name === "empty")?.value).toBe("");
    expect(
      createHash("sha256")
        .update(collectedStorage?.find((entry) => entry.name === "large")?.value ?? "")
        .digest("hex"),
    ).toBe(
      createHash("sha256")
        .update("界".repeat(3 * 1024 * 1024))
        .digest("hex"),
    );
    const failures: BrowserOriginCaptureFailure[] = [];
    const snapshot = decodeBrowserProfileSnapshot(
      encodeBrowserProfileSnapshot(
        captureBrowserProfileSnapshot({
          cookies: collected.cookies,
          origins: [
            ...collected.origins.map((state) =>
              state.origin === origin
                ? {
                    ...state,
                    localStorage: [{ name: "over-quota", value: "x".repeat(6 * 1024 * 1024) }],
                  }
                : state,
            ),
            { origin: "https://invalid.test/path", localStorage: [] },
          ],
          previous: collected,
          onOriginFailure: (failure) => failures.push(failure),
        }),
      ),
    );
    expect(failures).toEqual([
      { origin, reason: "invalid", retained: true },
      { origin: null, reason: "invalid", retained: false },
    ]);
    expect(snapshot.cookies.some((cookie) => cookie.name === "session")).toBe(true);
    expect(snapshot.origins.some((entry) => entry.origin === origin)).toBe(true);
    await first.close();

    const restored = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot },
    });
    cleanup.push(() => restored.close());
    const restoredPage = restored.context.pages()[0];
    if (!restoredPage) throw new Error("Expected a restored Chromium page.");
    const restoredCdp = await restoredPage.cdp();
    await restoredCdp.send("Page.navigate", { url: origin });
    await waitFor(() => restoredPage.url() === `${origin}/`);
    const state = await restoredCdp.send<{
      result?: { value?: unknown };
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve, reject) => {
          const request = indexedDB.open("opensteer-auth");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const read = request.result.transaction("tokens").objectStore("tokens").get("access");
            read.onerror = () => reject(read.error);
            read.onsuccess = async () => resolve({
              largeSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(localStorage.getItem('large'))))).map(byte => byte.toString(16).padStart(2, '0')).join(''),
              cookie: document.cookie,
              empty: localStorage.getItem("empty"),
              indexedDB: read.result,
              localStorage: localStorage.getItem("account"),
            });
          };
        })`,
      returnByValue: true,
    });
    expect(state.result?.value).toEqual({
      cookie: "session=portable-cookie",
      empty: "",
      indexedDB: "portable-token",
      localStorage: "client-a",
      largeSha256: createHash("sha256")
        .update("界".repeat(3 * 1024 * 1024))
        .digest("hex"),
    });
    const restoredNormal = await restored.context.createPage();
    const restoredNormalCdp = await restoredNormal.cdp();
    await restoredNormalCdp.send("Page.navigate", { url: normalOrigin });
    await waitFor(() => restoredNormal.url() === `${normalOrigin}/`);
    const normal = await restoredNormalCdp.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      { expression: "localStorage.getItem('normal')", returnByValue: true },
    );
    expect(normal.result?.value).toBe("normal-durable");
    const artifactDirectory =
      process.env.OPENSTEER_PROFILE_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-profile-checkpoint");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "chromium-profile.json"),
      `${JSON.stringify({ engine: "Playwright Chromium", executablePath, failures, restored: state.result?.value, normal: normal.result?.value, encodedBytes: encodeBrowserProfileSnapshot(snapshot).byteLength }, null, 2)}\n`,
    );
  });

  it("replaces site cookies in legacy and native profiles and preserves native state across restarts", async () => {
    // The egress proxy is how this engine reaches the fixture as *.example.test.
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async (hostname) => {
        if (hostname === "example.test" || hostname.endsWith(".example.test")) {
          return { address: "127.0.0.1", family: 4 };
        }
        throw new Error("Unexpected destination.");
      },
    });
    const proxyAddress = await proxy.start();
    cleanup.push(() => proxy.close());
    const report = await runStateImportScenario({
      engine: "playwright-chromium",
      launcher: new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath,
        headless: true,
        proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
      }),
    });
    const artifactDirectory =
      process.env.OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-state-import-e2e");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "playwright-chromium.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.fixtureCookieHeader).not.toMatch(/anon|tracker/u);
    await verifyNativeProfilePersistence();
    await verifyNativeProfileConversion();
  }, 60_000);

  it("shows every page a browser without WebAuthn, directly and as a hosted runtime launches it", async () => {
    // Hosted runtimes launch Chromium with the egress proxy's arguments.
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async (hostname) => {
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          return { address: "127.0.0.1", family: 4 };
        }
        throw new Error("Unexpected destination.");
      },
    });
    const proxyAddress = await proxy.start();
    cleanup.push(() => proxy.close());
    const artifactDirectory =
      process.env.OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-passkey-policy-e2e");
    await mkdir(artifactDirectory, { recursive: true });
    for (const [engine, proxyUrl] of [
      ["playwright-chromium", undefined],
      ["playwright-chromium-hosted", `http://127.0.0.1:${proxyAddress.port}`],
    ] as const) {
      const report = await runPasskeyPolicyScenario({
        engine,
        launcher: new PlaywrightChromiumLauncher({
          chromiumSandbox: false,
          executablePath,
          headless: true,
          ...(proxyUrl ? { proxyUrl } : {}),
        }),
      });
      await writeFile(
        join(artifactDirectory, `${engine}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  }, 90_000);

  it("forces redirects, subresources, and loopback requests through the public-only proxy", async () => {
    const seen: string[] = [];
    const site = createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url === "/redirect") {
        const address = site.address();
        if (!address || typeof address === "string") throw new Error("Test site unavailable.");
        response
          .writeHead(302, {
            location: `http://127.0.0.1:${address.port}/redirect-private`,
          })
          .end();
        return;
      }
      if (request.url === "/page") {
        const address = site.address();
        if (!address || typeof address === "string") throw new Error("Test site unavailable.");
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><title>Public page</title><img src="http://127.0.0.1:${address.port}/subresource-private">`,
          );
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("private");
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP address missing.");

    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async (hostname) => {
        if (hostname === "public.test") return { address: "127.0.0.1", family: 4 };
        throw new Error("Private destination denied.");
      },
    });
    const proxyAddress = await proxy.start();
    cleanup.push(() => proxy.close());
    const launcher = new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
      proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
    });
    const claims = validProfileClaims();
    const browser = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    });
    cleanup.push(() => browser.close());
    const ledger = new SurfaceLedger(browser.context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    });
    await ledger.start();
    cleanup.push(() => ledger.close());
    const active = ledger.active();
    if (!active) throw new Error("Expected an active Chromium surface.");
    const publicOrigin = `http://public.test:${address.port}`;

    await active.cdp.send("Page.navigate", { url: `${publicOrigin}/page` });
    await waitFor(() => active.page.url().endsWith("/page"));
    await delay(250, browserTestSignal());
    expect(seen).toContain("/page");
    expect(seen).not.toContain("/subresource-private");

    await active.cdp.send("Page.navigate", { url: `${publicOrigin}/redirect` }).catch(() => ({}));
    await waitFor(() => seen.includes("/redirect"));
    await delay(250, browserTestSignal());
    expect(seen).not.toContain("/redirect-private");

    await active.cdp
      .send("Page.navigate", {
        url: `http://127.0.0.1:${address.port}/direct-private`,
      })
      .catch(() => ({}));
    await delay(250, browserTestSignal());
    expect(seen).not.toContain("/direct-private");
  });

  it("navigates, streams, inputs, handles dialogs, tracks popups, and closes cleanly", async () => {
    const site = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/popup"
          ? "<!doctype html><title>Popup surface</title><p>Popup</p>"
          : '<!doctype html><title>Runtime integration</title><input id="target" />' +
              '<p style="position:fixed;top:120px;left:0;margin:0;font:20px monospace">grab this streamed text</p>',
      );
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP address missing.");
    const origin = `http://127.0.0.1:${address.port}`;

    const launcher = new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    });
    const claims = validProfileClaims();
    const browser = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    });
    cleanup.push(() => browser.close());
    const ledger = new SurfaceLedger(browser.context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    });
    await ledger.start();
    cleanup.push(() => ledger.close());
    const cdpRouter = new SessionCdpRouter(browser.cdp);
    const files = new SessionFiles(join(tmpdir(), `opensteer-files-${randomUUID()}`));
    cdpRouter.registerSession(
      claims.sessionId,
      await browser.context.pages()[0]!.targetId(),
      (targetId) => ledger.resolveTarget(targetId),
      files.root,
    );
    cleanup.push(() => cdpRouter.close());
    const sink = new FakeSink();
    const controller = new BrowserController({
      cdpRouter,
      claims,
      exportSnapshot: () => browser.exportSnapshot(),
      files,
      ledger,
      replaceSiteCookies: (site, cookies, deadline) =>
        browser.replaceSiteCookies(site, cookies, deadline),
      signIns: testSignIns(),
      sink,
    });
    await controller.start();
    cleanup.push(() => controller.close());
    await controller.handle({ type: "stream.subscribe" });
    const cdpRequestId = randomUUID();
    await controller.handle({
      command: { method: "Target.getTargets" },
      requestId: cdpRequestId,
      type: "cdp.command",
    });
    expect(
      sink.messages.find(
        (message) => message.type === "cdp.result" && message.requestId === cdpRequestId,
      ),
    ).toMatchObject({
      result: {
        targetInfos: expect.arrayContaining([expect.objectContaining({ type: "page" })]),
      },
      type: "cdp.result",
    });

    await controller.handle({ type: "navigation.go", url: origin });
    await waitFor(() => ledger.active()?.surface.title === "Runtime integration");
    await waitFor(() => sink.frames.length > 0);
    expect(sink.frames.at(-1)?.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const active = ledger.active();
    if (!active) throw new Error("Expected an active Chromium surface.");
    const readViewport = async () => {
      const result = await active.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "({ height: window.innerHeight, width: window.innerWidth })",
        returnByValue: true,
      });
      return result.result?.value;
    };
    const initialFrameId = sink.frames.at(-1)?.header.frameId ?? 0;
    await controller.handle({
      height: 650,
      surfaceId: active.surface.id,
      type: "viewport.set",
      width: 900,
    });
    await waitForAsync(async () => {
      const viewport = await readViewport();
      return JSON.stringify(viewport) === JSON.stringify({ height: 650, width: 900 });
    });
    await waitFor(() =>
      sink.frames.some(
        (frame) =>
          frame.header.frameId > initialFrameId &&
          frame.header.viewportHeight === 650 &&
          frame.header.viewportWidth === 900,
      ),
    );
    // Restore the test's baseline through the same ordered human command so
    // the existing pointer assertions continue to exercise 800x600.
    await controller.handle({
      height: 600,
      surfaceId: active.surface.id,
      type: "viewport.set",
      width: 800,
    });
    await waitForAsync(async () => {
      const viewport = await readViewport();
      return JSON.stringify(viewport) === JSON.stringify({ height: 600, width: 800 });
    });
    const surfaceId = active.surface.id;
    await active.cdp.send("Runtime.evaluate", {
      expression: "document.querySelector('#target').focus()",
    });
    await controller.handle({
      surfaceId,
      text: "clipboard text",
      type: "clipboard.paste",
    });
    const input = await active.cdp.send<{
      result?: { value?: unknown };
    }>("Runtime.evaluate", {
      expression: "document.querySelector('#target').value",
      returnByValue: true,
    });
    expect(input.result?.value).toBe("clipboard text");

    const readTarget = async () => {
      const state = await active.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "document.querySelector('#target').value",
        returnByValue: true,
      });
      return state.result?.value;
    };
    // Editing keys act through the virtual-key-code path, not generated text.
    for (const action of ["down", "up"] as const) {
      await controller.handle({
        action,
        code: "Backspace",
        key: "Backspace",
        modifiers: [],
        surfaceId,
        type: "input.key",
      });
    }
    await waitForAsync(async () => (await readTarget()) === "clipboard tex");

    // Dragging across the prose selects it, and the copy chord publishes
    // the selection so streaming clients can land it on a local clipboard.
    const dragY = 130 / 600;
    await controller.handle({
      action: "down",
      button: "left",
      clickCount: 1,
      surfaceId,
      type: "input.pointer",
      viewportHeight: 600,
      viewportWidth: 800,
      x: 2 / 800,
      y: dragY,
    });
    for (const x of [40 / 800, 100 / 800, 160 / 800]) {
      await controller.handle({
        action: "move",
        button: "none",
        surfaceId,
        type: "input.pointer",
        viewportHeight: 600,
        viewportWidth: 800,
        x,
        y: dragY,
      });
    }
    await controller.handle({
      action: "up",
      button: "left",
      clickCount: 1,
      surfaceId,
      type: "input.pointer",
      viewportHeight: 600,
      viewportWidth: 800,
      x: 160 / 800,
      y: dragY,
    });
    await waitForAsync(async () => {
      const state = await active.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "String(document.getSelection())",
        returnByValue: true,
      });
      return typeof state.result?.value === "string" && state.result.value.includes("grab this");
    });
    await controller.handle({
      action: "down",
      code: "KeyC",
      key: "c",
      modifiers: ["control"],
      surfaceId,
      type: "input.key",
    });
    await waitFor(() =>
      sink.messages.some(
        (message) => message.type === "clipboard.data" && message.text.includes("grab this"),
      ),
    );

    await active.cdp.send("Runtime.evaluate", {
      expression: "setTimeout(() => confirm('Continue integration?'), 0)",
    });
    await waitFor(() =>
      sink.messages.some(
        (message) => message.type === "browser.dialog.changed" && message.dialog !== null,
      ),
    );
    await controller.handle({
      accept: true,
      dialogId: shownDialog(sink.messages).id,
      type: "dialog.respond",
    });

    expect(await readViewport()).toEqual({ height: 600, width: 800 });
    const attachRequestId = randomUUID();
    await controller.handle({
      command: {
        method: "Target.attachToTarget",
        parameters: { targetId: await active.page.targetId() },
      },
      requestId: attachRequestId,
      type: "cdp.command",
    });
    const attached = sink.messages.find(
      (message) => message.type === "cdp.result" && message.requestId === attachRequestId,
    );
    if (!attached || attached.type !== "cdp.result") throw new Error("Missing agent CDP session");
    const agentSessionId = (attached.result as { sessionId?: unknown }).sessionId;
    if (typeof agentSessionId !== "string") throw new Error("Missing agent CDP session ID");
    await controller.handle({
      command: {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: {
          deviceScaleFactor: 1,
          height: 400,
          mobile: false,
          width: 500,
        },
        sessionId: agentSessionId,
      },
      requestId: randomUUID(),
      type: "cdp.command",
    });
    await waitForAsync(async () => {
      const viewport = await readViewport();
      return JSON.stringify(viewport) === JSON.stringify({ height: 400, width: 500 });
    });
    await controller.handle({ type: "stream.unsubscribe" });
    await controller.handle({ type: "stream.subscribe" });
    expect(await readViewport()).toEqual({ height: 400, width: 500 });
    await controller.handle({
      command: {
        method: "Emulation.clearDeviceMetricsOverride",
        sessionId: agentSessionId,
      },
      requestId: randomUUID(),
      type: "cdp.command",
    });
    await waitForAsync(async () => {
      const viewport = await readViewport();
      return JSON.stringify(viewport) === JSON.stringify({ height: 600, width: 800 });
    });

    const popupRegistered = waitForLedgerState(ledger, () =>
      ledger.snapshot().some((surface) => surface.openerId != null),
    );
    await active.cdp.send("Runtime.evaluate", {
      expression: `window.open(${JSON.stringify(`${origin}/popup`)}, '_blank')`,
    });
    await popupRegistered;
    expect(ledger.snapshot()).toHaveLength(2);

    await controller.handle({ type: "surface.open", url: `${origin}/popup` });
    await waitFor(() => ledger.snapshot().length === 3);
    await waitFor(() => ledger.active()?.surface.url === `${origin}/popup`);

    await controller.close();
    await ledger.close();
    await browser.close();
  });

  it("gives an agent page-level power and none of a signed-in session's cookies, headers, or storage", async () => {
    const secrets = boundarySecrets();
    const site = createServer((request, response) =>
      serveBoundaryFixture(secrets, request, response),
    );
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    cleanup.push(async () => {
      site.close();
      await once(site, "close");
    });
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP address missing.");
    const siteA = `http://site-a.test:${address.port}`;
    const siteB = `http://site-b.test:${address.port}`;
    // The egress proxy is how this engine reaches the fixture as two sites.
    const proxy = new PublicBrowserEgressProxy({
      port: 0,
      resolveAddress: async (hostname) => {
        if (hostname === "site-a.test" || hostname === "site-b.test") {
          return { address: "127.0.0.1", family: 4 };
        }
        throw new Error("Unexpected destination.");
      },
    });
    const proxyAddress = await proxy.start();
    cleanup.push(() => proxy.close());
    const claims = validProfileClaims();
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
      proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
    }).launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: `profile:${claims.identity.profileId}`,
      sessionId: claims.sessionId,
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    });
    cleanup.push(() => browser.close());
    const ledger = new SurfaceLedger(browser.context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    });
    await ledger.start();
    cleanup.push(() => ledger.close());
    const page = browser.context.pages()[0];
    if (!page) throw new Error("Expected an initial Chromium page.");
    const rootTargetId = await page.targetId();
    const report: Record<string, unknown> = {
      engine: "playwright-chromium",
      executablePath,
      generatedAt: new Date().toISOString(),
      secrets: Object.entries(secrets).map(([label, value]) => ({
        label,
        sha256: createHash("sha256").update(value).digest("hex"),
      })),
    };

    // The person signed in to both sites before the agent arrived.
    const platform = await page.cdp();
    const platformEvaluate = async (expression: string) =>
      evaluationValue(
        await platform.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        }),
      );
    // Observe before navigation: the icon controller also leases Runtime,
    // and enabling an already-enabled CDP domain does not replay its worlds.
    const platformContexts = new ExecutionContextInventory();
    const platformEvents: { method: string; parameters: CdpParameters }[] = [];
    platform.onEvent((method, parameters) => {
      platformContexts.observe(method, parameters);
      platformEvents.push({ method, parameters });
    });
    await platform.send("Runtime.enable");
    for (const url of [`${siteB}/login`, `${siteA}/login`]) {
      await platform.send("Page.navigate", { url });
      await waitForAsync(
        async () =>
          page.url() === url && (await platformEvaluate("document.readyState")) === "complete",
      );
    }
    const { frameTree: loginTree } = (await platform.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string } };
    };
    const privateWorld = (await platform.send("Page.createIsolatedWorld", {
      frameId: loginTree.frame.id,
      worldName: "existing-private-world",
    })) as { executionContextId: number };
    const privateHeld = (await platform.send("Runtime.evaluate", {
      contextId: privateWorld.executionContextId,
      expression: `globalThis.privateSecret = ${JSON.stringify(secrets.privateWorld)}; ({ privileged: globalThis.privateSecret })`,
    })) as { result: { objectId?: string } };
    if (typeof privateHeld.result.objectId !== "string") {
      throw new Error("The private world held no object.");
    }
    const privateHandle = privateHeld.result.objectId;

    // An unfiltered page channel shows what an agent could take before the boundary.
    const raw = await browser.cdp.attach(rootTargetId);
    cleanup.push(() => raw.close());
    const rawEvents: { method: string; parameters: CdpParameters }[] = [];
    raw.onEvent((method, parameters) => rawEvents.push({ method, parameters }));
    const rawCookieRead = foundSecrets(secrets, await raw.send("Network.getAllCookies"));
    expect(rawCookieRead).toEqual(["sessionA", "sessionB"]);
    await raw.send("Runtime.enable");
    await raw.send("Network.enable");

    const files = new SessionFiles(join(tmpdir(), `opensteer-files-${randomUUID()}`));
    expect(browser.clipboard?.machineClipboardShared).toBe(false);
    const cdpRouter = new SessionCdpRouter(
      browser.cdp,
      undefined,
      browser.clipboard?.machineClipboardShared !== false,
    );
    cdpRouter.registerSession(
      claims.sessionId,
      rootTargetId,
      (targetId) => ledger.resolveTarget(targetId),
      files.root,
    );
    cleanup.push(() => cdpRouter.close());
    const sink = new FakeSink();
    const controller = new BrowserController({
      cdpRouter,
      claims,
      exportSnapshot: () => browser.exportSnapshot(),
      files,
      ledger,
      replaceSiteCookies: (target, cookies, deadline) =>
        browser.replaceSiteCookies(target, cookies, deadline),
      signIns: testSignIns(),
      sink,
    });
    await controller.start();
    cleanup.push(() => controller.close());
    const agent = (method: string, parameters?: CdpParameters, sessionId?: string) =>
      sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        method,
        parameters,
        sessionId,
      );

    report.browser = await agent("Browser.getVersion");
    const { sessionId } = (await agent("Target.attachToTarget", {
      flatten: true,
      targetId: rootTargetId,
    })) as { sessionId: string };
    const outcome = (method: string, parameters: CdpParameters, on?: string) =>
      agent(method, parameters, on).then(
        (result) => ({
          leaked: foundSecrets(secrets, result),
          outcome: "forwarded",
        }),
        (error: unknown) => ({
          message: (error as Error).message,
          outcome: (error as { code?: string }).code === "forbidden" ? "forbidden" : "failed",
        }),
      );
    const own = (await agent("Runtime.evaluate", { expression: "({})" }, sessionId)) as {
      result: { objectId: string };
    };
    const useHeldHandle = async () => [
      await outcome(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(){return globalThis.privateSecret ?? null}",
          objectId: privateHandle,
          returnByValue: true,
        },
        sessionId,
      ),
      await outcome("Runtime.getProperties", { objectId: privateHandle }, sessionId),
      await outcome(
        "Runtime.callFunctionOn",
        {
          arguments: [{ objectId: privateHandle }],
          functionDeclaration: "function(held){return held.privileged}",
          objectId: own.result.objectId,
          returnByValue: true,
        },
        sessionId,
      ),
    ];
    const provenance: Record<string, unknown> = {
      heldBeforeRuntimeEnable: await useHeldHandle(),
    };
    for (const method of ["Page.enable", "Runtime.enable"]) {
      await agent(method, {}, sessionId);
    }
    const reportedToAgent = sink.messages.flatMap((message) =>
      message.type === "cdp.event" && message.event.method === "Runtime.executionContextCreated"
        ? [asRecord(message.event.parameters.context).id]
        : [],
    );
    provenance.contexts = platformContexts
      .entries()
      .map(({ frameId, id, mainWorld, description }) => ({
        frameId,
        id,
        mainWorld,
        name: description.name,
      }));
    provenance.reportedToAgent = reportedToAgent;
    provenance.heldAfterRuntimeEnable = await useHeldHandle();
    expect(reportedToAgent.length).toBeGreaterThan(0);
    expect(reportedToAgent.every((id) => platformContexts.isMainWorld(id))).toBe(true);
    for (const attempt of [
      ...(provenance.heldBeforeRuntimeEnable as { outcome: string }[]),
      ...(provenance.heldAfterRuntimeEnable as { outcome: string }[]),
    ]) {
      expect(attempt.outcome).toBe("forbidden");
    }

    // The private world logs and throws: the platform hears it, the agent must not.
    await platform.send("Runtime.evaluate", {
      contextId: privateWorld.executionContextId,
      expression: `console.log("FAKE_PRIVATE_CONSOLE", { privateSecret: globalThis.privateSecret }); setTimeout(() => { throw new Error("private-world-exception " + globalThis.privateSecret); }); true`,
    });
    await waitFor(() =>
      platformEvents.some(
        (event) =>
          event.method === "Runtime.exceptionThrown" &&
          asRecord(event.parameters.exceptionDetails).executionContextId ===
            privateWorld.executionContextId,
      ),
    );
    await delay(200, browserTestSignal());
    const privateOutput = sink.messages.filter((message) =>
      JSON.stringify(message).includes(secrets.privateWorld),
    );
    provenance.privateWorldOutputToAgent = privateOutput.length;
    expect(privateOutput).toEqual([]);

    // Handles forged from the agent's own isolate prefix. The private world's
    // console message bound its objects into the agent's own CDP session.
    const prefix = own.result.objectId.split(".", 1)[0] ?? "";
    const highest = Math.max(...platformContexts.entries().map((context) => context.id)) + 2;
    const tally = {
      main: { failed: 0, forbidden: 0, forwarded: 0 },
      other: { failed: 0, forbidden: 0, forwarded: 0 },
    };
    const forgedLeaks: string[] = [];
    for (let contextId = 1; contextId <= highest; contextId += 1) {
      const kind = platformContexts.isMainWorld(contextId) ? "main" : "other";
      for (let object = 1; object <= 16; object += 1) {
        const objectId = `${prefix}.${contextId}.${object}`;
        const forged = (await outcome(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: "function(){return globalThis.privateSecret ?? null}",
            objectId,
            returnByValue: true,
          },
          sessionId,
        )) as {
          leaked?: string[];
          outcome: "failed" | "forbidden" | "forwarded";
        };
        tally[kind][forged.outcome] += 1;
        if (forged.leaked?.length) forgedLeaks.push(objectId);
      }
    }
    provenance.forged = { highest, leaks: forgedLeaks, prefix, tally };
    expect(forgedLeaks).toEqual([]);
    expect(tally.other).toMatchObject({ failed: 0, forwarded: 0 });
    expect(tally.other.forbidden).toBeGreaterThan(0);
    expect(tally.main.forwarded).toBeGreaterThan(0);

    const refusals: { method: string; message: string; scope: string }[] = [];
    const refuse = async (method: string, parameters?: CdpParameters, on?: string) => {
      const error = await agent(method, parameters, on).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, method).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, method).toContain(method);
      refusals.push({
        message: (error as Error).message,
        method,
        scope: on ? "page" : "browser",
      });
    };
    for (const method of ["Network.getAllCookies", "Storage.getCookies", "Target.setAutoAttach"]) {
      await refuse(method);
    }
    for (const [method, parameters] of [
      ["Network.enable"],
      ["Network.getAllCookies"],
      ["Network.getCookies", { urls: [`${siteB}/`] }],
      [
        "Network.loadNetworkResource",
        {
          options: { disableCache: true, includeCredentials: true },
          url: `${siteB}/login`,
        },
      ],
      ["Fetch.enable", { patterns: [{ urlPattern: "*" }] }],
      ["Storage.getCookies"],
      [
        "DOMStorage.getDOMStorageItems",
        { storageId: { isLocalStorage: true, securityOrigin: siteB } },
      ],
      ["IndexedDB.requestDatabaseNames", { securityOrigin: siteB }],
      ["CacheStorage.requestCacheNames", { securityOrigin: siteB }],
      ["ServiceWorker.enable"],
      ["Debugger.enable"],
      ["Page.addScriptToEvaluateOnNewDocument", { source: "window.planted = true" }],
      ["Page.createIsolatedWorld", { frameId: "main" }],
      ["Page.setBypassCSP", { enabled: true }],
      ["Page.reload", { scriptToEvaluateOnLoad: "window.planted = true" }],
      ["Page.printToPDF", { transferMode: "ReturnAsStream" }],
      ["Runtime.addBinding", { name: "agentBinding" }],
      ["Runtime.evaluate", { expression: "copy(document.cookie)", includeCommandLineAPI: true }],
      ["Runtime.callFunctionOn", { executionContextId: 1, functionDeclaration: "() => 1" }],
      ["DOM.resolveNode", { backendNodeId: 1, executionContextId: 1 }],
      ["Page.navigate", { referrer: `${siteB}/`, url: `${siteA}/app` }],
      ["DOM.getDocument", { depth: 1, unreviewedParameter: true }],
      ["Log.enable"],
      ["Log.clear"],
    ] satisfies [string, CdpParameters?][]) {
      await refuse(method, parameters, sessionId);
    }

    // Harness-style page work: navigate, read, click, type, screenshot, files.
    const evaluate = async (expression: string) =>
      evaluationValue(
        await agent(
          "Runtime.evaluate",
          { awaitPromise: true, expression, returnByValue: true },
          sessionId,
        ),
      );
    await agent("Page.navigate", { url: `${siteA}/app` }, sessionId);
    await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
    expect({
      cookie: await evaluate("document.cookie"),
      signedIn: await evaluate("document.body.dataset.signedIn"),
      title: await evaluate("document.title"),
    }).toEqual({
      cookie: "visible_a=page-visible",
      signedIn: "yes",
      title: "Site A app",
    });
    const click = async (selector: string) => {
      const point = (await evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      )) as { x: number; y: number };
      for (const type of ["mousePressed", "mouseReleased"]) {
        await agent(
          "Input.dispatchMouseEvent",
          { button: "left", clickCount: 1, type, ...point },
          sessionId,
        );
      }
    };
    await click("#count");
    await click("#count");
    await click("#name");
    await agent("Input.insertText", { text: "hello!" }, sessionId);
    for (const type of ["keyDown", "keyUp"]) {
      await agent(
        "Input.dispatchKeyEvent",
        {
          code: "Enter",
          key: "Enter",
          modifiers: 0,
          nativeVirtualKeyCode: 13,
          type,
          windowsVirtualKeyCode: 13,
        },
        sessionId,
      );
    }
    expect(
      await evaluate(
        "[window.clicks, window.keys.includes('Enter'), document.querySelector('#name').value]",
      ),
    ).toEqual([2, true, "hello!"]);
    await evaluate(`
      globalThis.inputCopies = [];
      document.querySelector('#name').addEventListener('copy', (event) => {
        const input = event.target;
        inputCopies.push({ text: input.value.slice(input.selectionStart, input.selectionEnd), trusted: event.isTrusted });
        event.preventDefault();
      });
    `);
    for (const [key, code, windowsVirtualKeyCode, nativeVirtualKeyCode] of [
      ["a", "KeyA", 65, 0],
      ["c", "KeyC", 67, 8],
    ] as const) {
      for (const type of ["keyDown", "keyUp"]) {
        await agent(
          "Input.dispatchKeyEvent",
          {
            code,
            key,
            modifiers: 4,
            nativeVirtualKeyCode,
            windowsVirtualKeyCode,
            type,
            ...(type === "keyDown" ? { text: key } : {}),
          },
          sessionId,
        );
      }
      if (key === "a") {
        expect(
          await evaluate(
            "[document.querySelector('#name').selectionStart, document.querySelector('#name').selectionEnd]",
          ),
        ).toEqual([0, 6]);
      }
    }
    expect(await evaluate("inputCopies")).toEqual([{ text: "hello!", trusted: true }]);
    // Agents never paste the browser computer's clipboard, whatever the engine.
    await evaluate(
      "(() => { const input = document.querySelector('#name'); input.setSelectionRange(input.value.length, input.value.length); })()",
    );
    await expect(
      agent(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key: "v",
          code: "KeyV",
          modifiers: 4,
          nativeVirtualKeyCode: 9,
          windowsVirtualKeyCode: 86,
        },
        sessionId,
      ),
    ).rejects.toThrow(/Pasting is not available to agents/);
    expect(await evaluate("document.querySelector('#name').value")).toBe("hello!");
    expect(
      await evaluate(
        "[document.querySelector('#name').selectionStart, document.querySelector('#name').selectionEnd]",
      ),
    ).toEqual([6, 6]);
    const screenshot = (await agent("Page.captureScreenshot", { format: "png" }, sessionId)) as {
      data: string;
    };
    expect(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    const { root } = (await agent("DOM.getDocument", {}, sessionId)) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await agent(
      "DOM.querySelector",
      { nodeId: root.nodeId, selector: "#name" },
      sessionId,
    )) as { nodeId: number };
    const node = (await agent("DOM.resolveNode", { nodeId }, sessionId)) as {
      object: { objectId: string };
    };
    expect(
      evaluationValue(
        await agent(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: "function(){return this.value}",
            objectId: node.object.objectId,
            returnByValue: true,
          },
          sessionId,
        ),
      ),
    ).toBe("hello!");
    const staged = (await agent(stageFileMethod, {
      data: randomBytes(4_096).toString("base64"),
      fileId: randomUUID(),
      name: "boundary.txt",
      offset: 0,
      size: 4_096,
    })) as { path: string };
    const fileInput = (await agent(
      "Runtime.evaluate",
      { expression: "document.querySelector('#file')" },
      sessionId,
    )) as { result: { objectId: string } };
    await agent(
      "DOM.setFileInputFiles",
      { files: [staged.path], objectId: fileInput.result.objectId },
      sessionId,
    );
    await agent("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    await click("#choose");
    await waitFor(() =>
      sink.messages.some(
        (message) =>
          message.type === "cdp.event" && message.event.method === "Page.fileChooserOpened",
      ),
    );
    const chooser = sink.messages.find(
      (message) =>
        message.type === "cdp.event" && message.event.method === "Page.fileChooserOpened",
    );
    await agent(
      "DOM.setFileInputFiles",
      {
        backendNodeId: chooser?.type === "cdp.event" ? chooser.event.parameters.backendNodeId : 0,
        files: [staged.path],
      },
      sessionId,
    );
    await agent("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId);
    expect(
      await evaluate(
        "[...document.querySelectorAll('input[type=file]')].map((input) => input.files[0]?.name)",
      ),
    ).toEqual(["boundary.txt", "boundary.txt"]);
    const pdf = (await agent("Page.printToPDF", {}, sessionId)) as {
      data: string;
    };
    expect(Buffer.from(pdf.data, "base64").subarray(0, 4).toString()).toBe("%PDF");

    // Chromium's diagnostics for a blocked CORS fetch quote the response
    // header that the page's own fetch never sees.
    await raw.send("Log.enable");
    const corsFetch = await evaluate(
      `fetch(${JSON.stringify(`${siteB}/cors`)}, { credentials: "include" }).then(() => "read", (error) => error.name)`,
    );
    await waitFor(() =>
      rawEvents.some(
        (event) =>
          event.method === "Log.entryAdded" &&
          JSON.stringify(event.parameters).includes(secrets.corsHeader),
      ),
    );
    await delay(200, browserTestSignal());
    provenance.cors = {
      agentMessagesWithHeader: sink.messages.filter((message) =>
        JSON.stringify(message).includes(secrets.corsHeader),
      ).length,
      corsFetch,
      rawLogCaptured: true,
    };
    expect(provenance.cors).toMatchObject({
      agentMessagesWithHeader: 0,
      corsFetch: "TypeError",
    });

    // A script world beside the page's own, holding an object the agent tries to reach.
    const { frameTree } = (await raw.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string } };
    };
    const probe = (await raw.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "opensteer-boundary-probe",
    })) as { executionContextId: number };
    const held = (await raw.send("Runtime.evaluate", {
      contextId: probe.executionContextId,
      expression: "({ privileged: 'isolated-world-object' })",
    })) as { result: { objectId?: string } };
    expect(held.result.objectId).toEqual(expect.any(String));
    await refuse(
      "Runtime.evaluate",
      { contextId: probe.executionContextId, expression: "1" },
      sessionId,
    );
    await refuse(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: "function(){return this}",
        objectId: held.result.objectId,
      },
      sessionId,
    );

    const isolatedWorlds = rawEvents
      .filter((event) => event.method === "Runtime.executionContextCreated")
      .map((event) => asRecord(event.parameters.context))
      .filter((context) => asRecord(context.auxData).isDefault === false)
      .map((context) => context.name);
    const rawHeaderCapture = foundSecrets(
      secrets,
      rawEvents.filter((event) => event.method.endsWith("ExtraInfo")),
    );
    expect(rawHeaderCapture).toEqual(expect.arrayContaining(["rotatedSessionA", "sessionA"]));
    const agentEvents: Record<string, number> = {};
    for (const message of sink.messages) {
      if (message.type !== "cdp.event") continue;
      agentEvents[message.event.method] = (agentEvents[message.event.method] ?? 0) + 1;
      // Page events by reviewed name only; Target events are the router's own.
      if (!message.event.method.startsWith("Target.")) {
        expect(agentCdpAllowlist.events.has(message.event.method), message.event.method).toBe(true);
      }
      if (message.event.method === "Runtime.executionContextCreated") {
        expect(asRecord(asRecord(message.event.parameters.context).auxData).isDefault).toBe(true);
      }
    }
    const serialized = sink.messages.map((message) => JSON.stringify(message));
    const leaks = Object.entries(secrets)
      .filter(([, value]) => serialized.some((entry) => entry.includes(value)))
      .map(([label]) => label);
    Object.assign(report, {
      agentEvents,
      provenance,
      controls: {
        isolatedWorldsReported: [...new Set(isolatedWorlds)],
        rawChannelCookieRead: rawCookieRead,
        rawChannelHeaderCapture: rawHeaderCapture,
      },
      passed: leaks.length === 0,
      refusals,
      scan: {
        bytes: serialized.reduce((total, entry) => total + Buffer.byteLength(entry), 0),
        leaks,
        messages: serialized.length,
      },
    });
    const artifactDirectory =
      process.env.OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-cdp-boundary-e2e");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "playwright-chromium.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(leaks).toEqual([]);
    expect(agentEvents).toMatchObject({
      "Page.fileChooserOpened": 1,
      "Page.loadEventFired": expect.any(Number),
      "Runtime.consoleAPICalled": expect.any(Number),
    });
  }, 60_000);
});
