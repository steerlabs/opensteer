import {
  AgentConnectionStore,
  admitAgentOperation,
  beginAgentSession,
  beginBrowserPoolPark,
  decideAgentOperation,
  handOffAgentOperation,
  installBrowserPoolSlot,
  listBrowserPoolDocumentLosses,
  readBrowserPoolSlot,
  settleBrowserPoolRelay,
  TabStore,
  type BrowserPoolTargetIdentity,
} from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import {
  BrowserClientMessageSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  decodeBrowserFrameEnvelope,
  type InitialPageReady,
} from "../packages/protocol/src/browser.js";
import { BrowserChannelIdSchema } from "../packages/protocol/src/browser-relay.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { PooledBrowserRelay } from "../apps/host/src/browser/browser-pool-relay.js";
import {
  BrowserPoolCoordinator,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import { FakeBrowserPoolController } from "../apps/host/src/browser/browser-pool-controller.test-support.js";
import {
  BrowserService,
  type BrowserRuntimeConnection,
} from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { FakeIsolatingLauncher } from "../packages/browser-runtime-core/src/test-support/fakes.js";

/** Decodes a frame to raw pixels with the Host's own image library. */
const sharp = createRequire(new URL("../apps/host/package.json", import.meta.url))("sharp") as (
  input: Buffer,
) => {
  raw(): {
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: { width: number; height: number; channels: number };
    }>;
  };
};

it("vetoes D on an ended session with confined CDP contact loss", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("park-cdp-loss");
    const { database } = fixture;
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "pool-slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await personalBrowserRepository(fixture.store).createBrowserSession({
      ownerId: task.userId,
      id: sessionId,
      origin: "agent",
      placementKey: "pool-test",
      profileId: null,
      runnerId: target.runnerId,
      runtimeId: target.runtimeId,
    });
    const attachmentId = randomUUID();
    const lost = { runtimeBootId: target.instanceId, contactLostAt: new Date().toISOString() };
    await database
      .updateTable("browserSessions")
      .set({
        state: "closed",
        closedAt: new Date(),
        standardCdpAttempts: { [attachmentId]: lost },
      })
      .where("id", "=", sessionId)
      .execute();
    await installBrowserPoolSlot(database, target);
    const begin = () => beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(await begin()).toBeUndefined();
    expect(await readBrowserPoolSlot(database, target.runnerId)).toMatchObject({
      phase: "running",
      intentId: null,
    });
    await database
      .updateTable("browserSessions")
      .set({
        standardCdpAttempts: {
          [attachmentId]: { ...lost, terminalEvidenceAt: new Date().toISOString() },
        },
      })
      .where("id", "=", sessionId)
      .execute();
    expect(await begin()).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});

it("keeps outstanding Shared Chrome and plugin handoffs outside D", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("park-foreign-effects");
    const { database } = fixture;
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: task.userId,
      label: "Fixture connection",
      clientName: "Fixture agent",
      accessMode: "full-access",
      grant: { scope: "everything" },
      resource: "https://fixture.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await connections.activate(connection.id, randomUUID())).toBe(true);
    const { grantRevision } = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    const lineage = { userId: task.userId, agentConnectionId: connection.id };
    const { session } = await beginAgentSession(database, lineage);
    for (const grant of [
      { kind: "chrome-tabs", sourceId: createId("browserSource") },
      { kind: "plugin", target: { kind: "installed", pluginId: "fixture-plugin" } },
    ] as const) {
      const { operation } = await admitAgentOperation(database, {
        ...lineage,
        sessionId: session.id,
        operationKey: grant.kind,
        tool: grant.kind,
        argumentDigest: randomUUID(),
        target: { grant, name: grant.kind, device: null },
        targetGeneration: null,
        grantRevision,
        mode: "full-access",
        effect: "write",
        calls: grant.kind,
        agentReason: null,
      });
      const reviewed = await decideAgentOperation(database, operation, { by: "full-access" });
      await expect(
        handOffAgentOperation(database, { ...lineage, reviewed }),
      ).resolves.toMatchObject({ state: "handed-off", terminalEvidenceAt: null });
    }
    const target = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "test-slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(database, target);
    const intent = await beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(intent?.phase).toBe("preparing");
    expect(
      await database
        .selectFrom("agentOperations")
        .select("state")
        .where("sessionId", "=", session.id)
        .execute(),
    ).toEqual([{ state: "handed-off" }, { state: "handed-off" }]);
  } finally {
    await fixture.close();
  }
});

