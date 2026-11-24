import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  LocalProfileStore,
  type BrowserPage,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import { createId } from "@opensteer/core";
import { createBrowserSessionId, LocalProfileBindingSchema } from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  app,
  BaseWindow,
  BrowserWindow,
  nativeImage,
  protocol,
  WebContentsView,
  type WebContents,
} from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import {
  ElectronBrowserLauncher,
  electronPagePresentation,
} from "../src/browser/electron-browser-launcher.js";
import { ProfileExtensions } from "../src/browser/profile-extensions.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";

// Real Electron, real extensions: an agent loads an unpacked MV3 extension into a
// saved profile over CDP, the extension runs as it would in Chrome, and the
// profile loads it again after a restart, until the agent uninstalls it.
const phases = ["install", "reopen", "uninstalled"] as const;
type Phase = (typeof phases)[number];
const phase = (process.env.EXTENSIONS_SMOKE_PHASE ?? "") as Phase | "";
const state = realpathSync(
  process.env.EXTENSIONS_SMOKE_STATE ?? mkdtempSync(path.join(tmpdir(), "opensteer-extensions-")),
);

const manifest = {
  manifest_version: 3,
  name: "Smoke Extension",
  version: "1.0.0",
  permissions: ["storage", "tabs", "contextMenus"],
  host_permissions: ["<all_urls>"],
  icons: { 32: "icon.png" },
  background: { service_worker: "worker.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start" }],
  action: { default_title: "Smoke", default_popup: "popup.html" },
  options_page: "options.html",
};
const files: Record<string, string> = {
  "manifest.json": JSON.stringify(manifest),
  "worker.js": `
chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "smoke", title: "Smoke item", contexts: ["page"] }));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.open) chrome.tabs.create({ url: message.open, active: false }).then((tab) => reply({ opened: tab.id }));
  else if (message.window)
    chrome.windows.create({ url: message.window }).then(async (created) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.windows.remove(created.id);
      const current = await chrome.tabs.query({ active: true, currentWindow: true });
      reply({ current: current.length });
    });
  else chrome.storage.local.get(null).then((stored) => reply({ tabId: sender.tab?.id ?? null, stored }));
  return true;
});`,
  "content.js": `
document.documentElement.dataset.extensionRan = "yes";
chrome.runtime.sendMessage({ hello: true }).then((reply) => {
  document.documentElement.dataset.extensionReply = JSON.stringify(reply);
});
if (location.pathname === "/open") chrome.runtime.sendMessage({ open: location.origin + "/created" });
if (location.pathname === "/window")
  chrome.runtime.sendMessage({ window: location.origin + "/in-window" }).then((reply) => {
    document.documentElement.dataset.windowReply = JSON.stringify(reply);
  });`,
  "popup.html": `<!doctype html><body style="width:180px;height:60px">Popup<script src="popup.js"></script></body>`,
  "popup.js": `chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => { document.title = "tab:" + tabs.map((tab) => tab.id).join(","); });`,
  "options.html": `<!doctype html><title>Smoke options</title>`,
};

