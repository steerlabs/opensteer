/**
 * The menu bar app, in a real macOS session: the status item and its popover,
 * the person's Stop everything, this Mac's own Home and a Device Runner, the
 * quit question and the Dock. Each trial composes the production classes the
 * way main does, checks what it claims from inside Electron, writes evidence,
 * and exits 0 only when every check held. `test-electron-menu-bar.ts` drives
 * it; run it only in a disposable VM (`pnpm test:vm`).
 */
import { DeploymentCatalogSchema, DeploymentConnectionSchema } from "@opensteer/client/connections";
import { menuBarWords } from "@opensteer/client/computers";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { hostApi, hostApiVersionHeader } from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  screen,
  Tray,
  webContents,
} from "electron";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { installDesktopAppProtocol, registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { createDesktopApplicationMenu } from "../src/app/application-menu.js";
import { DesktopBackgroundMode } from "../src/app/background-mode.js";
import { DesktopShutdown } from "../src/app/desktop-shutdown.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { DesktopLocalStop, localStopFileStore } from "../src/app/local-stop.js";
import { DesktopMenuBar, menuBarGlyph, type MenuBarIcon } from "../src/app/menu-bar.js";
import { DesktopMenuBarService } from "../src/app/menu-bar-service.js";
import { DesktopQuitRouting, type QuitActions } from "../src/app/quit-routing.js";
import { parentedQuitQuestion, quitQuestionParentOptions } from "../src/app/quit-question.js";
import { AgentBrowserGate } from "../src/browser/agent-browser-gate.js";
import { createDesktopHostApi } from "../src/connections/desktop-host-api.js";
import { NativePersonalDeploymentCredentials } from "../src/secrets/personal-deployment-credentials.js";
import { NativePersonalDeploymentFilesystem } from "../src/secrets/personal-deployment-store.js";
import { startLocalBrowserRuntime } from "../src/supervisor/local-browser-runtime.js";
import { PersonalDeploymentSupervisor } from "../src/supervisor/personal-deployment-supervisor.js";
import { NativePersonalHostControl } from "../src/supervisor/personal-host-control.js";
import {
  NodePersonalProcessPort,
  readPersonalProcessSupervisorRelease,
} from "../src/supervisor/personal-process-port.js";
import { menuBarSmokeTrials } from "./menu-bar-smoke-plan.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";

const root = path.resolve(z.string().parse(process.env.OPENSTEER_MENU_BAR_E2E_DATA));
const trial = z.enum(menuBarSmokeTrials).parse(process.env.OPENSTEER_MENU_BAR_E2E_TRIAL);
/** The built desktop app beside the smoke bundle: its web UI and popover preload. */
const desktopDist = path.resolve(import.meta.dirname, "../dist");
configureDesktopApplicationPaths(app, root);
registerDesktopAppScheme(protocol);
app.on("window-all-closed", () => undefined);
const logPath = path.join(root, `${trial}.jsonl`);
const log = (event: string, fields: Readonly<Record<string, string | number | boolean>> = {}) =>
  appendFileSync(logPath, `${JSON.stringify({ event, ...fields, time: Date.now() })}\n`);
/** One claim held; the driver reads every one of these into the trial's result. */
const held = (claim: string, fields: Readonly<Record<string, string | number | boolean>> = {}) =>
  log("test.held", { claim, ...fields });
dialog.showErrorBox = (title, content) => log("test.modal", { title, content });

const shutdown = new DesktopShutdown({
  application: app,
  power: powerMonitor,
  log,
  hideWindow: () => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  },
});
const quitRouting = new DesktopQuitRouting({
  shutdown,
  confirm: parentedQuitQuestion({
    focus: () => app.focus({ steal: true }),
    createParent: () => new BrowserWindow(quitQuestionParentOptions(app.getName())),
    showMessageBox: (parent, options) => dialog.showMessageBox(parent as BrowserWindow, options),
  }),
  hideWindows: () => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  },
  log,
});
const installQuitMenu = (quit: QuitActions) =>
  Menu.setApplicationMenu(createDesktopApplicationMenu({ quit, workspaceContents: () => null }));
quitRouting.installAtReady(app, installQuitMenu);
const menuItem = (id: string) => {
  const found = Menu.getApplicationMenu()?.getMenuItemById(id);
  assert(found, `The app menu has no ${id} item`);
  return found;
};
const watchdog = setTimeout(() => {
  log("test.watchdog");
  shutdown.request("test-timeout");
}, 240_000);
// Cmd+Q before startup finishes has to be clickable before anything below runs.
if (trial === "early-quit")
  process.once("SIGUSR1", () => {
    menuItem("quit").click();
    log("test.quit-clicked");
  });
