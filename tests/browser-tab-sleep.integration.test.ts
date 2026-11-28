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

integration("Linux tab sleep through Home BrowserService", () => {
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
          sleeping: Map<string, unknown>;
        };
      }
    ).contextHandle;
    const unconfirmed = () =>
      writes.some((line) => line.includes('"browser-runtime.tab-removal-unconfirmed"'));
    await vi.waitFor(
      () =>
        expect(unconfirmed() || (guards.removals.size === 0 && guards.sleeping.size === 0)).toBe(
          true,
        ),
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
    // The browser looks for its tab helper in the background after launch (establishLifecycle):
    // the handle has it only once that look has ended.
    const handle2 = (
      stack2.getBrowser() as unknown as {
        contextHandle: {
          lifecycle: ChromiumTabLifecycleBridge | undefined;
          lifecycleSettled: Promise<void> | undefined;
        };
      }
    ).contextHandle;
    await handle2.lifecycleSettled;
    const lifecycle2 = handle2.lifecycle;
    expect(lifecycle2, "the restarted browser found no tab helper").toBeDefined();
    expect((await lifecycle2!.inventory()).some((t) => t.url === agentUrl)).toBe(false);
  }, 60_000);
});