async function main(): Promise<void> {
  const userData = path.join(state, "user-data");
  mkdirSync(path.join(userData, "session"), { recursive: true });
  configureDesktopApplicationPaths(app, userData);
  registerDesktopAppScheme(protocol);
  app.commandLine.appendSwitch("no-proxy-server");
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${request.url}</title><p>page</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
  const origin = `http://127.0.0.1:${address.port}`;
  const extensionFolder = path.join(state, "extension");
  if (phase === "install") {
    mkdirSync(extensionFolder, { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(extensionFolder, name), content);
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    );
    writeFileSync(path.join(extensionFolder, "icon.png"), icon.resize({ width: 32 }).toPNG());
  }
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDesktopDownloads(),
    localProfileRoot: path.join(userData, "session", "browser-profiles"),
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const checks: string[] = [];
  // Each check reports as it passes, so a hang names the step after the last one.
  const push = checks.push.bind(checks);
  checks.push = (...items: string[]) => {
    for (const item of items) console.log(`[extensions-smoke] ${phase}: … ${item}`);
    return push(...items);
  };
  try {
    const browser = await openProfile(launcher, phase === "install");
    const page = await browser.context.createPage();
    const router = new SessionCdpRouter(browser.cdp);
    const sessionId = createBrowserSessionId();
    const targetId = await page.targetId();
    router.registerSession(sessionId, targetId, async () => true, path.join(state, "files"));
    const agent = (method: string, parameters: CdpParameters = {}) =>
      router.send(sessionId, { method, parameters });

    if (phase === "install") {
      const loaded = (await agent("Extensions.loadUnpacked", { path: extensionFolder })) as {
        id: string;
      };
      assert.match(loaded.id, /^[a-p]{32}$/u);
      writeFileSync(path.join(state, "extension-id"), loaded.id);
      checks.push("agent loaded an unpacked extension over CDP");
    }
    const id = readFileSync(path.join(state, "extension-id"), "utf8");
    const listed = (await agent("Extensions.getExtensions")) as {
      extensions: { id: string; path: string }[];
    };
    const present = listed.extensions.some((extension) => extension.id === id);
    if (phase === "uninstalled") {
      assert.equal(present, false, "an uninstalled extension came back after a restart");
      await load(page, `${origin}/after-uninstall`);
      assert.equal(await dataset(page, "extensionRan"), "", "uninstalled content script ran");
      checks.push("uninstall survives a restart");
      return finish(checks);
    }
    assert.ok(present, "the profile did not list its extension");
    checks.push(
      phase === "reopen" ? "the profile reloaded its extension at start" : "getExtensions lists it",
    );

    // Its content script runs from document start and reaches its service worker.
    await load(page, `${origin}/page`);
    const reply = JSON.parse(await waitForDataset(page, "extensionReply")) as { tabId: number };
    assert.equal(reply.tabId, contents(page).id, "the worker saw the wrong tab");
    checks.push("content script and service worker talk, with the page's tab");

    // chrome.tabs.create opens a tab in the page's own Browser Session.
    const before = browser.context.pages().length;
    await load(page, `${origin}/open`);
    await waitFor(() =>
      browser.context.pages().some((candidate) => candidate.url() === `${origin}/created`),
    );
    assert.equal(browser.context.pages().length, before + 1);
    checks.push("chrome.tabs.create opens a session tab");

    // The page's context menu carries the extension's item.
    const extensions = ProfileExtensions.of(contents(page).session);
    assert.ok(extensions, "the saved profile had no extensions");
    await waitFor(() =>
      extensions
        .contextMenuItems(contents(page), contextParams(`${origin}/open`))
        .some(
          (item) =>
            JSON.stringify(item.submenu?.items.map((entry) => entry.label) ?? item.label).includes(
              "Smoke item",
            ) || item.label === "Smoke item",
        ),
    );
    checks.push("context menu items");

    // The toolbar button: the app window shows the page, and activating the
    // action opens the popup anchored directly to that window, where
    // chrome.tabs.query finds the page as the active tab.
    const appWindow = new BaseWindow({ show: false, width: 1_000, height: 700 });
    const appView = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
      },
    });
    appWindow.contentView.addChildView(appView);
    appView.setBounds({ x: 0, y: 0, width: 1_000, height: 60 });
    const presentation = electronPagePresentation(page);
    assert.ok(presentation, "the page has no native presentation");
    presentation.mount(appWindow, { x: 0, y: 60, width: 1_000, height: 640 }, () => undefined);
    // The person brings the window forward: its page becomes the tab extensions act on.
    appWindow.emit("focus");
    const listedForTab = extensions.list(contents(page));
    const smokeItem = listedForTab.find((item) => item.id === id);
    assert.ok(smokeItem?.action, "the extension did not expose its toolbar action");
    assert.equal(smokeItem.action.title, "Smoke");
    assert.ok(
      smokeItem.action.icon?.startsWith("data:image/png;base64,"),
      "the toolbar icon was missing",
    );
    assert.equal(smokeItem.action.hasPopup, true);
    extensions.activateAction({
      extensionId: id,
      tabContents: contents(page),
      hostWindow: appWindow,
      eventType: "click",
      anchorRect: { x: 960, y: 10, width: 28, height: 28 },
    });
    const popup = await waitForValue(() =>
      BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith(`chrome-extension://${id}/popup.html`),
      ),
    );
    assert.equal(popup.getParentWindow(), appWindow, "the popup is not over the app window");
    await waitFor(() => popup.webContents.getTitle().startsWith("tab:"));
    assert.equal(popup.webContents.getTitle(), `tab:${contents(page).id}`);
    popup.destroy();
    checks.push("toolbar state, icon and popup with the active tab");

    // chrome.windows.create opens its own window of tabs; removing it closes them,
    // and the profile's window stays current.
    const open = browser.context.pages().length;
    await load(page, `${origin}/window`);
    const windowed = JSON.parse(await waitForDataset(page, "windowReply")) as { current: number };
    assert.equal(windowed.current, 1, "the profile's window stopped being current");
    await waitFor(() => browser.context.pages().length === open);
    checks.push("chrome.windows.create and remove");

    // The menu offers its options page, which agents can open too.
    assert.equal(
      extensions.list().find((extension) => extension.id === id)?.optionsUrl,
      `chrome-extension://${id}/options.html`,
    );
    const attached = (await router.send(sessionId, {
      method: "Target.attachToTarget",
      parameters: { targetId },
    })) as { sessionId: string };
    await router.send(sessionId, {
      method: "Page.navigate",
      parameters: { url: `chrome-extension://${id}/options.html` },
      sessionId: attached.sessionId,
    });
    await waitFor(() => page.url() === `chrome-extension://${id}/options.html`);
    const runtime = (await router.send(sessionId, {
      method: "Runtime.evaluate",
      parameters: { expression: "chrome.runtime.id", returnByValue: true },
      sessionId: attached.sessionId,
    })) as { result: { value?: unknown } };
    assert.equal(runtime.result.value, id, "the agent could not reach the extension's context");
    checks.push("options page, and agent CDP in the extension's own pages");

    // Opt-in, over the network: the real Chrome Web Store page can install into
    // the profile, and the install is a normal, removable extension after a restart.
    if (process.env.OPENSTEER_EXTENSIONS_SMOKE_WEB_STORE === "1")
      await webStore(page, extensions, checks);

    if (phase === "reopen") {
      await agent("Extensions.uninstall", { id });
      const after = (await agent("Extensions.getExtensions")) as { extensions: { id: string }[] };
      assert.ok(!after.extensions.some((extension) => extension.id === id));
      checks.push("agent uninstalled it over CDP");
    }
    appWindow.destroy();
    finish(checks);
  } finally {
    launcher.close();
    server.close();
  }
}

