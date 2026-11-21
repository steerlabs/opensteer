import {
  AgentConnectionStore,
  admitAgentOperation,
  advanceBrowserPoolSlot,
  beginAgentSession,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  decideAgentOperation,
  handOffAgentOperation,
  listBrowserPoolDocumentLosses,
  readBrowserPoolSlot,
  requireBrowserPoolAdmission,
  TabStore,
  type BrowserPoolTargetIdentity,
} from "../packages/database/src/index.js";
import { commitPersonalMutation } from "../packages/database/src/personal-mutation.js";
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
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { BrowserPoolGate } from "../apps/host/src/browser/browser-pool-gate.js";
import { PooledBrowserRelay } from "../apps/host/src/browser/browser-pool-relay.js";
import {
  createLoopbackBrowserPool,
  type LoopbackPoolPhysicalState,
} from "../apps/host/src/browser/browser-pool-loopback.js";
import {
  BrowserService,
  type BrowserRuntimeConnection,
} from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";

it("orders park intent against demand and wakes once without dispatching a cancelled waiter", async () => {
  const fixture = await createStoreFixture();
  const hold = Promise.withResolvers<void>();
  const wake = Promise.withResolvers<void>();
  try {
    const task = await fixture.createRunFixture("browser-pool");
    const { database } = fixture;
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "pool-slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const afterD = Promise.withResolvers<void>();
    const wakeStarted = Promise.withResolvers<void>();
    let wakes = 0;
    let dispatched = 0;
    const read = () => readBrowserPoolSlot(database, target.runnerId);
    const gate = new BrowserPoolGate({
      read,
      begin: async (id, demanded) => {
        await beginBrowserPoolPark(database, target, id, demanded);
        throw new Error("Commit reply lost");
      },
      park: async (slot) => {
        afterD.resolve();
        await hold.promise;
        return advanceBrowserPoolSlot(database, slot, { ...slot, phase: "parked", retained: null });
      },
      abortPark: (slot) => advanceBrowserPoolSlot(database, slot, { ...slot, phase: "running" }),
      wake: async (slot) => {
        wakes++;
        wakeStarted.resolve();
        await wake.promise;
        return advanceBrowserPoolSlot(database, slot, { ...slot, phase: "running" });
      },
    });
    gate.recovered(undefined);
    const stop = new AbortController();
    const first = await gate.reserve(stop.signal);
    expect(await gate.tryPark()).toBe("vetoed");
    expect(await read()).toBeUndefined();
    first.release();
    const parking = gate.tryPark();
    await afterD.promise;
    expect(await read()).toMatchObject({ phase: "preparing", intentSequence: 1 });
    expect(() => gate.holdOpen()).toThrow(BrowserPoolAdmissionClosed);
    await expect(
      commitPersonalMutation(database, (tx) => requireBrowserPoolAdmission(tx, target.runnerId)),
    ).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
    const cancelled = expect(
      gate.reserve(stop.signal).then(() => {
        dispatched++;
      }),
    ).rejects.toThrow("Stopped");
    const next = gate.reserve(new AbortController().signal);
    const other = gate.reserve(new AbortController().signal);
    stop.abort(new Error("Stopped"));
    await cancelled;
    expect(wakes).toBe(0);
    hold.resolve();
    expect(await parking).toBe("parked");
    await wakeStarted.promise;
    expect([wakes, dispatched]).toEqual([1, 0]);
    wake.resolve();
    (await next).release();
    (await other).release();
    expect(wakes).toBe(1);
    await expect(
      commitPersonalMutation(database, (tx) => requireBrowserPoolAdmission(tx, target.runnerId)),
    ).resolves.toBeUndefined();
  } finally {
    hold.resolve();
    wake.resolve();
    await fixture.close();
  }
});

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
    const begin = () => beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(await begin()).toBeUndefined();
    expect(await readBrowserPoolSlot(database, target.runnerId)).toBeUndefined();
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
    const intent = await beginBrowserPoolPark(
      database,
      {
        runnerId: task.runnerId,
        runtimeId: "pool-runtime",
        slotId: "test-slot",
        instanceId: randomUUID(),
        term: 1,
        epoch: 1,
      },
      randomUUID(),
      () => false,
    );
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
    const release = vi.fn();
    const relay = await PooledBrowserRelay.open(fixture.database, target, { release });
    relay.submitted();
    relay.track("Runtime.evaluate", undefined, Promise.reject(new Error("Reply lost")));
    await relay.close();
    expect(release).toHaveBeenCalledOnce();
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toBeUndefined();
    expect(
      await beginBrowserPoolPark(
        fixture.database,
        {
          ...target,
          instanceId: randomUUID(),
          term: 2,
        },
        randomUUID(),
        () => false,
      ),
    ).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  browserPoolControlBytes,
  Ed25519AttachTicketVerifier,
  type LaunchedBrowser,
  type BrowserPoolControl,
} from "../packages/browser-runtime-core/src/index.js";
import { FakeIsolatingLauncher } from "../packages/browser-runtime-core/src/test-support/fakes.js";

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