it("keeps lost pooled relay replies in D after the transport ends", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("relay-lost-reply");
    const target = {
      runnerId: task.runnerId,
      runtimeId: "runtime",
      slotId: "slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    await installBrowserPoolSlot(fixture.database, target);
    const release = vi.fn();
    const relay = await PooledBrowserRelay.open(fixture.database, target, { release });
    relay.submitted();
    relay.track("Runtime.evaluate", undefined, Promise.reject(new Error("Reply lost")));
    await relay.close();
    expect(release).toHaveBeenCalledOnce();
    // The reply that never came keeps the relay's row: D vetoes on it.
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toBeUndefined();
    const [row] = await fixture.database.selectFrom("browserPoolRelays").select("id").execute();
    await settleBrowserPoolRelay(fixture.database, row!.id);
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});
class TestRuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 0;
  initialPage: InitialPageReady | undefined;
  private readonly channel = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
  private readonly bridge: LocalBrowserRuntimeBridge;

  constructor(bridge: LocalBrowserRuntimeBridge, ticket: string) {
    super();
    this.bridge = bridge;
    const pending: [Buffer, boolean][] = [];
    const frame = (data: Buffer, binary: boolean) => {
      if (this.readyState === 0) pending.push([data, binary]);
      else if (this.readyState === 1) this.emit("message", data, binary);
    };
    void bridge
      .attach(this.channel, ticket, {
        onFrame: (_channel, value) => frame(value, true),
        onServerMessage: (_channel, value) => frame(Buffer.from(JSON.stringify(value)), false),
        onClosed: (_channel, code, reason) => this.end(code, reason),
      })
      .then((attached) => {
        if (this.readyState === 3) return;
        this.initialPage = attached.initialPage;
        this.readyState = 1;
        for (const [data, binary] of pending) frame(data, binary);
        pending.length = 0;
      })
      .catch((error: unknown) => {
        this.emit("error", error);
        this.end(1011, "attach failed");
      });
  }

  send(data: string, _options: { binary: false }, callback: (error?: Error) => void): void {
    void this.bridge.send(this.channel, BrowserClientMessageSchema.parse(JSON.parse(data))).then(
      () => callback(),
      (error) => callback(error),
    );
  }

  private end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  close(): void {
    this.bridge.close(this.channel);
    this.end(1000, "closed");
  }

  terminate(): void {
    this.close();
  }
}

type Home = { service: BrowserService; coordinator: BrowserPoolCoordinator };

/** Hangs every runtime control from the named one on, as a Home that died just after it. */
function dyingAfter(runtime: BrowserRuntime, kind: string): BrowserPoolRuntimeChannel {
  let dead = false;
  return {
    poolState: () => runtime.poolState(),
    controlPool: async (control, signature) => {
      if (dead) return new Promise(() => {});
      const state = await runtime.controlPool(control, signature);
      if (control.kind === kind) {
        dead = true;
        return new Promise(() => {});
      }
      return state;
    },
  };
}

