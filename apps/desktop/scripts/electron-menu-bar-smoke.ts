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
import { hostApi, hostApiVersionHeader, mintComputerUseSessionId } from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { DesktopAccessOriginSchema } from "@opensteer/protocol/desktop";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
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
  utilityProcess,
  webContents,
} from "electron";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";
import { AgentAdmission } from "../src/app/agent-admission.js";
import { installDesktopAppProtocol, registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { createDesktopApplicationMenu } from "../src/app/application-menu.js";
import { DesktopBackgroundMode } from "../src/app/background-mode.js";
import { DesktopShutdown } from "../src/app/desktop-shutdown.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { HostedHomeStop } from "../src/app/hosted-home-stop.js";
import { DesktopLocalStop, localStopFileStore, type LocalStopPart } from "../src/app/local-stop.js";
import { DesktopMenuBar, menuBarGlyph, type MenuBarIcon } from "../src/app/menu-bar.js";
import { DesktopMenuBarService } from "../src/app/menu-bar-service.js";
import { DesktopQuitRouting, type QuitActions } from "../src/app/quit-routing.js";
import { parentedQuitQuestion, quitQuestionParentOptions } from "../src/app/quit-question.js";
import { AgentBrowserGate } from "../src/browser/agent-browser-gate.js";
import { ComputerUseService } from "../src/computer-use/computer-use-service.js";
import { bundledComputerUseHelperPath } from "../src/computer-use/helper-paths.js";
import { desktopComputerUseTeamId } from "../src/computer-use/release-identity.js";
import { readDesktopConfiguration } from "../src/config.js";
import { createDesktopHostApi } from "../src/connections/desktop-host-api.js";
import { NativePersonalDeploymentCredentials } from "../src/secrets/personal-deployment-credentials.js";
import { NativePersonalDeploymentFilesystem } from "../src/secrets/personal-deployment-store.js";
import { startLocalBrowserRuntime } from "../src/supervisor/local-browser-runtime.js";
import {
  electronUtilityProcessFork,
  LocalRunnerService,
} from "../src/supervisor/local-runner-service.js";
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
    case "row-stop":
      return rowStop();
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
  const heldPart: LocalStopPart = {
    pause: async () => {
      if (holds) await release.promise;
    },
    resume: () => undefined,
  };
  const failingPart: LocalStopPart = {
    pause: () => {
      if (failures-- > 0) throw new Error("A Device Runner did not confirm it stopped.");
    },
    resume: () => undefined,
  };
  const admission = new AgentAdmission();
  const localStop = new DesktopLocalStop({
    admission,
    computerUse: heldPart,
    runners: failingPart,
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
    }),
    stopRow: () => false,
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
    (await item.text()).includes("didn’t stop (Device connections)"),
  );
  const afterFailure = await item.buttons();
  assert(afterFailure.includes(menuBarWords("menubar.stopAll")), "No retry after a failed Stop");
  assert(
    !afterFailure.includes(menuBarWords("menubar.resume")),
    "Resume offered for a failed Stop",
  );
  assert(!(await item.text()).includes("Stopped everything"), "Said stopped for a failed Stop");
  await item.capture("failed");
  held("failed-stop-offers-retry-not-resume");

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

