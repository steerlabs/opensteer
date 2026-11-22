import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import { BrowserRuntimeError } from "../packages/browser-runtime-core/src/errors.js";
import type { LaunchedBrowser } from "../packages/browser-runtime-core/src/browser/backend.js";
import { SurfaceLedger } from "../packages/browser-runtime-core/src/browser/surface-ledger.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import type { RunnerAuxiliaryStream } from "../packages/orchestration/src/runner-registry.js";
import { RunnerAuxiliaryFrameFenceSchema } from "../packages/protocol/src/runner-auxiliary.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  createId,
  type BrowserProfileId,
  type TabId,
  type UserId,
} from "../packages/core/src/index.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import { beginAgentSession } from "../packages/database/src/agent-session-store.js";
import { TabStore } from "../packages/database/src/tab-store.js";
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
import { authorizeTabActor, authorizeTabTarget } from "../apps/host/src/tabs/tab-authority.js";
import { TabService } from "../apps/host/src/tabs/tab-service.js";

async function startRelayFixture(workspaceTabs: boolean, signal: AbortSignal) {
  const fixture = await createStoreFixture();
  const first = await fixture.startRunFixture("standard-cdp-first");
  const { database, store } = fixture;
  await database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
    .where("id", "=", first.runnerId)
    .execute();
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-home-standard-cdp-"));
  const key = generateKeyPairSync("ed25519");
  const bridgeToken = randomBytes(32).toString("base64url");
  const runtimeId = "home-standard-cdp";
  let attachKeys: readonly { keyId: string; publicKeyPem: string }[] = [];
  const launcher = new PlaywrightChromiumLauncher({
    headless: true,
    chromiumSandbox: false,
    executablePath: chromium.executablePath(),
  });
  const engines = new Map<BrowserProfileId, LaunchedBrowser>();
  const launch = launcher.launch.bind(launcher);
  vi.spyOn(launcher, "launch").mockImplementation(async (request, signal) => {
    const launched = await launch(request, signal);
    if (request.storage.kind === "local") engines.set(request.storage.binding.profileId, launched);
    return launched;
  });
  const runtime = new BrowserRuntime({
    launcher,
    localProfiles: { root: join(scratch, "profiles") },
    runtimeId,
    sessionFilesRoot: join(scratch, "files"),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: join(scratch, "private", "replay.json"),
      resolvePublicKey: (id) => attachKeys.find(({ keyId }) => keyId === id)?.publicKeyPem ?? null,
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
  const engine = await runtimeServer.start();
  const localProfiles = new BrowserLocalProfiles({
    baseUrl: new URL("http://127.0.0.1"),
    deploymentId: first.deploymentId,
    repository: store,
  });
  const hub = new RunnerBrowserHub();
  const targetResolver = new RunnerBrowserRuntimeRouter({ registry: hub, localProfiles });
  const bridge = new LocalBrowserRuntimeBridge({
    runtimeId,
    bridgeToken,
    url: new URL(`http://${engine.host}:${engine.port}`),
  });
  const capabilities = await bridge.capabilities();
  const runner = new BrowserModuleRelay(bridge);
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
          ...capabilities,
          cdpBoundary: 1,
          sharedControl: 1,
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
  const tabs = workspaceTabs ? new TabStore(database) : undefined;
  const browser = new BrowserService({
    ...(tabs ? { tabs, tabPlaces: { write: async () => false, notice: () => {} } } : {}),
    repository: personalBrowserRepository(store),
    deploymentId: first.deploymentId,
    hostOrigin: new URL("http://127.0.0.1"),
    personal: true,
    localProfiles,
    targetResolver,
    signer: new BrowserAttachTicketSigner({ privateKey: key.privateKey, keyId: "test" }),
    onSessionsChanged: () => {},
  });
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
  const site = createServer((_request, response) =>
    response.end("<title>Home CDP fixture</title><button>Home</button>"),
  );
  const clients: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
  await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
    close: async () => {
      for (const client of clients) await client.close();
      await home.close();
      await browser.close();
      targetResolver.close();
      runner.detach();
      await runtimeServer.close();
      if (site.listening) await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
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
  const homeUrl = (await home.listen({ port: 0, host: "127.0.0.1" })).replace(/^http/u, "ws");
  const listening = once(site, "listening", { signal });
  site.listen(0, "127.0.0.1");
  await listening;
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  return { fixture, first, database, store, tabs, browser, clients, homeUrl, origin, engines };
}

async function waitForDisconnect(client: Browser, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const disconnected = () => resolve();
  client.once("disconnected", disconnected);
  try {
    await withTimeout(promise, 5_000, {
      signal,
      timeoutError: () => new Error("Playwright did not receive the browser disconnect."),
    });
  } finally {
    client.off("disconnected", disconnected);
  }
}

async function checkPageCdp(
  owned: Page,
  signal: AbortSignal,
  /** Work under a connection's authority, which hears the one method sentence. */
  connection = false,
): Promise<void> {
  await withTimeout(
    (async () => {
      const cdp = await owned.context().newCDPSession(owned);
      const targets = cdp.send("Target.getTargets").then((result) => {
        expect(result).toMatchObject({
          targetInfos: [expect.objectContaining({ url: owned.url(), type: "page" })],
        });
      });
      const fills = [
        ["Opensteer.fillLogin", { loginRef: `lgn_${"1".repeat(32)}`, field: "password" }],
        ["Opensteer.fillCard", { cardRef: `crd_${"1".repeat(32)}`, field: "number" }],
      ] as const;
      await Promise.all([
        targets,
        cdp.send("Network.enable"),
        ...fills.map(([method, parameters]) => {
          const fill: Promise<unknown> = Reflect.apply(cdp.send, cdp, [method, parameters]);
          // A connection's refused command answers the one method sentence, naming no Home.
          return expect(fill).rejects.toThrow(
            connection
              ? `${method} is not available to a connected agent.`
              : "Saved login and card fills use browser_use",
          );
        }),
      ]);
      await cdp.detach();
      expect(await owned.evaluate(() => 42)).toBe(42);
    })(),
    8_000,
    { signal, timeoutError: () => new Error("The page CDP check timed out.") },
  );
}

async function startConnectedTask(database: TabStore["database"], userId: UserId) {
  const connections = new AgentConnectionStore(database);
  const connection = await connections.create({
    userId,
    label: "Managed CDP fixture",
    clientName: "Managed CDP fixture",
    accessMode: "full-access",
    grant: { scope: "everything" },
    resource: "https://home.example.test/mcp",
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(await connections.activate(connection.id, randomBytes(32).toString("hex"))).toBe(true);
  const { session } = await beginAgentSession(database, {
    userId,
    agentConnectionId: connection.id,
  });
  return { connection, session };
}

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "relays stock Playwright through Home and a Device to two independently held Chromium sessions",
  async ({ signal, onTestFailed }) => {
    const started = performance.now();
    let phase = "starting fixture";
    onTestFailed(() => {
      console.error(
        `Standard CDP relay was ${phase} at ${Math.round(performance.now() - started)}ms.`,
      );
    });
    const { fixture, first, store, browser, clients, homeUrl, origin } = await startRelayFixture(
      false,
      signal,
    );
    const second = await fixture.startRunFixture("standard-cdp-second");
    phase = "opening the two Run browser sessions";
    const a = { agentBindingId: `run:${first.runId}`, ownerId: first.userId };
    const b = { agentBindingId: `run:${second.runId}`, ownerId: second.userId };
    const profile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "Standard CDP",
      idempotencyKey: "standard-cdp-profile",
    });
    const [{ session: leftSession }, { session: rightSession }] = await Promise.all([
      browser.openAgentSession({ ...a, profileId: profile.id }),
      browser.openAgentSession({ ...b, fresh: true }),
    ]);
    const one = leftSession.id;
    const two = rightSession.id;
    phase = "checking ticket ownership";
    await expect(
      browser.issueStandardCdpTicket({ authority: b, browserSessionId: one, mode: "session" }),
    ).rejects.toThrow("This task does not have access to that browser tab.");

    const intended = await browser.issueStandardCdpTicket({
      authority: a,
      browserSessionId: one,
      mode: "session",
    });
    const issuedClaims = browser.standardCdpTickets.consume(intended.ticket)!;
    const wrongBinding = browser.standardCdpTickets.issue({ ...issuedClaims, authority: b });
    await expect(
      chromium.connectOverCDP(`${homeUrl}/v1/browser/connect/${wrongBinding}`, {
        noDefaults: true,
      }),
    ).rejects.toThrow("This task does not have access to that browser tab.");

    phase = "issuing the clients’ tickets";
    const aTicket = await browser.issueStandardCdpTicket({
      authority: a,
      browserSessionId: one,
      mode: "whole-context",
    });
    const bTicket = await browser.issueStandardCdpTicket({
      authority: b,
      browserSessionId: two,
      mode: "whole-context",
    });
    expect(aTicket.mode).toBe("whole-context");
    expect(bTicket.mode).toBe("session");
    phase = "connecting both clients";
    const connect = async (path: string, noDefaults = false) => {
      const client = await chromium.connectOverCDP(homeUrl + path, { noDefaults });
      clients.push(client);
      return client;
    };
    const [left, right] = await Promise.all([connect(aTicket.path), connect(bTicket.path, true)]);
    phase = "checking ticket replay";
    await expect(chromium.connectOverCDP(homeUrl + aTicket.path)).rejects.toThrow("401");
    const leftContext = left.contexts()[0]!;
    const rightContext = right.contexts()[0]!;
    expect(leftContext.pages()).toHaveLength(1);
    expect(rightContext.pages()).toHaveLength(1);
    const page = leftContext.pages()[0]!;
    phase = "navigating the left page";
    await page.goto(origin);
    expect(await page.evaluate(() => document.title)).toBe("Home CDP fixture");
    phase = "waiting for the popup";
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 5_000 }),
      page.evaluate(() => {
        window.open("/popup");
      }),
    ]);
    expect(await popup.title()).toBe("Home CDP fixture");
    phase = "checking context cookies";
    await leftContext.addCookies([{ name: "profile", value: "granted", url: origin }]);
    expect(await leftContext.cookies(origin)).toMatchObject([
      { name: "profile", value: "granted" },
    ]);
    await expect(rightContext.cookies()).rejects.toThrow("requires a whole browser context grant");
    expect(browser.listStandardCdpAttachmentsForBinding(a.agentBindingId)).toEqual([
      {
        browserSessionId: one,
        profileId: profile.id,
        mode: "whole-context",
        since: expect.any(String),
      },
    ]);
    expect(left.isConnected(), "The left client should still be connected before Stop").toBe(true);
    phase = "waiting for the left client to disconnect";
    const stopped = waitForDisconnect(left, signal);
    browser.closeStandardCdpForBinding(a.agentBindingId, "Stopped by owner.");
    await stopped;
    expect(browser.listStandardCdpAttachmentsForBinding(a.agentBindingId)).toEqual([]);
    phase = "driving the remaining client";
    const sibling = rightContext.pages()[0]!;
    await sibling.goto(origin + "/sibling");
    expect(await sibling.evaluate(() => document.title)).toBe("Home CDP fixture");
    expect((await store.getBrowserSessionForOwner(one, a.ownerId))?.state).toBe("ready");
    expect((await store.getBrowserSessionForOwner(two, b.ownerId))?.state).toBe("ready");
    phase = "waiting for the right client to disconnect";
    expect(right.isConnected(), "The right client should still be connected before Stop").toBe(
      true,
    );
    await Promise.all([waitForDisconnect(right, signal), browser.stop(b.ownerId, two)]);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "relays a command and a full-page screenshot larger than 1 MiB through Home and a Device",
  async ({ signal }) => {
    const { first, browser, clients, homeUrl, origin } = await startRelayFixture(false, signal);
    const authority = { agentBindingId: `run:${first.runId}`, ownerId: first.userId };
    const profile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "Standard CDP large frames",
      idempotencyKey: "standard-cdp-large-frames",
    });
    const { session } = await browser.openAgentSession({ ...authority, profileId: profile.id });
    const ticket = await browser.issueStandardCdpTicket({
      authority,
      browserSessionId: session.id,
      mode: "whole-context",
    });
    expect(ticket.mode).toBe("whole-context");
    const client = await chromium.connectOverCDP(homeUrl + ticket.path);
    clients.push(client);
    const page = client.contexts()[0]!.pages()[0]!;
    await page.goto(origin);
    await checkPageCdp(page, signal);
    const largeArgument = "x".repeat(1_100_000);
    expect(await page.evaluate((value) => value.length, largeArgument)).toBe(largeArgument.length);
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 680;
      canvas.height = 640;
      const ctx = canvas.getContext("2d")!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      const bytes = new Uint8Array(pixels.data.length);
      for (let offset = 0; offset < bytes.length; offset += 65_536)
        crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
      for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
      pixels.data.set(bytes);
      ctx.putImageData(pixels, 0, 0);
      document.body.append(canvas);
    });
    const png = await page.screenshot({ fullPage: true, timeout: 8_000 });
    expect(png.length).toBeGreaterThan(1_048_576);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "ends an existing CDP attachment when its task mode changes and admits a fresh one",
  async ({ signal }) => {
    const { first, database, store, tabs, browser, clients, homeUrl, origin } =
      await startRelayFixture(true, signal);
    if (!tabs) throw new Error("The CDP mode fixture has no tab catalog.");
    const { connection, session } = await startConnectedTask(database, first.userId);
    const authority = { agentBindingId: `session:${session.id}`, ownerId: first.userId };
    const modeProfile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "CDP mode change",
      idempotencyKey: "standard-cdp-mode-profile",
    });
    const actor = { kind: "browser-binding", authority, threadId: session.threadId } as const;
    const write = await browser.pageTabs.open(
      actor,
      { kind: "page", profileId: modeProfile.id, url: "about:blank" },
      "standard-cdp-mode-tab",
    );
    await tabs.open(write, "standard-cdp-mode-tab");
    await browser.pageTabs.admitted!(write);
    const row = await tabs.get(first.userId, write.id);
    if (!row) throw new Error("The CDP mode fixture has no task tab.");
    const seed = await browser.pageTabs.bindBrowserScript!(actor, row);
    const request = {
      authority,
      browserSessionId: seed.sessionId,
      seedTabId: seed.tabId,
      mode: "session",
    } as const;
    if (connection.grantRevision === undefined)
      throw new Error("The CDP mode fixture has no grant revision.");
    const witness = {
      grantRevision: connection.grantRevision,
      mode: "full-access",
      targetGeneration: row.generation,
    } as const;
    for (const operationWitness of [
      { ...witness, grantRevision: witness.grantRevision + 1 },
      { ...witness, targetGeneration: witness.targetGeneration + 1 },
    ]) {
      await expect(
        browser.issueStandardCdpTicket({ ...request, operationWitness }),
      ).rejects.toThrow("This browser authority changed. Request a new attachment.");
    }
    const connect = async (mode: "full-access" | "approval-required") => {
      const ticket = await browser.issueStandardCdpTicket({
        ...request,
        operationWitness: { ...witness, mode },
      });
      expect(ticket.mode).toBe("session");
      const client = await chromium.connectOverCDP(homeUrl + ticket.path, { noDefaults: true });
      clients.push(client);
      return { client, page: client.contexts()[0]!.pages()[0]! };
    };
    const { client, page: before } = await connect("full-access");
    await before.goto(origin);
    expect(await before.title()).toBe("Home CDP fixture");
    await checkPageCdp(before, signal, true);
    await Promise.all([
      waitForDisconnect(client, signal),
      store.updateThreadAccessMode({
        threadId: session.threadId,
        requestedBy: first.userId,
        accessMode: "approval-required",
      }),
    ]);
    await expect(before.evaluate(() => document.title)).rejects.toThrow();
    await expect(
      browser.issueStandardCdpTicket({ ...request, operationWitness: witness }),
    ).rejects.toThrow("This browser authority changed. Request a new attachment.");
    const fresh = await connect("approval-required");
    expect(await fresh.page.title()).toBe("Home CDP fixture");

    const refuseWrite = Promise.withResolvers<void>();
    const retrying = Promise.withResolvers<void>();
    const permitClose = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const open = tabs.open.bind(tabs);
    let unrecordedId: typeof seed.tabId | undefined;
    const catalog = vi.spyOn(tabs, "open").mockImplementation(async (write, key, ...rest) => {
      if (!key.startsWith("connected-page:")) return open(write, key, ...rest);
      unrecordedId = write.id;
      await refuseWrite.promise;
      throw new Error("Fixture refuses the connected page catalog write.");
    });
    const close = SurfaceLedger.prototype.closeDurableSurface;
    let attempts = 0;
    const physical = vi
      .spyOn(SurfaceLedger.prototype, "closeDurableSurface")
      .mockImplementation(async function (this: SurfaceLedger, id) {
        if (id !== unrecordedId) return close.call(this, id);
        if (++attempts === 1)
          throw new BrowserRuntimeError("conflict", "Fixture refuses the first physical close.");
        retrying.resolve();
        await permitClose.promise;
        await close.call(this, id);
        closed.resolve();
      });
    try {
      const unrecorded = await fresh.page.context().newPage();
      const disconnected = waitForDisconnect(fresh.client, signal);
      refuseWrite.resolve();
      await disconnected;
      await expect(unrecorded.evaluate(() => 42)).rejects.toThrow();
      const withinClose = {
        signal,
        timeoutError: () => new Error("Physical close did not settle."),
      };
      await withTimeout(retrying.promise, 5_000, withinClose);
      permitClose.resolve();
      await withTimeout(closed.promise, 5_000, withinClose);
      expect(unrecordedId).toBeDefined();
      expect(await tabs.get(first.userId, unrecordedId!, true)).toBeNull();
    } finally {
      catalog.mockRestore();
      physical.mockRestore();
      refuseWrite.resolve();
      permitClose.resolve();
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "closes the direct-work page and preserves the Run page when their tabs share a connection lineage",
  async ({ signal }) => {
    const { first, database, store, tabs, browser, clients, homeUrl, origin, engines } =
      await startRelayFixture(true, signal);
    if (!tabs) throw new Error("The CDP lineage fixture has no tab catalog.");
    const { connection, session } = await startConnectedTask(database, first.userId);
    await database
      .updateTable("threads")
      .set({ originConnectionId: connection.id })
      .where("id", "=", first.threadId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runs")
      .set({
        connectionId: connection.id,
        admittedGrantRevision: connection.grantRevision,
        admittedAccessMode: "full-access",
      })
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    const profile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "CDP close lineage",
      idempotencyKey: "standard-cdp-close-lineage-profile",
    });
    const open = async (binding: string, threadId: typeof first.threadId, key: string) => {
      const authority = { ownerId: first.userId, agentBindingId: binding };
      const actor = { kind: "browser-binding", authority, threadId } as const;
      const write = await browser.pageTabs.open(
        actor,
        { kind: "page", profileId: profile.id, url: "about:blank" },
        key,
      );
      await tabs.open(write, key);
      await browser.pageTabs.admitted!(write);
      const row = await tabs.get(first.userId, write.id);
      if (!row) throw new Error("Expected an open task tab.");
      const seed = await browser.pageTabs.bindBrowserScript!(actor, row);
      return { authority, id: row.id, seed };
    };
    const run = await open(`run:${first.runId}`, first.threadId, "close-lineage-run");
    const direct = await open(`session:${session.id}`, session.threadId, "close-lineage-direct");
    const connect = async ({ authority, seed }: typeof direct) => {
      const ticket = await browser.issueStandardCdpTicket({
        authority,
        browserSessionId: seed.sessionId,
        seedTabId: seed.tabId,
        mode: "session",
      });
      const client = await chromium.connectOverCDP(homeUrl + ticket.path, { noDefaults: true });
      clients.push(client);
      return client.contexts()[0]!;
    };
    const directContext = await connect(direct);
    const directPage = directContext.pages()[0]!;
    await directPage.goto(origin + "/direct");
    const runContext = await connect(run);
    const runPage = runContext.pages().find((page) => page.url() === "about:blank")!;
    await runPage.goto(origin + "/run");
    const unexpected = async () => {
      throw new Error("The page-close test does not use native tabs.");
    };
    const service = new TabService({
      store: tabs,
      devices: store,
      pages: browser.pageTabs,
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
      canRead: async () => true,
      canReadTask: async () => true,
      authorize: authorizeTabTarget,
      authorizeMembership: authorizeTabActor,
      onError: (error) => {
        throw error;
      },
    });
    const owner = { kind: "person", ownerId: first.userId } as const;
    try {
      const tabPublished = Promise.withResolvers<TabId>();
      const openRow = tabs.open.bind(tabs);
      const captureTab = vi.spyOn(tabs, "open").mockImplementation(async (write, key, ...rest) => {
        const result = await openRow(write, key, ...rest);
        if (
          key.startsWith("connected-page:") &&
          write.pageBinding?.sessionId === direct.seed.sessionId
        )
          tabPublished.resolve(write.id);
        return result;
      });
      const retryUrl = origin + "/close-retry";
      const { retryPage, retryId } = await (async () => {
        try {
          const retryPage = await directContext.newPage();
          await retryPage.goto(retryUrl);
          const retryId = await withTimeout(tabPublished.promise, 5_000, {
            signal,
            timeoutError: () => new Error("The managed page was not recorded in Tabs."),
          });
          return { retryPage, retryId };
        } finally {
          captureTab.mockRestore();
        }
      })();
      expect(await tabs.get(first.userId, retryId)).toMatchObject({
        openedBy: { taskId: session.threadId },
        closedAt: null,
      });
      const engine = engines.get(profile.id);
      if (!engine) throw new Error("Chromium did not start for the close fixture.");
      const targets = async () =>
        (await engine.cdp.send("Target.getTargets")) as {
          targetInfos: { targetId: string; url: string }[];
        };
      const retryTarget = (await targets()).targetInfos.find(({ url }) => url === retryUrl);
      if (!retryTarget) throw new Error("Chromium did not report the page for this close test.");
      const { targetId } = retryTarget;
      const channel = await directContext.newCDPSession(retryPage);
      const root = await directContext.browser()!.newBrowserCDPSession();
      const retryArrived = Promise.withResolvers<void>();
      const allowClose = Promise.withResolvers<void>();
      const physicalClose = Promise.withResolvers<void>();
      const close = SurfaceLedger.prototype.closeDurableSurface;
      let attempts = 0;
      const failClose = vi
        .spyOn(SurfaceLedger.prototype, "closeDurableSurface")
        .mockImplementation(async function (this: SurfaceLedger, id) {
          if (id !== retryId) return close.call(this, id);
          if (++attempts === 1)
            throw new BrowserRuntimeError("conflict", "Fixture refuses the first physical close.");
          retryArrived.resolve();
          await allowClose.promise;
          await close.call(this, id);
          physicalClose.resolve();
        });
      try {
        expect(await service.close(owner, [retryId], "close-with-runtime-refusal")).toEqual({
          closed: [retryId],
          failed: [],
        });
        expect(attempts).toBeGreaterThanOrEqual(1);
        expect((await targets()).targetInfos.map((target) => target.targetId)).toContain(targetId);
        await expect(channel.send("Runtime.evaluate", { expression: "42" })).rejects.toThrow();
        const visible = await root.send("Target.getTargets");
        expect(visible.targetInfos.map((target) => target.targetId)).not.toContain(targetId);
        await expect(
          root.send("Target.attachToTarget", { targetId, flatten: true }),
        ).rejects.toThrow();
        expect(await directPage.evaluate(() => location.pathname)).toBe("/direct");
        await withTimeout(retryArrived.promise, 5_000, {
          signal,
          timeoutError: () => new Error("The Home did not retry the physical close."),
        });
        allowClose.resolve();
        await withTimeout(physicalClose.promise, 5_000, {
          signal,
          timeoutError: () => new Error("The Runtime did not confirm the retried close."),
        });
        expect((await targets()).targetInfos.map((target) => target.targetId)).not.toContain(
          targetId,
        );
      } finally {
        allowClose.resolve();
        failClose.mockRestore();
        await root.detach();
      }

      const ended = directPage.waitForEvent("close", { timeout: 0 });
      const outcome = await service.close(owner, [direct.id, run.id], "close-same-lineage");
      expect(outcome.failed).toEqual([]);
      expect(outcome.closed).toHaveLength(2);
      expect(outcome.closed).toEqual(expect.arrayContaining([direct.id, run.id]));
      await ended;
      expect(await runPage.evaluate(() => location.pathname)).toBe("/run");
    } finally {
      service.dispose();
    }
  },
);