it("opens a person tab through the Home after a pooled runtime resumes", () =>
  ownerTabJourney("empty"));
it("rebuilds the owner broker after a parked BrowserService restart and edits the original draft", () =>
  ownerTabJourney("restore"));
it("stops a parked session while its viewer waits and never reattaches it", () =>
  ownerTabJourney("stop"));
it("stops a validly parked browser session without waking it", () =>
  ownerTabJourney("stop-parked"));
it("closes parked workspace membership without a physical close and excludes it on wake", () =>
  ownerTabJourney("close-parked"));
it("activates a retained workspace tab after waiting for its pooled browser", () =>
  ownerTabJourney("activate"));
it("wakes only for a visible owner context read and keeps a parked sign-in lookup non-waking", () =>
  ownerTabJourney("context"));
it("reconciles an interrupted adoption with the original epoch and one physical resume", () =>
  ownerTabJourney("recover-adoption"));
it("waits for pooled admission before a Run opens its own page", () => ownerTabJourney("run-open"));
it("waits for pooled admission before a Run binds and joins a retained page", () =>
  ownerTabJourney("run-bind"));
it("starts a person session on the pooled device and adopts its saved profile after restart", () =>
  ownerTabJourney("saved-profile"));
it("restores a lost pooled page with its original tab ID and a durable loss notice", () =>
  ownerTabJourney("lost-page"));
it("holds the gate until an awake physical close has a matching terminal receipt", () =>
  ownerTabJourney("close-awake"));
it("holds the gate for a live Watch viewer before its first retained-page frame", () =>
  ownerTabJourney("live-watch"));