/** This Mac's own Home and the Device Runner it lends to it, as the quit smoke starts them. */
async function startHome(input: {
  readonly agentStopFile: string;
  readonly gate: AgentBrowserGate;
  readonly admission: AgentAdmission;
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
  const supervisor = new PersonalDeploymentSupervisor({
    agentStopFile: input.agentStopFile,
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
      spawn: (spec) => processes.spawn(spec),
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
  const config = readDesktopConfiguration({
    appDataDirectory: root,
    defaultMode: "development",
    packaged: false,
    resourcesDirectory: resources,
    environment: {
      OPENSTEER_DESKTOP_DATA_DIR: root,
      OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: path.join(resources, "personal-runtime"),
      OPENSTEER_DESKTOP_RUNNER_WORKER: path.join(import.meta.dirname, "quit-runner-worker.js"),
      OPENSTEER_DESKTOP_NATIVE_FS_HELPER: path.join(
        resources,
        "personal-runtime/bin/opensteer-native-fs",
      ),
    },
  }).config;
  const target = {
    authority: runtime.discoveryEnvelope,
    source: { kind: "manual" as const },
    accessRoute: null,
    deploymentId: manifest.deploymentId,
    deploymentShape: { kind: "personal" as const },
    hostUrl: DesktopAccessOriginSchema.parse(origin),
    key: "menu-bar-smoke",
    mayRunAgents: false,
  };
  const localRunners = new LocalRunnerService(config, {
    admission: input.admission,
    log,
    browser: (browserInput) =>
      startLocalBrowserRuntime({
        agentGate: input.gate,
        downloads: smokeDesktopDownloads(),
        logPath: browserInput.logPath,
        pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
        profileRoot: browserInput.profileRoot,
        runtimeId: browserInput.runtimeId,
      }),
    fork: (modulePath, args, options) =>
      electronUtilityProcessFork(utilityProcess.fork)(modulePath, args, {
        ...options,
        env: {
          ...options.env,
          [processSupervisorExecutableVariable]: readPersonalProcessSupervisorRelease(resources),
        },
      }),
    homeDirectory: root,
    computerName: async () => "Menu bar smoke Mac",
    targets: {
      resolve: async () => target,
      isCurrent: async () => true,
      subscribe: () => () => undefined,
    },
    userEnvironment: { resolve: async () => environment },
  });
  shutdown.add({
    component: "local-runners",
    step: "stop",
    order: 30,
    timeoutMs: 8_000,
    stop: async (signal) => {
      await localRunners.shutdown(signal);
      localRunners.dispose();
    },
  });
  return { host, localRunners, manifest, network, origin, rpc, supervisor };
}

/**
 * Stop everything with this Mac's own Home and a Device Runner here: the Home
 * shows both computers as stopped and the popover says the Home confirms it;
 * the person's tab in the Device's browser stays open through Stop and Resume
 * and can be watched again after Resume; Resume clears the Home's line.
 */
async function homeStop(): Promise<void> {
  const admission = new AgentAdmission();
  const gate = new AgentBrowserGate(admission);
  const stopFile = path.join(root, "local-stop.json");
  const home = await startHome({ agentStopFile: stopFile, gate, admission });
  const localStop = new DesktopLocalStop({
    admission,
    computerUse: { pause: () => undefined, resume: () => undefined },
    runners: home.localRunners,
    browser: gate,
    home: new HostedHomeStop({
      hostedHome: async () => ({
        deploymentId: home.manifest.deploymentId,
        state: home.supervisor.status.state,
      }),
      host: () => home.host,
    }),
    store: localStopFileStore(stopFile),
    log,
  });
  await localStop.restore();
  assert.equal(localStop.phase, "running");
  const enrollment = z.object({ token: z.string() }).parse(
    await home.rpc("commands.dispatch", {
      type: "runner.enrollment.createLocal",
      idempotencyKey: randomUUID(),
      name: "Menu bar smoke Device",
      allowedModules: ["browser", "integrations", "shell"],
      access: { apps: false, browser: true, files: false },
    }),
  );
  await home.localRunners.start({
    deploymentId: home.manifest.deploymentId,
    enrollmentToken: enrollment.token,
    runAgents: false,
    runnerName: "Menu bar smoke Device",
  });
  const deviceRunnerId = z
    .string()
    .parse((await home.localRunners.status(home.manifest.deploymentId)).runner.runnerId);

  // The person's own tab, in the Device's browser.
  const pages = createServer((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Person's tab</title><p>Kept through Stop</p>"),
  );
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
  const session = z.object({ session: z.object({ id: z.string() }) }).parse(
    await home.rpc("commands.dispatch", {
      type: "browser.session.start",
      idempotencyKey: randomUUID(),
      input: {
        fresh: true,
        initialUrl: pageUrl,
        reuseExisting: false,
        placement: { kind: "runner", runnerId: deviceRunnerId },
      },
    }),
  ).session;
  await waitFor("the person's tab", () =>
    webContents.getAllWebContents().some((contents) => contents.getURL() === pageUrl),
  );
  const personTab = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === pageUrl)!;
  const watched = () =>
    new Promise<void>((resolve, reject) => {
      const socket = home.network.openWebSocket(
        {
          canonicalOrigin: home.origin,
          deploymentId: home.manifest.deploymentId,
          url: `ws://127.0.0.1:${home.manifest.hostPort}/v1/browser-sessions/${session.id}/connect`,
          authorization: null,
          requestOrigin: home.origin,
        },
        {
          open: () => undefined,
          message: (message) => {
            if (typeof message === "string" && JSON.parse(message).type === "browser.snapshot") {
              socket.close(1000, "watched");
              resolve();
            }
          },
          error: reject,
          close: () => undefined,
        },
      );
    });
  await watched();
  held("person-tab-watched-before-stop");

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
      runs: home.localRunners.localActivity(),
    }),
    stop: () => ({
      phase: localStop.phase,
      stoppedAt: localStop.stoppedAt,
      problem: localStop.problem,
    }),
    stopRow: () => false,
    openAtLogin: async () => ({ on: false, available: false }),
    log,
  });
  localStop.subscribe(() => service.changed());
  home.localRunners.subscribe(() => service.changed());
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
  await item.click(".menu-bar__stop-all");
  await waitFor(
    "stopped",
    async () => (await item.text()).includes("Stopped everything on this Mac at"),
    60_000,
  );
  held("stop-everything-confirmed", { phase: localStop.phase });

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
  await waitFor(
    "the Home showing the Device stopped, though its Runner is gone",
    async () => {
      const device = await row(deviceRunnerId);
      return Boolean(device?.agentsStoppedSince) && device?.status === "offline";
    },
    30_000,
  );
  held("home-shows-the-device-stopped-not-offline");
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
  assert(!personTab.isDestroyed() && personTab.getURL() === pageUrl, "The person's tab closed");
  held("person-tab-kept-through-stop");

  await item.click(".menu-bar__resume");
  await waitFor(
    "the Home clearing this Mac's Stop",
    async () => !(await row(home.manifest.runnerId))?.agentsStoppedSince,
    30_000,
  );
  await waitFor(
    "the Device back online",
    async () => {
      const device = await row(deviceRunnerId);
      return !device?.agentsStoppedSince && device?.status === "online";
    },
    60_000,
  );
  held("resume-clears-the-home-line");
  assert(!personTab.isDestroyed() && personTab.getURL() === pageUrl, "The person's tab closed");
  await watched();
  held("person-tab-watched-after-resume");
  passed({ deviceRunnerId });
}

