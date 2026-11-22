import { discoverHandler } from "../apps/host/src/mcp/handlers/discover.js";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import { fixtureConnectionCaller } from "./connection-caller.test-support.js";
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
import {
  AgentGrantSchema,
  RequestIdSchema,
  TabIdSchema,
  createId,
  type ThreadAccessMode,
} from "../packages/core/src/index.js";
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

it.skipIf(databaseMissing)(
  "ends shared Chrome browser_connect and in-flight browser_use when the task mode is lowered",
  () => proveChromeShares("mode downgrade"),
);

it
  .skipIf(databaseMissing)
  .each([
    "same Home",
    "restarted Home",
    "connected wire 7",
    "connected wire 7 with a popup",
    "reconnected wire 7",
  ] as const)(
  "checks shared Chrome Disconnect evidence from a late receipt on the %s",
  async (home) => {
    const fixture = await createStoreFixture();
    const { userId: ownerId, runnerId } = await fixture.createRunFixture("chrome-detach-receipt");
    const deviceId = await fixture.store.requireSelfDeviceId(runnerId);
    const sourceId = createId("browserSource");
    const shareId = crypto.randomUUID();
    const replay = home === "same Home" || home === "restarted Home";
    const popupId = home === "connected wire 7 with a popup" ? crypto.randomUUID() : undefined;
    const connections = new AgentConnectionStore(fixture.database);
    const connection = await connections.create({
      userId: ownerId,
      label: "Late detach",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: AgentGrantSchema.parse({
        scope: "selected",
        tasks: false,
        resources: [{ kind: "chrome-tabs", sourceId }],
      }),
    });
    expect(await connections.activate(connection.id, crypto.randomUUID())).toBe(true);
    const { session } = await beginAgentSession(fixture.database, {
      userId: ownerId,
      agentConnectionId: connection.id,
    });
    const authority = { ownerId, agentBindingId: `session:${session.id}` };
    const newHome = () =>
      new ChromeSharedTabs(fixture.store, {
        attempts: sharedChromeAttempts(fixture.database),
        device: async () => "Hosting computer",
      });
    let homeTabs = newHome();
    const connectChrome = (id = sourceId) =>
      homeTabs.connectSource({
        ownerId,
        sourceId: id,
        deviceId,
        name: "Chrome",
        detachReceipts: true,
        detachReplay: replay,
        write: () => true,
        fail: () => {},
      });
    const attempts = () => connectionAttempts(fixture.database, connection.id);
    const state = async () =>
      (await connections.list(ownerId, { includeRevoked: true })).find(
        ({ id }) => id === connection.id,
      )?.state;
    const drive = () =>
      fixture.store.driveConnectionCleanups({
        stopper: {
          async stop(attempt) {
            if (attempt.kind === "shared-chrome") await homeTabs.stopAttempt(attempt.id);
          },
        },
      });
    try {
      let chrome = connectChrome();
      await chrome.receive({
        type: "tab.shared",
        shareId,
        targetId: "fixture-target",
        title: "Fixture",
        url: "https://fixture.test/",
      });
      if (popupId)
        await chrome.receive({
          type: "tab.shared",
          shareId: popupId,
          targetId: "fixture-popup",
          title: "Popup",
          url: "https://fixture.test/popup",
          openerShareId: shareId,
        });
      const port = homeTabs.browserUsePort(async () => authority, shareId);
      await port.openPage(shareId, {
        contextKey: "fixture",
        signal: new AbortController().signal,
        deadline: Date.now() + 5_000,
        maxBytes: 4096,
        maxDepth: 16,
        maxEntries: 256,
      });
      expect(await connections.revoke(ownerId, connection.id)).toBe(true);
      const attempt = (await attempts()).find(({ kind }) => kind === "shared-chrome");
      expect(attempt?.terminalEvidenceAt).toBeNull();
      if (!attempt) throw new Error("Expected a shared Chrome attempt");
      if (home !== "restarted Home") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const stopped = homeTabs.stopAttempt(attempt.id);
          await vi.advanceTimersByTimeAsync(10_000);
          await stopped;
        } finally {
          vi.useRealTimers();
        }
      } else {
        homeTabs.close();
        await sharedChromeAttempts(fixture.database).recover();
        homeTabs = newHome();
        chrome = connectChrome();
      }

      if (home === "reconnected wire 7") {
        chrome.close();
        chrome = connectChrome();
      }

      expect((await drive()).settled).not.toContain(connection.id);
      expect(await state()).toBe("stopping");
      const unrelated = connectChrome(createId("browserSource"));
      await unrelated.receive({ type: "tab.detached", shareId });
      await chrome.receive({ type: "tab.detached", shareId: crypto.randomUUID() });
      expect(await attempts()).toContainEqual(
        expect.objectContaining({
          id: attempt.id,
          terminalEvidenceAt: null,
          contactLostAt: expect.any(Date),
        }),
      );

      await chrome.receive({ type: "tab.detached", shareId });
      if (home === "reconnected wire 7") {
        expect(await attempts()).toContainEqual(
          expect.objectContaining({ id: attempt.id, terminalEvidenceAt: null }),
        );
        expect((await drive()).settled).not.toContain(connection.id);
        expect(await state()).toBe("stopping");
        return;
      }
      if (popupId) {
        expect(await attempts()).toContainEqual(
          expect.objectContaining({ id: attempt.id, terminalEvidenceAt: null }),
        );
        await chrome.receive({ type: "tab.detached", shareId: popupId });
      }
      const ended = (await attempts()).find(({ id }) => id === attempt.id);
      expect(ended?.terminalEvidenceAt).toBeInstanceOf(Date);
      await chrome.receive({ type: "tab.detached", shareId });
      expect((await attempts()).find(({ id }) => id === attempt.id)).toEqual(ended);
      expect(await drive()).toEqual({ failures: [], settled: [connection.id] });
      expect(await state()).toBe("stopped");
    } finally {
      homeTabs.close();
    }
  },
);