async function journey(
  key: string,
  options: {
    readonly chromium?: boolean;
    readonly profile?: boolean;
    readonly runtimeFault?: ConstructorParameters<typeof BrowserPoolCoordinator>[0]["runtimeFault"];
  } = {},
) {
  const real = options.chromium !== false;
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-route-"));
  const task = await fixture.startRunFixture(key);
  const { database, store } = fixture;
  await database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
    .where("id", "=", task.runnerId)
    .execute();
  const slotId = `slot-${key}`;
  const controller = new FakeBrowserPoolController({ slotId, term: 1 });
  const tickets = generateKeyPairSync("ed25519");
  let launched: LaunchedBrowser | undefined;
  const launcher = real
    ? new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath: chromium.executablePath(),
        headless: true,
      })
    : new FakeIsolatingLauncher();
  if (real) {
    const launch = launcher.launch.bind(launcher);
    vi.spyOn(launcher, "launch").mockImplementation(async (request) => {
      const browser = await launch(request);
      launched = browser;
      return browser;
    });
  }
  const guest = new BrowserRuntime({
    runtimeId: "pool-runtime",
    launcher,
    sessionFilesRoot: join(root, "sessions"),
    ...(options.profile ? { localProfiles: { root: join(root, "profiles") } } : {}),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      pooled: true,
      replayLedgerPath: join(root, "private", "tickets.json"),
      resolvePublicKey: (id) => (id === "test" ? tickets.publicKey : null),
    }),
    pool: { controllerKey: controller.publicKey, probePage: async () => [] },
  });
  const bridgeToken = randomUUID();
  const runtimeServer = new BrowserRuntimeServer({
    runtime: guest,
    port: 0,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: () => {
        throw new Error("The loopback data bridge cannot replace the pooled ticket key.");
      },
    },
  });
  const address = await runtimeServer.start();
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken,
    runtimeId: "pool-runtime",
    url: new URL(`http://${address.host}:${address.port}`),
  });
  bridge.setAttachPublicKeys([
    {
      keyId: "test",
      publicKeyPem: tickets.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ]);
  const signer = new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey });
  const issued: string[] = [];
  const connect = (ticket: string) => {
    issued.push(ticket);
    return new TestRuntimeConnection(bridge, ticket);
  };
  const placement = {
    kind: "runner" as const,
    runnerId: task.runnerId,
    label: "Pooled test browser",
    runtimeId: "pool-runtime",
    environmentIds: [task.environmentId],
    available: true,
  };
  const tabs = new TabStore(database);
  const profile = options.profile
    ? await store.createBrowserProfile({
        name: "Saved browser",
        ownerId: task.userId,
        homeRunnerId: task.runnerId,
        idempotencyKey: "saved-profile",
      })
    : null;
  const homes: Home[] = [];
  const startHome = async (channel: BrowserPoolRuntimeChannel = guest): Promise<Home> => {
    const coordinator = new BrowserPoolCoordinator({
      database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId,
      term: 1,
      runtime: channel,
      controller,
      retryMs: 20,
      ...(options.runtimeFault ? { runtimeFault: options.runtimeFault } : {}),
    });
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      managedPoolTestRunner: task.runnerId,
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      ...(profile
        ? {
            localProfiles: new BrowserLocalProfiles({
              deploymentId: task.deploymentId,
              repository: store,
              baseUrl: new URL("http://127.0.0.1"),
            }),
          }
        : {}),
      signer,
      onSessionsChanged: () => {},
      targetResolver: {
        placements: () => [placement],
        resolve: () => ({
          runtimeId: "pool-runtime",
          placementKey: "pool-test",
          main: true,
          surfaceState: 1,
          tabRestoreVersion: true,
          sharedControl: true,
          cdpBoundary: true,
          ...(guest.localProfileStorage ? { localProfileStorage: guest.localProfileStorage } : {}),
          loopbackPool: coordinator,
          connect,
        }),
      },
    });
    const home = { service, coordinator };
    homes.push(home);
    await service.initialize();
    return home;
  };
  const restartHome = async (home: Home, channel?: BrowserPoolRuntimeChannel) => {
    await home.service.close();
    home.coordinator.close();
    return startHome(channel);
  };
  const command = (idempotencyKey: string) => ({
    type: "browser.tab.open" as const,
    identity: { kind: "guest" as const },
    placement: { kind: "runner" as const, runnerId: task.runnerId },
    idempotencyKey,
  });
  /** Types an unsent draft into the newest page; a key "x" later turns the page green. */
  const draft = async (index = -1) => {
    const page = launched?.context.pages().at(index);
    if (!page) throw new Error("The test runtime did not launch a page.");
    const cdp = await page.cdp();
    await cdp.send("Runtime.evaluate", {
      expression: `
        document.body.innerHTML = '<input style="font-size:32px;width:90%">';
        document.body.style.backgroundColor = '#ffffff';
        document.body.style.minHeight = '100vh';
        const input = document.querySelector('input');
        input.addEventListener('input', () => {
          document.body.style.backgroundColor = input.value.endsWith('x') ? '#147443' : '#ffffff';
        });
        input.focus();
        window.marker = 99;
      `,
    });
    await cdp.send("Input.insertText", { text: "unsent draft" });
    const value = async () =>
      (
        await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "JSON.stringify([document.querySelector('input').value, window.marker])",
          returnByValue: true,
        })
      ).result.value;
    const rendered = () =>
      cdp.send("Runtime.evaluate", {
        expression:
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        awaitPromise: true,
      });
    return { page, cdp, targetId: await page.targetId(), value, rendered };
  };
  const viewer = (home: Home, sessionId: string, mode: "control" | "watch" = "control") => {
    let open = true;
    const frames: Buffer[] = [];
    const attaching = home.service.attach(
      task.userId,
      BrowserSessionIdSchema.parse(sessionId),
      {
        id: `viewer-${randomUUID()}`,
        isOpen: () => open,
        close: () => {
          open = false;
        },
        send: async (data, binary) => {
          if (binary && Buffer.isBuffer(data)) frames.push(data);
        },
      },
      { authSessionId: createId("authSession"), mode, signedIn: async () => true },
    );
    void attaching.catch(() => undefined);
    return { attaching, frames };
  };
  const close = async () => {
    try {
      for (const home of homes) {
        home.coordinator.close();
        await home.service.close().catch(() => undefined);
      }
      await runtimeServer.close();
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    }
  };
  return {
    fixture,
    task,
    database,
    store,
    controller,
    guest,
    tabs,
    profile,
    issued,
    connect,
    signer,
    startHome,
    restartHome,
    command,
    draft,
    viewer,
    slot: () => readBrowserPoolSlot(database, task.runnerId),
    row: (sessionId: string) =>
      store.getBrowserSessionForOwner(BrowserSessionIdSchema.parse(sessionId), task.userId),
    close,
  };
}

