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
import { installSmokeGuard } from "./test-support/smoke-guard.js";

installSmokeGuard(
  `extensions${process.env.EXTENSIONS_SMOKE_PHASE ? `:${process.env.EXTENSIONS_SMOKE_PHASE}` : ""}`,
  360_000,
);

// Real Electron, real extensions: check connected-agent extension isolation first in its own
// profile (independent of the install phase's chrome.windows check), then verify an agent loads an
// unpacked MV3 extension into a saved profile over CDP, the extension runs as it would in Chrome,
// and the profile loads it again after a restart, until the agent uninstalls it.
const phases = ["connected-agent", "install", "reopen", "uninstalled"] as const;
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
  web_accessible_resources: [{ resources: ["war.html", "war.txt"], matches: ["<all_urls>"] }],
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
  "war.html": `<!doctype html><title>Smoke WAR</title><p>war</p>`,
  "war.txt": "extension-war-secret",
  "nonwar.html": `<!doctype html><title>Smoke non-WAR</title><p>nonwar</p>`,
};

function writeFixtureExtension(extensionFolder: string): void {
  mkdirSync(extensionFolder, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(extensionFolder, name), content);
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  );
  writeFileSync(path.join(extensionFolder, "icon.png"), icon.resize({ width: 32 }).toPNG());
}

async function main(): Promise<void> {
  const phaseState = phase === "connected-agent" ? path.join(state, "connected-agent") : state;
  const userData = path.join(phaseState, "user-data");
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
  const extensionFolder = path.join(phaseState, "extension");
  if (phase === "connected-agent" || phase === "install") {
    writeFixtureExtension(extensionFolder);
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
    const browser = await openProfile(
      launcher,
      phase === "connected-agent" || phase === "install",
      phaseState,
      phase === "install",
    );
    const page = await browser.context.createPage();
    const router = new SessionCdpRouter(browser.cdp);
    const sessionId = createBrowserSessionId();
    const targetId = await page.targetId();
    router.registerSession(sessionId, targetId, async () => true, path.join(phaseState, "files"));
    const agent = (method: string, parameters: CdpParameters = {}) =>
      router.send(sessionId, { method, parameters, manageExtensions: true });

    if (phase === "connected-agent") {
      const loaded = (await agent("Extensions.loadUnpacked", { path: extensionFolder })) as {
        id: string;
      };
      assert.match(loaded.id, /^[a-p]{32}$/u);
      const sections = await checkConnectedAgentBesideExtension(
        browser,
        router,
        sessionId,
        loaded.id,
        origin,
        checks,
      );
      await browser.close();
      const boundaryPassed = sections.every((entry) => entry.passed);
      writeBoundaryArtifacts(sections, checks, boundaryPassed);
      finish(checks, { passed: boundaryPassed, sections });
      if (!boundaryPassed) {
        const failed = sections
          .filter((entry) => !entry.passed)
          .map((entry) => `${entry.section}: ${entry.error ?? "failed"}`)
          .join("; ");
        throw new Error(`Connected-agent extension boundary failed: ${failed}`);
      }
      return;
    }

    if (phase === "install") {
      await assert.rejects(
        router.send(sessionId, {
          method: "Extensions.loadUnpacked",
          parameters: { path: extensionFolder },
        }),
        /Full access/u,
      );
      const loaded = (await agent("Extensions.loadUnpacked", { path: extensionFolder })) as {
        id: string;
      };
      assert.match(loaded.id, /^[a-p]{32}$/u);
      writeFileSync(path.join(phaseState, "extension-id"), loaded.id);
      checks.push("agent loaded an unpacked extension over CDP");
    }
    const id = readFileSync(path.join(phaseState, "extension-id"), "utf8");
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

interface SectionResult {
  readonly section: string;
  readonly passed: boolean;
  readonly checks: string[];
  readonly error?: string;
}

const boundarySectionNames = [
  "connected-agent-isolation",
  "connected-agent-breakpoints",
  "connected-agent-compromise",
  "connected-agent-probes",
  "connected-agent-dialog",
] as const;

function writeSectionArtifact(entry: SectionResult): void {
  const artifacts = process.env.OPENSTEER_EXTENSIONS_E2E_ARTIFACT_DIR;
  if (!artifacts) return;
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    path.join(artifacts, `section-${entry.section}.json`),
    JSON.stringify(entry, null, 2),
  );
}

function writeBoundaryArtifacts(
  sections: readonly SectionResult[],
  checks: readonly string[],
  passed: boolean,
): void {
  for (const entry of sections) writeSectionArtifact(entry);
  const artifacts = process.env.OPENSTEER_EXTENSIONS_E2E_ARTIFACT_DIR;
  if (!artifacts) return;
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    path.join(artifacts, "section-connected-agent.json"),
    JSON.stringify({ section: "connected-agent", passed, sections, checks }, null, 2),
  );
}

