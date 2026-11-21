import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import type { ChromiumTabLifecycleBridge } from "../apps/browser-runtime/src/browser/tab-lifecycle-extension.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import { BrowserService, type BrowserRuntimeConnection } from "../apps/host/src/browser/browser-service.js";
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
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
      response.end(`<!doctype html><html><head><title>Agent</title></head><body>agent</body></html>`);
      return;
    }
    if (url.pathname === "/deleted-page") {
      response.end(`<!doctype html><html><head><title>Deleted</title></head><body>deleted</body></html>`);
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
  constructor(
    runtimePort: number,
    bridgeToken: string,
    encodedKeys: string,
    ticket: string,
  ) {
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

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);

integration("Linux cold-start session restore through Home BrowserService", () => {
  it(
    "restores saved person tabs by Home tab id, excludes agent and deleted tabs, and leaves zero unclaimed tabs in Chromium",
    async () => {
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
      const pageA = stack1.getBrowser().context.pages().find((p) => p.url().includes("tab=a"))!;
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
      const pageB = stack1.getBrowser().context.pages().find((p) => p.url().includes("tab=b"))!;
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

      // Wait for Chromium to flush Default/Sessions/Session_* before shutdown.
      const profileDir = stack1.getDirectory();
      await vi.waitFor(
        async () => {
          const files = await readdir(path.join(profileDir, "Default", "Sessions")).catch(() => []);
          const sf = files.filter((n) => n.startsWith("Session_"));
          expect(sf.length).toBeGreaterThan(0);
          const sizes = await Promise.all(
            sf.map((n) => stat(path.join(profileDir, "Default", "Sessions", n)).then((s) => s.size)),
          );
          expect(Math.max(...sizes)).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 100 },
      );

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
      const activatedA = await stack2.browser.pageTabs.activate(f.userId, rowA);
      expect(activatedA.surfaceId).toBe(rowA.id);

      const browser2 = stack2.getBrowser();
      const lifecycle2 = (
        browser2 as unknown as { contextHandle: { lifecycle: ChromiumTabLifecycleBridge } }
      ).contextHandle.lifecycle;

      // Immediately after ready: agent tab and deleted tab MUST already be gone from Chromium!
      const invAfterA = await lifecycle2.inventory();
      const nonBlankAfterA = invAfterA.filter(
        (t) => t.url !== "" && t.url !== "about:blank" && !t.url.startsWith("chrome-extension://"),
      );
      expect(nonBlankAfterA.some((t) => t.url.includes("/agent-page"))).toBe(false);
      expect(nonBlankAfterA.some((t) => t.url.includes("/deleted-page"))).toBe(false);
      expect(nonBlankAfterA).toHaveLength(2);

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
      const activatedB = await stack2.browser.pageTabs.activate(f.userId, rowB);
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
    },
    60_000,
  );
});
