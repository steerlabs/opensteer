import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { asRecord, rootCdpNavigate, startFollowSession } from "./chromium.test-support.js";
import { cleanup } from "./browser-test-lifecycle.js";

const cdpRequest = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});

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
  const session = await startFollowSession({ args: ["--site-per-process"] });
  cleanup.push(() => session.files.dispose());
  const {
    browser: managed,
    cdpRouter: router,
    claims: { sessionId },
  } = session;
  await rootCdpNavigate(session.ledger, session.rootSurfaceId, `${origin}/existing`);
  const foreign = await managed.context.createPage();
  const foreignId = await foreign.targetId();
  router.registerSession(
    "foreign",
    foreignId,
    async () => !foreign.isClosed(),
    `${session.files.root}-foreign`,
  );

  const frames = new Set<string>();
  const receivedMethods = new Set<string>();
  const sockets = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  await once(sockets, "listening");
  let disconnected = Promise.withResolvers<void>();
  sockets.on("connection", (socket) => {
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const remove = router.onEvent(sessionId, (event) => {
      const { method, parameters: params, sessionId } = event;
      if (method === "Target.attachedToTarget" && sessionId)
        frames.add(String(asRecord(params.targetInfo).type));
      send({ method, params, sessionId });
    });
    socket.once("close", () => {
      remove();
      void router
        .send(sessionId, {
          method: "Target.setAutoAttach",
          parameters: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        })
        .then(() => disconnected.resolve(), disconnected.reject);
    });
    socket.on("message", (frame) => {
      const {
        id,
        method,
        params,
        sessionId: attached,
      } = cdpRequest.parse(JSON.parse(String(frame)));
      receivedMethods.add(method);
      void router
        .send(sessionId, {
          method,
          ...(params ? { parameters: params } : {}),
          ...(attached ? { sessionId: attached } : {}),
        })
        .then(
          (result) => send({ id, sessionId: attached, result }),
          (error: Error) =>
            send({ id, sessionId: attached, error: { code: -32000, message: error.message } }),
        );
    });
  });
  const wsUrl = `ws://127.0.0.1:${(sockets.address() as AddressInfo).port}`;
  const browser = await chromium.connectOverCDP(wsUrl);
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
  expect(frames).toContain("iframe");

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

  const personTab = await managed.context.createPage();
  const personPageEvent = context.waitForEvent("page");
  expect(await session.ledger.adoptTarget(await personTab.targetId())).toBe(true);
  const personPage = await personPageEvent;
  expect(personPage.url()).toBe("about:blank");
  const personPageClosed = personPage.waitForEvent("close");
  await personTab.close();
  await personPageClosed;

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
  const png = await page.screenshot({ fullPage: true });
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.length).toBeGreaterThan(432 * 1024);

  const staged = await session.files.stage({
    name: "staged.txt",
    fileId: "playwright-upload",
    offset: 0,
    size: 6,
    data: "c3RhZ2Vk",
  });
  expect(staged.path).toBeDefined();
  await page.setInputFiles("#file", staged.path!);
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
  receivedMethods.clear();
  await page.setInputFiles("#file", outsideFile);
  expect(receivedMethods.has("Runtime.callFunctionOn")).toBe(true);
  expect(receivedMethods.has("DOM.setFileInputFiles")).toBe(false);
  expect(
    await page.locator("#file").evaluate((input: HTMLInputElement) => input.files?.[0]?.text()),
  ).toBe("outside");

  // The managed profile denies downloads. Chromium reports the navigation
  // as a download, but stock Playwright receives no Download artifact.
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await expect(page.goto(`${origin}/file`)).rejects.toThrow("Download is starting");
  expect(page.url()).toBe(`${origin}/app`);

  await browser.close();
  await disconnected.promise;
  expect(downloads).toEqual([]);
  expect(managed.context.pages().map((page) => page.url())).toEqual(
    expect.arrayContaining([`${origin}/app`, `${origin}/popup`]),
  );
  expect(foreign.isClosed()).toBe(false);
  disconnected = Promise.withResolvers<void>();
  const reconnected = await chromium.connectOverCDP(wsUrl);
  cleanup.push(() => reconnected.close());
  expect(
    reconnected
      .contexts()[0]!
      .pages()
      .map((page) => page.url())
      .sort(),
  ).toEqual([`${origin}/app`, `${origin}/popup`]);
  await reconnected.close();
  await disconnected.promise;
});