/** Holds the next resume until `allow` resolves; `seen` resolves when it arrives. */
function holdResume(controller: FakeBrowserPoolController) {
  const seen = Promise.withResolvers<void>();
  const allow = Promise.withResolvers<void>();
  controller.hold("resume", async () => {
    seen.resolve();
    await allow.promise;
  });
  return { seen: seen.promise, allow: () => allow.resolve(), release: allow };
}

async function before<T>(gate: Promise<void>, work: Promise<T>, what: string) {
  await Promise.race([
    gate,
    work.then(() => {
      throw new Error(`${what} completed before the browser resumed.`);
    }),
  ]);
}

async function greenAt(frame: Buffer, tabId: string): Promise<boolean | undefined> {
  const decoded = decodeBrowserFrameEnvelope(frame);
  if (decoded.header.surfaceId !== tabId) return undefined;
  const { data, info } = await sharp(Buffer.from(decoded.data))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height * 0.75) * info.width + (info.width >> 1)) * info.channels;
  const [red, green, blue] = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  return green > 90 && red < 70 && blue < 110;
}

/** The edit is visible only if a frame shows the page's own colour change, not a caret. */
async function editVisibly(
  attached: { handle(data: Buffer, binary: boolean): Promise<void> },
  frames: Buffer[],
  tabId: string,
  value: () => Promise<string>,
  rendered: () => Promise<unknown>,
) {
  await attached.handle(
    Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
    false,
  );
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
  expect(await greenAt(frames[0]!, tabId)).toBe(false);
  const count = frames.length;
  const key = {
    type: "input.key",
    surfaceId: tabId,
    key: "x",
    code: "KeyX",
    modifiers: [],
    text: "x",
  };
  await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "down" })), false);
  await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "up" })), false);
  await vi.waitFor(async () => expect(await value()).toBe('["unsent draftx",99]'));
  // Let the colour change reach the compositor before a fresh frame is asked for.
  await rendered();
  await attached.handle(
    Buffer.from(JSON.stringify({ type: "stream.unsubscribe", surfaceId: tabId })),
    false,
  );
  await attached.handle(
    Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
    false,
  );
  await vi.waitFor(async () => {
    const results = await Promise.all(frames.slice(count).map((frame) => greenAt(frame, tabId)));
    expect(results).toContain(true);
  });
}

