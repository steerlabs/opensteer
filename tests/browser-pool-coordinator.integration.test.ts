import { randomUUID } from "node:crypto";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { expect, it, vi } from "vitest";
import {
  BrowserPoolCoordinator,
  type BrowserPoolAdopter,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import type {
  BrowserPoolControllerCall,
  BrowserPoolPhysicalController,
} from "../apps/host/src/browser/browser-pool-controller.js";
import { FakeBrowserPoolController } from "../apps/host/src/browser/browser-pool-controller.test-support.js";
import { type BrowserPoolControl } from "../packages/browser-runtime-core/src/browser-pool.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import {
  BrowserPoolAdmissionClosed,
  beginBrowserPoolPark,
  settleBrowserPoolControllerCall,
  browserPoolSlotIdentity,
  listBrowserPoolDocumentLosses,
  readBrowserPoolSlot,
  listBrowserPoolReadySessions,
  requireBrowserPoolAdmission,
} from "../packages/database/src/browser-pool-store.js";
import {
  createBrowserSession,
  getBrowserSessionForOwner,
  transitionBrowserSession,
} from "../packages/database/src/browser-session-store.js";
import { commitPersonalMutation } from "../packages/database/src/personal-mutation.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import { BrowserSessionIdSchema, type BrowserSessionId } from "../packages/protocol/src/browser.js";

type RuntimeKind = BrowserPoolControl["kind"];

/** Hangs every call from the first match on, as a Home process that died there would. */
class Crash {
  #armed: { kind: string; when: "before" | "after" } | undefined;
  dead = false;
  arm(kind: string, when: "before" | "after") {
    this.#armed = { kind, when };
  }
  async pass<T>(kind: string, call: () => Promise<T>): Promise<T> {
    if (this.dead) return new Promise<T>(() => {});
    if (this.#armed?.kind === kind && this.#armed.when === "before") {
      this.dead = true;
      return new Promise<T>(() => {});
    }
    const result = await call();
    if (this.#armed?.kind === kind) {
      this.dead = true;
      return new Promise<T>(() => {});
    }
    return result;
  }
}

async function poolFixture(
  key: string,
  options: {
    adoptionWindowMs?: number;
    now?: () => number;
    /** Each start the controller applies brings a new, uninstalled runtime, as a new guest. */
    freshGuests?: boolean;
    /** The runtime's page probe during a retire; a retire waits for it. */
    probePage?: (page: unknown, phase: "active" | "frozen") => Promise<readonly string[]>;
  } = {},
) {
  const fixture = await createStoreFixture();
  const task = await fixture.createRunFixture(key);
  const { database } = fixture;
  const controller = new FakeBrowserPoolController({
    slotId: `slot-${key}`,
    term: 1,
    ...(options.now ? { now: options.now } : {}),
    ...(options.freshGuests ? { freshGuests: true } : {}),
    // The loopback runtime outlives a start: the controller sees what it holds.
    guest: () => runtime.poolState()?.fence ?? null,
  });
  const page = new FakePage();
  const verifier = new FakeTicketVerifier();
  const newRuntime = () =>
    new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
      runtimeId: "pool-runtime",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
      pool: {
        controllerKey: controller.publicKey,
        probePage: options.probePage ?? (async () => []),
        ...(options.adoptionWindowMs ? { adoptionWindowMs: options.adoptionWindowMs } : {}),
      },
    });
  let runtime = newRuntime();
  if (options.freshGuests) {
    const apply = controller.apply.bind(controller);
    controller.apply = async (call) => {
      const result = await apply(call);
      if (call.kind === "start" && result.applied) {
        const old = runtime;
        runtime = newRuntime();
        await old.shutdown().catch(() => undefined);
      }
      return result;
    };
  }
  const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
  const claims = freshClaims({
    sessionId,
    actor: "person",
    tabRestoreVersion: 1,
    runtimeId: "pool-runtime",
  });
  const sinks = new Map<BrowserSessionId, Awaited<ReturnType<BrowserRuntime["attach"]>>>();
  const runtimeFaults: { kind: RuntimeKind; fault: "request" | "reply" }[] = [];
  const skip = new Set<BrowserSessionId>();
  const surfaces = new Set<string>();
  let tabLoss: BrowserSessionId | undefined;
  let stalled: Promise<void> | undefined;
  let unexpected: { sessionId: BrowserSessionId; surfaceId: string } | undefined;
  const adopter: BrowserPoolAdopter = {
    inventory: () => (unexpected ? [unexpected] : []),
    live: (id) => sinks.has(id),
    // As the Home's: the ready sessions of the runtime with no channel here.
    pagesOf: async (id) => (id === sessionId ? [...surfaces] : []),
    withoutChannel: async (runtimeId) =>
      (await listBrowserPoolReadySessions(database, task.runnerId, runtimeId)).filter(
        (id) => !sinks.has(id),
      ),
    // As the Home's before a restart: every channel of the runtime is closed, its row kept.
    quiesce: async () => {
      for (const attachment of sinks.values()) await attachment.close().catch(() => undefined);
      sinks.clear();
    },
    reattach: async ({ sessions, fence, attempt, documents, signal }) => {
      // A stall ends when the attempt's own signal does: nothing is left running after it.
      if (stalled)
        await Promise.race([
          stalled,
          new Promise<void>((resolve) =>
            signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve()),
          ),
        ]);
      if (signal?.aborted) return [];
      for (const id of sessions) {
        if (skip.has(id)) continue;
        const name = `reattach-${id}-${attempt}`;
        verifier.setClaims(name, {
          ...claims,
          sessionId: id,
          reattach: true,
          initialNavigation: undefined,
          pool: { ...fence, attachment: attempt },
        });
        sinks.set(id, await runtime.attach(name, new FakeSink()));
      }
      return tabLoss
        ? [
            {
              sessionId: tabLoss,
              reason: "document-changed",
              surfaces: documents.map(({ surfaceId, documentId }) => ({ surfaceId, documentId })),
              endSession: false,
            },
          ]
        : [];
    },
  };
  const homes: BrowserPoolCoordinator[] = [];
  const home = (
    crash?: Crash,
    physical: BrowserPoolPhysicalController = controller,
    extra: Partial<ConstructorParameters<typeof BrowserPoolCoordinator>[0]> = {},
  ) => {
    const channel: BrowserPoolRuntimeChannel = {
      poolState: () => runtime.poolState(),
      controlPool: (control, signature) =>
        crash
          ? crash.pass(`runtime:${control.kind}`, () => runtime.controlPool(control, signature))
          : runtime.controlPool(control, signature),
    };
    const port: BrowserPoolPhysicalController = crash
      ? {
          status: (slot, term) => crash.pass("status", () => physical.status(slot, term)),
          result: (slot, term, id) => crash.pass("result", () => physical.result(slot, term, id)),
          apply: (call: BrowserPoolControllerCall) =>
            crash.pass(call.kind === "sign" ? `sign:${call.control!.kind}` : call.kind, () =>
              physical.apply(call),
            ),
        }
      : physical;
    const coordinator = new BrowserPoolCoordinator({
      database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: `slot-${key}`,
      term: 1,
      runtime: channel,
      controller: port,
      retryMs: 5,
      ...extra,
      runtimeFault: (kind) => {
        const index = runtimeFaults.findIndex((entry) => entry.kind === kind);
        return index < 0 ? undefined : runtimeFaults.splice(index, 1)[0]!.fault;
      },
    });
    coordinator.setAdopter(adopter);
    homes.push(coordinator);
    return coordinator;
  };
  const openSession = async (coordinator: BrowserPoolCoordinator, id = sessionId) => {
    await createBrowserSession(database, {
      id,
      ownerId: task.userId,
      opener: { kind: "person", userId: task.userId },
      placementKey: "pool-test",
      runnerId: task.runnerId,
      origin: "person",
      profileId: null,
      runtimeId: "pool-runtime",
      pooled: true,
    });
    await transitionBrowserSession(database, { sessionId: id, state: "ready" });
    verifier.setClaims(`open-${id}`, { ...claims, sessionId: id, pool: coordinator.fence() });
    const sink = new FakeSink();
    const attachment = await runtime.attach(`open-${id}`, sink);
    if (id === sessionId) for (const surface of sink.tabs.rows.keys()) surfaces.add(surface);
    await attachment.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    sinks.set(id, attachment);
  };
  const row = (id = sessionId) => getBrowserSessionForOwner(database, id, task.userId);
  const slot = () => readBrowserPoolSlot(database, task.runnerId);
  const admitted = () =>
    commitPersonalMutation(database, async (tx) => {
      const current = await readBrowserPoolSlot(tx, task.runnerId);
      await requireBrowserPoolAdmission(
        tx,
        task.runnerId,
        current ? browserPoolSlotIdentity(current) : undefined,
      );
    });
  const signed = async (control: Omit<BrowserPoolControl, "sequence" | "expect">) => {
    const status = await controller.status(`slot-${key}`, 1);
    const result = await controller.apply({
      id: randomUUID(),
      slotId: `slot-${key}`,
      term: 1,
      kind: "sign",
      expect: {
        instance: status.instance,
        epoch: status.epoch,
        phase: status.phase,
        savedStateId: status.savedState?.id ?? null,
      },
      control,
    });
    expect(Buffer.from(result.signature!, "base64").equals(Buffer.alloc(64))).toBe(false);
    return runtime.controlPool(result.control!, Buffer.from(result.signature!, "base64"));
  };
  const crashSockets = async () => {
    for (const attachment of sinks.values()) await attachment.close().catch(() => undefined);
    sinks.clear();
  };
  const close = async () => {
    for (const coordinator of homes) coordinator.close();
    await runtime.shutdown();
    await fixture.close();
  };
  return {
    fixture,
    task,
    database,
    controller,
    get runtime() {
      return runtime;
    },
    page,
    sessionId,
    home,
    openSession,
    sinks,
    row,
    slot,
    admitted,
    signed,
    runtimeFaults,
    skip,
    crashSockets,
    setUnexpected: (value: typeof unexpected) => {
      unexpected = value;
    },
    reportTabLoss: (value: BrowserSessionId | undefined) => {
      tabLoss = value;
    },
    /** Every reattach waits for this, as one that stalls on the way to the runtime. */
    stallReattach: (until: Promise<void> | undefined) => {
      stalled = until;
    },
    /** The Runner's channel drops: the guest keeps the session detached. */
    loseChannel: async (id: BrowserSessionId = sessionId) => {
      await sinks.get(id)?.close(false, false, true);
      sinks.delete(id);
    },
    close,
  };
}

