import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Real Electron agent CDP boundary. An agent drives a signed-in Browser
 * Session through the real SessionCdpRouter and BrowserController: page work
 * succeeds, while every cookie, network and storage theft path is refused and
 * nothing the agent receives carries the fake sign-in secrets. Writes
 * `electron.json` to `--artifact-dir=<dir>`, `OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR`,
 * or `<tmp>/opensteer-cdp-boundary-e2e`.
 *
 * How the Electron side of main-world provenance could fail, each checked
 * below and recorded under `checks`:
 * 1. A platform channel enabled Runtime first, so the debugger hub reports no
 *    contexts to the agent's later channel, and the router never learns that
 *    a world created before the agent attached is not a main world.
 * 2. A handle the platform holds from such a world (an isolated world, the
 *    page-policy preload's world, or the storage world 10991) runs code or
 *    reads properties for the agent, before or after its Runtime.enable.
 * 3. That world's console messages or exceptions reach the agent.
 * 4. The agent forges handles from its own isolate prefix and enumerated
 *    context and object numbers, and one of them reaches a non-main world.
 * 5. A renderer swap after a cross-site navigation renumbers contexts, and a
 *    stale classification admits a reused ID.
 * 6. Chromium's Log diagnostics reach the agent: a blocked CORS fetch quotes
 *    the response header the page's fetch never sees.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, WebContentsView, type WebContents } from "electron";
import {
  agentCdpAllowlist,
  ExecutionContextInventory,
  SessionCdpRouter,
  type CdpParameters,
} from "@opensteer/browser-core";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserSessionIdSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  stageFileMethod,
  SurfaceLedger,
  type BrowserLaunchRequest,
  type BrowserPage,
  type CdpSession,
} from "@opensteer/browser-runtime-core";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

const userData = mkdtempSync(path.join(tmpdir(), "opensteer-cdp-boundary-smoke-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP site-a.test 127.0.0.1, MAP site-b.test 127.0.0.1",
);
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

const artifactDirectory =
  process.argv.find((argument) => argument.startsWith("--artifact-dir="))?.slice(15) ??
  process.env.OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR ??
  path.join(tmpdir(), "opensteer-cdp-boundary-e2e");

const secrets = {
  corsHeader: `fake-acao-${randomBytes(16).toString("hex")}`,
  privateWorld: `fake-private-world-${randomBytes(16).toString("hex")}`,
  rotatedSessionA: `fake-rotated-a-${randomBytes(16).toString("hex")}`,
  sessionA: `fake-session-a-${randomBytes(16).toString("hex")}`,
  sessionB: `fake-session-b-${randomBytes(16).toString("hex")}`,
  storageB: `fake-storage-b-${randomBytes(16).toString("hex")}`,
};
/** The platform's own storage world; see `storageWorldId` in the launcher. */
const storageWorldId = 10_991;
/** Electron runs a context-isolated preload in this world. */
const preloadWorldId = 999;

// Each domain an agent must never reach; an event from any of them is a leak.
const browserInternalDomains = [
  "Audits",
  "Browser",
  "CSS",
  "CacheStorage",
  "DOMStorage",
  "Debugger",
  "Fetch",
  "HeapProfiler",
  "IO",
  "IndexedDB",
  "Log",
  "Memory",
  "Network",
  "Overlay",
  "Profiler",
  "Security",
  "ServiceWorker",
  "Storage",
  "SystemInfo",
  "Tracing",
  "WebAuthn",
];

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly method: string;
  readonly scope: "browser" | "page";
}

interface Check {
  readonly detail: unknown;
  readonly name: string;
  readonly passed: boolean;
}

const report: {
  agentEvents: Record<string, number>;
  browser: unknown;
  checks: Check[];
  controls: Record<string, unknown>;
  engine: "electron";
  error?: string;
  flows: Record<string, unknown>;
  generatedAt: string;
  passed: boolean;
  refusals: Refusal[];
  scan: { bytes: number; leaks: string[]; messages: number };
  secrets: { label: string; sha256: string }[];
} = {
  agentEvents: {},
  browser: null,
  checks: [],
  controls: {},
  engine: "electron",
  flows: {},
  generatedAt: new Date().toISOString(),
  passed: false,
  refusals: [],
  scan: { bytes: 0, leaks: [], messages: 0 },
  secrets: Object.entries(secrets).map(([label, value]) => ({
    label,
    sha256: createHash("sha256").update(value).digest("hex"),
  })),
};

void run().then(
  () => finish(null),
  (error: unknown) => finish(error),
);