it("opens a person tab through the Home after the pooled runtime wakes, with a lost pause request and a lost resume reply", async () => {
  const j = await journey("empty", { chromium: false });
  try {
    const home = await j.startHome();
    expect(j.controller.effects).toEqual(["start"]);
    j.controller.inject("pause", "request");
    expect(await home.coordinator.tryPark()).toBe("parked");
    expect(j.controller.effects).toEqual(["start", "pause"]);
    j.controller.inject("resume", "reply");
    await expect(
      home.service.openTab(j.task.userId, j.command("after-wake")),
    ).resolves.toMatchObject({
      tabId: expect.any(String),
    });
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(j.issued).toHaveLength(1);
    expect(await j.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect(await j.store.getBrowserTabOpen(j.task.userId, "after-wake")).toMatchObject({
      outcome: { kind: "opened" },
    });
  } finally {
    await j.close();
  }
});

it("keeps an unsent draft through a vetoed park, a park and a Home restart, and edits the same document visibly", async () => {
  const j = await journey("first-proof");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("draft"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(original).toEqual(expect.any(String));
    // A send before D vetoes the park.
    const early = await home.coordinator.gate.reserve(AbortSignal.timeout(1_000));
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    early.release();
    const parkedFence = home.coordinator.fence();
    expect(await home.coordinator.tryPark()).toBe("parked");
    const beforePark = j.issued.at(-1)!;
    home = await j.restartHome(home);
    expect(home.coordinator.gate.phase).toBe("parked");
    expect((await j.row(sessionId))?.state).toBe("ready");
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId);
    await before(resume.seen, watching.attaching, "The viewer");
    expect(j.issued.at(-1)).toBe(beforePark);
    resume.allow();
    const attached = await watching.attaching;
    try {
      expect(await page.page.targetId()).toBe(page.targetId);
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
      expect(await home.coordinator.tryPark()).toBe("vetoed");
      expect(await j.slot()).toMatchObject({
        phase: "running",
        epoch: 2,
        outcome: { adopted: [sessionId], lost: [] },
      });
      // A ticket issued before the park is refused after the wake.
      const refusal = async (ticket: string) => {
        const stale = j.connect(ticket);
        const refused = Promise.withResolvers<unknown>();
        stale.once("error", refused.resolve);
        const error = await refused.promise;
        expect(stale.readyState).toBe(3);
        return (error as Error).message;
      };
      expect(await refusal(beforePark)).toBe("The browser attach ticket has already been used.");
      // A ticket issued before the park and never redeemed meets the new fence.
      expect(
        await refusal(
          j.signer.issue({
            creationOrigin: "person",
            actor: "person",
            access: "read-write",
            reattach: true,
            pool: parkedFence,
            identity: { kind: "fresh" },
            runtimeId: "pool-runtime",
            sessionId,
            subject: j.task.userId,
          }),
        ),
      ).toBe("The pooled browser authority has changed.");
      expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("stops a parked session while its viewer waits and never reattaches it", async () => {
  const j = await journey("stop-waiting");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("stop"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId);
    await before(resume.seen, watching.attaching, "The viewer");
    const attachesBefore = j.issued.length;
    await home.service.stop(j.task.userId, sessionId);
    await expect(watching.attaching).rejects.toThrow("stopped this browser");
    resume.allow();
    await vi.waitFor(async () =>
      expect(await j.slot()).toMatchObject({
        phase: "running",
        outcome: { adopted: [], lost: [{ sessionId }] },
      }),
    );
    expect(j.issued.length).toBe(attachesBefore);
    expect(page.page.isClosed()).toBe(true);
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId },
    ]);
  } finally {
    await j.close();
  }
});

