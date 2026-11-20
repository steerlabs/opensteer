import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import type { ConnectionCaller } from "../apps/host/src/mcp/agent-caller.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
} from "../apps/host/src/mcp/handlers/browser.js";
import { TabToolHandlers } from "../apps/host/src/mcp/handlers/tabs.js";
import {
  authorizeTabActor,
  authorizeTabTarget,
  canReadTab,
  tabReadAuthority,
} from "../apps/host/src/tabs/tab-authority.js";
import { TabService } from "../apps/host/src/tabs/tab-service.js";
import { BrowserReplService } from "../apps/host/src/browser-use/browser-repl-service.js";
import {
  AgentConnectionStore,
  beginAgentSession,
  sharedChromeAttempts,
  TabStore,
} from "../packages/database/src/index.js";
import { BrowserSourceService } from "../apps/host/src/browser/browser-source-service.js";
import { ChromeSharedTabs } from "../apps/host/src/browser/chrome-shared-tabs.js";
import { HarnessAuthenticationCoordinator } from "../apps/host/src/identity/harness-authentication-coordinator.js";
import { signHostDiscovery } from "../apps/host/src/identity/host-keys.js";
import { createHostServer } from "../apps/host/src/server.js";
import { hostServerTestDependencies } from "../apps/host/src/server/host-server-test-harness.js";
import {
  browserSourceInvitationSigningBytes,
  encodeBrowserSourceInvitation,
} from "../packages/deployment-authority/src/index.js";
import { AgentGrantSchema, TabIdSchema, createId } from "../packages/core/src/index.js";
import { connectionAttempts } from "../packages/database/src/connection-disconnect.js";
import { BrowserSourceStore } from "../packages/database/src/browser-source-store.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import { opensteerChromeLiveTabsExtensionId } from "../packages/protocol/src/browser-sources.js";

const extension = `chrome-extension://${opensteerChromeLiveTabsExtensionId}`;
const repository = resolve(import.meta.dirname, "..");
const disconnectedFrom = (browser: Browser) =>
  new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));

const companionManifest = JSON.parse(
  readFileSync(join(repository, "apps/browser-extension/src/manifest.live-tabs.json"), "utf8"),
) as { permissions: string[] };
const databaseMissing = !process.env.OPENSTEER_TEST_DATABASE_URL;

it.skipIf(databaseMissing)(
  "shares real Chrome with stock Playwright through Home (lifecycle)",
  () => proveChromeShares("lifecycle"),
);
it.skipIf(databaseMissing)(
  "shares real Chrome with stock Playwright through Home (popup isolation)",
  () => proveChromeShares("popup isolation"),
);

it.skipIf(databaseMissing)(
  "grants a selected connected agent one shared Chrome and detaches it on Disconnect",
  () => proveChromeShares("connected agents"),
);