const darkReader = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

async function webStore(
  page: BrowserPage,
  extensions: ProfileExtensions,
  checks: string[],
): Promise<void> {
  // Normal profile tabs must NEVER expose chrome.webstorePrivate (extensions run in this Session).
  await load(page, `https://chromewebstore.google.com/detail/${darkReader}`);
  const profileTabApi = await contents(page).executeJavaScript("typeof chrome?.webstorePrivate");
  assert.equal(
    profileTabApi,
    "undefined",
    "the profile's extension-loaded Session must not expose chrome.webstorePrivate",
  );

  // The dedicated extension-free Chrome Web Store window exposes chrome.webstorePrivate safely.
  const storeWindow = extensions.openWebStore(
    undefined,
    `https://chromewebstore.google.com/detail/${darkReader}`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      if (!storeWindow.webContents.isLoading()) {
        resolve();
        return;
      }
      storeWindow.webContents.once("did-finish-load", () => resolve());
      storeWindow.webContents.once("did-fail-load", (_e, _c, desc) => reject(new Error(desc)));
    });
    const api = await storeWindow.webContents.executeJavaScript(
      "typeof chrome?.webstorePrivate?.beginInstallWithManifest3",
    );
    assert.equal(api, "function", "the isolated Chrome Web Store window lost its install API");
  } finally {
    if (!storeWindow.isDestroyed()) storeWindow.destroy();
  }
  checks.push("the isolated Chrome Web Store window can install while profile tabs cannot");
  if (phase === "install") {
    await extensions.installFromStore(darkReader);
    checks.push("installed Dark Reader from the Web Store");
    return;
  }
  const listed = extensions.list().find((extension) => extension.id === darkReader);
  assert.ok(listed && !listed.unpacked && listed.icon, "the store install did not come back");
  await extensions.uninstall(darkReader);
  assert.ok(!extensions.list().some((extension) => extension.id === darkReader));
  checks.push("the store install came back after a restart and uninstalled");
}

/** Guest keeps no extensions: CDP says so instead of loading one anywhere. */
async function guestRefuses(launcher: ElectronBrowserLauncher): Promise<void> {
  const sessionId = createBrowserSessionId();
  const guest = await launcher.launch({
    initialViewport: { devicePixelRatio: 1, width: 640, height: 480 },
    partitionKey: `session:${sessionId}`,
    sessionId,
    storage: { kind: "guest" },
  });
  const router = new SessionCdpRouter(guest.cdp);
  const page = guest.context.pages()[0] ?? (await guest.context.createPage());
  router.registerSession(
    sessionId,
    await page.targetId(),
    async () => true,
    path.join(state, "guest-files"),
  );
  await assert.rejects(
    router.send(sessionId, {
      method: "Extensions.loadUnpacked",
      parameters: { path: path.join(state, "extension") },
    }),
    /saved browser profile/u,
  );
  await guest.close();
}