it("stops a validly parked browser session without waking it", async () => {
  const j = await journey("stop-parked");
  try {
    let home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-parked"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closed");
    expect(await j.slot()).toMatchObject({ phase: "parked" });
    expect(j.controller.effects).toEqual(["start", "pause"]);
    expect(page.page.isClosed()).toBe(false);
  } finally {
    await j.close();
  }
});

it("adopts the open tab of a session and closes the one closed while parked", async () => {
  const j = await journey("two-tabs");
  try {
    let home = await j.startHome();
    const first = await home.service.openTab(j.task.userId, j.command("tab-a"));
    const second = await home.service.openTab(j.task.userId, j.command("tab-b"));
    expect(second.sessionId).toBe(first.sessionId);
    const pages = j.guest.health();
    expect(pages.sessionCount).toBe(1);
    const kept = await j.draft(0);
    const keptDocument = home.service
      .pageInventory(first.sessionId)
      ?.records.get(first.tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const closedRow = await j.tabs.get(j.task.userId, second.tabId);
    expect((await j.tabs.close(j.task.userId, [second.tabId], "close-parked")).tabIds).toEqual([
      second.tabId,
    ]);
    await home.service.pageTabs.closeViewers(j.task.userId, closedRow!, true);
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const row = await j.tabs.get(j.task.userId, first.tabId);
    const activating = home.service.pageTabs.activate(j.task.userId, row!, "activate-kept");
    await expect(activating).resolves.toMatchObject({
      kind: "page",
      sessionId: first.sessionId,
      surfaceId: first.tabId,
    });
    expect(home.service.pageInventory(first.sessionId)?.records.get(first.tabId)?.documentId).toBe(
      keptDocument,
    );
    await vi.waitFor(() =>
      expect(home.service.pageInventory(first.sessionId)?.records.has(second.tabId)).toBe(false),
    );
    expect(await kept.value()).toBe('["unsent draft",99]');
    expect((await j.row(first.sessionId))?.state).toBe("ready");
    expect(await j.slot()).toMatchObject({
      phase: "running",
      outcome: { adopted: [first.sessionId], lost: [] },
    });
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, second.tabId)).toEqual(
      [],
    );
  } finally {
    await j.close();
  }
});