/**
 * One agent session on this Mac's apps through the real helper, stopped from
 * its row: the Runner hears the person's stop, the row says stopping until the
 * helper confirms the close, then goes. A guest whose helper cannot open a
 * session leaves this unverified, never passed.
 */
async function rowStop(): Promise<void> {
  const admission = new AgentAdmission();
  admission.reopen();
  const computerUse = new ComputerUseService({
    admission,
    appBundleId: "dev.opensteer.menu-bar-smoke",
    appVersion: app.getVersion(),
    bundledHelperPath: () =>
      bundledComputerUseHelperPath({
        developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
        packaged: false,
        resourcesPath: undefined,
      }),
    log: (event, fields) => log(event, fields ?? {}),
    teamId: desktopComputerUseTeamId(false),
  });
  shutdown.add({
    component: "computer-use",
    step: "stop",
    order: 50,
    timeoutMs: 2_000,
    stop: () => computerUse.stop(),
  });
  const bridge = await computerUse.startForSlot("dep_00000000-0000-4000-8000-0000000000aa");
  assert(bridge, "Computer use is unavailable on this Mac");
  const runner = new WebSocket(bridge.url, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  await new Promise<void>((resolve, reject) => {
    runner.once("open", () => resolve());
    runner.once("error", reject);
  });
  const answers = new Map<number, (frame: unknown) => void>();
  const events: unknown[] = [];
  runner.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString("utf8")) as { id?: number; kind?: string };
    if (frame.kind === "event") events.push(frame);
    else if (typeof frame.id === "number") answers.get(frame.id)?.(frame);
  });
  const call = (id: number, method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      answers.set(id, resolve);
      runner.send(JSON.stringify({ id, kind: "request", method, params }));
    });
  const sessionId = mintComputerUseSessionId();
  const opened = z
    .object({ result: z.unknown().optional(), error: z.object({ code: z.string() }).optional() })
    .parse(await call(1, "session.open", { sessionId, threadTitle: "Menu bar smoke" }));
  if (opened.error) {
    // Grants or the helper itself are missing in this guest: not a pass.
    log("test.unverified", { reason: `session.open refused: ${opened.error.code}` });
    clearTimeout(watchdog);
    runner.close();
    shutdown.request("test-unverified");
    return;
  }
  await waitFor("the session's row", () =>
    computerUse.agentSessionDetails().some((row) => row.sessionId === sessionId),
  );
  held("row-appears-for-the-session");
  assert.equal(computerUse.stopAgentSession(sessionId), true);
  const states = computerUse.agentSessionDetails().map((row) => row.state);
  assert.deepEqual(states, ["stopping"], "The row did not say stopping");
  held("row-says-stopping-until-confirmed");
  await waitFor("the person's stop reaching the Runner", () =>
    events.some(
      (frame) =>
        (frame as { event?: string; params?: { reason?: string } }).event === "session.stopped" &&
        (frame as { params?: { reason?: string } }).params?.reason === "user",
    ),
  );
  held("runner-hears-the-persons-stop");
  await waitFor(
    "the helper confirming the close",
    () => computerUse.agentSessionDetails().length === 0,
  );
  held("row-goes-once-the-helper-confirms");
  runner.close();
  passed();
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
  process.once("SIGHUP", () => menuItem("quit-completely").click());
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
