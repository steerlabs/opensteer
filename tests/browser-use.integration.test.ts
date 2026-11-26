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
import { AgentConnectionStore, beginAgentSession } from "../packages/database/src/index.js";
import { ownTestDatabaseProducer } from "../packages/database/src/test-database.test-support.js";
import type { RunnerAuxiliaryStream } from "../packages/orchestration/src/runner-registry.js";
import {
  browserHostMethods,
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
} from "../packages/protocol/src/browser.js";
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
import {
  AgentGrantSchema,
  AgentOperationIdSchema,
  createId,
  ThreadIdSchema,
  type ThreadId,
} from "../packages/core/src/index.js";
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
  HostToBrowserRuntimeRelayMessageSchema,
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
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
} from "../apps/host/src/mcp/handlers/browser.js";

/** A Home and a Device with a real headless Chromium, as the browser script journeys use them. */
async function browserUseHome() {
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
          connectionCommands: 1,
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
  const queuedExpression = "document.title = 'cancelled command ran'";
  const queuedCommand = Promise.withResolvers<string>();
  const cancelledRequests = new Set<string>();
  const cancellationAcknowledged = Promise.withResolvers<string>();
  // Faults a journey injects into the Device's commands and replies.
  const faults: {
    dropBrowserReply: boolean;
    replaceBrowserResponse: ((message: unknown) => unknown) | undefined;
    beforeClientCommand:
      | ((command: {
          readonly method: string;
          readonly parameters?: Record<string, unknown> | undefined;
        }) => Promise<void> | void)
      | undefined;
    onServerMessage: ((message: unknown) => void) | undefined;
  } = {
    dropBrowserReply: false,
    replaceBrowserResponse: undefined,
    beforeClientCommand: undefined,
    onServerMessage: undefined,
  };
  const peer = {
    id: "browser-device",
    close: () => runner.detach(),
    send: async (message: unknown) => {
      const relay = HostToBrowserRuntimeRelayMessageSchema.parse(message);
      const command =
        relay.type === "browser.client-message"
          ? BrowserClientMessageSchema.safeParse(relay.message).data
          : undefined;
      if (
        command?.type === "cdp.command" &&
        command.command.method === browserHostMethods.cancelScriptCommand &&
        typeof command.command.parameters?.requestId === "string"
      ) {
        cancelledRequests.add(command.command.parameters.requestId);
      }
      if (command?.type === "cdp.command" && faults.beforeClientCommand) {
        await faults.beforeClientCommand(command.command);
      }
      await runner.handleFrame(Buffer.from(JSON.stringify(message)), false);
      if (
        command?.type === "cdp.command" &&
        command.command.method === "Runtime.evaluate" &&
        command.command.parameters?.expression === queuedExpression
      ) {
        queuedCommand.resolve(command.requestId);
      }
    },
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
  // Every control the Browser Harness helpers act on, for a connected agent's run of all of them.
  const helpersPage = `<!doctype html><title>Helpers</title><h1>Helpers</h1>
      <label for=name>Name</label><input id=name>
      <label><input type=checkbox id=agree> Agree</label>
      <select id=pick><option value=a>A</option><option value=b>B</option></select>
      <button id=go ondblclick="this.textContent='Twice'" onclick="this.dataset.clicked='yes'">Go</button>
      <ul><li>one</li><li>two</li><li>three</li></ul>
      <div style="height:3000px">tall</div>`;
  const site = createServer((request, response) => {
    const gate = pending.get(request.url ?? "");
    if (gate) {
      gate.started.resolve();
      void gate.release.promise.then(() => response.end("done"));
      return;
    }
    response.setHeader("content-type", "text/html");
    if (request.url === "/large-result") {
      response.end(
        `<!doctype html><title>Large result</title><body><!--${"x".repeat(410_000)}--></body>`,
      );
      return;
    }
    if (request.url === "/without-heading") {
      response.end("<!doctype html><title>No heading</title><p>A paragraph.</p>");
      return;
    }
    response.end(
      request.url === "/popup"
        ? "<title>Popup</title><h1>Popup</h1>"
        : request.url === "/form-login"
          ? `<title>Sign in</title><h1>Sign in</h1><form id="f" method="post" action="/signed-in"><button type="button" onclick="fetch('/arm-submit').then(() => document.getElementById('f').submit())">Sign in</button></form>`
          : request.url === "/signed-in"
            ? "<title>Signed in</title><h1>Signed in</h1>"
            : request.url === "/helpers"
              ? helpersPage
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
        if (message.type === "browser.server-message") {
          faults.onServerMessage?.(message.message);
          const response = BrowserServerMessageSchema.safeParse(message.message).data;
          if (
            response?.type === "cdp.error" &&
            response.error.reason === "browser-command-cancelled"
          )
            cancellationAcknowledged.resolve(response.requestId);
        }
        if (
          message.type === "browser.server-message" &&
          faults.dropBrowserReply &&
          message.message &&
          typeof message.message === "object" &&
          "type" in message.message &&
          message.message.type === "cdp.result"
        ) {
          faults.dropBrowserReply = false;
          const { message: _discardedReply, ...channel } = message;
          await hub.handleMessage(peer, {
            ...channel,
            type: "browser.closed",
            code: 1011,
            reason: "Fixture dropped the correlated reply",
          });
        } else if (message.type === "browser.server-message" && faults.replaceBrowserResponse) {
          await hub.handleMessage(peer, {
            ...message,
            message: faults.replaceBrowserResponse(message.message),
          });
        } else if (message.type !== "runner.auxiliary.heartbeat")
          await hub.handleMessage(peer, message);
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
  await browser.createProfile({
    homeRunnerId: first.runnerId,
    ownerId: first.userId,
    name: "Second saved profile",
    idempotencyKey: "browser-use-second-profile",
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
  return {
    fixture,
    first,
    second,
    database,
    store,
    browser,
    scripts,
    tabs,
    tabStore,
    setBrowserAccess,
    hold,
    origin,
    a,
    b,
    profile,
    run,
    text,
    contextKey,
    cancellationAcknowledged,
    cancelledRequests,
    queuedExpression,
    queuedCommand,
    faults,
  };
}

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "runs sandboxed browser scripts through Home and a Device without sharing task tabs",
  async () => {
    const {
      store,
      scripts,
      tabStore,
      setBrowserAccess,
      hold,
      origin,
      a,
      b,
      profile,
      run,
      text,
      cancellationAcknowledged,
      cancelledRequests,
      queuedExpression,
      queuedCommand,
      faults,
    } = await browserUseHome();
    expect(await run('await newPage("about:blank")')).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "bad_request",
          message: "More than one granted browser profile is available.",
        },
      },
    });
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
      globalThis.popupPage = await openPage(popup.surfaceId);
      await popupPage.locator("h1").waitFor();
      print(await popupPage.locator("h1").innerText());
    `),
      ),
    ).toBe("Popup");
    const blankLink = await run(`
      await page.evaluate(() => {
        const link = document.createElement("a");
        link.id = "blank-popup";
        link.target = "_blank";
        link.href = "/popup?from=link";
        link.textContent = "Open link";
        document.body.prepend(link);
      });
      print("before blank click");
      await page.locator("#blank-popup").click();
      print("after blank click");
      let popup;
      for (let attempt = 0; !popup && attempt < 20; attempt++) {
        popup = (await pages()).find((tab) => tab.url.endsWith("/popup?from=link"));
        if (!popup) await page.waitForTimeout(100);
      }
      if (!popup) throw new Error("The popup was not listed.");
      print(await (await openPage(popup.tabId)).url());
    `);
    expect(blankLink.isError, JSON.stringify(blankLink.content)).not.toBe(true);
    expect(blankLink.content).toEqual([
      { type: "text", text: "before blank click" },
      { type: "text", text: "after blank click" },
      { type: "text", text: `${origin}/popup?from=link` },
    ]);

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

    faults.replaceBrowserResponse = (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "cdp.result" &&
        "requestId" in message
      ) {
        return {
          type: "cdp.error",
          requestId: message.requestId,
          // A definite refusal (A7: before the page), whose private words never reach the agent.
          error: {
            code: "forbidden",
            retryable: false,
            message: "private upstream URL and secret",
            unsent: true,
          },
        };
      }
      return message;
    };
    try {
      const sanitized = text(
        await run(
          `try { await page.cdp("Runtime.evaluate", { expression: "1" }); } catch (error) { print({ code: error.code, message: error.message }); }`,
        ),
      );
      expect(JSON.parse(sanitized)).toEqual({
        code: "forbidden",
        message: "This CDP operation is outside the browser attachment's authority.",
      });
    } finally {
      faults.replaceBrowserResponse = undefined;
    }

    const abandoned = hold("/abandoned");
    const continueScript = hold("/continue");
    try {
      const unfinished = run(`
        void page.js("fetch('/abandoned').then(r => r.text())").catch(() => {});
        await popupPage.gotoUrl(${JSON.stringify(`${origin}/continue`)});
        return "done";
      `);
      await Promise.race([
        abandoned.started.promise,
        unfinished.then((result) => {
          throw new Error(JSON.stringify(result));
        }),
      ]);
      continueScript.release.resolve();
      expect(await unfinished).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "outcome-unknown" } },
      });
    } finally {
      continueScript.release.resolve();
      abandoned.release.resolve();
    }
    const stop = hold("/stop");
    const inFlight = run(`
      const running = page.js("fetch('/stop').then(r => r.text())");
      const queued = page.js(${JSON.stringify(queuedExpression)});
      await Promise.all([running, queued]);
    `);
    const [, queuedRequestId] = await Promise.race([
      Promise.all([stop.started.promise, queuedCommand.promise]),
      inFlight.then((result) => {
        throw new Error(JSON.stringify(result));
      }),
    ]);
    await scripts.closeBrowserScriptsForBinding(a.agentBindingId);
    expect(await inFlight).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "outcome-unknown" } },
    });
    try {
      expect(await cancellationAcknowledged.promise).toBe(queuedRequestId);
      expect(cancelledRequests).toContain(queuedRequestId);
    } finally {
      stop.release.resolve();
    }
    const tab = await tabStore.get(a.ownerId, tabId);
    expect(tab?.pageBinding).toBeTruthy();
    expect(
      await store.getBrowserSessionForOwner(tab!.pageBinding!.sessionId, a.ownerId),
    ).toMatchObject({ state: "ready" });
    const fresh = await run(
      `globalThis.fresh = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });`,
      b,
    );
    expect(fresh.isError).toBeUndefined();
    faults.dropBrowserReply = true;
    const lost = await run(
      `
      try { await fresh.cdp("Runtime.evaluate", { expression: "document.title = 'changed'" }); }
      catch (error) { print(error.code); }
      return "caught";
    `,
      b,
    );
    expect(lost).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "outcome-unknown" } },
    });
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "keeps a connection's Run relay to the standard lists at the browser root; the person's own Run as before",
  async () => {
    const {
      first,
      second,
      database,
      browser,
      scripts,
      tabStore,
      origin,
      a,
      b,
      profile,
      run,
      text,
    } = await browserUseHome();
    const { tabId } = JSON.parse(
      text(
        await run(
          `print({ tabId: (await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} })).tabId });`,
        ),
      ),
    ) as { tabId: string };
    // The person's own Run: its relay's browser root and its page commands go out as before.
    expect(second.userId).toBe(first.userId);
    const ownSession = (await tabStore.get(a.ownerId, tabId as never))!.pageBinding!.sessionId;
    const own = await browser.attachCdpForAgent({ ...a, sessionId: ownSession }, () => {});
    try {
      await expect(own.request({ method: "SystemInfo.getProcessInfo" })).resolves.toMatchObject({
        processInfo: expect.any(Array),
      });
      await expect(own.request({ method: "Tracing.start", parameters: {} })).resolves.toEqual({});
      await own.request({ method: "Tracing.end" });
    } finally {
      own.close();
    }
    // The person's own Run sends the same page commands as before.
    const ownPage = await scripts.runBrowserScript({
      authority: a,
      contextKey: "own-page",
      code: `
        const page = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
        await page.goto(${JSON.stringify(origin)});
        const sent = [];
        for (const [method, params] of [
          ["Storage.clearDataForOrigin", { origin: ${JSON.stringify(origin)}, storageTypes: "cookies" }],
          ["ServiceWorker.unregister", { scopeURL: ${JSON.stringify(`${origin}/`)} }],
        ]) {
          try { await page.cdp(method, params); sent.push(method + ": sent"); }
          catch (error) { sent.push(method + ": " + String(error && error.message)); }
        }
        return "outcome:" + encodeURIComponent(JSON.stringify(sent)) + ":end";
      `,
    });
    const ownText = JSON.stringify(ownPage.content);
    const ownSent = JSON.parse(
      decodeURIComponent(/outcome:([^:"\\]*):end/u.exec(ownText)?.[1] ?? "%5B%5D"),
    ) as string[];
    expect(ownSent, ownText.slice(0, 2000)).toHaveLength(2);
    for (const line of ownSent) expect(line).not.toMatch(/not available to a connected agent/u);
    const outside = (method: string) =>
      new RegExp(`^${method.replaceAll(".", "\\.")} is not available to a connected agent\\.`, "u");

    // The same Run in a connected agent's lineage: its relay sends only the standard lists.
    const connections = new AgentConnectionStore(database);
    const lineage = await connections.create({
      userId: first.userId,
      label: "Lineage",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: AgentGrantSchema.parse({ scope: "everything" }),
    });
    expect(await connections.activate(lineage.id, randomUUID())).toBe(true);
    const lineageTab = text(
      await scripts.runBrowserScript({
        authority: b,
        contextKey: "lineage",
        code: `print((await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} })).tabId);`,
      }),
    );
    const lineageSession = (await tabStore.get(b.ownerId, lineageTab as never))!.pageBinding!
      .sessionId;
    const setLineage = async (connectionId: string | null) => {
      await database
        .updateTable("threads")
        .set({ originConnectionId: connectionId })
        .where("id", "=", second.threadId)
        .execute();
      await database
        .updateTable("runs")
        .set({ connectionId })
        .where("id", "=", second.runId)
        .execute();
    };
    await setLineage(lineage.id);
    const relay = await browser.attachCdpForAgent({ ...b, sessionId: lineageSession }, () => {});
    try {
      for (const method of ["Tracing.start", "SystemInfo.getProcessInfo"])
        await expect(relay.request({ method, parameters: {} }), method).rejects.toThrow(
          outside(method),
        );
      await expect(relay.request({ method: "Browser.getVersion" })).resolves.toMatchObject({
        product: expect.any(String),
      });
    } finally {
      relay.close();
      // The rest of this journey is the person's own work again.
      await setLineage(null);
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "reports a missing locator match as a failed browser script",
  async () => {
    const { run, origin, profile } = await browserUseHome();
    expect(
      await run(`
        globalThis.page = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
        await page.goto(${JSON.stringify(`${origin}/without-heading`)});
      `),
    ).not.toHaveProperty("isError", true);
    expect(await run('return await page.locator("h1").textContent();')).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "failed",
          message: 'page.locator("h1").textContent(): Timeout 10000ms: no element matched',
        },
      },
    });
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "reports screenshot refusals and oversized images as failed browser-use calls",
  async () => {
    const { first, database, store, scripts, tabs, origin, profile } = await browserUseHome();
    const connections = new AgentConnectionStore(database);
    const grant = AgentGrantSchema.parse({
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: profile.id }],
    });
    const direct = await connections.create({
      userId: first.userId,
      label: "Browser results",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant,
    });
    expect(await connections.activate(direct.id, randomUUID())).toBe(true);
    const { grantRevision } = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", direct.id)
      .executeTakeFirstOrThrow();
    const handlers = new BrowserToolHandlers({
      sessions: new AgentSessionService({ store, holdMs: 0 }),
      confinement: new BrowserScriptConfinement(),
      scripts,
      tabs,
      origin: new URL(origin),
      profiles: async () => [
        {
          ...profile,
          purpose: profile.purpose ?? "person",
          home: { runnerId: first.runnerId, name: "Browser Device" },
        },
      ],
      requireDevice: (runnerId) => store.requireSelfDeviceId(runnerId),
      issueTicket: async () => {
        throw new Error("This fixture only uses scripts");
      },
    });
    const caller = {
      kind: "connection" as const,
      connectionId: direct.id,
      key: `connection:${direct.id}`,
      userId: first.userId,
      accessMode: "full-access" as const,
      grantRevision,
      grant,
    };
    let taskId: ThreadId | undefined;
    const use = async (code: string) => {
      const result = await handlers.browser_use({
        caller,
        input: { code, profileId: profile.id, ...(taskId ? { taskId } : {}) },
        operationKey: randomUUID(),
      });
      taskId = ThreadIdSchema.parse(result.structuredContent.taskId);
      return result;
    };
    const expectFailed = async (result: Awaited<ReturnType<typeof use>>, message: RegExp) => {
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        error: { message: expect.stringMatching(message) },
      });
      expect(
        await database
          .selectFrom("agentOperations")
          .select(["state", "contactLostAt"])
          .where("id", "=", AgentOperationIdSchema.parse(result.structuredContent.operationId))
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "failed", contactLostAt: null });
    };
    expect(
      (
        await use(`
      globalThis.page = await newPage(${JSON.stringify(`${origin}/large-result`)}, { profileId: ${JSON.stringify(profile.id)} });
    `)
      ).structuredContent,
    ).toMatchObject({ status: "completed" });
    const html = (bytes: number) =>
      `await page.js("document.documentElement.outerHTML.slice(0,${bytes})")`;
    for (const bytes of [100_000, 300_000, 400_000]) {
      const result = await use(`return ${html(bytes)};`);
      expect(result.structuredContent).toMatchObject({ status: "completed" });
      const block = result.content[0];
      expect(block?.type === "text" ? JSON.parse(block.text).length : null).toBe(bytes);
    }
    expect(
      (await use("await page.screenshot()")).content.some(({ type }) => type === "image"),
    ).toBe(true);
    const combined = await use(`print(${html(400_000)}); await page.screenshot();`);
    expect(combined.structuredContent).toMatchObject({ status: "completed" });
    expect(combined.content.some(({ type }) => type === "image")).toBe(true);
    const full = await use(
      'await page.cdp("Page.captureScreenshot", { captureBeyondViewport: true });',
    );
    await expectFailed(full, /Scroll and capture each part/u);
    expect(
      (
        await use(`
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        canvas.style.cssText = "position:fixed;inset:0";
        document.body.append(canvas);
        const context = canvas.getContext("2d");
        const image = context.createImageData(canvas.width, canvas.height);
        let bits = 983275;
        for (let i = 0; i < image.data.length; i += 4) {
          bits ^= bits << 13; bits ^= bits >>> 17; bits ^= bits << 5;
          image.data[i] = bits & 255;
          image.data[i + 1] = (bits >>> 8) & 255;
          image.data[i + 2] = (bits >>> 16) & 255;
          image.data[i + 3] = 255;
        }
        context.putImageData(image, 0, 0);
      });
    `)
      ).structuredContent,
    ).toMatchObject({ status: "completed" });
    for (const code of [
      "await page.screenshot();",
      `print(${html(400_000)}); await page.screenshot();`,
      'await page.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 600, height: 400, scale: 1 } });',
    ]) {
      await expectFailed(
        await use(code),
        /Screenshot was [0-9]+ KiB.*limit is 323 KiB.*smaller viewport clip/u,
      );
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "runs the Browser Harness page and locator helpers as a connected agent, in real Chromium",
  async () => {
    const { first, database, scripts, origin, profile } = await browserUseHome();
    const connections = new AgentConnectionStore(database);
    // A connected agent's own browser_use: every helper works, and nothing outside the lists goes out.
    const direct = await connections.create({
      userId: first.userId,
      label: "Direct",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: AgentGrantSchema.parse({
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      }),
    });
    expect(await connections.activate(direct.id, randomUUID())).toBe(true);
    const { session } = await beginAgentSession(database, {
      userId: first.userId,
      agentConnectionId: direct.id,
    });
    const agent = { agentBindingId: `session:${session.id}`, ownerId: first.userId };
    const helpers = await scripts.runBrowserScript({
      authority: agent,
      contextKey: "connected-helpers",
      code: `
        const failed = [];
        const step = async (name, run) => {
          try { await run(); } catch (error) { failed.push(name + ": " + String(error && error.message)); }
        };
        const page = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
        await step("goto", () => page.goto(${JSON.stringify(`${origin}/helpers`)}));
        await step("waitForLoad", () => page.waitForLoad());
        await step("waitForURL", () => page.waitForURL(${JSON.stringify(`${origin}/helpers`)}));
        await step("url/title", async () => { if (!(await page.url()).endsWith("/helpers") || (await page.title()) !== "Helpers") throw new Error("wrong page"); });
        await step("pages", async () => { if (!(await pages()).length) throw new Error("no pages"); });
        await step("openPage", async () => { if ((await openPage(page.tabId)) !== page) throw new Error("other page"); });
        await step("locator", async () => { if ((await page.locator("h1").innerText()) !== "Helpers") throw new Error("h1"); });
        await step("getByLabel.fill", () => page.getByLabel("Name").fill("Ada"));
        await step("inputValue", async () => { if ((await page.getByLabel("Name").inputValue()) !== "Ada") throw new Error("fill"); });
        await step("clear", () => page.getByLabel("Name").clear());
        await step("press", () => page.getByLabel("Name").press("A"));
        await step("check", () => page.locator("#agree").check());
        await step("isChecked", async () => { if (!(await page.locator("#agree").isChecked())) throw new Error("check"); });
        await step("uncheck", () => page.locator("#agree").uncheck());
        await step("setChecked", () => page.locator("#agree").setChecked(true));
        await step("selectOption", () => page.locator("#pick").selectOption("b"));
        await step("getByRole.click", () => page.getByRole("button", { name: "Go" }).click());
        await step("getAttribute", async () => { if ((await page.locator("#go").getAttribute("data-clicked")) !== "yes") throw new Error("click"); });
        await step("dblclick", () => page.locator("#go").dblclick());
        await step("getByText", () => page.getByText("two").waitFor());
        await step("first/last/nth/count", async () => {
          const items = page.locator("li");
          if ((await items.count()) !== 3 || (await items.first().innerText()) !== "one" || (await items.last().innerText()) !== "three" || (await items.nth(1).textContent()) !== "two") throw new Error("list");
        });
        await step("filter", async () => { if ((await page.locator("li").filter({ hasText: "two" }).count()) !== 1) throw new Error("filter"); });
        await step("allInnerTexts", async () => { if ((await page.locator("li").allInnerTexts()).length !== 3) throw new Error("texts"); });
        await step("isVisible/isEnabled", async () => { if (!(await page.locator("h1").isVisible()) || !(await page.locator("#go").isEnabled())) throw new Error("state"); });
        await step("locator.evaluate", () => page.locator("h1").evaluate((node) => node.textContent));
        await step("locator.ariaSnapshot", () => page.locator("ul").ariaSnapshot());
        await step("evaluate", () => page.evaluate(() => document.title));
        await step("waitForFunction", () => page.waitForFunction(() => document.readyState === "complete"));
        await step("waitForTimeout", () => page.waitForTimeout(10));
        await step("screenshot", () => page.screenshot());
        await step("ariaSnapshot", () => page.ariaSnapshot());
        await step("close", () => page.close());
        return "outcome:" + encodeURIComponent(JSON.stringify(failed)) + ":end";
      `,
    });
    const helperText = JSON.stringify(helpers.content);
    const helperFailures = JSON.parse(
      decodeURIComponent(
        /outcome:([^:"\\]*):end/u.exec(helperText)?.[1] ?? "%5B%22no%20outcome%22%5D",
      ),
    ) as string[];
    expect(helperFailures, helperText.slice(0, 2000)).toEqual([]);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "runs the Browser Harness input and page-detail helpers as a connected agent, in real Chromium",
  async () => {
    const { first, database, scripts, origin, profile } = await browserUseHome();
    const connections = new AgentConnectionStore(database);
    // A connected agent's own browser_use: every helper works, and nothing outside the lists goes out.
    const direct = await connections.create({
      userId: first.userId,
      label: "Direct",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: AgentGrantSchema.parse({
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      }),
    });
    expect(await connections.activate(direct.id, randomUUID())).toBe(true);
    const { session } = await beginAgentSession(database, {
      userId: first.userId,
      agentConnectionId: direct.id,
    });
    const agent = { agentBindingId: `session:${session.id}`, ownerId: first.userId };
    const helpers = await scripts.runBrowserScript({
      authority: agent,
      contextKey: "connected-helpers",
      code: `
        const failed = [];
        const step = async (name, run) => {
          try { await run(); } catch (error) { failed.push(name + ": " + String(error && error.message)); }
        };
        const page = await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
        await step("goto", () => page.goto(${JSON.stringify(`${origin}/helpers`)}));
        await step("waitForLoad", () => page.waitForLoad());
        await step("waitForURL", () => page.waitForURL(${JSON.stringify(`${origin}/helpers`)}));
        await step("url/title", async () => { if (!(await page.url()).endsWith("/helpers") || (await page.title()) !== "Helpers") throw new Error("wrong page"); });
        await step("keyboard.press", () => page.keyboard.press("Tab"));
        await step("keyboard.type", async () => { await page.locator("#name").click(); await page.keyboard.type("bc"); });
        await step("keyboard.insertText", () => page.keyboard.insertText("d"));
        await step("mouse.click", () => page.mouse.click(5, 5));
        await step("clickAt", () => page.clickAt(5, 5));
        await step("fillInput", () => page.fillInput("#name", "Grace"));
        await step("pressKey", () => page.pressKey("End"));
        await step("typeText", () => page.typeText("!"));
        await step("scroll", () => page.scroll(10, 10));
        await step("js", () => page.js("1 + 1"));
        await step("cdp", () => page.cdp("Runtime.evaluate", { expression: "1" }));
        await step("currentTab/ensureRealTab", async () => { await page.currentTab(); await page.ensureRealTab(); });
        await step("pageInfo", () => page.pageInfo());
        await step("captureScreenshot", () => page.captureScreenshot());
        await step("drainEvents", () => page.drainEvents());
        await step("waitForElement", () => page.waitForElement("h1"));
        await step("waitForNetworkIdle", () => page.waitForNetworkIdle({ timeout: 5000, idleMs: 200 }));
        await step("respondDialog", async () => {
          const opened = page.js("new Promise((resolve) => setTimeout(() => resolve(confirm('ok?')), 50))").catch(() => undefined);
          await sleep(300);
          await page.respondDialog({ accept: true });
          await opened;
        });
        await step("gotoUrl", () => page.gotoUrl(${JSON.stringify(`${origin}/popup`)}));
        await step("help", () => help());
        await step("print", () => print("printed"));
        await step("close", () => page.close());
        return "outcome:" + encodeURIComponent(JSON.stringify(failed)) + ":end";
      `,
    });
    const helperText = JSON.stringify(helpers.content);
    const helperFailures = JSON.parse(
      decodeURIComponent(
        /outcome:([^:"\\]*):end/u.exec(helperText)?.[1] ?? "%5B%22no%20outcome%22%5D",
      ),
    ) as string[];
    expect(helperFailures, helperText.slice(0, 2000)).toEqual([]);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "keeps a connection's browser_use to the standard lists; the person's own as before",
  async () => {
    const { first, database, scripts, origin, profile } = await browserUseHome();
    const connections = new AgentConnectionStore(database);
    // A connected agent's own browser_use: every helper works, and nothing outside the lists goes out.
    const direct = await connections.create({
      userId: first.userId,
      label: "Direct",
      clientName: "Fixture",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: AgentGrantSchema.parse({
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      }),
    });
    expect(await connections.activate(direct.id, randomUUID())).toBe(true);
    const { session } = await beginAgentSession(database, {
      userId: first.userId,
      agentConnectionId: direct.id,
    });
    const agent = { agentBindingId: `session:${session.id}`, ownerId: first.userId };
    // And on a page of its own, nothing outside the lists reaches the browser, nested or not.
    const refusalsOf = async (contextKey: string, attempts: string) => {
      const result = await scripts.runBrowserScript({
        authority: agent,
        contextKey,
        code: `
          globalThis.page ??= await newPage("about:blank", { profileId: ${JSON.stringify(profile.id)} });
          if (!(await page.url()).startsWith(${JSON.stringify(origin)})) await page.goto(${JSON.stringify(origin)});
          const refused = [];
          const attempt = async (name, run) => {
            try { await run(); refused.push(name + ": performed"); }
            catch (error) { refused.push(name + ": " + String(error && error.message)); }
          };
          ${attempts}
          const alive = await page.js("document.title");
          return "outcome:" + encodeURIComponent(JSON.stringify({ refused, alive })) + ":end";
        `,
      });
      const outcome = JSON.parse(
        decodeURIComponent(/outcome:([^:"\\]*):end/u.exec(JSON.stringify(result.content))![1]!),
      ) as { refused: string[]; alive: string };
      expect(outcome.alive).toBe("Home browser fixture");
      return outcome.refused;
    };
    const outsideMessage = (name: string, method = name) =>
      expect.stringMatching(
        new RegExp(
          `^${name.replaceAll(".", "\\.")}: .*${method.replaceAll(".", "\\.")} is not available to a connected agent\\.`,
          "u",
        ),
      );
    // Storage and workers the profile's other pages use, first: nothing of them reaches the page.
    expect(
      await refusalsOf(
        "connected-refusals",
        `
          await attempt("Storage.clearDataForOrigin", () => page.cdp("Storage.clearDataForOrigin", { origin: ${JSON.stringify(origin)}, storageTypes: "all" }));
          await attempt("ServiceWorker.unregister", () => page.cdp("ServiceWorker.unregister", { scopeURL: ${JSON.stringify(`${origin}/`)} }));
          await attempt("nested", () => page.cdp("Target.sendMessageToTarget", { sessionId: "child", message: JSON.stringify({ id: 1, method: "Page.crash", params: {} }) }));
        `,
      ),
    ).toEqual([
      outsideMessage("Storage.clearDataForOrigin"),
      outsideMessage("ServiceWorker.unregister"),
      outsideMessage("nested", "Page.crash"),
    ]);
    // Then the page itself: it is neither crashed nor closed.
    expect(
      await refusalsOf(
        "connected-refusals",
        `
          await attempt("Page.crash", () => page.cdp("Page.crash", {}));
          await attempt("Page.close", () => page.cdp("Page.close", {}));
        `,
      ),
    ).toEqual([outsideMessage("Page.crash"), outsideMessage("Page.close")]);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "retries getByRole().waitFor() when a form navigation destroys the document context between Runtime.evaluate and Accessibility.queryAXTree",
  async () => {
    const { origin, profile, run, text, hold, faults } = await browserUseHome();
    const armSubmit = hold("/arm-submit");
    const navigatedToSignedIn = Promise.withResolvers<void>();
    faults.onServerMessage = (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "cdp.event" &&
        "event" in message &&
        message.event &&
        typeof message.event === "object" &&
        "method" in message.event &&
        message.event.method === "Page.frameNavigated" &&
        JSON.stringify(message.event).includes(`${origin}/signed-in`)
      ) {
        navigatedToSignedIn.resolve();
      }
    };
    let heldHeadingQuery = false;
    faults.beforeClientCommand = async (command) => {
      if (
        !heldHeadingQuery &&
        command.method === "Accessibility.queryAXTree" &&
        command.parameters?.role === "heading"
      ) {
        heldHeadingQuery = true;
        // Let Runtime.evaluate("document") return the pre-navigation objectId first, then release
        // the form submission and wait for Page.frameNavigated to commit the new document before
        // forwarding this stale Accessibility.queryAXTree to Chromium.
        await armSubmit.started.promise;
        armSubmit.release.resolve();
        await navigatedToSignedIn.promise;
      }
    };
    try {
      const result = await run(`
        const page = await newPage(${JSON.stringify(`${origin}/form-login`)}, { profileId: ${JSON.stringify(profile.id)} });
        await page.getByRole("button", { name: "Sign in" }).click();
        const signedIn = page.getByRole("heading", { name: "Signed in" });
        await signedIn.waitFor();
        print(await signedIn.innerText());
      `);
      expect(text(result)).toContain("Signed in");
      expect(heldHeadingQuery).toBe(true);
    } finally {
      armSubmit.release.resolve();
      navigatedToSignedIn.resolve();
      faults.beforeClientCommand = undefined;
      faults.onServerMessage = undefined;
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "never closes the row itself of a page a Run closed when its task was lowered to read-only before the close was confirmed",
  async () => {
    const { database, first, tabStore, origin, profile, run, text, faults } =
      await browserUseHome();
    let lowered = false;
    faults.beforeClientCommand = async (command) => {
      if (command.method !== "Target.closeTarget" || lowered) return;
      lowered = true;
      // The close was admitted and sent; the person lowers the task before the browser answers.
      await database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", first.runId)
        .execute();
    };
    try {
      const closed = await run(
        `const page = await newPage(${JSON.stringify(`${origin}/done`)}, { profileId: ${JSON.stringify(profile.id)} }); const id = page.tabId; await page.close(); return id;`,
      );
      const tabId = JSON.parse(text(closed)) as string;
      expect(lowered).toBe(true);
      // The row close needs the access the close itself needed: lacking it, the Home's own close
      // of the row never happens. The page's absence is the shadow inventory's to report, as for
      // a page that goes by itself: its `physical-close`, whenever that report comes.
      const closes = (
        await database
          .selectFrom("commands")
          .select("idempotencyKey")
          .where("idempotencyKey", "like", `%${tabId}%`)
          .execute()
      ).map(({ idempotencyKey }) => idempotencyKey);
      expect(closes.filter((key) => key.startsWith("cdp-close:"))).toEqual([]);
      if ((await tabStore.get(first.userId, tabId as never, true))?.closedAt)
        expect(closes.some((key) => key.startsWith("physical-close:"))).toBe(true);
    } finally {
      faults.beforeClientCommand = undefined;
    }
  },
);

/** A connected agent's session, off the pool, with everything. */
async function connectedAgent(home: Awaited<ReturnType<typeof browserUseHome>>) {
  const { database, first } = home;
  const connections = new AgentConnectionStore(database);
  const direct = await connections.create({
    userId: first.userId,
    label: "Direct",
    clientName: "Fixture",
    accessMode: "full-access",
    resource: "http://localhost/mcp",
    expiresAt: new Date(Date.now() + 60_000),
    grant: AgentGrantSchema.parse({ scope: "everything" }),
  });
  expect(await connections.activate(direct.id, randomUUID())).toBe(true);
  const { session } = await beginAgentSession(database, {
    userId: first.userId,
    agentConnectionId: direct.id,
  });
  return { authority: { agentBindingId: `session:${session.id}`, ownerId: first.userId } };
}

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "ends the page of every tab the person closes off the pool while a connected agent's handle holds it: the handle ends in plain words and the agent opens a new page",
  async () => {
    const home = await browserUseHome();
    const { scripts, tabs, browser, origin, first, profile, text } = home;
    const { authority } = await connectedAgent(home);
    const { tab: person } = await tabs.open(
      { kind: "person", ownerId: first.userId },
      { kind: "page", profileId: profile.id, url: `${origin}/person` },
      "person-tab",
    );
    const runAgent = (code: string) =>
      scripts.runBrowserScript({ authority, contextKey: "person-close", code });
    const held = JSON.parse(
      text(
        await runAgent(
          `globalThis.theirs = await openPage(${JSON.stringify(person.tabId)}); globalThis.mine = await newPage(${JSON.stringify(`${origin}/mine`)}, { profileId: ${JSON.stringify(profile.id)} }); return mine.tabId;`,
        ),
      ),
    ) as string;
    const rows = await Promise.all(
      [person.tabId, held].map((tabId) => home.tabStore.get(first.userId, tabId as never)),
    );
    // The person closes both, by the route the web app's close-all calls.
    const result = await tabs.close(
      { kind: "person", ownerId: first.userId },
      [person.tabId, held as never],
      "person-close-all",
    );
    expect(result.failed).toEqual([]);
    // Each page closes, the agent's and the person's own alike.
    for (const row of rows)
      await vi.waitFor(
        () =>
          expect(
            browser.tabStateOf(row!.pageBinding!.sessionId, row!.pageBinding!.surfaceId),
          ).toBeUndefined(),
        { timeout: 10_000 },
      );
    const lines = JSON.parse(
      text(
        await runAgent(
          `const out = []; for (const page of [mine, theirs]) for (let use = 0; use < 2; use++) { try { await page.title(); out.push("ran"); } catch (error) { out.push(error.code + ": " + error.message); } } const fresh = await newPage(${JSON.stringify(`${origin}/again`)}, { profileId: ${JSON.stringify(profile.id)} }); out.push("fresh:" + await fresh.title()); return out;`,
        ),
      ),
    ) as string[];
    expect(lines).toHaveLength(5);
    // Off the pool a handle is retired as soon as its page's end reaches it, so its first use
    // reads the ended handle's sentence, or the ended attachment's if it went out first.
    for (const first of [lines[0], lines[2]])
      expect(first).toMatch(
        /^(?:conflict: (?:page\.\w+\(\): )?The browser page attachment has ended\.|page-ended: (?:page\.\w+\(\): )?This page handle has ended\. Bind the tab again with openPage\(tabId\)\.)$/u,
      );
    // A later use reads as a narrowed-away handle's later use does: nothing of it is left.
    for (const later of [lines[1], lines[3]])
      expect(later).toMatch(
        /This page handle has ended\. Bind the tab again with openPage\(tabId\)\./u,
      );
    expect(lines[4]).toBe("fresh:Home browser fixture");
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "loads a tab the person closed and reopened when a connected agent opens it first, off the pool",
  async () => {
    const home = await browserUseHome();
    const { scripts, tabs, browser, tabStore, origin, first, profile, text } = home;
    const { authority } = await connectedAgent(home);
    const address = `${origin}/person`;
    const { tab: person } = await tabs.open(
      { kind: "person", ownerId: first.userId },
      { kind: "page", profileId: profile.id, url: address },
      "person-tab",
    );
    await vi.waitFor(
      async () => {
        await browser.flushPendingTabDescriptors();
        expect((await tabStore.get(first.userId, person.tabId as never))?.url).toBe(address);
      },
      { timeout: 10_000 },
    );
    await tabs.close({ kind: "person", ownerId: first.userId }, [person.tabId], "close");
    await tabs.reopen({ kind: "person", ownerId: first.userId }, person.tabId, "reopen");
    const opened = await scripts.runBrowserScript({
      authority,
      contextKey: "reopened",
      code: `const page = await openPage(${JSON.stringify(person.tabId)}); return [await page.evaluate(() => location.href)];`,
    });
    expect(JSON.parse(text(opened))).toEqual([address]);
  },
);