async function run(): Promise<void> {
  await app.whenReady();
  const server = createServer(serveFixture);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address is missing.");
  const siteA = `http://site-a.test:${address.port}`;
  const siteB = `http://site-b.test:${address.port}`;

  const request = {
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000301",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000301"),
    storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
  } satisfies BrowserLaunchRequest;
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const browser = await launcher.launch(request);
  const page = browser.context.pages()[0];
  if (!page) throw new Error("Electron did not open its root page.");
  const rootTargetId = await page.targetId();
  // Production wiring: the session's router owns its root page and every page
  // the ledger registers for it.
  const files = new SessionFiles(
    path.join(await mkdtemp(path.join(tmpdir(), "opensteer-boundary-files-")), request.sessionId),
  );
  const router = new SessionCdpRouter(browser.cdp);
  const ledger = new SurfaceLedger(browser.context, {
    claimTarget: (targetId) => router.claimTarget(request.sessionId, targetId),
    initialViewport: request.initialViewport,
  });
  router.registerSession(
    request.sessionId,
    rootTargetId,
    (targetId) => ledger.resolveTarget(targetId),
    files.root,
  );
  await ledger.start();

  // The person signed in to both sites before the agent arrived.
  const platform = await page.cdp();
  const platformEvaluate = async (expression: string) =>
    evaluationValue(await platform.send("Runtime.evaluate", { expression, returnByValue: true }));
  // Observe before navigation: the icon controller also leases Runtime,
  // and enabling an already-enabled channel does not replay its worlds.
  const contents = pageContents(page);
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
    if (url.startsWith(siteB)) {
      report.controls.siteBStorageWritten =
        (await platformEvaluate("localStorage.getItem('token_b')")) === secrets.storageB;
    }
  }

  const preexisting = await plantPrivateWorlds(platform, contents, platformContexts);

  // An unfiltered page channel shows what the agent could take before the boundary.
  const raw = await browser.cdp.attach(rootTargetId);
  const rawEvents: { method: string; parameters: CdpParameters }[] = [];
  raw.onEvent((method, parameters) => rawEvents.push({ method, parameters }));
  report.controls.rawChannelCookieRead = foundSecrets(await raw.send("Network.getAllCookies"));

  const messages: BrowserServerMessage[] = [];
  const controller = new BrowserController({
    cdpRouter: router,
    claims: BrowserAttachTicketClaimsSchema.parse({
      access: "full-control",
      audience: "opensteer-browser-runtime",
      expiresAt: "2030-01-01T00:05:00.000Z",
      identity: { kind: "fresh" },
      issuedAt: "2030-01-01T00:00:00.000Z",
      nonce: "nonce_0123456789abcdef",
      runtimeId: "electron-boundary-smoke",
      sessionId: request.sessionId,
      subject: "electron-boundary-smoke",
    }),
    exportSnapshot: () => browser.exportSnapshot(),
    files,
    ledger,
    replaceSiteCookies: (site, cookies, deadline) =>
      browser.replaceSiteCookies(site, cookies, deadline),
    signIns: new HostSignIns({ authority: undefined, runtimeId: "electron-boundary-smoke" }),
    sink: {
      sendFrame: async () => undefined,
      sendServer: async (message) => {
        messages.push(message);
      },
    },
  });
  await controller.start();

  const agent = agentClient(controller, messages);
  report.browser = await agent.send("Browser.getVersion");
  const { targetInfos } = (await agent.send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string }[];
  };
  if (!targetInfos.some((target) => target.targetId === rootTargetId)) {
    throw new Error(`The agent did not see its page: ${JSON.stringify(targetInfos)}`);
  }
  const { sessionId } = (await agent.send("Target.attachToTarget", {
    flatten: true,
    targetId: rootTargetId,
  })) as { sessionId: string };
  const ownObject = (await agent.send("Runtime.evaluate", { expression: "({})" }, sessionId)) as {
    result: { objectId: string };
  };
  const heldBefore = await tryHeldHandles(agent, sessionId, preexisting, ownObject.result.objectId);
  check("held-handles-refused-before-agent-runtime-enable", allRefused(heldBefore), {
    attempts: heldBefore,
    worlds: preexisting.map(({ contextId, name, planted }) => ({ contextId, name, planted })),
  });
  for (const method of ["Page.enable", "Runtime.enable"]) {
    await agent.send(method, {}, sessionId);
  }
  const replayed = messages.flatMap((message) =>
    message.type === "cdp.event" &&
    message.event.sessionId === sessionId &&
    message.event.method === "Runtime.executionContextCreated"
      ? [asRecord(message.event.parameters.context)]
      : [],
  );
  check(
    "existing-main-worlds-reported-to-later-agent",
    replayed.length > 0 &&
      replayed.every((context) => platformContexts.isMainWorld(context.id)) &&
      platformContexts
        .entries()
        .filter((context) => context.mainWorld)
        .every((context) => replayed.some((reported) => reported.id === context.id)),
    {
      platformContexts: platformContexts.entries().map(({ frameId, id, mainWorld }) => ({
        frameId,
        id,
        mainWorld,
      })),
      reportedToAgent: replayed.map((context) => context.id),
    },
  );
  const heldAfter = await tryHeldHandles(agent, sessionId, preexisting, ownObject.result.objectId);
  check("held-handles-refused-after-agent-runtime-enable", allRefused(heldAfter), {
    attempts: heldAfter,
  });
  check(
    "private-world-console-and-exceptions-withheld",
    ...(await privateWorldOutput(platform, preexisting, platformEvents, messages)),
  );
  const forged = await forgeHandles(agent, sessionId, platformContexts);
  check("forged-handles-refused", forgedHandlesRefused(forged), forged);

  await raw.send("Runtime.enable");
  await raw.send("Network.enable");

  const refuse = async (method: string, parameters?: CdpParameters, on?: string): Promise<void> => {
    const outcome = await agent.send(method, parameters, on).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if (!("error" in outcome) || !(outcome.error instanceof AgentCommandError)) {
      throw new Error(`${method} was not refused: ${JSON.stringify(outcome)}`);
    }
    if (outcome.error.code !== "forbidden" || !outcome.error.message.includes(method)) {
      throw new Error(`${method} was refused unclearly: ${outcome.error.message}`);
    }
    report.refusals.push({
      code: outcome.error.code,
      message: outcome.error.message,
      method,
      scope: on ? "page" : "browser",
    });
  };
  for (const method of [
    "Network.getAllCookies",
    "Storage.getCookies",
    "Storage.getStorageKeyForFrame",
    "Target.setAutoAttach",
    "Target.createBrowserContext",
    "Target.exposeDevToolsProtocol",
    "Browser.setDownloadBehavior",
  ]) {
    await refuse(method);
  }
  for (const [method, parameters] of pageTheftAttempts(siteA, siteB)) {
    await refuse(method, parameters, sessionId);
  }

  // Harness-style page work: navigate, read, click, type, screenshot, files.
  const evaluate = async (expression: string) =>
    evaluationValue(
      await agent.send(
        "Runtime.evaluate",
        { awaitPromise: true, expression, returnByValue: true },
        sessionId,
      ),
    );
  await agent.send("Page.navigate", { url: `${siteA}/app` }, sessionId);
  await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "cdp.event" &&
        message.event.method === "Runtime.consoleAPICalled" &&
        JSON.stringify(message.event.parameters).includes("site-a page ready"),
    ),
  );
  const page1 = {
    cookie: await evaluate("document.cookie"),
    signedIn: await evaluate("document.body.dataset.signedIn"),
    title: await evaluate("document.title"),
  };
  if (
    page1.title !== "Site A app" ||
    page1.signedIn !== "yes" ||
    typeof page1.cookie !== "string" ||
    !page1.cookie.includes("visible_a=page-visible") ||
    page1.cookie.includes("session_a")
  ) {
    throw new Error(`The agent's page view is wrong: ${JSON.stringify(page1)}`);
  }
  report.flows.navigate = page1;

  // A page renders only while a display shows its window. A locked screen or a
  // sleeping display leaves it hidden, and Chromium then drops dispatched mouse
  // and key events; inserted text, screenshots and file inputs still work.
  const rendered = (await evaluate("document.visibilityState")) === "visible";
  report.flows.rendered = rendered;
  const center = async (selector: string) =>
    (await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    )) as { x: number; y: number };
  const click = async (selector: string) => {
    const point = await center(selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await agent.send(
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type, ...point },
        sessionId,
      );
    }
  };
  await click("#count");
  await click("#count");
  const clicks = await evaluate("window.clicks");
  if (rendered && clicks !== 2) throw new Error(`Clicks did not reach the page: ${String(clicks)}`);
  report.flows.click = { clicks, forwarded: true };

  await evaluate("document.querySelector('#name').focus()");
  await agent.send("Input.insertText", { text: "hello!" }, sessionId);
  // Browser Harness pressKey("Enter").
  const enter = {
    code: "Enter",
    key: "Enter",
    modifiers: 0,
    nativeVirtualKeyCode: 13,
    windowsVirtualKeyCode: 13,
  };
  for (const type of ["keyDown", "keyUp"]) {
    await agent.send("Input.dispatchKeyEvent", { ...enter, type }, sessionId);
  }
  const typed = await evaluate("document.querySelector('#name').value");
  const keys = await evaluate("window.keys");
  if (typed !== "hello!" || (rendered && !(Array.isArray(keys) && keys.includes("Enter")))) {
    throw new Error(`Typing did not reach the page: ${JSON.stringify({ keys, typed })}`);
  }
  report.flows.type = { keys, value: typed };

  const screenshot = (await agent.send("Page.captureScreenshot", { format: "png" }, sessionId)) as {
    data: string;
  };
  const png = Buffer.from(screenshot.data, "base64");
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("The agent's screenshot is not a PNG.");
  }
  report.flows.screenshot = { bytes: png.byteLength };

  const { root } = (await agent.send("DOM.getDocument", {}, sessionId)) as {
    root: { nodeId: number };
  };
  const { nodeId } = (await agent.send(
    "DOM.querySelector",
    { nodeId: root.nodeId, selector: "#name" },
    sessionId,
  )) as { nodeId: number };
  const resolved = (await agent.send("DOM.resolveNode", { nodeId }, sessionId)) as {
    object: { objectId: string };
  };
  const domValue = evaluationValue(
    await agent.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: "function(){return this.value}",
        objectId: resolved.object.objectId,
        returnByValue: true,
      },
      sessionId,
    ),
  );
  if (domValue !== "hello!") throw new Error(`DOM handles did not work: ${String(domValue)}`);
  const tree = (await agent.send("Accessibility.getFullAXTree", {}, sessionId)) as {
    nodes: { name?: { value?: unknown } }[];
  };
  if (!tree.nodes.some((node) => node.name?.value === "Count")) {
    throw new Error("The accessibility tree is missing the page's button.");
  }
  report.flows.dom = { accessibilityNodes: tree.nodes.length, value: domValue };

  // Harness setInputFiles: a selector's input directly, and a button's chooser.
  const upload = randomBytes(4_096);
  const staged = (await agent.send(stageFileMethod, {
    data: upload.toString("base64"),
    fileId: randomUUID(),
    name: "boundary.txt",
    offset: 0,
    size: upload.byteLength,
  })) as { path: string };
  const fileInput = (await agent.send(
    "Runtime.evaluate",
    { expression: "document.querySelector('#file')" },
    sessionId,
  )) as { result: { objectId: string } };
  await agent.send(
    "DOM.setFileInputFiles",
    { files: [staged.path], objectId: fileInput.result.objectId },
    sessionId,
  );
  if (rendered) {
    await agent.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
    await click("#choose");
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === "cdp.event" &&
          message.event.method === "Page.fileChooserOpened" &&
          message.event.sessionId === sessionId,
      ),
    );
    const chooser = messages.find(
      (message) =>
        message.type === "cdp.event" && message.event.method === "Page.fileChooserOpened",
    );
    const backendNodeId =
      chooser?.type === "cdp.event" ? chooser.event.parameters.backendNodeId : null;
    await agent.send("DOM.setFileInputFiles", { backendNodeId, files: [staged.path] }, sessionId);
    await agent.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId);
  }
  const fileNames = await evaluate(
    "[...document.querySelectorAll('input[type=file]')].map((input) => input.files[0]?.name ?? null)",
  );
  const expectedFiles = rendered ? ["boundary.txt", "boundary.txt"] : ["boundary.txt", null];
  if (JSON.stringify(fileNames) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Files did not reach the page: ${JSON.stringify(fileNames)}`);
  }
  report.flows.files = { chooser: rendered, names: fileNames };

  await agent.send(
    "Emulation.setDeviceMetricsOverride",
    { deviceScaleFactor: 1, height: 500, mobile: false, width: 700 },
    sessionId,
  );
  // The command reply precedes Chromium's renderer resize. Observe the page
  // reaching each size before checking the round trip.
  await waitForAsync(
    async () => JSON.stringify(await evaluate("[innerWidth, innerHeight]")) === "[700,500]",
  );
  const emulated = JSON.stringify(await evaluate("[innerWidth, innerHeight]"));
  await agent.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await waitForAsync(
    async () => JSON.stringify(await evaluate("[innerWidth, innerHeight]")) === "[800,600]",
  );
  const restored = JSON.stringify(await evaluate("[innerWidth, innerHeight]"));
  if (emulated !== "[700,500]" || restored !== "[800,600]") {
    throw new Error(`Emulation did not reach the page: ${emulated} then ${restored}`);
  }
  report.flows.emulation = { emulated, restored };
  report.flows.printToPDF = await agent.send("Page.printToPDF", {}, sessionId).then(
    (result) => ({ bytes: Buffer.from((result as { data: string }).data, "base64").byteLength }),
    (error: unknown) => {
      if (error instanceof AgentCommandError && error.code === "forbidden") throw error;
      return { browserError: error instanceof Error ? error.message : String(error) };
    },
  );
  await agent.send("Page.reload", { ignoreCache: false }, sessionId);
  await waitForAsync(async () => (await evaluate("document.readyState")) === "complete");
  const history = (await agent.send("Page.getNavigationHistory", {}, sessionId)) as {
    entries: unknown[];
  };
  report.flows.history = { entries: history.entries.length };

  // Chromium's diagnostics for a blocked CORS fetch quote the response
  // header that the page's own fetch never sees.
  await raw.send("Log.enable");
  const logCommands: (Attempt & { method: string })[] = [];
  for (const method of ["Log.enable", "Log.clear"]) {
    logCommands.push({ method, ...(await attempt(agent, method, {}, sessionId)) });
  }
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
  // The same debugger session delivers to every channel at once; give the
  // controller's sink a moment to record anything it was handed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const corsLeaks = messages.filter((message) =>
    JSON.stringify(message).includes(secrets.corsHeader),
  ).length;
  check(
    "cors-diagnostics-withheld",
    corsFetch === "TypeError" &&
      logCommands.every((command) => command.outcome === "forbidden") &&
      corsLeaks === 0,
    { agentMessagesWithHeader: corsLeaks, corsFetch, logCommands, rawLogCaptured: true },
  );

  // A cross-site round trip can replace the renderer, which numbers its
  // contexts afresh; new worlds there must be refused just the same.
  const rendererProcesses = [contents.getOSProcessId()];
  for (const url of [`${siteB}/blank`, `${siteA}/blank`]) {
    await agent.send("Page.navigate", { url }, sessionId);
    await waitForAsync(
      async () => page.url() === url && (await evaluate("document.readyState")) === "complete",
    );
    rendererProcesses.push(contents.getOSProcessId());
  }
  const swapped = await plantPrivateWorlds(platform, contents, platformContexts);
  const swappedObject = (await agent.send(
    "Runtime.evaluate",
    { expression: "({})" },
    sessionId,
  )) as { result: { objectId: string } };
  const heldSwapped = await tryHeldHandles(
    agent,
    sessionId,
    swapped,
    swappedObject.result.objectId,
  );
  for (const world of swapped) {
    heldSwapped.push({
      contextId: world.contextId,
      method: "Runtime.evaluate",
      world: world.name,
      ...(await attempt(
        agent,
        "Runtime.evaluate",
        { contextId: world.contextId, expression: "globalThis.privateSecret" },
        sessionId,
      )),
    });
  }
  check("held-handles-refused-after-renderer-swap", allRefused(heldSwapped), {
    attempts: heldSwapped,
    rendererProcesses,
  });
  const forgedSwapped = await forgeHandles(agent, sessionId, platformContexts);
  check("forged-handles-refused-after-renderer-swap", forgedHandlesRefused(forgedSwapped), {
    ...forgedSwapped,
    rendererProcesses,
  });

  const leakedHeaders = rawEvents.filter((event) => event.method.endsWith("ExtraInfo"));
  report.controls.rawChannelHeaderCapture = foundSecrets(leakedHeaders);

  const received = messages.filter(
    (message) =>
      message.type === "cdp.result" || message.type === "cdp.error" || message.type === "cdp.event",
  );
  for (const message of received) {
    if (message.type !== "cdp.event") continue;
    report.agentEvents[message.event.method] = (report.agentEvents[message.event.method] ?? 0) + 1;
  }
  // Page events by reviewed name only; Target events are the router's own.
  const unreviewedEvents = Object.keys(report.agentEvents).filter(
    (method) => !agentCdpAllowlist.events.has(method) && !method.startsWith("Target."),
  );
  check("agent-events-reviewed-by-name", unreviewedEvents.length === 0, {
    received: Object.keys(report.agentEvents),
    unreviewedEvents,
  });
  const leakedEvents = Object.keys(report.agentEvents).filter(
    (method) =>
      browserInternalDomains.includes(method.split(".", 1)[0] ?? "") ||
      method === "Runtime.bindingCalled" ||
      method === "Runtime.inspectRequested",
  );
  const isolatedEvents = received.filter(
    (message) =>
      message.type === "cdp.event" &&
      message.event.method === "Runtime.executionContextCreated" &&
      asRecord(asRecord(message.event.parameters.context).auxData).isDefault !== true,
  );
  const serialized = messages.map((message) => JSON.stringify(message));
  report.scan = {
    bytes: serialized.reduce((total, entry) => total + Buffer.byteLength(entry), 0),
    leaks: Object.entries(secrets)
      .filter(([, value]) => serialized.some((entry) => entry.includes(value)))
      .map(([label]) => label),
    messages: messages.length,
  };

  await raw.close();
  await controller.close();
  await router.close();
  await files.dispose();
  await ledger.close();
  await browser.close();
  server.close();
  await once(server, "close");

  const controls = report.controls as {
    rawChannelCookieRead: string[];
    rawChannelHeaderCapture: string[];
    siteBStorageWritten: boolean;
  };
  const failedChecks = report.checks.filter((entry) => !entry.passed).map((entry) => entry.name);
  if (failedChecks.length > 0) {
    throw new Error(`The agent reached outside frames' main worlds: ${failedChecks.join(", ")}`);
  }
  if (
    !controls.siteBStorageWritten ||
    !controls.rawChannelCookieRead.includes("sessionA") ||
    !controls.rawChannelCookieRead.includes("sessionB") ||
    !controls.rawChannelHeaderCapture.includes("rotatedSessionA")
  ) {
    throw new Error(`The fake sign-ins never reached the browser: ${JSON.stringify(controls)}`);
  }
  if (leakedEvents.length > 0 || isolatedEvents.length > 0 || report.scan.leaks.length > 0) {
    throw new Error(
      `The agent received browser internals: ${JSON.stringify({ isolatedEvents: isolatedEvents.length, leakedEvents, leaks: report.scan.leaks })}`,
    );
  }
  const expectedEvents = [
    "Page.loadEventFired",
    "Runtime.consoleAPICalled",
    "Runtime.executionContextCreated",
  ];
  if (report.flows.rendered) expectedEvents.push("Page.fileChooserOpened");
  for (const method of expectedEvents) {
    if (!report.agentEvents[method]) throw new Error(`The agent did not receive ${method}.`);
  }
  report.passed = true;
}

