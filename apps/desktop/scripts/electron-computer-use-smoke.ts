import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain, nativeImage, protocol, screen, session } from "electron";
import { z } from "zod";
import type {
  ComputerUseDataGrant,
  ComputerUseDataGrants,
  ComputerUsePermissions,
} from "@opensteer/protocol";
import { installDesktopAppProtocol, registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { configureDesktopSession, desktopWebPreferences } from "../src/app/electron-window.js";
import { DesktopAppOriginPolicy } from "../src/app/navigation-policy.js";
import { registerDesktopBridge } from "../src/bridge/registration.js";
import { ComputerUsePermissionsPanel } from "../src/computer-use/computer-use-permissions-panel.js";
import { ComputerAppSetupGuide } from "../src/computer-app-setup-guide.js";
import { ComputerAppSetupPanel } from "../src/computer-use/computer-app-setup-panel.js";
import {
  runPasswordsMacJourney,
  stopPasswordsMacProcesses,
} from "./test-support/passwords-mac-journey.js";

const smokeDownloads = smokeDesktopDownloads();

// Separate profile and simulated grant reads keep the smoke away from the
// person's saved deployments, app data, and macOS permission prompts.
const profile = mkdtempSync(path.join(tmpdir(), "opensteer-consent-smoke-"));
app.setPath("userData", profile);
registerDesktopAppScheme(protocol);
const liveness = setInterval(() => undefined, 1_000);
const watchdog = setTimeout(() => {
  process.stderr.write("Computer use Electron smoke exceeded 90 seconds.\n");
  finish(1);
}, 90_000);
app.on("window-all-closed", () => undefined);
void run().then(
  () => finish(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    finish(1);
  },
);

function finish(code: number): void {
  stopPasswordsMacProcesses();
  clearInterval(liveness);
  clearTimeout(watchdog);
  // This also covers setup failures before run's panel cleanup and the watchdog.
  try {
    if (app.isReady()) for (const window of BrowserWindow.getAllWindows()) window.destroy();
    rmSync(profile, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`Consent smoke cleanup failed: ${String(error)}\n`);
    code = 1;
  }
  if (code === 0) process.stdout.write("electron-computer-use-smoke.passed\n");
  app.exit(code);
}

async function run(): Promise<void> {
  await app.whenReady();
  await runPasswordsMacJourney();
  const bridgeToken = randomBytes(32).toString("base64url");
  const preferences = desktopWebPreferences(
    { mode: "production" },
    bridgeToken,
    path.resolve("dist/preload.cjs"),
  );
  const uninstallProtocol = installDesktopAppProtocol(protocol, path.resolve("dist/web"));
  configureDesktopSession(
    session.defaultSession,
    new DesktopAppOriginPolicy(),
    null,
    smokeDownloads,
  );
  let permissions: ComputerUsePermissions = { accessibility: "denied", screenRecording: "denied" };
  let permissionWindow: BrowserWindow | undefined;
  const permissionRequests: string[] = [];
  let failNextPermissionRequest = false;
  const settings: string[] = [];
  const permissionPanel = new ComputerUsePermissionsPanel({
    openExternal: async (url) => {
      settings.push(url);
    },
    screen,
    webPreferences: preferences,
    windowFactory: (options) => {
      permissionWindow = new BrowserWindow(options);
      return permissionWindow;
    },
  });
  // The setup guide over simulated helper grants: the real panel window, the
  // real bridge, and a helper whose answers the journey decides.
  let dataGrants: ComputerUseDataGrants = {
    automation: "requestable",
    calendars: "granted",
    contacts: "granted",
    "full-disk-access": "denied",
    reminders: "granted",
  };
  let thisAppHasFullDiskAccess = false;
  let failNextDataRequest = false;
  const dataRequests: ComputerUseDataGrant[] = [];
  const dataSettings: ComputerUseDataGrant[] = [];
  const drags: { readonly file: string }[] = [];
  const helperAppPath = path.join(profile, "Opensteer Computer Use.app");
  let setupWindow: BrowserWindow | undefined;
  const setupPanel = new ComputerAppSetupPanel({
    onClosed: () => void setupGuide.dismiss(),
    screen,
    webPreferences: preferences,
    windowFactory: (options) => {
      setupWindow = new BrowserWindow(options);
      // A real drag needs a person's pointer; the journey records what main
      // would drag instead.
      setupWindow.webContents.startDrag = (item) => {
        drags.push({ file: String(item.file) });
      };
      return setupWindow;
    },
  });
  const setupGuide = new ComputerAppSetupGuide({
    appIcon: async () => null,
    appName: "Opensteer Beta",
    dataGrants: async () => dataGrants,
    helperAppPath,
    ownFullDiskAccess: async () => thisAppHasFullDiskAccess,
    openSettings: async (grant) => {
      dataSettings.push(grant);
    },
    panel: setupPanel,
    requestDataGrant: async (grant) => {
      dataRequests.push(grant);
      if (failNextDataRequest) {
        failNextDataRequest = false;
        throw new Error("This Mac's Computer use helper did not answer in time.");
      }
      return dataGrants;
    },
  });
  // Register the actual IPC handlers; unrelated desktop services fail if a
  // consent route unexpectedly starts depending on them.
  const unused = (): never => {
    throw new Error("Consent panel used an unrelated desktop service");
  };
  const subscribe = () => () => undefined;
  const unregisterBridge = registerDesktopBridge({
    downloads: smokeDownloads,
    localVisibility: { getSnapshot: () => true, subscribe: () => () => undefined },
    access: {
      addDirect: unused,
      cancel: unused,
      checkDeployments: unused,
      connectPrivate: unused,
      createPersonalDeployment: unused,
      linkPersonal: unused,
      reauthorize: unused,
      refreshDirectory: unused,
      removeFromAccount: unused,
      retry: unused,
      select: unused,
      signIn: unused,
      signOut: unused,
      snapshot: unused,
      subscribe,
      unlinkPersonal: unused,
    },
    agentPhone: { chooseUsbDevice: unused, readArtifact: unused },
    bridgeToken,
    computerApps: {
      dragIcon: async () => nativeImage.createFromPath(path.resolve("dist/web/computer-use.png")),
      setup: {
        begin: (input) => setupGuide.begin(input),
        close: (input) => setupGuide.dismiss(input),
        dragItem: () => setupGuide.dragItem(),
        open: (input) => setupGuide.open(input),
        showAgain: () => setupGuide.openSettings(),
        status: () => setupGuide.status(),
      },
    },
    computerUse: {
      onActivationError: () => undefined,

      closePermissionsPanel: async () => permissionPanel.close(),
      openPermissionsPanel: async () => {
        await permissionPanel.open();
      },
      verifyBundledHelper: async () => undefined,
      openSystemSettings: (pane) => permissionPanel.openSystemSettings(pane),
      permissions: async () => permissions,
      requestPermissions: async (pane) => {
        permissionRequests.push(pane);
        if (failNextPermissionRequest) {
          failNextPermissionRequest = false;
          throw new Error("simulated permission request failure");
        }
        return permissions;
      },
    },
    fullDiskAccess: { check: unused, closePanel: unused, request: unused },
    passwords: {
      open: unused,
      status: unused,
      subscribe,
    },
    hostTransport: {
      closeBinary: unused,
      closeBinaryForOwner: unused,
      openBinary: unused,
      writeBinary: unused,
      finishBinary: unused,
      readBinary: unused,
      closeSocketsForOwner: unused,
      closeWebSocket: unused,
      current: unused,
      integrationAuthorizationOrigin: unused,
      openWebSocket: unused,
      request: unused,
      sendWebSocket: unused,
    },
    ipcMain,
    portal: { openExternal: unused, pickFolder: unused },
    runner: { remove: unused, start: unused, status: unused, subscribe },
  });
  const screenshots = path.join(
    process.env.OPENSTEER_JOURNEY_OUT ?? tmpdir(),
    "opensteer-consent-smoke-screenshots",
  );
  await mkdir(screenshots, { recursive: true });
  try {
    await permissionPanel.open();
    assert(permissionWindow);
    await rendered(permissionWindow, "Enable Screen Recording");
    assert.deepEqual(
      permissionRequests,
      [],
      "Opening the panel must not ask macOS for either grant",
    );
    await click(permissionWindow, "Enable Screen Recording");
    await rendered(permissionWindow, "Open System Settings");
    assert.deepEqual(settings, [], "The macOS request must not immediately open System Settings");
    assert.deepEqual(permissionRequests, ["screen-recording"]);
    await click(permissionWindow, "Open System Settings");
    await until(() => settings.length > 0, "System Settings action");
    assert.match(settings[0] ?? "", /Privacy_ScreenCapture$/);
    await assertPermissionContentFits(permissionWindow, false);
    await writeFile(
      path.join(screenshots, "permissions.png"),
      (await permissionWindow.webContents.capturePage()).toPNG(),
    );
    permissions = { accessibility: "denied", screenRecording: "granted" };
    await rendered(permissionWindow, "Enable Accessibility");
    assert.deepEqual(permissionRequests, ["screen-recording"]);
    failNextPermissionRequest = true;
    await click(permissionWindow, "Enable Accessibility");
    await until(
      async () =>
        Boolean(
          await permissionWindow?.webContents.executeJavaScript(
            "document.querySelector('[role=alert]')?.textContent.includes('Could not request Accessibility')",
          ),
        ),
      "permission request failure",
    );
    await assertPermissionContentFits(permissionWindow, true);
    await writeFile(
      path.join(screenshots, "permissions-error.png"),
      (await permissionWindow.webContents.capturePage()).toPNG(),
    );
    await click(permissionWindow, "Enable Accessibility");
    await rendered(permissionWindow, "Open System Settings");
    assert.deepEqual(permissionRequests, ["screen-recording", "accessibility", "accessibility"]);
    assert.equal(settings.length, 1, "The Accessibility request must not open Settings itself");
    await click(permissionWindow, "Open System Settings");
    await until(() => settings.length > 1, "Accessibility System Settings action");
    assert.match(settings[1] ?? "", /Privacy_Accessibility$/);
    permissions = { accessibility: "granted", screenRecording: "granted" };
    await until(
      async () =>
        Boolean(
          await permissionWindow?.webContents.executeJavaScript(
            "document.body.textContent.includes('Computer use is ready.')",
          ),
        ),
      "permission ready state",
    );
    permissions = { accessibility: "denied", screenRecording: "granted" };
    await rendered(permissionWindow, "Open System Settings");
    assert.equal(permissionWindow.isDestroyed(), false, "A revoked grant keeps the panel open");
    permissions = { accessibility: "granted", screenRecording: "granted" };
    await until(() => permissionWindow?.isDestroyed() === true, "permission completion");

    // Setting up an app the helper serves: the incident's journey. The wrong
    // app switched on first, an Automation question answered after the
    // request that asked it gave up, and the agent's offer.
    const journey: string[] = [];
    const panelText = async () =>
      String(await setupWindow?.webContents.executeJavaScript("document.body.textContent ?? ''"));
    const capture = async (name: string) => {
      const window = setupWindow;
      assert(window && !window.isDestroyed());
      // The panel fades in when it arrives and shakes when the wrong app
      // turns on; a picture taken during either is not what the person sees.
      // The looping pictures inside it never settle, so only finite ones wait.
      await until(
        async () =>
          window.isVisible() &&
          Boolean(
            await window.webContents.executeJavaScript(`(() => {
              const panel = document.querySelector(".cas-panel:not(.cas-panel--empty)");
              return Boolean(panel) &&
                getComputedStyle(panel).opacity === "1" &&
                document.getAnimations().every((animation) =>
                  animation.playState !== "running" ||
                  animation.effect?.getComputedTiming().iterations === Infinity);
            })()`),
          ),
        `the setup panel fully shown for ${name}`,
      );
      await window.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await writeFile(
        path.join(screenshots, `setup-${name}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
      journey.push(name);
    };

    assert.deepEqual(
      await setupGuide.open({ access: "read-write", definitionId: "apple-messages" }),
      {
        opened: true,
      },
    );
    await until(async () => (await panelText()).includes("Opensteer Computer Use"), "setup row");
    assert.deepEqual(dataSettings, ["full-disk-access"], "The step's pane opens once, at once");
    const workArea = screen.getPrimaryDisplay().workArea;
    const setupBounds = setupWindow?.getBounds();
    assert(setupBounds);
    assert(
      setupBounds.x > workArea.x + workArea.width / 2 &&
        setupBounds.y > workArea.y + workArea.height / 2,
      "The panel sits in the bottom-right corner, clear of System Settings' list",
    );
    assert.equal(
      await setupWindow?.webContents.executeJavaScript(
        "(() => { const name = document.querySelector('.cas-row__name'); return name.scrollWidth <= name.clientWidth; })()",
      ),
      true,
      "The helper's name, which is how the person finds the row, is never cut",
    );
    await capture("1-full-disk-access");

    thisAppHasFullDiskAccess = true;
    await until(
      async () =>
        Boolean(
          await setupWindow?.webContents.executeJavaScript(
            "Boolean(document.querySelector('.cas-row--wrong'))",
          ),
        ),
      "this app struck out",
    );
    assert((await panelText()).includes("Opensteer Beta"));
    await capture("2-wrong-app");

    await setupWindow?.webContents.executeJavaScript(
      "document.querySelector('.cas-row--drag').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))",
    );
    await until(() => drags.length === 1, "helper drag");
    assert.deepEqual(
      drags,
      [{ file: helperAppPath }],
      "Main drags the installed helper, nothing else",
    );

    await clickLabel(setupWindow, "Show in System Settings");
    await until(() => dataSettings.length === 2, "pane reopened");
    assert.deepEqual(dataSettings, ["full-disk-access", "full-disk-access"]);

    failNextDataRequest = true;
    dataGrants = { ...dataGrants, "full-disk-access": "granted" };
    await until(() => dataRequests.includes("automation"), "Automation asked");
    await until(async () => (await panelText()).includes("Don’t Allow"), "macOS question drawn");
    await capture("3-ask");
    // The request gave up; the question is still on screen, and so is the step.
    await delay(2_500);
    assert((await panelText()).includes("Don’t Allow"), "A timed-out question ends nothing");
    await clickLabel(setupWindow, "Ask again");
    await until(
      () => dataRequests.filter((grant) => grant === "automation").length === 2,
      "asked again",
    );

    dataGrants = { ...dataGrants, automation: "granted" };
    await until(async () => (await panelText()).includes("Done"), "done");
    await capture("4-done");
    await until(() => setupWindow?.isDestroyed() === true, "setup panel closes itself");

    // An agent's call found sending missing: offered, not started.
    dataGrants = { ...dataGrants, automation: "requestable" };
    const before = dataRequests.length;
    setupGuide.offerForAgent({ access: "read-write", definitionId: "apple-messages" });
    await until(() => setupWindow !== undefined && !setupWindow.isDestroyed(), "offer opens");
    const offerWindow = setupWindow;
    assert(offerWindow);
    await rendered(offerWindow, "Set up");
    assert.equal(dataRequests.length, before, "An offer asks macOS nothing");
    await capture("5-offer");
    await click(offerWindow, "Set up");
    await until(() => dataRequests.length === before + 1, "Set up asks");
    await clickLabel(setupWindow, "Not now");
    await until(() => setupWindow?.isDestroyed() === true, "not now closes");
    setupGuide.offerForAgent({ access: "read-write", definitionId: "apple-messages" });
    await delay(1_000);
    assert.equal(setupWindow?.isDestroyed(), true, "Not now keeps that app's offers quiet");

    setupGuide.close();
    assert.deepEqual(await setupGuide.open({ access: "read", definitionId: "apple-contacts" }), {
      opened: false,
    });
    await writeFile(
      path.join(screenshots, "setup-journey.json"),
      `${JSON.stringify({ dataRequests, dataSettings, drags, journey, passed: true }, null, 2)}\n`,
    );

    process.stdout.write(
      `Consent renderer, IPC isolation, decisions, withdrawal, crash, close, quit, permission polling and app setup passed. Screenshots: ${screenshots}\n`,
    );
  } finally {
    permissionPanel.close();
    setupGuide.close();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    unregisterBridge();
    uninstallProtocol();
  }
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

async function rendered(window: BrowserWindow, button: string): Promise<void> {
  await until(
    async () =>
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.webContents.isLoading() &&
      (await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).some(button => button.textContent === ${JSON.stringify(button)})`,
      )),
    button,
  );
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function click(window: BrowserWindow, text: string): Promise<void> {
  const point = z.object({ x: z.number(), y: z.number() }).parse(
    await window.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)});
    const bounds = button.getBoundingClientRect();
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  })()`),
  );
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
}

async function clickLabel(window: BrowserWindow | undefined, label: string): Promise<void> {
  assert(window && !window.isDestroyed(), `No window for ${label}`);
  const point = z.object({ x: z.number(), y: z.number() }).parse(
    await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
    const bounds = button.getBoundingClientRect();
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  })()`),
  );
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
}

async function assertPermissionContentFits(window: BrowserWindow, error: boolean): Promise<void> {
  assert.equal(
    await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.cu-panel');
      const panelBounds = panel?.getBoundingClientRect();
      const selectors = ['.cu-panel__headline', '.cu-panel__grants', '.cu-panel__dismiss',
        ${error ? "'[role=alert]'" : "'.cu-panel__sub'"}];
      return Boolean(panel && panelBounds && panel.scrollTop === 0 &&
        panelBounds.top >= 0 && panelBounds.bottom <= innerHeight &&
        selectors.every(selector => {
          const element = document.querySelector(selector);
          if (!element) return false;
          const bounds = element.getBoundingClientRect();
          return bounds.top >= panelBounds.top && bounds.bottom <= panelBounds.bottom &&
            bounds.left >= panelBounds.left && bounds.right <= panelBounds.right;
        }));
    })()`),
    true,
    `The ${error ? "error" : "permission"} state must keep its heading, rows, and dismissal visible`,
  );
}
