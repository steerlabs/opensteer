import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expect, it } from "vitest";
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
import { createId } from "../packages/core/src/index.js";
import { BrowserSourceStore } from "../packages/database/src/browser-source-store.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import { opensteerChromeLiveTabsExtensionId } from "../packages/protocol/src/browser-sources.js";

const extension = `chrome-extension://${opensteerChromeLiveTabsExtensionId}`;
const repository = resolve(import.meta.dirname, "..");

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "pairs the Live Tabs companion with Home and serves the chosen real Chrome tab to stock Playwright",
  async () => {
    execFileSync("pnpm", ["--filter", "@opensteer/browser-extension", "build:live-tabs"], {
      cwd: repository,
      stdio: "pipe",
    });
    const directory = join(repository, "apps/browser-extension/dist-live-tabs");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
      permissions: string[];
      action: { default_popup: string };
    };
    expect(manifest.permissions).toEqual(["alarms", "debugger", "storage"]);
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
    const liveTabs = new ChromeSharedTabs(fixture.store);
    const sources = new BrowserSourceService({
      deploymentId: run.deploymentId,
      browser: {
        signInTarget: () => Promise.reject(new Error("Unexpected cookie target")),
        applySiteCookies: () => Promise.reject(new Error("Unexpected cookie import")),
      },
      canonicalOrigin: origin,
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
    const document = {
      version: 2 as const,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      authority: discovery,
      deploymentName: "Live tab test Home",
      destinations: [{ origin, route: null }],
    };
    const invitation = encodeBrowserSourceInvitation({
      ...document,
      signature: sign(null, browserSourceInvitationSigningBytes(document), key.privateKey).toString(
        "base64url",
      ),
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
    const pairingPage = await chrome.newPage();
    await pairingPage.goto(`${origin}/test-pair`);
    const opened = chrome.waitForEvent("page");
    await pairingPage.getByRole("link", { name: "Pair the companion" }).click();
    const connect = await opened;
    await expect.poll(() => connect.title()).toContain("Connect Chrome");
    await connect.getByText(/The agent can act as you, in a tab you share/).waitFor();
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
    const companion = await (chrome.serviceWorkers()[0] ?? chrome.waitForEvent("serviceworker"));
    const share = async (page: Page) => {
      type Api = { tabs: { query(options: object): Promise<{ id: number; url: string }[]> } };
      const tabId = await companion.evaluate(async (url) => {
        const api = (globalThis as typeof globalThis & { chrome: Api }).chrome;
        return (await api.tabs.query({})).find((tab) => tab.url === url)!.id;
      }, page.url());
      const result = await popup.evaluate(
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
      return (await liveTabs.listForBinding(authority)).find((tab) => tab.url === page.url())!
        .tabId;
    };
    const issue = (tabId: string) => liveTabs.issueStandardCdpTicket({ authority, tabId });
    const attach = async (tabId: string) => {
      const ticket = await issue(tabId);
      const client = await chromium.connectOverCDP(ws + ticket.path, { noDefaults: true });
      clients.push(client);
      return client;
    };
    const first = await chrome.newPage();
    const other = await chrome.newPage();
    await first.goto(`${origin}/test-tab/First`);
    await other.goto(`${origin}/test-tab/Other`);
    const firstId = await share(first);
    const otherId = await share(other);
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
    const next = page.waitForEvent("popup");
    await page.locator("#popup").click();
    expect(await (await next).title()).toBe("Popup");
    expect(await Promise.all(context.pages().map((p) => p.title()))).toEqual(["Driven", "Popup"]);
    await popup.reload();
    const disconnected = client.waitForEvent("disconnected");
    await popup.getByRole("button", { name: "Stop sharing Driven" }).click();
    await disconnected;
    await expect(page.evaluate(() => 1)).rejects.toThrow("closed");
    await expect(issue(firstId)).rejects.toThrow("no longer shared");
    expect(first.isClosed()).toBe(false);

    const second = await attach(otherId);
    const tabClosed = second.waitForEvent("disconnected");
    await other.close();
    await tabClosed;
    await expect(issue(otherId)).rejects.toThrow("no longer shared");
    const persisted = await share(first);
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
    const restartWorker = await (chrome.serviceWorkers()[0] ??
      chrome.waitForEvent("serviceworker"));
    const restartId = await restartWorker.evaluate(
      async ({ url, sourceId }) => {
        const api = (
          globalThis as typeof globalThis & {
            chrome: {
              tabs: { query(options: object): Promise<{ id: number; url: string }[]> };
              runtime: { sendMessage(message: unknown): Promise<unknown> };
            };
          }
        ).chrome;
        return { tabId: (await api.tabs.query({})).find((tab) => tab.url === url)!.id, sourceId };
      },
      { url: restartPage.url(), sourceId },
    );
    await restartedPopup.evaluate(
      (message) =>
        (
          globalThis as typeof globalThis & {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome.runtime.sendMessage(message),
      { type: "ui.tab.share", ...restartId },
    );
    await expect.poll(async () => (await liveTabs.listForBinding(authority)).length).toBe(1);
    const last = await attach((await liveTabs.listForBinding(authority))[0]!.tabId);
    const revoked = last.waitForEvent("disconnected");
    expect(await sources.revokeSource({ ownerId: run.userId, sourceId })).toBe(true);
    await revoked;
    expect(await liveTabs.listForBinding(authority)).toEqual([]);
  },
);