function pageTheftAttempts(siteA: string, siteB: string): [string, CdpParameters?][] {
  const otherOrigin = { securityOrigin: siteB };
  return [
    ["Network.enable"],
    ["Network.getAllCookies"],
    ["Network.getCookies", { urls: [`${siteB}/`] }],
    ["Network.getCookies", { urls: [`${siteA}/`] }],
    [
      "Network.loadNetworkResource",
      { options: { disableCache: true, includeCredentials: true }, url: `${siteB}/login` },
    ],
    ["Network.getResponseBody", { requestId: "1" }],
    ["Network.setExtraHTTPHeaders", { headers: { "x-agent": "1" } }],
    ["Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }],
    ["Storage.getCookies"],
    ["Storage.getUsageAndQuota", { origin: siteB }],
    ["DOMStorage.enable"],
    ["DOMStorage.getDOMStorageItems", { storageId: { ...otherOrigin, isLocalStorage: true } }],
    ["IndexedDB.requestDatabaseNames", otherOrigin],
    ["CacheStorage.requestCacheNames", otherOrigin],
    ["ServiceWorker.enable"],
    ["Security.setIgnoreCertificateErrors", { ignore: true }],
    ["Debugger.enable"],
    ["HeapProfiler.enable"],
    ["Profiler.enable"],
    ["Tracing.start"],
    ["Memory.getDOMCounters"],
    ["IO.read", { handle: "1" }],
    ["SystemInfo.getInfo"],
    ["Audits.enable"],
    ["Inspector.enable"],
    ["WebAuthn.enable"],
    ["CSS.enable"],
    ["Overlay.enable"],
    ["Browser.getVersion"],
    ["Page.addScriptToEvaluateOnNewDocument", { source: "window.planted = true" }],
    ["Page.createIsolatedWorld", { frameId: "main", worldName: "agent" }],
    ["Page.setBypassCSP", { enabled: true }],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: tmpdir() }],
    ["Page.getResourceContent", { frameId: "main", url: `${siteA}/login` }],
    ["Page.reload", { scriptToEvaluateOnLoad: "window.planted = true" }],
    ["Page.printToPDF", { transferMode: "ReturnAsStream" }],
    ["Runtime.addBinding", { name: "agentBinding" }],
    ["Runtime.compileScript", { expression: "1", persistScript: true, sourceURL: "agent.js" }],
    ["Runtime.runScript", { scriptId: "1" }],
    ["Runtime.evaluate", { expression: "copy(document.cookie)", includeCommandLineAPI: true }],
    ["Runtime.evaluate", { expression: "1", uniqueContextId: "1.1" }],
    ["Runtime.callFunctionOn", { executionContextId: 1, functionDeclaration: "() => 1" }],
    ["DOM.resolveNode", { backendNodeId: 1, executionContextId: 1 }],
    // Parameters the reviewed spec does not give agents.
    ["Page.navigate", { referrer: `${siteB}/`, url: `${siteA}/app` }],
    [
      "Emulation.setDeviceMetricsOverride",
      { deviceScaleFactor: 1, height: 600, mobile: false, scale: 4, width: 800 },
    ],
    ["DOM.getDocument", { depth: 1, unreviewedParameter: true }],
    [
      "Input.dispatchDragEvent",
      {
        data: {
          dragOperationsMask: 1,
          items: [{ data: "x", mimeType: "text/plain", unreviewed: 1 }],
        },
        type: "drop",
        x: 1,
        y: 1,
      },
    ],
  ];
}