let companionBuilt = false;

async function proveChromeShares(
  scenario: "lifecycle" | "popup isolation" | "connected agents" | "mode downgrade",
) {
  if (!companionBuilt) {
    execFileSync("pnpm", ["--filter", "@opensteer/browser-extension", "build:live-tabs"], {
      cwd: repository,
      stdio: "pipe",
    });
    companionBuilt = true;
  }
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
  await connect.getByRole("button", { name: "Pair Chrome tab sharing", exact: true }).click();
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
            chrome: {
              runtime: {
                sendMessage(message: unknown): Promise<{ ok: boolean; tabShareReason?: string }>;
              };
            };
          }
        ).chrome;
        return api.runtime.sendMessage(message);
      },
      { type: "ui.tab.share", sourceId, tabId },
    );
    if (result.ok !== true) {
      const target = await companion.evaluate(async (id) => {
        const api = (
          globalThis as typeof globalThis & {
            chrome: { debugger: { getTargets(): Promise<{ tabId?: number; type: string }[]> } };
          }
        ).chrome;
        return (await api.debugger.getTargets()).find((target) => target.tabId === id)?.type;
      }, tabId);
      const paired = (await sources.listState({ ownerId: run.userId })).sources.find(
        (source) => source.id === sourceId,
      );
      expect(
        result.ok,
        `Share ${page.url()}: ${result.tabShareReason ?? "no reason"}, companion connected=${paired?.connected}, Chrome target=${target}`,
      ).toBe(true);
    }
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
  if (scenario === "connected agents" || scenario === "mode downgrade") {
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
        detachAgentSessionsForBinding: async () => [],
        browserBindingEnded: () => false,
      },
    });
    const bindingClosures = new Map<string, Promise<void[]>>();
    const sessions = new AgentSessionService({
      store: fixture.store,
      holdMs: 0,
      closeBinding: (bindingId, reason) => {
        bindingClosures.set(
          bindingId,
          Promise.all([
            liveTabs.closeForBinding(bindingId, reason),
            scripts.closeBrowserScriptsForBinding(bindingId),
          ]),
        );
      },
    });
    const allow = async (id: unknown) => {
      const requestId = RequestIdSchema.parse(id);
      const request = await fixture.database
        .selectFrom("requests")
        .select("revision")
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      await sessions.respond({
        requestId,
        expectedRevision: request.revision,
        resolvedBy: ownerId,
        response: { kind: "form", answers: { decision: ["allow"] } },
      });
    };
    const driveCleanups = () =>
      fixture.store.driveConnectionCleanups({
        stopper: {
          async stop(attempt) {
            if (attempt.kind === "shared-chrome") await liveTabs.stopAttempt(attempt.id);
          },
        },
      });
    const tabTools = new TabToolHandlers(tabs, sessions);
    const discover = discoverHandler(
      {
        tab_list: (call) => tabTools.tab_list(call),
        browser_profile_list: async () => ({ profiles: [], sites: [] }),
      },
      { tabs, browserSources: sources, store: fixture.store },
    );
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
    const session = async (
      label: string,
      granted: boolean,
      accessMode: ThreadAccessMode = "full-access",
    ) => {
      const connection = await connections.create({
        userId: ownerId,
        label,
        clientName: label,
        accessMode,
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
      const caller = fixtureConnectionCaller(connection);
      return {
        caller,
        session,
        connectionId: connection.id,
        authority: { ownerId, agentBindingId: subject.bindingId },
        subject,
      };
    };
    if (scenario === "mode downgrade") {
      const agent = await session("Chrome task whose mode is lowered", true);
      const taskId = agent.session.threadId;
      const input = { taskId, tabId: TabIdSchema.parse(firstId) };
      const connect = (operationKey: string) =>
        browserTools.browser_connect({ caller: agent.caller, input, operationKey });
      const ticket = await connect("full-access-cdp");
      expect(ticket).toMatchObject({ status: "completed", mode: "session" });
      const client = await chromium.connectOverCDP(ticket.endpoint!, { noDefaults: true });
      clients.push(client);
      const cdp = await client.contexts()[0]!.newCDPSession(client.contexts()[0]!.pages()[0]!);
      await expect(
        cdp.send("Runtime.evaluate", { expression: "document.title" }),
      ).resolves.toMatchObject({ result: { value: "First" } });
      // The person's own Chrome clipboard is in no grant: a paste or copy is refused, unsent.
      for (const key of ["v", "c"])
        await expect(
          cdp.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            modifiers: 4,
            key,
            code: `Key${key.toUpperCase()}`,
          }),
        ).rejects.toThrow(
          "The clipboard is not available to a connected agent. Use Input.insertText to enter text.",
        );
      // Nor the person's camera, microphone or location: no browser permission changes.
      for (const [method, parameters] of [
        ["Browser.grantPermissions", { permissions: ["audioCapture"] }],
        ["Browser.grantPermissions", { permissions: ["videoCapture"] }],
        ["Browser.grantPermissions", { permissions: ["geolocation"] }],
        ["Browser.grantPermissions", { permissions: ["clipboardReadWrite"] }],
        ["Browser.resetPermissions", {}],
      ] as const)
        await expect(
          (cdp as unknown as { send(m: string, p: object): Promise<unknown> }).send(
            method,
            parameters,
          ),
          method,
        ).rejects.toThrow("Browser permissions cannot be changed by a connected agent.");
      // A shared tab is one tab: its own cookies, never the rest of the person's Chrome.
      const tabOrigin = new URL(first.url()).origin;
      await chrome.addCookies([
        { name: "tab", value: "this-tab", url: tabOrigin },
        { name: "elsewhere", value: "sentinel-elsewhere", url: "https://elsewhere.test/" },
      ]);
      const send = cdp as unknown as { send(m: string, p?: object): Promise<unknown> };
      for (const [method, parameters] of [
        ["Network.getAllCookies", {}],
        ["Storage.getCookies", {}],
        ["Network.getCookies", { urls: ["https://elsewhere.test/"] }],
      ] as const)
        await expect(send.send(method, parameters), method).rejects.toThrow(
          /connected agent|whole browser context/u,
        );
      const own = (await send.send("Network.getCookies", {})) as { cookies: { name: string }[] };
      expect(own.cookies.map(({ name }) => name)).toEqual(["tab"]);
      // The same through browser_use on the same shared tab.
      const cookieScript = (await browserTools.browser_use({
        caller: agent.caller,
        operationKey: "shared-cookies",
        input: {
          ...input,
          code: `
            const page = await openPage(${JSON.stringify(firstId)});
            const seen = [];
            for (const [method, params] of [["Network.getAllCookies", {}], ["Storage.getCookies", {}], ["Network.getCookies", { urls: ["https://elsewhere.test/"] }], ["Network.getCookies", {}]]) {
              try { seen.push(method + ": " + JSON.stringify((await page.cdp(method, params)).cookies.map((cookie) => cookie.name))); }
              catch (error) { seen.push(method + ": refused " + String(error && error.message)); }
            }
            return "outcome:" + encodeURIComponent(JSON.stringify(seen)) + ":end";
          `,
        },
      })) as { content: unknown };
      const seen = JSON.parse(
        decodeURIComponent(/outcome:([^:"\\]*):end/u.exec(JSON.stringify(cookieScript))![1]!),
      ) as string[];
      expect(seen.slice(0, 3)).toEqual([
        expect.stringMatching(/^Network\.getAllCookies: refused /u),
        expect.stringMatching(/^Storage\.getCookies: refused /u),
        expect.stringMatching(/^Network\.getCookies: refused /u),
      ]);
      expect(seen[3]).toBe('Network.getCookies: ["tab"]');
      expect(JSON.stringify(seen)).not.toContain('elsewhere"');
      const attempts = async () => {
        const row = await fixture.database
          .selectFrom("agentConnections")
          .select("sharedChromeAttempts")
          .where("id", "=", agent.connectionId)
          .executeTakeFirstOrThrow();
        return Object.values(row.sharedChromeAttempts);
      };
      expect(await attempts()).toEqual([
        expect.objectContaining({
          shareId: firstId,
          sourceId,
          threadId: taskId,
          mode: "full-access",
        }),
      ]);

      const script = browserTools
        .browser_use({
          caller: agent.caller,
          operationKey: "full-access-script",
          input: {
            ...input,
            code: `await (await openPage(${JSON.stringify(firstId)})).js("new Promise(resolve => { window.finishScript = resolve; })");`,
          },
        })
        .catch((error: unknown) => error);
      await first.waitForFunction(() => typeof Reflect.get(window, "finishScript") === "function");
      const disconnected = disconnectedFrom(client);
      const { thread } = await fixture.store.updateThreadAccessMode({
        threadId: taskId,
        requestedBy: ownerId,
        accessMode: "approval-required",
      });
      await sessions.lowerTaskMode(taskId, thread.accessMode);
      expect(await script).toMatchObject({
        blocked: { code: "access_changed" },
        receipt: { status: "unknown" },
      });
      await expect(
        fixture.database
          .selectFrom("agentOperations")
          .select("outcome")
          .where("sessionId", "=", agent.session.id)
          .where("operationKey", "=", "full-access-script")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ outcome: "unknown" });
      await disconnected;
      await expect(
        cdp.send("Runtime.evaluate", {
          expression: "document.getElementById('change').click()",
        }),
      ).rejects.toThrow(/closed/i);
      await first.evaluate(() => {
        Reflect.get(window, "finishScript")("finished");
      });
      await expect.poll(attempts).toEqual([]);
      await expect(first.locator("#change").textContent()).resolves.toBe("Click");
      expect(await liveTabs.listForBinding(agent.authority)).toEqual(
        expect.arrayContaining([expect.objectContaining({ tabId: firstId })]),
      );

      expect(await share(chrome, popup, first)).toBe(firstId);

      const fresh = await connect("approval-required-cdp");
      expect(fresh).toMatchObject({ status: "pending", requestId: expect.any(String) });
      expect(fresh.endpoint).toBeUndefined();
      return;
    }
    expect(await sources.grantableChromeTabs(ownerId)).toEqual([
      { sourceId, computerName: "Hosting computer", paired: true },
    ]);
    const denied = await session("No Chrome grant", false);
    expect(await liveTabs.listForBinding(denied.authority)).toEqual([]);
    expect(
      await discover({
        caller: denied.caller,
        input: {},
        operationKey: "denied-list",
      }),
    ).toEqual({ items: [], nextCursor: null });
    const deniedRead = (id: string) =>
      discover({
        caller: denied.caller,
        input: { id },
        operationKey: "denied-source",
      }).catch((error: unknown) => error);
    const hidden = await deniedRead(sourceId);
    expect(hidden).toMatchObject({ code: "not_found", message: "That item is unavailable." });
    expect(hidden).toEqual(await deniedRead(createId("browserSource")));
    expect(
      await tabTools.tab_list({
        caller: denied.caller,
        input: {},
        operationKey: "denied-all-tabs",
      }),
    ).toMatchObject({ status: "completed", operationId: expect.any(String), tabs: [] });
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

    const allowed = await session("First Chrome agent", true, "auto-accept-edits");
    await expect(
      fixture.store.admitExecution({ ownerUserId: ownerId, subject: allowed.subject }),
    ).resolves.toMatchObject({ mode: "auto-accept-edits" });
    const isolated = await session("Second Chrome agent", true);
    expect(await liveTabs.tabPlaces(ownerId, allowed.subject)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabId: firstId,
          sharedByPerson: { sourceId, computerName: "Hosting computer" },
        }),
      ]),
    );
    const approvedConnect = async (tabId: string, operationKey: string) => {
      const connect = () =>
        browserTools.browser_connect({
          caller: allowed.caller,
          input: { tabId: TabIdSchema.parse(tabId), taskId: allowed.session.threadId },
          operationKey,
        });
      const pending = await connect();
      expect(pending).toMatchObject({ status: "pending", requestId: expect.any(String) });
      expect(pending.endpoint).toBeUndefined();
      await allow(pending.requestId);
      const ticket = await connect();
      expect(ticket).toMatchObject({ status: "completed", mode: "session" });
      const client = await chromium.connectOverCDP(ticket.endpoint!, { noDefaults: true });
      clients.push(client);
      return client;
    };
    const firstClient = await approvedConnect(firstId, "first-cdp");
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
    expect(
      await tabTools.tab_list({
        caller: allowed.caller,
        input: { query: "Hosting computer" },
        operationKey: "granted-all-tabs",
      }),
    ).toMatchObject({
      status: "completed",
      tabs: [{ tabId: firstId, sharedByPerson: { sourceId, computerName: "Hosting computer" } }],
    });
    const listing = await discover({
      caller: allowed.caller,
      input: { id: sourceId, query: "Hosting computer" },
      operationKey: "granted-list",
    });
    expect(listing).toMatchObject({
      status: "completed",
      item: { id: sourceId, kind: "chrome-tabs", computer: "Hosting computer" },
      items: [{ id: firstId, kind: "tab", computer: "Hosting computer", untrusted: true }],
    });
    const drive = () =>
      browserTools.browser_use({
        caller: allowed.caller,
        operationKey: "drive-first",
        input: {
          tabId: firstTab,
          taskId: allowed.session.threadId,
          code: `globalThis.tab = await openPage(${JSON.stringify(firstId)}); await tab.locator("#change").click(); return await tab.js("document.querySelector('#change').textContent");`,
        },
      });
    const pendingScript = await drive();
    expect(pendingScript.structuredContent).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });
    await expect(firstPage!.locator("#change").textContent()).resolves.toBe("Click");
    await allow(pendingScript.structuredContent.requestId);
    const driven = await drive();
    expect(driven.structuredContent).toMatchObject({ status: "completed" });
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

    const extensionDebugger = (page: Page) =>
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
      }, page.url());
    await expect(extensionDebugger(other)).resolves.toMatchObject({
      frameTree: expect.any(Object),
    });
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
    const cleanup = await driveCleanups();
    expect(cleanup.failures).toEqual([]);
    expect(cleanup.settled).toContain(isolated.connectionId);
    await otherEnded;
    expect(
      (await connections.list(ownerId, { includeRevoked: true })).find(
        ({ id }) => id === isolated.connectionId,
      )?.state,
    ).toBe("stopped");
    await expect(extensionDebugger(other)).rejects.toThrow(/not attached/i);
    expect(other.isClosed()).toBe(false);

    const stopId = await share(chrome, popup, first);
    const stopClient = await approvedConnect(stopId, "stop-cdp");
    await expect(extensionDebugger(first)).resolves.toMatchObject({
      frameTree: expect.any(Object),
    });
    const stopped = disconnectedFrom(stopClient);
    expect(
      await sessions.stopSession({
        ownerUserId: ownerId,
        threadId: allowed.session.threadId,
        sessionId: allowed.session.id,
      }),
    ).toEqual({ ended: true });
    const closing = bindingClosures.get(allowed.authority.agentBindingId);
    expect(closing).toBeDefined();
    await closing;
    await stopped;
    await expect(extensionDebugger(first)).rejects.toThrow(/not attached/i);
    await expect(
      liveTabs.issueStandardCdpTicket({ authority: allowed.authority, tabId: stopId }),
    ).rejects.toThrow("no longer shared");

    const narrowId = await share(chrome, popup, other);
    const narrowed = await session("Chrome access to narrow", true);
    const narrowTicket = await browserTools.browser_connect({
      caller: narrowed.caller,
      input: { tabId: TabIdSchema.parse(narrowId), taskId: narrowed.session.threadId },
      operationKey: "narrow-cdp",
    });
    expect(narrowTicket).toMatchObject({ status: "completed", mode: "session" });
    const narrowClient = await chromium.connectOverCDP(narrowTicket.endpoint!, {
      noDefaults: true,
    });
    clients.push(narrowClient);
    await expect(extensionDebugger(other)).resolves.toMatchObject({
      frameTree: expect.any(Object),
    });
    const narrowEnded = disconnectedFrom(narrowClient);
    expect(
      await connections.update(ownerId, {
        connectionId: narrowed.connectionId,
        expectedRevision: narrowed.caller.grantRevision,
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    ).toMatchObject({ narrowed: true });
    await expect(
      liveTabs.issueStandardCdpTicket({ authority: narrowed.authority, tabId: narrowId }),
    ).rejects.toThrow("no longer shared");
    const narrowedCleanup = await driveCleanups();
    expect(narrowedCleanup.failures).toEqual([]);
    expect(narrowedCleanup.settled).toContain(narrowed.connectionId);
    await narrowEnded;
    await expect(extensionDebugger(other)).rejects.toThrow(/not attached/i);
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
  const pageCdp = await context.newCDPSession(page);
  await expect(
    pageCdp.send("Runtime.evaluate", { expression: "document.title" }),
  ).resolves.toMatchObject({
    result: { value: "First" },
  });
  await pageCdp.detach();

  const otherCdp = await chrome.newCDPSession(other);
  const { targetInfo: unrelated } = await otherCdp.send("Target.getTargetInfo");
  await otherCdp.detach();
  const rootAlias = await client.newBrowserCDPSession();
  const { targetInfos } = await rootAlias.send("Target.getTargets");
  expect(targetInfos.map((target) => target.url)).toEqual([first.url()]);
  await expect(
    rootAlias.send("Target.attachToTarget", { targetId: unrelated.targetId, flatten: true }),
  ).rejects.toThrow("CDP target is outside this Browser Session.");
  await expect(rootAlias.send("Storage.getCookies")).rejects.toThrow(
    "requires a whole browser context grant",
  );
  await rootAlias.detach();
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
