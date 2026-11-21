import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  readBrowserPoolSlot,
  requireBrowserPoolAdmission,
  type BrowserPoolTargetIdentity,
} from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { BrowserPoolGate } from "./browser-pool-gate.js";
import {
  createLoopbackBrowserPool,
  type LoopbackPoolPhysicalState,
} from "./browser-pool-loopback.js";
import { BrowserService, type BrowserRuntimeConnection } from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";
import type { InitialPageReady } from "@opensteer/protocol";

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
  Ed25519AttachTicketVerifier,
  type BrowserAttachment,
} from "@opensteer/browser-runtime-core";
import { FakeIsolatingLauncher } from "@opensteer/browser-runtime-core/test-support";

class TestRuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 1;
  initialPage: InitialPageReady | undefined;
  private readonly attached: Promise<BrowserAttachment>;

  constructor(runtime: BrowserRuntime, ticket: string) {
    super();
    this.attached = runtime
      .attach(ticket, {
        sendFrame: async () => {},
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

it("opens a person tab through the Home after a pooled runtime resumes", async () => {
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-route-"));
  let runtime: BrowserRuntime | undefined;
  let browser: BrowserService | undefined;
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
    const launcher = new FakeIsolatingLauncher();
    const guest = new BrowserRuntime({
      runtimeId: "pool-runtime",
      launcher,
      sessionFilesRoot: join(root, "sessions"),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
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
    const negotiated = await createLoopbackBrowserPool({
      database,
      runtime: guest,
      target,
      controllerKey: controller.privateKey,
      physical: {
        status: async () => physical,
        apply: async ({ id, kind, expect: previous }) => {
          expect(previous).toEqual(physical);
          calls.push(kind);
          physical = {
            ...physical,
            phase: kind === "pause" ? "paused" : "running",
            lastOperation: id,
          };
          return physical;
        },
      },
    });
    const placement = {
      kind: "runner" as const,
      runnerId: task.runnerId,
      label: "Pooled test browser",
      runtimeId: target.runtimeId,
      environmentIds: [task.environmentId],
      available: true,
    };
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      managedPoolTestRunner: task.runnerId,
      repository: personalBrowserRepository(store),
      signer: new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey }),
      onSessionsChanged: () => {},
      targetResolver: {
        placements: () => [placement],
        resolve: () => ({
          runtimeId: target.runtimeId,
          placementKey: "pool-test",
          main: true,
          loopbackPool: negotiated,
          connect: (ticket) => {
            calls.push("attach");
            return new TestRuntimeConnection(guest, ticket);
          },
        }),
      },
    });
    browser = service;
    expect(await negotiated.gate.tryPark()).toBe("parked");
    expect(calls).toEqual(["pause"]);
    await expect(
      service.openTab(task.userId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId: task.runnerId },
        idempotencyKey: "after-wake",
      }),
    ).resolves.toMatchObject({ tabId: expect.any(String) });
    expect(calls).toEqual(["pause", "resume", "attach"]);
    expect(await readBrowserPoolSlot(database, task.runnerId)).toMatchObject({
      phase: "running",
      epoch: 2,
    });
    expect(await store.getBrowserTabOpen(task.userId, "after-wake")).toMatchObject({
      outcome: { kind: "opened" },
    });
  } finally {
    try {
      await browser?.close();
      await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    }
  }
});