async function parkAndWake(f: Awaited<ReturnType<typeof poolFixture>>, home = f.home()) {
  expect(await home.tryPark()).toBe("parked");
  expect(await f.slot()).toMatchObject({ phase: "parked" });
  const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
  woken.release();
  return home;
}

it("lets a removal asked while a wake's reattach never answers go first, and nothing of the wake acts after it", async () => {
  const f = await poolFixture("wake-stall-removal");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const never = Promise.withResolvers<void>();
    f.stallReattach(never.promise);
    const waking = home.gate.reserve(AbortSignal.timeout(30_000)).then(
      (reservation) => {
        reservation.release();
        return "admitted";
      },
      () => "refused",
    );
    // The wake resumed the guest and waits on a reattach that never answers.
    await vi.waitFor(() => expect(f.runtime.poolState()?.phase).toBe("adopting"));
    const woken = [...f.controller.effects];
    expect(woken).toEqual(["start", "pause", "resume"]);
    const attached = [...f.sinks.values()];
    const removed = home.releaseDevice();
    await withTimeout(Promise.all([removed, home.released()]), 10_000, {
      timeoutError: () => new Error("The removal waited behind the wake."),
    });
    expect(await waking).toBe("refused");
    expect(f.controller.effects).toEqual([...woken, "stop"]);
    expect(await f.slot()).toBeUndefined();
    expect(home.gate.phase).toBe("released");
    // The stalled reattach ends: nothing of the wake attaches or calls the controller after.
    never.resolve();
    await Promise.resolve();
    expect([...f.sinks.values()]).toEqual(attached);
    expect(f.controller.effects).toEqual([...woken, "stop"]);
    expect((await f.row())?.state).toBe("failed");
  } finally {
    await f.close();
  }
});

it("starts again after an install that never reached the runtime, and installs the next one", async () => {
  const f = await poolFixture("install-lost");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    // The restart's install is lost on its way: the runtime still holds the first fence.
    f.runtimeFaults.push({ kind: "install", fault: "request" });
    await withTimeout(home.restart(), 10_000, {
      timeoutError: () => new Error("The restart is wedged on the lost install."),
    });
    const status = await f.controller.status("slot-install-lost", 1);
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      fence: { slot: "slot-install-lost", term: 1, instance: status.instance, epoch: 1 },
    });
    expect(f.controller.effects).toEqual(["start", "stop", "start", "stop", "start"]);
    expect(await f.slot()).toMatchObject({ phase: "running", instanceId: status.instance });
    await f.admitted();
  } finally {
    await f.close();
  }
});

it("installs the controller's fence before any traffic and never reads it from the guest", async () => {
  const f = await poolFixture("install");
  try {
    expect(f.runtime.poolState()).toMatchObject({ phase: "uninstalled" });
    await expect(f.admitted()).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
    const home = f.home();
    await home.recover();
    const status = await f.controller.status("slot-install", 1);
    expect(f.runtime.poolState()?.fence).toEqual({
      slot: "slot-install",
      term: 1,
      instance: status.instance,
      epoch: 1,
    });
    expect(status.instance).not.toBe(f.runtime.standardCdpBootId);
    expect(await f.slot()).toMatchObject({ phase: "running", instanceId: status.instance });
    expect(f.controller.effects).toEqual(["start"]);
    await f.admitted();
  } finally {
    await f.close();
  }
});