async function ownerTabJourney(
  mode:
    | "empty"
    | "restore"
    | "stop"
    | "stop-parked"
    | "close-parked"
    | "activate"
    | "context"
    | "recover-adoption"
    | "run-open"
    | "run-bind"
    | "saved-profile"
    | "lost-page"
    | "close-awake"
    | "live-watch",
) {
  const restart = mode !== "empty";
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-route-"));
  let runtime: BrowserRuntime | undefined;
  let runtimeServer: BrowserRuntimeServer | undefined;
  let browser: BrowserService | undefined;
  const allowResume = Promise.withResolvers<void>();
  try {
    const task = await fixture.startRunFixture("pool-owner-tab");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", task.runnerId)
      .execute();
    const controller = generateKeyPairSync("ed25519");
    const tickets = generateKeyPairSync("ed25519");
    let launched: LaunchedBrowser | undefined;
    const launcher = restart
      ? new PlaywrightChromiumLauncher({
          chromiumSandbox: false,
          executablePath: chromium.executablePath(),
          headless: true,
        })
      : new FakeIsolatingLauncher();
    if (restart) {
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
      ...(mode === "saved-profile" ? { localProfiles: { root: join(root, "profiles") } } : {}),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        pooled: true,
        replayLedgerPath: join(root, "private", "tickets.json"),
        resolvePublicKey: (id) => (id === "test" ? tickets.publicKey : null),
      }),
      pool: { term: 1, controllerKey: controller.publicKey, probePage: async () => [] },
    });
    runtime = guest;
    const bridgeToken = randomUUID();
    runtimeServer = new BrowserRuntimeServer({
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
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "test-slot",
      instanceId: guest.standardCdpBootId,
      term: 1,
      epoch: 1,
    };
    let physical: LoopbackPoolPhysicalState = {
      slotId: target.slotId,
      instanceId: target.instanceId,
      term: target.term,
      phase: "running",
      lastOperation: null,
    };
    const calls: string[] = [];
    let lostPauseRequest = false;
    let lostResumeReply = false;
    let interruptAdoption = mode === "recover-adoption";
    const resumeSeen = Promise.withResolvers<void>();
    const poolOptions: Parameters<typeof createLoopbackBrowserPool>[0] = {
      database,
      runtime: guest,
      target,
      controllerKey: controller.privateKey,
      physical: {
        status: async () => physical,
        apply: async ({ id, kind, expect: previous }) => {
          expect(previous).toEqual(physical);
          if (!restart && kind === "pause" && !lostPauseRequest) {
            lostPauseRequest = true;
            throw new Error("Pause request lost before delivery");
          }
          calls.push(kind);
          if (restart && kind === "resume") {
            resumeSeen.resolve();
            await allowResume.promise;
          }
          physical = {
            ...physical,
            phase: kind === "pause" ? "paused" : "running",
            lastOperation: id,
          };
          if (!restart && kind === "resume" && !lostResumeReply) {
            lostResumeReply = true;
            throw new Error("Resume reply lost after delivery");
          }
          return physical;
        },
      },
      ...(restart
        ? {
            adopt: async (documents, fence, attachment) => {
              if (mode === "lost-page") return [];
              if (interruptAdoption) {
                interruptAdoption = false;
                throw new Error("The Home disappeared after M10");
              }
              return browser!.adoptPooledOwnerDocuments(
                task.userId,
                task.runnerId,
                documents,
                fence,
                attachment,
              );
            },
          }
        : {}),
    };
    const placement = {
      kind: "runner" as const,
      runnerId: task.runnerId,
      label: "Pooled test browser",
      runtimeId: target.runtimeId,
      environmentIds: [task.environmentId],
      available: true,
    };
    const tabs = new TabStore(database);
    const profile =
      mode === "saved-profile"
        ? await store.createBrowserProfile({
            name: "Saved browser",
            ownerId: task.userId,
            homeRunnerId: task.runnerId,
            idempotencyKey: "saved-profile",
          })
        : null;
    const startHome = async () => {
      const negotiated = await createLoopbackBrowserPool(poolOptions);
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
        signer: new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey }),
        onSessionsChanged: () => {},
        targetResolver: {
          placements: () => [placement],
          resolve: () => ({
            runtimeId: target.runtimeId,
            placementKey: "pool-test",
            main: true,
            surfaceState: 1,
            tabRestoreVersion: true,
            sharedControl: true,
            cdpBoundary: true,
            ...(guest.localProfileStorage
              ? { localProfileStorage: guest.localProfileStorage }
              : {}),
            loopbackPool: negotiated,
            connect: (ticket) => {
              calls.push("attach");
              return new TestRuntimeConnection(bridge, ticket);
            },
          }),
        },
      });
      browser = service;
      await service.initialize();
      return { service, negotiated };
    };
    const command = {
      type: "browser.tab.open" as const,
      identity: { kind: "guest" as const },
      placement: { kind: "runner" as const, runnerId: task.runnerId },
      idempotencyKey: "after-wake",
    };
    if (!restart) {
      const intent = await beginBrowserPoolPark(database, target, randomUUID(), () => false);
      expect(intent?.phase).toBe("preparing");
      await createLoopbackBrowserPool(poolOptions);
      expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
        phase: "running",
      });
      const delayed: BrowserPoolControl = {
        kind: "retire",
        fence: guest.poolState()!.fence,
        intent: { id: intent!.intentId, sequence: intent!.intentSequence },
      };
      await expect(
        guest.controlPool(
          delayed,
          sign(null, browserPoolControlBytes(delayed), controller.privateKey),
        ),
      ).rejects.toThrow("cancelled");
      expect(calls).toEqual([]);
    }
    const { service, negotiated } = await startHome();
    if (restart) {
      const { sessionId, tabId } = await (async () => {
        if (!profile) return service.openTab(task.userId, command);
        const { session } = await service.start({ ownerId: task.userId, profileId: profile.id });
        const [tab] = await service.savedPages(task.userId, session.id);
        if (!tab || !tab.pageBinding) throw new Error("The saved profile has no durable tab.");
        return { sessionId: session.id, tabId: tab.id };
      })();
      const document = launched?.context.pages()[0];
      if (!document) throw new Error("The test runtime did not launch a page.");
      const cdp = await document.cdp();
      const targetId = await document.targetId();
      await cdp.send("Runtime.evaluate", {
        expression: `
          document.body.innerHTML = '<input style="font-size:32px;width:90%">';
          const input = document.querySelector('input');
          input.addEventListener('input', () => {
            document.body.style.backgroundColor = input.value.endsWith('x') ? '#147443' : '#ffffff';
          });
          input.focus();
          window.marker = 99;
        `,
      });
      await cdp.send("Input.insertText", { text: "unsent draft" });
      const original = service.pageInventory(sessionId)?.records.get(tabId);
      const tab = await tabs.get(task.userId, tabId);
      expect(tab?.pageBinding?.sessionId).toBe(sessionId);
      expect(original?.documentId).toEqual(expect.any(String));
      if (mode === "close-awake") {
        const closed = Promise.withResolvers<void>();
        document.onClose(() => closed.resolve());
        const closing = await tabs.close(task.userId, [tabId], "close-awake");
        expect(closing.tabIds).toEqual([tabId]);
        await service.pageTabs.closeViewers(task.userId, tab!, true);
        await closed.promise;
        await vi.waitFor(async () =>
          expect(await database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual([]),
        );
        expect(calls).toEqual(["attach"]);
        return;
      }
      const early = negotiated.gate.holdOpen();
      try {
        expect(await negotiated.gate.tryPark()).toBe("vetoed");
      } finally {
        early.release();
      }
      const parking = await negotiated.gate.tryPark();
      expect(parking, JSON.stringify(guest.poolState())).toBe("parked");
      await service.close();
      let restarted = await startHome();
      expect((await store.getBrowserSessionForOwner(sessionId, task.userId))?.state).toBe("ready");
      expect(calls).toEqual(["attach", "pause"]);
      if (mode === "stop-parked") {
        await restarted.service.stop(task.userId, sessionId);
        expect((await store.getBrowserSessionForOwner(sessionId, task.userId))?.state).toBe(
          "closed",
        );
        expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
          phase: "parked",
        });
        expect(calls).toEqual(["attach", "pause"]);
        expect(document.isClosed()).toBe(false);
        return;
      }
      if (mode === "close-parked") {
        expect((await tabs.close(task.userId, [tabId], "close-parked")).tabIds).toEqual([tabId]);
        await restarted.service.pageTabs.closeViewers(task.userId, tab!, true);
        expect(calls).toEqual(["attach", "pause"]);
        expect(document.isClosed()).toBe(false);
        const opening = restarted.service.openTab(task.userId, {
          ...command,
          idempotencyKey: "after-close",
        });
        await Promise.race([
          resumeSeen.promise,
          opening.then(() => {
            throw new Error("The new tab opened before resume.");
          }),
        ]);
        allowResume.resolve();
        await expect(opening).resolves.toMatchObject({ browserStarted: true });
        expect(document.isClosed()).toBe(true);
        expect(calls).toEqual(["attach", "pause", "resume", "attach"]);
        expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
          phase: "running",
          retained: { adopted: [], lost: [{ sessionId, surfaceId: tabId }] },
        });
        return;
      }
      if (mode === "context") {
        await expect(
          restarted.service.signInTarget({ ownerId: task.userId, sessionId, tabId }),
        ).resolves.toBeNull();
        await expect(
          restarted.service.readContextCandidate(task.userId, {
            sessionId,
            tabId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
          }),
        ).rejects.toMatchObject({ code: "not_found" });
        expect(calls).toEqual(["attach", "pause"]);
        const reading = restarted.service.readContextCandidate(task.userId, { sessionId, tabId });
        await Promise.race([
          resumeSeen.promise,
          reading.then(() => {
            throw new Error("The context read completed before physical resume.");
          }),
        ]);
        expect(calls).toEqual(["attach", "pause", "resume"]);
        allowResume.resolve();
        await expect(reading).resolves.toMatchObject({
          sessionId,
          tabId,
          documentId: original?.documentId,
        });
        return;
      }
      if (mode === "activate" || mode === "saved-profile" || mode === "lost-page") {
        const activating = restarted.service.pageTabs.activate(
          task.userId,
          tab!,
          "activate-retained",
        );
        await Promise.race([
          resumeSeen.promise,
          activating.then(() => {
            throw new Error("The tab activated before physical resume.");
          }),
        ]);
        expect(calls).toEqual(["attach", "pause", "resume"]);
        allowResume.resolve();
        if (mode === "lost-page") {
          const restored = await activating;
          expect(restored).toMatchObject({
            kind: "page",
            surfaceId: tabId,
            recoveryNotice: "This page was reloaded because its live state could not be kept.",
          });
          expect(restored.sessionId).not.toBe(sessionId);
          expect(
            restarted.service.pageInventory(restored.sessionId)?.records.get(tabId)?.documentId,
          ).not.toBe(original?.documentId);
          expect(await listBrowserPoolDocumentLosses(database, task.userId, tabId)).toMatchObject([
            { sessionId, surfaceId: tabId, documentId: original?.documentId },
          ]);
          expect(document.isClosed()).toBe(true);
          return;
        }
        await expect(activating).resolves.toEqual({ kind: "page", sessionId, surfaceId: tabId });
        expect(restarted.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
          original?.documentId,
        );
        if (profile) {
          const storage = await store.getBrowserProfileStorage(profile.id);
          expect(storage).toMatchObject({ kind: "local", initialized: true });
          expect((await store.getBrowserSessionForOwner(sessionId, task.userId))?.profileId).toBe(
            profile.id,
          );
          const marker = await cdp.send("Runtime.evaluate", { expression: "window.marker" });
          expect(marker).toMatchObject({ result: { value: 99 } });
        }
        return;
      }
      if (mode === "run-open" || mode === "run-bind") {
        const run = {
          agentBindingId: `run:${task.runId}`,
          ownerId: task.userId,
          environmentId: task.environmentId,
          threadId: task.threadId,
        };
        const bind = async () => {
          const scope = await store.runCapabilityScope(task.runId);
          if (!scope) throw new Error("The test Run has no browser authority.");
          return restarted.service.bindPage(
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
        };
        const result =
          mode === "run-open"
            ? restarted.service.openAgentTab(run, {
                identity: { kind: "guest", computer: task.runnerId },
                operationKey: "run-open",
              })
            : bind();
        try {
          await Promise.race([
            resumeSeen.promise,
            result.then(() => {
              throw new Error("The Run used the browser before physical resume.");
            }),
          ]);
          expect(calls).toEqual(["attach", "pause", "resume"]);
          expect(await store.listActiveBrowserSessionsForAgentBinding(run.agentBindingId)).toEqual(
            [],
          );
          allowResume.resolve();
          const bound = await result;
          expect(bound.backend).toBe("cdp");
          if (mode === "run-bind") {
            expect(bound).toMatchObject({ tabId, sessionId, reloaded: false });
            await expect(
              restarted.service.openAgentSession({ ...run, sessionId }),
            ).resolves.toMatchObject({
              wasExisting: true,
              session: { id: sessionId, attached: true },
            });
            expect(restarted.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
              original?.documentId,
            );
          } else expect(bound.sessionId).not.toBe(sessionId);
          expect(await store.listBrowserSessionAttachmentBindings(bound.sessionId)).toEqual([
            run.agentBindingId,
          ]);
          expect(await restarted.negotiated.gate.tryPark()).toBe("vetoed");
          const cdp = await restarted.service.attachCdpForAgent(
            { ...run, sessionId: bound.sessionId },
            () => {},
          );
          try {
            await store.detachBrowserSessionAttachments(run.agentBindingId);
            expect(await restarted.negotiated.gate.tryPark()).toBe("vetoed");
            expect(await cdp.request({ method: "Target.getTargets" })).toMatchObject({
              targetInfos: expect.any(Array),
            });
            await expect(
              restarted.service.attachActionsForAgent(
                { ...run, sessionId: bound.sessionId },
                () => {},
              ),
            ).rejects.toThrow("no detach receipt");
          } finally {
            await cdp.pooledClose!();
          }
          expect(await database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual([]);
        } finally {
          allowResume.resolve();
          await result.catch(() => undefined);
        }
        return;
      }
      let open = true;
      const frames: Buffer[] = [];
      const attachViewer = () =>
        restarted.service.attach(
          task.userId,
          sessionId,
          {
            id: "restored-owner",
            isOpen: () => open,
            close: () => {
              open = false;
            },
            send: async (data, binary) => {
              if (binary && Buffer.isBuffer(data)) frames.push(data);
            },
          },
          {
            authSessionId: createId("authSession"),
            mode: mode === "live-watch" ? "watch" : "control",
            signedIn: async () => true,
          },
        );
      let attaching = attachViewer();
      void attaching.catch(() => undefined);
      await Promise.race([
        resumeSeen.promise,
        attaching.then(() => {
          throw new Error("The viewer attached before physical resume.");
        }),
      ]);
      expect(calls).toEqual(["attach", "pause", "resume"]);
      if (mode === "stop") {
        await restarted.service.stop(task.userId, sessionId);
        await expect(attaching).rejects.toThrow("stopped this browser");
        expect(calls).toEqual(["attach", "pause", "resume"]);
        allowResume.resolve();
        await vi.waitFor(async () =>
          expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
            phase: "running",
            retained: { adopted: [], lost: [{ sessionId, surfaceId: tabId }] },
          }),
        );
        expect(document.isClosed()).toBe(true);
        return;
      }
      allowResume.resolve();
      if (mode === "recover-adoption") {
        await expect(attaching).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
        const interrupted = guest.poolState();
        expect(interrupted).toMatchObject({ phase: "adopting", fence: { epoch: 2 } });
        expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
          phase: "waking",
          epoch: 1,
          attachmentGeneration: 2,
        });
        await restarted.service.close();
        restarted = await startHome();
        attaching = attachViewer();
        expect(calls).toEqual(["attach", "pause", "resume"]);
        expect(guest.poolState()?.adoption?.until).toBe(interrupted?.adoption?.until);
      }
      const viewer = await attaching;
      try {
        await viewer.handle(
          Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
          false,
        );
        await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
        const originalFrame = decodeBrowserFrameEnvelope(frames[0]!);
        expect(originalFrame.header.surfaceId).toBe(tabId);
        const frameCountBeforeEdit = frames.length;
        expect(await document.targetId()).toBe(targetId);
        expect(restarted.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
          original?.documentId,
        );
        expect(await restarted.negotiated.gate.tryPark()).toBe("vetoed");
        if (mode === "live-watch") return;
        const key = {
          type: "input.key",
          surfaceId: tabId,
          key: "x",
          code: "KeyX",
          modifiers: [],
          text: "x",
        };
        await viewer.handle(Buffer.from(JSON.stringify({ ...key, action: "down" })), false);
        await viewer.handle(Buffer.from(JSON.stringify({ ...key, action: "up" })), false);
        const value = () =>
          cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
            expression: "JSON.stringify([document.querySelector('input').value, window.marker])",
            returnByValue: true,
          });
        await vi.waitFor(async () =>
          expect((await value()).result.value).toBe('["unsent draftx",99]'),
        );
        await cdp.send("Runtime.evaluate", {
          expression:
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          awaitPromise: true,
        });
        await viewer.handle(
          Buffer.from(JSON.stringify({ type: "stream.unsubscribe", surfaceId: tabId })),
          false,
        );
        await viewer.handle(
          Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
          false,
        );
        await vi.waitFor(() =>
          expect(
            frames.slice(frameCountBeforeEdit).some((frame) => {
              const decoded = decodeBrowserFrameEnvelope(frame);
              return (
                decoded.header.surfaceId === tabId &&
                !Buffer.from(decoded.data).equals(Buffer.from(originalFrame.data))
              );
            }),
          ).toBe(true),
        );
        expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
          phase: "running",
          epoch: 2,
          retained: { adopted: [{ sessionId, surfaceId: tabId }] },
        });
      } finally {
        viewer.close();
      }
      return;
    }
    expect(await negotiated.gate.tryPark()).toBe("parked");
    expect(calls).toEqual(["pause"]);
    await expect(service.openTab(task.userId, command)).resolves.toMatchObject({
      tabId: expect.any(String),
    });
    expect(calls).toEqual(["pause", "resume", "attach"]);
    expect({ lostPauseRequest, lostResumeReply }).toEqual({
      lostPauseRequest: true,
      lostResumeReply: true,
    });
    expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
      phase: "running",
      epoch: 2,
    });
    expect(await store.getBrowserTabOpen(task.userId, "after-wake")).toMatchObject({
      outcome: { kind: "opened" },
    });
  } finally {
    allowResume.resolve();
    try {
      await browser?.close();
      if (runtimeServer) await runtimeServer.close();
      else await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    }
  }
}
