import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import type { ChromiumTabLifecycleBridge } from "../apps/browser-runtime/src/browser/tab-lifecycle-extension.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import {
  BrowserService,
  type BrowserRuntimeConnection,
} from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { TabStore, type DatabaseSchema } from "../packages/database/src/index.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import type { BrowserAttachPublicKey, InitialPageReady } from "../packages/protocol/src/index.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { chromium } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    if (url.pathname === "/article") {
      response.end(
        `<!doctype html><html><head><title>Article ${url.searchParams.get("tab") ?? ""}</title></head>
        <body style="height:8000px">
          <input id="draft" name="draft" type="text" value="" />
          <div style="height:7000px">spacer</div>
          <script>window.__ssAtLoad = sessionStorage.getItem("k");</script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/agent-page") {
      response.end(
        `<!doctype html><html><head><title>Agent</title></head><body>agent</body></html>`,
      );
      return;
    }
    if (url.pathname === "/deleted-page") {
      response.end(
        `<!doctype html><html><head><title>Deleted</title></head><body>deleted</body></html>`,
      );
      return;
    }
    response.end(`<!doctype html><html><body>ok</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no address.");
  return {
    originForSite: (index: number) => `http://site-${index}.localhost:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

class BridgeRuntimeSocket extends EventEmitter implements BrowserRuntimeConnection {
  initialPage: InitialPageReady | undefined;
  readonly #ws: WebSocket;
  constructor(runtimePort: number, bridgeToken: string, encodedKeys: string, ticket: string) {
    super();
    this.#ws = new WebSocket(`ws://127.0.0.1:${runtimePort}/v1/browser`, {
      headers: {
        authorization: `Bearer ${ticket}`,
        "x-opensteer-browser-bridge-token": bridgeToken,
        "x-opensteer-browser-attach-keys": encodedKeys,
      },
    });
    this.#ws.on("message", (raw, isBinary) => {
      if (!isBinary) {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        try {
          const parsed = JSON.parse(text) as { type?: string; initialPage?: InitialPageReady };
          if (parsed.type === "browser.attached") {
            this.initialPage = parsed.initialPage;
            return;
          }
        } catch {
          // forward non-JSON
        }
      }
      this.emit("message", raw, isBinary);
    });
    this.#ws.on("close", (code, reason) => this.emit("close", code, reason));
    this.#ws.on("error", (error) => this.emit("error", error));
  }
  get readyState() {
    return this.#ws.readyState;
  }
  send(data: string, options: { binary: false }, callback: (error?: Error) => void): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(data, options, callback);
    } else {
      this.#ws.once("open", () => this.#ws.send(data, options, callback));
    }
  }
  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }
  terminate(): void {
    this.#ws.terminate();
  }
}

async function evalOnPage<T>(
  browser: LaunchedBrowser,
  urlSubstring: string,
  expression: string,
): Promise<T> {
  const page = browser.context.pages().find((entry) => entry.url().includes(urlSubstring));
  if (!page) throw new Error(`Page matching ${urlSubstring} not found.`);
  const cdp = await page.cdp();
  const res = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? "eval failed");
  return res.result?.value as T;
}

async function waitPageLoaded(browser: LaunchedBrowser, urlSubstring: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const ready = await evalOnPage<boolean>(
        browser,
        urlSubstring,
        "document.readyState === 'complete'",
      );
      expect(ready).toBe(true);
    },
    { timeout: 10_000, interval: 100 },
  );
}

/**
 * Waits deterministically until Chromium has flushed every required URL substring
 * into `Default/Sessions/Session_*` on disk before shutdown or SIGKILL.
 */
async function waitSessionFilesContain(
  profileDir: string,
  requiredSubstrings: readonly string[],
): Promise<void> {
  const sessionsDir = path.join(profileDir, "Default", "Sessions");
  await vi.waitFor(
    async () => {
      const files = await readdir(sessionsDir).catch(() => []);
      const sf = files.filter((n) => n.startsWith("Session_"));
      expect(sf.length).toBeGreaterThan(0);
      const chunks = await Promise.all(
        sf.map(async (n) => {
          const full = path.join(sessionsDir, n);
          const s = await stat(full);
          if (s.size === 0) return "";
          return readFile(full, "latin1");
        }),
      );
      const combined = chunks.join("\n");
      for (const expected of requiredSubstrings) {
        // Group titles are written as UTF-16; addresses as UTF-8.
        const utf16 = Buffer.from(expected, "utf16le").toString("latin1");
        expect(combined.includes(expected) || combined.includes(utf16)).toBe(true);
      }
    },
    { timeout: 15_000, interval: 100 },
  );
}

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);

