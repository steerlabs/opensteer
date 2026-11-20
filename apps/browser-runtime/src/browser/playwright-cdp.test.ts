import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  standardCdpPath,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validClaims } from "@opensteer/browser-runtime-core/test-support";
import { createBrowserSessionId, type BrowserAttachTicketClaims } from "@opensteer/protocol";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import {
  asRecord,
  executablePath,
  runHarness,
  sendAsAgent,
  startHarnessBridge,
} from "./chromium.test-support.js";
import { cleanup, TestChromiumLauncher } from "./browser-test-lifecycle.js";
import { nativeRuntimeProfile } from "./native-profile.test-support.js";

async function fixtureServer(handler: RequestListener, hostname = "127.0.0.1") {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://${hostname}:${(server.address() as AddressInfo).port}`;
}

it("connects stock Playwright to the owned pages of a managed Chromium session", async () => {
  const frameOrigin = await fixtureServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<button onclick=\"this.textContent = 'Clicked in frame'\">Frame button</button>");
  }, "localhost");
  const responseBody = "response\n".repeat(75_000);
  const origin = await fixtureServer((request, response) => {
    switch (request.url) {
      case "/worker.js":
        response.setHeader("Content-Type", "application/javascript");
        response.end('onmessage = ({data}) => postMessage("worker: " + data)');
        return;
      case "/data":
        response.end(responseBody);
        return;
      case "/file":
        response.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
        response.end("download");
        return;
      case "/app":
        response.setHeader("Content-Type", "text/html");
        response.end(`<title>Fixture</title>
          <button id="count" onclick="this.textContent = 'Clicked'">Click</button>
          <input id="name"><input id="file" type="file">
          <a href="/file">Download</a>
          <iframe src="${frameOrigin}/frame"></iframe>`);
        return;
      default:
        response.setHeader("Content-Type", "text/html");
        response.end("<title>Initial page</title>");
    }
  });
  const profile = await nativeRuntimeProfile();
  cleanup.push(profile.close);
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-standard-cdp-"));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const signing = generateKeyPairSync("ed25519");
  const verifier = await Ed25519AttachTicketVerifier.create({
    replayLedgerPath: join(scratch, "private", "replay.json"),
    resolvePublicKey: (id) => (id === "test" ? signing.publicKey : null),
  });
  const claims = validClaims({ identity: profile.identity });
  const ticket = (overrides: Partial<BrowserAttachTicketClaims> = {}) => {
    const header = Buffer.from(
      JSON.stringify({
        alg: "EdDSA",
        kid: "test",
        typ: "opensteer-browser-attach+jwt",
      }),
    ).toString("base64url");
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        ...claims,
        ...overrides,
        nonce: randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        operationExpiresAt: new Date(now + 18_000).toISOString(),
      }),
    ).toString("base64url");
    const content = `${header}.${payload}`;
    return `${content}.${sign(null, Buffer.from(content), signing.privateKey).toString("base64url")}`;
  };
  const runtime = new BrowserRuntime({
    launcher: new TestChromiumLauncher({
      executablePath,
      headless: true,
      chromiumSandbox: false,
      args: ["--site-per-process"],
    }),
    localProfiles: profile.localProfiles,
    runtimeId: claims.runtimeId,
    sessionFilesRoot: join(scratch, "files"),
    ticketVerifier: verifier,
  });
  const server = new BrowserRuntimeServer({ port: 0, runtime });
  cleanup.push(() => server.close());
  const { host, port } = await server.start();
  const sessionSink = new FakeSink();
  const legacy = await runtime.attach(ticket(), sessionSink);
  const agent = (method: string, parameters?: Record<string, unknown>, sessionId?: string) =>
    sendAsAgent(
      (message) => legacy.handle(JSON.stringify(message)),
      sessionSink.messages,
      method,
      parameters,
      sessionId,
    );
  const directory = asRecord(await agent("Target.getTargets"));
  const rootTargetId = String(directory.rootTargetId);
  const pageSessionId = String(
    asRecord(
      await agent("Target.attachToTarget", {
        targetId: rootTargetId,
        flatten: true,
      }),
    ).sessionId,
  );
  await agent("Page.enable", {}, pageSessionId);
  const loaded = Promise.withResolvers<void>();
  sessionSink.sendServerImplementation = async (message) => {
    if (
      message.type === "cdp.event" &&
      message.event.sessionId === pageSessionId &&
      message.event.method === "Page.loadEventFired"
    )
      loaded.resolve();
  };
  await agent("Page.navigate", { url: `${origin}/existing` }, pageSessionId);
  await loaded.promise;
  sessionSink.sendServerImplementation = null;

  const wsUrl = `ws://${host}:${port}${standardCdpPath}`;
  const connect = (token: string, noDefaults = false) =>
    chromium.connectOverCDP(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      noDefaults,
    });
  await expect(connect(ticket())).rejects.toThrow();
  const rawTicket = ticket({ standardCdp: "whole-context" });
  const browser = await connect(rawTicket);
  cleanup.push(() => browser.close());
  const context = browser.contexts()[0]!;
  expect(context.pages().map((page) => page.url())).toEqual([`${origin}/existing`]);
  const page = context.pages()[0]!;
  expect(await page.title()).toBe("Initial page");

  const requests: string[] = [];
  const responses: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push(response.url()));
  await page.goto(`${origin}/app`);
  await page.click("#count");
  await page.fill("#name", "Playwright");
  await page.waitForSelector("button:text-is('Clicked')");
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>("#name")?.value)).toBe(
    "Playwright",
  );
  const frame = page.frameLocator("iframe");
  await frame.getByText("Frame button").click();
  expect(await frame.locator("button").textContent()).toBe("Clicked in frame");
  expect(asRecord(await agent("Target.getTargets")).targetInfos).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "iframe" })]),
  );

  await context.addCookies([{ name: "profile-cookie", value: "present", url: origin }]);
  expect(await context.cookies(origin)).toEqual([
    expect.objectContaining({ name: "profile-cookie", value: "present" }),
  ]);
  const response = page.waitForResponse(`${origin}/data`);
  expect(await page.evaluate(() => fetch("/data").then((res) => res.text()))).toBe(responseBody);
  expect(await (await response).text()).toBe(responseBody);
  expect(requests).toContain(`${origin}/data`);
  expect(responses).toContain(`${origin}/data`);

  await page.evaluate(() => localStorage.setItem("fixture", "saved"));
  expect(await context.storageState()).toMatchObject({
    origins: [{ origin, localStorage: [{ name: "fixture", value: "saved" }] }],
  });

  const largeInput = "input".repeat(260_000);
  expect(await page.evaluate((input) => input.length, largeInput)).toBe(largeInput.length);

  const consoleEvent = page.waitForEvent("console");
  await page.evaluate((body) => console.log(body), responseBody);
  expect((await consoleEvent).text()).toBe(responseBody);

  const workerEvent = page.waitForEvent("worker");
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const worker = new Worker("/worker.js");
          worker.onmessage = ({ data }) => resolve(data);
          window.addEventListener("terminate-fixture-worker", () => worker.terminate(), {
            once: true,
          });
          worker.postMessage("hello");
        }),
    ),
  ).toBe("worker: hello");
  const worker = await workerEvent;
  expect(await worker.evaluate(() => self.location.pathname)).toBe("/worker.js");
  const workerClosed = worker.waitForEvent("close");
  await page.evaluate(() => window.dispatchEvent(new Event("terminate-fixture-worker")));
  await workerClosed;

  const popupEvent = page.waitForEvent("popup");
  await page.evaluate(() => {
    window.open("/popup");
  });
  const popup = await popupEvent;
  expect(popup.context()).toBe(context);
  expect(await popup.title()).toBe("Initial page");

  const harnessPageEvent = context.waitForEvent("page");
  const harnessPageInfo = asRecord(await agent("Target.createTarget", { url: "about:blank" }));
  const harnessPage = await harnessPageEvent;
  expect(harnessPage.url()).toBe("about:blank");
  const harnessPageClosed = harnessPage.waitForEvent("close");
  await agent("Target.closeTarget", { targetId: harnessPageInfo.targetId });
  await harnessPageClosed;

  const newPage = await context.newPage();
  await newPage.goto(`${origin}/new`);
  expect(await newPage.title()).toBe("Initial page");
  await newPage.goto("about:blank");
  expect(newPage.url()).toBe("about:blank");
  await newPage.close();
  expect(context.pages()).toHaveLength(2);

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 600;
    const drawing = canvas.getContext("2d")!;
    const image = drawing.createImageData(canvas.width, canvas.height);
    let value = 1;
    for (let i = 0; i < image.data.length; i += 4) {
      value = (Math.imul(value, 1664525) + 1013904223) | 0;
      image.data[i] = value >>> 24;
      image.data[i + 1] = (value >>> 16) & 255;
      image.data[i + 2] = (value >>> 8) & 255;
      image.data[i + 3] = 255;
    }
    drawing.putImageData(image, 0, 0);
    document.body.append(canvas);
  });
  const viewport = () => page.evaluate(() => [innerWidth, innerHeight, scrollX, scrollY]);
  const beforeCapture = await viewport();
  const png = await page.screenshot({ fullPage: true });
  expect(await viewport()).toEqual(beforeCapture);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.length).toBeGreaterThan(432 * 1024);

  const staged = asRecord(
    await agent("Opensteer.stageFile", {
      name: "staged.txt",
      fileId: "playwright-upload",
      offset: 0,
      size: 6,
      data: "c3RhZ2Vk",
    }),
  );
  expect(staged.path).toBeDefined();
  await page.setInputFiles("#file", String(staged.path));
  expect(
    await page.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.text()),
  ).toBe("staged");
  await page.setInputFiles("#file", {
    name: "inline.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("inline"),
  });
  expect(
    await page.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.text()),
  ).toBe("inline");

  const clientDirectory = await mkdtemp(join(tmpdir(), "playwright-client-"));
  cleanup.push(() => rm(clientDirectory, { recursive: true, force: true }));
  const outsideFile = join(clientDirectory, "outside.txt");
  await writeFile(outsideFile, "outside");
  // Stock remote Playwright reads a client-local file and sends its bytes
  // through the page. Chromium never receives the client filesystem path.
  await page.setInputFiles("#file", outsideFile);
  expect(
    await page.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.text()),
  ).toBe("outside");

  // The managed profile denies downloads. Chromium reports the navigation
  // as a download, but stock Playwright receives no Download artifact.
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await expect(page.goto(`${origin}/file`)).rejects.toThrow("Download is starting");
  expect(page.url()).toBe(`${origin}/app`);

  await context.grantPermissions(["geolocation"], { origin });
  expect(
    await page.evaluate(
      async () => (await navigator.permissions.query({ name: "geolocation" })).state,
    ),
  ).toBe("granted");
  await context.clearPermissions();
  await context.clearCookies();
  expect(await context.cookies(origin)).toEqual([]);
  await context.addCookies([{ name: "profile-cookie", value: "survives", url: origin }]);

  await browser.close();
  expect(downloads).toEqual([]);
  await expect(connect(rawTicket)).rejects.toThrow();
  const reconnected = await connect(ticket({ standardCdp: "whole-context" }));
  cleanup.push(() => reconnected.close());
  const reconnectedPages = reconnected.contexts()[0]!.pages();
  expect(reconnectedPages.map((page) => page.url()).sort()).toEqual([
    `${origin}/app`,
    `${origin}/popup`,
  ]);
  const reconnectedPopup = reconnectedPages.find((page) => page.url().endsWith("/popup"));
  expect((await reconnectedPopup?.opener())?.url()).toBe(`${origin}/app`);
  await reconnected.close();

  const bridge = await startHarnessBridge(agent, sessionSink);
  cleanup.push(() => bridge.close());
  const tabs = asRecord(await agent("Opensteer.listTabs")).tabs as {
    surfaceId: string;
    url: string;
  }[];
  const rootTabId = tabs.find((tab) => tab.url === `${origin}/app`)?.surfaceId;
  expect(rootTabId).toBeDefined();
  const harness = await runHarness(
    bridge.url,
    claims.sessionId,
    rootTabId!,
    'console.log(await js("document.title"));',
  );
  expect(harness.stdout.trim()).toBe("Fixture");

  const foreignSessionId = createBrowserSessionId();
  const foreignSink = new FakeSink();
  await runtime.attach(ticket({ sessionId: foreignSessionId }), foreignSink);
  await expect(connect(ticket({ standardCdp: "whole-context" }))).rejects.toThrow();
  await expect(connect(ticket({ standardCdp: "session" }))).rejects.toThrow(
    "requires a whole browser context grant",
  );
  const shared = await connect(ticket({ standardCdp: "session" }), true);
  cleanup.push(() => shared.close());
  const foreign = await connect(
    ticket({ sessionId: foreignSessionId, standardCdp: "session" }),
    true,
  );
  cleanup.push(() => foreign.close());
  const sharedContext = shared.contexts()[0]!;
  const foreignContext = foreign.contexts()[0]!;
  expect(
    sharedContext
      .pages()
      .map((page) => page.url())
      .sort(),
  ).toEqual([`${origin}/app`, `${origin}/popup`]);
  expect(foreignContext.pages().map((page) => page.url())).toEqual(["about:blank"]);

  for (const refused of [
    () => sharedContext.cookies(),
    () => sharedContext.addCookies([{ name: "foreign", value: "denied", url: origin }]),
    () => sharedContext.clearCookies(),
    () => sharedContext.grantPermissions(["geolocation"], { origin }),
    () => sharedContext.clearPermissions(),
    () => sharedContext.storageState(),
  ])
    await expect(refused()).rejects.toThrow("requires a whole browser context grant");
  await foreignContext.pages()[0]!.goto(`${origin}/other-session`);
  expect(await foreignContext.pages()[0]!.evaluate(() => document.cookie)).toBe(
    "profile-cookie=survives",
  );
  const ended = Promise.withResolvers<void>();
  shared.once("disconnected", () => ended.resolve());
  await legacy.close();
  await ended.promise;
  expect(foreign.isConnected()).toBe(true);
});
