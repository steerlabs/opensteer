import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
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
import { BrowserSessionIdSchema, type InitialPageReady } from "../packages/protocol/src/browser.js";
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
import {
  createLoopbackBrowserPool,
  type LoopbackPoolPhysicalState,
} from "../apps/host/src/browser/browser-pool-loopback.js";
import {
  BrowserService,
  type BrowserRuntimeConnection,
} from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";

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
import {
  BrowserRuntime,
  browserPoolControlBytes,
  Ed25519AttachTicketVerifier,
  encodeBrowserFrame,
  type BrowserAttachment,
  type LaunchedBrowser,
  type BrowserPoolControl,
} from "../packages/browser-runtime-core/src/index.js";
import { FakeIsolatingLauncher } from "../packages/browser-runtime-core/src/test-support/fakes.js";

class TestRuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 1;
  initialPage: InitialPageReady | undefined;
  private readonly attached: Promise<BrowserAttachment>;

  constructor(runtime: BrowserRuntime, ticket: string) {
    super();
    this.attached = runtime
      .attach(ticket, {
        sendFrame: async (frame) => {
          if (this.readyState === 1) this.emit("message", encodeBrowserFrame(frame), true);
        },
        sendServer: async (message) => {
          if (this.readyState === 1)
            this.emit("message", Buffer.from(JSON.stringify(message)), false);
        },
        closeForPool: () => this.end(1012, "browser-pool-retire"),
      })
      .then((attachment) => {
        this.initialPage = attachment.initialPage;
        return attachment;
      });
    void this.attached.catch((error: unknown) => this.emit("error", error));
  }

  send(data: string, _options: { binary: false }, callback: (error?: Error) => void): void {
    void this.attached
      .then((attachment) => attachment.handle(data))
      .then(
        () => callback(),
        (error) => callback(error),
      );
  }

  private end(code: number, reason: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    void this.attached
      .then(
        (attachment) => attachment.close(),
        () => undefined,
      )
      .finally(() => this.emit("close", code, Buffer.from(reason)));
  }

  close(): void {
    this.end(1000, "closed");
  }

  terminate(): void {
    this.close();
  }
}

it("opens a person tab through the Home after a pooled runtime resumes", () =>
  ownerTabJourney(false));
it("rebuilds the owner broker after a parked BrowserService restart and edits the original draft", () =>
  ownerTabJourney(true));
it("stops a parked session while its viewer waits and never reattaches it", () =>
  ownerTabJourney(true, true));
it("activates a retained workspace tab after waiting for its pooled browser", () =>
  ownerTabJourney(true, false, true));

async function ownerTabJourney(restart: boolean, stopWaiting = false, activate = false) {
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-route-"));
  let runtime: BrowserRuntime | undefined;
  let browser: BrowserService | undefined;
  const allowResume = Promise.withResolvers<void>();
  try {
    const task = await fixture.createRunFixture("pool-owner-tab");
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
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        pooled: true,
        replayLedgerPath: join(root, "private", "tickets.json"),
        resolvePublicKey: (id) => (id === "test" ? tickets.publicKey : null),
      }),
      pool: { term: 1, controllerKey: controller.publicKey, probePage: async () => [] },
    });
    runtime = guest;
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
            adopt: (documents, fence, attachment) =>
              browser!.adoptPooledOwnerDocuments(
                task.userId,
                task.runnerId,
                documents,
                fence,
                attachment,
              ),
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
            loopbackPool: negotiated,
            connect: (ticket) => {
              calls.push("attach");
              return new TestRuntimeConnection(guest, ticket);
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
      const { sessionId, tabId } = await service.openTab(task.userId, command);
      const document = launched?.context.pages()[0];
      if (!document) throw new Error("The test runtime did not launch a page.");
      const cdp = await document.cdp();
      const targetId = await document.targetId();
      await cdp.send("Runtime.evaluate", {
        expression:
          "document.body.innerHTML = '<input>'; document.querySelector('input').focus(); window.marker = 99;",
      });
      await cdp.send("Input.insertText", { text: "unsent draft" });
      const original = service.pageInventory(sessionId)?.records.get(tabId);
      const tab = await tabs.get(task.userId, tabId);
      expect(tab?.pageBinding?.sessionId).toBe(sessionId);
      expect(original?.documentId).toEqual(expect.any(String));
      const early = negotiated.gate.holdOpen();
      try {
        expect(await negotiated.gate.tryPark()).toBe("vetoed");
      } finally {
        early.release();
      }
      const parking = await negotiated.gate.tryPark();
      expect(parking, JSON.stringify(guest.poolState())).toBe("parked");
      await service.close();
      const restarted = await startHome();
      expect((await store.getBrowserSessionForOwner(sessionId, task.userId))?.state).toBe("ready");
      expect(calls).toEqual(["attach", "pause"]);
      if (activate) {
        const activating = restarted.service.pageTabs.activate(task.userId, tab!);
        await Promise.race([
          resumeSeen.promise,
          activating.then(() => {
            throw new Error("The tab activated before physical resume.");
          }),
        ]);
        expect(calls).toEqual(["attach", "pause", "resume"]);
        allowResume.resolve();
        await expect(activating).resolves.toEqual({ kind: "page", sessionId, surfaceId: tabId });
        expect(restarted.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
          original?.documentId,
        );
        return;
      }
      let open = true;
      const frames: Buffer[] = [];
      const attaching = restarted.service.attach(
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
        { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
      );
      void attaching.catch(() => undefined);
      await Promise.race([
        resumeSeen.promise,
        attaching.then(() => {
          throw new Error("The viewer attached before physical resume.");
        }),
      ]);
      expect(calls).toEqual(["attach", "pause", "resume"]);
      if (stopWaiting) {
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
      const viewer = await attaching;
      try {
        await viewer.handle(
          Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
          false,
        );
        await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
        expect(await document.targetId()).toBe(targetId);
        expect(restarted.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
          original?.documentId,
        );
        expect(await restarted.negotiated.gate.tryPark()).toBe("vetoed");
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
      await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    }
  }
}