it("wakes only for a visible owner context read and keeps a parked sign-in lookup non-waking", async () => {
  const j = await journey("context");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("context"));
    await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    await expect(
      home.service.signInTarget({ ownerId: j.task.userId, sessionId, tabId }),
    ).resolves.toBeNull();
    await expect(
      home.service.readContextCandidate(j.task.userId, {
        sessionId,
        tabId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const resume = holdResume(j.controller);
    const reading = home.service.readContextCandidate(j.task.userId, { sessionId, tabId });
    await before(resume.seen, reading, "The context read");
    resume.allow();
    await expect(reading).resolves.toMatchObject({ sessionId, tabId, documentId: original });
  } finally {
    await j.close();
  }
});

it("continues an adoption a Home crash interrupted, inside the original window, with one resume", async () => {
  const j = await journey("recover-adoption");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("crash"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home, dyingAfter(j.guest, "adopt"));
    const dying = j.viewer(home, sessionId);
    await vi.waitFor(() => expect(j.guest.poolState()?.phase).toBe("adopting"));
    const interrupted = j.guest.poolState()!;
    expect(await j.slot()).toMatchObject({ phase: "waking", epoch: 2 });
    home = await j.restartHome(home);
    await expect(dying.attaching).rejects.toThrow();
    expect(home.coordinator.gate.phase).toBe("open");
    expect(j.guest.poolState()?.adoption?.until).toBe(interrupted.adoption?.until);
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
      expect(await j.slot()).toMatchObject({
        phase: "running",
        epoch: 2,
        outcome: { adopted: [sessionId], lost: [] },
      });
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("keeps a saved-profile session's draft through a park and adopts it with its profile", async () => {
  const j = await journey("saved-profile", { profile: true });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const original = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const row = await j.tabs.get(j.task.userId, tab.id);
    await expect(
      home.service.pageTabs.activate(j.task.userId, row!, "activate-profile"),
    ).resolves.toMatchObject({ kind: "page", sessionId: session.id, surfaceId: tab.id });
    expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    expect((await j.row(session.id))?.profileId).toBe(j.profile!.id);
    expect(await j.store.getBrowserProfileStorage(j.profile!.id)).toMatchObject({
      kind: "local",
      initialized: true,
    });
  } finally {
    await j.close();
  }
});

it("keeps a page an agent opened through a park and adopts its session", async () => {
  const j = await journey("agent-page");
  try {
    let home = await j.startHome();
    const run = {
      agentBindingId: `run:${j.task.runId}`,
      ownerId: j.task.userId,
      environmentId: j.task.environmentId,
      threadId: j.task.threadId,
    };
    const opened = await home.service.openAgentTab(run, {
      identity: { kind: "guest", computer: j.task.runnerId },
      operationKey: "agent-page",
    });
    const page = await j.draft();
    const original = home.service
      .pageInventory(opened.sessionId)
      ?.records.get(opened.tabId)?.documentId;
    expect((await j.row(opened.sessionId))?.origin).toBe("agent");
    // While the Run holds the page, the park is vetoed; once it let go, the page is kept.
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    // The Run's end goes the ordinary way; its state update is delivered before a park.
    await home.service.detachAgentSessionsForBinding(run.agentBindingId);
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    // The person watches the agent's page: that demand wakes the browser.
    const watching = j.viewer(home, opened.sessionId, "watch");
    const attached = await watching.attaching;
    attached.close();
    expect(
      home.service.pageInventory(opened.sessionId)?.records.get(opened.tabId)?.documentId,
    ).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    expect(await j.slot()).toMatchObject({
      outcome: { adopted: [opened.sessionId], lost: [] },
    });
  } finally {
    await j.close();
  }
});

it("says once that a page could not be kept when the saved state expired, and reopens it", async () => {
  const j = await journey("expired");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("expired"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    j.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    const row = await j.tabs.get(j.task.userId, tabId);
    const restored = await home.service.pageTabs.activate(j.task.userId, row!, "activate-lost");
    expect(restored).toMatchObject({
      kind: "page",
      surfaceId: tabId,
      recoveryNotice: "This page was reloaded because its live state could not be kept.",
    });
    expect(restored.kind === "page" && restored.sessionId).not.toBe(sessionId);
    expect(page.page.isClosed()).toBe(true);
    expect((await j.row(sessionId))?.state).toBe("failed");
    expect(
      restored.kind === "page" &&
        home.service.pageInventory(restored.sessionId)?.records.get(tabId)?.documentId,
    ).not.toBe(original);
    const again = await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "activate-again",
    );
    expect(again).not.toHaveProperty("recoveryNotice");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, surfaceId: tabId, documentId: original, noticedAt: expect.any(Date) },
    ]);
    expect(j.controller.effects).toEqual(["start", "pause", "start"]);
  } finally {
    await j.close();
  }
});

