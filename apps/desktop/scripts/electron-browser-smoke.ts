import {
  browserFrameFits,
  defaultBrowserViewport,
  SessionCdpRouter,
} from "@opensteer/browser-core";
import {
  BrowserController,
  BrowserRuntime,
  BrowserRuntimeServer,
  HostSignIns,
  rasterShowsSize,
  SessionFiles,
  stageFileMethod,
  SurfaceLedger,
  type BrowserFrame,
  type BrowserLaunchRequest,
} from "@opensteer/browser-runtime-core";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserContextCandidateSchema,
  BrowserServerMessageSchema,
  BrowserSessionIdSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  app,
  BaseWindow,
  BrowserWindow,
  nativeImage,
  protocol,
  screen,
  session,
  webContents,
  type Debugger,
} from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  desktopAppEntryUrl,
  installDesktopAppProtocol,
  registerDesktopAppScheme,
} from "../src/app/app-protocol.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { configureDesktopSession } from "../src/app/electron-window.js";
import { DesktopAppOriginPolicy } from "../src/app/navigation-policy.js";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";
import { idleCpuPhase } from "./electron-idle-cpu-smoke.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";

const smokeDownloads = smokeDesktopDownloads();

const smokeProfile = mkdtempSync(path.join(tmpdir(), "opensteer-browser-smoke-"));
app.setPath("userData", smokeProfile);
app.setPath("sessionData", smokeProfile);
app.commandLine.appendSwitch("headless");
registerDesktopAppScheme(protocol);

// Hidden/headless WebContents do not consistently keep the macOS Electron app
// alive while custom-scheme navigation is pending. The harness owns an
// explicit liveness handle so a zero exit can only happen after all assertions.
const smokeLiveness = setInterval(() => undefined, 1_000);
let smokeFinished = false;
let lastStage = "startup";
app.on("before-quit", (event) => {
  if (!smokeFinished) event.preventDefault();
});
void withTimeout(run(), 90_000, {
  timeoutError: () => new Error(`Electron smoke stalled at ${lastStage}`),
}).then(
  async () => {
    smokeFinished = true;
    clearInterval(smokeLiveness);
    process.stdout.write(`${JSON.stringify({ event: "electron-browser-smoke.passed" })}\n`);
    await rm(smokeProfile, { recursive: true, force: true });
    app.quit();
  },
  (error: unknown) => {
    smokeFinished = true;
    clearInterval(smokeLiveness);
    process.stderr.write(
      `${JSON.stringify({
        event: "electron-browser-smoke.failed",
        message: error instanceof Error ? error.stack : String(error),
      })}\n`,
    );
    app.exit(1);
  },
);