type Agent = ReturnType<typeof agentClient>;

interface Attempt {
  readonly leaked?: string[];
  readonly message?: string;
  readonly outcome: "failed" | "forbidden" | "forwarded";
}

interface HeldAttempt extends Attempt {
  readonly contextId: number;
  readonly method: string;
  readonly world: string;
}

interface PrivateWorld {
  readonly contextId: number;
  /** A handle the platform holds on an object in this world. */
  readonly held: string;
  readonly name: string;
  readonly planted: boolean;
}

function check(name: string, passed: boolean, detail: unknown): void {
  report.checks.push({ detail, name, passed });
}

/** Sends as the agent; a refusal by the router is `forbidden`, anything Chromium said is `failed`. */
async function attempt(
  agent: Agent,
  method: string,
  parameters: CdpParameters,
  sessionId?: string,
): Promise<Attempt> {
  return agent.send(method, parameters, sessionId).then(
    (result) => ({ leaked: foundSecrets(result), outcome: "forwarded" as const }),
    (error: unknown) =>
      error instanceof AgentCommandError && error.code === "forbidden"
        ? { message: error.message, outcome: "forbidden" as const }
        : {
            message: error instanceof Error ? error.message : String(error),
            outcome: "failed" as const,
          },
  );
}

function allRefused(attempts: readonly Attempt[]): boolean {
  return attempts.length > 0 && attempts.every((entry) => entry.outcome === "forbidden");
}