for (const field of ["slotId", "term"] as const)
  it(`replaces a guest whose ${field} differs from the slot's, with the same instance and epoch`, async () => {
    const f = await poolFixture(`fence-${field}`);
    try {
      const before = f.home();
      await before.recover();
      await f.openSession(before);
      before.close();
      const first = await f.controller.status(`slot-fence-${field}`, 1);
      // The durable row names another slot or term; the instance and epoch still match.
      await f.database
        .updateTable("browserPoolSlots")
        .set(field === "slotId" ? { slotId: "slot-elsewhere" } : { term: 2 })
        .where("runnerId", "=", f.task.runnerId)
        .execute();
      const home = f.home();
      await home.recover();
      // Not the controller's whole fence: never kept, the guest is replaced and named again.
      const now = await f.controller.status(`slot-fence-${field}`, 1);
      expect(f.controller.effects).toEqual(["start", "stop", "start"]);
      expect(now.instance).not.toBe(first.instance);
      expect(await f.slot()).toMatchObject({
        phase: "running",
        slotId: `slot-fence-${field}`,
        term: 1,
        instanceId: now.instance,
        epoch: now.epoch,
      });
      expect(f.runtime.poolState()?.fence).toEqual({
        slot: `slot-fence-${field}`,
        term: 1,
        instance: now.instance,
        epoch: now.epoch,
      });
      expect((await f.row())?.state).toBe("failed");
      expect(home.gate.phase).toBe("open");
    } finally {
      await f.close();
    }
  });

it("bootstraps a Home without its slot row by replacing whatever guest runs, with the controller's fence", async () => {
  const f = await poolFixture("bootstrap");
  try {
    const first = f.home();
    await first.recover();
    await f.openSession(first);
    first.close();
    const dropRow = () =>
      f.database.deleteFrom("browserPoolSlots").where("runnerId", "=", f.task.runnerId).execute();
    const installed = async () => {
      const now = await f.controller.status("slot-bootstrap", 1);
      const fence = { slot: "slot-bootstrap", term: 1, instance: now.instance, epoch: now.epoch };
      expect(f.runtime.poolState()?.fence).toEqual(fence);
      expect(await f.slot()).toMatchObject({
        phase: "running",
        slotId: "slot-bootstrap",
        term: 1,
        instanceId: now.instance,
        epoch: now.epoch,
      });
      return now.instance;
    };
    const before = (await f.controller.status("slot-bootstrap", 1)).instance;
    // Without a row nothing could own a page in the running guest, even one whose whole fence is
    // the controller's: it is stopped and a fresh one started.
    await dropRow();
    await f.home().recover();
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    const second = await installed();
    expect(second).not.toBe(before);
    expect(f.page.isClosed()).toBe(true);
    // The same with a controller on an epoch the guest does not carry.
    await dropRow();
    f.controller.observe({ epoch: 5 });
    await f.home().recover();
    expect(f.controller.effects).toEqual(["start", "stop", "start", "stop", "start"]);
    expect(await installed()).not.toBe(second);
    await f.admitted();
  } finally {
    await f.close();
  }
});

for (const kind of ["sign:retire", "sign:seal", "pause", "resume", "sign:complete"] as const)
  for (const fault of ["request", "reply", "duplicate"] as const)
    it(`parks and wakes once when the controller's ${kind} suffers a ${fault} loss`, async () => {
      const f = await poolFixture(`${kind}-${fault}`.replace(":", "-"));
      try {
        const home = f.home();
        await home.recover();
        await f.openSession(home);
        f.controller.inject(kind, fault);
        await parkAndWake(f, home);
        expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
        expect(await f.slot()).toMatchObject({
          phase: "running",
          epoch: 2,
          outcome: { adopted: [f.sessionId], lost: [] },
        });
        expect((await f.row())?.state).toBe("ready");
        expect(f.page.isClosed()).toBe(false);
        await f.admitted();
      } finally {
        await f.close();
      }
    });

for (const kind of ["retire", "seal", "adopt", "complete", "release"] as const)
  for (const fault of ["request", "reply"] as const)
    it(`reaches an open gate when the runtime's ${kind} ${fault} is lost`, async () => {
      const f = await poolFixture(`runtime-${kind}-${fault}`);
      try {
        const home = f.home();
        await home.recover();
        await f.openSession(home);
        f.runtimeFaults.push({ kind, fault });
        if (kind === "release") {
          // A release happens on an abort: an unexpected drop forces one.
          f.setUnexpected({ sessionId: f.sessionId, surfaceId: "bsf_missing" });
          expect(await home.tryPark()).toBe("vetoed");
          f.setUnexpected(undefined);
          expect(f.runtime.poolState()).toMatchObject({ phase: "running", cancelled: true });
        } else if (kind === "retire" && fault === "request") {
          // The retire never arrived: the park is released by a tombstone, and the next one parks.
          expect(await home.tryPark()).toBe("vetoed");
          await expect(
            f.signed({
              kind: "retire",
              fence: f.runtime.poolState()!.fence!,
              intent: f.runtime.poolState()!.intent!,
            }),
          ).rejects.toThrow("cancelled");
          await parkAndWake(f, home);
        } else if (kind === "retire") {
          // Rule D: the runtime did retire, but its reply was lost: release, reattach, open.
          expect(await home.tryPark()).toBe("vetoed");
          expect(f.runtime.poolState()).toMatchObject({
            phase: "running",
            cancelled: true,
            adoption: { cause: "release", outcome: { adopted: [f.sessionId], lost: [] } },
          });
          expect(f.controller.effects).toEqual(["start"]);
          await parkAndWake(f, home);
        } else {
          await parkAndWake(f, home);
        }
        expect(home.gate.phase).toBe("open");
        expect((await f.row())?.state).toBe("ready");
        expect(f.page.isClosed()).toBe(false);
        await f.admitted();
        expect(f.controller.effects.filter((effect) => effect === "pause").length).toBe(
          f.controller.effects.filter((effect) => effect === "resume").length,
        );
      } finally {
        await f.close();
      }
    });

// A crash while the runtime still runs, or after it finished adoption, closes the old Home's
// channels like any Home restart does, and those sessions end with a note. Every other point
// keeps the retained session for the next Home.
const crashes = [
  ["runtime:retire", "before", "failed"],
  ["runtime:retire", "after", "ready"],
  ["runtime:seal", "after", "ready"],
  ["pause", "before", "ready"],
  ["pause", "after", "ready"],
  ["resume", "before", "ready"],
  ["resume", "after", "ready"],
  ["runtime:adopt", "after", "ready"],
  ["runtime:complete", "after", "failed"],
] as const;
for (const [point, when, ends] of crashes)
  it(`continues the same attempt after a Home crash ${when} ${point}`, async () => {
    const f = await poolFixture(`crash-${point}-${when}`.replace(":", "-"));
    try {
      const first = f.home();
      await first.recover();
      await f.openSession(first);
      first.close();
      const crash = new Crash();
      const dying = f.home(crash);
      await dying.recover();
      crash.arm(point, when);
      // A park, and a wake once it is parked: the Home dies at the armed point of either.
      void dying
        .tryPark()
        .then((parked) =>
          parked === "parked" ? dying.gate.reserve(AbortSignal.timeout(10_000)) : undefined,
        )
        .catch(() => undefined);
      await vi.waitFor(() => expect(crash.dead).toBe(true));
      dying.close();
      // The old process's sockets close with it.
      await f.crashSockets();
      // A session the crash left without a channel gets the reconnect window, then ends with its
      // note: a short window here.
      const next = f.home(undefined, f.controller, { channelDeadlineMs: 300 });
      await next.recover();
      if (ends === "failed")
        await vi.waitFor(
          async () => {
            expect((await f.row())?.state).toBe("failed");
            expect(next.gate.phase).not.toBe("reconnecting");
          },
          { timeout: 5_000 },
        );
      expect(["open", "parked"]).toContain(next.gate.phase);
      if (next.gate.phase === "parked") {
        const woken = await next.gate.reserve(AbortSignal.timeout(10_000));
        woken.release();
      }
      expect(next.gate.phase).toBe("open");
      const current = await f.slot();
      expect(current?.phase).toBe("running");
      expect(f.controller.effects.filter((effect) => effect === "pause").length).toBeLessThan(2);
      expect(f.controller.effects.filter((effect) => effect === "resume").length).toBeLessThan(2);
      expect(f.runtime.poolState()?.phase).toBe("running");
      // Every outcome is said: the session is adopted, or it ended with a note.
      expect((await f.row())?.state).toBe(ends);
      expect(f.page.isClosed()).toBe(ends === "failed");
      if (ends === "failed")
        expect(
          await f.database
            .selectFrom("browserPoolDocumentLosses")
            .select("sessionId")
            .where("sessionId", "=", f.sessionId)
            .execute(),
        ).toEqual(expect.arrayContaining([{ sessionId: f.sessionId }]));
      await f.admitted();
      expect(await next.tryPark()).toMatch(/parked|vetoed/);
    } finally {
      await f.close();
    }
  });