async function run(): Promise<void> {
  await app.whenReady();
  if (process.env.OPENSTEER_IDLE_CPU_SMOKE === "1") {
    progress("idle-cpu-and-lifecycle");
    await idleCpuPhase();
    return;
  }
  progress("app-ready");
  // Keep Electron alive before the first asynchronous filesystem operation.
  // A headless process with no WebContents can otherwise exit before the smoke
  // reaches the security assertions.
  const shell = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  const shellRoot = await mkdtemp(path.join(tmpdir(), "opensteer-shell-smoke-"));
  await mkdir(path.join(shellRoot, "assets"));
  await writeFile(
    path.join(shellRoot, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Opensteer shell</title><script>globalThis.inlineScriptRan=true</script><script type="module" src="/assets/shell.js"></script>',
  );
  await writeFile(
    path.join(shellRoot, "assets", "shell.js"),
    "globalThis.bundledScriptRan = true;",
  );
  const uninstallAppProtocol = installDesktopAppProtocol(protocol, shellRoot);
  const shellPolicy = new DesktopAppOriginPolicy();
  configureDesktopSession(session.defaultSession, shellPolicy, null, smokeDownloads);
  shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shell.webContents.on("will-navigate", (event, url) => {
    if (!shellPolicy.allowsNavigation(url)) event.preventDefault();
  });
  await shell.loadURL(desktopAppEntryUrl);
  const shellSecurity = (await shell.webContents.executeJavaScript(`(async () => ({
    bundledScriptRan: globalThis.bundledScriptRan === true,
    externalNetworkBlocked: await fetch("http://127.0.0.1:9/v1/leak").then(() => false, () => true),
    inlineScriptBlocked: globalThis.inlineScriptRan !== true,
    nodeHidden: typeof require === "undefined" && typeof process === "undefined",
    origin: location.origin,
    popupBlocked: window.open("https://attacker.example", "_blank") === null,
    permissionDenied: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      () => resolve(false),
      () => resolve(true),
    )),
  }))()`)) as Record<string, unknown>;
  if (
    shellSecurity.origin !== "app://opensteer" ||
    shellSecurity.bundledScriptRan !== true ||
    shellSecurity.externalNetworkBlocked !== true ||
    shellSecurity.inlineScriptBlocked !== true ||
    shellSecurity.nodeHidden !== true ||
    shellSecurity.popupBlocked !== true ||
    shellSecurity.permissionDenied !== true
  ) {
    throw new Error(`Electron shell security mismatch: ${JSON.stringify(shellSecurity)}`);
  }
  shell.destroy();
  uninstallAppProtocol();
  await rm(shellRoot, { force: true, recursive: true });
  if (BrowserWindow.getAllWindows().length !== 0) {
    throw new Error("Electron shell security smoke left a native window open.");
  }
  progress("shell-security-passed");
  // A site's icon, served without a type as many servers do: the bytes say what it is.
  const sitePixels = Buffer.alloc(32 * 32 * 4, 255);
  const siteIcon = nativeImage.createFromBitmap(sitePixels, { width: 32, height: 32 }).toPNG();
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(200).end(siteIcon);
      return;
    }
    if (request.url === "/icon.svg") {
      response
        .writeHead(200, { "content-type": "image/svg+xml" })
        .end(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.background { fill: #00ff00; }</style><rect class="background" width="32" height="32"/></svg>',
        );
      return;
    }
    if (request.url === "/host-cookie-set") {
      response
        .writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "opensteer-host-smoke=authenticated; HttpOnly; Path=/; SameSite=Lax",
        })
        .end('{"ok":true}');
      return;
    }
    if (request.url === "/host-cookie-check") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
      return;
    }
    if (new URL(request.url ?? "/", "http://fixture").pathname === "/follow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(followPage);
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        request.url === "/popup"
          ? "<!doctype html><title>Popup</title><p>Popup</p>"
          : "<!doctype html><title>Electron browser smoke</title><p id=state>Ready</p>",
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  progress("server-listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Smoke server address is missing.");
  const origin = `http://127.0.0.1:${address.port}`;
  const hostNetwork = new ElectronHostNetwork();
  const cookieDeployment = "dep_00000000-0000-4000-8000-000000000001";
  const setCookie = await hostNetwork.partitionFetch(
    cookieDeployment,
    new URL("/host-cookie-set", origin),
    { credentials: "include", method: "POST" },
  );
  if (!setCookie.ok) throw new Error("Electron Host session did not accept its cookie response.");
  const checkedCookie = (await (
    await hostNetwork.partitionFetch(cookieDeployment, new URL("/host-cookie-check", origin), {
      credentials: "include",
      method: "GET",
    })
  ).json()) as { cookie?: unknown };
  if (
    typeof checkedCookie.cookie !== "string" ||
    !checkedCookie.cookie.includes("opensteer-host-smoke=authenticated")
  ) {
    throw new Error("Electron Host session did not retain its HttpOnly cookie.");
  }
  await hostNetwork.clearDeploymentSession(cookieDeployment);
  progress("host-session-cookie-passed");
  const request: BrowserLaunchRequest = {
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000001",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000002"),
    storage: { kind: "guest" },
  };
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  let first = await launcher.launch(request);
  if (
    BrowserWindow.getAllWindows().length !== 0 ||
    BaseWindow.getAllWindows().some(
      (candidate) => candidate.isVisible() && candidate.getOpacity() !== 0,
    )
  ) {
    throw new Error("Unpresented runtime exposed a standalone page window.");
  }
  progress("first-launched");
  const firstPage = first.context.pages()[0];
  if (!firstPage) throw new Error("Electron browser did not create its root page.");
  // Production wiring: the session's router owns the root page, and every page
  // the ledger registers, a tab the person opens included, is claimed for it.
  const cdpRouter = new SessionCdpRouter(first.cdp);
  const sessionFiles = new SessionFiles(
    path.join(await mkdtemp(path.join(tmpdir(), "opensteer-smoke-files-")), request.sessionId),
  );
  let ledger = new SurfaceLedger(first.context, {
    claimTarget: (targetId) => cdpRouter.claimTarget(request.sessionId, targetId),
    initialViewport: request.initialViewport,
  });
  const firstLedger = ledger;
  cdpRouter.registerSession(
    request.sessionId,
    await firstPage.targetId(),
    (targetId) => firstLedger.resolveTarget(targetId),
    sessionFiles.root,
  );
  await ledger.start();
  progress("first-ledger-started");
  const platformCdp = await firstPage.cdp();
  await platformCdp.send("Page.navigate", { url: origin });
  await waitFor(() => firstPage.url() === `${origin}/`);
  await waitFor(() =>
    ledger
      .snapshot()
      .some(
        (surface) =>
          surface.openerId == null &&
          surface.title === "Electron browser smoke" &&
          surface.url === `${origin}/`,
      ),
  );
  progress("first-navigated");
  // The tab names its site's icon, fetched by Electron's own browser.
  await waitFor(() =>
    ledger
      .snapshot()
      .some(
        (surface) =>
          surface.url === `${origin}/` &&
          surface.favicon !== undefined &&
          nativeImage.createFromDataURL(surface.favicon).toBitmap().equals(sitePixels),
      ),
  );
  progress("site-icon-read");
  const rasterIcon = ledger.snapshot().find((surface) => surface.url === `${origin}/`)?.favicon;
  const svgPixels = Buffer.alloc(32 * 32 * 4);
  for (let index = 0; index < svgPixels.length; index += 4) {
    svgPixels[index + 1] = 255;
    svgPixels[index + 3] = 255;
  }
  await platformCdp.send("Runtime.evaluate", {
    expression: `(() => {
      const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; img-src *";document.head.append(policy);
      const link=document.createElement('link');link.rel='icon';link.href=${JSON.stringify(`http://localhost:${address.port}/icon.svg`)};document.head.append(link);
    })()`,
  });
  const pageFetch = await platformCdp.send<{ result: { value: boolean } }>("Runtime.evaluate", {
    expression: `fetch(${JSON.stringify(`http://localhost:${address.port}/icon.svg`)}, {mode:'no-cors'}).then(()=>false,()=>true)`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (pageFetch.result.value !== true) throw new Error("Page CSP did not block the icon fetch.");
  await waitFor(() =>
    ledger
      .snapshot()
      .some(
        (surface) =>
          surface.url === `${origin}/` &&
          surface.favicon !== undefined &&
          nativeImage.createFromDataURL(surface.favicon).toBitmap().equals(svgPixels),
      ),
  );
  const vectorIcon = ledger.snapshot().find((surface) => surface.url === `${origin}/`)?.favicon;
  progress("cross-site-svg-csp-read");
  await platformCdp.send("Page.navigate", { url: `${origin}/history` });
  await waitFor(() =>
    ledger
      .snapshot()
      .some((surface) => surface.openerId == null && surface.url === `${origin}/history`),
  );
  const history = (await platformCdp.send("Page.getNavigationHistory")) as {
    currentIndex?: unknown;
    entries?: Array<{ id?: unknown }>;
  };
  const previousEntry = history.entries?.[Number(history.currentIndex) - 1]?.id;
  if (!Number.isInteger(previousEntry)) throw new Error("Electron browser history is missing.");
  await platformCdp.send("Page.navigateToHistoryEntry", {
    entryId: previousEntry,
  });
  await waitFor(() => firstPage.url() === `${origin}/`);
  await waitFor(() =>
    ledger.snapshot().some((surface) => surface.openerId == null && surface.url === `${origin}/`),
  );
  progress("history-metadata-synchronized");
  const blockedNavigation = (await platformCdp.send("Page.navigate", {
    url: "file:///etc/passwd",
  })) as { errorText?: unknown };
  if (
    typeof blockedNavigation.errorText !== "string" ||
    !blockedNavigation.errorText.includes("ERR_BLOCKED_BY_CLIENT")
  ) {
    throw new Error("Electron browser did not block a local-file request.");
  }
  await platformCdp.send("Page.navigate", { url: origin });
  await waitFor(() => firstPage.url() === `${origin}/`);
  await platformCdp.send("Runtime.evaluate", {
    expression: `document.cookie = "session=electron-cookie; SameSite=Lax";
      localStorage.setItem("account", "desktop");`,
  });
  progress("simple-storage-written");
  await platformCdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((resolve, reject) => {
      const opening = indexedDB.open("opensteer-electron", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("tokens");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("tokens", "readwrite");
        transaction.objectStore("tokens").put({ token: "portable", count: 2n }, "access");
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          database.close();
          resolve(true);
        };
      };
    })`,
  });
  progress("indexed-db-written");
  await platformCdp.send("Runtime.evaluate", {
    expression: 'window.open("/popup", "_blank") !== null',
    returnByValue: true,
  });
  progress("popup-requested");
  await waitFor(() => ledger.snapshot().length === 2);
  progress("popup-opened");
  const rootSurface = ledger.snapshot().find((surface) => surface.openerId == null);
  if (!rootSurface) throw new Error("Electron browser root surface is missing.");
  await ledger.activate(rootSurface.id);

  const agentCdp = await first.cdp.attach(await firstPage.targetId());
  await agentCdp.send("Page.enable");
  const title = asEvaluationValue(
    await agentCdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    }),
  );
  if (title !== "Electron browser smoke") throw new Error("Agent CDP did not control the page.");
  const readViewport = async () =>
    asEvaluationValue(
      await platformCdp.send("Runtime.evaluate", {
        expression: "({ height: window.innerHeight, width: window.innerWidth })",
        returnByValue: true,
      }),
    ) as { height?: unknown; width?: unknown };
  const restingViewport = await readViewport();
  if (restingViewport.height !== 600 || restingViewport.width !== 800) {
    throw new Error(`Electron resting viewport mismatch: ${JSON.stringify(restingViewport)}`);
  }
  progress("agent-cdp-ready");

  // A channel's command never reaches Chromium ahead of that channel's own
  // enable of its domain, even while the enable waits behind another
  // channel's disable. Profiler.start fails while Profiler is not enabled.
  const profilerProbe = await first.cdp.attach(await firstPage.targetId());
  const startedDisabled = await profilerProbe.send("Profiler.start").then(
    () => null,
    (error: unknown) => error,
  );
  if (!(startedDisabled instanceof Error)) {
    throw new Error(
      "Profiler.start ran without an enabled Profiler; the order probe proves nothing.",
    );
  }
  const profilerOwner = await first.cdp.attach(await firstPage.targetId());
  await profilerOwner.send("Profiler.enable");
  const released = profilerOwner.close();
  const enabled = profilerProbe.send("Profiler.enable");
  const started = profilerProbe.send("Profiler.start");
  await Promise.all([released, enabled, started]);
  await profilerProbe.send("Profiler.stop");
  await profilerProbe.close();
  progress("domain-order-kept");

  // Exercise the same controller path used by remote Web and Electron panels,
  // not only Electron's raw debugger mechanics.
  const routedMessages: BrowserServerMessage[] = [];
  const routedFrames: BrowserFrame[] = [];
  const controller = new BrowserController({
    cdpRouter,
    claims: BrowserAttachTicketClaimsSchema.parse({
      operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
      remainingBudgetMs: 18_000,
      wireVersion: 1,
      access: "full-control",
      audience: "opensteer-browser-runtime",
      expiresAt: "2030-01-01T00:05:00.000Z",
      identity: { kind: "fresh" },
      issuedAt: "2030-01-01T00:00:00.000Z",
      nonce: "nonce_0123456789abcdef",
      runtimeId: "electron-smoke",
      sessionId: request.sessionId,
      subject: "electron-smoke",
    }),
    files: sessionFiles,
    replaceSiteCookies: (site, cookies, deadline) =>
      first.replaceSiteCookies(site, cookies, deadline),
    signIns: new HostSignIns({
      state: { run: (work) => work() },
      writeCookies: () => Promise.resolve(),
      deliveryTimeoutMs: 1_000,
      executor: undefined,
      fresh: true,
      runtimeId: "electron-smoke",
    }),
    ledger,
    sink: {
      sendFrame: async (frame) => {
        routedFrames.push(frame);
      },
      sendServer: async (message) => {
        routedMessages.push(message);
      },
    },
  });
  await controller.start();
  await controller.handle({ type: "stream.subscribe" });
  await controller.handle({
    height: 480,
    surfaceId: rootSurface.id,
    type: "viewport.set",
    width: 640,
  });
  const panelViewport = await readViewport();
  if (panelViewport.height !== 480 || panelViewport.width !== 640) {
    throw new Error(`Electron panel viewport mismatch: ${JSON.stringify(panelViewport)}`);
  }
  await waitFor(() =>
    routedFrames.some(
      (frame) => frame.header.viewportHeight === 480 && frame.header.viewportWidth === 640,
    ),
  );

  const attachRequestId = "00000000-0000-4000-8000-000000000003";
  await controller.handle({
    command: {
      method: "Target.attachToTarget",
      parameters: { targetId: await firstPage.targetId() },
    },
    requestId: attachRequestId,
    type: "cdp.command",
  });
  const attached = routedMessages.find(
    (message) => message.type === "cdp.result" && message.requestId === attachRequestId,
  );
  const routedSessionId =
    attached?.type === "cdp.result" &&
    attached.result &&
    typeof attached.result === "object" &&
    typeof (attached.result as { sessionId?: unknown }).sessionId === "string"
      ? (attached.result as { sessionId: string }).sessionId
      : null;
  if (!routedSessionId) throw new Error("Electron controller did not attach agent CDP.");
  await controller.handle({
    command: {
      method: "Emulation.setDeviceMetricsOverride",
      parameters: {
        deviceScaleFactor: 1,
        height: 400,
        mobile: false,
        width: 500,
      },
      sessionId: routedSessionId,
    },
    requestId: "00000000-0000-4000-8000-000000000004",
    type: "cdp.command",
  });
  await waitForAsync(async () => {
    const viewport = await readViewport();
    return viewport.height === 400 && viewport.width === 500;
  });
  const routedAgentViewport = await readViewport();
  if (routedAgentViewport.height !== 400 || routedAgentViewport.width !== 500) {
    throw new Error(
      `Electron routed agent viewport mismatch: ${JSON.stringify(routedAgentViewport)}`,
    );
  }
  await controller.handle({
    command: {
      method: "Emulation.clearDeviceMetricsOverride",
      sessionId: routedSessionId,
    },
    requestId: "00000000-0000-4000-8000-000000000005",
    type: "cdp.command",
  });
  await waitForAsync(async () => {
    const viewport = await readViewport();
    return viewport.height === 480 && viewport.width === 640;
  });
  const routedRestoredViewport = await readViewport();
  if (routedRestoredViewport.height !== 480 || routedRestoredViewport.width !== 640) {
    throw new Error(
      `Electron routed viewport was not restored: ${JSON.stringify({ viewport: routedRestoredViewport, errors: routedMessages.filter((message) => message.type === "cdp.error") })}`,
    );
  }
  // Files reach Electron pages exactly as they reach Chromium: staged over the
  // session's own CDP channel, then handed to a real input and to the chooser a
  // page button opens. Paths outside the session's folder are refused.
  const routed = async (
    method: string,
    parameters?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    const requestId = randomUUID();
    await controller.handle({
      command: {
        method,
        ...(parameters ? { parameters } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      requestId,
      type: "cdp.command",
    });
    const reply = routedMessages.find(
      (message) =>
        (message.type === "cdp.result" || message.type === "cdp.error") &&
        message.requestId === requestId,
    );
    if (reply?.type === "cdp.error") throw new Error(reply.error.message);
    if (reply?.type !== "cdp.result") throw new Error(`${method} was not answered.`);
    return reply.result;
  };
  const upload = randomBytes(600_001);
  const uploadId = randomUUID();
  let stagedPath: string | undefined;
  for (let offset = 0; offset < upload.byteLength; offset += 256 * 1_024) {
    const part = upload.subarray(offset, offset + 256 * 1_024);
    const last = offset + part.byteLength >= upload.byteLength;
    const result = (await routed(stageFileMethod, {
      data: part.toString("base64"),
      fileId: uploadId,
      name: "listing photo.png",
      offset,
      ...(last ? { size: upload.byteLength } : {}),
    })) as { path?: string };
    if (last) stagedPath = result.path;
  }
  if (!stagedPath?.startsWith(`${sessionFiles.root}${path.sep}`)) {
    throw new Error(`Electron staging returned ${String(stagedPath)}`);
  }
  await routed(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression: `(() => {
        document.body.insertAdjacentHTML("beforeend", '<div id="files-check"><input id="single" type="file"><input id="hidden" type="file" style="display:none"><button id="choose" style="position:fixed;left:10px;top:10px;width:160px;height:48px;z-index:2147483647">Add photos</button></div>');
        window.received = {};
        const sum = async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let hash = 0;
          for (const byte of bytes) hash = (hash * 31 + byte) >>> 0;
          return { hash, name: file.name, size: file.size };
        };
        for (const id of ["single", "hidden"]) {
          document.getElementById(id).addEventListener("change", async (event) => {
            window.received[id] = { files: await Promise.all([...event.target.files].map(sum)), trusted: event.isTrusted };
          });
        }
        document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
      })()`,
    },
    routedSessionId,
  );
  const single = (await routed(
    "Runtime.evaluate",
    { expression: "document.getElementById('single')" },
    routedSessionId,
  )) as { result: { objectId?: string } };
  await routed(
    "DOM.setFileInputFiles",
    { files: [stagedPath], objectId: single.result.objectId },
    routedSessionId,
  );
  await routed("Page.enable", {}, routedSessionId);
  await routed("Page.setInterceptFileChooserDialog", { enabled: true }, routedSessionId);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await routed(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type, x: 90, y: 34 },
      routedSessionId,
    );
  }
  await waitFor(() =>
    routedMessages.some(
      (message) =>
        message.type === "cdp.event" &&
        message.event.method === "Page.fileChooserOpened" &&
        message.event.sessionId === routedSessionId,
    ),
  );
  const chooserEvent = routedMessages.find(
    (message) => message.type === "cdp.event" && message.event.method === "Page.fileChooserOpened",
  );
  const backendNodeId =
    chooserEvent?.type === "cdp.event" ? chooserEvent.event.parameters.backendNodeId : undefined;
  await routed("DOM.setFileInputFiles", { backendNodeId, files: [stagedPath] }, routedSessionId);
  await routed("Page.setInterceptFileChooserDialog", { enabled: false }, routedSessionId);
  let received: Record<
    string,
    { files: { hash: number; name: string; size: number }[]; trusted: boolean }
  > = {};
  const deadline = Date.now() + 10_000;
  while (!(received.single && received.hidden)) {
    if (Date.now() > deadline)
      throw new Error(`Electron files did not arrive: ${JSON.stringify(received)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    received = (
      (await routed(
        "Runtime.evaluate",
        { expression: "window.received", returnByValue: true },
        routedSessionId,
      )) as { result: { value: typeof received } }
    ).result.value;
  }
  let expectedHash = 0;
  for (const byte of upload) expectedHash = (expectedHash * 31 + byte) >>> 0;
  for (const id of ["single", "hidden"] as const) {
    const [file] = received[id]?.files ?? [];
    if (
      received[id]?.trusted !== true ||
      file?.name !== "listing photo.png" ||
      file.size !== upload.byteLength ||
      file.hash !== expectedHash
    ) {
      throw new Error(`Electron ${id} received ${JSON.stringify(received[id])}`);
    }
  }
  const refused = await routed(
    "DOM.setFileInputFiles",
    { files: ["/etc/hosts"], objectId: single.result.objectId },
    routedSessionId,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(refused instanceof Error) || !refused.message.includes("staged for this Browser Session")) {
    throw new Error("Electron accepted a file outside the session's folder.");
  }
  await routed(
    "Runtime.evaluate",
    { expression: 'document.getElementById("files-check").remove()' },
    routedSessionId,
  );
  await sessionFiles.dispose();
  progress("session-files-delivered");

  // A maximized panel emulates larger than the hidden BaseWindow resting
  // bounds. Growing past the native widget is the one direction where Electron
  // offscreen compositing could diverge from Playwright, so the smoke asserts
  // both the emulated layout and the encoded frame at that larger size.
  await controller.handle({
    height: 900,
    surfaceId: rootSurface.id,
    type: "viewport.set",
    width: 1440,
  });
  const grownViewport = await readViewport();
  if (grownViewport.height !== 900 || grownViewport.width !== 1440) {
    throw new Error(`Electron grown viewport mismatch: ${JSON.stringify(grownViewport)}`);
  }
  await waitFor(() =>
    routedFrames.some(
      (frame) =>
        frame.header.viewportHeight === 900 &&
        frame.header.viewportWidth === 1440 &&
        sameShape(frame.header),
    ),
  );
  // The picture is no longer capped at 1280×720: it carries up to two pixels
  // per CSS pixel, inside the frame bound.
  const grownFrame = routedFrames.find(
    (frame) =>
      frame.header.viewportHeight === 900 &&
      frame.header.viewportWidth === 1440 &&
      sameShape(frame.header),
  )!;
  const grownRaster = jpegSize(grownFrame.data);
  if (
    grownRaster.width < 1440 ||
    grownRaster.height < 900 ||
    grownRaster.width > 2880 ||
    grownRaster.height > 1800 ||
    !browserFrameFits(grownRaster.width, grownRaster.height)
  ) {
    throw new Error(`Electron grown raster is out of bounds: ${JSON.stringify(grownRaster)}`);
  }
  await controller.handle({
    height: 600,
    surfaceId: rootSurface.id,
    type: "viewport.set",
    width: 800,
  });
  progress("controller-viewport-passed");

  // The person and the agent act in one page at once. The agent's evaluation
  // waits in the page for the person's next click, then their next key; the
  // person's input reaches the page through the viewer's channel while it
  // waits. Serialized debugger commands would deadlock here.
  const rootTargetId = await firstPage.targetId();
  const readAwaiting = async () =>
    asEvaluationValue(
      await platformCdp.send("Runtime.evaluate", {
        expression: "document.body.dataset.awaiting ?? null",
        returnByValue: true,
      }),
    );
  await routed(
    "Runtime.evaluate",
    {
      expression: `(() => {
        document.getElementById("concurrency-field")?.remove();
        document.body.insertAdjacentHTML("beforeend", '<input id="concurrency-field" style="position:fixed;left:0;top:0;width:800px;height:600px;opacity:0.01;z-index:2147483647">');
      })()`,
    },
    routedSessionId,
  );
  const awaitPersonInput = (kind: "click" | "key") =>
    routed(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        expression: `new Promise((resolve) => {
          const field = document.getElementById("concurrency-field");
          const started = performance.now();
          field.addEventListener(${JSON.stringify(kind === "click" ? "mousedown" : "keydown")}, (event) => {
            resolve({ trusted: event.isTrusted, waitedMs: Math.round(performance.now() - started) });
          }, { once: true });
          document.body.dataset.awaiting = ${JSON.stringify(kind)};
        })`,
        returnByValue: true,
      },
      routedSessionId,
    );
  const concurrencyBoundMs = 5_000;
  const personActsWhileAgentWaits = async (
    kind: "click" | "key",
    act: () => Promise<void>,
  ): Promise<{
    personInputMs: number;
    resolvedMs: number;
    trusted: boolean;
  }> => {
    const waiting = awaitPersonInput(kind);
    await withTimeout(
      waitForAsync(async () => (await readAwaiting()) === kind),
      concurrencyBoundMs,
      {
        timeoutError: () =>
          new Error(`The viewer's channel waited behind the agent's pending evaluation (${kind}).`),
      },
    );
    const started = performance.now();
    await withTimeout(act(), concurrencyBoundMs, {
      timeoutError: () =>
        new Error(`The person's ${kind} waited behind the agent's pending evaluation.`),
    });
    const personInputMs = Math.round(performance.now() - started);
    const answered = asEvaluationValue(
      await withTimeout(waiting, concurrencyBoundMs, {
        timeoutError: () => new Error(`The agent's evaluation never saw the person's ${kind}.`),
      }),
    ) as { trusted?: unknown };
    const resolvedMs = Math.round(performance.now() - started);
    if (answered.trusted !== true) {
      throw new Error(`The agent saw an untrusted ${kind}: ${JSON.stringify(answered)}`);
    }
    return { personInputMs, resolvedMs, trusted: true };
  };
  const targetInfo = async (targetId: string) =>
    asRecord(asRecord(await routed("Target.getTargetInfo", { targetId })).targetInfo);
  const click = await personActsWhileAgentWaits("click", async () => {
    for (const action of ["down", "up"] as const) {
      await controller.handle({
        action,
        button: "left",
        clickCount: 1,
        surfaceId: rootSurface.id,
        type: "input.pointer",
        viewportHeight: 600,
        viewportWidth: 800,
        x: 0.5,
        y: 0.5,
      });
    }
  });
  const afterClick = asRecord((await targetInfo(rootTargetId)).userActivity);
  if (afterClick.kind !== "click" || afterClick.sinceLastAgentCommand !== true) {
    throw new Error(`The agent did not learn of the person's click: ${JSON.stringify(afterClick)}`);
  }
  const key = await personActsWhileAgentWaits("key", async () => {
    for (const action of ["down", "up"] as const) {
      await controller.handle({
        action,
        code: "KeyQ",
        key: "q",
        modifiers: [],
        surfaceId: rootSurface.id,
        ...(action === "down" ? { text: "q" } : {}),
        type: "input.key",
      });
    }
  });
  const pasted = `electron-person-paste-${randomUUID()}`;
  await controller.handle({
    surfaceId: rootSurface.id,
    text: pasted,
    type: "clipboard.paste",
  });
  const afterTyping = await targetInfo(rootTargetId);
  const typingActivity = asRecord(afterTyping.userActivity);
  if (
    typingActivity.kind !== "typing" ||
    typingActivity.sinceLastAgentCommand !== true ||
    JSON.stringify(afterTyping).includes(pasted) ||
    Object.keys(typingActivity).some(
      (field) => !["at", "kind", "sinceLastAgentCommand", "x", "y"].includes(field),
    )
  ) {
    throw new Error(
      `Person typing activity is wrong or leaks content: ${JSON.stringify(afterTyping)}`,
    );
  }
  const reattached = asRecord(
    await routed("Target.attachToTarget", {
      flatten: true,
      targetId: rootTargetId,
    }),
  );
  if (asRecord(reattached.userActivity).sinceLastAgentCommand !== true) {
    throw new Error(`Attach did not report unseen activity: ${JSON.stringify(reattached)}`);
  }
  const seenOnce = asRecord(
    await routed("Target.attachToTarget", {
      flatten: true,
      targetId: rootTargetId,
    }),
  );
  if (asRecord(seenOnce.userActivity).sinceLastAgentCommand !== false) {
    throw new Error(
      `Attach repeated activity the agent already heard: ${JSON.stringify(seenOnce)}`,
    );
  }
  const typedValue = asEvaluationValue(
    await routed(
      "Runtime.evaluate",
      {
        expression: 'document.getElementById("concurrency-field").value',
        returnByValue: true,
      },
      routedSessionId,
    ),
  );
  if (typeof typedValue !== "string" || !typedValue.includes(pasted)) {
    throw new Error(`The person's paste did not reach the page: ${JSON.stringify(typedValue)}`);
  }
  await routed(
    "Runtime.evaluate",
    { expression: 'document.getElementById("concurrency-field").remove()' },
    routedSessionId,
  );
  progress("concurrent-person-input-passed");

  // A tab the person opens starts at the size of their view, is visible to the
  // agent with its popups, and a Fit on it never resizes another page.
  await controller.handle({
    type: "surface.open",
    url: `${origin}/person`,
    viewport: { height: 700, width: 1_000 },
  });
  const personSurface = ledger.active();
  if (!personSurface || personSurface.surface.id === rootSurface.id) {
    throw new Error("The person's new tab did not open.");
  }
  await waitFor(() => personSurface.page.url() === `${origin}/person`);
  const listed = asRecord(await routed("Target.getTargets")).targetInfos;
  const listedPerson = (Array.isArray(listed) ? listed : [])
    .map(asRecord)
    .find((info) => info.targetId === personSurface.targetId);
  if (listedPerson?.surfaceId !== personSurface.surface.id) {
    throw new Error(`The agent cannot see the person's tab: ${JSON.stringify(listed)}`);
  }
  const personAttach = asRecord(
    await routed("Target.attachToTarget", {
      flatten: true,
      targetId: personSurface.targetId,
    }),
  );
  const personSessionId = personAttach.sessionId;
  if (typeof personSessionId !== "string" || personAttach.surfaceId !== personSurface.surface.id) {
    throw new Error(`The agent cannot attach to the person's tab: ${JSON.stringify(personAttach)}`);
  }
  const agentViewport = async (sessionId: string) =>
    asEvaluationValue(
      await routed(
        "Runtime.evaluate",
        {
          expression: "({ height: innerHeight, width: innerWidth })",
          returnByValue: true,
        },
        sessionId,
      ),
    ) as { height?: unknown; width?: unknown };
  const personStartSize = await agentViewport(personSessionId);
  if (personStartSize.width !== 1_000 || personStartSize.height !== 700) {
    throw new Error(
      `The person's tab did not start at their size: ${JSON.stringify(personStartSize)}`,
    );
  }
  await controller.handle({
    height: 650,
    surfaceId: personSurface.surface.id,
    type: "viewport.set",
    width: 900,
  });
  const personFitSize = await agentViewport(personSessionId);
  const rootAfterPersonFit = await readViewport();
  if (
    personFitSize.width !== 900 ||
    personFitSize.height !== 650 ||
    rootAfterPersonFit.width !== 800 ||
    rootAfterPersonFit.height !== 600
  ) {
    throw new Error(
      `Fit reached another page: ${JSON.stringify({ personFitSize, rootAfterPersonFit })}`,
    );
  }
  await routed(
    "Runtime.evaluate",
    {
      expression: `window.open(${JSON.stringify(`${origin}/popup`)}, "_blank") !== null`,
    },
    personSessionId,
  );
  let personPopupTargetId: string | null = null;
  await waitForAsync(async () => {
    const infos = asRecord(await routed("Target.getTargets")).targetInfos;
    const popup = (Array.isArray(infos) ? infos : [])
      .map(asRecord)
      .find((info) => info.openerId === personSurface.targetId);
    personPopupTargetId = typeof popup?.targetId === "string" ? popup.targetId : null;
    return personPopupTargetId !== null;
  });
  // Both agent- and person-opened popups are listed without changing selection.
  await routed("Target.attachToTarget", {
    flatten: true,
    targetId: personPopupTargetId,
  });
  if (ledger.active()?.surface.id !== personSurface.surface.id) {
    throw new Error("A popup the agent opened took the person's view.");
  }
  await personSurface.cdp.send("Runtime.evaluate", {
    expression: `document.addEventListener("click", () => window.open(${JSON.stringify(`${origin}/popup`)}, "_blank"), { once: true })`,
  });
  for (const action of ["down", "up"] as const) {
    await controller.handle({
      action,
      button: "left",
      clickCount: 1,
      surfaceId: personSurface.surface.id,
      type: "input.pointer",
      viewportHeight: 650,
      viewportWidth: 900,
      x: 0.5,
      y: 0.5,
    });
  }
  await waitFor(() => ledger.snapshot().filter((surface) => surface.openerId != null).length >= 2);
  if (ledger.active()?.surface.id !== personSurface.surface.id)
    throw new Error("A popup changed the person's selection.");
  const openedPopup = ledger.snapshot().findLast((surface) => surface.openerId != null);
  const personOpenedPopup = openedPopup ? ledger.binding(openedPopup.id) : null;
  const personOpenedPopupInfo = personOpenedPopup
    ? asRecord(
        asRecord(
          await routed("Target.getTargetInfo", {
            targetId: personOpenedPopup.targetId,
          }),
        ).targetInfo,
      )
    : {};
  if (personOpenedPopupInfo.openerId !== personSurface.targetId) {
    throw new Error(
      `The popup in front is not the person's: ${JSON.stringify(personOpenedPopupInfo)}`,
    );
  }
  const created = asRecord(await routed("Target.createTarget", { url: "about:blank" }));
  if (typeof created.targetId !== "string") throw new Error("Target.createTarget failed.");
  const agentTab = asRecord(
    await routed("Target.attachToTarget", {
      flatten: true,
      targetId: created.targetId,
    }),
  );
  if (typeof agentTab.sessionId !== "string") throw new Error("Agent tab attach failed.");
  const agentTabSize = await agentViewport(agentTab.sessionId);
  if (
    agentTabSize.width !== request.initialViewport.width ||
    agentTabSize.height !== request.initialViewport.height
  ) {
    throw new Error(
      `The agent's tab did not start at the agent size: ${JSON.stringify(agentTabSize)}`,
    );
  }
  for (const surface of ledger.snapshot()) {
    if (surface.id === rootSurface.id || surface.openerId != null) continue;
    if (
      surface.id === personSurface.surface.id ||
      ledger.binding(surface.id)?.targetId === created.targetId
    ) {
      await controller.handle({ surfaceId: surface.id, type: "surface.close" });
    }
  }
  await controller.handle({
    surfaceId: rootSurface.id,
    type: "surface.activate",
  });
  progress("person-tab-shared-passed");

  const artifactDirectory =
    process.env.OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-shared-browser-e2e");
  await mkdir(artifactDirectory, { recursive: true });
  if (!rasterIcon || !vectorIcon) throw new Error("Missing verified icon artifacts.");
  await writeFile(
    path.join(artifactDirectory, "electron-site-icon.png"),
    nativeImage.createFromDataURL(rasterIcon).toPNG(),
  );
  await writeFile(
    path.join(artifactDirectory, "electron-cross-site-icon.png"),
    nativeImage.createFromDataURL(vectorIcon).toPNG(),
  );
  await writeFile(
    path.join(artifactDirectory, "electron-shared-browser.json"),
    `${JSON.stringify(
      {
        engine: "electron",
        versions: {
          chrome: process.versions.chrome,
          electron: process.versions.electron,
        },
        generatedAt: new Date().toISOString(),
        siteIcons: { width: 32, height: 32, decodedPixelsMatch: true, crossSiteSvgUnderCsp: true },
        concurrency: { boundMs: concurrencyBoundMs, click, key },
        activity: {
          afterClick,
          afterTyping: typingActivity,
          attachReportsUnseenOnce: true,
          omitsTypedContent: true,
        },
        personTab: {
          listedToAgent: true,
          attachedByAgent: true,
          startSize: personStartSize,
          fitSize: personFitSize,
          rootSizeAfterPersonFit: rootAfterPersonFit,
          popupListedToAgent: personPopupTargetId !== null,
          agentPopupStayedBehind: true,
          personPopupCameForward: true,
        },
        domainOrderKept: true,
        agentTab: { startSize: agentTabSize },
      },
      null,
      2,
    )}\n`,
  );
  await controller.handle({ type: "stream.unsubscribe" });
  await controller.close();
  await cdpRouter.close();

  let screencastFrames = 0;
  let agentScreencastFrames = 0;
  const removeAgentFrameListener = agentCdp.onEvent((method) => {
    if (method === "Page.screencastFrame") agentScreencastFrames += 1;
  });
  const removeFrameListener = platformCdp.onEvent((method, parameters) => {
    if (method !== "Page.screencastFrame") return;
    screencastFrames += 1;
    const sessionId = parameters.sessionId;
    if (typeof sessionId === "number") {
      void platformCdp.send("Page.screencastFrameAck", { sessionId });
    }
  });
  await agentCdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 400,
    mobile: false,
    width: 500,
  });
  await platformCdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
  });
  // A newly subscribed viewer must receive the current static page without a
  // native mount or a synthetic mutation to wake Chromium's compositor.
  await waitFor(() => screencastFrames > 0);
  const initialScreencastFrames = screencastFrames;
  await agentCdp.send("Runtime.evaluate", {
    expression: 'document.querySelector("#state").textContent = String(Math.random())',
  });
  await waitFor(() => screencastFrames > initialScreencastFrames);
  const emulatedViewport = await readViewport();
  if (emulatedViewport.height !== 400 || emulatedViewport.width !== 500) {
    throw new Error(`Electron emulated viewport mismatch: ${JSON.stringify(emulatedViewport)}`);
  }
  await agentCdp.send("Page.startScreencast", { format: "jpeg", quality: 20 });
  await agentCdp.send("Page.stopScreencast");
  const beforeMutation = screencastFrames;
  const agentFramesAfterStop = agentScreencastFrames;
  await agentCdp.send("Runtime.evaluate", {
    expression: 'document.querySelector("#state").textContent = String(Math.random())',
  });
  await waitFor(() => screencastFrames > beforeMutation);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (agentScreencastFrames !== agentFramesAfterStop) {
    throw new Error("A stopped Electron CDP channel still received screencast frames.");
  }
  progress("screencast-multiplexed");
  await platformCdp.send("Page.stopScreencast");
  const viewportAfterStreaming = await readViewport();
  if (viewportAfterStreaming.height !== 400 || viewportAfterStreaming.width !== 500) {
    throw new Error(
      `Electron viewer changed agent emulation: ${JSON.stringify(viewportAfterStreaming)}`,
    );
  }
  await agentCdp.send("Emulation.clearDeviceMetricsOverride");
  await waitForAsync(async () => {
    const viewport = await readViewport();
    return viewport.height === 600 && viewport.width === 800;
  });
  const restoredViewport = await readViewport();
  if (restoredViewport.height !== 600 || restoredViewport.width !== 800) {
    throw new Error(
      `Electron resting viewport was not restored: ${JSON.stringify(restoredViewport)}`,
    );
  }
  removeFrameListener();
  removeAgentFrameListener();
  await agentCdp.close();

  const snapshot = await first.exportSnapshot();
  progress("snapshot-exported");
  if (!snapshot.cookies.some((cookie) => cookie.name === "session")) {
    throw new Error("Electron profile did not export cookies.");
  }
  if (!snapshot.origins.some((state) => state.origin === origin && state.indexedDB?.length)) {
    throw new Error("Electron profile did not export origin storage.");
  }
  await ledger.close();
  await first.close();

  first = await launcher.launch({ ...request, storage: { kind: "legacy", snapshot } });
  progress("second-launched");
  ledger = new SurfaceLedger(first.context, {
    initialViewport: request.initialViewport,
  });
  await ledger.start();
  const restoredPage = first.context.pages()[0];
  if (!restoredPage) throw new Error("Restored Electron profile did not start.");
  const restoredCdp = await restoredPage.cdp();
  await restoredCdp.send("Page.navigate", { url: origin });
  await waitFor(() => restoredPage.url() === `${origin}/`);
  progress("second-navigated");
  const restored = asEvaluationValue(
    await restoredCdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve, reject) => {
        const opening = indexedDB.open("opensteer-electron");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const database = opening.result;
          const reading = database.transaction("tokens").objectStore("tokens").get("access");
          reading.onerror = () => reject(reading.error);
          reading.onsuccess = () => {
            resolve({
              cookie: document.cookie,
              indexedDB: { ...reading.result, count: String(reading.result.count) },
              localStorage: localStorage.getItem("account"),
            });
            database.close();
          };
        };
      })`,
      returnByValue: true,
    }),
  );
  const restoredRecord = restored as {
    cookie?: unknown;
    indexedDB?: { count?: unknown; token?: unknown };
    localStorage?: unknown;
  };
  if (
    restoredRecord.cookie !== "session=electron-cookie" ||
    restoredRecord.indexedDB?.count !== "2" ||
    restoredRecord.indexedDB.token !== "portable" ||
    restoredRecord.localStorage !== "desktop"
  ) {
    throw new Error(`Electron profile restore mismatch: ${JSON.stringify(restored)}`);
  }

  await ledger.close();
  await first.close();
  await transportAgentSizePhase(origin);
  progress("transport-agent-size-passed");
  await followViewPhase(launcher, origin);
  progress("follow-view-passed");
  if (BaseWindow.getAllWindows().length !== 0) {
    throw new Error("Electron browser runtime left a resting renderer host open.");
  }
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

/*
 * A size reply can be valid only in memory and end the session on the wire;
 * the page can miss or keep the agent's size; views can miss sizedByAgent
 * changes; an override can disappear on navigation; Fit can fail to remove it.
 */
async function transportAgentSizePhase(origin: string): Promise<void> {
  const runtimeId = "electron-size-transport-smoke";
  const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const runtime = new BrowserRuntime({
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    launcher,
    runtimeId,
    sessionFilesRoot: path.join(smokeProfile, "transport-session-files"),
    ticketVerifier: {
      verify: async (ticket) => {
        if (ticket !== "electron-size-smoke-ticket") throw new Error("Unexpected smoke ticket.");
        const now = Date.now();
        return BrowserAttachTicketClaimsSchema.parse({
          operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
          remainingBudgetMs: 18_000,
          wireVersion: 1,
          access: "full-control",
          audience: "opensteer-browser-runtime",
          expiresAt: new Date(now + 300_000).toISOString(),
          identity: { kind: "fresh" },
          issuedAt: new Date(now).toISOString(),
          nonce: "electron_size_smoke_nonce",
          runtimeId,
          sessionId,
          subject: "electron-size-smoke",
        });
      },
    },
  });
  const server = new BrowserRuntimeServer({ host: "127.0.0.1", port: 0, runtime });
  const frames: BrowserServerMessage[] = [];
  const wireFrames: unknown[] = [];
  const steps: Array<{
    step: string;
    size: { width: number; height: number };
    sizedByAgent: boolean;
  }> = [];
  let socket: WebSocket | undefined;
  let refused: unknown;
  let closed = false;
  let failure: string | undefined;
  const healthy = () => {
    if (refused) throw new Error(`Runner bridge would refuse a frame: ${String(refused)}`);
    if (closed || socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Browser Runtime socket closed during the agent size journey.");
    }
  };
  const until = (predicate: () => boolean) =>
    waitFor(() => {
      healthy();
      return predicate();
    });
  try {
    const address = await server.start();
    socket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
      headers: { authorization: "Bearer electron-size-smoke-ticket" },
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const frame: unknown = JSON.parse(String(data));
        wireFrames.push(frame);
        frames.push(BrowserServerMessageSchema.parse(frame));
      } catch (error) {
        refused = error;
      }
    });
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", (error) => {
      refused = error;
    });
    await once(socket, "open");
    await until(() => frames.some((frame) => frame.type === "browser.snapshot"));
    const snapshot = frames.find((frame) => frame.type === "browser.snapshot");
    if (snapshot?.type !== "browser.snapshot") throw new Error("Runtime omitted its snapshot.");
    const surface = snapshot.surfaces.find((candidate) => candidate.openerId == null);
    if (!surface) throw new Error("Runtime omitted the root surface.");

    const command = async (
      method: string,
      parameters?: Record<string, unknown>,
      pageSessionId?: string,
    ) => {
      healthy();
      const requestId = randomUUID();
      socket!.send(
        JSON.stringify({
          command: {
            method,
            ...(parameters ? { parameters } : {}),
            ...(pageSessionId ? { sessionId: pageSessionId } : {}),
          },
          requestId,
          type: "cdp.command",
        }),
      );
      await until(() =>
        frames.some(
          (frame) =>
            (frame.type === "cdp.result" || frame.type === "cdp.error") &&
            frame.requestId === requestId,
        ),
      );
      const reply = frames.find(
        (frame) =>
          (frame.type === "cdp.result" || frame.type === "cdp.error") &&
          frame.requestId === requestId,
      );
      if (reply?.type !== "cdp.result")
        throw new Error(`${method} failed: ${JSON.stringify(reply)}`);
      return reply;
    };
    const targets = await command("Target.getTargets");
    const targetId = asRecord(targets.result).rootTargetId;
    if (typeof targetId !== "string") throw new Error("Runtime omitted the root target.");
    const attach = async () => {
      const reply = await command("Target.attachToTarget", { flatten: true, targetId });
      const id = asRecord(reply.result).sessionId;
      if (typeof id !== "string") throw new Error("Target attach omitted its session ID.");
      return id;
    };
    let pageSessionId = await attach();
    await command("Page.navigate", { url: `${origin}/follow` }, pageSessionId);
    const evaluate = async (expression: string) =>
      asEvaluationValue(
        (await command("Runtime.evaluate", { expression, returnByValue: true }, pageSessionId))
          .result,
      );
    await waitForAsync(async () => (await evaluate("location.pathname")) === "/follow");
    const readSize = async () => {
      const value = asRecord(await evaluate("({ width: innerWidth, height: innerHeight })"));
      if (typeof value.width !== "number" || typeof value.height !== "number") {
        throw new Error(`Runtime did not return a page size: ${JSON.stringify(value)}`);
      }
      return { width: value.width, height: value.height };
    };
    const latestSurface = () => {
      for (const frame of frames.toReversed()) {
        if (frame.type === "browser.snapshot" || frame.type === "browser.surfaces.changed")
          return frame.surfaces.find((candidate) => candidate.id === surface.id);
      }
      return undefined;
    };
    const expectStep = async (
      step: string,
      width: number,
      height: number,
      sizedByAgent: boolean,
    ) => {
      const size = await readSize();
      if (size.width !== width || size.height !== height) {
        throw new Error(`${step} page size mismatch: ${JSON.stringify(size)}`);
      }
      const observed = latestSurface()?.sizedByAgent;
      if (observed !== sizedByAgent) {
        throw new Error(`${step} sizedByAgent mismatch: ${JSON.stringify(observed)}`);
      }
      const probe = await evaluate("1+1");
      if (probe !== 2) throw new Error(`${step} ordinary command failed: ${JSON.stringify(probe)}`);
      healthy();
      steps.push({ step, size, sizedByAgent: observed });
    };
    /**
     * A write the person makes has no reply, and the ledger announces the
     * agent's size gone before the page has its new size: wait for a later
     * geometry revision as well as the flag.
     */
    const expectSurface = async (after: number, sizedByAgent: boolean, beyondRevision = -1) => {
      await until(() =>
        frames.slice(after).some((frame) => {
          if (frame.type !== "browser.surfaces.changed") return false;
          const changed = frame.surfaces.find((candidate) => candidate.id === surface.id);
          return (
            changed?.sizedByAgent === sizedByAgent &&
            (changed.geometryRevision ?? 0) > beyondRevision
          );
        }),
      );
    };
    const expectEmptyReply = (reply: Awaited<ReturnType<typeof command>>) => {
      if (
        Object.keys(reply).length !== 3 ||
        reply.type !== "cdp.result" ||
        JSON.stringify(reply.result) !== "{}"
      ) {
        throw new Error(`Size write did not return CDP's empty object: ${JSON.stringify(reply)}`);
      }
    };
    await expectStep("initial", 800, 600, false);
    const metrics = { deviceScaleFactor: 0, height: 900, mobile: false, width: 1_280 };
    let after = frames.length;
    expectEmptyReply(await command("Emulation.setDeviceMetricsOverride", metrics, pageSessionId));
    await expectSurface(after, true);
    await expectStep("agent set", 1_280, 900, true);
    expectEmptyReply(await command("Emulation.setDeviceMetricsOverride", metrics, pageSessionId));
    await expectStep("identical set", 1_280, 900, true);
    after = frames.length;
    expectEmptyReply(
      await command("Emulation.clearDeviceMetricsOverride", undefined, pageSessionId),
    );
    await expectSurface(after, false);
    await expectStep("agent clear", 800, 600, false);
    after = frames.length;
    expectEmptyReply(await command("Emulation.setDeviceMetricsOverride", metrics, pageSessionId));
    await expectSurface(after, true);
    await expectStep("set before detach", 1_280, 900, true);
    await command("Target.detachFromTarget", { sessionId: pageSessionId });
    pageSessionId = await attach();
    await expectStep("reattached before navigation", 1_280, 900, true);
    await command("Page.navigate", { url: `${origin}/history` }, pageSessionId);
    await waitForAsync(async () => (await evaluate("location.pathname")) === "/history");
    await command("Target.detachFromTarget", { sessionId: pageSessionId });
    pageSessionId = await attach();
    await expectStep("reattached after navigation", 1_280, 900, true);
    after = frames.length;
    const sizedRevision = latestSurface()?.geometryRevision ?? 0;
    socket.send(
      JSON.stringify({ type: "viewport.set", surfaceId: surface.id, width: 800, height: 600 }),
    );
    await expectSurface(after, false, sizedRevision);
    await expectStep("person Fit", 800, 600, false);
    const info = await command("Target.getTargetInfo", { targetId });
    if (
      asRecord(asRecord(info.result).targetInfo).pageResize === undefined ||
      asRecord(asRecord(asRecord(info.result).targetInfo).pageResize).agentSizeRemoved !== true
    ) {
      throw new Error(`Fit did not report agentSizeRemoved: ${JSON.stringify(info.result)}`);
    }
    await expectStep("Fit target metadata", 800, 600, false);
    healthy();
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    try {
      const artifactDirectory =
        process.env.OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR ??
        path.join(tmpdir(), "opensteer-shared-browser-e2e");
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        path.join(artifactDirectory, "electron-agent-size-transport.json"),
        `${JSON.stringify(
          {
            engine: "electron",
            generatedAt: new Date().toISOString(),
            versions: { chrome: process.versions.chrome, electron: process.versions.electron },
            frames: wireFrames,
            steps,
            ...(failure ? { failure } : {}),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      socket?.terminate();
      try {
        await server.close();
      } finally {
        launcher.close();
      }
    }
  }
}

/**
 * A page follows the person's view on the real compositor: a page larger than
 * the browser's resting window streams whole, at the screen's own density,
 * with a styled scrollbar, through a sustained drag. Writes frames and a JSON
 * report beside the other browser artifacts.
 */
async function followViewPhase(launcher: ElectronBrowserLauncher, origin: string): Promise<void> {
  const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000009");
  const browser = await launcher.launch({
    // The Browser Runtime's own default: the resting window is this size.
    initialViewport: { devicePixelRatio: 1, ...defaultBrowserViewport },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000009",
    sessionId,
    storage: { kind: "guest" },
  });
  // Every visible size and cast start any channel, or the launcher itself,
  // sends to this browser's pages, so the launcher's redraws and each tab's
  // casts can be counted.
  const debuggerCommands: Array<{
    readonly at: number;
    readonly height: unknown;
    readonly method: string;
    readonly target: Debugger;
    readonly width: unknown;
  }> = [];
  const watchDebugger = (target: Debugger) => {
    const send = target.sendCommand.bind(target);
    target.sendCommand = (method: string, parameters?: unknown, sessionId?: string) => {
      if (
        method === "Emulation.setVisibleSize" ||
        method === "Emulation.setDeviceMetricsOverride" ||
        method === "Emulation.clearDeviceMetricsOverride" ||
        method === "Page.startScreencast"
      ) {
        const { height, width } = asRecord(parameters);
        debuggerCommands.push({
          at: performance.now(),
          height,
          method,
          target,
          width,
        });
      }
      return send(method, parameters, sessionId);
    };
  };
  for (const contents of webContents.getAllWebContents()) watchDebugger(contents.debugger);
  const onContentsCreated = (_event: Electron.Event, contents: Electron.WebContents) =>
    watchDebugger(contents.debugger);
  app.on("web-contents-created", onContentsCreated);
  /**
   * The launcher's redraws since `start`, on one page or all: a visible size
   * one pixel taller, then the size itself.
   */
  const redrawsBetween = (start: number, end: number, target?: Debugger) => {
    const sizes = debuggerCommands.filter(
      (command) =>
        command.method === "Emulation.setVisibleSize" &&
        (target === undefined || command.target === target),
    );
    return sizes.filter((command, index) => {
      const taller = sizes.slice(0, index).findLast((earlier) => earlier.target === command.target);
      return (
        command.at >= start &&
        command.at <= end &&
        taller !== undefined &&
        taller.width === command.width &&
        typeof command.height === "number" &&
        taller.height === command.height + 1
      );
    }).length;
  };
  const castStartsOn = (target: Debugger | undefined, start: number, end: number) =>
    debuggerCommands.filter(
      (command) =>
        command.method === "Page.startScreencast" &&
        command.target === target &&
        command.at >= start &&
        command.at <= end,
    ).length;
  const debuggerOf = (url: string) =>
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.debugger;
  const rootPage = browser.context.pages()[0];
  if (!rootPage) throw new Error("The follow-view browser did not create its root page.");
  const cdpRouter = new SessionCdpRouter(browser.cdp);
  const files = new SessionFiles(
    path.join(await mkdtemp(path.join(tmpdir(), "opensteer-follow-files-")), sessionId),
  );
  const ledger = new SurfaceLedger(browser.context, {
    claimTarget: (targetId) => cdpRouter.claimTarget(sessionId, targetId),
    rootPages: [rootPage],
  });
  cdpRouter.registerSession(
    sessionId,
    await rootPage.targetId(),
    (targetId) => ledger.resolveTarget(targetId),
    files.root,
  );
  await ledger.start();
  const messages: BrowserServerMessage[] = [];
  /** When each of `messages` arrived. */
  const messageTimes: number[] = [];
  const frames: Array<BrowserFrame & { readonly at: number }> = [];
  const controller = new BrowserController({
    cdpRouter,
    claims: BrowserAttachTicketClaimsSchema.parse({
      operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
      remainingBudgetMs: 18_000,
      wireVersion: 1,
      access: "full-control",
      audience: "opensteer-browser-runtime",
      expiresAt: "2030-01-01T00:05:00.000Z",
      identity: { kind: "fresh" },
      issuedAt: "2030-01-01T00:00:00.000Z",
      nonce: "nonce_0123456789abcdef",
      runtimeId: "electron-smoke",
      sessionId,
      subject: "electron-smoke",
    }),
    files,
    ledger,
    replaceSiteCookies: (site, cookies, deadline) =>
      browser.replaceSiteCookies(site, cookies, deadline),
    signIns: new HostSignIns({
      state: { run: (work) => work() },
      writeCookies: () => Promise.resolve(),
      deliveryTimeoutMs: 1_000,
      executor: undefined,
      fresh: true,
      runtimeId: "electron-smoke",
    }),
    sink: {
      sendFrame: async (frame) => {
        frames.push({ ...frame, at: performance.now() });
      },
      sendServer: async (message) => {
        messages.push(message);
        messageTimes.push(performance.now());
      },
    },
  });
  await controller.start();
  const root = ledger.active();
  if (!root) throw new Error("The follow-view session has no page.");
  const surfaceId = root.surface.id;
  // Every command sent through the person's page channel, which the ledger's
  // size writes and the stream's casts share, so a step's casts can be counted.
  const rootCommands: Array<{ readonly at: number; readonly method: string }> = [];
  const geometryApplications: number[] = [];
  if (root.page.applyGeometry) {
    const apply = root.page.applyGeometry.bind(root.page);
    root.page.applyGeometry = (geometry) => {
      geometryApplications.push(performance.now());
      return apply(geometry);
    };
  }
  const rootSend = root.cdp.send.bind(root.cdp);
  root.cdp.send = ((method: string, parameters?: Record<string, unknown>) => {
    rootCommands.push({ at: performance.now(), method });
    return rootSend(method, parameters);
  }) as typeof root.cdp.send;
  const commandsBetween = (start: number, end: number) => {
    const sent = rootCommands.filter((command) => command.at >= start && command.at <= end);
    const count = (method: string) => sent.filter((command) => command.method === method).length;
    const rawCount = (method: string) =>
      debuggerCommands.filter(
        (command) =>
          command.at >= start &&
          command.at <= end &&
          command.target === debuggerOf(root.page.url()) &&
          command.method === method,
      ).length;
    return {
      sizeWrites: geometryApplications.filter((at) => at >= start && at <= end).length,
      metricsOverrides: rawCount("Emulation.setDeviceMetricsOverride"),
      metricsClears: rawCount("Emulation.clearDeviceMetricsOverride"),
      castStarts: count("Page.startScreencast"),
      visibleSizes: rawCount("Emulation.setVisibleSize"),
      redraws: redrawsBetween(start, end),
    };
  };
  /** A cast that keeps restarting would start more than twice per size written. */
  const churns = (commands: ReturnType<typeof commandsBetween>) =>
    commands.castStarts > 2 * commands.sizeWrites + 1;
  // The size of every frame Chromium sends on that channel, before the
  // stream checks it.
  const rootRawFrames: Array<{ readonly at: number; readonly size: string }> = [];
  root.cdp.on("Page.screencastFrame", (parameters) => {
    const record = asRecord(parameters);
    const metadata = asRecord(record.metadata);
    const raster = jpegSize(Buffer.from(String(record.data), "base64"));
    rootRawFrames.push({
      at: performance.now(),
      size: `${String(metadata.deviceWidth)}x${String(metadata.deviceHeight)} raster ${raster.width}x${raster.height}`,
    });
  });
  /** The casts and frames of the person's page channel since `since`, for a failure's record. */
  const castLog = (since: number) =>
    [
      ...rootCommands
        .filter(
          (command) =>
            command.at >= since &&
            command.method !== "Runtime.evaluate" &&
            command.method !== "Page.screencastFrameAck",
        )
        .map((command) => ({
          at: command.at,
          entry: `sent ${command.method}`,
        })),
      ...rootRawFrames
        .filter((frame) => frame.at >= since)
        .map((frame) => ({ at: frame.at, entry: `frame ${frame.size}` })),
    ]
      .sort((left, right) => left.at - right.at)
      .slice(-80)
      .map((event) => `${Math.round(event.at - since)}ms ${event.entry}`);
  /** The sizes the page saw itself resized to since its log was last cleared. */
  const pageResizes = async () =>
    ((await read("window.resizes")) as Array<{ height: number; width: number }> | undefined) ?? [];
  const onlyResizedTo = (
    seen: ReadonlyArray<{ readonly height: number; readonly width: number }>,
    sizes: ReadonlyArray<{ readonly height: number; readonly width: number }>,
  ) =>
    seen.every((resize) =>
      sizes.some((size) => size.width === resize.width && size.height === resize.height),
    );
  const read = async (expression: string): Promise<unknown> =>
    asEvaluationValue(
      await root.cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        expression,
        returnByValue: true,
      }),
    );
  const pageState = async () =>
    asRecord(
      await read(
        "({ width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, dpr: devicePixelRatio })",
      ),
    );
  const follow = (size: { readonly height: number; readonly width: number }) =>
    controller.handle({ ...size, surfaceId, type: "viewport.follow" });
  const pointer = (
    action: "down" | "move" | "up",
    shown: { readonly height: number; readonly width: number },
    x: number,
    y: number,
  ) =>
    controller.handle({
      action,
      button: action === "move" ? "none" : "left",
      ...(action === "move" ? {} : { clickCount: 1 }),
      surfaceId,
      type: "input.pointer",
      viewportHeight: shown.height,
      viewportWidth: shown.width,
      x,
      y,
    });
  /** The first picture of the page at `size`, in its shape, at or after `since`. */
  const pictureAt = async (
    size: { readonly height: number; readonly width: number },
    since: number,
  ) => {
    const matches = (frame: (typeof frames)[number]) =>
      frame.at >= since &&
      frame.header.viewportWidth === size.width &&
      frame.header.viewportHeight === size.height &&
      sameShape(frame.header);
    await waitFor(() => frames.some(matches));
    return frames.find(matches)!;
  };
  const errors = () => messages.filter((message) => message.type === "browser.error");
  const expectedErrors = new Set<BrowserServerMessage>();
  const screenScale = screen.getPrimaryDisplay().scaleFactor;
  const artifactDirectory =
    process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-browser-follow-e2e");
  await mkdir(artifactDirectory, { recursive: true });
  const savedFrames: string[] = [];
  const saveFrame = async (name: string, frame: BrowserFrame) => {
    const file = path.join(artifactDirectory, `electron-${name}.jpg`);
    await writeFile(file, frame.data);
    savedFrames.push(file);
  };

  await controller.handle({ type: "stream.subscribe" });
  await root.cdp.send("Page.navigate", { url: `${origin}/follow` });
  await waitForAsync(async () => (await read("document.readyState")) === "complete");
  const resting = await pageState();
  if (resting.width !== defaultBrowserViewport.width) {
    throw new Error(`The page did not start at the default size: ${JSON.stringify(resting)}`);
  }

  // Person sizing changes real resting-host content and view bounds, while
  // pictures keep the display's density within the frame bound.
  const restingHosts = () =>
    BaseWindow.getAllWindows().map((host) => ({
      id: host.id,
      contentBounds: host.getContentBounds(),
      views: host.contentView.children.map((view) => view.getBounds()),
    }));
  const restingBefore = restingHosts();
  const large = { height: 900, width: 1_400 };
  const largeSince = performance.now();
  await follow(large);
  const largePicture = await pictureAt(large, largeSince);
  const restingWithLarge = restingHosts();
  const largeState = await pageState();
  const largeRaster = jpegSize(largePicture.data);
  const corner = asRecord(
    await read(
      "(() => { const r = document.getElementById('corner').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()",
    ),
  );
  const cornerPixel = framePixel(
    largePicture,
    (Number(corner.left) + Number(corner.right)) / 2,
    (Number(corner.top) + Number(corner.bottom)) / 2,
  );
  const rasterScale = largeRaster.width / large.width;
  if (
    largeState.width !== large.width ||
    largeState.height !== large.height ||
    largeRaster.width !== largePicture.header.rasterWidth ||
    largeRaster.height !== largePicture.header.rasterHeight ||
    largeRaster.width > large.width * 2 ||
    largeRaster.height > large.height * 2 ||
    !browserFrameFits(largeRaster.width, largeRaster.height) ||
    Math.abs(rasterScale - Math.min(2, screenScale)) > 0.01
  ) {
    throw new Error(
      `The large page was not pictured whole at the screen's density: ${JSON.stringify({ largeState, largeRaster, screenScale })}`,
    );
  }
  if (
    restingBefore.length !== 1 ||
    restingWithLarge.length !== 1 ||
    restingWithLarge[0]?.id !== restingBefore[0]?.id ||
    restingWithLarge[0]?.contentBounds.width !== large.width ||
    restingWithLarge[0]?.contentBounds.height !== large.height ||
    JSON.stringify(restingWithLarge[0]?.views) !==
      JSON.stringify([{ x: 0, y: 0, width: large.width, height: large.height }]) ||
    largeState.dpr !== resting.dpr
  ) {
    throw new Error(
      `The person-sized resting host/view did not use real bounds: ${JSON.stringify({ restingBefore, restingWithLarge })}`,
    );
  }
  // JPEG and the display's colour profile move the exact value, never the hue.
  if (!(
    cornerPixel.green > 150 &&
    cornerPixel.green - cornerPixel.red > 60 &&
    cornerPixel.green - cornerPixel.blue > 60
  )) {
    throw new Error(
      `The page's far corner is missing from its picture: ${JSON.stringify(cornerPixel)}`,
    );
  }
  const personGeometryCommands = commandsBetween(largeSince, performance.now());
  if (personGeometryCommands.visibleSizes !== 0 || personGeometryCommands.metricsOverrides !== 0) {
    throw new Error(`Person geometry used fake metrics: ${JSON.stringify(personGeometryCommands)}`);
  }
  await saveFrame("follow-large-1400x900", largePicture);
  progress("follow-large-page-passed");

  // A styled scrollbar takes width from the page's layout; the picture
  // still shows the whole viewport, and a click beside the scrollbar lands.
  const scrollbarShown = Number(largeState.clientWidth) < Number(largeState.width);
  const edge = asRecord(
    await read(
      "(() => { const r = document.getElementById('edge').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()",
    ),
  );
  await read("window.pointerLog = []");
  for (const action of ["down", "up"] as const) {
    await pointer(
      action,
      large,
      (Number(edge.left) + Number(edge.right)) / 2 / large.width,
      (Number(edge.top) + Number(edge.bottom)) / 2 / large.height,
    );
  }
  const edgeClick = (
    (await read("window.pointerLog")) as Array<Record<string, unknown>> | undefined
  )?.find((entry) => entry.type === "mousedown");
  const repaintSince = performance.now();
  await read("document.getElementById('state').textContent = 'repainted'");
  await pictureAt(large, repaintSince);
  if (!scrollbarShown || edgeClick?.target !== "edge") {
    throw new Error(
      `A styled-scrollbar page did not stream or take a click: ${JSON.stringify({ largeState, edge, edgeClick })}`,
    );
  }
  progress("follow-styled-scrollbar-passed");

  // The same size while the person holds the button ends nothing.
  await read("window.pointerLog = []");
  await pointer("down", large, 0.3, 0.3);
  await follow(large);
  await pointer("move", large, 0.35, 0.35);
  const heldThroughNoOp = (
    (await read("window.pointerLog")) as Array<Record<string, unknown>> | undefined
  )?.at(-1);
  await pointer("up", large, 0.35, 0.35);
  if (heldThroughNoOp?.type !== "mousemove" || heldThroughNoOp.buttons !== 1) {
    throw new Error(`A same-size write ended a held press: ${JSON.stringify(heldThroughNoOp)}`);
  }
  progress("follow-held-press-passed");

  // A sustained drag keeps pictures coming, and the last size is
  // pictured soon after; a press aimed at an old picture is refused.
  const dragSizes = Array.from({ length: 40 }, (_, index) => ({
    height: 700,
    width: index === 39 ? 1_000 : 600 + index * 10,
  }));
  await read("window.resizes = []");
  const dragStarted = performance.now();
  const dragging: Promise<void>[] = [];
  let lastFollowSent = dragStarted;
  for (const size of dragSizes) {
    lastFollowSent = performance.now();
    dragging.push(follow(size));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const dragEnded = performance.now();
  await read("window.pointerLog = []");
  const staleInputFrom = messages.length;
  await pointer("down", dragSizes[0]!, 0.5, 0.5);
  const staleInputErrors = messages
    .slice(staleInputFrom)
    .filter((message) => message.type === "browser.error");
  if (
    staleInputErrors.length !== 1 ||
    staleInputErrors[0]?.error.reason !== "browser-input-stale-geometry"
  )
    throw new Error(
      `Stale drag input must produce its typed refusal: ${JSON.stringify(staleInputErrors)}`,
    );
  expectedErrors.add(staleInputErrors[0]);
  await Promise.all(dragging);
  const finalSize = dragSizes.at(-1)!;
  const finalPicture = await pictureAt(finalSize, lastFollowSent);
  const finalPictureMs = Math.round(finalPicture.at - lastFollowSent);
  const dragFrames = frames.filter((frame) => frame.at >= dragStarted && frame.at <= dragEnded);
  const stalePresses = (
    (await read("window.pointerLog")) as Array<Record<string, unknown>> | undefined
  )?.filter((entry) => entry.type === "mousedown");
  // Settled for a moment after its last picture, so a cast that kept
  // restarting would show here.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const dragCommands = commandsBetween(dragStarted, performance.now());
  // The page sees only the sizes the person gave it, whatever the stream does.
  const dragResizes = await pageResizes();
  if (
    dragFrames.length === 0 ||
    finalPictureMs > 2_000 ||
    stalePresses?.length !== 0 ||
    churns(dragCommands) ||
    !onlyResizedTo(dragResizes, dragSizes)
  ) {
    throw new Error(
      `The drag did not stream, let a stale press through, kept restarting its cast or resized the page otherwise: ${JSON.stringify({ frames: dragFrames.length, finalPictureMs, stalePresses, dragCommands, dragResizes, castLog: castLog(dragStarted) })}`,
    );
  }
  await saveFrame("follow-drag-final-1000x700", finalPicture);
  const midDrag = dragFrames[Math.floor(dragFrames.length / 2)];
  if (midDrag) await saveFrame("follow-drag-middle", midDrag);
  progress("follow-drag-passed");

  // Each check below is recorded; the run reports them all, then fails on any.
  const failures: string[] = [];
  const results: Record<string, unknown> = {};
  const section = async (name: string, run: () => Promise<Record<string, unknown>>) => {
    const since = performance.now();
    progress(`follow-${name}-started`);
    try {
      results[name] = { ...(await run()), passed: true };
      progress(`follow-${name}-passed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      results[name] = {
        passed: false,
        failure: message,
        castLog: castLog(since),
      };
    }
  };
  const settles = (operation: Promise<unknown>, timeoutMs = 5_000) =>
    withTimeout(
      operation.then(() => true),
      timeoutMs,
      { timeoutError: () => new Error("timed out") },
    ).catch(() => false);
  const agent = async (
    method: string,
    parameters?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    const requestId = randomUUID();
    await controller.handle({
      command: {
        method,
        ...(parameters ? { parameters } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      requestId,
      type: "cdp.command",
    });
    const reply = messages.find(
      (message) =>
        (message.type === "cdp.result" || message.type === "cdp.error") &&
        message.requestId === requestId,
    );
    if (reply?.type === "cdp.error") {
      throw Object.assign(new Error(reply.error.message), {
        code: reply.error.code,
      });
    }
    if (reply?.type !== "cdp.result") throw new Error(`${method} was not answered.`);
    return reply.result;
  };
  const dialogChanges = () =>
    messages.flatMap((message) => (message.type === "browser.dialog.changed" ? [message] : []));
  /** The dialog the person sees now, which their answer names. */
  const shownDialogId = () => {
    const dialog = dialogChanges().at(-1)?.dialog;
    if (!dialog) throw new Error("No browser dialog is shown.");
    return dialog.id;
  };
  const errorsFrom = (index: number) =>
    messages
      .slice(index)
      .flatMap((message) => (message.type === "browser.error" ? [message.error.message] : []));
  const ensure = (condition: boolean, detail: unknown) => {
    if (!condition) throw new Error(JSON.stringify(detail));
  };
  const rootAgentSession = String(
    asRecord(
      await agent("Target.attachToTarget", {
        flatten: true,
        targetId: root.targetId,
      }),
    ).sessionId,
  );
  const dialogResize = { height: 720, width: 1_100 };

  // A page under a dialog answers nothing else until it closes. The person's
  // size waits for it without holding their answer, an agent's size is
  // refused, a second answer finds no dialog, and a press held from before
  // is released before the waiting size reaches the page.
  await section("targeted-surfaces", async () => {
    const selected = ledger.active()?.surface.id;
    if (!selected) throw new Error("Missing selected surface");
    const create = async (label: string) => {
      const targetId = String(
        asRecord(await agent("Target.createTarget", { url: `${origin}/follow?${label}` })).targetId,
      );
      const surface = ledger.surfaceIdForTarget(targetId);
      if (!surface) throw new Error("Targeted tab missing");
      const sessionId = String(
        asRecord(await agent("Target.attachToTarget", { targetId, flatten: true })).sessionId,
      );
      return { targetId, surface, sessionId };
    };
    const y = await create("target-y");
    const z = await create("target-z");
    const before = frames.length;
    const sizes = [selected, y.surface, z.surface].map((id) => ledger.viewportOf(id));
    await controller.handle({ type: "stream.subscribe", surfaceId: y.surface });
    await controller.handle({ type: "stream.subscribe", surfaceId: z.surface });
    await waitFor(() =>
      [y.surface, z.surface].every((id) =>
        frames.slice(before).some((frame) => frame.header.surfaceId === id),
      ),
    );
    ensure(ledger.active()?.surface.id === selected, {
      selected,
      current: ledger.active()?.surface.id,
    });
    ensure(
      JSON.stringify(sizes) ===
        JSON.stringify([selected, y.surface, z.surface].map((id) => ledger.viewportOf(id))),
      "Targeted observation changed a viewport",
    );
    await agent(
      "Runtime.evaluate",
      {
        expression: `document.body.innerHTML = '<input type="password">'; true`,
        returnByValue: true,
      },
      y.sessionId,
    );
    const surface = ledger.binding(y.surface)!.surface;
    const page = ledger.binding(y.surface)!.page;
    const checkedAfter = Date.now();
    const candidate = BrowserContextCandidateSchema.parse(
      await agent("Opensteer.contextCandidate", { surfaceId: y.surface }),
    );
    ensure(
      candidate.sessionId === sessionId &&
        candidate.tabId === y.surface &&
        candidate.documentId === surface.documentId &&
        candidate.title === surface.title.slice(0, 256) &&
        candidate.url === page.url() &&
        candidate.eligibility === "eligible" &&
        candidate.reason === null &&
        Date.parse(candidate.checkedAt ?? "") >= checkedAfter &&
        Date.parse(candidate.checkedAt ?? "") <= Date.now(),
      { candidate, surface, url: page.url() },
    );
    const token = randomUUID();
    const requestId = randomUUID();
    await controller.handle({
      type: "cdp.command",
      actorToken: token,
      requestId,
      command: {
        method: "Input.dispatchMouseEvent",
        parameters: { type: "mouseMoved", x: 100, y: 100 },
        sessionId: y.sessionId,
      },
    });
    const activity = messages.findLast(
      (message) => message.type === "browser.activity" && message.actorToken === token,
    );
    ensure(
      activity?.type === "browser.activity" &&
        activity.surfaceId === y.surface &&
        activity.pointer !== null,
      { activity },
    );
    await writeFile(
      path.join(artifactDirectory, "electron-targeted-concurrency.json"),
      JSON.stringify(
        {
          selected,
          candidate,
          y,
          z,
          sizes,
          frames: frames.slice(before).map(({ header }) => header),
          activity,
        },
        null,
        2,
      ),
    );
    for (const target of [y, z]) {
      await controller.handle({ type: "stream.unsubscribe", surfaceId: target.surface });
      await agent("Target.closeTarget", { targetId: target.targetId });
    }
    return { candidate };
  });

  await section("dialog-with-resize", async () => {
    await read("window.pointerLog = []");
    await pointer("down", finalSize, 0.4, 0.4);
    const opened = dialogChanges().length;
    await read(
      "setTimeout(() => { window.answer = confirm('Keep going?'); window.answeredAt = performance.now(); }, 0); true",
    );
    await waitFor(() =>
      dialogChanges()
        .slice(opened)
        .some((message) => message.dialog?.surfaceId === surfaceId),
    );
    const resizeSettled = await settles(follow(dialogResize));
    const agentRefusal = await agent(
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 500, mobile: false, width: 700 },
      rootAgentSession,
    ).then(
      () => null,
      (error: unknown) => ({
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      }),
    );
    const answeredFrom = messages.length;
    const resizedSince = performance.now();
    const dialogId = shownDialogId();
    const answersSettled = await settles(
      Promise.all([
        controller.handle({ accept: true, dialogId, type: "dialog.respond" }),
        controller.handle({ accept: false, dialogId, type: "dialog.respond" }),
      ]),
    );
    if (!answersSettled) {
      await root.cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    }
    const answer = await read("window.answer");
    await waitForAsync(async () => (await pageState()).width === dialogResize.width).catch(
      () => undefined,
    );
    const afterDialog = await pageState();
    const resizedPicture = await pictureAt(dialogResize, resizedSince);
    const responseErrors = errorsFrom(answeredFrom);
    const answerRefusals = messages
      .slice(answeredFrom)
      .filter((message) => message.type === "browser.error");
    if (
      answerRefusals.length === 1 &&
      answerRefusals[0]?.error.message === "There is no active browser dialog."
    )
      expectedErrors.add(answerRefusals[0]);
    const release = asRecord(
      await read("({ log: window.pointerLog, answeredAt: window.answeredAt })"),
    );
    const log = (release.log as Array<Record<string, unknown>> | undefined) ?? [];
    const pressedDown = log.find((entry) => entry.type === "mousedown");
    const releasedUp = log.find((entry) => entry.type === "mouseup");
    const outcome = {
      resizeSettledWithin5s: resizeSettled,
      agentRefusal,
      answersSettledWithin5s: answersSettled,
      answer,
      responseErrors,
      afterDialog,
      resizedPicture: resizedPicture.header,
      pointerLog: log,
      answeredAt: release.answeredAt,
    };
    ensure(resizeSettled && answersSettled, outcome);
    ensure(
      agentRefusal?.code === "conflict" &&
        agentRefusal.message ===
          "A JavaScript dialog is open on this page. Chromium changes its size only after the dialog is answered with Page.handleJavaScriptDialog.",
      outcome,
    );
    ensure(answer === true, outcome);
    ensure(
      responseErrors.length === 1 && responseErrors[0] === "There is no active browser dialog.",
      outcome,
    );
    ensure(
      afterDialog.width === dialogResize.width && afterDialog.height === dialogResize.height,
      outcome,
    );
    ensure(
      pressedDown !== undefined &&
        Number(pressedDown.t) <= Number(releasedUp?.t) &&
        releasedUp !== undefined &&
        Number(releasedUp.t) >= Number(release.answeredAt),
      outcome,
    );
    return outcome;
  });

  // Pausing the picture keeps the page bound: the dialog stays shown and
  // answerable, and the picture resumes once it is answered.
  await section("dialog-across-pause", async () => {
    const opened = dialogChanges().length;
    await read("setTimeout(() => { window.answer = confirm('Still there?'); }, 0); true");
    await waitFor(() =>
      dialogChanges()
        .slice(opened)
        .some((message) => message.dialog?.surfaceId === surfaceId),
    );
    const shown = dialogChanges().length;
    const pauseSettled = await settles(controller.handle({ type: "stream.unsubscribe" }));
    const resumed = controller.handle({ type: "stream.subscribe" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const hiddenWhilePaused = dialogChanges()
      .slice(shown)
      .filter((message) => message.dialog === null).length;
    const answeredFrom = messages.length;
    const resumedSince = performance.now();
    const answerSettled = await settles(
      controller.handle({
        accept: true,
        dialogId: shownDialogId(),
        type: "dialog.respond",
      }),
    );
    const resumeSettled = await settles(resumed);
    const answer = await read("window.answer");
    await read("document.getElementById('state').textContent = 'resumed'");
    const resumedPicture = await pictureAt(dialogResize, resumedSince);
    const outcome = {
      pauseSettledWithin5s: pauseSettled,
      hiddenWhilePaused,
      answerSettledWithin5s: answerSettled,
      resumeSettledWithin5s: resumeSettled,
      answer,
      errors: errorsFrom(answeredFrom),
      resumedPicture: resumedPicture.header,
    };
    ensure(
      pauseSettled &&
        hiddenWhilePaused === 0 &&
        answerSettled &&
        resumeSettled &&
        answer === true &&
        outcome.errors.length === 0,
      outcome,
    );
    return outcome;
  });

  // A dialog a background tab opens shows the moment the person turns to
  // that tab, before the tab list does, and is theirs to answer.
  await section("dialog-on-background-tab", async () => {
    await controller.handle({
      type: "surface.open",
      url: `${origin}/follow?background`,
    });
    const background = ledger.active();
    if (!background || background.surface.id === surfaceId) {
      throw new Error("The background tab did not open.");
    }
    const backgroundRead = async (expression: string) =>
      asEvaluationValue(
        await background.cdp.send("Runtime.evaluate", {
          awaitPromise: true,
          expression,
          returnByValue: true,
        }),
      );
    await waitForAsync(async () => (await backgroundRead("document.readyState")) === "complete");
    await controller.handle({ surfaceId, type: "surface.activate" });
    const before = dialogChanges().length;
    await backgroundRead(
      "setTimeout(() => { window.answer = confirm('From a background tab'); }, 300); true",
    );
    await waitFor(() => ledger.dialogOf(background.surface.id) !== null);
    const shownWhileBehind = dialogChanges()
      .slice(before)
      .some((message) => message.dialog?.surfaceId === background.surface.id);
    const activatedFrom = messages.length;
    await controller.handle({
      surfaceId: background.surface.id,
      type: "surface.activate",
    });
    await waitFor(() =>
      messages
        .slice(activatedFrom)
        .some(
          (message) =>
            message.type === "browser.dialog.changed" &&
            message.dialog?.surfaceId === background.surface.id,
        ),
    );
    await waitFor(() =>
      messages.slice(activatedFrom).some((message) => message.type === "browser.surfaces.changed"),
    );
    const order = messages
      .slice(activatedFrom)
      .map((message) => message.type)
      .filter((type) => type === "browser.dialog.changed" || type === "browser.surfaces.changed");
    const answerSettled = await settles(
      controller.handle({
        accept: true,
        dialogId: shownDialogId(),
        type: "dialog.respond",
      }),
    );
    const answer = await backgroundRead("window.answer");
    await waitFor(() =>
      messages
        .slice(activatedFrom)
        .some((message) => message.type === "browser.dialog.changed" && message.dialog === null),
    );
    // Turning back and closing the tab at once, as a person does, are
    // ordinary commands again once its dialog is answered.
    const returnedFrom = messages.length;
    await controller.handle({ surfaceId, type: "surface.activate" });
    const errorsTurningBack = errorsFrom(returnedFrom);
    const closedFrom = messages.length;
    await controller.handle({
      surfaceId: background.surface.id,
      type: "surface.close",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const errorsClosing = errorsFrom(closedFrom);
    const outcome = {
      shownWhileBehind,
      order,
      answerSettledWithin5s: answerSettled,
      answer,
      errorsTurningBack,
      errorsClosing,
    };
    ensure(
      !shownWhileBehind &&
        order[0] === "browser.dialog.changed" &&
        answerSettled &&
        answer === true &&
        errorsTurningBack.length === 0 &&
        errorsClosing.length === 0,
      outcome,
    );
    return outcome;
  });

  // An agent's tab opened with an address lays out at the followed size from
  // its first script; an address CDP may not open is refused.
  await section("agent-tab-with-url", async () => {
    const created = asRecord(
      await agent("Target.createTarget", { url: `${origin}/follow?created` }),
    );
    const createdSurface = ledger.surfaceIdForTarget(String(created.targetId));
    const binding = createdSurface ? ledger.binding(createdSurface) : null;
    if (!binding) throw new Error("The agent's tab is not one of the session's pages.");
    const createdRead = async (expression: string) =>
      asEvaluationValue(
        await binding.cdp.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        }),
      );
    await waitForAsync(async () => {
      const state = asRecord(
        await createdRead("({ ready: document.readyState, href: location.href })"),
      );
      return state.ready === "complete" && String(state.href).endsWith("/follow?created");
    });
    const firstLayout = asRecord(
      await createdRead("({ load: window.loadSize, resizes: window.resizes })"),
    );
    const unsafe = await agent("Target.createTarget", {
      url: "file:///etc/hosts",
    }).then(
      () => null,
      (error: unknown) => ({
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      }),
    );
    const outcome = { followed: dialogResize, firstLayout, unsafe };
    ensure(
      JSON.stringify(firstLayout.load) === JSON.stringify(dialogResize) &&
        Array.isArray(firstLayout.resizes) &&
        firstLayout.resizes.length === 0 &&
        unsafe?.code === "forbidden" &&
        unsafe.message ===
          "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
      outcome,
    );
    await agent("Target.closeTarget", { targetId: created.targetId });
    return outcome;
  });

  // A tall page an agent sizes is pictured shrunk into the frame bound, and
  // its picture is still taken.
  await section("tall-agent-sized-page", async () => {
    const tall = { height: 4_300, width: 390 };
    const since = performance.now();
    // The root page goes back to the person's size whatever happens here, so
    // later sections never inherit the agent's.
    const picture = await (async () => {
      try {
        await agent(
          "Emulation.setDeviceMetricsOverride",
          { ...tall, deviceScaleFactor: 1, mobile: false },
          rootAgentSession,
        );
        return await pictureAt(tall, since).catch((error: unknown) => {
          throw new Error(
            JSON.stringify({
              error: String(error),
              streamed: frames.filter((frame) => frame.at >= since).map((frame) => frame.header),
            }),
          );
        });
      } finally {
        await agent("Emulation.clearDeviceMetricsOverride", {}, rootAgentSession);
      }
    })();
    const raster = jpegSize(picture.data);
    await saveFrame("follow-tall-agent-390x4300", picture);
    const outcome = {
      page: tall,
      header: picture.header,
      raster,
      shrunk: raster.width < tall.width * screenScale,
    };
    ensure(
      raster.height <= 4_320 &&
        raster.width <= 391 &&
        browserFrameFits(raster.width, raster.height),
      outcome,
    );
    return outcome;
  });

  type TimedFrame = (typeof frames)[number];
  /** A picture of one page at `size` since `since`, or null after five seconds. */
  const pictureWithin = async (
    size: { readonly height: number; readonly width: number },
    since: number,
    surface: string = surfaceId,
  ): Promise<TimedFrame | null> => {
    const matches = (frame: TimedFrame) =>
      frame.at >= since &&
      frame.header.surfaceId === surface &&
      frame.header.viewportWidth === size.width &&
      frame.header.viewportHeight === size.height &&
      sameShape(frame.header);
    await waitFor(() => frames.some(matches), 5_000).catch(() => undefined);
    return frames.find(matches) ?? null;
  };
  const pictureSummary = (frame: TimedFrame | null, since: number) =>
    frame
      ? {
          afterMs: Math.round(frame.at - since),
          raster: `${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
          rasterPerCssPixel: frame.header.rasterWidth / frame.header.viewportWidth,
          viewport: `${frame.header.viewportWidth}x${frame.header.viewportHeight}`,
        }
      : null;
  const density = Math.min(2, screenScale);
  const sharp = (frame: TimedFrame | null) =>
    frame !== null &&
    Math.abs(frame.header.rasterWidth / frame.header.viewportWidth - density) < 0.01;

  // An agent may screencast the page the person watches, and Electron casts a
  // page once for every CDP channel. The agent's start pictures the static
  // page at once; the person's restarts reach Chromium, so their picture
  // follows a size past its last bound at the screen's density and is there
  // at once when they look back; the agent's cast goes on, at its own pace,
  // while the person looks away, and takes its own parameters when the agent
  // starts it again then.
  await section("agent-screencast-alongside", async () => {
    const agentFrames: Array<{
      readonly at: number;
      readonly format: string;
      readonly height: number;
      readonly sessionId: unknown;
      readonly width: number;
    }> = [];
    let scanned = messages.length;
    const collect = () => {
      for (; scanned < messages.length; scanned += 1) {
        const message = messages[scanned]!;
        if (
          message.type !== "cdp.event" ||
          message.event.method !== "Page.screencastFrame" ||
          message.event.sessionId !== rootAgentSession
        ) {
          continue;
        }
        agentFrames.push({
          at: messageTimes[scanned]!,
          sessionId: message.event.parameters.sessionId,
          ...encodedImage(String(message.event.parameters.data)),
        });
      }
      return agentFrames;
    };
    const agentFrameAfter = async (
      since: number,
      accept: (frame: (typeof agentFrames)[number]) => boolean = () => true,
    ) => {
      const matches = (frame: (typeof agentFrames)[number]) => frame.at >= since && accept(frame);
      await waitFor(() => collect().some(matches), 5_000).catch(() => undefined);
      const frame = collect().find(matches);
      return frame ? { ...frame, afterMs: Math.round(frame.at - since) } : null;
    };
    // The agent acknowledges each frame, as CDP asks of a screencast client.
    let acked = 0;
    let watching = true;
    const acknowledging = (async () => {
      while (watching) {
        for (const frame of collect().slice(acked)) {
          acked += 1;
          await agent(
            "Page.screencastFrameAck",
            { sessionId: frame.sessionId },
            rootAgentSession,
          ).catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const from = messages.length;
    const sectionSince = performance.now();
    const ask = { format: "png", maxHeight: 240, maxWidth: 320 };
    try {
      const joinedSince = performance.now();
      await agent("Page.startScreencast", ask, rootAgentSession);
      const joined = await agentFrameAfter(joinedSince);

      const grown = { height: 900, width: 1_400 };
      await read("window.resizes = []");
      const grownSince = performance.now();
      await follow(grown);
      const grownPicture = await pictureWithin(grown, grownSince);

      const awaySince = performance.now();
      const awaySettled = await settles(controller.handle({ type: "stream.unsubscribe" }));
      for (let index = 0; index < 12; index += 1) {
        await read(`document.getElementById('state').textContent = 'away ${index}'`);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const framesWhileAway = collect().filter((frame) => frame.at >= awaySince).length;
      const ownSince = performance.now();
      await agent("Page.startScreencast", ask, rootAgentSession);
      const own = await agentFrameAfter(ownSince, (frame) => frame.format === "png");

      const backSince = performance.now();
      const backSettled = await settles(controller.handle({ type: "stream.subscribe" }));
      const backPicture = await pictureWithin(grown, backSince);
      const agentAlongside = await agentFrameAfter(backSince);

      await agent("Page.stopScreencast", {}, rootAgentSession);
      const agentFramesAtStop = collect().length;
      const repaintSince = performance.now();
      await read("document.getElementById('state').textContent = 'agent stopped'");
      const afterStop = await pictureWithin(grown, repaintSince);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const resizes = await pageResizes();
      const outcome = {
        agentAsked: ask,
        pageResizes: resizes,
        castStarts: commandsBetween(sectionSince, performance.now()),
        agentFirstFrame: joined,
        personGrown: pictureSummary(grownPicture, grownSince),
        personAwaySettledWithin5s: awaySettled,
        agentFramesWhileAway: framesWhileAway,
        agentOwnParameters: own,
        personBackSettledWithin5s: backSettled,
        personBack: pictureSummary(backPicture, backSince),
        agentAlongsideAgain: agentAlongside,
        personAfterAgentStopped: pictureSummary(afterStop, repaintSince),
        agentFramesAfterStop: collect().length - agentFramesAtStop,
        agentFramesTotal: agentFrames.length,
        frameLog: {
          person: frames
            .filter((frame) => frame.at >= sectionSince)
            .map(
              (frame) =>
                `${Math.round(frame.at - sectionSince)}ms ${frame.header.viewportWidth}x${frame.header.viewportHeight} raster ${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
            ),
          agent: agentFrames.map(
            (frame) =>
              `${Math.round(frame.at - sectionSince)}ms ${frame.format} ${frame.width}x${frame.height}`,
          ),
          marks: {
            grown: Math.round(grownSince - sectionSince),
            away: Math.round(awaySince - sectionSince),
            own: Math.round(ownSince - sectionSince),
            back: Math.round(backSince - sectionSince),
          },
        },
        errors: errorsFrom(from),
      };
      ensure(
        joined !== null &&
          sharp(grownPicture) &&
          awaySettled &&
          framesWhileAway >= 6 &&
          own !== null &&
          own.width <= ask.maxWidth &&
          own.height <= ask.maxHeight &&
          backSettled &&
          sharp(backPicture) &&
          afterStop !== null &&
          outcome.agentFramesAfterStop === 0 &&
          resizes.length > 0 &&
          onlyResizedTo(resizes, [grown]) &&
          outcome.errors.length === 0,
        outcome,
      );
      if (grownPicture) await saveFrame("follow-alongside-agent-1400x900", grownPicture);
      return outcome;
    } finally {
      watching = false;
      await acknowledging;
    }
  });

  // A tab nobody has looked at yet is live: an agent's click there lands, its
  // page draws, and it is pictured within a second of the person turning to
  // it. A tab the person opens with an address shows its loaded page within a
  // second. The launcher's redraws behind both cost a cast one restart at most.
  await section("never-shown-tab", async () => {
    const from = messages.length;
    const pagePictured = (frame: TimedFrame | null) => {
      if (!frame) return null;
      const pixel = framePixel(
        frame,
        frame.header.viewportWidth - 30,
        frame.header.viewportHeight - 30,
      );
      return pixel.green > 150 && pixel.green - pixel.red > 60 && pixel.green - pixel.blue > 60;
    };
    const created = asRecord(
      await agent("Target.createTarget", {
        url: `${origin}/follow?never-shown`,
      }),
    );
    const agentTab = ledger.surfaceIdForTarget(String(created.targetId));
    if (!agentTab) throw new Error("The agent's tab is not one of the session's pages.");
    const agentSession = String(
      asRecord(
        await agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      ).sessionId,
    );
    const agentRead = async (expression: string) =>
      asEvaluationValue(
        await agent(
          "Runtime.evaluate",
          { awaitPromise: true, expression, returnByValue: true },
          agentSession,
        ),
      );
    await waitForAsync(async () => (await agentRead("document.readyState")) === "complete");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await agent(
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type, x: 30, y: 30 },
        agentSession,
      );
    }
    const presses = await agentRead(
      "window.pointerLog.filter((entry) => entry.type === 'mousedown').length",
    );
    const animationFrames = await agentRead(
      "new Promise((resolve) => { let count = 0; const until = performance.now() + 300; const step = () => { count += 1; if (performance.now() < until) requestAnimationFrame(step); else resolve(count); }; requestAnimationFrame(step); setTimeout(() => resolve(count), 1_000); })",
    );
    const agentTabSize = ledger.viewportOf(agentTab);
    if (!agentTabSize) throw new Error("The agent's tab has no size.");
    const agentTabDebugger = debuggerOf(`${origin}/follow?never-shown`);
    const turnSince = performance.now();
    await controller.handle({ surfaceId: agentTab, type: "surface.activate" });
    const firstPicture = await pictureWithin(agentTabSize, turnSince, agentTab);
    // Settled, so a cast that kept restarting would show here.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const agentTabCasts = {
      castStarts: castStartsOn(agentTabDebugger, turnSince, performance.now()),
      redraws: redrawsBetween(turnSince, performance.now(), agentTabDebugger),
    };
    await controller.handle({ surfaceId, type: "surface.activate" });
    await agent("Target.closeTarget", { targetId: created.targetId });

    const openSince = performance.now();
    await controller.handle({
      type: "surface.open",
      url: `${origin}/follow?person-opened`,
    });
    const personTab = ledger.active();
    if (!personTab || personTab.surface.id === surfaceId) {
      throw new Error("The person's tab did not open.");
    }
    await waitForAsync(
      async () =>
        asEvaluationValue(
          await personTab.cdp.send("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          }),
        ) === "complete",
    );
    const personTabSize = ledger.viewportOf(personTab.surface.id);
    if (!personTabSize) throw new Error("The person's tab has no size.");
    const showsPersonTab = (frame: TimedFrame) =>
      frame.at >= openSince &&
      frame.header.surfaceId === personTab.surface.id &&
      frame.header.viewportWidth === personTabSize.width &&
      frame.header.viewportHeight === personTabSize.height &&
      sameShape(frame.header) &&
      pagePictured(frame) === true;
    await waitFor(() => frames.some(showsPersonTab), 5_000).catch(() => undefined);
    const personPicture = frames.find(showsPersonTab) ?? null;
    const personPagePictured = personPicture !== null && personPicture.at - openSince < 1_000;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const personTabDebugger = debuggerOf(`${origin}/follow?person-opened`);
    const personTabCasts = {
      castStarts: castStartsOn(personTabDebugger, openSince, performance.now()),
      redraws: redrawsBetween(openSince, performance.now(), personTabDebugger),
    };
    await controller.handle({
      surfaceId: personTab.surface.id,
      type: "surface.close",
    });
    await controller.handle({ surfaceId, type: "surface.activate" });
    const outcome = {
      agentPressesLanded: presses,
      animationFramesIn300ms: animationFrames,
      firstPictureWhenShown: pictureSummary(firstPicture, turnSince),
      firstPictureShowsPage: pagePictured(firstPicture),
      agentTabCasts,
      personTabPicture: pictureSummary(personPicture, openSince),
      personTabPictureShowsPage: personPagePictured,
      personTabCasts,
      errors: errorsFrom(from),
    };
    ensure(
      presses === 1 &&
        typeof animationFrames === "number" &&
        animationFrames > 1 &&
        firstPicture !== null &&
        firstPicture.at - turnSince < 1_000 &&
        outcome.firstPictureShowsPage === true &&
        // The engine supplies the first picture without synthetic redraws.
        agentTabCasts.redraws === 0 &&
        agentTabCasts.castStarts <= 1 + agentTabCasts.redraws &&
        personPagePictured === true &&
        personTabCasts.redraws === 0 &&
        // Opening can restart once after the initial viewport is sized.
        personTabCasts.castStarts <= 2 &&
        outcome.errors.length === 0,
      outcome,
    );
    return outcome;
  });

  /**
   * One tab's own debugger, beneath the CDP hub: every command any channel or
   * the hub sends it, with its answer, and the frames and dialog events
   * Chromium sends back, so a failure on that tab explains itself.
   */
  const watchTab = (url: string) => {
    const target = debuggerOf(url);
    const events: Array<{ readonly at: number; readonly entry: string }> = [];
    if (!target) return { log: () => [`no debugger shows ${url}`], stop: () => undefined };
    const send = target.sendCommand;
    const onMessage = (_event: unknown, method: string, parameters: unknown) => {
      const record = asRecord(parameters);
      if (method === "Page.screencastFrame") {
        const metadata = asRecord(record.metadata);
        const raster = jpegSize(Buffer.from(String(record.data), "base64"));
        events.push({
          at: performance.now(),
          entry: `frame ${String(metadata.deviceWidth)}x${String(metadata.deviceHeight)} raster ${raster.width}x${raster.height}`,
        });
      } else if (method.startsWith("Page.javascriptDialog")) {
        events.push({ at: performance.now(), entry: method });
      }
    };
    target.on("message", onMessage);
    target.sendCommand = (method: string, parameters?: unknown, sessionId?: string) => {
      const size = asRecord(parameters);
      const entry =
        method === "Emulation.setVisibleSize"
          ? `${method} ${String(size.width)}x${String(size.height)}`
          : method;
      const response = send.call(target, method, parameters, sessionId) as Promise<unknown>;
      if (method !== "Page.screencastFrameAck" && method !== "Runtime.evaluate") {
        events.push({ at: performance.now(), entry: `sent ${entry}` });
        void response.then(
          () => events.push({ at: performance.now(), entry: `answered ${entry}` }),
          (error: unknown) =>
            events.push({ at: performance.now(), entry: `refused ${entry}: ${String(error)}` }),
        );
      }
      return response;
    };
    return {
      log: (since: number) =>
        events
          .filter((event) => event.at >= since)
          .slice(-80)
          .map((event) => `${Math.round(event.at - since)}ms ${event.entry}`),
      stop: () => {
        target.off("message", onMessage);
        target.sendCommand = send;
      },
    };
  };

  // A tab the person opened, which no agent uses, is pictured again within a
  // second when they turn back to it, though nothing on it changed.
  await section("person-tab-on-return", async () => {
    const openedAt = performance.now();
    await controller.handle({ type: "surface.open", url: `${origin}/follow?return` });
    const opened = ledger.active();
    if (!opened || opened.surface.id === surfaceId) throw new Error("The tab did not open.");
    const tab = opened.surface.id;
    let watch: ReturnType<typeof watchTab> | null = null;
    try {
      await waitForAsync(
        async () =>
          asEvaluationValue(
            await opened.cdp.send("Runtime.evaluate", {
              expression: "document.readyState",
              returnByValue: true,
            }),
          ) === "complete",
      );
      const size = ledger.viewportOf(tab);
      if (!size) throw new Error("The tab has no size.");
      const first = await pictureWithin(size, openedAt, tab);
      watch = watchTab(`${origin}/follow?return`);
      const turnedAwayAt = performance.now();
      await controller.handle({ surfaceId, type: "surface.activate" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const returnedAt = performance.now();
      await controller.handle({ surfaceId: tab, type: "surface.activate" });
      const returned = await pictureWithin(size, returnedAt, tab);
      const outcome = {
        size,
        first: pictureSummary(first, openedAt),
        returned: pictureSummary(returned, returnedAt),
        returnedAfterMs: Math.round(returnedAt - turnedAwayAt),
        debuggerLog: watch.log(turnedAwayAt),
      };
      ensure(first !== null && returned !== null && returned.at - returnedAt < 1_000, outcome);
      if (returned) await saveFrame("person-tab-on-return", returned);
      return outcome;
    } finally {
      watch?.stop();
      await controller.handle({ surfaceId, type: "surface.activate" });
      await controller.handle({ surfaceId: tab, type: "surface.close" });
    }
  });

  // An answer names the dialog the person was shown. One that arrives after
  // they turned to another tab's dialog answers the first tab's alone; sent
  // again, it finds no dialog and reaches no other; the second tab's own
  // answer answers it.
  await section("stale-dialog-answers", async () => {
    const from = messages.length;
    await controller.handle({
      type: "surface.open",
      url: `${origin}/follow?dialog-b`,
    });
    const other = ledger.active();
    if (!other || other.surface.id === surfaceId) throw new Error("The second tab did not open.");
    const tabB = other.surface.id;
    const readB = async (expression: string) =>
      asEvaluationValue(
        await other.cdp.send("Runtime.evaluate", {
          awaitPromise: true,
          expression,
          returnByValue: true,
        }),
      );
    // A page under a dialog answers nothing else, so its answer is read once it closed.
    const answerOf = (
      surface: typeof surfaceId,
      reader: (expression: string) => Promise<unknown>,
    ) =>
      ledger.dialogOpen(surface)
        ? Promise.resolve("dialog still open")
        : reader("window.answer ?? null");
    const answerWith = async (dialogId: string, accept: boolean, expectRefusal = false) => {
      const answeredFrom = messages.length;
      const settledWithin5s = await settles(
        controller.handle({ accept, dialogId, type: "dialog.respond" }),
      );
      if (expectRefusal) {
        const refusals = messages
          .slice(answeredFrom)
          .filter((message) => message.type === "browser.error");
        ensure(
          refusals.length === 1 &&
            refusals[0]?.error.message === "There is no active browser dialog.",
          { dialogId, refusals },
        );
        expectedErrors.add(refusals[0]!);
      }
      return {
        settledWithin5s,
        errors: errorsFrom(answeredFrom),
        shown: messages
          .slice(answeredFrom)
          .flatMap((message) =>
            message.type === "browser.dialog.changed" ? [message.dialog?.id ?? null] : [],
          ),
      };
    };
    const shownOn = (index: number, surface: typeof surfaceId) =>
      waitFor(() =>
        messages
          .slice(index)
          .some(
            (message) =>
              message.type === "browser.dialog.changed" && message.dialog?.surfaceId === surface,
          ),
      );
    let watchB: ReturnType<typeof watchTab> | null = null;
    try {
      await waitForAsync(async () => (await readB("document.readyState")) === "complete");
      watchB = watchTab(`${origin}/follow?dialog-b`);
      const fromA = messages.length;
      const turnedAwayAt = performance.now();
      await controller.handle({ surfaceId, type: "surface.activate" });
      await read("setTimeout(() => { window.answer = confirm('Allow action A?'); }, 0); true");
      await shownOn(fromA, surfaceId);
      const dialogA = shownDialogId();
      await readB(
        "setTimeout(() => { window.answer = confirm('Allow destructive action B?'); }, 0); true",
      );
      await waitFor(() => ledger.dialogOf(tabB) !== null);
      const fromB = messages.length;
      const turnedToBAt = performance.now();
      await controller.handle({ surfaceId: tabB, type: "surface.activate" });
      await shownOn(fromB, tabB);
      const dialogB = shownDialogId();

      const late = await answerWith(dialogA, true);
      await waitForAsync(async () => (await answerOf(surfaceId, read)) !== null, 2_000).catch(
        () => undefined,
      );
      const lateAnswerForA = {
        ...late,
        answerA: await answerOf(surfaceId, read),
        dialogAOpen: ledger.dialogOpen(surfaceId),
        dialogBShown: ledger.dialogOf(tabB)?.id === dialogB,
        bInView: ledger.active()?.surface.id === tabB,
      };
      const repeated = await answerWith(dialogA, false, true);
      const repeatedAnswerForA = {
        ...repeated,
        answerA: await answerOf(surfaceId, read),
        dialogBShown: ledger.dialogOf(tabB)?.id === dialogB,
      };
      const answeredAt = performance.now();
      const own = await answerWith(dialogB, false);
      await waitForAsync(async () => (await answerOf(tabB, readB)) !== null, 2_000).catch(
        () => undefined,
      );
      const sizeB = ledger.viewportOf(tabB);
      const pictureB = sizeB ? await pictureWithin(sizeB, answeredAt, tabB) : null;
      if (pictureB) await saveFrame("stale-dialog-b-answered", pictureB);
      const answerForB = {
        ...own,
        answerB: await answerOf(tabB, readB),
        dialogBOpen: ledger.dialogOpen(tabB),
        picture: pictureSummary(pictureB, answeredAt),
        size: sizeB,
        marks: {
          turnedToB: Math.round(turnedToBAt - turnedAwayAt),
          answeredB: Math.round(answeredAt - turnedAwayAt),
        },
        debuggerLog: watchB.log(turnedAwayAt),
        streamed: frames
          .filter((frame) => frame.at >= answeredAt && frame.header.surfaceId === tabB)
          .map(
            (frame) =>
              `${Math.round(frame.at - answeredAt)}ms ${frame.header.viewportWidth}x${frame.header.viewportHeight} raster ${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
          ),
      };
      const outcome = {
        dialogs: { a: dialogA, b: dialogB },
        lateAnswerForA,
        repeatedAnswerForA,
        answerForB,
        errors: errorsFrom(from),
      };
      ensure(
        dialogA !== dialogB &&
          late.settledWithin5s &&
          late.errors.length === 0 &&
          late.shown.length === 0 &&
          lateAnswerForA.answerA === true &&
          !lateAnswerForA.dialogAOpen &&
          lateAnswerForA.dialogBShown &&
          lateAnswerForA.bInView,
        outcome,
      );
      ensure(
        repeated.settledWithin5s &&
          repeated.errors.length === 1 &&
          repeated.errors[0] === "There is no active browser dialog." &&
          repeated.shown.length === 0 &&
          repeatedAnswerForA.answerA === true &&
          repeatedAnswerForA.dialogBShown,
        outcome,
      );
      ensure(
        own.settledWithin5s &&
          own.errors.length === 0 &&
          own.shown.length === 1 &&
          own.shown[0] === null &&
          answerForB.answerB === false &&
          !answerForB.dialogBOpen &&
          pictureB !== null &&
          outcome.errors.length === 1,
        outcome,
      );
      return outcome;
    } finally {
      watchB?.stop();
      for (const surface of [surfaceId, tabB]) {
        const open = ledger.dialogOf(surface);
        if (open) await ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      }
      await controller.handle({ surfaceId, type: "surface.activate" });
      await controller.handle({ surfaceId: tabB, type: "surface.close" });
    }
  });

  // A tab whose dialog waits cannot draw. Turning back to it shows its last
  // picture beneath the dialog once the list showing it again went out, as a
  // viewer takes a picture only of the page that list shows; its answer
  // brings live pictures back.
  await section("waiting-tab-return", async () => {
    const from = messages.length;
    await controller.handle({ surfaceId, type: "surface.activate" });
    const size = ledger.viewportOf(surfaceId);
    if (!size) throw new Error("The root page has no size.");
    const isPictureOfA = (frame: TimedFrame) =>
      frame.header.surfaceId === surfaceId &&
      frame.header.viewportWidth === size.width &&
      frame.header.viewportHeight === size.height &&
      sameShape(frame.header);
    await controller.handle({ type: "surface.open", url: `${origin}/follow?other` });
    const other = ledger.active();
    if (!other || other.surface.id === surfaceId) throw new Error("The second tab did not open.");
    const tabB = other.surface.id;
    try {
      await waitForAsync(
        async () =>
          asEvaluationValue(
            await other.cdp.send("Runtime.evaluate", {
              expression: "document.readyState",
              returnByValue: true,
            }),
          ) === "complete",
      );
      const shownAt = performance.now();
      await controller.handle({ surfaceId, type: "surface.activate" });
      await read("document.getElementById('state').textContent = 'waiting tab'");
      await pictureWithin(size, shownAt);
      await read(
        "setTimeout(() => { window.answer = confirm('Keep waiting?'); document.getElementById('state').textContent = 'answered ' + window.answer; }, 0); true",
      );
      await waitFor(() => ledger.dialogOf(surfaceId) !== null);
      const dialog = ledger.dialogOf(surfaceId)!;
      const awayAt = performance.now();
      await controller.handle({ surfaceId: tabB, type: "surface.activate" });
      const awayPicture = await pictureWithin(ledger.viewportOf(tabB)!, awayAt, tabB);
      const returnFrom = messages.length;
      const returnedAt = performance.now();
      await controller.handle({ surfaceId, type: "surface.activate" });
      const listShowingA = () => {
        for (let index = returnFrom; index < messages.length; index += 1) {
          const message = messages[index]!;
          if (
            message.type === "browser.surfaces.changed" &&
            message.surfaces.some((surface) => surface.active && surface.id === surfaceId)
          ) {
            return messageTimes[index]!;
          }
        }
        return undefined;
      };
      await waitFor(() => {
        const list = listShowingA();
        return (
          list !== undefined && frames.some((frame) => frame.at >= list && isPictureOfA(frame))
        );
      }, 1_000).catch(() => undefined);
      const list = listShowingA();
      const retained =
        list === undefined
          ? null
          : (frames.find((frame) => frame.at >= list && isPictureOfA(frame)) ?? null);
      const dialogOpenAtPicture = ledger.dialogOpen(surfaceId);
      const picturesBeforeList = frames
        .filter(
          (frame) =>
            frame.at >= returnedAt &&
            frame.header.surfaceId === surfaceId &&
            (list === undefined || frame.at < list),
        )
        .map((frame) => pictureSummary(frame, returnedAt));
      const reshown = messages
        .slice(returnFrom)
        .find(
          (message) =>
            message.type === "browser.dialog.changed" && message.dialog?.surfaceId === surfaceId,
        );
      if (retained) await saveFrame("waiting-tab-retained", retained);
      const answeredAt = performance.now();
      const answered = await settles(
        controller.handle({ accept: true, dialogId: shownDialogId(), type: "dialog.respond" }),
      );
      const isLive = (frame: TimedFrame) =>
        frame.at >= answeredAt &&
        isPictureOfA(frame) &&
        retained !== null &&
        !frame.data.equals(retained.data);
      await waitFor(() => frames.some(isLive), 5_000).catch(() => undefined);
      const live = frames.find(isLive) ?? null;
      if (live) await saveFrame("waiting-tab-live-after-answer", live);
      const page = asRecord(
        await read(
          "({ answer: window.answer, state: document.getElementById('state').textContent })",
        ),
      );
      const outcome = {
        size,
        dialog,
        awayPicture: pictureSummary(awayPicture, awayAt),
        retained: retained
          ? {
              ...pictureSummary(retained, returnedAt),
              afterListMs: list === undefined ? null : Math.round(retained.at - list),
              header: retained.header,
              decoded: jpegSize(retained.data),
            }
          : null,
        picturesBeforeList,
        dialogOpenAtPicture,
        reshownDialog: reshown?.type === "browser.dialog.changed" ? reshown.dialog : null,
        answeredWithin5s: answered,
        live: pictureSummary(live, answeredAt),
        page,
        errors: errorsFrom(from),
      };
      ensure(
        retained !== null &&
          retained.at - returnedAt <= 300 &&
          picturesBeforeList.length === 0 &&
          outcome.retained?.decoded.width === retained.header.rasterWidth &&
          outcome.retained?.decoded.height === retained.header.rasterHeight &&
          dialogOpenAtPicture &&
          outcome.reshownDialog?.id === dialog.id,
        outcome,
      );
      ensure(
        answered &&
          live !== null &&
          page.answer === true &&
          page.state === "answered true" &&
          outcome.errors.length === 0,
        outcome,
      );
      return outcome;
    } finally {
      const open = ledger.dialogOf(surfaceId);
      if (open) await ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      await controller.handle({ surfaceId, type: "surface.activate" });
      await controller.handle({ surfaceId: tabB, type: "surface.close" });
    }
  });

  // An agent lays a page out as a phone. With no viewport tag the page is
  // 980px wide and Chromium zooms it out to fit; the person's click where the
  // picture shows a button lands on it, as on a page laid out device-wide.
  await section("agent-phone-layout-input", async () => {
    const from = messages.length;
    const created = asRecord(await agent("Target.createTarget", { url: `${origin}/follow?phone` }));
    const phoneTab = ledger.surfaceIdForTarget(String(created.targetId));
    const binding = phoneTab ? ledger.binding(phoneTab) : null;
    if (!phoneTab || !binding)
      throw new Error("The agent's tab is not one of the session's pages.");
    const agentSession = String(
      asRecord(
        await agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      ).sessionId,
    );
    const phoneRead = async (expression: string) =>
      asEvaluationValue(
        await binding.cdp.send("Runtime.evaluate", {
          awaitPromise: true,
          expression,
          returnByValue: true,
        }),
      );
    const phone = { height: 844, width: 390 };
    const atPhoneSize = (since: number) => (frame: TimedFrame) =>
      frame.at >= since &&
      frame.header.surfaceId === phoneTab &&
      frame.header.viewportWidth === phone.width &&
      frame.header.viewportHeight === phone.height &&
      sameShape(frame.header);
    /** What Chromium's latest frame of the tab said of itself, which input mapping reads. */
    const latest = { device: "", pageScaleFactor: null as unknown };
    const onFrame = (parameters: unknown) => {
      const metadata = asRecord(asRecord(parameters).metadata);
      latest.device = `${String(metadata.deviceWidth)}x${String(metadata.deviceHeight)}`;
      latest.pageScaleFactor = metadata.pageScaleFactor;
    };
    binding.cdp.on("Page.screencastFrame", onFrame);
    const outcomes: Array<Record<string, unknown>> = [];
    try {
      await controller.handle({
        surfaceId: phoneTab,
        type: "surface.activate",
      });
      for (const scenario of [
        {
          deviceScaleFactor: 1,
          deviceWidth: false,
          left: 490,
          name: "no-viewport-tag-1x",
          top: 490,
        },
        {
          deviceScaleFactor: 3,
          deviceWidth: false,
          left: 490,
          name: "no-viewport-tag-3x",
          top: 490,
        },
        {
          deviceScaleFactor: 3,
          deviceWidth: true,
          left: 150,
          name: "device-width-3x",
          top: 300,
        },
      ]) {
        const url = `${origin}/follow?phone-${scenario.name}`;
        await binding.cdp.send("Page.navigate", { url });
        await waitForAsync(async () => {
          const state = asRecord(
            await phoneRead("({ ready: document.readyState, href: location.href })"),
          );
          return state.ready === "complete" && state.href === url;
        });
        if (scenario.deviceWidth) {
          await phoneRead(`(() => {
            const meta = document.createElement("meta");
            meta.name = "viewport";
            meta.content = "width=device-width,initial-scale=1";
            document.head.append(meta);
          })()`);
        }
        const metricsAt = performance.now();
        await agent(
          "Emulation.setDeviceMetricsOverride",
          {
            ...phone,
            deviceScaleFactor: scenario.deviceScaleFactor,
            mobile: true,
          },
          agentSession,
        );
        await waitFor(() => frames.some(atPhoneSize(metricsAt)), 5_000);
        const placedAt = performance.now();
        // Blue, which nothing else on the follow page is.
        await phoneRead(`(() => {
          const button = document.createElement("button");
          button.id = "target";
          button.style.cssText = "position:absolute;left:${scenario.left}px;top:${scenario.top}px;width:100px;height:100px;margin:0;padding:0;border:0;background:rgb(0,0,255)";
          window.clicks = [];
          button.addEventListener("click", (event) => clicks.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY }));
          document.body.append(button);
          window.pointerLog = [];
        })()`);
        // The person aims where the picture shows the button.
        const seen: {
          box: ReturnType<typeof blueBox>;
          frame: TimedFrame | null;
        } = {
          box: null,
          frame: null,
        };
        await waitFor(() => {
          const frame = frames.findLast(atPhoneSize(placedAt));
          if (!frame || frame === seen.frame) return false;
          seen.frame = frame;
          seen.box = blueBox(frame);
          return seen.box !== null;
        }, 5_000).catch(() => undefined);
        const { box, frame } = seen;
        if (!box || !frame) throw new Error(`The button was never pictured in ${scenario.name}.`);
        await saveFrame(`phone-${scenario.name}`, frame);
        const aim = {
          x: (box.left + box.right) / 2 / box.width,
          y: (box.top + box.bottom) / 2 / box.height,
        };
        for (const action of ["down", "up"] as const) {
          await controller.handle({
            action,
            button: "left",
            clickCount: 1,
            surfaceId: phoneTab,
            type: "input.pointer",
            viewportHeight: phone.height,
            viewportWidth: phone.width,
            x: aim.x,
            y: aim.y,
          });
        }
        await waitForAsync(
          async () => Number(await phoneRead("window.clicks.length")) > 0,
          2_000,
        ).catch(() => undefined);
        const page = asRecord(
          await phoneRead(
            "({ clicks: window.clicks, presses: window.pointerLog.filter((entry) => entry.type === 'mousedown'), width: innerWidth, height: innerHeight, scale: visualViewport.scale })",
          ),
        );
        const clicks = (page.clicks as Array<Record<string, unknown>> | undefined) ?? [];
        const presses = (page.presses as Array<Record<string, unknown>> | undefined) ?? [];
        const outcome = {
          scenario,
          header: frame.header,
          pictureBox: box,
          aim,
          frameMetadata: { ...latest },
          page,
        };
        outcomes.push(outcome);
        const click = clicks[0];
        ensure(
          clicks.length === 1 &&
            click?.trusted === true &&
            Number(click.x) >= scenario.left &&
            Number(click.x) <= scenario.left + 100 &&
            Number(click.y) >= scenario.top &&
            Number(click.y) <= scenario.top + 100 &&
            presses.length === 1 &&
            presses[0]?.target === "target" &&
            (scenario.deviceWidth
              ? page.width === phone.width && page.scale === 1
              : page.width === 980 && Number(page.scale) < 0.5),
          outcome,
        );
        await agent("Emulation.clearDeviceMetricsOverride", {}, agentSession);
      }
      const errors = errorsFrom(from);
      ensure(errors.length === 0, { errors, outcomes });
      return { outcomes };
    } finally {
      binding.cdp.off("Page.screencastFrame", onFrame);
      await writeFile(
        path.join(artifactDirectory, "electron-phone-layout-input.json"),
        `${JSON.stringify({ versions: process.versions, outcomes }, null, 2)}\n`,
      );
      await agent("Emulation.clearDeviceMetricsOverride", {}, agentSession).catch(() => undefined);
      await controller.handle({ surfaceId, type: "surface.activate" });
      await agent("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }
  });

  // The person reads one tab while an agent works in another. The agent's
  // click there opens a confirm() once the site has worked for a while, and
  // the agent's size write reaches Chromium meanwhile, so Chromium holds the
  // write until the dialog is answered. Each page has its own size lock: the
  // person's drag on their tab applies at once, they turn to the agent's tab,
  // see its dialog, turn back without answering and keep streaming, and once
  // they answer there the agent's write completes and the tab's picture
  // returns. The view reports its size for each tab the person picks.
  await section("dialog-holds-agent-write", async () => {
    const from = messages.length;
    const personTab = surfaceId;
    const created = asRecord(
      await agent("Target.createTarget", {
        url: `${origin}/follow?agent-dialog`,
      }),
    );
    const agentTab = ledger.surfaceIdForTarget(String(created.targetId));
    if (!agentTab) throw new Error("The agent's tab is not one of the session's pages.");
    const agentSession = String(
      asRecord(
        await agent("Target.attachToTarget", {
          flatten: true,
          targetId: created.targetId,
        }),
      ).sessionId,
    );
    const agentRead = async (expression: string) =>
      asEvaluationValue(
        await agent(
          "Runtime.evaluate",
          { awaitPromise: true, expression, returnByValue: true },
          agentSession,
        ),
      );
    await waitForAsync(async () => (await agentRead("document.readyState")) === "complete");
    const button = asRecord(
      await agentRead(`(() => {
        const button = document.createElement("button");
        button.id = "delete";
        button.textContent = "Delete listing";
        button.style.cssText = "position:fixed;left:20px;top:120px;width:200px;height:60px";
        button.addEventListener("click", () => setTimeout(() => {
          window.workedFrom = Date.now();
          const until = performance.now() + 1500;
          while (performance.now() < until) {}
          window.answer = confirm("Delete this listing?");
        }, 0));
        document.body.append(button);
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`),
    );
    let dialogOpenedAt: number | null = null;
    const stopWatching = ledger.subscribe((event) => {
      if (
        event.type === "dialog" &&
        event.surfaceId === agentTab &&
        dialogOpenedAt === null &&
        ledger.dialogOpen(agentTab)
      ) {
        dialogOpenedAt = performance.now();
      }
    });
    const viewerFollows: Array<Promise<void>> = [];
    try {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await agent(
          "Input.dispatchMouseEvent",
          { button: "left", clickCount: 1, type, x: button.x, y: button.y },
          agentSession,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const agentSize = { height: 500, width: 600 };
      const writeSentAt = performance.now();
      const writeSentEpoch = Date.now();
      let writeSettledAt: number | null = null;
      const agentWrite = agent(
        "Emulation.setDeviceMetricsOverride",
        { ...agentSize, deviceScaleFactor: 1, mobile: false },
        agentSession,
      ).then(
        () => {
          writeSettledAt = performance.now();
          return null;
        },
        (error: unknown) => {
          writeSettledAt = performance.now();
          return error instanceof Error ? error.message : String(error);
        },
      );
      await waitFor(() => dialogOpenedAt !== null, 5_000).catch(() => undefined);
      const since = (start: number, at: number | null) =>
        at === null ? null : Math.round(at - start);

      await read("window.resizes = []");
      const dragSince = performance.now();
      const drag = [
        { height: 860, width: 1_300 },
        { height: 840, width: 1_260 },
        { height: 820, width: 1_220 },
        { height: 800, width: 1_200 },
      ];
      const dragging: Array<Promise<void>> = [];
      for (const size of drag) {
        dragging.push(follow(size));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const dragSettled = await settles(Promise.all(dragging));
      const dragSettledMs = Math.round(performance.now() - dragSince);
      const panel = drag.at(-1)!;
      const dragPicture = await pictureWithin(panel, dragSince);
      const dragLayout = await pageState();
      const dragCommands = commandsBetween(dragSince, performance.now());
      const dragResizes = await pageResizes();

      const turnFrom = messages.length;
      const turnSince = performance.now();
      const turned = await settles(
        controller.handle({ surfaceId: agentTab, type: "surface.activate" }),
      );
      viewerFollows.push(
        controller.handle({
          ...panel,
          surfaceId: agentTab,
          type: "viewport.follow",
        }),
      );
      const dialogShown = await waitFor(
        () =>
          messages
            .slice(turnFrom)
            .some(
              (message) =>
                message.type === "browser.dialog.changed" && message.dialog?.surfaceId === agentTab,
            ),
        5_000,
      ).then(
        () => Math.round(performance.now() - turnSince),
        () => null,
      );

      const backFrom = messages.length;
      const backSince = performance.now();
      const turnedBack = await settles(
        controller.handle({ surfaceId: personTab, type: "surface.activate" }),
      );
      viewerFollows.push(
        controller.handle({
          ...panel,
          surfaceId: personTab,
          type: "viewport.follow",
        }),
      );
      const backPicture = await pictureWithin(panel, backSince);
      const dialogHiddenOnPersonTab = messages
        .slice(backFrom)
        .some((message) => message.type === "browser.dialog.changed" && message.dialog === null);
      const paused = await settles(controller.handle({ type: "stream.unsubscribe" }));
      const resumeSince = performance.now();
      const resumed = await settles(controller.handle({ type: "stream.subscribe" }));
      const resumedPicture = await pictureWithin(panel, resumeSince);

      const againFrom = messages.length;
      const againSince = performance.now();
      const turnedAgain = await settles(
        controller.handle({ surfaceId: agentTab, type: "surface.activate" }),
      );
      viewerFollows.push(
        controller.handle({
          ...panel,
          surfaceId: agentTab,
          type: "viewport.follow",
        }),
      );
      const dialogShownAgain = await waitFor(
        () =>
          messages
            .slice(againFrom)
            .some(
              (message) =>
                message.type === "browser.dialog.changed" && message.dialog?.surfaceId === agentTab,
            ),
        5_000,
      ).then(
        () => Math.round(performance.now() - againSince),
        () => null,
      );
      const writeHeldUntilAnswer = writeSettledAt === null;
      const answerSince = performance.now();
      const answered = await settles(
        controller.handle({
          accept: true,
          dialogId: shownDialogId(),
          type: "dialog.respond",
        }),
      );
      const writeOutcome = await withTimeout(agentWrite, 5_000, {
        timeoutError: () => new Error("timed out"),
      }).catch(() => "unanswered within 5s");
      const agentPicture = await pictureWithin(agentSize, answerSince, agentTab);
      const followsSettled = await settles(Promise.all(viewerFollows));
      const page = asRecord(
        await agentRead(
          "({ answer: window.answer, workedFrom: window.workedFrom, width: innerWidth, height: innerHeight })",
        ),
      );
      const outcome = {
        agentWrite: {
          sentAfterSiteBeganWorkingMs: writeSentEpoch - Number(page.workedFrom),
          dialogOpenedAfterWriteMs: since(writeSentAt, dialogOpenedAt),
          heldUntilAnswer: writeHeldUntilAnswer,
          completedAfterAnswerMs: since(answerSince, writeSettledAt),
          refusal: writeOutcome,
        },
        personDrag: {
          settledWithin5s: dragSettled,
          settledMs: dragSettledMs,
          picture: pictureSummary(dragPicture, dragSince),
          layout: dragLayout,
          commands: dragCommands,
          pageResizes: dragResizes,
        },
        turnToAgentTab: { settledWithin5s: turned, dialogShownMs: dialogShown },
        turnBackWithoutAnswering: {
          settledWithin5s: turnedBack,
          picture: pictureSummary(backPicture, backSince),
          dialogHidden: dialogHiddenOnPersonTab,
          pauseSettledWithin5s: paused,
          resumeSettledWithin5s: resumed,
          resumedPicture: pictureSummary(resumedPicture, resumeSince),
        },
        turnToAgentTabAgain: {
          settledWithin5s: turnedAgain,
          dialogShownMs: dialogShownAgain,
        },
        answer: {
          settledWithin5s: answered,
          answer: page.answer,
          agentTabPicture: pictureSummary(agentPicture, answerSince),
          agentTabLayout: { height: page.height, width: page.width },
        },
        viewerFollowsSettledWithin5s: followsSettled,
        errors: errorsFrom(from),
      };
      ensure(
        outcome.agentWrite.sentAfterSiteBeganWorkingMs > 0 &&
          outcome.agentWrite.dialogOpenedAfterWriteMs !== null &&
          writeHeldUntilAnswer &&
          writeOutcome === null,
        outcome,
      );
      ensure(
        dragSettled &&
          dragPicture !== null &&
          !churns(dragCommands) &&
          onlyResizedTo(dragResizes, drag) &&
          dragLayout.width === panel.width &&
          dragLayout.height === panel.height,
        outcome,
      );
      ensure(turned && dialogShown !== null, outcome);
      ensure(
        turnedBack &&
          backPicture !== null &&
          dialogHiddenOnPersonTab &&
          paused &&
          resumed &&
          resumedPicture !== null,
        outcome,
      );
      ensure(turnedAgain && dialogShownAgain !== null, outcome);
      ensure(
        answered &&
          page.answer === true &&
          agentPicture !== null &&
          page.width === agentSize.width &&
          page.height === agentSize.height &&
          followsSettled &&
          outcome.errors.length === 0,
        outcome,
      );
      return outcome;
    } finally {
      stopWatching();
      const open = ledger.dialogOf(agentTab);
      if (open) await ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      await settles(Promise.all(viewerFollows));
      await controller.handle({
        surfaceId: personTab,
        type: "surface.activate",
      });
      await agent("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
    }
  });

  // A page's JavaScript dialog is tab-modal, as in a browser. An agent sees
  // it in target information and answers it with Page.handleJavaScriptDialog,
  // from the connection whose click opened it or a later one; when the person
  // and an agent answer at once it is answered once; the person's other tabs
  // stay usable while it waits; and a tab whose page shows one closes at once.
  await section("agent-and-tab-modal-dialogs", async () => {
    const from = messages.length;
    const panel = { height: 700, width: 1_000 };
    const confirmButton = `(() => {
      const button = document.createElement("button");
      button.id = "delete";
      button.textContent = "Delete listing";
      button.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px";
      window.answers = [];
      button.addEventListener("click", () => window.answers.push(confirm("Delete this listing?")));
      document.body.append(button);
    })()`;
    const timed = async (operation: Promise<unknown>) => {
      const since = performance.now();
      const error = await withTimeout(
        operation.then(() => null),
        5_000,
        { timeoutError: () => new Error("unanswered within 5s") },
      ).catch((caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
      return { error, ms: Math.round(performance.now() - since) };
    };
    const outcomeOf = (operation: Promise<unknown>) =>
      withTimeout(
        operation.then(() => "answered"),
        5_000,
        { timeoutError: () => new Error("unanswered within 5s") },
      ).catch((caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
    const viewerSaw = (start: number) =>
      messages
        .slice(start)
        .flatMap((message) =>
          message.type === "browser.dialog.changed"
            ? [message.dialog ? `${message.dialog.type}: ${message.dialog.message}` : "closed"]
            : [],
        );
    const opened: string[] = [];
    let third: typeof surfaceId | undefined;
    const openTab = async (label: string) => {
      const created = asRecord(
        await agent("Target.createTarget", { url: `${origin}/follow?${label}` }),
      );
      const targetId = String(created.targetId);
      opened.push(targetId);
      const tab = ledger.surfaceIdForTarget(targetId);
      if (!tab) throw new Error(`The agent's ${label} tab is not one of the session's pages.`);
      const session = String(
        asRecord(await agent("Target.attachToTarget", { flatten: true, targetId })).sessionId,
      );
      const evaluate = async (expression: string) =>
        asEvaluationValue(
          await agent("Runtime.evaluate", { expression, returnByValue: true }, session),
        );
      await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
      await evaluate(confirmButton);
      return { session, tab, targetId };
    };
    /** Read through the page's own channel: a read is not an agent command. */
    const answersOf = async (tab: typeof surfaceId) => {
      const binding = ledger.binding(tab);
      if (!binding) return null;
      return asEvaluationValue(
        await binding.cdp.send("Runtime.evaluate", {
          expression: "window.answers",
          returnByValue: true,
        }),
      );
    };
    /** The agent's click, as Browser Harness clickAt sends it; the release waits for the dialog. */
    const agentClick = async (session: string) => {
      const values = { button: "left", clickCount: 1, x: 50, y: 50 };
      await agent("Input.dispatchMouseEvent", { ...values, type: "mousePressed" }, session);
      return agent("Input.dispatchMouseEvent", { ...values, type: "mouseReleased" }, session);
    };
    const dialogOpens = (tab: typeof surfaceId) =>
      waitFor(() => ledger.dialogOf(tab) !== null, 5_000);
    try {
      const a = await openTab("dialogs-a");
      const shownSince = performance.now();
      await controller.handle({ surfaceId: a.tab, type: "surface.activate" });
      await controller.handle({ ...panel, surfaceId: a.tab, type: "viewport.follow" });
      ensure((await pictureWithin(panel, shownSince, a.tab)) !== null, "The tab was never shown.");

      // In the connection whose click opened it, as Puppeteer's page.on("dialog") answers.
      await agent("Page.enable", {}, a.session);
      progress("modal-tab-shown");
      const sameRunFrom = messages.length;
      const released = agentClick(a.session);
      await waitFor(
        () =>
          messages
            .slice(sameRunFrom)
            .some(
              (message) =>
                message.type === "cdp.event" &&
                message.event.sessionId === a.session &&
                message.event.method === "Page.javascriptDialogOpening",
            ),
        5_000,
      );
      const sameRunAnswer = await timed(
        agent("Page.handleJavaScriptDialog", { accept: true }, a.session),
      );
      const sameRunRelease = await timed(released);
      await agent("Page.disable", {}, a.session);
      const sameRun = {
        answer: sameRunAnswer,
        clickReleaseAnswered: sameRunRelease,
        answers: await answersOf(a.tab),
        viewerSaw: viewerSaw(sameRunFrom),
      };

      // The connection whose click Chromium holds ends, as a Browser Harness
      // run does; a later one sees the dialog on attach and answers it.
      progress("modal-same-run");
      const laterFrom = messages.length;
      const held = outcomeOf(agentClick(a.session));
      await dialogOpens(a.tab);
      const detached = await timed(agent("Target.detachFromTarget", { sessionId: a.session }));
      const heldClick = await held;
      const reattached = asRecord(
        await agent("Target.attachToTarget", { flatten: true, targetId: a.targetId }),
      );
      const later = String(reattached.sessionId);
      const info = asRecord(
        asRecord(await agent("Target.getTargetInfo", { targetId: a.targetId })).targetInfo,
      );
      const laterAnswer = await timed(
        agent("Page.handleJavaScriptDialog", { accept: true }, later),
      );
      const laterRun = {
        detached,
        heldClick,
        attachDialog: reattached.dialog ?? null,
        targetInfoDialog: info.dialog ?? null,
        answer: laterAnswer,
        answers: await answersOf(a.tab),
        viewerSaw: viewerSaw(laterFrom),
      };

      // The person and an agent answer the same dialog at once: it is answered once.
      progress("modal-later-run");
      const races: Record<string, unknown>[] = [];
      for (const first of ["person", "agent"] as const) {
        const raceFrom = messages.length;
        const releasing = outcomeOf(agentClick(later));
        await dialogOpens(a.tab);
        const dialog = ledger.dialogOf(a.tab)!;
        const person = () =>
          controller.handle({ accept: false, dialogId: dialog.id, type: "dialog.respond" });
        const agentAnswer = () =>
          agent("Page.handleJavaScriptDialog", { accept: true }, later).then(
            () => "answered",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        let agentOutcome: string;
        if (first === "person") {
          const personAnswered = person();
          agentOutcome = await agentAnswer();
          await personAnswered;
        } else {
          const agentAnswered = agentAnswer();
          await person();
          agentOutcome = await agentAnswered;
        }
        const refusals = messages
          .slice(raceFrom)
          .filter((message) => message.type === "browser.error");
        ensure(
          refusals.length === (agentOutcome === "answered" ? 1 : 0) &&
            refusals.every(
              (message) => message.error.message === "There is no active browser dialog.",
            ),
          { first, dialogId: dialog.id, agentOutcome, refusals },
        );
        for (const refusal of refusals) expectedErrors.add(refusal);
        races.push({
          first,
          agent: agentOutcome,
          personErrors: errorsFrom(raceFrom),
          clickRelease: await releasing,
          answers: await answersOf(a.tab),
          viewerSaw: viewerSaw(raceFrom),
        });
      }

      // The person's click opens it; they turn to another tab, size it and
      // open a third while it waits, then come back and answer it.
      progress("modal-races");
      const lastAnswerAt = performance.now();
      ensure(
        (await pictureWithin(panel, lastAnswerAt, a.tab)) !== null,
        "The tab was not pictured after its dialog closed.",
      );
      const press = (action: "down" | "up") =>
        controller.handle({
          action,
          button: "left",
          clickCount: 1,
          surfaceId: a.tab,
          type: "input.pointer",
          viewportHeight: panel.height,
          viewportWidth: panel.width,
          x: 0.05,
          y: 0.05,
        });
      const personClick = async () => {
        await press("down");
        const releasing = press("up");
        await dialogOpens(a.tab);
        return { releasing };
      };
      progress("modal-before-person-click");
      const { releasing } = await personClick();
      progress("modal-person-click");
      const dialog = ledger.dialogOf(a.tab)!;
      const turned = await timed(controller.handle({ surfaceId, type: "surface.activate" }));
      const rootSize = { height: 680, width: 960 };
      const rootSince = performance.now();
      const sizedRoot = await timed(follow(rootSize));
      const rootPicture = await pictureWithin(rootSize, rootSince);
      const openedThird = await timed(
        controller.handle({ type: "surface.open", url: `${origin}/follow?dialogs-third` }),
      );
      third = ledger.active()?.surface.id;
      const stillWaiting = ledger.dialogOf(a.tab)?.id === dialog.id;
      const backFrom = messages.length;
      const back = await timed(controller.handle({ surfaceId: a.tab, type: "surface.activate" }));
      const shownAgain = await waitFor(
        () =>
          messages
            .slice(backFrom)
            .some(
              (message) =>
                message.type === "browser.dialog.changed" && message.dialog?.id === dialog.id,
            ),
        5_000,
      ).then(
        () => true,
        () => false,
      );
      progress("modal-returned");
      const answerSince = performance.now();
      const answered = await timed(
        controller.handle({ accept: true, dialogId: dialog.id, type: "dialog.respond" }),
      );
      const clickFinished = await timed(releasing);
      progress("modal-person-answered");
      const personAnswers = await answersOf(a.tab);
      const tabModal = {
        turnToRoot: turned,
        sizeRoot: sizedRoot,
        rootPictureMs: rootPicture ? Math.round(rootPicture.at - rootSince) : null,
        openThird: openedThird,
        thirdOpened: third !== undefined && third !== a.tab && third !== surfaceId,
        sameDialogStillWaiting: stillWaiting,
        turnBack: back,
        sameDialogShownAgain: shownAgain,
        answered,
        clickFinished,
        answers: personAnswers,
      };

      // The person closes the tab whose page shows a dialog; the tab left shows.
      ensure(
        (await pictureWithin(panel, answerSince, a.tab)) !== null,
        "The tab was not pictured after the person answered.",
      );
      progress("modal-before-person-close");
      const closing = outcomeOf((await personClick()).releasing);
      const closeFrom = messages.length;
      const closeSince = performance.now();
      const personClosed = await timed(
        controller.handle({ surfaceId: a.tab, type: "surface.close" }),
      );
      const remaining = ledger.active()?.surface.id;
      const remainingSize = remaining ? ledger.viewportOf(remaining) : null;
      const remainingPicture =
        remaining && remainingSize
          ? await pictureWithin(remainingSize, closeSince, remaining)
          : null;
      const personClose = {
        closed: personClosed,
        tabGone: !ledger.snapshot().some((surface) => surface.id === a.tab),
        remainingIsThird: remaining === third,
        remainingPictureMs: remainingPicture ? Math.round(remainingPicture.at - closeSince) : null,
        clickRelease: await closing,
        errors: errorsFrom(closeFrom),
      };

      // An agent closes its own tab while its click there waits under a dialog.
      progress("modal-person-closed");
      const b = await openTab("dialogs-b");
      const agentHeld = outcomeOf(agentClick(b.session));
      await dialogOpens(b.tab);
      const agentClosed = await timed(agent("Target.closeTarget", { targetId: b.targetId }));
      const agentTabGone = await waitFor(
        () => !ledger.snapshot().some((surface) => surface.id === b.tab),
        1_000,
      ).then(
        () => true,
        () => false,
      );
      const agentClose = {
        closed: agentClosed,
        tabGone: agentTabGone,
        activeStayed: ledger.active()?.surface.id === remaining,
        clickRelease: await agentHeld,
      };

      const outcome = {
        sameRun,
        laterRun,
        races,
        tabModal,
        personClose,
        agentClose,
        errors: errorsFrom(from),
      };
      await writeFile(
        path.join(artifactDirectory, "electron-agent-dialogs.json"),
        `${JSON.stringify(outcome, null, 2)}\n`,
      );
      const shownThenClosed = (seen: unknown) =>
        JSON.stringify(seen) === JSON.stringify(["confirm: Delete this listing?", "closed"]);
      ensure(
        sameRun.answer.error === null &&
          sameRun.answer.ms < 1_000 &&
          sameRun.clickReleaseAnswered.error === null &&
          JSON.stringify(sameRun.answers) === "[true]" &&
          shownThenClosed(sameRun.viewerSaw),
        outcome,
      );
      ensure(
        detached.error === null &&
          detached.ms < 1_000 &&
          heldClick !== "unanswered within 5s" &&
          typeof asRecord(laterRun.attachDialog).id === "string" &&
          asRecord(laterRun.attachDialog).message === "Delete this listing?" &&
          asRecord(laterRun.attachDialog).type === "confirm" &&
          JSON.stringify(laterRun.targetInfoDialog) === JSON.stringify(laterRun.attachDialog) &&
          laterAnswer.error === null &&
          laterAnswer.ms < 1_000 &&
          JSON.stringify(laterRun.answers) === "[true,true]" &&
          shownThenClosed(laterRun.viewerSaw),
        outcome,
      );
      ensure(
        JSON.stringify(races.map((race) => [race.first, race.agent, race.personErrors])) ===
          JSON.stringify([
            ["person", "No dialog is showing.", []],
            ["agent", "answered", ["There is no active browser dialog."]],
          ]) &&
          JSON.stringify(races.at(-1)?.answers) === "[true,true,false,true]" &&
          races.every(
            (race) => race.clickRelease === "answered" && shownThenClosed(race.viewerSaw),
          ),
        outcome,
      );
      ensure(
        turned.error === null &&
          turned.ms < 500 &&
          sizedRoot.error === null &&
          rootPicture !== null &&
          openedThird.error === null &&
          tabModal.thirdOpened &&
          stillWaiting &&
          back.error === null &&
          shownAgain &&
          answered.error === null &&
          clickFinished.error === null &&
          JSON.stringify(personAnswers) === "[true,true,false,true,true]",
        outcome,
      );
      ensure(
        personClosed.error === null &&
          personClosed.ms < 1_000 &&
          personClose.tabGone &&
          personClose.remainingIsThird &&
          remainingPicture !== null &&
          personClose.errors.length === 0,
        outcome,
      );
      ensure(
        agentClosed.error === null &&
          agentClosed.ms < 1_000 &&
          agentClose.tabGone &&
          agentClose.activeStayed &&
          agentClose.clickRelease !== "answered" &&
          agentClose.clickRelease !== "unanswered within 5s",
        outcome,
      );
      return outcome;
    } finally {
      for (const surface of ledger.snapshot()) {
        const open = ledger.dialogOf(surface.id);
        if (open) await ledger.answerDialog(open.id, false, undefined).catch(() => undefined);
      }
      for (const targetId of opened) {
        await agent("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      if (third && ledger.binding(third)) {
        await controller.handle({ surfaceId: third, type: "surface.close" });
      }
      await controller.handle({ surfaceId, type: "surface.activate" });
    }
  });

  await section("inline-popup-dialogs", async () => {
    await controller.handle({ type: "surface.activate", surfaceId });
    const size = { width: 930, height: 670 };
    await controller.handle({ type: "viewport.set", surfaceId, ...size });
    const site = createServer((request, response) => {
      const type = request.url === "/alert" ? "alert" : "confirm";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Inline ${type}</title>
<script>window.answer = ${type}("Immediate ${type}"); window.finished = true;</script>
<body style="background:#aee">Answered ${type}</body>`);
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("Missing dialog fixture address");
    const outcomes: Record<string, unknown>[] = [];
    try {
      // document.write runs before the popup's Runtime inventory is ready.
      const writing = read(
        'window.p = window.open("about:blank", "_blank"); p.document.write("<script>window.answer=confirm(\\\"Written dialog\\\")<\\/script>"); true',
      ).catch(() => undefined);
      await waitFor(
        () =>
          ledger
            .snapshot()
            .some((surface) => ledger.dialogOf(surface.id)?.message === "Written dialog"),
        2_000,
      );
      const writtenPopup = ledger
        .snapshot()
        .find((surface) => ledger.dialogOf(surface.id)?.message === "Written dialog");
      if (!writtenPopup) throw new Error("The written popup was not registered");
      const inventory = await withTimeout(agent("Target.getTargets"), 2_000, {
        timeoutError: () => new Error("Dialog blocked target inventory"),
      });
      const writtenBinding = ledger.binding(writtenPopup.id)!;
      const writtenTarget = await writtenBinding.page.targetId();
      const writtenSession = String(
        asRecord(await agent("Target.attachToTarget", { targetId: writtenTarget, flatten: true }))
          .sessionId,
      );
      const writtenDialog = ledger.dialogOf(writtenPopup.id)!;
      await agent(
        "Page.handleJavaScriptDialog",
        { dialogId: writtenDialog.id, accept: false },
        writtenSession,
      );
      await writing;
      outcomes.push({ writtenPopup, writtenDialog, inventory });
      await agent("Target.closeTarget", { targetId: writtenTarget });

      for (const type of ["confirm", "alert"] as const) {
        const url = `http://127.0.0.1:${address.port}/${type}`;
        const from = messages.length;
        const openedAt = performance.now();
        ledger.recordLegacyPersonActivity(false);
        ledger.recordHumanActivity(surfaceId, { kind: "click" });
        const opening = read(`window.open(${JSON.stringify(url)}, "_blank") !== null`);
        await waitFor(
          () =>
            ledger
              .snapshot()
              .some(
                (surface) =>
                  surface.openerId != null &&
                  surface.url === url &&
                  ledger.dialogOf(surface.id) !== null,
              ),
          2_000,
        );
        const popup = ledger
          .snapshot()
          .find((surface) => surface.openerId != null && surface.url === url);
        if (!popup) throw new Error("The inline dialog popup was not registered");
        const dialog = ledger.dialogOf(popup.id);
        if (!dialog) throw new Error("The inline popup dialog was not captured");
        ensure(ledger.active()?.surface.id === popup.id, {
          popup,
          selected: ledger.active()?.surface.id,
        });
        await controller.handle({ type: "surface.activate", surfaceId: popup.id });
        await waitFor(
          () =>
            messages
              .slice(from)
              .some(
                (message) =>
                  message.type === "browser.surfaces.changed" &&
                  message.surfaces.some((surface) => surface.id === popup.id),
              ),
          2_000,
        );
        await waitFor(
          () =>
            messages
              .slice(from)
              .some(
                (message) =>
                  message.type === "browser.dialog.changed" && message.dialog?.id === dialog.id,
              ),
          2_000,
        );
        const visibleWithinMs = performance.now() - openedAt;
        const sizeBeforeAnswer = ledger.viewportOf(popup.id);
        ensure(ledger.active()?.surface.id === popup.id && dialog.type === type, { popup, dialog });
        const answeredAt = performance.now();
        ensure(
          await settles(
            controller.handle({
              type: "dialog.respond",
              dialogId: dialog.id,
              accept: true,
            }),
            2_000,
          ),
          dialog,
        );
        await opening;
        progress(`inline-${type}-answered`);
        await waitFor(() => ledger.viewportOf(popup.id)?.width === size.width);
        progress(`inline-${type}-viewport-settled`);
        const binding = ledger.binding(popup.id);
        if (!binding) throw new Error("The popup disappeared after its dialog was answered");
        const state = asRecord(
          asEvaluationValue(
            await binding.cdp.send("Runtime.evaluate", {
              expression:
                "({ width: innerWidth, height: innerHeight, finished: window.finished, answer: window.answer ?? null })",
              returnByValue: true,
            }),
          ),
        );
        progress(`inline-${type}-state-read`);
        await waitFor(() =>
          frames.some(
            (frame) =>
              frame.at >= answeredAt &&
              frame.header.surfaceId === popup.id &&
              frame.header.viewportWidth === size.width &&
              frame.header.viewportHeight === size.height,
          ),
        );
        const frame = frames.find(
          (frame) =>
            frame.at >= answeredAt &&
            frame.header.surfaceId === popup.id &&
            frame.header.viewportWidth === size.width &&
            frame.header.viewportHeight === size.height,
        )!;
        await saveFrame(`inline-${type}`, frame);
        ensure(
          state.width === size.width &&
            state.height === size.height &&
            state.finished === true &&
            state.answer === (type === "confirm" ? true : null),
          state,
        );
        outcomes.push({
          type,
          dialog,
          visibleWithinMs,
          sizeBeforeAnswer,
          state,
          frame: frame.header,
          messages: messages
            .slice(from)
            .filter(
              (message) =>
                message.type === "browser.surfaces.changed" ||
                message.type === "browser.dialog.changed",
            ),
        });
        await controller.handle({ type: "surface.close", surfaceId: popup.id });
        await controller.handle({ type: "surface.activate", surfaceId });
      }
      return { outcomes };
    } finally {
      await writeFile(
        path.join(artifactDirectory, "electron-inline-popup-dialogs.json"),
        `${JSON.stringify({ versions: process.versions, outcomes, surfaces: ledger.snapshot() }, null, 2)}\n`,
      );
      site.closeAllConnections();
      site.close();
      await once(site, "close");
    }
  });
  await section("written-popup-session-close", async () => {
    const isolated = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, ...defaultBrowserViewport },
      partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000019",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000019"),
      storage: { kind: "guest" },
    });
    const initial = isolated.context.pages()[0]!;
    const owned = new SurfaceLedger(isolated.context, { rootPages: [initial] });
    try {
      await owned.start();
      const channel = await initial.cdp();
      const opening = channel
        .send("Runtime.evaluate", {
          expression:
            'window.p = window.open("about:blank", "_blank"); p.document.write("<script>confirm(\\\"Close under dialog\\\")<\\/script>"); true',
        })
        .catch(() => undefined);
      await waitFor(
        () =>
          owned
            .snapshot()
            .some((surface) => owned.dialogOf(surface.id)?.message === "Close under dialog"),
        2_000,
      );
      const before = owned.snapshot();
      await owned.closeOwnedPages();
      await opening;
      await waitFor(() => isolated.context.pages().length === 0, 2_000);
      const remaining = isolated.context.pages().length;
      const outcome = { before, remaining };
      ensure(remaining === 0, outcome);
      await writeFile(
        path.join(artifactDirectory, "electron-written-popup-session-close.json"),
        JSON.stringify(outcome, null, 2),
      );
      return outcome;
    } finally {
      await owned.close();
      await isolated.close();
    }
  });
  const dragShapes = dragFrames.filter((frame) => !sameShape(frame.header)).length;
  if (dragShapes > 0) failures.push(`drag: ${dragShapes} frames had another shape`);
  const unexpectedErrors = errors().flatMap((message) =>
    message.type === "browser.error" && !expectedErrors.has(message) ? [message.error.message] : [],
  );
  if (unexpectedErrors.length > 0) failures.push(`errors: ${JSON.stringify(unexpectedErrors)}`);

  await writeFile(
    path.join(artifactDirectory, "electron-follow-view.json"),
    `${JSON.stringify(
      {
        engine: "electron",
        expectedOperationErrors: [...expectedErrors],
        versions: {
          chrome: process.versions.chrome,
          electron: process.versions.electron,
        },
        generatedAt: new Date().toISOString(),
        headless: app.commandLine.hasSwitch("headless"),
        screenScale,
        restingWindow: defaultBrowserViewport,
        restingPage: resting,
        largePage: {
          requested: large,
          restingHosts: {
            before: restingBefore,
            withLargePage: restingWithLarge,
          },
          layout: largeState,
          header: largePicture.header,
          decodedRaster: largeRaster,
          rasterPerCssPixel: rasterScale,
          farCorner: { rect: corner, pixel: cornerPixel },
        },
        styledScrollbar: { scrollbarShown, edge, edgeClick },
        heldThroughNoOpFollow: heldThroughNoOp,
        drag: {
          follows: dragSizes.length,
          durationMs: Math.round(dragEnded - dragStarted),
          framesDuringDrag: dragFrames.length,
          frameTimesMs: dragFrames.map((frame) => Math.round(frame.at - dragStarted)),
          frames: dragFrames.map(
            (frame) =>
              `${frame.header.viewportWidth}x${frame.header.viewportHeight} raster ${frame.header.rasterWidth}x${frame.header.rasterHeight}`,
          ),
          framesWithAnotherShape: dragShapes,
          commands: dragCommands,
          pageResizes: dragResizes.length,
          pageResizedOnlyToDraggedSizes: true,
          finalSize,
          finalPictureAfterLastFollowMs: finalPictureMs,
          stalePressRefused: true,
        },
        ...results,
        errorsInContext: messages.flatMap((message, index) =>
          message.type === "browser.error"
            ? [
                {
                  error: message.error,
                  after: messages
                    .slice(Math.max(0, index - 4), index)
                    .map((previous) =>
                      previous.type === "cdp.result" || previous.type === "cdp.error"
                        ? `${previous.type} ${previous.requestId}`
                        : previous.type,
                    ),
                },
              ]
            : [],
        ),
        savedFrames,
        failures,
        passed: failures.length === 0,
      },
      null,
      2,
    )}\n`,
  );
  await controller.handle({ type: "stream.unsubscribe" });
  await controller.close();
  await cdpRouter.close();
  await ledger.close();
  await browser.close();
  await files.dispose();
  app.off("web-contents-created", onContentsCreated);
  if (failures.length > 0) {
    throw new Error(`The follow-view checks failed: ${JSON.stringify(failures)}`);
  }
}

/** The picture has its page's shape, by the stream's own rule. */
function sameShape(header: BrowserFrame["header"]): boolean {
  return rasterShowsSize(
    { height: header.rasterHeight, width: header.rasterWidth },
    { height: header.viewportHeight, width: header.viewportWidth },
  );
}

/** A JPEG's pixel size, read from its start-of-frame marker. */
function jpegSize(data: Buffer): {
  readonly height: number;
  readonly width: number;
} {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("The frame is not a JPEG with a frame header.");
}

/** The format and pixel size of a base64 screencast image. */
function encodedImage(data: string): {
  readonly format: string;
  readonly height: number;
  readonly width: number;
} {
  const bytes = Buffer.from(data, "base64");
  const format =
    bytes.subarray(0, 4).toString("latin1") === "\x89PNG"
      ? "png"
      : bytes[0] === 0xff && bytes[1] === 0xd8
        ? "jpeg"
        : "other";
  return { format, ...nativeImage.createFromBuffer(bytes).getSize() };
}

/** The colour a frame shows at a point of its page, in CSS pixels. */
function framePixel(
  frame: BrowserFrame,
  x: number,
  y: number,
): { readonly blue: number; readonly green: number; readonly red: number } {
  const image = nativeImage.createFromBuffer(frame.data);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const column = Math.round((x * size.width) / frame.header.viewportWidth);
  const row = Math.round((y * size.height) / frame.header.viewportHeight);
  const offset = (row * size.width + column) * 4;
  // Electron bitmaps are BGRA.
  return {
    blue: bitmap[offset]!,
    green: bitmap[offset + 1]!,
    red: bitmap[offset + 2]!,
  };
}

/**
 * Where a frame pictures pure blue, in its pixels, with the frame's own pixel
 * size, or null if nowhere. JPEG and the display's colour profile move the
 * exact value, never the hue.
 */
function blueBox(frame: BrowserFrame): {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
} | null {
  const image = nativeImage.createFromBuffer(frame.data);
  const { height, width } = image.getSize();
  const bitmap = image.toBitmap();
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      // Electron bitmaps are BGRA.
      const blue = bitmap[offset]!;
      const green = bitmap[offset + 1]!;
      const red = bitmap[offset + 2]!;
      if (blue > 150 && blue - red > 100 && blue - green > 100) {
        left = Math.min(left, column);
        top = Math.min(top, row);
        right = Math.max(right, column + 1);
        bottom = Math.max(bottom, row + 1);
      }
    }
  }
  return right === 0 ? null : { bottom, height, left, right, top, width };
}

/**
 * A page with a styled scrollbar, a button beside it, a marker in its far
 * corner, the size it first laid out at, and a log of its resizes and of
 * every trusted pointer event.
 */
const followPage = `<!doctype html><meta charset="utf-8"><title>Follow view</title>
<style>
html,body{margin:0}
::-webkit-scrollbar{width:17px;height:17px;background:#ccc}
::-webkit-scrollbar-thumb{background:#888}
#tall{height:5000px}
#edge{position:fixed;top:40px;right:0;width:12px;height:40px;padding:0;border:0;background:#c00}
#corner{position:fixed;right:0;bottom:0;width:60px;height:60px;background:rgb(0,200,0)}
</style>
<div id="tall"><p id="state">Follow view</p></div>
<button id="edge" aria-label="Edge"></button><div id="corner"></div>
<script>
window.loadSize = { width: innerWidth, height: innerHeight };
window.resizes = [];
addEventListener("resize", () => resizes.push({ width: innerWidth, height: innerHeight }));
window.pointerLog = [];
for (const type of ["mousedown", "mouseup", "mousemove"]) {
  addEventListener(type, (event) => {
    if (event.isTrusted) pointerLog.push({ type, buttons: event.buttons, x: event.clientX, y: event.clientY, t: performance.now(), target: event.target.id || event.target.tagName });
  }, true);
}
</script>`;

function progress(stage: string): void {
  lastStage = stage;
  process.stdout.write(
    `${JSON.stringify({ event: "electron-browser-smoke.progress", stage, at: performance.now() })}\n`,
  );
}

function asEvaluationValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  return (result as { value?: unknown }).value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Electron browser smoke condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Electron browser smoke condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