async function openProfile(
  launcher: ElectronBrowserLauncher,
  initialize: boolean,
): Promise<LaunchedBrowser> {
  const root = path.join(state, "user-data", "session", "browser-profiles");
  const record = path.join(state, "binding.json");
  const store = await LocalProfileStore.acquire(root, "electron");
  const binding = initialize
    ? {
        version: 1 as const,
        deploymentId: createId("deployment"),
        profileId: createId("browserProfile"),
        runnerId: createId("runner"),
        storageInstanceId: store.storageInstanceId,
        bindingId: randomUUID(),
        engine: "electron" as const,
      }
    : LocalProfileBindingSchema.parse(JSON.parse(readFileSync(record, "utf8")));
  await store.provision(
    binding,
    !initialize,
    (directory) =>
      launcher.localProfiles.createFiles(directory, binding, new AbortController().signal),
    new AbortController().signal,
  );
  await store.close();
  if (initialize) writeFileSync(record, JSON.stringify(binding), { mode: 0o600 });
  if (initialize) await guestRefuses(launcher);
  const browser = await launcher.launch({
    initialViewport: { width: 1_000, height: 640, devicePixelRatio: 1 },
    sessionId: createBrowserSessionId(),
    partitionKey: `profile:${binding.profileId}`,
    storage: {
      kind: "local",
      directory: path.join(root, "profiles", binding.profileId, "native"),
      binding,
    },
  });
  await browser.profile!.admit();
  return browser;
}

async function load(page: BrowserPage, url: string): Promise<void> {
  const cdp = await page.cdp();
  await cdp.send("Page.enable");
  const loaded = new Promise<void>((resolve) => cdp.on("Page.loadEventFired", () => resolve()));
  await cdp.send("Page.navigate", { url });
  await withTimeout(loaded, 10_000, { timeoutError: () => new Error(`${url} did not load`) });
}

function contents(page: BrowserPage): WebContents {
  const presentation = electronPagePresentation(page);
  if (!presentation) throw new Error("The page is not an Electron page.");
  return presentation.view.webContents;
}

async function dataset(page: BrowserPage, key: string): Promise<string> {
  return String(
    await contents(page).executeJavaScript(`document.documentElement.dataset.${key} ?? ""`),
  );
}

async function waitForDataset(page: BrowserPage, key: string): Promise<string> {
  return waitForValue(async () => (await dataset(page, key)) || undefined);
}

function contextParams(pageURL: string): Electron.ContextMenuParams {
  return {
    x: 10,
    y: 10,
    pageURL,
    linkURL: "",
    mediaType: "none",
    isEditable: false,
    selectionText: "",
    editFlags: {},
    menuSourceType: "mouse",
  } as unknown as Electron.ContextMenuParams;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  await waitForValue(async () => ((await predicate()) ? true : undefined), timeoutMs);
}

async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the extension smoke.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function finish(checks: string[]): void {
  writeFileSync(path.join(state, `result-${phase}.json`), JSON.stringify({ checks }));
}

async function driver(): Promise<void> {
  const all: string[] = [];
  const artifacts = process.env.OPENSTEER_EXTENSIONS_E2E_ARTIFACT_DIR;
  const report = (passed: boolean, error?: unknown) => {
    if (!artifacts) return;
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      path.join(artifacts, "extensions.json"),
      JSON.stringify({ passed, checks: all, ...(error ? { error: String(error) } : {}) }, null, 2),
    );
  };
  try {
    await runPhases(all);
    report(true);
  } catch (error) {
    report(false, error);
    throw error;
  }
}

async function runPhases(all: string[]): Promise<void> {
  for (const name of phases) {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [import.meta.filename], {
        stdio: "inherit",
        env: { ...process.env, EXTENSIONS_SMOKE_PHASE: name, EXTENSIONS_SMOKE_STATE: state },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.once("error", reject);
      child.once("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    const result = path.join(state, `result-${name}.json`);
    if (code !== 0 || !existsSync(result))
      throw new Error(`Extensions smoke phase ${name} failed.`);
    for (const check of (JSON.parse(readFileSync(result, "utf8")) as { checks: string[] }).checks) {
      all.push(`${name}: ${check}`);
      console.log(`[extensions-smoke] ${name}: ${check}`);
    }
  }
  console.log("[extensions-smoke] passed");
}

// A failure reports and exits instead of opening Electron's error dialog.
process.on("uncaughtException", (error) => {
  console.error("[extensions-smoke] uncaught", error);
  app.exit(1);
});

if (phase) {
  void main().then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error);
      app.exit(1);
    },
  );
} else {
  void app.whenReady().then(() =>
    driver().then(
      () => app.exit(0),
      (error: unknown) => {
        console.error(error);
        app.exit(1);
      },
    ),
  );
}