it("aborts a park whose retire missed a page the Home knows, and the pages stay usable", async () => {
  const f = await poolFixture("unexpected-drop");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    f.setUnexpected({
      sessionId: f.sessionId,
      surfaceId: "bsf_00000000-0000-4000-8000-00000000dead",
    });
    expect(await home.tryPark()).toBe("vetoed");
    f.setUnexpected(undefined);
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      cancelled: true,
      adoption: { cause: "release", outcome: { adopted: [f.sessionId], lost: [] } },
    });
    expect(f.controller.effects).toEqual(["start"]);
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 1 });
    expect(home.gate.phase).toBe("open");
    await parkAndWake(f, home);
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("recovers a retire that threw by release and adoption, then parks again", async () => {
  const f = await poolFixture("retire-throws");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    const original = f.runtime.controlPool.bind(f.runtime);
    let failRetire = true;
    // The retire's channel close throws after the session was detached.
    (f.runtime as { controlPool: BrowserRuntime["controlPool"] }).controlPool = async (
      control,
      signature,
    ) => {
      if (control.kind === "retire" && failRetire) {
        failRetire = false;
        const sessions = (f.runtime as unknown as { sessions: Map<string, unknown> }).sessions;
        const session = sessions.get(f.sessionId) as {
          controller: { detachForPool: () => Promise<void> };
        };
        const detach = session.controller.detachForPool.bind(session.controller);
        session.controller.detachForPool = async () => {
          await detach();
          throw new Error("The channel close failed");
        };
      }
      return original(control, signature);
    };
    expect(await home.tryPark()).toBe("vetoed");
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      adoption: { cause: "release", outcome: { adopted: [f.sessionId] } },
    });
    expect(home.gate.phase).toBe("open");
    await parkAndWake(f, home);
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.close();
  }
});

it("notes a page a vetoed retire could not thaw as its own loss, and keeps its session", async () => {
  // The frozen probe finds a blocker, so the retire thaws its pages and is vetoed.
  const f = await poolFixture("veto-thaw", {
    probePage: async (_page, phase) => (phase === "frozen" ? ["busy"] : []),
  });
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    // Chromium refuses to thaw the page.
    f.page.cdpSession.responses.set(
      "Page.setWebLifecycleState",
      (parameters: Record<string, unknown> | undefined) => {
        if (parameters?.state === "active") throw new Error("The page cannot be thawed.");
        return {};
      },
    );
    expect(await home.tryPark()).toBe("vetoed");
    // Never left frozen as usable: the page is closed, and it is a loss with its note.
    expect(f.page.isClosed()).toBe(true);
    expect(
      await f.database
        .selectFrom("browserPoolDocumentLosses")
        .select(["sessionId", "reason"])
        .where("sessionId", "=", f.sessionId)
        .execute(),
    ).toEqual([{ sessionId: f.sessionId, reason: "thaw-failed" }]);
    expect((await f.row())?.state).toBe("ready");
    expect(home.gate.phase).toBe("open");
  } finally {
    await f.close();
  }
});

/** The fake, except that the first call of `kind` is refused after its work was undone. */
function refusing(
  f: Awaited<ReturnType<typeof poolFixture>>,
  kind: "resume" | "start",
): BrowserPoolPhysicalController & { refused: number } {
  const port = {
    refused: 0,
    status: (slot: string, term: number) => f.controller.status(slot, term),
    result: (slot: string, term: number, id: string) => f.controller.result(slot, term, id),
    apply: async (call: BrowserPoolControllerCall) => {
      if (call.kind === kind && port.refused === 0) {
        port.refused++;
        // The guest is stopped now, whatever the call asked for.
        f.controller.observe({ phase: "stopped", savedState: null });
        return {
          id: call.id,
          applied: false,
          reason: "undone",
          status: await f.controller.status(call.slotId, call.term),
        };
      }
      return f.controller.apply(call);
    },
  };
  return port;
}

it("reads the state a refused resume returns: the stopped guest is replaced, the session ended", async () => {
  const f = await poolFixture("refused-resume");
  try {
    const port = refusing(f, "resume");
    const home = f.home(undefined, port);
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect(port.refused).toBe(1);
    // Nothing assumed the guest was still paused: no stop of a stopped guest, a fresh start.
    expect(f.controller.effects).toEqual(["start", "pause", "start"]);
    expect(home.gate.phase).toBe("open");
    expect((await f.row())?.state).toBe("failed");
    expect(await f.slot()).toMatchObject({ phase: "running" });
  } finally {
    await f.close();
  }
});

it("reads the state a refused start returns, and starts again from the stopped guest", async () => {
  const f = await poolFixture("refused-start");
  try {
    const port = refusing(f, "start");
    const home = f.home(undefined, port);
    await home.recover();
    expect(port.refused).toBe(1);
    expect(f.controller.effects).toEqual(["start"]);
    expect(home.gate.phase).toBe("open");
    const status = await f.controller.status("slot-refused-start", 1);
    expect(await f.slot()).toMatchObject({ phase: "running", instanceId: status.instance });
    await f.admitted();
  } finally {
    await f.close();
  }
});

for (const asked of ["removal", "restart"] as const)
  it(`holds admission when a ${asked} is asked while a park is in flight`, async () => {
    const f = await poolFixture(`park-then-${asked}`);
    try {
      const home = f.home();
      await home.recover();
      await f.openSession(home);
      const pausing = Promise.withResolvers<void>();
      const pause = Promise.withResolvers<void>();
      f.controller.hold("pause", async () => {
        pausing.resolve();
        await pause.promise;
      });
      const parking = home.tryPark();
      await pausing.promise;
      const done = asked === "removal" ? home.releaseDevice() : home.restart();
      // A waiter with demand arrives meanwhile.
      const waiting = home.gate.reserve(AbortSignal.timeout(10_000)).then(
        (held) => {
          held.release();
          return "admitted" as const;
        },
        (error: unknown) => (error instanceof Error ? error.message : "refused"),
      );
      pause.resolve();
      // A restart lets the park finish and report where the browser is; a removal goes first and
      // ends it, so it did not park. Either way it admits nothing.
      expect(await parking).toBe(asked === "removal" ? "vetoed" : "parked");
      expect(home.gate.phase).toBe(asked === "removal" ? "released" : "restarting");
      expect(home.gate.held).toBe(0);
      await done;
      if (asked === "removal") {
        await home.released();
        expect(await waiting).toContain("removed");
        expect(home.gate.phase).toBe("released");
        expect(await home.tryPark()).toBe("vetoed");
        expect(f.controller.effects).toEqual(["start", "pause", "stop"]);
      } else {
        // Only the restart's fresh guest admits the waiter; the parked guest was never woken.
        expect(await waiting).toBe("admitted");
        expect(home.gate.phase).toBe("open");
        expect(f.controller.effects).toEqual(["start", "pause", "stop", "start"]);
      }
    } finally {
      await f.close();
    }
  });