async function runBoundarySection(
  section: (typeof boundarySectionNames)[number],
  checks: string[],
  fn: (sectionChecks: string[]) => Promise<void>,
): Promise<SectionResult> {
  const sectionChecks: string[] = [];
  try {
    await fn(sectionChecks);
    const entry: SectionResult = { section, passed: true, checks: sectionChecks };
    writeSectionArtifact(entry);
    console.log(`[extensions-smoke] section ${section}: PASS (${sectionChecks.join("; ")})`);
    checks.push(`${section}: ${sectionChecks.join("; ")}`);
    return entry;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const entry: SectionResult = {
      section,
      passed: false,
      checks: sectionChecks,
      error: message,
    };
    writeSectionArtifact(entry);
    console.error(`[extensions-smoke] section ${section}: FAIL: ${message}`);
    return entry;
  }
}

/**
 * Section: "a connected agent beside an extension".
 * Runs as five independent boundary sections before main's install/windows phase, writing a
 * separate result line and JSON file per section so boundary evidence is complete regardless of
 * main's chrome.windows step while still failing honestly if any boundary check fails.
 */
async function checkConnectedAgentBesideExtension(
  browser: LaunchedBrowser,
  router: SessionCdpRouter,
  sessionId: string,
  extensionId: string,
  origin: string,
  checks: string[],
): Promise<SectionResult[]> {
  const warUrl = `chrome-extension://${extensionId}/war.html`;
  const warTxtUrl = `chrome-extension://${extensionId}/war.txt`;
  const nonWarUrl = `chrome-extension://${extensionId}/nonwar.html`;

  const results: SectionResult[] = [];

  results.push(
    await runBoundarySection("connected-agent-isolation", checks, async (sectionChecks) => {
      const connPage = await browser.context.createPage();
      let runClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      let blindClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      try {
        const connTargetId = await connPage.targetId();
        router.claimTarget(sessionId, connTargetId);
        await load(connPage, `${origin}/connected-check`);
        await waitForDataset(connPage, "extensionReply");

        // 1. Inspect via a Run (non-connection) channel what Electron's CDP actually reports for the
        //    content-script execution context, and print it so the VM record settles that fact.
        const runContexts: Record<string, unknown>[] = [];
        runClient = router.openStandardClient(sessionId, { wholeContext: false });
        runClient.onEvent((event) => {
          if (event.method === "Runtime.executionContextCreated") {
            runContexts.push(event.parameters.context as Record<string, unknown>);
          }
        });
        const { sessionId: runSession } = (await runClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: connTargetId, flatten: true },
        })) as { sessionId: string };
        await runClient.send({ method: "Runtime.enable", sessionId: runSession });
        const extWorld = await waitForValue(() =>
          runContexts.find((ctx) => {
            const aux = (ctx.auxData ?? {}) as Record<string, unknown>;
            return (
              aux.isDefault === false &&
              (String(ctx.origin ?? "").startsWith("chrome-extension://") ||
                ctx.name === "Smoke Extension")
            );
          }),
        );
        console.log(
          `[extensions-smoke] connected-agent: Electron CDP content-script world=${JSON.stringify(extWorld)}`,
        );
        const extContextId = extWorld.id as number;
        runClient.close();
        runClient = null;

        // 2. Attach as a connected agent (without Runtime.enable first to prove M2 live).
        blindClient = router.openStandardClient(sessionId, {
          wholeContext: false,
          connection: true,
          lineage: { attachmentId: "smoke-conn-blind", seedTargetId: connTargetId },
        });
        const blindEvents: { method: string; parameters: CdpParameters }[] = [];
        blindClient.onEvent((event) => blindEvents.push(event));
        const { sessionId: blindSession } = (await blindClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: connTargetId, flatten: true },
        })) as { sessionId: string };

        let guessedOutcome = "resolved";
        try {
          await blindClient.send({
            method: "Runtime.evaluate",
            sessionId: blindSession,
            parameters: {
              contextId: extContextId,
              expression: "chrome.runtime.id",
              returnByValue: true,
            },
          });
        } catch (error) {
          guessedOutcome = error instanceof Error ? error.message : String(error);
        }
        assert.notEqual(
          guessedOutcome,
          "resolved",
          `M2 failed: connected agent without Runtime.enable entered extension contextId=${extContextId}`,
        );
        assert.equal(
          blindEvents.some((e) => e.method === "Runtime.executionContextCreated"),
          false,
          `M2 failed: internal Runtime.enable leaked executionContextCreated events: ${JSON.stringify(blindEvents)}`,
        );

        // Now enable Runtime on the connected agent channel and verify the content-script world never appears.
        await blindClient.send({ method: "Runtime.enable", sessionId: blindSession });
        const connContextIds = blindEvents
          .filter((e) => e.method === "Runtime.executionContextCreated")
          .map((e) => e.parameters.context as { id: number; name?: string; origin?: string });
        assert.equal(
          connContextIds.some((c) => c.id === extContextId || c.name === "Smoke Extension"),
          false,
          `2a(i) failed: extension world appeared to connected agent: ${JSON.stringify(connContextIds)}`,
        );

        // M5: creating an isolated world with the extension's exact name succeeds identically to a random name.
        const frameTree = (await blindClient.send({
          method: "Page.getFrameTree",
          sessionId: blindSession,
        })) as { frameTree: { frame: { id: string } } };
        const mainFrameId = frameTree.frameTree.frame.id;
        const namedLikeExt = (await blindClient.send({
          method: "Page.createIsolatedWorld",
          sessionId: blindSession,
          parameters: { frameId: mainFrameId, worldName: "Smoke Extension" },
        })) as { executionContextId: number };
        assert.equal(
          typeof namedLikeExt.executionContextId,
          "number",
          `M5 failed: createIsolatedWorld("Smoke Extension") returned ${JSON.stringify(namedLikeExt)}`,
        );

        // S1: fetch probe for a web-accessible resource from the connection-controlled page is cancelled.
        const fetchProbe = (await blindClient.send({
          method: "Runtime.evaluate",
          sessionId: blindSession,
          parameters: {
            expression: `fetch(${JSON.stringify(warTxtUrl)}).then(r => r.text()).then(t => "LOADED:" + t, e => "BLOCKED:" + String(e))`,
            awaitPromise: true,
            returnByValue: true,
          },
        })) as { result?: { value?: unknown } };
        assert.ok(
          String(fetchProbe.result?.value ?? "").startsWith("BLOCKED:"),
          `S1 failed: WAR fetch probe was not cancelled on connection page; saw ${JSON.stringify(fetchProbe.result?.value)}`,
        );

        // M1a: page-started location.href, iframe, and window.open to war.html are refused by Electron.
        const pagesBeforePopup = browser.context.pages().length;
        await blindClient.send({
          method: "Runtime.evaluate",
          sessionId: blindSession,
          parameters: {
            expression: `(() => {
              window.open(${JSON.stringify(warUrl)});
              const f = document.createElement("iframe");
              f.src = ${JSON.stringify(warUrl)};
              document.body.appendChild(f);
              location.href = ${JSON.stringify(warUrl)};
              return "attempted";
            })()`,
            returnByValue: true,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(
          connPage.url(),
          `${origin}/connected-check`,
          `M1a failed: connection page navigated to ${connPage.url()}`,
        );
        assert.equal(
          browser.context.pages().length,
          pagesBeforePopup,
          `M1a failed: window.open to ${warUrl} opened a popup (${browser.context.pages().length} vs ${pagesBeforePopup})`,
        );
        sectionChecks.push("M1a, M2, 2a(i), M5, S1");
      } finally {
        runClient?.close();
        blindClient?.close();
        await connPage.close().catch(() => undefined);
      }
    }),
  );

  results.push(
    await runBoundarySection("connected-agent-breakpoints", checks, async (sectionChecks) => {
      const bpPage = await browser.context.createPage();
      let bpClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      try {
        const bpTargetId = await bpPage.targetId();
        router.claimTarget(sessionId, bpTargetId);
        await load(bpPage, `${origin}/connected-check-bp`);
        await waitForDataset(bpPage, "extensionReply");

        // N1: Debugger.setBreakpointByUrl with urlRegex is refused on a connected agent channel, and
        // reloading the page runs no agent code in the content-script world.
        bpClient = router.openStandardClient(sessionId, {
          wholeContext: false,
          connection: true,
          lineage: { attachmentId: "smoke-conn-bp", seedTargetId: bpTargetId },
        });
        const { sessionId: bpSession } = (await bpClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: bpTargetId, flatten: true },
        })) as { sessionId: string };
        await bpClient.send({ method: "Debugger.enable", sessionId: bpSession });
        let bpOutcome = "resolved";
        try {
          await bpClient.send({
            method: "Debugger.setBreakpointByUrl",
            sessionId: bpSession,
            parameters: {
              lineNumber: 0,
              urlRegex: ".*",
              condition:
                'document.documentElement.dataset.bpLeak = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || "page", false',
            },
          });
        } catch (error) {
          bpOutcome = error instanceof Error ? error.message : String(error);
        }
        assert.notEqual(
          bpOutcome,
          "resolved",
          "N1 failed: Debugger.setBreakpointByUrl with urlRegex succeeded on a connected agent channel",
        );
        await load(bpPage, `${origin}/connected-check-bp-reload`);
        await waitForDataset(bpPage, "extensionReply");
        assert.equal(
          await dataset(bpPage, "bpLeak"),
          "",
          "N1 failed: breakpoint condition executed in content-script world after reload",
        );
        sectionChecks.push("N1");
      } finally {
        bpClient?.close();
        await bpPage.close().catch(() => undefined);
      }
    }),
  );

  results.push(
    await runBoundarySection("connected-agent-compromise", checks, async (sectionChecks) => {
      const compPage = await browser.context.createPage();
      let activeClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      let freshClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      try {
        const compTargetId = await compPage.targetId();
        router.claimTarget(sessionId, compTargetId);
        await load(compPage, `${origin}/connected-check-compromise`);
        await waitForDataset(compPage, "extensionReply");

        // M1b + N2 defense in depth: even if Electron's M1a gate were bypassed and the main frame
        // reached chrome-extension: anyway, the router ends EVERY connection channel on the target —
        // including a fresh channel that has NOT enabled Page, Runtime, or sent any ID command.
        activeClient = router.openStandardClient(sessionId, {
          wholeContext: false,
          connection: true,
          lineage: { attachmentId: "smoke-conn-active", seedTargetId: compTargetId },
        });
        const { sessionId: activeSession } = (await activeClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: compTargetId, flatten: true },
        })) as { sessionId: string };
        await activeClient.send({ method: "Runtime.enable", sessionId: activeSession });

        freshClient = router.openStandardClient(sessionId, {
          wholeContext: false,
          connection: true,
          lineage: { attachmentId: "smoke-conn-fresh", seedTargetId: compTargetId },
        });
        const { sessionId: freshSession } = (await freshClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: compTargetId, flatten: true },
        })) as { sessionId: string };
        const waitDetached = (
          client: ReturnType<SessionCdpRouter["openStandardClient"]>,
          sid: string,
        ) =>
          new Promise<boolean>((resolve) => {
            client.onEvent((event) => {
              if (
                event.method === "Target.detachedFromTarget" &&
                event.parameters.sessionId === sid
              )
                resolve(true);
            });
            setTimeout(() => resolve(false), 5_000);
          });
        const activeDetached = waitDetached(activeClient, activeSession);
        const freshDetached = waitDetached(freshClient, freshSession);
        browser.cdp.setConnectionControlled?.(compTargetId, false);
        await contents(compPage).loadURL(warUrl);
        assert.equal(
          await activeDetached,
          true,
          `M1b failed: active connection channel did not emit Target.detachedFromTarget after loading ${warUrl}`,
        );
        assert.equal(
          await freshDetached,
          true,
          `N2 failed: fresh connection channel (no Page/Runtime enable) did not emit Target.detachedFromTarget after loading ${warUrl}`,
        );
        for (const [label, client, sid] of [
          ["active", activeClient, activeSession],
          ["fresh", freshClient, freshSession],
        ] as const) {
          let afterCompromise = "resolved";
          try {
            await client.send({
              method: "Runtime.evaluate",
              sessionId: sid,
              parameters: { expression: "chrome.runtime.id", returnByValue: true },
            });
          } catch (error) {
            afterCompromise = error instanceof Error ? error.message : String(error);
          }
          assert.notEqual(
            afterCompromise,
            "resolved",
            `M1b/N2 failed: Runtime.evaluate succeeded on ${label} channel after entering chrome-extension: page`,
          );
        }
        sectionChecks.push("M1b, N2");
      } finally {
        freshClient?.close();
        activeClient?.close();
        await compPage.close().catch(() => undefined);
      }
    }),
  );

  results.push(
    await runBoundarySection("connected-agent-probes", checks, async (sectionChecks) => {
      const probePage = await browser.context.createPage();
      let probeClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      try {
        const probeTargetId = await probePage.targetId();
        router.claimTarget(sessionId, probeTargetId);
        await load(probePage, `${origin}/nonwar-probe`);
        await contents(probePage).executeJavaScript(`location.href = ${JSON.stringify(nonWarUrl)}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
        console.log(
          `[extensions-smoke] connected-agent: non-connection web page location.href=${nonWarUrl} -> finalUrl=${probePage.url()}`,
        );

        await load(probePage, `${origin}/iframe-probe`);
        const observedFrameNavigations: string[] = [];
        const onProbeFrameNavigate = (details: { url: string }) => {
          observedFrameNavigations.push(details.url);
        };
        contents(probePage).on("will-frame-navigate", onProbeFrameNavigate);
        const iframeResults = (await contents(probePage).executeJavaScript(`
          new Promise((resolve) => {
            const seen = [];
            const done = () => {
              if (seen.length === 3) {
                window.removeEventListener("message", onMessage);
                resolve(seen.sort());
              }
            };
            const onMessage = (event) => {
              if (typeof event.data === "string" && event.data.endsWith("-ok") && !seen.includes(event.data)) {
                seen.push(event.data);
                done();
              }
            };
            window.addEventListener("message", onMessage);
            const dataFrame = document.createElement("iframe");
            dataFrame.src = "data:text/html,<script>parent.postMessage('data-ok','*')</script>";
            document.body.appendChild(dataFrame);
            const blobFrame = document.createElement("iframe");
            blobFrame.src = URL.createObjectURL(
              new Blob(["<script>parent.postMessage('blob-ok','*')</script>"], { type: "text/html" }),
            );
            document.body.appendChild(blobFrame);
            const srcdocFrame = document.createElement("iframe");
            srcdocFrame.srcdoc = "<script>parent.postMessage('srcdoc-ok','*')</script>";
            document.body.appendChild(srcdocFrame);
            setTimeout(() => resolve(seen.sort()), 3000);
          })
        `)) as string[];
        contents(probePage).off("will-frame-navigate", onProbeFrameNavigate);
        assert.deepEqual(
          iframeResults,
          ["blob-ok", "data-ok", "srcdoc-ok"],
          `N4 failed: ordinary non-connection iframes did not all load cleanly; got ${JSON.stringify(iframeResults)}`,
        );
        console.log(
          `[extensions-smoke] connected-agent: will-frame-navigate fired for data=${observedFrameNavigations.some((u) => u.startsWith("data:"))} blob=${observedFrameNavigations.some((u) => u.startsWith("blob:"))} srcdoc=${observedFrameNavigations.some((u) => u.startsWith("about:srcdoc"))} urls=${JSON.stringify(observedFrameNavigations)}`,
        );

        probeClient = router.openStandardClient(sessionId, { wholeContext: false });
        const iframeEvents: { method: string; parameters: CdpParameters }[] = [];
        probeClient.onEvent((event) => iframeEvents.push(event));
        const { sessionId: probeSession } = (await probeClient.send({
          method: "Target.attachToTarget",
          parameters: { targetId: probeTargetId, flatten: true },
        })) as { sessionId: string };
        await probeClient.send({
          method: "Target.setAutoAttach",
          sessionId: probeSession,
          parameters: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        });
        await probeClient.send({
          method: "Runtime.evaluate",
          sessionId: probeSession,
          parameters: {
            expression: `(() => {
              const f = document.createElement("iframe");
              f.id = "probe-frame";
              f.src = ${JSON.stringify(warUrl)};
              document.body.appendChild(f);
            })()`,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const iframeSummary = iframeEvents
          .filter(
            (e) =>
              e.method === "Target.attachedToTarget" || e.method === "Target.detachedFromTarget",
          )
          .map((e) => ({
            method: e.method,
            info: e.parameters.targetInfo,
            sessionId: e.parameters.sessionId,
          }));
        console.log(
          `[extensions-smoke] connected-agent: non-connection iframe->${warUrl} target events=${JSON.stringify(iframeSummary)}`,
        );
        sectionChecks.push("N4, Electron facts #2/#3");
      } finally {
        probeClient?.close();
        await probePage.close().catch(() => undefined);
      }
    }),
  );

  results.push(
    await runBoundarySection("connected-agent-dialog", checks, async (sectionChecks) => {
      const dialogPage = await browser.context.createPage();
      let dialogClient: ReturnType<SessionCdpRouter["openStandardClient"]> | null = null;
      try {
        const dialogTargetId = await dialogPage.targetId();
        router.claimTarget(sessionId, dialogTargetId);
        await load(dialogPage, `${origin}/dialog-s9`);
        const dialogPlatform = await dialogPage.cdp();
        await dialogPlatform.send("Page.enable");
        const dialogOpened = new Promise<void>((resolve) => {
          dialogPlatform.on("Page.javascriptDialogOpening", () => resolve());
        });
        void contents(dialogPage)
          .executeJavaScript('setTimeout(() => alert("s9-dialog"), 0)')
          .catch(() => undefined);
        await withTimeout(dialogOpened, 5_000, {
          timeoutError: () => new Error("S9 failed: alert() dialog did not open"),
        });
        dialogClient = router.openStandardClient(sessionId, {
          wholeContext: false,
          connection: true,
          lineage: { attachmentId: "smoke-conn-s9", seedTargetId: dialogTargetId },
        });
        const { sessionId: dialogSession } = (await withTimeout(
          dialogClient.send({
            method: "Target.attachToTarget",
            parameters: { targetId: dialogTargetId, flatten: true },
          }),
          3_000,
          { timeoutError: () => new Error("S9 failed: connection attach stalled on open alert()") },
        )) as { sessionId: string };
        await withTimeout(
          dialogClient.send({
            method: "Page.handleJavaScriptDialog",
            sessionId: dialogSession,
            parameters: { accept: true },
          }),
          3_000,
          { timeoutError: () => new Error("S9 failed: Page.handleJavaScriptDialog stalled") },
        );
        const afterDialog = (await withTimeout(
          dialogClient.send({
            method: "Runtime.evaluate",
            sessionId: dialogSession,
            parameters: { expression: "1 + 1", returnByValue: true },
          }),
          5_000,
          {
            timeoutError: () =>
              new Error("S9 failed: Runtime.evaluate stalled after dialog dismiss"),
          },
        )) as { result?: { value?: unknown } };
        assert.equal(
          afterDialog.result?.value,
          2,
          `S9 failed: Runtime.evaluate after dialog dismiss returned ${JSON.stringify(afterDialog)}`,
        );
        sectionChecks.push("S9");
      } finally {
        dialogClient?.close();
        await dialogPage.close().catch(() => undefined);
      }
    }),
  );

  return results;
}

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
      manageExtensions: true,
    }),
    /saved browser profile/u,
  );
  await guest.close();
}

async function openProfile(
  launcher: ElectronBrowserLauncher,
  initialize: boolean,
  phaseState: string,
  checkGuest = initialize,
): Promise<LaunchedBrowser> {
  const root = path.join(phaseState, "user-data", "session", "browser-profiles");
  const record = path.join(phaseState, "binding.json");
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
  if (checkGuest) await guestRefuses(launcher);
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

function finish(
  checks: string[],
  extra?: { readonly passed?: boolean; readonly sections?: readonly SectionResult[] },
): void {
  writeFileSync(path.join(state, `result-${phase}.json`), JSON.stringify({ checks, ...extra }));
}

async function spawnPhase(name: Phase): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
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
}

async function driver(): Promise<void> {
  const all: string[] = [];
  const artifacts = process.env.OPENSTEER_EXTENSIONS_E2E_ARTIFACT_DIR;
  const sections: SectionResult[] = [];
  let boundaryPassed = false;
  let lifecyclePassed = false;
  let boundaryError: string | undefined;
  let lifecycleError: string | undefined;

  // 1. Run the connected-agent extension boundary sections first, independent of main's install phase.
  const boundaryCode = await spawnPhase("connected-agent");
  const boundaryResultFile = path.join(state, "result-connected-agent.json");
  if (existsSync(boundaryResultFile)) {
    const parsed = JSON.parse(readFileSync(boundaryResultFile, "utf8")) as {
      checks: string[];
      passed?: boolean;
      sections?: SectionResult[];
    };
    for (const check of parsed.checks) {
      all.push(`connected-agent: ${check}`);
      console.log(`[extensions-smoke] connected-agent: ${check}`);
    }
    if (parsed.sections) sections.push(...parsed.sections);
    boundaryPassed =
      boundaryCode === 0 &&
      parsed.passed === true &&
      boundarySectionNames.every((name) =>
        sections.some((entry) => entry.section === name && entry.passed),
      );
    if (!boundaryPassed) {
      boundaryError = `Connected-agent boundary phase exited ${boundaryCode}.`;
    }
  } else {
    boundaryError = `Connected-agent boundary phase failed before writing results (exit ${boundaryCode}).`;
    for (const name of boundarySectionNames) {
      const missing: SectionResult = {
        section: name,
        passed: false,
        checks: [],
        error: boundaryError,
      };
      writeSectionArtifact(missing);
      sections.push(missing);
      console.error(`[extensions-smoke] section ${name}: FAIL: ${boundaryError}`);
    }
  }
  writeBoundaryArtifacts(
    sections.filter((entry) => entry.section !== "extension-lifecycle"),
    all,
    boundaryPassed,
  );

  // 2. Run main's install -> reopen -> uninstalled lifecycle phases and record their separate section.
  const lifecycleChecks: string[] = [];
  for (const name of ["install", "reopen", "uninstalled"] as const) {
    const code = await spawnPhase(name);
    const result = path.join(state, `result-${name}.json`);
    if (code !== 0 || !existsSync(result)) {
      lifecycleError = `Extensions smoke phase ${name} failed (exit ${code}).`;
      break;
    }
    for (const check of (JSON.parse(readFileSync(result, "utf8")) as { checks: string[] }).checks) {
      all.push(`${name}: ${check}`);
      lifecycleChecks.push(`${name}: ${check}`);
      console.log(`[extensions-smoke] ${name}: ${check}`);
    }
  }
  lifecyclePassed = lifecycleError === undefined;
  const lifecycleSection: SectionResult = {
    section: "extension-lifecycle",
    passed: lifecyclePassed,
    checks: lifecycleChecks,
    ...(lifecycleError ? { error: lifecycleError } : {}),
  };
  writeSectionArtifact(lifecycleSection);
  sections.push(lifecycleSection);
  if (lifecyclePassed) {
    console.log(
      `[extensions-smoke] section extension-lifecycle: PASS (${lifecycleChecks.length} checks)`,
    );
  } else {
    console.error(`[extensions-smoke] section extension-lifecycle: FAIL: ${lifecycleError}`);
  }

  const passed = boundaryPassed && lifecyclePassed;
  const error = [boundaryError, lifecycleError].filter(Boolean).join("; ") || undefined;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      path.join(artifacts, "extensions.json"),
      JSON.stringify(
        {
          passed,
          boundaryPassed,
          lifecyclePassed,
          sections,
          checks: all,
          ...(error ? { error } : {}),
        },
        null,
        2,
      ),
    );
  }
  if (!passed) throw new Error(error ?? "Extensions smoke failed.");
  console.log("[extensions-smoke] passed");
}

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