it("keeps every page usable after a release that followed a retire", async () => {
  let seals = 0;
  const j = await journey("release-after-retire", {
    // Both seal requests are lost: the park is released after its retire.
    runtimeFault: (kind) => (kind === "seal" && seals++ < 2 ? "request" : undefined),
  });
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("release"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    expect(j.guest.poolState()).toMatchObject({
      phase: "running",
      cancelled: true,
      adoption: { cause: "release", outcome: { adopted: [sessionId], lost: [] } },
    });
    expect(j.controller.effects).toEqual(["start"]);
    expect(home.coordinator.gate.phase).toBe("open");
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

for (const mode of ["run-open", "run-bind"] as const)
  it(
    mode === "run-open"
      ? "waits for pooled admission before a Run opens its own page"
      : "waits for pooled admission before a Run binds and joins a retained page",
    async () => {
      const j = await journey(mode);
      try {
        let home = await j.startHome();
        const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command(mode));
        await j.draft();
        const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
        expect(await home.coordinator.tryPark()).toBe("parked");
        home = await j.restartHome(home);
        const run = {
          agentBindingId: `run:${j.task.runId}`,
          ownerId: j.task.userId,
          environmentId: j.task.environmentId,
          threadId: j.task.threadId,
        };
        const tab = await j.tabs.get(j.task.userId, tabId);
        const resume = holdResume(j.controller);
        const result =
          mode === "run-open"
            ? home.service.openAgentTab(run, {
                identity: { kind: "guest", computer: j.task.runnerId },
                operationKey: "run-open",
              })
            : (async () => {
                const scope = await j.store.runCapabilityScope(j.task.runId);
                if (!scope) throw new Error("The test Run has no browser authority.");
                return home.service.bindPage(
                  {
                    ...scope,
                    aud: "opensteer-run-tools",
                    iss: "opensteer-host",
                    jti: randomUUID(),
                    iat: 1,
                    exp: 2,
                  },
                  tab!,
                );
              })();
        try {
          await before(resume.seen, result, "The Run");
          expect(
            await j.store.listActiveBrowserSessionsForAgentBinding(run.agentBindingId),
          ).toEqual([]);
          resume.allow();
          const bound = await result;
          expect(bound.backend).toBe("cdp");
          if (mode === "run-bind") {
            expect(bound).toMatchObject({ tabId, sessionId, reloaded: false });
            await expect(
              home.service.openAgentSession({ ...run, sessionId }),
            ).resolves.toMatchObject({
              wasExisting: true,
              session: { id: sessionId, attached: true },
            });
            expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
              original,
            );
          } else expect(bound.sessionId).not.toBe(sessionId);
          expect(await j.store.listBrowserSessionAttachmentBindings(bound.sessionId)).toEqual([
            run.agentBindingId,
          ]);
          expect(await home.coordinator.tryPark()).toBe("vetoed");
          const cdp = await home.service.attachCdpForAgent(
            { ...run, sessionId: bound.sessionId },
            () => {},
          );
          try {
            await j.store.detachBrowserSessionAttachments(run.agentBindingId);
            expect(await home.coordinator.tryPark()).toBe("vetoed");
            expect(await cdp.request({ method: "Target.getTargets" })).toMatchObject({
              targetInfos: expect.any(Array),
            });
            await expect(
              home.service.attachActionsForAgent({ ...run, sessionId: bound.sessionId }, () => {}),
            ).rejects.toThrow("no detach receipt");
          } finally {
            await cdp.pooledClose!();
          }
          expect(await j.database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual(
            [],
          );
        } finally {
          resume.allow();
          await result.catch(() => undefined);
        }
      } finally {
        await j.close();
      }
    },
  );

it("holds the gate until an awake physical close has a matching terminal receipt", async () => {
  const j = await journey("close-awake");
  try {
    const home = await j.startHome();
    const { tabId } = await home.service.openTab(j.task.userId, j.command("close-awake"));
    const page = await j.draft();
    const tab = await j.tabs.get(j.task.userId, tabId);
    const closed = Promise.withResolvers<void>();
    page.page.onClose(() => closed.resolve());
    expect((await j.tabs.close(j.task.userId, [tabId], "close-awake")).tabIds).toEqual([tabId]);
    await home.service.pageTabs.closeViewers(j.task.userId, tab!, true);
    await closed.promise;
    await vi.waitFor(async () =>
      expect(await j.database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual([]),
    );
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    await j.close();
  }
});

it("holds the gate for a live Watch viewer before its first retained-page frame", async () => {
  const j = await journey("live-watch");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("watch"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId, "watch");
    await before(resume.seen, watching.attaching, "The Watch viewer");
    resume.allow();
    const attached = await watching.attaching;
    try {
      await attached.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
        false,
      );
      await vi.waitFor(() => expect(watching.frames.length).toBeGreaterThan(0));
      expect(decodeBrowserFrameEnvelope(watching.frames[0]!).header.surfaceId).toBe(tabId);
      expect(await page.page.targetId()).toBe(page.targetId);
      expect(await home.coordinator.tryPark()).toBe("vetoed");
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});