it("recovers a runtime found retiring at a Home restart as not parked", async () => {
  // The retire's page probe waits here, so the runtime is still retiring when the Home restarts.
  let probing = Promise.withResolvers<void>();
  let blocked = false;
  const f = await poolFixture("found-retiring", {
    probePage: async () => {
      if (blocked) await probing.promise;
      return [];
    },
  });
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    const slot = await f.slot();
    const intent = await beginBrowserPoolPark(
      f.database,
      browserPoolSlotIdentity(slot!),
      randomUUID(),
      () => false,
    );
    blocked = true;
    const retiring = f
      .signed({
        kind: "retire",
        fence: f.runtime.poolState()!.fence!,
        intent: { id: intent!.intentId!, sequence: intent!.intentSequence },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.runtime.poolState()?.phase).toBe("retiring"));
    home.close();
    const seen: string[] = [];
    const next = f.home(undefined, f.controller, {
      runtime: {
        poolState: () => {
          const state = f.runtime.poolState();
          if (state) seen.push(state.phase);
          return state;
        },
        controlPool: (control, signature) => f.runtime.controlPool(control, signature),
      },
    });
    const recovering = next.recover();
    // The new Home found it retiring; only then may the probe finish.
    await vi.waitFor(() => expect(seen).toContain("retiring"));
    blocked = false;
    probing.resolve();
    probing = Promise.withResolvers<void>();
    await recovering;
    await retiring;
    expect(next.gate.phase).toBe("open");
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 1 });
    expect(f.runtime.poolState()).toMatchObject({ phase: "running", cancelled: true });
    expect(f.controller.effects).toEqual(["start"]);
    expect((await f.row())?.state).toBe("ready");
    expect(f.page.isClosed()).toBe(false);
  } finally {
    probing.resolve();
    await f.close();
  }
});

it("records an adoption the runtime ended at its window while the Home was gone", async () => {
  const f = await poolFixture("window", { adoptionWindowMs: 200 });
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    home.close();
    const crash = new Crash();
    const dying = f.home(crash);
    await dying.recover();
    expect(dying.gate.phase).toBe("parked");
    crash.arm("runtime:adopt", "after");
    void dying.gate.reserve(AbortSignal.timeout(10_000)).catch(() => undefined);
    // The Home died just after adopt; the runtime ends the adoption at its window by itself.
    await vi.waitFor(() => expect(f.runtime.poolState()?.phase).toBe("running"));
    dying.close();
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      adoption: {
        outcome: { lost: [{ sessionId: f.sessionId, reason: "adoption-window-expired" }] },
      },
    });
    const next = f.home();
    await next.recover();
    expect(next.gate.phase).toBe("open");
    expect(await f.slot()).toMatchObject({
      phase: "running",
      epoch: 2,
      outcome: { adopted: [], lost: [{ sessionId: f.sessionId }] },
    });
    expect((await f.row())?.state).toBe("failed");
    expect(f.page.isClosed()).toBe(true);
  } finally {
    await f.close();
  }
});

it("discards live state and opens when the saved state expired, and says what was lost", async () => {
  const f = await poolFixture("expired");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    f.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect(f.controller.effects).toEqual(["start", "pause", "start"]);
    const status = await f.controller.status("slot-expired", 1);
    expect(await f.slot()).toMatchObject({
      phase: "running",
      instanceId: status.instance,
      epoch: 1,
      outcome: {
        adopted: [],
        lost: [{ sessionId: f.sessionId, reason: "live-state-unavailable" }],
      },
    });
    expect((await f.row())?.state).toBe("failed");
    expect(f.page.isClosed()).toBe(true);
    const losses = await listBrowserPoolDocumentLosses(
      f.database,
      f.task.userId,
      (await f.slot())!.retained
        ? ((await f.slot())!.retained as { documents: { surfaceId: never }[] }).documents[0]!
            .surfaceId
        : (null as never),
    );
    expect(losses).toMatchObject([{ sessionId: f.sessionId, reason: "live-state-unavailable" }]);
    await f.admitted();
  } finally {
    await f.close();
  }
});

/** The park's manifest says each page held typed text that was not sent. */
async function parkedTyped(f: Awaited<ReturnType<typeof poolFixture>>) {
  const parked = (await f.slot())!;
  const documents = (parked.retained as { documents: { surfaceId: string }[] }).documents;
  await f.database
    .updateTable("browserPoolSlots")
    .set({
      retained: {
        ...(parked.retained as object),
        documents: documents.map((document) => ({ ...document, typed: true })),
      },
    })
    .where("runnerId", "=", parked.runnerId)
    .execute();
  return documents[0]!.surfaceId as never;
}

it("records with each loss whether its page held unsent typed text, as known when the loss is written", async () => {
  const f = await poolFixture("typed-loss");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const surfaceId = await parkedTyped(f);
    // The saved state expired: the page is lost, and its note says typed text went with it.
    f.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    (await home.gate.reserve(AbortSignal.timeout(10_000))).release();
    expect(f.controller.effects).toEqual(["start", "pause", "start"]);
    expect(await listBrowserPoolDocumentLosses(f.database, f.task.userId, surfaceId)).toEqual([
      expect.objectContaining({ reason: "live-state-unavailable", typed: true }),
    ]);
  } finally {
    await f.close();
  }
});

it("claims nothing typed for a page a restart of the running browser loses after an earlier park", async () => {
  const f = await poolFixture("typed-stale");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const surfaceId = await parkedTyped(f);
    // Woken and adopted: that park's manifest is no longer what is so.
    (await home.gate.reserve(AbortSignal.timeout(10_000))).release();
    expect((await f.row())?.state).toBe("ready");
    await home.restart();
    expect((await f.row())?.state).toBe("failed");
    expect(await listBrowserPoolDocumentLosses(f.database, f.task.userId, surfaceId)).toEqual([
      expect.objectContaining({ reason: "person", typed: false }),
    ]);
  } finally {
    await f.close();
  }
});