integration("Linux cold-start session restore through Home BrowserService", () => {
  it("restores saved person tabs by Home tab id, excludes agent and deleted tabs, and leaves zero unclaimed tabs in Chromium", async () => {
    const fixture = await createStoreFixture();
    const f = await fixture.startRunFixture("linux-cold-restore");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();

    const site = await startFixtureServer();
    const scratch = await mkdtemp(path.join(tmpdir(), "os-f1-home-restore-"));
    const profileRoot = path.join(scratch, "profiles");
    const filesRoot = path.join(scratch, "files");
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keys: BrowserAttachPublicKey[] = [{ keyId: "test", publicKeyPem }];
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: keyPair.privateKey,
    });

    const cleanups: (() => Promise<unknown>)[] = [
      () => site.close(),
      () => rm(scratch, { recursive: true, force: true }),
    ];

    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
      },
    }));

    const startStack = async (tag: string) => {
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server"],
      });
      let lastBrowser: LaunchedBrowser | undefined;
      let lastDirectory: string | undefined;
      const runtime = new BrowserRuntime({
        runtimeId: "linux-restore-runtime",
        launcher: {
          hostCost: launcher.hostCost,
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            if (request.storage.kind === "local") lastDirectory = request.storage.directory;
            lastBrowser = await launcher.launch(request, signal);
            return lastBrowser;
          },
        },
        localProfiles: { root: profileRoot },
        sessionFilesRoot: path.join(filesRoot, tag),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: path.join(scratch, `private-${tag}`, "replay.json"),
          resolvePublicKey: (id) => keys.find((k) => k.keyId === id)?.publicKeyPem ?? null,
        }),
      });
      await runtime.prepare();
      const bridgeToken = randomBytes(16).toString("base64url");
      const server = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: {
          token: bridgeToken,
          updateAttachKeys: () => undefined,
        },
      });
      const addr = await server.start();
      const storage = runtime.localProfileStorage!;
      const errors: unknown[] = [];
      const browser = new BrowserService({
        deploymentId: f.deploymentId,
        hostOrigin: new URL("http://127.0.0.1"),
        personal: true,
        repository: personalBrowserRepository(store),
        localProfiles: new BrowserLocalProfiles({
          deploymentId: f.deploymentId,
          baseUrl: new URL("http://127.0.0.1"),
          repository: store,
        }),
        tabs,
        tabPlaces: { write: async () => false, notice: () => {} },
        signer,
        onSessionsChanged: () => {},
        onError: (error) => errors.push(error),
        targetResolver: {
          placements: () => [
            {
              kind: "runner",
              runnerId: f.runnerId,
              runtimeId: "linux-restore-runtime",
              label: "Linux Home",
              available: true,
              agents: true,
              environmentIds: [f.environmentId],
            },
          ],
          resolve: (placement) =>
            placement.runnerId === f.runnerId
              ? {
                  runtimeId: "linux-restore-runtime",
                  placementKey: "linux-restore",
                  cdpBoundary: true,
                  sharedControl: true,
                  targetControl: true,
                  surfaceState: 1,
                  tabRestoreVersion: true,
                  actorClaim: true,
                  localProfileStorage: storage,
                  connect: (ticket) =>
                    new BridgeRuntimeSocket(
                      addr.port,
                      bridgeToken,
                      Buffer.from(JSON.stringify(keys)).toString("base64url"),
                      ticket,
                    ),
                }
              : undefined,
        },
      });
      const close = async () => {
        // Shut down runtime FIRST (matching real Linux Home / container restart)
        // so durable person tabs exit with Chromium instead of being closed as session-ended.
        await runtime.shutdown();
        await server.close();
        await browser.close();
      };
      cleanups.push(close);
      return {
        runtime,
        server,
        browser,
        errors,
        close,
        getBrowser: () => lastBrowser!,
        getDirectory: () => lastDirectory!,
      };
    };

    const urlA = `${site.originForSite(1)}/article?tab=a`;
    const urlB = `${site.originForSite(2)}/article?tab=b`;
    const urlDeleted = `${site.originForSite(3)}/deleted-page`;
    const urlAgent = `${site.originForSite(4)}/agent-page`;

    // --- RUN 1: populate saved person tabs + deleted tab + agent tab in the same native profile ---
    const stack1 = await startStack("run1");
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "Personal",
      homeRunnerId: f.runnerId,
      idempotencyKey: "profile-f1",
    });

    const person = { kind: "person", ownerId: f.userId } as const;
    const writeA = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: urlA },
      "open-a",
    );
    await tabs.open(writeA, "open-a");
    await stack1.browser.pageTabs.admitted!(writeA);
    await waitPageLoaded(stack1.getBrowser(), "tab=a");
    await evalOnPage(stack1.getBrowser(), "tab=a", "document.getElementById('draft').focus()");
    const pageA = stack1
      .getBrowser()
      .context.pages()
      .find((p) => p.url().includes("tab=a"))!;
    await (await pageA.cdp()).send("Input.insertText", { text: "Person draft A" });
    await evalOnPage(
      stack1.getBrowser(),
      "tab=a",
      `document.activeElement.blur(); window.scrollTo(0, 1400); sessionStorage.setItem("k", "val-A"); window.scrollY`,
    );

    const writeB = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: urlB },
      "open-b",
    );
    await tabs.open(writeB, "open-b");
    await stack1.browser.pageTabs.admitted!(writeB);
    await waitPageLoaded(stack1.getBrowser(), "tab=b");
    await evalOnPage(stack1.getBrowser(), "tab=b", "document.getElementById('draft').focus()");
    const pageB = stack1
      .getBrowser()
      .context.pages()
      .find((p) => p.url().includes("tab=b"))!;
    await (await pageB.cdp()).send("Input.insertText", { text: "Person draft B" });
    await evalOnPage(
      stack1.getBrowser(),
      "tab=b",
      `document.activeElement.blur(); window.scrollTo(0, 2200); window.scrollY`,
    );

    const writeD = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: urlDeleted },
      "open-d",
    );
    await tabs.open(writeD, "open-d");
    await stack1.browser.pageTabs.admitted!(writeD);
    await waitPageLoaded(stack1.getBrowser(), "/deleted-page");

    // Connected/run agent opens its own tab in the SAME profile.
    await stack1.browser.openAgentTab(
      {
        ownerId: f.userId,
        agentBindingId: `run:${f.runId}`,
        threadId: f.threadId,
        environmentId: f.environmentId,
      },
      {
        identity: { kind: "profile", profile: profile.id },
        url: urlAgent,
        operationKey: "agent-tab-c",
      },
    );
    await waitPageLoaded(stack1.getBrowser(), "/agent-page");

    // Wait deterministically for Chromium to flush all 4 tabs into Default/Sessions/Session_*.
    const profileDir = stack1.getDirectory();
    await waitSessionFilesContain(profileDir, ["tab=a", "tab=b", "/deleted-page", "/agent-page"]);

    // Shut down run 1 (simulating Home/runtime restart).
    await stack1.close();

    // Delete tab D in Home while the browser is down.
    await tabs.close(f.userId, [writeD.id], "delete-d-while-down");

    // --- RUN 2: cold restart through Home's real pageTabs.activate ---
    const stack2 = await startStack("run2");
    const rowA = (await tabs.get(f.userId, writeA.id))!;
    const rowB = (await tabs.get(f.userId, writeB.id))!;
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // Restore tab A via Home's real entry point (NO hand-called launcher hooks!).
    const activatedA = await stack2.browser.pageTabs.activate(f.userId, rowA, "activate-a");
    expect(activatedA.surfaceId).toBe(rowA.id);

    const browser2 = stack2.getBrowser();
    const lifecycle2 = (
      browser2 as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;

    // Immediately after ready: agent tab and deleted tab MUST already be gone from Chromium,
    // AND parked tab B MUST be discarded with zero live background page (R1)!
    const invAfterA = await lifecycle2.inventory();
    const nonBlankAfterA = invAfterA.filter(
      (t) => t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
    );
    expect(nonBlankAfterA.some((t) => t.url.includes("/agent-page"))).toBe(false);
    expect(nonBlankAfterA.some((t) => t.url.includes("/deleted-page"))).toBe(false);
    expect(nonBlankAfterA).toHaveLength(2);
    const parkedB = nonBlankAfterA.find((t) => t.url.includes("tab=b"));
    expect(parkedB).toMatchObject({ status: "unloaded" });
    expect(browser2.context.pages()).toHaveLength(1);
    expect(browser2.context.pages()[0]!.url()).toContain("tab=a");

    // Tab A came back as itself with scroll, typed draft, and sessionStorage intact!
    await waitPageLoaded(browser2, "tab=a");
    await vi.waitFor(
      async () => {
        expect(await evalOnPage<number>(browser2, "tab=a", "window.scrollY")).toBe(1400);
      },
      { timeout: 5_000, interval: 100 },
    );
    expect(
      await evalOnPage<string>(browser2, "tab=a", "document.getElementById('draft').value"),
    ).toBe("Person draft A");
    expect(await evalOnPage<string | null>(browser2, "tab=a", "window.__ssAtLoad")).toBe("val-A");

    // Restore dormant tab B via Home's real entry point -> claims its restored Chromium tab!
    const activatedB = await stack2.browser.pageTabs.activate(f.userId, rowB, "activate-b");
    expect(activatedB.surfaceId).toBe(rowB.id);
    await waitPageLoaded(browser2, "tab=b");
    await vi.waitFor(
      async () => {
        expect(await evalOnPage<number>(browser2, "tab=b", "window.scrollY")).toBe(2200);
      },
      { timeout: 5_000, interval: 100 },
    );
    expect(
      await evalOnPage<string>(browser2, "tab=b", "document.getElementById('draft').value"),
    ).toBe("Person draft B");

    // Still exactly 2 non-blank tabs in Chromium (no duplicates, no unclaimed tabs!).
    const invAfterB = await lifecycle2.inventory();
    const nonBlankAfterB = invAfterB.filter(
      (t) => t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
    );
    expect(nonBlankAfterB).toHaveLength(2);
    expect(stack2.errors).toEqual([]);
  }, 60_000);

  it("removes sleeping agent tabs from Chromium on BrowserService.stop and brings none back on cold restart", async () => {
    const fixture = await createStoreFixture();
    const f = await fixture.startRunFixture("linux-sleep-stop");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();

    const site = await startFixtureServer();
    const scratch = await mkdtemp(path.join(tmpdir(), "os-f2-sleep-stop-"));
    const profileRoot = path.join(scratch, "profiles");
    const filesRoot = path.join(scratch, "files");
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keys: BrowserAttachPublicKey[] = [{ keyId: "test", publicKeyPem }];
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: keyPair.privateKey,
    });

    const cleanups: (() => Promise<unknown>)[] = [
      () => site.close(),
      () => rm(scratch, { recursive: true, force: true }),
    ];

    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
      },
    }));

    const startStack = async (tag: string) => {
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server"],
      });
      let lastBrowser: LaunchedBrowser | undefined;
      let lastDirectory: string | undefined;
      const runtime = new BrowserRuntime({
        runtimeId: "linux-stop-runtime",
        launcher: {
          hostCost: launcher.hostCost,
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            if (request.storage.kind === "local") lastDirectory = request.storage.directory;
            lastBrowser = await launcher.launch(request, signal);
            return lastBrowser;
          },
        },
        localProfiles: { root: profileRoot },
        sessionFilesRoot: path.join(filesRoot, tag),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: path.join(scratch, `private-${tag}`, "replay.json"),
          resolvePublicKey: (id) => keys.find((k) => k.keyId === id)?.publicKeyPem ?? null,
        }),
      });
      await runtime.prepare();
      const bridgeToken = randomBytes(16).toString("base64url");
      const server = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: {
          token: bridgeToken,
          updateAttachKeys: () => undefined,
        },
      });
      const addr = await server.start();
      const storage = runtime.localProfileStorage!;
      const browser = new BrowserService({
        deploymentId: f.deploymentId,
        hostOrigin: new URL("http://127.0.0.1"),
        personal: true,
        repository: personalBrowserRepository(store),
        localProfiles: new BrowserLocalProfiles({
          deploymentId: f.deploymentId,
          baseUrl: new URL("http://127.0.0.1"),
          repository: store,
        }),
        tabs,
        tabPlaces: { write: async () => false, notice: () => {} },
        signer,
        onSessionsChanged: () => {},
        onError: () => {},
        targetResolver: {
          placements: () => [
            {
              kind: "runner",
              runnerId: f.runnerId,
              runtimeId: "linux-stop-runtime",
              label: "Linux Home",
              available: true,
              agents: true,
              environmentIds: [f.environmentId],
            },
          ],
          resolve: (placement) =>
            placement.runnerId === f.runnerId
              ? {
                  runtimeId: "linux-stop-runtime",
                  placementKey: "linux-stop",
                  cdpBoundary: true,
                  sharedControl: true,
                  targetControl: true,
                  surfaceState: 1,
                  tabRestoreVersion: true,
                  actorClaim: true,
                  localProfileStorage: storage,
                  connect: (ticket) =>
                    new BridgeRuntimeSocket(
                      addr.port,
                      bridgeToken,
                      Buffer.from(JSON.stringify(keys)).toString("base64url"),
                      ticket,
                    ),
                }
              : undefined,
        },
      });
      const close = async () => {
        await runtime.shutdown();
        await server.close();
        await browser.close();
      };
      cleanups.push(close);
      return {
        runtime,
        server,
        browser,
        close,
        getBrowser: () => lastBrowser!,
        getDirectory: () => lastDirectory!,
      };
    };

    const stack1 = await startStack("f2-run1");
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "Personal",
      homeRunnerId: f.runnerId,
      idempotencyKey: "profile-f2",
    });

    // Keep a person session open on the same profile so the Chromium host stays alive
    // when the agent session ends via BrowserService.stop().
    const person = { kind: "person", ownerId: f.userId } as const;
    const personWrite = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: `${site.originForSite(1)}/article?tab=person` },
      "open-person",
    );
    await tabs.open(personWrite, "open-person");
    await stack1.browser.pageTabs.admitted!(personWrite);
    await waitPageLoaded(stack1.getBrowser(), "tab=person");

    const agentUrl = `${site.originForSite(2)}/agent-page`;
    // Open a separate agent session on the same profile so BrowserService.stop()
    // ends ONLY the agent session while Chromium stays alive for the person session.
    const openedAgent = await stack1.browser.openAgentSession({
      ownerId: f.userId,
      agentBindingId: `run:${f.runId}`,
      environmentId: f.environmentId,
      profileId: profile.id,
    });
    expect(openedAgent.session.id).not.toBe(personWrite.pageBinding?.sessionId);
    const agentPage = stack1
      .getBrowser()
      .context.pages()
      .find((p) => !p.url().includes("tab=person"))!;
    expect(agentPage).toBeDefined();
    await (await agentPage.cdp()).send("Page.navigate", { url: agentUrl });
    await waitPageLoaded(stack1.getBrowser(), "/agent-page");

    // Sleep the agent tab inside its live runtime session.
    const internalRuntime = stack1.runtime as unknown as {
      sessions: Map<
        string,
        {
          ledger: {
            snapshot(): Array<{ id: string }>;
            sleep(id: string, blocked: () => null): Promise<boolean>;
          };
        }
      >;
    };
    const agentRuntimeSession = internalRuntime.sessions.get(openedAgent.session.id);
    expect(agentRuntimeSession).toBeDefined();
    const agentSurfaceId = agentRuntimeSession!.ledger.snapshot()[0]!.id;
    expect(await agentRuntimeSession!.ledger.sleep(agentSurfaceId, () => null)).toBe(true);

    const lifecycle1 = (
      stack1.getBrowser() as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;
    expect((await lifecycle1.inventory()).some((t) => t.url === agentUrl && t.discarded)).toBe(
      true,
    );

    // Wait deterministically for Chromium to flush Default/Sessions/Session_* while the agent tab is asleep.
    const profileDir = stack1.getDirectory();
    await waitSessionFilesContain(profileDir, ["tab=person", "/agent-page"]);

    // End the agent session through Home's real BrowserService.stop(). When it resolves no session
    // can reach the tab: it is unpublished and nothing can attach to it, at once.
    const agentTarget = (await lifecycle1.inventory()).find((t) => t.url === agentUrl)?.targetId;
    const writes: string[] = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...rest) => {
      writes.push(String(chunk));
      return stderrWrite(chunk as string, ...(rest as []));
    });
    cleanups.push(async () => stderr.mockRestore());
    await stack1.browser.stop(f.userId, openedAgent.session.id);
    expect(
      stack1
        .getBrowser()
        .context.pages()
        .some((p) => p.url() === agentUrl),
    ).toBe(false);
    if (agentTarget)
      await expect(stack1.getBrowser().cdp.attach(agentTarget)).rejects.toThrow(
        /not an attachable/,
      );
    // Its removal is `removed` or `unknown`, decided by the runtime within the background retry's
    // bound (K6): removed, with a read that agrees with itself showing no such tab; or reported
    // unconfirmed, with the name still guarded.
    const guards = (
      stack1.getBrowser() as unknown as {
        contextHandle: {
          removals: Map<string, unknown>;
          unremovable: Set<string>;
          sleepingByToken: Map<string, unknown>;
        };
      }
    ).contextHandle;
    const unconfirmed = () =>
      writes.some((line) => line.includes('"browser-runtime.tab-removal-unconfirmed"'));
    await vi.waitFor(
      () =>
        expect(
          unconfirmed() || (guards.removals.size === 0 && guards.sleepingByToken.size === 0),
        ).toBe(true),
      { timeout: 40_000, interval: 100 },
    );
    if (unconfirmed()) expect(guards.unremovable.size).toBe(1);
    else expect((await lifecycle1.inventory()).some((t) => t.url === agentUrl)).toBe(false);
    expect(
      stack1
        .getBrowser()
        .context.pages()
        .some((p) => p.url() === agentUrl),
    ).toBe(false);

    await stack1.close();

    // Cold restart must bring none of the stopped session's sleeping tabs back!
    const stack2 = await startStack("f2-run2");
    const personRow = (await tabs.get(f.userId, personWrite.id))!;
    await stack2.browser.pageTabs.activate(f.userId, personRow, "activate-person");
    const lifecycle2 = (
      stack2.getBrowser() as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;
    expect((await lifecycle2.inventory()).some((t) => t.url === agentUrl)).toBe(false);
  }, 60_000);

  it("never binds an agent tab to a person tab on the same URL across SIGKILL crash and discards parked tabs (R4, R1)", async () => {
    const fixture = await createStoreFixture();
    const f = await fixture.startRunFixture("linux-r4-sigkill");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();

    const site = await startFixtureServer();
    const scratch = await mkdtemp(path.join(tmpdir(), "os-r4-sigkill-"));
    const profileRoot = path.join(scratch, "profiles");
    const filesRoot = path.join(scratch, "files");
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keys: BrowserAttachPublicKey[] = [{ keyId: "test", publicKeyPem }];
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: keyPair.privateKey,
    });

    const cleanups: (() => Promise<unknown>)[] = [
      () => site.close(),
      () => rm(scratch, { recursive: true, force: true }),
    ];
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
      },
    }));

    const startStack = async (tag: string) => {
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server"],
      });
      let lastBrowser: LaunchedBrowser | undefined;
      let lastDirectory: string | undefined;
      const runtime = new BrowserRuntime({
        runtimeId: "linux-r4-runtime",
        launcher: {
          hostCost: launcher.hostCost,
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            if (request.storage.kind === "local") lastDirectory = request.storage.directory;
            lastBrowser = await launcher.launch(request, signal);
            return lastBrowser;
          },
        },
        localProfiles: { root: profileRoot },
        sessionFilesRoot: path.join(filesRoot, tag),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: path.join(scratch, `private-${tag}`, "replay.json"),
          resolvePublicKey: (id) => keys.find((k) => k.keyId === id)?.publicKeyPem ?? null,
        }),
      });
      await runtime.prepare();
      const bridgeToken = randomBytes(16).toString("base64url");
      const server = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: { token: bridgeToken, updateAttachKeys: () => undefined },
      });
      const addr = await server.start();
      const storage = runtime.localProfileStorage!;
      const browser = new BrowserService({
        deploymentId: f.deploymentId,
        hostOrigin: new URL("http://127.0.0.1"),
        personal: true,
        repository: personalBrowserRepository(store),
        localProfiles: new BrowserLocalProfiles({
          deploymentId: f.deploymentId,
          baseUrl: new URL("http://127.0.0.1"),
          repository: store,
        }),
        tabs,
        tabPlaces: { write: async () => false, notice: () => {} },
        signer,
        onSessionsChanged: () => {},
        onError: () => {},
        targetResolver: {
          placements: () => [
            {
              kind: "runner",
              runnerId: f.runnerId,
              runtimeId: "linux-r4-runtime",
              label: "Linux Home",
              available: true,
              agents: true,
              environmentIds: [f.environmentId],
            },
          ],
          resolve: (placement) =>
            placement.runnerId === f.runnerId
              ? {
                  runtimeId: "linux-r4-runtime",
                  placementKey: "linux-r4",
                  cdpBoundary: true,
                  sharedControl: true,
                  targetControl: true,
                  surfaceState: 1,
                  tabRestoreVersion: true,
                  actorClaim: true,
                  localProfileStorage: storage,
                  connect: (ticket) =>
                    new BridgeRuntimeSocket(
                      addr.port,
                      bridgeToken,
                      Buffer.from(JSON.stringify(keys)).toString("base64url"),
                      ticket,
                    ),
                }
              : undefined,
        },
      });
      const close = async () => {
        await runtime.shutdown().catch(() => undefined);
        await server.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      };
      cleanups.push(close);
      return {
        runtime,
        server,
        browser,
        close,
        getBrowser: () => lastBrowser!,
        getDirectory: () => lastDirectory!,
      };
    };

    const sharedUrl = `${site.originForSite(1)}/article?tab=shared`;
    const parkedUrl = `${site.originForSite(2)}/article?tab=parked`;

    const stack1 = await startStack("r4-run1");
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "Personal",
      homeRunnerId: f.runnerId,
      idempotencyKey: "profile-r4",
    });

    // Agent opens FIRST on the shared URL with distinct agent state!
    await stack1.browser.openAgentTab(
      {
        ownerId: f.userId,
        agentBindingId: `run:${f.runId}`,
        threadId: f.threadId,
        environmentId: f.environmentId,
      },
      {
        identity: { kind: "profile", profile: profile.id },
        url: sharedUrl,
        operationKey: "agent-shared",
      },
    );
    await waitPageLoaded(stack1.getBrowser(), "tab=shared");
    await evalOnPage(stack1.getBrowser(), "tab=shared", "document.getElementById('draft').focus()");
    const agentPage = stack1
      .getBrowser()
      .context.pages()
      .find((p) => p.url().includes("tab=shared"))!;
    await (await agentPage.cdp()).send("Input.insertText", { text: "AGENT_SECRET" });
    await evalOnPage(
      stack1.getBrowser(),
      "tab=shared",
      `document.activeElement.blur(); sessionStorage.setItem("k", "AGENT_SECRET");`,
    );

    // Person opens TWO tabs: one on the EXACT same URL (with distinct person state) and one parked tab.
    const person = { kind: "person", ownerId: f.userId } as const;
    const writeP = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: sharedUrl },
      "open-person-shared",
    );
    await tabs.open(writeP, "open-person-shared");
    await stack1.browser.pageTabs.admitted!(writeP);
    const personSharedPage = stack1
      .getBrowser()
      .context.pages()
      .find((p) => p !== agentPage && p.url().includes("tab=shared"))!;
    expect(personSharedPage).toBeDefined();
    await vi.waitFor(async () => {
      const cdp = await personSharedPage.cdp();
      const r = (await cdp.send("Runtime.evaluate", {
        expression: "document.readyState === 'complete'",
        returnByValue: true,
      })) as { result?: { value?: boolean } };
      expect(r.result?.value).toBe(true);
    });
    {
      const cdp = await personSharedPage.cdp();
      await cdp.send("Runtime.evaluate", {
        expression: "document.getElementById('draft').focus()",
      });
      await cdp.send("Input.insertText", { text: "PERSON_OWN" });
      await cdp.send("Runtime.evaluate", {
        expression: `document.activeElement.blur(); sessionStorage.setItem("k", "PERSON_OWN");`,
      });
    }

    const writeParked = await stack1.browser.pageTabs.open(
      person,
      { kind: "page", profileId: profile.id, url: parkedUrl },
      "open-person-parked",
    );
    await tabs.open(writeParked, "open-person-parked");
    await stack1.browser.pageTabs.admitted!(writeParked);
    await waitPageLoaded(stack1.getBrowser(), "tab=parked");

    // Ensure the person's tabs carry their Home ids and Chromium flushed Session_* (with those
    // names) before the SIGKILL crash.
    await stack1.getBrowser().context.sessionRestore!.flush!();
    const profileDir = stack1.getDirectory();
    const lifecycle1 = (
      stack1.getBrowser() as unknown as {
        contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
      }
    ).contextHandle.lifecycle;
    await vi.waitFor(
      async () => {
        const named = (await lifecycle1.inventory()).filter((t) => t.url === sharedUrl);
        // The person's tab carries its own Home id; the agent's tab on the same address none.
        expect(named.map((t) => t.identity ?? null).sort()).toEqual([null, writeP.id].sort());
      },
      { timeout: 10_000, interval: 100 },
    );
    await waitSessionFilesContain(profileDir, ["tab=shared", "tab=parked", writeP.id]);

    // Hard crash Chromium with SIGKILL!
    const pid1 = (
      stack1.getBrowser() as unknown as { playwrightContext: { process(): { pid: number } } }
    ).playwrightContext.process().pid;
    process.kill(-pid1, "SIGKILL");
    await stack1.close();

    // Cold restart through Home's real pageTabs.activate(rowP):
    const stack2 = await startStack("r4-run2");
    const rowP = (await tabs.get(f.userId, writeP.id))!;
    await stack2.browser.pageTabs.activate(f.userId, rowP, "activate-person-after-sigkill");

    const browser2 = stack2.getBrowser();
    const lifecycle2 = (
      browser2 as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;

    // Agent tab MUST be closed (only the 2 person tabs remain), and parked tab MUST be discarded!
    const inv2 = await lifecycle2.inventory();
    const nonBlank2 = inv2.filter(
      (t) => t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
    );
    expect(nonBlank2).toHaveLength(2);
    expect(nonBlank2.filter((t) => t.url.includes("tab=shared"))).toHaveLength(1);
    expect(nonBlank2.find((t) => t.url.includes("tab=parked"))).toMatchObject({
      status: "unloaded",
    });
    expect(browser2.context.pages()).toHaveLength(1);

    // Person tab MUST NEVER receive the agent tab's draft or sessionStorage!
    await waitPageLoaded(browser2, "tab=shared");
    const restoredDraft = await evalOnPage<string>(
      browser2,
      "tab=shared",
      "document.getElementById('draft').value",
    );
    const restoredSs = await evalOnPage<string | null>(browser2, "tab=shared", "window.__ssAtLoad");
    expect(restoredDraft).not.toBe("AGENT_SECRET");
    expect(restoredSs).not.toBe("AGENT_SECRET");
  }, 60_000);

  it("closes all restored person tabs before an agent session is ready when agent starts first after cold start (R2)", async () => {
    const fixture = await createStoreFixture();
    const f = await fixture.startRunFixture("linux-r2-agent-first");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();

    const site = await startFixtureServer();
    const scratch = await mkdtemp(path.join(tmpdir(), "os-r2-agent-first-"));
    const profileRoot = path.join(scratch, "profiles");
    const filesRoot = path.join(scratch, "files");
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keys: BrowserAttachPublicKey[] = [{ keyId: "test", publicKeyPem }];
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: keyPair.privateKey,
    });

    const cleanups: (() => Promise<unknown>)[] = [
      () => site.close(),
      () => rm(scratch, { recursive: true, force: true }),
    ];
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
      },
    }));

    const startStack = async (tag: string) => {
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server"],
      });
      let lastBrowser: LaunchedBrowser | undefined;
      let lastDirectory: string | undefined;
      const runtime = new BrowserRuntime({
        runtimeId: "linux-r2-runtime",
        launcher: {
          hostCost: launcher.hostCost,
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            if (request.storage.kind === "local") lastDirectory = request.storage.directory;
            lastBrowser = await launcher.launch(request, signal);
            return lastBrowser;
          },
        },
        localProfiles: { root: profileRoot },
        sessionFilesRoot: path.join(filesRoot, tag),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: path.join(scratch, `private-${tag}`, "replay.json"),
          resolvePublicKey: (id) => keys.find((k) => k.keyId === id)?.publicKeyPem ?? null,
        }),
      });
      await runtime.prepare();
      const bridgeToken = randomBytes(16).toString("base64url");
      const server = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: { token: bridgeToken, updateAttachKeys: () => undefined },
      });
      const addr = await server.start();
      const storage = runtime.localProfileStorage!;
      const browser = new BrowserService({
        deploymentId: f.deploymentId,
        hostOrigin: new URL("http://127.0.0.1"),
        personal: true,
        repository: personalBrowserRepository(store),
        localProfiles: new BrowserLocalProfiles({
          deploymentId: f.deploymentId,
          baseUrl: new URL("http://127.0.0.1"),
          repository: store,
        }),
        tabs,
        tabPlaces: { write: async () => false, notice: () => {} },
        signer,
        onSessionsChanged: () => {},
        onError: () => {},
        targetResolver: {
          placements: () => [
            {
              kind: "runner",
              runnerId: f.runnerId,
              runtimeId: "linux-r2-runtime",
              label: "Linux Home",
              available: true,
              agents: true,
              environmentIds: [f.environmentId],
            },
          ],
          resolve: (placement) =>
            placement.runnerId === f.runnerId
              ? {
                  runtimeId: "linux-r2-runtime",
                  placementKey: "linux-r2",
                  cdpBoundary: true,
                  sharedControl: true,
                  targetControl: true,
                  surfaceState: 1,
                  tabRestoreVersion: true,
                  actorClaim: true,
                  localProfileStorage: storage,
                  connect: (ticket) =>
                    new BridgeRuntimeSocket(
                      addr.port,
                      bridgeToken,
                      Buffer.from(JSON.stringify(keys)).toString("base64url"),
                      ticket,
                    ),
                }
              : undefined,
        },
      });
      const close = async () => {
        await runtime.shutdown().catch(() => undefined);
        await server.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      };
      cleanups.push(close);
      return {
        runtime,
        server,
        browser,
        close,
        getBrowser: () => lastBrowser!,
        getDirectory: () => lastDirectory!,
      };
    };

    const personUrl = `${site.originForSite(1)}/article?tab=private-person`;
    const agentUrl = `${site.originForSite(2)}/agent-page`;

    // Run 1: person opens a saved tab, flushes Session_*, shuts down cleanly.
    const stack1 = await startStack("r2-run1");
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "Personal",
      homeRunnerId: f.runnerId,
      idempotencyKey: "profile-r2",
    });
    const personWrite = await stack1.browser.pageTabs.open(
      { kind: "person", ownerId: f.userId },
      { kind: "page", profileId: profile.id, url: personUrl },
      "open-private-person",
    );
    await tabs.open(personWrite, "open-private-person");
    await stack1.browser.pageTabs.admitted!(personWrite);
    await waitPageLoaded(stack1.getBrowser(), "tab=private-person");
    await waitSessionFilesContain(stack1.getDirectory(), ["tab=private-person"]);
    await stack1.close();

    // Run 2: Agent starts FIRST on the profile before the person activates anything!
    const stack2 = await startStack("r2-run2");
    await stack2.browser.openAgentTab(
      {
        ownerId: f.userId,
        agentBindingId: `run:${f.runId}`,
        threadId: f.threadId,
        environmentId: f.environmentId,
      },
      {
        identity: { kind: "profile", profile: profile.id },
        url: agentUrl,
        operationKey: "agent-first",
      },
    );

    const browser2 = stack2.getBrowser();
    const lifecycle2 = (
      browser2 as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;

    // Restored person tab MUST already be confirmed gone from Chromium and never in agent pages!
    const inv2 = await lifecycle2.inventory();
    expect(inv2.some((t) => t.url.includes("tab=private-person"))).toBe(false);
    expect(browser2.context.pages().some((p) => p.url().includes("tab=private-person"))).toBe(
      false,
    );
  }, 60_000);

  it("preserves sessionStorage, scroll, and draft on a never-loaded saved tab while discarding eagerly loaded parked tabs (R1)", async () => {
    const fixture = await createStoreFixture();
    const f = await fixture.startRunFixture("linux-r1-never-loaded");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();

    const site = await startFixtureServer();
    const scratch = await mkdtemp(path.join(tmpdir(), "os-r1-never-loaded-"));
    const profileRoot = path.join(scratch, "profiles");
    const filesRoot = path.join(scratch, "files");
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const keyPair = generateKeyPairSync("ed25519");
    const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keys: BrowserAttachPublicKey[] = [{ keyId: "test", publicKeyPem }];
    const signer = new BrowserAttachTicketSigner({
      keyId: "test",
      privateKey: keyPair.privateKey,
    });

    const cleanups: (() => Promise<unknown>)[] = [
      () => site.close(),
      () => rm(scratch, { recursive: true, force: true }),
    ];
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
      },
    }));

    const startStack = async (tag: string) => {
      const launcher = new PlaywrightChromiumLauncher({
        executablePath: chromium.executablePath(),
        headless: true,
        chromiumSandbox: false,
        args: ["--no-proxy-server"],
      });
      let lastBrowser: LaunchedBrowser | undefined;
      let lastDirectory: string | undefined;
      const runtime = new BrowserRuntime({
        runtimeId: "linux-r1-runtime",
        launcher: {
          hostCost: launcher.hostCost,
          localProfiles: launcher.localProfiles,
          launch: async (request, signal) => {
            if (request.storage.kind === "local") lastDirectory = request.storage.directory;
            lastBrowser = await launcher.launch(request, signal);
            return lastBrowser;
          },
        },
        localProfiles: { root: profileRoot },
        sessionFilesRoot: path.join(filesRoot, tag),
        ticketVerifier: await Ed25519AttachTicketVerifier.create({
          replayLedgerPath: path.join(scratch, `private-${tag}`, "replay.json"),
          resolvePublicKey: (id) => keys.find((k) => k.keyId === id)?.publicKeyPem ?? null,
        }),
      });
      await runtime.prepare();
      const bridgeToken = randomBytes(16).toString("base64url");
      const server = new BrowserRuntimeServer({
        runtime,
        port: 0,
        relayBridge: { token: bridgeToken, updateAttachKeys: () => undefined },
      });
      const addr = await server.start();
      const storage = runtime.localProfileStorage!;
      const browser = new BrowserService({
        deploymentId: f.deploymentId,
        hostOrigin: new URL("http://127.0.0.1"),
        personal: true,
        repository: personalBrowserRepository(store),
        localProfiles: new BrowserLocalProfiles({
          deploymentId: f.deploymentId,
          baseUrl: new URL("http://127.0.0.1"),
          repository: store,
        }),
        tabs,
        tabPlaces: { write: async () => false, notice: () => {} },
        signer,
        onSessionsChanged: () => {},
        onError: () => {},
        targetResolver: {
          placements: () => [
            {
              kind: "runner",
              runnerId: f.runnerId,
              runtimeId: "linux-r1-runtime",
              label: "Linux Home",
              available: true,
              agents: true,
              environmentIds: [f.environmentId],
            },
          ],
          resolve: (placement) =>
            placement.runnerId === f.runnerId
              ? {
                  runtimeId: "linux-r1-runtime",
                  placementKey: "linux-r1",
                  cdpBoundary: true,
                  sharedControl: true,
                  targetControl: true,
                  surfaceState: 1,
                  tabRestoreVersion: true,
                  actorClaim: true,
                  localProfileStorage: storage,
                  connect: (ticket) =>
                    new BridgeRuntimeSocket(
                      addr.port,
                      bridgeToken,
                      Buffer.from(JSON.stringify(keys)).toString("base64url"),
                      ticket,
                    ),
                }
              : undefined,
        },
      });
      const close = async () => {
        await runtime.shutdown().catch(() => undefined);
        await server.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      };
      cleanups.push(close);
      return {
        runtime,
        server,
        browser,
        close,
        getBrowser: () => lastBrowser!,
        getDirectory: () => lastDirectory!,
      };
    };

    const stack1 = await startStack("r1-run1");
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "Personal",
      homeRunnerId: f.runnerId,
      idempotencyKey: "profile-r1-never-loaded",
    });
    const person = { kind: "person", ownerId: f.userId } as const;
    // 25 tabs exceeds Chromium's BackgroundTabLoadingPolicy kMaxTabsToLoad (20),
    // ensuring tab 2 genuinely stays never-loaded even on high-RAM hosts while MRU tab 23 loads.
    const totalTabs = 25;
    const mruIndex = totalTabs - 2;
    const openedWrites = [];
    for (let i = 0; i < totalTabs; i++) {
      const url = `${site.originForSite(i + 1)}/article?tab=t${i}`;
      const write = await stack1.browser.pageTabs.open(
        person,
        { kind: "page", profileId: profile.id, url },
        `open-r1-${i}`,
      );
      await tabs.open(write, `open-r1-${i}`);
      await stack1.browser.pageTabs.admitted!(write);
      openedWrites.push(write);
      if (i === 0 || i === 2 || i === mruIndex) {
        await waitPageLoaded(stack1.getBrowser(), `tab=t${i}`);
        if (i === 2 || i === mruIndex) {
          const scrollY = i === 2 ? 950 : 1150;
          const page = stack1
            .getBrowser()
            .context.pages()
            .find((p) => p.url().includes(`tab=t${i}`))!;
          const cdp = await page.cdp();
          await evalOnPage(
            stack1.getBrowser(),
            `tab=t${i}`,
            "document.getElementById('draft').focus()",
          );
          await cdp.send("Input.insertText", { text: `draft-${i}` });
          await evalOnPage(
            stack1.getBrowser(),
            `tab=t${i}`,
            `document.activeElement.blur(); window.scrollTo(0, ${scrollY}); sessionStorage.setItem("k", "ss-${i}"); window.scrollY;`,
          );
          await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          await cdp.send("Page.setWebLifecycleState", { state: "active" });
        }
      } else {
        await vi.waitFor(
          () =>
            expect(
              stack1
                .getBrowser()
                .context.pages()
                .some((p) => p.url().includes(`tab=t${i}`)),
            ).toBe(true),
          { timeout: 10_000, interval: 50 },
        );
      }
    }

    await waitSessionFilesContain(stack1.getDirectory(), [
      "tab=t0",
      "tab=t2",
      `tab=t${mruIndex}`,
      `tab=t${totalTabs - 1}`,
    ]);
    await stack1.close();

    // Run 2: cold restart through Home's real BrowserService, activating ONLY tab 0.
    const stack2 = await startStack("r1-run2");
    const row0 = (await tabs.get(f.userId, openedWrites[0]!.id))!;
    await stack2.browser.pageTabs.activate(f.userId, row0, "activate-r1-0");
    await waitPageLoaded(stack2.getBrowser(), "tab=t0");

    const browser2 = stack2.getBrowser();
    const lifecycle2 = (
      browser2 as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycle;

    // Wait for Chromium's startup background-loading wave to settle; every loaded parked tab
    // must be auto-discarded so exactly one profile tab is live (tab 0).
    let tab2Parked: { status: string; discarded: boolean; url: string } | undefined;
    let tabMruParked: { status: string; discarded: boolean; url: string } | undefined;
    await vi.waitFor(
      async () => {
        const inv2 = await lifecycle2.inventory();
        const profileTabs2 = inv2.filter(
          (t) =>
            t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
        );
        expect(profileTabs2).toHaveLength(totalTabs);
        const loaded2 = profileTabs2.filter((t) => t.status !== "unloaded" && !t.discarded);
        expect(loaded2).toHaveLength(1);
        expect(loaded2[0]!.url).toContain("tab=t0");
        expect(browser2.context.pages()).toHaveLength(1);
        expect(browser2.context.pages()[0]!.url()).toContain("tab=t0");
        tab2Parked = profileTabs2.find((t) => t.url.includes("tab=t2"));
        tabMruParked = profileTabs2.find((t) => t.url.includes(`tab=t${mruIndex}`));
      },
      { timeout: 15_000, interval: 100 },
    );

    // Tab 2 (never loaded by Chromium at startup) must stay untouched (not discarded) until claimed,
    // and when claimed through BrowserService must come back with sessionStorage, scroll, and draft!
    expect(tab2Parked).toMatchObject({ status: "unloaded", discarded: false });
    expect(tabMruParked).toMatchObject({ status: "unloaded", discarded: true });

    const row2 = (await tabs.get(f.userId, openedWrites[2]!.id))!;
    await stack2.browser.pageTabs.activate(f.userId, row2, "activate-r1-2");
    await waitPageLoaded(browser2, "tab=t2");
    const page2 = browser2.context.pages().find((p) => p.url().includes("tab=t2"))!;
    expect(page2.restoredFromSession).toBe(true);
    await vi.waitFor(
      async () => expect(await evalOnPage<number>(browser2, "tab=t2", "window.scrollY")).toBe(950),
      { timeout: 5_000, interval: 50 },
    );
    expect(
      await evalOnPage<string>(browser2, "tab=t2", "document.getElementById('draft').value"),
    ).toBe("draft-2");
    expect(await evalOnPage<string | null>(browser2, "tab=t2", "window.__ssAtLoad")).toBe("ss-2");

    // MRU tab (eagerly loaded by Chromium then discarded by R1) must also keep all state!
    const rowMru = (await tabs.get(f.userId, openedWrites[mruIndex]!.id))!;
    await stack2.browser.pageTabs.activate(f.userId, rowMru, `activate-r1-${mruIndex}`);
    await waitPageLoaded(browser2, `tab=t${mruIndex}`);
    const pageMru = browser2.context.pages().find((p) => p.url().includes(`tab=t${mruIndex}`))!;
    expect(pageMru.restoredFromSession).toBe(true);
    await vi.waitFor(
      async () =>
        expect(await evalOnPage<number>(browser2, `tab=t${mruIndex}`, "window.scrollY")).toBe(1150),
      { timeout: 5_000, interval: 50 },
    );
    expect(
      await evalOnPage<string>(
        browser2,
        `tab=t${mruIndex}`,
        "document.getElementById('draft').value",
      ),
    ).toBe(`draft-${mruIndex}`);
    expect(await evalOnPage<string | null>(browser2, `tab=t${mruIndex}`, "window.__ssAtLoad")).toBe(
      `ss-${mruIndex}`,
    );
  }, 90_000);
});
