import { randomUUID } from "node:crypto";
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
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
} from "../packages/browser-runtime-core/src/browser-pool.js";
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
  browserPoolSlotIdentity,
  listBrowserPoolDocumentLosses,
  readBrowserPoolSlot,
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

async function poolFixture(key: string, options: { adoptionWindowMs?: number } = {}) {
  const fixture = await createStoreFixture();
  const task = await fixture.createRunFixture(key);
  const { database } = fixture;
  const controller = new FakeBrowserPoolController({ slotId: `slot-${key}`, term: 1 });
  const page = new FakePage();
  const verifier = new FakeTicketVerifier();
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
    runtimeId: "pool-runtime",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
    pool: {
      controllerKey: controller.publicKey,
      probePage: async () => [],
      ...(options.adoptionWindowMs ? { adoptionWindowMs: options.adoptionWindowMs } : {}),
    },
  });
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
  let unexpected: { sessionId: BrowserSessionId; surfaceId: string } | undefined;
  const adopter: BrowserPoolAdopter = {
    inventory: () => (unexpected ? [unexpected] : []),
    orphans: async () => {
      const live = (runtime as unknown as { sessions: Map<string, unknown> }).sessions;
      const current = await getBrowserSessionForOwner(database, sessionId, task.userId);
      return current && current.state === "ready" && !live.has(sessionId)
        ? [
            {
              sessionId,
              surfaces: [...surfaces].map((surfaceId) => ({ surfaceId, documentId: null })),
            },
          ]
        : [];
    },
    reattach: async ({ sessions, fence, attempt }) => {
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
      return [];
    },
  };
  const homes: BrowserPoolCoordinator[] = [];
  const home = (crash?: Crash, physical: BrowserPoolPhysicalController = controller) => {
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
      runtimeFault: (kind) => {
        const index = runtimeFaults.findIndex((entry) => entry.kind === kind);
        return index < 0 ? undefined : runtimeFaults.splice(index, 1)[0]!.fault;
      },
    });
    coordinator.setAdopter(adopter);
    homes.push(coordinator);
    return coordinator;
  };
  const openSession = async (coordinator: BrowserPoolCoordinator) => {
    await createBrowserSession(database, {
      id: sessionId,
      ownerId: task.userId,
      opener: { kind: "person", userId: task.userId },
      placementKey: "pool-test",
      runnerId: task.runnerId,
      origin: "person",
      profileId: null,
      runtimeId: "pool-runtime",
      pooled: true,
    });
    await transitionBrowserSession(database, { sessionId, state: "ready" });
    verifier.setClaims("open", { ...claims, pool: coordinator.fence() });
    const sink = new FakeSink();
    const attachment = await runtime.attach("open", sink);
    for (const id of sink.tabs.rows.keys()) surfaces.add(id);
    await attachment.handle(
      JSON.stringify({ type: "session.state", runs: 0, personUsed: [], viewed: [], pinned: [] }),
    );
    sinks.set(sessionId, attachment);
  };
  const row = () => getBrowserSessionForOwner(database, sessionId, task.userId);
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
  const signed = async (control: BrowserPoolControl) => {
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
    return runtime.controlPool(control, Buffer.from(result.signature!, "base64"));
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
    runtime,
    page,
    sessionId,
    home,
    openSession,
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
      const next = f.home();
      await next.recover();
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

it("recovers a runtime found retiring at a Home restart as not parked", async () => {
  const f = await poolFixture("found-retiring");
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
    const retired = await f.signed({
      kind: "retire",
      fence: f.runtime.poolState()!.fence!,
      intent: { id: intent!.intentId!, sequence: intent!.intentSequence },
    });
    expect(retired.phase).toBe("retired");
    home.close();
    const next = f.home();
    await next.recover();
    expect(next.gate.phase).toBe("open");
    expect(await f.slot()).toMatchObject({ phase: "running", epoch: 1 });
    expect(f.runtime.poolState()).toMatchObject({ phase: "running", cancelled: true });
    expect(f.controller.effects).toEqual(["start"]);
    expect((await f.row())?.state).toBe("ready");
    expect(f.page.isClosed()).toBe(false);
  } finally {
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
    const late: BrowserPoolControl = {
      kind: "retire",
      fence: f.runtime.poolState()!.fence!,
      intent: { id: intent!.intentId!, sequence: intent!.intentSequence },
    };
    await expect(f.signed(late)).rejects.toThrow("cancelled");
    expect(browserPoolControlBytes(late).length).toBeGreaterThan(0);
    await parkAndWake(f, next);
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});