function pageContents(page: BrowserPage): WebContents {
  const view: unknown = Reflect.get(page, "view");
  if (!(view instanceof WebContentsView)) throw new Error("The Electron page has no view.");
  return view.webContents;
}

/**
 * Puts the fake private secret in three worlds beside the main frame's own:
 * one created over CDP, the platform's storage world and the preload's world.
 * Returns a platform-held handle in every non-main world of the main frame.
 */
async function plantPrivateWorlds(
  platform: CdpSession,
  contents: WebContents,
  contexts: ExecutionContextInventory,
): Promise<PrivateWorld[]> {
  const plant = `globalThis.privateSecret = ${JSON.stringify(secrets.privateWorld)}; true`;
  const { frameTree } = (await platform.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  const frameId = frameTree.frame.id;
  const created = (await platform.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "existing-private-world",
  })) as { executionContextId: number };
  await platform.send("Runtime.evaluate", {
    contextId: created.executionContextId,
    expression: plant,
  });
  for (const worldId of [storageWorldId, preloadWorldId]) {
    await contents.executeJavaScriptInIsolatedWorld(worldId, [{ code: plant }], false);
  }
  const holdsSecret = async (contextId: number) =>
    evaluationValue(
      await platform.send("Runtime.evaluate", {
        contextId,
        expression: `globalThis.privateSecret === ${JSON.stringify(secrets.privateWorld)}`,
        returnByValue: true,
      }),
    ) === true;
  const others = () =>
    contexts.entries().filter((context) => !context.mainWorld && context.frameId === frameId);
  // Electron reports a new world's context over the debugger, apart from the
  // reply that ran code in it.
  await waitForAsync(async () => {
    let planted = 0;
    for (const context of others()) if (await holdsSecret(context.id)) planted += 1;
    return planted >= 3;
  });
  const worlds: PrivateWorld[] = [];
  for (const context of others()) {
    const held = (await platform.send("Runtime.evaluate", {
      contextId: context.id,
      expression: "({ privileged: globalThis.privateSecret ?? null })",
    })) as { result: { objectId?: string } };
    if (typeof held.result.objectId !== "string") {
      throw new Error(`World ${context.id} held no object.`);
    }
    worlds.push({
      contextId: context.id,
      held: held.result.objectId,
      name: String(context.description.name ?? ""),
      planted: await holdsSecret(context.id),
    });
  }
  return worlds;
}

