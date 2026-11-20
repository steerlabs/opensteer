import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import { TabStore } from "../packages/database/src/tab-store.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import type { RunnerAuxiliaryStream } from "../packages/orchestration/src/runner-registry.js";
import { machineAccessPolicyDefault } from "../packages/protocol/src/shell.js";
import { RunnerAuxiliaryFrameFenceSchema } from "../packages/protocol/src/runner-auxiliary.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createId } from "../packages/core/src/index.js";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { BrowserModuleRelay } from "../packages/runner-client/src/browser-relay.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { RunnerBrowserHub } from "../apps/host/src/browser/runner-browser-hub.js";
import {
  BrowserRuntimeRelayToHostMessageSchema,
  RunnerBrowserRuntimeRouter,
} from "../apps/host/src/browser/runner-browser-runtime.js";
import { HarnessAuthenticationCoordinator } from "../apps/host/src/identity/harness-authentication-coordinator.js";
import { signHostDiscovery } from "../apps/host/src/identity/host-keys.js";
import { createHostServer } from "../apps/host/src/server.js";
import { hostServerTestDependencies } from "../apps/host/src/server/host-server-test-harness.js";

import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import { TabService } from "../apps/host/src/tabs/tab-service.js";
import {
  authorizeTabActor,
  authorizeTabTarget,
  canReadTab,
  tabComputer,
  tabReadAuthority,
} from "../apps/host/src/tabs/tab-authority.js";
import { requireDeviceAccess } from "../apps/host/src/administration/device-access.js";

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "runs sandboxed browser scripts through Home and a Device without sharing task tabs",
  async () => {
    const fixture = await createStoreFixture();
    const first = await fixture.startRunFixture("browser-use-first");
    const second = await fixture.startRunFixture("browser-use-second");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", first.runnerId)
      .execute();
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-home-browser-use-"));
    const key = generateKeyPairSync("ed25519");
    const bridgeToken = randomBytes(32).toString("base64url");
    const runtimeId = "home-browser-use";
    let attachKeys: readonly { keyId: string; publicKeyPem: string }[] = [];
    const runtime = new BrowserRuntime({
      launcher: new PlaywrightChromiumLauncher({
        headless: true,
        chromiumSandbox: false,
        executablePath: chromium.executablePath(),
      }),
      localProfiles: { root: join(scratch, "profiles") },
      runtimeId,
      sessionFilesRoot: join(scratch, "files"),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        replayLedgerPath: join(scratch, "private", "replay.json"),
        resolvePublicKey: (id) =>
          attachKeys.find(({ keyId }) => keyId === id)?.publicKeyPem ?? null,
      }),
    });
    const runtimeServer = new BrowserRuntimeServer({
      runtime,
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: (keys) => {
          attachKeys = keys;
        },
      },
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        await runtimeServer.close();
        await rm(scratch, { recursive: true, force: true });
      },
    }));
    const engine = await runtimeServer.start();
    const localProfiles = new BrowserLocalProfiles({
      baseUrl: new URL("http://127.0.0.1"),
      deploymentId: first.deploymentId,
      repository: store,
    });
    const hub = new RunnerBrowserHub();
    const targetResolver = new RunnerBrowserRuntimeRouter({ registry: hub, localProfiles });
    const runner = new BrowserModuleRelay(
      new LocalBrowserRuntimeBridge({
        runtimeId,
        bridgeToken,
        url: new URL(`http://${engine.host}:${engine.port}`),
      }),
    );
    const fence = RunnerAuxiliaryFrameFenceSchema.parse({
      runnerId: first.runnerId,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
      auxiliaryStreamId: `rax_${randomUUID()}`,
      module: "browser",
    });
    const { auxiliaryStreamId, module: _module, ...primaryFence } = fence;
    const stream: RunnerAuxiliaryStream = {
      auxiliaryStreamId,
      fence,
      streamLeaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
      identity: {
        ...primaryFence,
        fence: primaryFence,
        allowedModules: ["agents", "browser"],
        capabilities: [],
        environmentIds: [first.environmentId],
        personalRemoteAccessGeneration: null,
        runnerKind: "main",
        name: "Browser Device",
        runtimeVersion: "test",
        modules: {
          browser: {
            runtimeId,
            wireVersion: 2,
            standardCdp: 1,
            wholeContextCdp: 1,
            ...(runtime.localProfileStorage
              ? { localProfileStorage: runtime.localProfileStorage }
              : {}),
            cdpBoundary: 1,
            sharedControl: 1,
            targetControl: 1,
            tabRestoreVersion: 1,
            surfaceState: 1,
            popupFollowVersion: 1,
          },
        },
      },
    };
    const peer = {
      id: "browser-device",
      close: () => runner.detach(),
      send: (message: unknown) => runner.handleFrame(Buffer.from(JSON.stringify(message)), false),
    };
    hub.attach(peer, stream);
    const tabStore = new TabStore(database);
    const device = await store.requireSelfDeviceId(first.runnerId);
    const setBrowserAccess = (enabled: boolean) =>
      database
        .updateTable("devices")
        .set({ accessPolicy: { ...machineAccessPolicyDefault, browser: enabled } })
        .where("id", "=", device)
        .execute();
    await setBrowserAccess(true);
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "in", [first.threadId, second.threadId])
      .execute();
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "in", [first.runId, second.runId])
      .execute();
    const checkDevice = async (id: typeof first.runnerId) =>
      requireDeviceAccess(database, await store.requireSelfDeviceId(id), "browser", true);
    const browser = new BrowserService({
      tabs: tabStore,
      tabPlaces: { write: (input) => store.recordRunTabPlace(input), notice: () => {} },
      requireAgentAccess: checkDevice,
      requireAgentVisibility: checkDevice,
      repository: personalBrowserRepository(store),
      deploymentId: first.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      localProfiles,
      targetResolver,
      signer: new BrowserAttachTicketSigner({ privateKey: key.privateKey, keyId: "test" }),
      onSessionsChanged: () => {},
    });
    const tabs = new TabService({
      store: tabStore,
      devices: store,
      pages: browser.pageTabs,
      nativeTargets: {
        resolveWindow: vi.fn(),
        windowState: vi.fn(),
        phoneState: vi.fn(),
        openOwnerView: vi.fn(),
        closeOwnerViews: vi.fn(),
        onTargetAcquired: () => () => {},
      },
      apps: { get: vi.fn() },
      computer: async (owner, id, db) => ({
        ...(await tabComputer(owner, id, db)),
        connected: true,
      }),
      canRead: canReadTab,
      canReadTask: async () => true,
      readAuthority: tabReadAuthority,
      authorize: authorizeTabTarget,
      authorizeMembership: authorizeTabActor,
      onError: (error) => {
        throw error;
      },
    });
    const scripts = new BrowserScriptService({ browser, store, tabs });
    const home = await createHostServer(
      hostServerTestDependencies({
        browser,
        store,
        discovery: signHostDiscovery(key, {
          canonicalOrigin: "http://127.0.0.1",
          deploymentId: first.deploymentId,
          hostInstanceId: createId("hostInstance"),
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: { kind: "personal" },
        }),
        harnessAuthenticationCoordinator: new HarnessAuthenticationCoordinator({
          harnesses: { getHarnessInstance: async () => null },
          runners: {
            isAvailable: () => false,
            manageHarnessAuthentication: async () => ({ status: "not-started" }),
          },
        }),
      }),
    );
    const pending = new Map<
      string,
      {
        started: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    >();
    const hold = (name: string) => {
      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      pending.set(name, gate);
      return gate;
    };
    const site = createServer((request, response) => {
      const gate = pending.get(request.url ?? "");
      if (gate) {
        gate.started.resolve();
        void gate.release.promise.then(() => response.end("done"));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/popup"
          ? "<title>Popup</title><h1>Popup</h1>"
          : `
        <title>Home browser fixture</title><h1>Home browser fixture</h1>
        <button onclick="this.textContent = 'Clicked'">Click me</button>
        <button onclick="window.open('/popup')">Open popup</button>
      `,
      );
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        for (const { release } of pending.values()) release.resolve();
        await scripts.close();
        await home.close();
        await browser.close();
        targetResolver.close();
        runner.detach();
        if (site.listening) await new Promise<void>((resolve) => site.close(() => resolve()));
      },
    }));
    await runner.attach({
      fence,
      browserWireVersion: 2,
      browserAttachPublicKeys: [
        {
          keyId: "test",
          publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
      send: async (frame, binary) => {
        if (binary) await hub.handleBinary(peer, Buffer.from(frame));
        else {
          const message = BrowserRuntimeRelayToHostMessageSchema.parse(JSON.parse(String(frame)));
          if (message.type !== "runner.auxiliary.heartbeat") await hub.handleMessage(peer, message);
        }
      },
    });
    await home.listen({ port: 0, host: "127.0.0.1" });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    const a = { agentBindingId: `run:${first.runId}`, ownerId: first.userId };
    const b = { agentBindingId: `run:${second.runId}`, ownerId: second.userId };
    const profile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "Browser scripts",
      idempotencyKey: "browser-use-profile",
    });
    const contextKey = "journey";
    const run = (code: string, authority = a) =>
      scripts.runBrowserScript({ authority, contextKey, code });
    const text = (result: Awaited<ReturnType<typeof run>>) => {
      if (result.isError) throw new Error(JSON.stringify(result));
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Missing browser script text.");
      return block.text;
    };
    const journey = await run(`
      globalThis.page = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
      await page.goto(${JSON.stringify(origin)});
      const heading = await page.locator("h1").innerText();
      await page.getByRole("button", { name: "Click me" }).click();
      print({ tabId: page.tabId, heading, clicked: await page.getByRole("button", { name: "Clicked" }).innerText() });
      await page.screenshot();
    `);
    const { tabId } = JSON.parse(text(journey));
    expect(JSON.parse(text(journey))).toEqual({
      tabId: expect.any(String),
      heading: "Home browser fixture",
      clicked: "Clicked",
    });
    expect(journey.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.stringMatching(/^iVBORw0KGgo/u),
    });
    expect(JSON.parse(text(await run("return await pages();", b)))).toEqual([]);
    expect(await run(`await openPage(${JSON.stringify(tabId)});`, b)).toMatchObject({
      isError: true,
    });
    expect(text(await run(`print((await openPage(${JSON.stringify(tabId)})) === page);`))).toBe(
      "true",
    );
    expect(
      text(
        await run(`
      await page.getByRole("button", { name: "Open popup" }).click();
      const { targetInfos } = await page.cdp("Target.getTargets");
      const popup = targetInfos.find(({url}) => url.endsWith("/popup"));
      const handle = await openPage(popup.surfaceId);
      await handle.locator("h1").waitFor();
      print(await handle.locator("h1").innerText());
    `),
      ),
    ).toBe("Popup");

    const policy = hold("/policy");
    const recheck = run(
      `await page.js("fetch('/policy').then(r => r.text())"); await page.title();`,
    );
    await Promise.race([
      policy.started.promise,
      recheck.then((result) => {
        throw new Error(JSON.stringify(result));
      }),
    ]);
    await setBrowserAccess(false);
    policy.release.resolve();
    expect(await recheck).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "forbidden" } },
    });
    await setBrowserAccess(true);

    const abandoned = hold("/abandoned");
    try {
      const unfinished = run(`
        await page.cdp("Network.enable");
        void page.js("fetch('/abandoned').then(r => r.text())").catch(() => {});
        for (;;) {
          if (page.drainEvents().some(({ method, params }) =>
            method === "Network.requestWillBeSent" && params.request.url.endsWith("/abandoned"))) break;
          await sleep(20);
        }
        return "done";
      `);
      await Promise.race([
        abandoned.started.promise,
        unfinished.then((result) => {
          throw new Error(JSON.stringify(result));
        }),
      ]);
      expect(await unfinished).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "outcome-unknown" } },
      });
    } finally {
      abandoned.release.resolve();
    }
    const stop = hold("/stop");
    const inFlight = run(`await page.js("fetch('/stop').then(r => r.text())");`);
    await Promise.race([
      stop.started.promise,
      inFlight.then((result) => {
        throw new Error(JSON.stringify(result));
      }),
    ]);
    await scripts.closeBrowserScriptsForBinding(a.agentBindingId);
    expect(await inFlight).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "outcome-unknown" } },
    });
    stop.release.resolve();
    const tab = await tabStore.get(a.ownerId, tabId);
    expect(tab?.pageBinding).toBeTruthy();
    expect(
      await store.getBrowserSessionForOwner(tab!.pageBinding!.sessionId, a.ownerId),
    ).toMatchObject({ state: "ready" });
  },
);
