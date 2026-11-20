import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
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
import { chromium } from "playwright-core";
import { createId } from "../packages/core/src/index.js";
import { sql } from "kysely";
import { expect, it } from "vitest";
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

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "relays stock Playwright through Home and a Device to two independently held Chromium sessions",
  async () => {
    const fixture = await createStoreFixture();
    const first = await fixture.startRunFixture("standard-cdp-first");
    const second = await fixture.startRunFixture("standard-cdp-second");
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
    const browser = new BrowserService({
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
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    const a = { agentBindingId: `run:${first.runId}`, ownerId: first.userId };
    const b = { agentBindingId: `run:${second.runId}`, ownerId: second.userId };
    const profile = await browser.createProfile({
      homeRunnerId: first.runnerId,
      ownerId: first.userId,
      name: "Standard CDP",
      idempotencyKey: "standard-cdp-profile",
    });
    const one = (await browser.openAgentSession({ ...a, profileId: profile.id })).session.id;
    const two = (await browser.openAgentSession({ ...b, fresh: true })).session.id;
    await expect(
      browser.issueStandardCdpTicket({ authority: b, browserSessionId: one, mode: "session" }),
    ).rejects.toThrow("does not hold");

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
    ).rejects.toThrow("does not hold that Browser Session");

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
    const left = await chromium.connectOverCDP(homeUrl + aTicket.path);
    clients.push(left);
    const right = await chromium.connectOverCDP(homeUrl + bTicket.path, { noDefaults: true });
    clients.push(right);
    await expect(chromium.connectOverCDP(homeUrl + aTicket.path)).rejects.toThrow("401");
    const leftContext = left.contexts()[0]!;
    const rightContext = right.contexts()[0]!;
    const page = leftContext.pages()[0]!;
    await page.goto(origin);
    expect(await page.evaluate(() => document.title)).toBe("Home CDP fixture");
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
    const png = await page.screenshot({ fullPage: true });
    expect(png.length).toBeGreaterThan(1_048_576);
    const notice = page.waitForEvent("popup");
    await page.evaluate(() => {
      window.open("/popup");
    });
    expect(await (await notice).title()).toBe("Home CDP fixture");
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
    const stopped = Promise.withResolvers<void>();
    left.once("disconnected", () => stopped.resolve());
    browser.closeStandardCdpForBinding(a.agentBindingId, "Stopped by owner.");
    await stopped.promise;
    expect(browser.listStandardCdpAttachmentsForBinding(a.agentBindingId)).toEqual([]);
    const sibling = rightContext.pages()[0]!;
    await sibling.goto(origin + "/sibling");
    expect(await sibling.evaluate(() => document.title)).toBe("Home CDP fixture");
    expect((await store.getBrowserSessionForOwner(one, a.ownerId))?.state).toBe("ready");
    expect((await store.getBrowserSessionForOwner(two, b.ownerId))?.state).toBe("ready");
    const sessionEnded = Promise.withResolvers<void>();
    right.once("disconnected", () => sessionEnded.resolve());
    await browser.stop(b.ownerId, two);
    await sessionEnded.promise;
  },
);