/** The agent uses each platform-held handle directly and as a call argument. */
async function tryHeldHandles(
  agent: Agent,
  sessionId: string,
  worlds: readonly PrivateWorld[],
  ownObjectId: string,
): Promise<HeldAttempt[]> {
  const attempts: HeldAttempt[] = [];
  for (const world of worlds) {
    const commands: [string, CdpParameters][] = [
      [
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(){return globalThis.privateSecret ?? null}",
          objectId: world.held,
          returnByValue: true,
        },
      ],
      ["Runtime.getProperties", { objectId: world.held, ownProperties: true }],
      [
        "Runtime.callFunctionOn",
        {
          arguments: [{ objectId: world.held }],
          functionDeclaration: "function(held){return held.privileged}",
          objectId: ownObjectId,
          returnByValue: true,
        },
      ],
    ];
    for (const [method, parameters] of commands) {
      attempts.push({
        contextId: world.contextId,
        method,
        world: world.name,
        ...(await attempt(agent, method, parameters, sessionId)),
      });
    }
  }
  return attempts;
}

/** Each private world logs and throws; the platform hears it, the agent must not. */
async function privateWorldOutput(
  platform: CdpSession,
  worlds: readonly PrivateWorld[],
  platformEvents: readonly { method: string; parameters: CdpParameters }[],
  messages: readonly BrowserServerMessage[],
): Promise<[boolean, unknown]> {
  const contextIds = new Set(worlds.map((world) => world.contextId));
  for (const world of worlds) {
    await platform.send("Runtime.evaluate", {
      contextId: world.contextId,
      expression: `console.log("FAKE_PRIVATE_CONSOLE", { privateSecret: globalThis.privateSecret }); setTimeout(() => { throw new Error("private-world-exception " + globalThis.privateSecret); }); true`,
    });
  }
  const fromPrivateWorlds = (method: string, parameters: CdpParameters) =>
    contextIds.has(
      Number(
        method === "Runtime.exceptionThrown"
          ? asRecord(parameters.exceptionDetails).executionContextId
          : parameters.executionContextId,
      ),
    );
  const heardByPlatform = () =>
    platformEvents.filter(
      (event) =>
        (event.method === "Runtime.consoleAPICalled" ||
          event.method === "Runtime.exceptionThrown") &&
        fromPrivateWorlds(event.method, event.parameters),
    );
  await waitFor(
    () =>
      heardByPlatform().filter((event) => event.method === "Runtime.consoleAPICalled").length >=
      worlds.length,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const heardByAgent = messages.filter(
    (message) =>
      message.type === "cdp.event" &&
      (message.event.method === "Runtime.consoleAPICalled" ||
        message.event.method === "Runtime.exceptionThrown") &&
      fromPrivateWorlds(message.event.method, message.event.parameters),
  );
  const carriesSecret = messages.filter((message) =>
    JSON.stringify(message).includes(secrets.privateWorld),
  );
  return [
    heardByAgent.length === 0 && carriesSecret.length === 0,
    {
      agentEventsFromPrivateWorlds: heardByAgent.length,
      agentMessagesWithSecret: carriesSecret.length,
      platformEventsFromPrivateWorlds: heardByPlatform().map((event) => event.method),
    },
  ];
}

/**
 * Forges `<isolate>.<context>.<object>` from the agent's own isolate prefix
 * for every context number up to two past the highest the platform knows.
 */
async function forgeHandles(agent: Agent, sessionId: string, contexts: ExecutionContextInventory) {
  const own = (await agent.send("Runtime.evaluate", { expression: "({})" }, sessionId)) as {
    result: { objectId: string };
  };
  const prefix = own.result.objectId.split(".", 1)[0] ?? "";
  const highest = Math.max(...contexts.entries().map((context) => context.id)) + 2;
  const tally = {
    main: { failed: 0, forbidden: 0, forwarded: 0 },
    other: { failed: 0, forbidden: 0, forwarded: 0 },
  };
  const leaks: string[] = [];
  const reachedOutside: string[] = [];
  for (let contextId = 1; contextId <= highest; contextId += 1) {
    const kind = contexts.isMainWorld(contextId) ? "main" : "other";
    for (let object = 1; object <= 16; object += 1) {
      const objectId = `${prefix}.${contextId}.${object}`;
      const outcome = await attempt(
        agent,
        "Runtime.callFunctionOn",
        {
          functionDeclaration:
            "function(){return { privateSecret: globalThis.privateSecret ?? null, requireType: typeof require }}",
          objectId,
          returnByValue: true,
        },
        sessionId,
      );
      tally[kind][outcome.outcome] += 1;
      if (outcome.leaked?.length) leaks.push(objectId);
      if (kind === "other" && outcome.outcome !== "forbidden") reachedOutside.push(objectId);
    }
  }
  return {
    contexts: contexts.entries().map(({ id, mainWorld, description }) => ({
      id,
      mainWorld,
      name: description.name ?? "",
    })),
    highest,
    leaks,
    prefix,
    reachedOutside: reachedOutside.slice(0, 32),
    tally,
  };
}

function forgedHandlesRefused(forged: Awaited<ReturnType<typeof forgeHandles>>): boolean {
  return (
    forged.leaks.length === 0 &&
    forged.reachedOutside.length === 0 &&
    forged.tally.other.forbidden > 0 &&
    forged.tally.main.forwarded > 0
  );
}

class AgentCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Speaks to the controller as the Host's broker does for Browser Harness. */
function agentClient(controller: BrowserController, messages: readonly BrowserServerMessage[]) {
  return {
    async send(method: string, parameters?: CdpParameters, sessionId?: string): Promise<unknown> {
      const requestId = randomUUID();
      await controller.handle({
        command: {
          method,
          ...(parameters ? { parameters: { ...parameters } } : {}),
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
        throw new AgentCommandError(reply.error.code, reply.error.message);
      }
      if (reply?.type !== "cdp.result") throw new Error(`${method} was not answered.`);
      return reply.result;
    },
  };
}

function serveFixture(request: IncomingMessage, response: ServerResponse): void {
  const site = request.headers.host?.split(":", 1)[0];
  const cookie = request.headers.cookie ?? "";
  const html = (title: string, body = "") =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
  const sessionCookie = (name: string, value: string) =>
    `${name}=${value}; HttpOnly; Path=/; SameSite=Lax`;
  if (site === "site-b.test" && request.url === "/login") {
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": sessionCookie("session_b", secrets.sessionB),
      })
      .end(
        html(
          "Site B login",
          `<script>localStorage.setItem("token_b", ${JSON.stringify(secrets.storageB)})</script>`,
        ),
      );
    return;
  }
  if (site === "site-a.test" && request.url === "/login") {
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": [
          sessionCookie("session_a", secrets.sessionA),
          "visible_a=page-visible; Path=/; SameSite=Lax",
        ],
      })
      .end(html("Site A login"));
    return;
  }
  if (site === "site-b.test" && request.url === "/cors") {
    // Not the requesting origin: the page's fetch fails without seeing it.
    response
      .writeHead(200, {
        "access-control-allow-origin": secrets.corsHeader,
        "content-type": "text/plain; charset=utf-8",
      })
      .end("cross-origin body");
    return;
  }
  if (request.url === "/blank") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Blank"));
    return;
  }
  if (site === "site-a.test" && request.url === "/app") {
    // The page says whether the session arrived, never what it was.
    const signedIn =
      cookie.includes(`session_a=${secrets.sessionA}`) ||
      cookie.includes(`session_a=${secrets.rotatedSessionA}`);
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": sessionCookie("session_a", secrets.rotatedSessionA),
      })
      .end(
        html(
          "Site A app",
          `<body data-signed-in="${signedIn ? "yes" : "no"}">
<button id="count" style="position:fixed;left:20px;top:20px;width:160px;height:40px">Count</button>
<input id="name" style="position:fixed;left:20px;top:80px;width:200px;height:30px">
<input id="file" type="file" style="position:fixed;left:20px;top:130px">
<input id="hidden" type="file" style="display:none">
<button id="choose" style="position:fixed;left:20px;top:180px;width:160px;height:40px">Add file</button>
<script>
window.clicks = 0;
window.keys = [];
document.getElementById("name").addEventListener("keydown", (event) => { if (event.isTrusted) window.keys.push(event.key); });
document.getElementById("count").addEventListener("click", () => { window.clicks += 1; });
document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
console.log("site-a page ready");
</script>`,
        ),
      );
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

function foundSecrets(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  return Object.entries(secrets)
    .filter(([, secret]) => serialized.includes(secret))
    .map(([label]) => label);
}

function evaluationValue(value: unknown): unknown {
  return asRecord(asRecord(value).result).value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  await waitForAsync(async () => predicate(), timeoutMs);
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Electron CDP boundary condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function finish(error: unknown): void {
  if (error) report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const artifact = path.join(artifactDirectory, "electron.json");
  void mkdir(artifactDirectory, { recursive: true })
    .then(() => writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`))
    .finally(() => {
      finished = true;
      clearInterval(liveness);
      rmSync(userData, { recursive: true, force: true });
      if (error) {
        process.stderr.write(
          `${JSON.stringify({ artifact, error: report.error, event: "electron-cdp-boundary-smoke.failed" })}\n`,
        );
        app.exit(1);
      } else {
        process.stdout.write(
          `${JSON.stringify({ artifact, event: "electron-cdp-boundary-smoke.passed" })}\n`,
        );
        app.quit();
      }
    });
}