async function proveChromeShares(scenario: "lifecycle" | "popup isolation" | "connected agents") {
  execFileSync("pnpm", ["--filter", "@opensteer/browser-extension", "build:live-tabs"], {
    cwd: repository,
    stdio: "pipe",
  });
  const directory = join(repository, "apps/browser-extension/dist-live-tabs");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    permissions: string[];
    action: { default_popup: string };
  };
  expect(manifest.permissions).toEqual(companionManifest.permissions);
  expect(manifest.permissions).toContain("debugger");
  expect(manifest.permissions).toContain("webNavigation");
  expect(manifest.permissions).not.toContain("cookies");
  const fixture = await createStoreFixture();
  const run = await fixture.startRunFixture("shared-real-chrome");
  const authority = { agentBindingId: `run:${run.runId}`, ownerId: run.userId };
  const key = generateKeyPairSync("ed25519");
  const reserved = createServer().listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const { port } = reserved.address() as AddressInfo;
  await new Promise<void>((done) => reserved.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const ws = origin.replace(/^http/u, "ws");
  const discovery = signHostDiscovery(key, {
    canonicalOrigin: origin,
    deploymentId: run.deploymentId,
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "personal" },
  });
  const deviceId = await fixture.store.requireSelfDeviceId(run.runnerId);
  const liveTabs = new ChromeSharedTabs(fixture.store, {
    attempts: sharedChromeAttempts(fixture.database),
    device: async () => "Hosting computer",
  });
  const sources = new BrowserSourceService({
    deploymentId: run.deploymentId,
    browser: {
      signInTarget: () => Promise.reject(new Error("Unexpected cookie target")),
      applySiteCookies: () => Promise.reject(new Error("Unexpected cookie import")),
    },
    canonicalOrigin: origin,
    pairingDevice: async () => deviceId,
    computerName: async () => "Hosting computer",
    currentRoute: async () => null,
    sign: (bytes) => sign(null, bytes, key.privateKey).toString("base64url"),
    store: new BrowserSourceStore(fixture.database),
    requests: fixture.store.requests,
    liveTabs,
  });
  const home = await createHostServer(
    hostServerTestDependencies({
      browserSources: sources,
      discovery,
      store: fixture.store,
      harnessAuthenticationCoordinator: new HarnessAuthenticationCoordinator({
        harnesses: { getHarnessInstance: async () => null },
        runners: {
          isAvailable: () => false,
          manageHarnessAuthentication: async () => ({ status: "not-started" }),
        },
      }),
    }),
  );
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-tabs-e2e-"));
  let chrome: BrowserContext | undefined;
  const clients: Browser[] = [];
  await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
    close: async () => {
      for (const client of clients) await client.close().catch(() => undefined);
      await chrome?.close();
      sources.close();
      await home.close();
      await rm(scratch, { recursive: true, force: true });
    },
  }));
  const pairing = await sources.createPairing({ ownerId: run.userId, route: null });
  const invitationDocument = {
    version: 2 as const,
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    authority: discovery,
    deploymentName: "Live tab test Home",
    destinations: [{ origin, route: null }],
  };
  const invitation = encodeBrowserSourceInvitation({
    ...invitationDocument,
    signature: sign(
      null,
      browserSourceInvitationSigningBytes(invitationDocument),
      key.privateKey,
    ).toString("base64url"),
  });
  home.get("/test-pair", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        `<a target="_blank" href="${extension}/connect.html#${invitation}">Pair the companion</a>`,
      ),
  );
  home.get("/test-tab/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    return reply.type("text/html").send(`<!doctype html><title>${name}</title>
        <button id="change" onclick="this.textContent='Clicked'">Click</button>
        <button id="popup" onclick="window.open('/test-tab/Popup')">Popup</button>`);
  });
  await home.listen({ host: "127.0.0.1", port });
  const launch = () =>
    chromium.launchPersistentContext(scratch, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
      ignoreDefaultArgs: ["--disable-background-networking"],
    });
  chrome = await launch();
  const worker = chrome.serviceWorkers()[0] ?? (await chrome.waitForEvent("serviceworker"));
  const warnings = await worker.evaluate(async (manifestText) => {
    const api = (
      globalThis as typeof globalThis & {
        chrome: {
          management: { getPermissionWarningsByManifest(manifest: string): Promise<string[]> };
        };
      }
    ).chrome;
    return api.management.getPermissionWarningsByManifest(manifestText);
  }, JSON.stringify(manifest));
  expect(warnings).toEqual([
    "Access the page debugger backend",
    "Read and change all your data on all websites",
  ]);
  const pairingPage = await chrome.newPage();
  await pairingPage.goto(`${origin}/test-pair`);
  const opened = chrome.waitForEvent("page");
  await pairingPage.getByRole("link", { name: "Pair the companion" }).click();
  const connect = await opened;
  await expect.poll(() => connect.title()).toContain("Connect Chrome");
  await connect.getByText(/The agent can act as you, in a tab you share/).waitFor();
  await connect.getByText(/uses Chrome.s navigation permission to follow sign-in popups/).waitFor();
  const closed = connect.waitForEvent("close");
  await connect.getByRole("button", { name: "Pair Live Tabs" }).click();
  await closed;
  const sourceId = await expect
    .poll(async () =>
      (await sources.listState({ ownerId: run.userId })).sources.some(
        (source) => source.connected && source.capability === "live-tabs",
      ),
    )
    .toBe(true)
    .then(async () => (await sources.listState({ ownerId: run.userId })).sources[0]!.id);
  expect(
    (await sources.inspect({ ownerId: run.userId, url: "https://github.com/" })).candidates,
  ).toEqual([]);
  const popup = await chrome.newPage();
  await popup.goto(`${extension}/${manifest.action.default_popup}`);
  const share = async (chromeContext: BrowserContext, extensionPopup: Page, page: Page) => {
    const companion =
      chromeContext.serviceWorkers()[0] ?? (await chromeContext.waitForEvent("serviceworker"));
    type Api = { tabs: { query(options: object): Promise<{ id: number; url: string }[]> } };
    const tabId = await companion.evaluate(async (url) => {
      const api = (globalThis as typeof globalThis & { chrome: Api }).chrome;
      return (await api.tabs.query({})).find((tab) => tab.url === url)!.id;
    }, page.url());
    const result = await extensionPopup.evaluate(
      async (message) => {
        const api = (
          globalThis as typeof globalThis & {
            chrome: { runtime: { sendMessage(message: unknown): Promise<{ ok: boolean }> } };
          }
        ).chrome;
        return api.runtime.sendMessage(message);
      },
      { type: "ui.tab.share", sourceId, tabId },
    );
    expect(result.ok).toBe(true);
    await expect
      .poll(async () =>
        (await liveTabs.listForBinding(authority)).some((tab) => tab.url === page.url()),
      )
      .toBe(true);
    return (await liveTabs.listForBinding(authority)).find((tab) => tab.url === page.url())!.tabId;
  };
  const issue = (tabId: string) => liveTabs.issueStandardCdpTicket({ authority, tabId });
  const attach = async (tabId: string, actor = authority) => {
    const ticket = await liveTabs.issueStandardCdpTicket({ authority: actor, tabId });
    const client = await chromium.connectOverCDP(ws + ticket.path, { noDefaults: true });
    clients.push(client);
    return client;
  };
  const first = await chrome.newPage();
  const other = await chrome.newPage();
  await first.goto(`${origin}/test-tab/First`);
  await other.goto(`${origin}/test-tab/Other`);
  const firstId = await share(chrome, popup, first);
  const otherId = await share(chrome, popup, other);
  if (scenario === "connected agents") {
    const ownerId = run.userId;
    const connections = new AgentConnectionStore(fixture.database);
    const unexpected = async (): Promise<never> => {
      throw new Error("Expected shared Chrome only");
    };
    const tabs = new TabService({
      store: new TabStore(fixture.database),
      sharedChromeTabs: (actor) => {
        if (actor.kind === "browser-binding")
          return liveTabs.tabPlaces(actor.authority.ownerId, {
            kind: "binding",
            bindingId: actor.authority.agentBindingId,
          });
        if (actor.kind === "connection")
          return liveTabs.tabPlaces(actor.caller.userId, {
            kind: "connection",
            agentConnectionId: actor.caller.connectionId,
          });
        return unexpected();
      },
      devices: fixture.store,
      pages: {
        open: unexpected,
        state: unexpected,
        bind: unexpected,
        activate: unexpected,
        closeViewers: unexpected,
      },
      nativeTargets: {
        resolveWindow: unexpected,
        windowState: unexpected,
        phoneState: unexpected,
        openOwnerView: unexpected,
        closeOwnerViews: unexpected,
        onTargetAcquired: () => () => {},
      },
      apps: { get: unexpected },
      computer: unexpected,
      canRead: canReadTab,
      readAuthority: tabReadAuthority,
      canReadTask: async () => true,
      authorize: authorizeTabTarget,
      authorizeMembership: authorizeTabActor,
      onError: (error) => {
        throw error;
      },
    });
    const scripts = new BrowserScriptService({
      store: fixture.store,
      tabs,
      sharedChromeTabs: liveTabs,
      browser: {
        attachCdpForAgent: unexpected,
        flushPendingTabDescriptors: unexpected,
        listAgentProfiles: unexpected,
        tabOccupants: () => [],
        detachAgentSessionsForBinding: async () => {},
        browserBindingEnded: () => false,
      },
    });
    const sessions = new AgentSessionService({ store: fixture.store, holdMs: 0 });
    const tabTools = new TabToolHandlers(tabs, sessions);
    const browserTools = new BrowserToolHandlers({
      sessions,
      sharedChromeTabs: liveTabs,
      tabs,
      scripts,
      confinement: new BrowserScriptConfinement(),
      profiles: async () => [],
      requireDevice: unexpected,
      issueTicket: unexpected,
      origin: new URL(origin),
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        sessions.stop();
        await scripts.close();
        tabs.dispose();
      },
    }));
    const session = async (label: string, granted: boolean) => {
      const connection = await connections.create({
        userId: ownerId,
        label,
        clientName: label,
        accessMode: "full-access",
        resource: origin,
        expiresAt: new Date(Date.now() + 60_000),
        grant: AgentGrantSchema.parse({
          scope: "selected",
          tasks: false,
          resources: granted ? [{ kind: "chrome-tabs", sourceId }] : [],
        }),
      });
      expect(await connections.activate(connection.id, crypto.randomUUID())).toBe(true);
      const { session } = await beginAgentSession(fixture.database, {
        userId: ownerId,
        agentConnectionId: connection.id,
      });
      const subject = { kind: "binding" as const, bindingId: `session:${session.id}` };
      const caller: ConnectionCaller = {
        kind: "connection",
        key: `connection:${connection.id}`,
        userId: ownerId,
        connectionId: connection.id,
        grant: connection.grant,
        grantRevision: connection.grantRevision,
        accessMode: connection.accessMode,
      };
      return {
        caller,
        connectionId: connection.id,
        authority: { ownerId, agentBindingId: subject.bindingId },
        subject,
      };
    };
    expect(await sources.grantableChromeTabs(ownerId)).toEqual([
      { sourceId, computerName: "Hosting computer", paired: true },
    ]);
    const denied = await session("No Chrome grant", false);
    expect(await liveTabs.listForBinding(denied.authority)).toEqual([]);
    expect(
      await tabTools.tab_list({ caller: denied.caller, input: {}, operationKey: "denied-list" }),
    ).toMatchObject({ status: "completed", tabs: [] });
    const firstTab = TabIdSchema.parse(firstId);
    await expect(
      browserTools.browser_connect({
        caller: denied.caller,
        input: { tabId: firstTab },
        operationKey: "denied-cdp",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await liveTabs.tabPlaces(ownerId, denied.subject)).toEqual([]);
    await expect(
      liveTabs.issueStandardCdpTicket({ authority: denied.authority, tabId: firstId }),
    ).rejects.toMatchObject({ message: "This Chrome tab is no longer shared." });
    const deniedRepl = new BrowserReplService({
      port: liveTabs.browserUsePort(async () => denied.authority, firstId),
    });
    try {
      const result = await deniedRepl.execute(
        "denied",
        `return (await pages()).length + ":" + await openPage(${JSON.stringify(firstId)}).then(() => "opened", e => e.message);`,
      );
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify("0:This Chrome tab is no longer shared.") },
      ]);
    } finally {
      await deniedRepl.close();
    }

    const allowed = await session("First Chrome agent", true);
    const isolated = await session("Second Chrome agent", true);
    expect(await liveTabs.tabPlaces(ownerId, allowed.subject)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabId: firstId,
          sharedByPerson: { sourceId, computerName: "Hosting computer" },
        }),
      ]),
    );
    const firstTicket = await browserTools.browser_connect({
      caller: allowed.caller,
      input: { tabId: firstTab },
      operationKey: "first-cdp",
    });
    expect(firstTicket).toMatchObject({ status: "completed", mode: "session" });
    const firstClient = await chromium.connectOverCDP(firstTicket.endpoint!, { noDefaults: true });
    clients.push(firstClient);
    const secondClient = await attach(otherId, isolated.authority);
    const [firstPage] = firstClient.contexts()[0]!.pages();
    const [otherPage] = secondClient.contexts()[0]!.pages();
    expect(await firstPage!.title()).toBe("First");
    expect(await otherPage!.title()).toBe("Other");
    expect(await liveTabs.listForBinding(allowed.authority)).toEqual([
      expect.objectContaining({ tabId: firstId }),
    ]);
    await expect(
      liveTabs.issueStandardCdpTicket({ authority: allowed.authority, tabId: otherId }),
    ).rejects.toThrow("Another agent");
    const listing = await tabTools.tab_list({
      caller: allowed.caller,
      input: { query: "Hosting computer" },
      operationKey: "granted-list",
    });
    expect(listing).toMatchObject({
      status: "completed",
      tabs: [
        expect.objectContaining({
          tabId: firstId,
          sharedByPerson: { sourceId, computerName: "Hosting computer" },
        }),
      ],
    });
    const driven = await browserTools.browser_use({
      caller: allowed.caller,
      operationKey: "drive-first",
      input: {
        tabId: firstTab,
        code: `globalThis.tab = await openPage(${JSON.stringify(firstId)}); await tab.locator("#change").click(); return await tab.js("document.querySelector('#change').textContent");`,
      },
    });
    expect(driven.content).toEqual([{ type: "text", text: JSON.stringify("Clicked") }]);
    await expect(otherPage!.locator("#change").textContent()).resolves.toBe("Click");
    const disconnected = disconnectedFrom(firstClient);
    await popup.reload();
    await popup.getByRole("button", { name: "Stop sharing First" }).click();
    await disconnected;
    const refused = await scripts.runBrowserScript({
      authority: allowed.authority,
      sharedChromeTabId: firstId,
      contextKey: `chrome:${firstId}`,
      code: `return await openPage(${JSON.stringify(firstId)});`,
    });
    expect(refused.structuredContent?.error).toMatchObject({
      code: "forbidden",
      message: "This Chrome tab is no longer shared.",
    });
    await expect(otherPage!.title()).resolves.toBe("Other");

    const extensionDebugger = () =>
      worker.evaluate(async (url) => {
        const api = (
          globalThis as typeof globalThis & {
            chrome: {
              debugger: {
                sendCommand(target: { tabId: number }, method: string): Promise<unknown>;
              };
              tabs: { query(options: object): Promise<{ id: number; url: string }[]> };
            };
          }
        ).chrome;
        const tabId = (await api.tabs.query({})).find((tab) => tab.url === url)!.id;
        return api.debugger.sendCommand({ tabId }, "Page.getFrameTree");
      }, other.url());
    await expect(extensionDebugger()).resolves.toMatchObject({ frameTree: expect.any(Object) });
    const otherEnded = disconnectedFrom(secondClient);
    expect(await connections.revoke(ownerId, isolated.connectionId)).toBe(true);
    expect(await connectionAttempts(fixture.database, isolated.connectionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "shared-chrome", terminalEvidenceAt: null }),
      ]),
    );
    expect(
      (await connections.list(ownerId, { includeRevoked: true })).find(
        ({ id }) => id === isolated.connectionId,
      )?.state,
    ).toBe("stopping");
    const cleanup = await fixture.store.driveConnectionCleanups({
      stopper: {
        async stop(attempt) {
          if (attempt.kind === "shared-chrome") await liveTabs.stopAttempt(attempt.id);
        },
      },
    });
    expect(cleanup.failures).toEqual([]);
    expect(cleanup.settled).toContain(isolated.connectionId);
    await otherEnded;
    expect(
      (await connections.list(ownerId, { includeRevoked: true })).find(
        ({ id }) => id === isolated.connectionId,
      )?.state,
    ).toBe("stopped");
    await expect(extensionDebugger()).rejects.toThrow(/not attached/i);
    expect(other.isClosed()).toBe(false);
    return;
  }
  const client = await attach(firstId);
  await chrome.addCookies([{ name: "fixture", value: "fixture-session", url: origin }]);
  const repl = liveTabs.browserUsePort(async () => authority);
  const replCall = {
    contextKey: "chrome-repl",
    signal: AbortSignal.timeout(5_000),
    deadline: Date.now() + 5_000,
    maxBytes: 100_000,
    maxDepth: 16,
    maxEntries: 1000,
  };
  const selected = await repl.openPage(firstId, replCall);
  const unsubscribe = repl.subscribe(
    selected,
    () => {},
    () => {},
    replCall,
  );
  try {
    expect(
      JSON.parse(
        await repl.command(
          selected,
          "Runtime.evaluate",
          {
            expression: "document.title",
            returnByValue: true,
          },
          undefined,
          replCall,
        ),
      ),
    ).toMatchObject({ result: { value: "First" } });
    const reads: unknown = JSON.parse(
      await repl.command(
        selected,
        "Network.getCookies",
        {
          urls: [origin],
        },
        undefined,
        replCall,
      ),
    );
    expect(reads).toMatchObject({
      cookies: [expect.objectContaining({ name: "fixture", value: "fixture-session" })],
    });
  } finally {
    unsubscribe();
  }
  const context = client.contexts()[0]!;
  expect(context.pages()).toHaveLength(1);
  const page = context.pages()[0]!;
  expect(await page.title()).toBe("First");
  await expect(context.newCDPSession(page)).rejects.toThrow("Target.attachToBrowserTarget");
  await expect(context.cookies()).rejects.toThrow("requires a whole browser context grant");
  await page.goto(`${origin}/test-tab/Driven`);
  expect(await page.evaluate(() => document.title)).toBe("Driven");
  await page.locator("#change").click();
  expect(await page.locator("#change").textContent()).toBe("Clicked");
  expect((await page.screenshot()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  if (scenario === "popup isolation") {
    await other.bringToFront();
    const next = page.waitForEvent("popup");
    void next.catch(() => undefined);
    const realPopup = chrome.waitForEvent("page");
    await page.locator("#popup").click();
    await (await realPopup).waitForLoadState();
    await expect
      .poll(async () => (await liveTabs.listForBinding(authority)).map((tab) => tab.title))
      .toContain("Popup");
    await expect.poll(() => context.pages().length).toBe(2);
    expect(await (await next).title()).toBe("Popup");
    expect(await Promise.all(context.pages().map((p) => p.title()))).toEqual(["Driven", "Popup"]);
    return;
  }
  await popup.reload();
  const disconnected = disconnectedFrom(client);
  await popup.getByRole("button", { name: "Stop sharing Driven" }).click();
  await disconnected;
  await expect(page.evaluate(() => 1)).rejects.toThrow("closed");
  await expect(issue(firstId)).rejects.toThrow("no longer shared");
  expect(first.isClosed()).toBe(false);

  const second = await attach(otherId);
  const tabClosed = disconnectedFrom(second);
  await other.close();
  await tabClosed;
  await expect(issue(otherId)).rejects.toThrow("no longer shared");
  const persisted = await share(chrome, popup, first);
  expect(persisted).not.toBe(firstId);
  await chrome.close();
  chrome = await launch();
  await expect
    .poll(async () => (await sources.listState({ ownerId: run.userId })).sources[0]?.connected)
    .toBe(true);
  expect(await liveTabs.listForBinding(authority)).toEqual([]);
  await expect(issue(persisted)).rejects.toThrow("no longer shared");
  const restartedPopup = await chrome.newPage();
  await restartedPopup.goto(`${extension}/${manifest.action.default_popup}`);
  const restartPage = await chrome.newPage();
  await restartPage.goto(`${origin}/test-tab/Revoked`);
  const last = await attach(await share(chrome, restartedPopup, restartPage));
  const revoked = disconnectedFrom(last);
  expect(await sources.revokeSource({ ownerId: run.userId, sourceId })).toBe(true);
  await revoked;
  expect(await liveTabs.listForBinding(authority)).toEqual([]);
}