it("refuses a late retire after an abort and parks on the next attempt", async () => {
  const f = await poolFixture("late-retire");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    const slot = await f.slot();
    const intent = await beginBrowserPoolPark(
      f.database,
      browserPoolSlotIdentity(slot!),
      randomUUID(),
      () => false,
    );
    home.close();
    const next = f.home();
    await next.recover();
    expect(f.runtime.poolState()).toMatchObject({ phase: "running", cancelled: true });
    const late: Omit<BrowserPoolControl, "sequence" | "expect"> = {
      kind: "retire",
      fence: f.runtime.poolState()!.fence!,
      intent: { id: intent!.intentId!, sequence: intent!.intentSequence },
    };
    await expect(f.signed(late)).rejects.toThrow("cancelled");
    await parkAndWake(f, next);
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("keeps admission closed when the park intent's commit and its read-back fail, until the intent is known", async () => {
  const f = await poolFixture("commit-unknown");
  try {
    let reads = 0;
    let readingBack = false;
    const home = f.home(undefined, f.controller, {
      testHooks: {
        beginPark: async (...args) => {
          await beginBrowserPoolPark(...args);
          readingBack = true;
          throw new Error("The COMMIT reply was lost.");
        },
        readSlot: async (...args) => {
          // The first two read-backs fail too; admission stays closed meanwhile.
          if (readingBack) {
            if (++reads <= 2) throw new Error("The read-back failed.");
            readingBack = false;
          }
          return readBrowserPoolSlot(...args);
        },
      },
    });
    await home.recover();
    await f.openSession(home);
    const parking = home.tryPark();
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(home.gate.phase).not.toBe("open");
    expect(await parking).toBe("parked");
    expect(reads).toBe(3);
    expect(await f.slot()).toMatchObject({ phase: "parked" });
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("settles a controller call that never answers by its id, and is not held behind it", async () => {
  const f = await poolFixture("hung-call");
  try {
    const home = f.home(undefined, f.controller, { callTimeoutMs: 200 });
    await home.recover();
    await f.openSession(home);
    // The first pause request never returns; the deadline reads its outcome by id instead.
    f.controller.hold("pause", () => new Promise(() => {}));
    expect(await home.tryPark()).toBe("parked");
    expect(f.controller.effects).toEqual(["start", "pause"]);
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
  } finally {
    await f.close();
  }
});

it("never replaces a resumed guest when the resume's journal acknowledgement failed", async () => {
  const f = await poolFixture("resume-ack");
  try {
    let failed = false;
    const home = f.home(undefined, f.controller, {
      testHooks: {
        settleCall: async (id, result) => {
          const call = await f.database
            .selectFrom("browserPoolControllerCalls")
            .select("kind")
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
          if (call.kind === "resume" && !failed) {
            failed = true;
            throw new Error("The journal write failed after the resume applied.");
          }
          await settleBrowserPoolControllerCall(f.database, id, result);
        },
      },
    });
    await home.recover();
    await f.openSession(home);
    await parkAndWake(f, home);
    expect(failed).toBe(true);
    // Settled live by the same id: no discard, no fresh start, the same session adopted.
    expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("writes every controller call's journal row before the call is sent", async () => {
  const f = await poolFixture("journal-first");
  try {
    const seen: string[] = [];
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => f.controller.status(slot, term),
      result: (slot, term, id) => f.controller.result(slot, term, id),
      apply: async (call) => {
        const row = await f.database
          .selectFrom("browserPoolControllerCalls")
          .select(["id", "settledAt"])
          .where("id", "=", call.id)
          .executeTakeFirst();
        expect(row).toMatchObject({ id: call.id, settledAt: null });
        seen.push(call.kind);
        return f.controller.apply(call);
      },
    };
    const home = f.home(undefined, physical);
    await home.recover();
    await f.openSession(home);
    await parkAndWake(f, home);
    expect(seen).toEqual(expect.arrayContaining(["start", "sign", "pause", "resume"]));
  } finally {
    await f.close();
  }
});

it("keeps a partial tab loss through a Home restart between the runtime's completion and the Home's write", async () => {
  const f = await poolFixture("partial-loss");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    home.close();
    f.reportTabLoss(f.sessionId);
    const crash = new Crash();
    const dying = f.home(crash);
    await dying.recover();
    crash.arm("runtime:complete", "after");
    void dying.gate.reserve(AbortSignal.timeout(10_000)).catch(() => undefined);
    await vi.waitFor(() => expect(crash.dead).toBe(true));
    dying.close();
    f.reportTabLoss(undefined);
    const next = f.home();
    await next.recover();
    expect(next.gate.phase).toBe("open");
    expect(
      await f.database
        .selectFrom("browserPoolDocumentLosses")
        .select(["sessionId", "reason"])
        .where("reason", "=", "document-changed")
        .execute(),
    ).toEqual([{ sessionId: f.sessionId, reason: "document-changed" }]);
  } finally {
    await f.close();
  }
});

it("consumes a saved state with exactly one resume, whatever the call id", async () => {
  const controller = new FakeBrowserPoolController({ slotId: "slot-once", term: 1 });
  const call = async (kind: "start" | "pause" | "resume", id = randomUUID()) => {
    const status = await controller.status("slot-once", 1);
    return controller.apply({
      id,
      slotId: "slot-once",
      term: 1,
      kind,
      expect: {
        instance: status.instance,
        epoch: status.epoch,
        phase: status.phase,
        savedStateId: status.savedState?.id ?? null,
      },
      ...(kind === "resume" ? { intent: { id: randomUUID(), sequence: 1 } } : {}),
    });
  };
  await call("start");
  await call("pause");
  const paused = await controller.status("slot-once", 1);
  const resumeFrom = (id: string) =>
    controller.apply({
      id,
      slotId: "slot-once",
      term: 1,
      kind: "resume",
      expect: {
        instance: paused.instance,
        epoch: paused.epoch,
        phase: "paused",
        savedStateId: paused.savedState!.id,
      },
      intent: { id: randomUUID(), sequence: 1 },
    });
  const first = randomUUID();
  expect(await resumeFrom(first)).toMatchObject({ applied: true });
  expect(await resumeFrom(first)).toMatchObject({ applied: true });
  expect(await resumeFrom(randomUUID())).toMatchObject({ applied: false });
  expect(controller.effects).toEqual(["start", "pause", "resume"]);
});

it("discards when the saved state passes its discard time on the controller's clock", async () => {
  let now = Date.now();
  const f = await poolFixture("discard-at", { now: () => now });
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const saved = (await f.controller.status("slot-discard-at", 1)).savedState!;
    now = Date.parse(saved.discardAt) + 1;
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect(f.controller.effects).toEqual(["start", "pause", "start"]);
    expect((await f.row())?.state).toBe("failed");
    expect(await f.slot()).toMatchObject({
      phase: "running",
      outcome: { lost: [{ sessionId: f.sessionId, reason: "live-state-unavailable" }] },
    });
  } finally {
    await f.close();
  }
});

it("aborts a park when a page was ended while its session was suspended", async () => {
  const f = await poolFixture("late-page");
  try {
    let dropAfterRetire = true;
    const home = f.home(undefined, f.controller, {
      runtime: {
        // The runtime reports a page it ended during the suspension (a late popup).
        poolState: () => {
          const state = f.runtime.poolState()!;
          return dropAfterRetire && state.phase === "retired" ? { ...state, dropped: 1 } : state;
        },
        controlPool: async (control, signature) => {
          const state = await f.runtime.controlPool(control, signature);
          return dropAfterRetire && state.phase === "retired" ? { ...state, dropped: 1 } : state;
        },
      },
    });
    await home.recover();
    await f.openSession(home);
    const parked = await home.tryPark();
    dropAfterRetire = false;
    expect(parked).toBe("vetoed");
    expect(f.controller.effects).toEqual(["start"]);
    expect(f.runtime.poolState()).toMatchObject({ phase: "running", cancelled: true });
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("keeps installing a cold start past the attempts until the controller answers", async () => {
  const f = await poolFixture("cold-start");
  try {
    // The controller cannot be reached for more attempts than the ladder has before its last rung.
    let unreachable = 9;
    const flaky: BrowserPoolPhysicalController = {
      status: async (slot, term) => {
        if (unreachable > 0) {
          unreachable--;
          throw new Error("The pool controller is unreachable.");
        }
        return f.controller.status(slot, term);
      },
      result: (slot, term, id) => f.controller.result(slot, term, id),
      apply: (call) => f.controller.apply(call),
    };
    const home = f.home(undefined, flaky);
    await withTimeout(home.recover(), 10_000, {
      timeoutError: () => new Error("The cold start never installed."),
    });
    expect(unreachable).toBe(0);
    expect(home.gate.phase).toBe("open");
    expect(f.controller.effects).toEqual(["start"]);
    expect(await f.slot()).toMatchObject({ phase: "running" });
    await f.admitted();
  } finally {
    await f.close();
  }
});

it("discards a running slot whose recovery keeps failing, and never opens it unchecked", async () => {
  const f = await poolFixture("running-fallback");
  try {
    const first = f.home();
    await first.recover();
    await f.openSession(first);
    first.close();
    // After the restart the runtime's state cannot be read for many attempts.
    let unreadable = 9;
    const next = f.home(undefined, f.controller, {
      runtime: {
        poolState: () => {
          if (unreadable > 0) {
            unreadable--;
            return undefined;
          }
          return f.runtime.poolState();
        },
        controlPool: (control, signature) => f.runtime.controlPool(control, signature),
      },
    });
    await withTimeout(next.recover(), 10_000, {
      timeoutError: () => new Error("The recovery never ended."),
    });
    // Recovery is tried every round; once the attempts are used and it fails again, the live
    // state is discarded with its note. Admission opens only behind the fresh guest.
    expect(next.gate.phase).toBe("open");
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    expect((await f.row())?.state).toBe("failed");
    expect(await f.slot()).toMatchObject({
      outcome: { adopted: [], lost: [{ sessionId: f.sessionId, reason: "unrecoverable" }] },
    });
  } finally {
    await f.close();
  }
});

it("drives a reconnect whose slot read fails to the session reattached and an open gate", async () => {
  const f = await poolFixture("reconnect-read");
  try {
    let failing = 0;
    const home = f.home(undefined, f.controller, {
      channelDeadlineMs: 5_000,
      testHooks: {
        readSlot: async (database, runnerId) => {
          if (failing > 0) {
            failing--;
            throw new Error("The slot read failed.");
          }
          return readBrowserPoolSlot(database, runnerId);
        },
      },
    });
    await home.recover();
    await f.openSession(home);
    await f.loseChannel();
    failing = 2;
    home.channelLost(f.sessionId);
    await vi.waitFor(() => expect(home.gate.phase).toBe("open"), { timeout: 4_000 });
    expect(failing).toBe(0);
    expect((await f.row())?.state).toBe("ready");
    expect(f.page.isClosed()).toBe(false);
  } finally {
    await f.close();
  }
});

it("ends a reconnect whose reattach stalls by its deadline, with the session's end recorded", async () => {
  const f = await poolFixture("reconnect-stall");
  try {
    const home = f.home(undefined, f.controller, { channelDeadlineMs: 300 });
    await home.recover();
    await f.openSession(home);
    await f.loseChannel();
    const never = Promise.withResolvers<void>();
    f.stallReattach(never.promise);
    const lost = Date.now();
    home.channelLost(f.sessionId);
    await vi.waitFor(() => expect(home.gate.phase).toBe("open"), { timeout: 3_000 });
    expect(Date.now() - lost).toBeLessThan(3_000);
    expect((await f.row())?.state).toBe("failed");
    expect(await f.slot()).toMatchObject({ phase: "running" });
    // The stalled attempt was ended by its own signal: nothing attaches late.
    never.resolve();
    await vi.waitFor(() => expect(home.gate.phase).toBe("open"));
    expect(f.sinks.has(f.sessionId)).toBe(false);
  } finally {
    await f.close();
  }
});

it("gives a second session that loses its channel while the first one ends its own window", async () => {
  const f = await poolFixture("second-loss");
  try {
    const home = f.home(undefined, f.controller, { channelDeadlineMs: 400 });
    await home.recover();
    await f.openSession(home);
    const other = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await f.openSession(home, other);
    // The first never comes back; the second drops while the first's window runs out.
    f.skip.add(f.sessionId);
    await f.loseChannel(f.sessionId);
    home.channelLost(f.sessionId);
    await vi.waitFor(async () => expect((await f.row())?.state).toBe("failed"), {
      timeout: 5_000,
    });
    await f.loseChannel(other);
    home.channelLost(other);
    await vi.waitFor(() => expect(f.sinks.has(other)).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(home.gate.phase).toBe("open"));
    expect((await f.row(other))?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

for (const asked of ["restart", "removal"] as const)
  it(`settles a ${asked} asked while a park is retiring, with no reconnect after it`, async () => {
    const inProbe = Promise.withResolvers<void>();
    const probe = Promise.withResolvers<void>();
    let holding = false;
    const f = await poolFixture(`retiring-${asked}`, {
      probePage: async (_page, phase) => {
        if (holding && phase === "frozen") {
          inProbe.resolve();
          await probe.promise;
        }
        return [];
      },
    });
    try {
      const home = f.home();
      await home.recover();
      await f.openSession(home);
      holding = true;
      const parking = home.tryPark();
      await inProbe.promise;
      const done = asked === "restart" ? home.restart() : home.releaseDevice();
      holding = false;
      probe.resolve();
      await parking;
      await done;
      if (asked === "removal") {
        await home.released();
        expect(home.gate.phase).toBe("released");
        expect(await f.slot()).toBeUndefined();
      } else {
        // The park had committed its intent, so it ends parked; then the restart replaces it.
        expect(home.gate.phase).toBe("open");
        expect(f.controller.effects).toEqual(["start", "pause", "stop", "start"]);
        expect(await f.slot()).toMatchObject({ phase: "running" });
        // No session is left waiting for a channel: nothing reconnects afterwards.
        expect(home.gate.away).toBeNull();
      }
    } finally {
      probe.resolve();
      await f.close();
    }
  });

for (const fault of ["status-fails", "stop-throws", "stop-not-applied"] as const)
  it(`keeps a removed device's slot until its guest is known stopped when the ${fault}`, async () => {
    const f = await poolFixture(`release-${fault}`);
    try {
      let failing = 3;
      let refused = 0;
      const physical: BrowserPoolPhysicalController = {
        status: async (slot, term) => {
          if (fault === "status-fails" && failing > 0) {
            failing--;
            refused++;
            throw new Error("The pool controller is unreachable.");
          }
          return f.controller.status(slot, term);
        },
        result: (slot, term, id) => f.controller.result(slot, term, id),
        apply: async (call) => {
          if (call.kind === "stop" && fault !== "status-fails" && failing > 0) {
            failing--;
            refused++;
            if (fault === "stop-throws") throw new Error("The stop request was lost.");
            return {
              id: call.id,
              applied: false,
              reason: "busy",
              status: await f.controller.status(call.slotId, call.term),
            };
          }
          return f.controller.apply(call);
        },
      };
      const first = f.home();
      await first.recover();
      await f.openSession(first);
      first.close();
      let removing = f.home(undefined, physical);
      await removing.recover();
      const blocked = Promise.withResolvers<void>();
      f.controller.hold("stop", () => blocked.promise);
      failing = 1_000;
      await removing.releaseDevice();
      // The sessions ended with their note at once, admission is closed for good, and the row
      // waits: none of the failures is evidence that the guest stopped.
      expect((await f.row())?.state).toBe("failed");
      expect(await f.slot()).toMatchObject({ phase: "releasing" });
      expect(removing.gate.phase).toBe("released");
      // The driver keeps asking; however often it is refused, the row stays.
      const before = refused;
      await vi.waitFor(() => expect(refused).toBeGreaterThanOrEqual(before + 3));
      expect(await f.slot()).toMatchObject({ phase: "releasing" });
      expect(f.controller.effects).toEqual(["start"]);
      // A Home restart resumes the stop; once it is known, the slot goes with its journal.
      removing.close();
      blocked.resolve();
      failing = 2;
      removing = f.home(undefined, physical);
      await removing.recover();
      expect(removing.gate.phase).toBe("released");
      await vi.waitFor(async () => expect(await f.slot()).toBeUndefined(), { timeout: 5_000 });
      expect(f.controller.effects).toEqual(["start", "stop"]);
      expect(
        await f.database
          .selectFrom("browserPoolControllerCalls")
          .select("id")
          .where("runnerId", "=", f.task.runnerId)
          .execute(),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

it("ages out finished calls, the last intent's included once the slot runs again, without being asked", async () => {
  const f = await poolFixture("prune-idle");
  try {
    const home = f.home(undefined, f.controller, { pruneEveryMs: 50 });
    await home.recover();
    await f.openSession(home);
    await parkAndWake(f, home);
    const slot = await f.slot();
    expect(slot).toMatchObject({ phase: "running", intentId: expect.any(String) });
    const calls = () =>
      f.database
        .selectFrom("browserPoolControllerCalls")
        .select(["id", "intentId"])
        .where("runnerId", "=", f.task.runnerId)
        .execute();
    expect((await calls()).some(({ intentId }) => intentId === slot!.intentId)).toBe(true);
    // Everything finished long ago; nothing calls the cleanup here, the Home's own timer does.
    await f.database
      .updateTable("browserPoolControllerCalls")
      .set({ settledAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where("runnerId", "=", f.task.runnerId)
      .where("settledAt", "is not", null)
      .execute();
    await vi.waitFor(async () => expect(await calls()).toEqual([]), { timeout: 3_000 });
  } finally {
    await f.close();
  }
});

it("closes an open resume when a discard replaces the guest, so no later recovery replays it", async () => {
  const f = await poolFixture("resume-ack-lost", { freshGuests: true });
  try {
    // Every acknowledgement of the resume is lost: its row stays open while the guest resumed.
    const settle = async (id: string, result: Readonly<Record<string, unknown>>) => {
      const row = await f.database
        .selectFrom("browserPoolControllerCalls")
        .select("kind")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (row.kind === "resume") throw new Error("The journal acknowledgement was lost.");
      await f.database
        .updateTable("browserPoolControllerCalls")
        .set({ result, settledAt: new Date() })
        .where("id", "=", id)
        .where("settledAt", "is", null)
        .execute();
    };
    const home = f.home(undefined, f.controller, { testHooks: { settleCall: settle } });
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");
    const woken = await home.gate.reserve(AbortSignal.timeout(15_000));
    woken.release();
    // The ladder reached its last rung: a fresh guest replaced the resumed one.
    expect(f.controller.effects).toEqual(["start", "pause", "resume", "stop", "start"]);
    const open = () =>
      f.database
        .selectFrom("browserPoolControllerCalls")
        .select(["kind", "result"])
        .where("runnerId", "=", f.task.runnerId)
        .where("settledAt", "is", null)
        .execute();
    expect(await open()).toEqual([]);
    // The resume did apply, so its row never says it did not: it was superseded, its outcome
    // not known to the journal.
    expect(
      await f.database
        .selectFrom("browserPoolControllerCalls")
        .select("result")
        .where("runnerId", "=", f.task.runnerId)
        .where("kind", "=", "resume")
        .execute(),
    ).toEqual([
      {
        result: {
          id: expect.any(String),
          outcome: "unknown",
          reason: "superseded",
          status: expect.any(Object),
        },
      },
    ]);
    // A later Home's recovery has nothing to replay against the new guest: still one guest.
    home.close();
    const next = f.home();
    await next.recover();
    expect(f.controller.effects).toEqual(["start", "pause", "resume", "stop", "start"]);
    expect(next.gate.phase).toBe("open");
    expect(await open()).toEqual([]);
  } finally {
    await f.close();
  }
});

it("ends a recovery that keeps failing at start in a discard and an open gate", async () => {
  const f = await poolFixture("startup-discard");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    const slot = await f.slot();
    const intent = await beginBrowserPoolPark(
      f.database,
      browserPoolSlotIdentity(slot!),
      randomUUID(),
      () => false,
    );
    await f.signed({
      kind: "retire",
      fence: f.runtime.poolState()!.fence!,
      intent: { id: intent!.intentId!, sequence: intent!.intentSequence },
    });
    home.close();
    // After the restart the runtime refuses every release: the recovery cannot abort.
    const next = f.home(undefined, f.controller, {
      runtime: {
        poolState: () => f.runtime.poolState(),
        controlPool: (control, signature) =>
          control.kind === "release"
            ? Promise.reject(new Error("The release never applies."))
            : f.runtime.controlPool(control, signature),
      },
    });
    await next.recover();
    expect(next.gate.phase).toBe("open");
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 1 });
    expect((await f.row())?.state).toBe("failed");
    expect(f.page.isClosed()).toBe(true);
  } finally {
    await f.close();
  }
});

it("reports a lost session whose end could not be confirmed, and keeps the other session usable", async () => {
  const f = await poolFixture("end-unconfirmed");
  try {
    const home = f.home();
    await home.recover();
    await f.openSession(home);
    const other = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await f.openSession(home, other);
    expect(await home.tryPark()).toBe("parked");
    // The first session is not reattached, and ending it fails; the second is reattached.
    f.skip.add(f.sessionId);
    (f.runtime as unknown as { endPooledSession: () => Promise<void> }).endPooledSession =
      async () => {
        throw new Error("The page close could not be confirmed.");
      };
    const woken = await home.gate.reserve(AbortSignal.timeout(10_000));
    woken.release();
    expect(f.runtime.poolState()).toMatchObject({
      phase: "running",
      adoption: {
        outcome: {
          adopted: [other],
          lost: [{ sessionId: f.sessionId, reason: "not-reattached; end-unconfirmed" }],
        },
      },
    });
    // No blanket discard: the controller saw no fresh start, and the other session works.
    expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect((await f.row(other))?.state).toBe("ready");
    await expect(
      f.sinks.get(other)!.handle(
        JSON.stringify({
          type: "session.state",
          runs: 0,
          personUsed: [],
          viewed: [],
          pinned: [],
        }),
      ),
    ).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});