void run().catch((error: unknown) => {
  log("test.failed", {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  shutdown.request("test-failed");
});

async function waitFor(
  label: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(50);
  }
}

/** Ends a self-checking trial: every claim held, so the app quits cleanly. */
function passed(fields: Readonly<Record<string, string | number | boolean>> = {}): void {
  clearTimeout(watchdog);
  log("test.passed", fields);
  shutdown.request("test-complete");
}

async function run(): Promise<void> {
  await app.whenReady();
  installDesktopAppProtocol(protocol, path.join(desktopDist, "web"));
  switch (trial) {
    case "popover-phases":
      return popoverPhases();
    case "home-stop":
      return homeStop();
    case "quit-logout":
    case "quit-sigterm":
      return quitQuestion();
    case "early-quit":
      return earlyQuit();
    case "dock":
      return dock();
  }
}

/** The status item and its popover, as main builds them, with what they drew recorded. */
function statusItem(input: {
  readonly service: DesktopMenuBarService;
  readonly stop: () => Promise<void>;
  readonly resume: () => Promise<void>;
}) {
  let drawn: Buffer | null = null;
  let popover: BrowserWindow | null = null;
  const menuBar = new DesktopMenuBar({
    service: input.service,
    actions: {
      stop: input.stop,
      resume: input.resume,
      setOpenAtLogin: async () => undefined,
      openApp: async () => undefined,
      openRow: async () => undefined,
      openNeedsYou: async () => undefined,
      openSettings: async () => undefined,
      quitCompletely: async () => undefined,
    },
    ipcMain,
    screen,
    createTray: (image) => new Tray(image),
    createImage: (bitmap, scaleFactor) => {
      drawn = Buffer.from(bitmap);
      return nativeImage.createFromBitmap(bitmap, { width: 32, height: 32, scaleFactor });
    },
    createWindow: (options) => {
      popover = new BrowserWindow(options);
      return popover;
    },
    webPreferences: {
      ...desktopWebPreferences(
        { mode: "development" },
        randomUUID(),
        path.join(desktopDist, "menu-bar-preload.cjs"),
      ),
      additionalArguments: [],
    },
    log,
  });
  shutdown.add({
    component: "menu-bar",
    step: "dispose",
    order: 80,
    timeoutMs: 1_000,
    stop: () => menuBar.dispose(),
  });
  const window = () => {
    assert(popover && !popover.isDestroyed(), "The popover window is gone");
    return popover;
  };
  const text = async () =>
    z.string().parse(await window().webContents.executeJavaScript("document.body.innerText"));
  const buttons = async () =>
    z
      .array(z.string())
      .parse(
        await window().webContents.executeJavaScript(
          "[...document.querySelectorAll('button')].map((button) => button.textContent.trim())",
        ),
      );
  const click = async (selector: string) =>
    assert.equal(
      await window().webContents.executeJavaScript(
        `(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target) return false; target.click(); return true; })()`,
      ),
      true,
      `Nothing to click at ${selector}`,
    );
  /** The status item shows exactly this glyph: the bitmap main last drew. */
  const shows = (icon: MenuBarIcon) => drawn !== null && drawn.equals(menuBarGlyph(32, icon));
  const capture = async (name: string) =>
    writeFileSync(
      path.join(root, `${trial}-${name}.png`),
      (await window().webContents.capturePage()).toPNG(),
    );
  return { menuBar, window, text, buttons, click, shows, capture };
}

const plain: MenuBarIcon = { attention: false, unreachable: false, stopped: false };
const stoppedIcon: MenuBarIcon = { ...plain, stopped: true };

/**
 * Stop everything through the popover, with one part held and one failing
 * once: stopping offers nothing; a Stop that did not finish never says
 * stopped and offers Stop everything, not Resume; the retry stops; Resume
 * returns. The status item follows with the popover closed.
 */
async function popoverPhases(): Promise<void> {
  const release = Promise.withResolvers<void>();
  let holds = true;
  let failures = 1;
  const localStop = new DesktopLocalStop({
    restart: async () => {
      if (holds) await release.promise;
      if (failures-- > 0)
        throw new Error("Couldn't confirm that one device connection on this Mac stopped.");
    },
    store: localStopFileStore(path.join(root, "local-stop.json")),
    log,
  });
  await localStop.restore();
  const service = new DesktopMenuBarService({
    hostedHome: async () => null,
    deviceHomes: async () => [],
    selected: () => null,
    host: () => {
      throw new Error("This trial reads no Home");
    },
    local: () => ({ apps: [], tabs: [] }),
    stop: () => ({
      phase: localStop.phase,
      stoppedAt: localStop.stoppedAt,
      problem: localStop.problem,
      confirming: localStop.confirming,
      confirmOverdue: localStop.confirmOverdue,
    }),
    openAtLogin: async () => ({ on: false, available: false }),
    log,
  });
  localStop.subscribe(() => service.changed());
  const item = statusItem({
    service,
    stop: () => localStop.stop(),
    resume: () => localStop.resume(),
  });
  item.menuBar.start();
  await waitFor("the status item's first glyph", () => item.shows(plain));
  held("status-item-plain-at-start");

  await item.menuBar.open();
  await waitFor("Stop everything", async () =>
    (await item.text()).includes(menuBarWords("menubar.stopAll")),
  );
  await item.capture("running");
  await item.click(".menu-bar__stop-all");
  await waitFor("stopping", async () =>
    (await item.text()).includes(menuBarWords("menubar.stopping")),
  );
  const whileStopping = await item.buttons();
  assert(!whileStopping.includes(menuBarWords("menubar.resume")), "Resume offered mid-Stop");
  assert(!whileStopping.includes(menuBarWords("menubar.stopAll")), "Stop offered mid-Stop");
  assert(!(await item.text()).includes("Stopped everything"), "Said stopped mid-Stop");
  await item.capture("stopping");
  held("stopping-offers-nothing");
  item.window().hide();
  await waitFor("the stopped glyph with the popover closed", () => item.shows(stoppedIcon));
  held("status-item-stopped-with-popover-closed");

  release.resolve();
  holds = false;
  await item.menuBar.open();
  await waitFor("the failed Stop", async () =>
    (await item.text()).includes(
      "Couldn't confirm that one device connection on this Mac stopped.",
    ),
  );
  const afterFailure = await item.buttons();
  assert(
    afterFailure.includes(menuBarWords("menubar.resume")),
    "No Resume after the stopped worker booted",
  );
  assert(
    !(await item.text()).includes("Stopped everything"),
    "Claimed all work stopped without proof",
  );
  await item.capture("failed");
  held("unconfirmed-stop-offers-resume");
  await item.click(".menu-bar__resume");
  await waitFor("running again before another Stop", async () =>
    (await item.text()).includes(menuBarWords("menubar.stopAll")),
  );

  await item.click(".menu-bar__stop-all");
  await waitFor("stopped", async () =>
    (await item.text()).includes("Stopped everything on this Mac at"),
  );
  assert((await item.buttons()).includes(menuBarWords("menubar.resume")));
  await item.capture("stopped");
  held("retry-stops-and-offers-resume");

  await item.click(".menu-bar__resume");
  await waitFor("running again", async () =>
    (await item.text()).includes(menuBarWords("menubar.stopAll")),
  );
  item.window().hide();
  await waitFor("the plain glyph with the popover closed", () => item.shows(plain));
  held("resume-returns-and-status-item-follows");
  passed();
}

/** This Mac's own Home and its hosted Runner, as `PersonalDeploymentSupervisor` runs them. */
async function startHome(input: {
  readonly agentsStoppedSince: () => string | null;
  readonly gate: AgentBrowserGate;
}) {
  const resources = path.resolve(z.string().parse(process.env.OPENSTEER_PERSONAL_E2E_RESOURCES));
  const keyPath = path.join(root, "test-key");
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const encryptionKey = readFileSync(keyPath);
  const temporary = path.join(root, "temporary-runtime");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const network = new ElectronHostNetwork();
  const files = new NativePersonalDeploymentFilesystem({ dataDirectory: root });
  const processes = new NodePersonalProcessPort({
    logsDirectory: path.join(root, "logs"),
    supervisorExecutable: readPersonalProcessSupervisorRelease(resources),
  });
  const environment = { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: temporary };
  const engineFixture = path.join(resources, "codex-fixture", "fake-codex-app-server.mjs");
  const engineWrapper = path.join(root, "codex-fixture");
  const engineRelease = path.join(root, "release-fixture-turn");
  const engineHarnessLog = path.join(root, "logs", "codex-browser-harness.jsonl");
  const shellArgument = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const supervisor = new PersonalDeploymentSupervisor({
    agentsStoppedSince: input.agentsStoppedSince,
    log,
    catalog: {
      upsertAndSelect: async (value) => ({
        deployments: [
          DeploymentConnectionSchema.parse({
            ...value,
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ],
        selectedDeploymentId: value.authority.document.deploymentId,
        revision: 1,
        schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
        updatedAt: new Date().toISOString(),
      }),
    },
    credentials: new NativePersonalDeploymentCredentials({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "e2e-aes-gcm",
      encryptStringAsync: async (plainText) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
        const bytes = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      },
      decryptStringAsync: async (encrypted) => {
        const cipher = createDecipheriv("aes-256-gcm", encryptionKey, encrypted.subarray(0, 12));
        cipher.setAuthTag(encrypted.subarray(12, 28));
        return {
          result: Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]).toString(
            "utf8",
          ),
          shouldReEncrypt: false,
        };
      },
    }),
    files,
    host: new NativePersonalHostControl({
      fetch: (id, url, init) => network.partitionFetch(id, url, init),
    }),
    localRuntimes: {
      startBrowser: async (browserInput) => {
        const browser = await startLocalBrowserRuntime({
          agentGate: input.gate,
          downloads: smokeDesktopDownloads(),
          profileRoot: browserInput.paths.browserProfileRoot,
          runtimeId: browserInput.runtimeId,
          logPath: path.join(root, "logs", "personal-browser.log"),
          pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
        });
        return { ...browser, stop: async (signal) => browser.stop(signal) };
      },
    },
    processes: {
      run: (spec, options) => processes.run(spec, options),
      spawn: (spec) => {
        if (spec.component !== "runner") return processes.spawn(spec);
        const node = z.string().parse(spec.environment.OPENSTEER_NODE_EXECUTABLE);
        writeFileSync(
          engineWrapper,
          `#!/bin/sh
export FAKE_CODEX_HARNESS_LOG=${shellArgument(engineHarnessLog)}
exec ${shellArgument(node)} ${shellArgument(engineFixture)} --scenario=long-stream-held --unique-threads ${shellArgument(`--release-file=${engineRelease}`)} "$@"
`,
          { mode: 0o700 },
        );
        return processes.spawn({
          ...spec,
          environment: { ...spec.environment, OPENSTEER_CODEX_EXECUTABLE: engineWrapper },
        });
      },
    },
    baseEnvironment: environment,
    userEnvironment: { resolve: async () => environment },
    releaseDirectory: path.join(resources, "personal-runtime"),
  });
  shutdown.signal.addEventListener("abort", () => supervisor.quiesce(), { once: true });
  shutdown.add({
    component: "personal",
    step: "stop",
    order: 40,
    timeoutMs: 24_000,
    stop: (signal) => supervisor.stop(signal),
  });
  await supervisor.start();
  const manifest = await files.load();
  assert(manifest);
  const origin = `http://127.0.0.1:${manifest.hostPort}`;
  const fetch = (url: URL | RequestInfo, init: RequestInit) =>
    network.partitionFetch(manifest.deploymentId, url, init);
  const host = createDesktopHostApi({ origin, fetch });
  const rpc = async (method: string, body?: object) => {
    const read = Object.entries(hostApi).some(
      ([name, declaration]) => name === method && declaration.method === "GET",
    );
    const response = await fetch(
      `${origin}/v1/rpc/${method}${read ? `?input=${encodeURIComponent(JSON.stringify(body ?? {}))}` : ""}`,
      {
        method: read ? "GET" : "POST",
        headers: {
          [hostApiVersionHeader]: String(hostApiVersion),
          origin,
          "content-type": "application/json",
        },
        ...(!read && body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return z.object({ ok: z.literal(true), data: z.unknown() }).parse(result).data;
  };
  const runtime = await supervisor.current();
  assert(runtime);
  return { fetch, host, manifest, network, origin, rpc, supervisor };
}

/**
 * Stop everything on the Mac hosting its own Personal Home (the shipped path,
 * where `LocalRunnerAuthority` never attaches a separate Device Runner to this
 * Mac's own Home and Stop acts on the Home's own Runner via
 * `PersonalDeploymentSupervisor.restartForAgentMode()`):
 * - an active Run and agent browser tab both stop;
 * - the confirmed Stop time appears only after the Runner finishes restarting;
 * - the person's own tab keeps its exact page instance and form text across Stop and Resume;
 * - an open live Watch view reconnects by itself across Stop;
 * - Resume continues held work while a manually paused queue stays paused;
 * - double Stop and rapid Stop-then-Resume settle cleanly.
 */
async function homeStop(): Promise<void> {
  const gate = new AgentBrowserGate();
  const stopFile = path.join(root, "local-stop.json");
  let restartInFlight = false;
  let restartCompleted = 0;
  let prematureConfirmedStop = false;
  let startedHome: Awaited<ReturnType<typeof startHome>> | null = null;
  const localStop = new DesktopLocalStop({
    restart: async () => {
      restartInFlight = true;
      try {
        await home.supervisor.restartForAgentMode();
        restartCompleted += 1;
      } finally {
        restartInFlight = false;
      }
    },
    confirm: (stoppedSince, signal) =>
      startedHome
        ? startedHome.supervisor.waitForStopProof(stoppedSince, signal)
        : Promise.resolve(),
    store: localStopFileStore(stopFile),
    log,
  });
  shutdown.signal.addEventListener("abort", () => localStop.dispose(), { once: true });
  localStop.subscribe(() => {
    if (restartInFlight && (localStop.stoppedAt !== null || localStop.phase === "stopped")) {
      prematureConfirmedStop = true;
    }
  });
  await localStop.restore();
  const home = await startHome({ agentsStoppedSince: () => localStop.agentsStoppedSince, gate });
  startedHome = home;
  assert.equal(localStop.phase, "running");
  const homeRunnerId = home.manifest.runnerId;

  // The person's own tab (with a form input and page-instance nonce), and an agent page URL.
  const pages = createServer((request, response) => {
    if (request.url === "/agent") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>Agent tab</title><p>Agent work</p>");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        '<!doctype html><title>Person\'s tab</title><p>Kept through Stop</p><input id="person-note" type="text" value="" /><script>window.__personPageId = Math.random().toString(36).slice(2);</script>',
      );
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  shutdown.add({
    component: "test-page",
    step: "close",
    order: 85,
    timeoutMs: 1_000,
    stop: () => {
      pages.closeAllConnections();
      pages.close();
    },
  });
  const address = pages.address();
  assert(address && typeof address !== "string");
  const pageUrl = `http://127.0.0.1:${address.port}/person`;
  const agentPageUrl = `http://127.0.0.1:${address.port}/agent`;

  // Real HttpHostClient opens, activates and watches the person's tab the way the product does.
  let personSessionId: string | null = null;
  let liveViewSocketsOpened = 0;
  let liveViewSnapshots = 0;
  const liveClient = new HttpHostClient({
    baseUrl: home.origin,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", home.origin);
      return home.fetch(input, { ...init, headers });
    },
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 500,
    webSocketFactory: (url): WebSocketClient => {
      const isBrowserWatch =
        personSessionId !== null && url.includes(`/v1/browser-sessions/${personSessionId}/connect`);
      if (isBrowserWatch) liveViewSocketsOpened += 1;
      let readyState = 0;
      const listeners = new Map<string, Set<(event: unknown) => void>>();
      const emit = (type: string, event: unknown) => {
        for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
      };
      const socket = home.network.openWebSocket(
        {
          canonicalOrigin: home.origin,
          deploymentId: home.manifest.deploymentId,
          url,
          authorization: null,
          requestOrigin: home.origin,
        },
        {
          open: () => {
            readyState = 1;
            emit("open", {});
          },
          message: (data) => {
            if (isBrowserWatch && typeof data === "string") {
              try {
                if ((JSON.parse(data) as { type?: string }).type === "browser.snapshot") {
                  liveViewSnapshots += 1;
                }
              } catch {
                // Ignore malformed non-JSON frame here; client validates it.
              }
            }
            const payload =
              typeof data === "string"
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            emit("message", { data: payload });
          },
          error: () => {
            emit("error", {});
          },
          close: (code, reason) => {
            readyState = 3;
            emit("close", { code, reason });
          },
        },
      );
      return {
        binaryType: "arraybuffer",
        get readyState() {
          return readyState;
        },
        addEventListener(type, listener, options) {
          let set = listeners.get(type);
          if (!set) {
            set = new Set();
            listeners.set(type, set);
          }
          const wrapped = options?.once
            ? (event: unknown) => {
                set!.delete(wrapped);
                (listener as (event: unknown) => void)(event);
              }
            : (listener as (event: unknown) => void);
          set.add(wrapped);
        },
        close(code, reason) {
          readyState = 3;
          socket.close(code, reason);
        },
        send(data) {
          if (typeof data === "string") socket.send(data);
          else if (ArrayBuffer.isView(data))
            socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          else if (data instanceof ArrayBuffer) socket.send(new Uint8Array(data));
        },
      };
    },
  });
  let releaseLiveView: (() => void) | null = null;
  let unsubscribeLiveViewFrames: (() => void) | null = null;
  shutdown.add({
    component: "live-watch",
    step: "close",
    order: 20,
    timeoutMs: 2_000,
    stop: () => {
      unsubscribeLiveViewFrames?.();
      releaseLiveView?.();
      liveClient.dispose();
    },
  });
  await liveClient.load();
  const openedTab = await liveClient.openTab({
    kind: "page",
    url: pageUrl,
    guest: true,
  });
  const viewer = await liveClient.activateTab(openedTab.tabId);
  assert.equal(viewer.kind, "page", "Person tab did not activate as a page viewer");
  const session = { id: viewer.sessionId };
  personSessionId = session.id;
  const personSurfaceId = openedTab.tabId;
  await waitFor("the person's tab", () =>
    webContents.getAllWebContents().some((contents) => contents.getURL() === pageUrl),
  );
  const personTab = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === pageUrl)!;
  const typedNote = "kept-across-stop";
  const initialPageId = z
    .string()
    .min(1)
    .parse(
      await personTab.executeJavaScript(
        `(() => { const el = document.getElementById("person-note"); el.focus(); el.value = ${JSON.stringify(typedNote)}; el.dispatchEvent(new Event("input", { bubbles: true })); return window.__personPageId; })()`,
      ),
    );
  const assertPersonTabIntact = async (stage: string) => {
    assert(
      !personTab.isDestroyed() && personTab.getURL() === pageUrl,
      `The person's tab closed (${stage})`,
    );
    const state = z
      .object({ pageId: z.string(), value: z.string() })
      .parse(
        await personTab.executeJavaScript(
          `({ pageId: String(window.__personPageId ?? ""), value: String(document.getElementById("person-note")?.value ?? "") })`,
        ),
      );
    assert.equal(state.pageId, initialPageId, `The person's tab reloaded (${stage})`);
    assert.equal(state.value, typedNote, `The person's form text changed (${stage})`);
  };
  let lastAckedWatchToken: string | null = null;
  const acknowledgeLiveViewFrame = () => {
    const token = liveClient.browserWatchFrames.get(session.id, personSurfaceId)?.header.watchToken;
    if (token && token !== lastAckedWatchToken) {
      lastAckedWatchToken = token;
      liveClient.acceptBrowserWatchFrame(session.id, token, personSurfaceId);
    }
  };
  unsubscribeLiveViewFrames = liveClient.browserWatchFrames.subscribe(
    session.id,
    acknowledgeLiveViewFrame,
    personSurfaceId,
  );
  releaseLiveView = liveClient.retainBrowserWatch(session.id, personSurfaceId);
  acknowledgeLiveViewFrame();
  await waitFor(
    "live view admitted before Stop",
    () =>
      liveClient.browserWatchState(session.id, personSurfaceId).admitted === true &&
      liveViewSnapshots >= 1,
    30_000,
  );
  held("person-tab-live-view-open-before-stop", {
    socketsOpened: liveViewSocketsOpened,
    snapshots: liveViewSnapshots,
  });

  const harnessDetailSchema = z.object({
    data: z.object({
      kind: z.literal("harness"),
      harnesses: z.array(
        z.object({ id: z.string(), driverKind: z.string(), environmentId: z.string() }),
      ),
    }),
  });
  const harnessCatalogDetailSchema = z.object({
    data: z.object({
      kind: z.literal("harness-catalog"),
      environments: z.array(
        z.object({
          id: z.string(),
          harnessCatalogs: z.array(z.object({ harnessInstanceId: z.string(), status: z.string() })),
        }),
      ),
    }),
  });
  let codex:
    | { readonly id: string; readonly driverKind: string; readonly environmentId: string }
    | undefined;
  await waitFor(
    "the fixture engine and its model catalog",
    async () => {
      const harnesses = harnessDetailSchema.parse(
        await home.rpc("resources.detail.get", { kind: "harness" }),
      );
      codex = harnesses.data.harnesses.find(
        (harness) =>
          harness.driverKind === "codex" && harness.environmentId === home.manifest.environmentId,
      );
      if (!codex) return false;
      const catalogs = harnessCatalogDetailSchema.parse(
        await home.rpc("resources.detail.get", { kind: "harness-catalog" }),
      );
      const environment = catalogs.data.environments.find(
        (entry) => entry.id === home.manifest.environmentId,
      );
      return (
        environment?.harnessCatalogs.some(
          (entry) => entry.harnessInstanceId === codex!.id && entry.status === "ready",
        ) === true
      );
    },
    30_000,
  );
  assert(codex, "The Home did not expose the fixture engine");
  const fixtureHarness = codex;
  const createTask = async (title: string) =>
    z.object({ thread: z.object({ id: z.string() }) }).parse(
      await home.rpc("commands.dispatch", {
        type: "thread.create",
        idempotencyKey: randomUUID(),
        environmentId: home.manifest.environmentId,
        harnessInstanceId: fixtureHarness.id,
        modelSelection: {
          modelId: "gpt-5.6-sol",
          providerId: "openai",
          options: { effort: "low" },
        },
        title,
      }),
    ).thread;
  const sendTo = async (threadId: string, text: string) =>
    z.object({ run: z.object({ id: z.string() }).nullable() }).parse(
      await home.rpc("commands.dispatch", {
        type: "thread.sendMessage",
        idempotencyKey: randomUUID(),
        delivery: "queue",
        threadId,
        content: [{ type: "text", text }],
      }),
    );
  const taskStateFor = async (threadId: string) =>
    z
      .object({
        tasks: z.array(
          z.object({ id: z.string(), status: z.string(), failurePreview: z.string().nullable() }),
        ),
      })
      .parse(await home.rpc("personal.shell.get"))
      .tasks.find((entry) => entry.id === threadId);
  const runItemFor = async (threadId: string, runId: string) =>
    z
      .object({
        items: z.array(
          z
            .object({
              kind: z.string(),
              runId: z.string().nullable().optional(),
              view: z.object({ status: z.string().optional() }).passthrough().optional(),
              failure: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
            })
            .passthrough(),
        ),
      })
      .parse(await home.rpc("thread.snapshot.get", { threadId }))
      .items.find((entry) => entry.kind === "run" && entry.runId === runId);

  // Task 1: active Run + agent browser tab in use + follow-up queued to resume after Stop.
  const task = await createTask("Stop journey task");
  const taskState = () => taskStateFor(task.id);
  const firstRun = await sendTo(task.id, `Keep working until Stop\nAGENT_TAB_URL=${agentPageUrl}`);
  assert(firstRun.run, "Stop journey task did not start an initial run");
  const stoppedRunId = firstRun.run.id;
  await waitFor(
    "the task running before Stop",
    async () => (await taskState())?.status === "running",
  );
  await waitFor("the agent browser tab in use before Stop", () => gate.agentTabs > 0, 30_000).catch(
    (error: unknown) => {
      const harnessLogPath = path.join(root, "logs", "codex-browser-harness.jsonl");
      if (existsSync(harnessLogPath)) {
        log("test.agent-tab-diagnostic", {
          harnessLog: readFileSync(harnessLogPath, "utf8").trim(),
        });
      }
      throw error;
    },
  );
  await sendTo(task.id, "Continue once this Mac resumes");
  held("task-and-agent-browser-tab-in-use-before-stop", { agentTabs: gate.agentTabs });

  // Task 2: a queue the person manually paused before Stop must stay paused after Resume.
  const pausedTask = await createTask("Manually paused queue task");
  const pausedFirst = await sendTo(pausedTask.id, "Pause this task before Stop");
  assert(pausedFirst.run, "Paused task did not start an initial run");
  await waitFor(
    "paused task running before manual interrupt",
    async () => (await taskStateFor(pausedTask.id))?.status === "running",
  );
  await sendTo(pausedTask.id, "Stay paused after Resume");
  await home.rpc("commands.dispatch", {
    type: "run.interrupt",
    idempotencyKey: randomUUID(),
    threadId: pausedTask.id,
    runId: pausedFirst.run.id,
  });
  await waitFor(
    "manually paused task interrupted before Stop",
    async () => (await taskStateFor(pausedTask.id))?.status !== "running",
  );
  held("manually-paused-queue-ready-before-stop");

  const service = new DesktopMenuBarService({
    hostedHome: async () => ({
      deploymentId: home.manifest.deploymentId,
      name: "Smoke Home",
      state: home.supervisor.status.state,
      runnerId: home.manifest.runnerId,
    }),
    deviceHomes: async () => [],
    selected: () => ({ deploymentId: home.manifest.deploymentId, devicesAvailable: true }),
    host: () => home.host,
    local: () => ({
      apps: [],
      tabs: gate.agentTabDetails(),
      runs: [],
    }),
    stop: () => ({
      phase: localStop.phase,
      stoppedAt: localStop.stoppedAt,
      problem: localStop.problem,
      confirming: localStop.confirming,
      confirmOverdue: localStop.confirmOverdue,
    }),
    openAtLogin: async () => ({ on: false, available: false }),
    log,
  });
  localStop.subscribe(() => service.changed());
  const item = statusItem({
    service,
    stop: () => localStop.stop(),
    resume: () => localStop.resume(),
  });
  item.menuBar.start();
  await item.menuBar.open();
  await waitFor("Stop everything", async () =>
    (await item.text()).includes(menuBarWords("menubar.stopAll")),
  );
  const stoppedMenuReady = async () => {
    const text = await item.text();
    return (
      text.includes(menuBarWords("menubar.resume")) &&
      (text.includes(menuBarWords("menubar.stopped.waiting")) ||
        text.includes("Stopped everything on this Mac at"))
    );
  };
  const restartsBeforeStop = restartCompleted;
  const stopStarted = performance.now();
  await item.click(".menu-bar__stop-all");
  await waitFor("stopped state with Resume offered", stoppedMenuReady);
  const firstLocalStopMs = Math.round(performance.now() - stopStarted);
  await waitFor(
    "stopped timestamp confirmed",
    async () => (await item.text()).includes("Stopped everything on this Mac at"),
    30_000,
  );
  const firstConfirmTotalMs = Math.round(performance.now() - stopStarted);
  const firstHomeConfirmAfterLocalMs = Math.max(0, firstConfirmTotalMs - firstLocalStopMs);
  assert(
    !prematureConfirmedStop,
    "Confirmed Stop time appeared before Runners finished restarting",
  );
  assert(
    restartCompleted > restartsBeforeStop && localStop.stoppedAt !== null,
    "Confirmed Stop time appeared without restart proof",
  );
  log("test.stop-confirmation-timing", {
    stage: "first-stop",
    totalMs: firstConfirmTotalMs,
    localStopMs: firstLocalStopMs,
    homeConfirmAfterLocalMs: firstHomeConfirmAfterLocalMs,
  });
  process.stdout.write(
    `home-stop confirmation (first-stop): total=${firstConfirmTotalMs}ms local=${firstLocalStopMs}ms afterLocal=${firstHomeConfirmAfterLocalMs}ms\n`,
  );
  held("stop-everything-confirmed-after-proof", {
    phase: localStop.phase,
    elapsedMs: firstConfirmTotalMs,
    localStopMs: firstLocalStopMs,
    homeConfirmAfterLocalMs: firstHomeConfirmAfterLocalMs,
  });
  await waitFor("agent browser tabs cleared after Stop", () => gate.agentTabs === 0, 15_000);
  held("agent-browser-tab-stopped");

  const machines = async () =>
    z
      .object({
        machines: z.array(
          z
            .object({
              selfRunnerId: z.string().nullable().optional(),
              status: z.string(),
              agentsStoppedSince: z.string().nullable().optional(),
            })
            .passthrough(),
        ),
      })
      .parse(await home.rpc("machines.list")).machines;
  const row = async (runnerId: string) =>
    (await machines()).find((machine) => machine.selfRunnerId === runnerId);
  await waitFor(
    "the Home showing this Mac stopped",
    async () => Boolean((await row(home.manifest.runnerId))?.agentsStoppedSince),
    30_000,
  );
  held("home-shows-its-own-mac-stopped");
  await waitFor("the Home identifying the old Run as stopped", async () => {
    const run = await runItemFor(task.id, stoppedRunId);
    return (
      run?.view?.status === "failed" &&
      run.failure?.code === "computer_stopped" &&
      run.failure.message.includes("Stopped on")
    );
  });
  await waitFor(
    "the Home showing this Mac stopped while its Runner stays online",
    async () => {
      const self = await row(homeRunnerId);
      return Boolean(self?.agentsStoppedSince) && self?.status === "online";
    },
    30_000,
  );
  held("home-shows-the-device-stopped-not-offline");
  if (item.window().isVisible()) item.window().hide();
  await item.menuBar.open();
  await waitFor(
    "the Home's confirmation",
    async () =>
      (await item.text()).includes(
        menuBarWords("menubar.stopped.confirmed", { home: "Smoke Home" }),
      ),
    30_000,
  );
  await item.capture("stopped-confirmed");
  held("popover-says-the-home-confirms");
  await assertPersonTabIntact("after-stop");
  held("person-tab-form-kept-through-stop");
  // Kept-open live view must recover/stay live on its own without manual reopen.
  await waitFor(
    "live view self-reconnected while stopped",
    () => {
      const state = liveClient.browserWatchState(session.id, personSurfaceId);
      return state.admitted === true && state.error === null;
    },
    30_000,
  );
  held("live-view-reconnected-across-stop", {
    socketsOpened: liveViewSocketsOpened,
    snapshots: liveViewSnapshots,
  });

  await item.click(".menu-bar__resume");
  await waitFor(
    "the Home clearing this Mac's Stop",
    async () => !(await row(home.manifest.runnerId))?.agentsStoppedSince,
    30_000,
  );
  await waitFor(
    "this Mac's Runner back online",
    async () => {
      const self = await row(homeRunnerId);
      return !self?.agentsStoppedSince && self?.status === "online";
    },
    60_000,
  );
  held("resume-clears-the-home-line");
  await waitFor(
    "the queued task running after Resume",
    async () => (await taskState())?.status === "running",
  );
  held("queued-task-runs-after-resume");
  await delay(1_500);
  assert.notEqual(
    (await taskStateFor(pausedTask.id))?.status,
    "running",
    "A queue the person paused resumed automatically after Stop/Resume",
  );
  held("manually-paused-queue-stays-paused");
  await assertPersonTabIntact("after-resume");
  await waitFor(
    "live view admitted after Resume",
    () => {
      const state = liveClient.browserWatchState(session.id, personSurfaceId);
      return state.admitted === true && state.error === null;
    },
    30_000,
  );
  held("person-tab-watched-after-resume");

  // Rapid Stop pressed twice must settle cleanly as stopped with no error.
  if (!item.window().isVisible()) await item.menuBar.open();
  const doubleStopStarted = performance.now();
  await Promise.all([localStop.stop(), localStop.stop()]);
  assert.equal(localStop.phase, "stopped", "Double Stop did not settle as stopped");
  assert.equal(localStop.stopped, true);
  await waitFor("double Stop showing stopped state with Resume offered", stoppedMenuReady);
  const doubleLocalStopMs = Math.round(performance.now() - doubleStopStarted);
  await waitFor(
    "double Stop Home confirmation",
    async () =>
      localStop.stoppedAt !== null &&
      (await item.text()).includes("Stopped everything on this Mac at"),
    30_000,
  );
  const doubleConfirmTotalMs = Math.round(performance.now() - doubleStopStarted);
  const doubleHomeConfirmAfterLocalMs = Math.max(0, doubleConfirmTotalMs - doubleLocalStopMs);
  log("test.stop-confirmation-timing", {
    stage: "double-stop",
    totalMs: doubleConfirmTotalMs,
    localStopMs: doubleLocalStopMs,
    homeConfirmAfterLocalMs: doubleHomeConfirmAfterLocalMs,
  });
  process.stdout.write(
    `home-stop confirmation (double-stop): total=${doubleConfirmTotalMs}ms local=${doubleLocalStopMs}ms afterLocal=${doubleHomeConfirmAfterLocalMs}ms\n`,
  );
  assert.equal(localStop.problem, null, `Double Stop reported a problem: ${localStop.problem}`);
  await waitFor(
    "Home confirming double Stop",
    async () => Boolean((await row(home.manifest.runnerId))?.agentsStoppedSince),
    30_000,
  );
  await assertPersonTabIntact("after-double-stop");
  await waitFor(
    "live view admitted after double Stop",
    () => {
      const state = liveClient.browserWatchState(session.id, personSurfaceId);
      return state.admitted === true && state.error === null;
    },
    30_000,
  );
  held("double-stop-idempotent", {
    elapsedMs: doubleConfirmTotalMs,
    localStopMs: doubleLocalStopMs,
    homeConfirmAfterLocalMs: doubleHomeConfirmAfterLocalMs,
  });

  // Resume cleanly, then trigger Stop and Resume quickly without awaiting Stop.
  await localStop.resume();
  await waitFor(
    "Home clearing Stop before rapid Stop+Resume",
    async () => !(await row(home.manifest.runnerId))?.agentsStoppedSince,
    30_000,
  );
  const rapidStop = localStop.stop();
  const rapidResume = localStop.resume();
  await Promise.all([rapidStop, rapidResume]);
  assert.equal(localStop.phase, "running", "Rapid Stop then Resume did not settle as running");
  assert.equal(localStop.stopped, false);
  assert.equal(
    localStop.problem,
    null,
    `Rapid Stop then Resume reported a problem: ${localStop.problem}`,
  );
  await waitFor(
    "Home clearing rapid Stop+Resume",
    async () => !(await row(home.manifest.runnerId))?.agentsStoppedSince,
    30_000,
  );
  await waitFor(
    "this Mac's Runner online after rapid Stop+Resume",
    async () => {
      const self = await row(homeRunnerId);
      return !self?.agentsStoppedSince && self?.status === "online";
    },
    60_000,
  );
  await assertPersonTabIntact("after-rapid-stop-resume");
  await waitFor(
    "live view admitted after rapid Stop+Resume",
    () => {
      const state = liveClient.browserWatchState(session.id, personSurfaceId);
      return state.admitted === true && state.error === null;
    },
    30_000,
  );
  held("stop-then-resume-quickly");
  passed({ runnerId: homeRunnerId });
}

/**
 * Quit Opensteer Completely's question, as a sheet on its own parent, open
 * when macOS logs out (SIGUSR2 stands for the system's shutdown notice) or a
 * SIGTERM arrives: the question goes away unanswered and the app shuts down.
 */
async function quitQuestion(): Promise<void> {
  app.setActivationPolicy("accessory");
  const background = new DesktopBackgroundMode({
    shutdown,
    window: { hide: () => undefined },
    notice: {
      seen: async () => true,
      markSeen: async () => undefined,
      show: () => undefined,
    },
    work: async () => ({ known: true, hostsHome: true, deviceHomes: [], lines: [] }),
    confirm: parentedQuitQuestion({
      focus: () => app.focus({ steal: true }),
      createParent: () => new BrowserWindow(quitQuestionParentOptions("Opensteer Menu Bar Smoke")),
      showMessageBox: (parent, options) => dialog.showMessageBox(parent as BrowserWindow, options),
      shown: () => log("test.question-shown"),
    }),
    log,
  });
  quitRouting.attach(background);
  if (trial === "quit-logout") process.once("SIGUSR2", () => powerMonitor.emit("shutdown"));
  process.once("SIGUSR1", () => menuItem("quit-completely").click());
  clearTimeout(watchdog);
  log("test.ready");
}

/**
 * Cmd+Q while the app is still starting puts its windows away and never runs
 * the full shutdown; once started it keeps serving from the menu bar.
 */
async function earlyQuit(): Promise<void> {
  const window = new BrowserWindow({ show: true, width: 480, height: 320 });
  await window.loadURL("data:text/html,<title>Starting</title><p>Starting…</p>");
  log("test.starting");
  await waitFor("Cmd+Q during startup", () => quitRouting.quitBeforeStart, 30_000);
  assert(!shutdown.requested, "Cmd+Q during startup ran the full shutdown");
  assert(!window.isVisible(), "Cmd+Q during startup left the window showing");
  held("quit-during-startup-puts-windows-away");
  // Startup finishes: the menu bar app takes over and stays.
  const background = new DesktopBackgroundMode({
    shutdown,
    window: { hide: () => window.hide() },
    notice: { seen: async () => true, markSeen: async () => undefined, show: () => undefined },
    work: async () => ({ known: true, hostsHome: false, deviceHomes: [], lines: [] }),
    confirm: async () => false,
    log,
  });
  quitRouting.attach(background);
  await delay(2_000);
  assert(!shutdown.requested, "The app quit after startup");
  held("still-running-after-startup");
  passed();
}

/**
 * The Dock icon goes when the window does, and stays gone after a reopen and
 * close too quick for Electron to honour the hide the first time.
 */
async function dock(): Promise<void> {
  app.setActivationPolicy("regular");
  const window = new BrowserWindow({ show: true, width: 480, height: 320 });
  await window.loadURL("data:text/html,<title>Dock</title>");
  const appDock = app.dock;
  assert(appDock, "No Dock on this platform");
  const background = new DesktopBackgroundMode({
    shutdown,
    window: { hide: () => window.hide() },
    dock: {
      hide: () => appDock.hide(),
      show: () => appDock.show(),
      isVisible: () => appDock.isVisible(),
    },
    notice: { seen: async () => true, markSeen: async () => undefined, show: () => undefined },
    work: async () => ({ known: true, hostsHome: false, deviceHomes: [], lines: [] }),
    confirm: async () => false,
    log,
  });
  quitRouting.attach(background);
  await waitFor("the Dock icon", () => appDock.isVisible());
  window.hide();
  background.windowVisibility(false);
  await waitFor("the Dock icon to go", () => !appDock.isVisible(), 5_000);
  held("dock-icon-goes-with-the-window");
  window.show();
  background.windowVisibility(true);
  await waitFor("the Dock icon back", () => appDock.isVisible(), 5_000);
  // Closed again at once: Electron ignores a hide this soon after a show.
  window.hide();
  background.windowVisibility(false);
  await waitFor("the Dock icon gone after a quick reopen", () => !appDock.isVisible(), 5_000);
  held("dock-icon-gone-after-quick-reopen-and-close");
  window.show();
  background.windowVisibility(true);
  await delay(2_000);
  assert(appDock.isVisible(), "The Dock icon went while the window was open");
  held("dock-icon-stays-while-the-window-is-open");
  passed();
}
