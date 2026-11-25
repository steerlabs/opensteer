import { randomUUID } from "node:crypto";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserPoolCoordinator,
  type BrowserPoolAdopter,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import { BrowserPoolAttemptRefused } from "../apps/host/src/browser/browser-pool-gate.js";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalStatus,
  BrowserPoolPhysicalController,
} from "../apps/host/src/browser/browser-pool-controller.js";
import {
  createPoolController,
  AgentPoolController,
  poolControllerKind,
} from "./browser-pool-controller-under-test.test-support.js";
import { type BrowserPoolControl } from "../packages/browser-runtime-core/src/browser-pool.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import { BrowserPoolAgentSlotDeleted } from "../packages/browser-runtime-core/src/browser-pool-agent-wire.js";
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
  readBrowserPoolSlot,
  listBrowserPoolReadySessions,
  requireBrowserPoolAdmission,
} from "../packages/database/src/browser-pool-store.js";
import { listBrowserPoolDocumentLosses } from "./browser-pool-journey.test-support.js";
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
    /** The channel behaves as a remote one: slow, and answers none when no guest is running. */
    remote?: boolean;
    /** The runtime's page probe during a retire; a retire waits for it. */
    probePage?: (page: unknown, phase: "active" | "frozen") => Promise<readonly string[]>;
  } = {},
) {
  const fixture = await createStoreFixture();
  const task = await fixture.createRunFixture(key);
  const { database } = fixture;
  // The agent cannot see a loopback runtime that outlives a start: against it every start is a
  // new guest with an empty runtime, as on a real host.
  if (poolControllerKind() === "agent") options = { ...options, freshGuests: true };
  const controller = await createPoolController({
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
  let afterReattach: ((sessions: readonly BrowserSessionId[]) => Promise<void>) | undefined;
  let scanning: (() => Promise<void>) | undefined;
  let unexpected: { sessionId: BrowserSessionId; surfaceId: string } | undefined;
  const adopter: BrowserPoolAdopter = {
    inventory: () => (unexpected ? [unexpected] : []),
    live: (id) => sinks.has(id),
    // As the Home's: the ready sessions of the runtime with no channel here.
    pagesOf: async (id) => (id === sessionId ? [...surfaces] : []),
    withoutChannel: async (target) => {
      const found = (await listBrowserPoolReadySessions(database, target)).filter(
        (id) => !sinks.has(id),
      );
      await scanning?.();
      return found;
    },
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
      await afterReattach?.(sessions);
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
      poolState: async () => {
        // As a remote runtime behind a relay: slow, and with no guest running there is no
        // runtime to ask.
        if (options.remote) {
          for (let turn = 0; turn < 5; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          const status = await controller.status(`slot-${key}`, 1);
          if (status.phase !== "running") return null;
        }
        return runtime.poolState() ?? null;
      },
      controlPool: (control, signature) =>
        crash
          ? crash.pass(`runtime:${control.kind}`, () => runtime.controlPool(control, signature))
          : runtime.controlPool(control, signature),
      endSession: (ticket) => runtime.endPoolSession(ticket),
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
    await controller.close?.();
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
    /** Runs inside the loop's read of sessions without a channel, before it returns. */
    onScan: (hook: typeof scanning) => {
      scanning = hook;
    },
    /** Runs once a reattach has attached its sessions, before it returns. */
    onReattached: (hook: typeof afterReattach) => {
      afterReattach = hook;
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

it("answers a restart asked before the first slot with the first install, and records its key", async () => {
  const f = await poolFixture("restart-before-slot");
  try {
    const home = f.home();
    const restarting = home.restart({ key: "before-slot" });
    await home.recover();
    await restarting;
    // It resolved only once a guest was installed, and that one install answered it.
    expect(await f.slot()).toMatchObject({ phase: "running", restartKeys: ["before-slot"] });
    expect(f.controller.effects).toEqual(["start"]);
    await home.restart({ key: "before-slot" });
    expect(f.controller.effects).toEqual(["start"]);
    expect(home.gate.phase).toBe("open");
  } finally {
    await f.close();
  }
});

it("answers more joined restarts than it records with one start, and never rewrites for the rest", async () => {
  const f = await poolFixture("restart-many-keys");
  try {
    const home = f.home();
    await home.recover();
    const stopping = Promise.withResolvers<void>();
    const stop = Promise.withResolvers<void>();
    f.controller.hold("stop", async () => {
      stopping.resolve();
      await stop.promise;
    });
    const first = home.restart({ key: "key-0" });
    await stopping.promise;
    const joined = Array.from({ length: 69 }, (_, index) =>
      home.restart({ key: `key-${index + 1}` }),
    );
    stop.resolve();
    await withTimeout(Promise.all([first, ...joined]), 10_000, {
      timeoutError: () => new Error("The joined restarts did not settle."),
    });
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    const keys = (await f.slot())!.restartKeys as string[];
    expect(keys).toHaveLength(64);
    expect(new Set(keys).size).toBe(64);
    expect(home.gate.phase).toBe("open");
  } finally {
    await f.close();
  }
});

it("finishes a restart a Home crash interrupted after its stop, once, and a retry of its key changes nothing", async () => {
  const f = await poolFixture("restart-crash");
  try {
    const first = f.home();
    await first.recover();
    // The guest is stopped; the Home dies before the start it sent ever applies.
    f.controller.hold("start", () => new Promise<void>(() => {}));
    void first.restart({ key: "crashed" }).catch(() => undefined);
    await vi.waitFor(() => expect(f.controller.effects).toEqual(["start", "stop"]));
    first.close();
    const next = f.home();
    await next.recover();
    await vi.waitFor(async () =>
      expect(await f.slot()).toMatchObject({ phase: "running", restartKeys: ["crashed"] }),
    );
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    await next.restart({ key: "crashed" });
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    expect(next.gate.phase).toBe("open");
  } finally {
    await f.close();
  }
});

it("keeps admission closed from a park's commit until its abort is confirmed, for demand that came after the last veto check", async () => {
  const f = await poolFixture("commit-then-demand");
  try {
    let waiter: Promise<string> | undefined;
    const signing = Promise.withResolvers<void>();
    const sign = Promise.withResolvers<void>();
    const home = f.home(undefined, f.controller, {
      testHooks: {
        beginPark: async (...args) => {
          const committed = await beginBrowserPoolPark(...args);
          // Demand arrives after the database's last veto check, before the commit's reply.
          waiter = home.gate.reserve(AbortSignal.timeout(10_000)).then(async (held) => {
            const phase = (await f.slot())?.phase ?? "none";
            held.release();
            return phase;
          });
          // The abort's first signature waits, so the interval stays open to look at.
          f.controller.hold("sign", async () => {
            signing.resolve();
            await sign.promise;
          });
          return committed;
        },
      },
    });
    await home.recover();
    await f.openSession(home);
    const parking = home.tryPark();
    await signing.promise;
    expect((await f.slot())?.phase).toBe("preparing");
    expect(home.gate.admits).toBe(false);
    sign.resolve();
    expect(await parking).toBe("vetoed");
    // Admitted only once the row read running again.
    expect(await waiter).toBe("running");
  } finally {
    await f.close();
  }
});

it("gives a holder that never lets go its recorded outcome before a restart stops the guest", async () => {
  const f = await poolFixture("restart-stuck-holder");
  try {
    const home = f.home(undefined, f.controller, { quiesceMs: 300 });
    await home.recover();
    const order: string[] = [];
    const held = await home.gate.reserve(AbortSignal.timeout(10_000));
    // A holder that ignores its abort; it can still say what it did.
    held.onForcedEnd?.(async () => {
      order.push(`settled with ${f.controller.effects.join(",")}`);
    });
    await withTimeout(home.restart({ key: "stuck" }), 10_000, {
      timeoutError: () => new Error("The restart waited forever for the holder."),
    });
    expect(order).toEqual(["settled with start"]);
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    held.release();
    expect(home.gate.phase).toBe("open");
  } finally {
    await f.close();
  }
});

it("keeps a channel lost again while its attach is being finished as a new loss, with its own documents", async () => {
  const f = await poolFixture("lost-again", { adoptionWindowMs: 60_000 });
  try {
    const home = f.home(undefined, f.controller, { channelDeadlineMs: 20_000 });
    await home.recover();
    await f.openSession(home);
    let attempts = 0;
    let second: { document: string | undefined; admits: boolean } | undefined;
    f.onReattached(async (sessions) => {
      attempts++;
      const id = sessions[0]!;
      if (attempts === 1) {
        // The fresh channel closes as soon as it is up: a second loss, with what it holds now.
        await f.sinks.get(id)?.close(false, false, true);
        f.sinks.delete(id);
        home.channelLost(id, new Map([["surface-now", "document-now"]]));
      } else if (attempts === 2)
        // The second attach answers the second loss, whose witness is still the one it brought.
        second = {
          document: home.knownDocument(id, "surface-now"),
          admits: home.gate.admits,
        };
    });
    await f.loseChannel();
    home.channelLost(f.sessionId);
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(second).toEqual({ document: "document-now", admits: false });
    await vi.waitFor(() => expect(home.gate.phase).toBe("open"));
    expect(home.reattaching(f.sessionId)).toBe(false);
    expect((await f.row())?.state).toBe("ready");
  } finally {
    await f.close();
  }
});

it("waits out the reconnect step's backoff when the channel it brought back drops again at once", async () => {
  const f = await poolFixture("lost-spin", { adoptionWindowMs: 60_000 });
  try {
    const home = f.home(undefined, f.controller, { channelDeadlineMs: 60_000, retryMs: 300 });
    await home.recover();
    await f.openSession(home);
    const attempts: number[] = [];
    f.onReattached(async (sessions) => {
      attempts.push(Date.now());
      const id = sessions[0]!;
      // Every fresh channel closes as soon as it is up: lost again, during the step.
      await f.sinks.get(id)?.close(false, false, true);
      f.sinks.delete(id);
      home.channelLost(id);
    });
    await f.loseChannel();
    home.channelLost(f.sessionId);
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(4), { timeout: 15_000 });
    // Each new attempt waits its backoff: never dialled in a loop.
    for (let index = 1; index < 4; index++)
      expect(attempts[index]! - attempts[index - 1]!).toBeGreaterThanOrEqual(250);
  } finally {
    await f.close();
  }
});

it("takes a stored, signed fenced answer as final: nothing more is sent, and callers are refused at once", async () => {
  const f = await poolFixture("over-fenced");
  try {
    let fenced = false;
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => f.controller.status(slot, term),
      result: (slot, term, id) => f.controller.result(slot, term, id),
      // Another term owns the slot now: the controller answers a start, stored, as fenced.
      apply: async (call) =>
        fenced && call.kind === "start"
          ? {
              id: call.id,
              applied: false,
              reason: "fenced",
              status: await f.controller.status(call.slotId, call.term),
            }
          : f.controller.apply(call),
    };
    const home = f.home(undefined, physical);
    await home.recover();
    fenced = true;
    await expect(
      withTimeout(home.restart({ key: "fenced" }), 10_000, {
        timeoutError: () => new Error("The restart is still asking a fenced target."),
      }),
    ).rejects.toThrow("not ready");
    const effects = [...f.controller.effects];
    const asked = Date.now();
    await expect(home.gate.reserve(AbortSignal.timeout(15_000))).rejects.toThrow("not ready");
    expect(Date.now() - asked).toBeLessThan(2_000);
    expect(home.report()).toMatchObject({ refused: "fenced" });
    expect(f.controller.effects).toEqual(effects);
  } finally {
    await f.close();
  }
});

it("waits longer after each failure in a row, retryMs or not", async () => {
  const f = await poolFixture("growing-backoff");
  try {
    const first = f.home();
    await first.recover();
    first.close();
    // The runtime's state cannot be read for a while: each recovery attempt fails.
    const tries: number[] = [];
    const next = f.home(undefined, f.controller, {
      retryMs: 20,
      runtime: {
        poolState: async () => {
          tries.push(Date.now());
          if (tries.length <= 5) throw new Error("The runtime's state could not be read.");
          return f.runtime.poolState() ?? null;
        },
        controlPool: (control, signature) => f.runtime.controlPool(control, signature),
        endSession: (ticket) => f.runtime.endPoolSession(ticket),
      },
    });
    await next.recover();
    const waits = tries.slice(1).map((at, index) => at - tries[index]!);
    expect(waits.length).toBeGreaterThanOrEqual(5);
    // 20 ms doubling: the fifth wait is far longer than the first.
    expect(waits[4]!).toBeGreaterThan(waits[0]! * 4);
  } finally {
    await f.close();
  }
});

it("wakes with a down proxy, then parks and wakes the same browser to repair it without a failed start or a lost page", async () => {
  const f = await poolFixture("proxy-wake-repair");
  const slotId = "slot-proxy-wake-repair";
  const agent = poolControllerKind() === "agent";
  const repairWake = Promise.withResolvers<BrowserPoolControllerCall>();
  const allowRepair = Promise.withResolvers<void>();
  try {
    const calls: string[] = [];
    let firstWake: BrowserPoolControllerResult | undefined;
    let firstWakeSavedId: string | null | undefined;
    let repairPark: BrowserPoolControllerResult | undefined;
    let down: BrowserPoolPhysicalStatus | undefined;
    const physical: BrowserPoolPhysicalController = {
      status: async (slot, term) => {
        const status = await f.controller.status(slot, term);
        if (status.phase === "running" && status.proxy === "down") down = status;
        return status;
      },
      result: (slot, term, id) => f.controller.result(slot, term, id),
      apply: async (call) => {
        if (call.kind !== "sign") calls.push(call.kind);
        if (call.kind === "resume" && call.expect.epoch === 2) {
          repairWake.resolve(call);
          await allowRepair.promise;
        }
        const result = await f.controller.apply(call);
        if (call.kind === "resume" && call.expect.epoch === 1) {
          firstWake = result;
          firstWakeSavedId = call.expect.savedStateId;
          if (!agent) f.controller.observe({ proxy: "down" });
        }
        if (call.kind === "pause" && call.expect.epoch === 2) repairPark = result;
        return result;
      },
    };
    const home = f.home(undefined, physical, { statusEveryMs: 50 });
    await home.recover();
    await f.openSession(home);
    const runtime = f.runtime;
    const loader = f.page.loaderId;
    expect(await home.tryPark()).toBe("parked");
    const parked = await f.controller.status(slotId, 1);
    expect(parked).toMatchObject({ phase: "paused", epoch: 1 });
    expect(parked.savedState?.id).toBeDefined();
    f.controller.setProxyUnhealthy?.(true);
    const waiting = home.gate.reserve(AbortSignal.timeout(30_000)).then(
      (lease) => lease.release(),
      (error: unknown) => error,
    );

    const repair = await repairWake.promise;
    expect(firstWakeSavedId).toBe(parked.savedState?.id);
    expect(firstWake).toMatchObject({
      applied: true,
      status: { phase: "running", instance: parked.instance, epoch: 2, savedState: null },
    });
    expect(down).toMatchObject({
      phase: "running",
      instance: parked.instance,
      epoch: 2,
      proxy: "down",
    });
    expect(repairPark).toMatchObject({
      applied: true,
      status: { phase: "paused", instance: parked.instance, epoch: 2 },
    });
    expect(repairPark?.savedState?.id).toBeDefined();
    expect(repair.expect.savedStateId).toBe(repairPark?.savedState?.id);
    expect(await f.controller.status(slotId, 1)).toMatchObject({
      phase: "paused",
      instance: parked.instance,
      savedState: repairPark?.savedState,
    });
    expect(await f.slot()).toMatchObject({ instanceId: parked.instance, failedStarts: 0 });
    expect(home.report()).toMatchObject({ phase: "waking" });
    expect(home.report()?.refused).toBeUndefined();

    f.controller.setProxyUnhealthy?.(false);
    if (!agent) f.controller.observe({ proxy: "up" as never });
    allowRepair.resolve();
    expect(await waiting).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await f.slot()).toMatchObject({
        phase: "running",
        instanceId: parked.instance,
        epoch: 3,
        failedStarts: 0,
        outcome: { adopted: [f.sessionId], lost: [] },
      }),
    );
    expect(await f.controller.status(slotId, 1)).toMatchObject({
      phase: "running",
      instance: parked.instance,
      epoch: 3,
      savedState: null,
    });
    expect((await f.controller.status(slotId, 1)).proxy).toBe(agent ? undefined : "up");
    expect(calls).toEqual(["start", "pause", "resume", "pause", "resume"]);
    expect(f.controller.effects).toEqual(calls);
    expect(f.runtime).toBe(runtime);
    expect(f.page.isClosed()).toBe(false);
    expect(f.page.loaderId).toBe(loader);
    expect((await f.row())?.state).toBe("ready");
    expect(f.sinks.has(f.sessionId)).toBe(true);
    await f.admitted();
  } finally {
    allowRepair.resolve();
    await f.close();
  }
});

it("shows a running browser recovering against a host that does not answer as waking from the first unanswered call, never as running", async () => {
  const f = await poolFixture("recover-unreachable");
  try {
    const first = f.home();
    await first.recover();
    first.close();
    // A Home restart while the host does not answer: every call goes unanswered.
    const unreachable: BrowserPoolPhysicalController = {
      status: async () => {
        throw new TypeError("fetch failed");
      },
      result: async () => {
        throw new TypeError("fetch failed");
      },
      apply: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const next = f.home(undefined, unreachable, { unreachableAfterMs: 60 * 60_000 });
    void next.recover();
    // Long before the report would say unreachable, it says the browser is not ready.
    await vi.waitFor(() => expect(next.report()).toMatchObject({ phase: "waking" }));
    expect(next.report()?.unreachable).toBeUndefined();
    expect(next.gate.admits).toBe(false);
    next.close();
  } finally {
    await f.close();
  }
});

it("recovers a running guest its host stopped on its own, at the next status read, and starts it again", async () => {
  const f = await poolFixture("host-stopped");
  try {
    const home = f.home(undefined, f.controller, { statusEveryMs: 50 });
    await home.recover();
    await f.openSession(home);
    // The host stops the guest by itself (a Home silent for long, say): nothing of this Home's
    // asked for it, and no channel of it was lost here.
    f.controller.observe({ phase: "stopped", savedState: null });
    await vi.waitFor(() => expect(f.controller.effects).toEqual(["start", "start"]), {
      timeout: 10_000,
    });
    // The session ended with the guest, with its note; a cold start is no failed start.
    await vi.waitFor(async () => expect((await f.row())?.state).toBe("failed"));
    expect(await f.slot()).toMatchObject({ phase: "running", failedStarts: 0 });
  } finally {
    await f.close();
  }
});

it("counts no failed start for a fresh start into a target that is over, and ends there", async () => {
  const f = await poolFixture("over-start");
  try {
    let over = false;
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => f.controller.status(slot, term),
      result: (slot, term, id) => f.controller.result(slot, term, id),
      // The host answers, signed, that the slot is gone: the start goes nowhere.
      apply: async (call) => {
        if (over && call.kind === "start")
          throw new BrowserPoolAgentSlotDeleted("The slot was deleted.");
        return f.controller.apply(call);
      },
    };
    const discards: string[] = [];
    const home = f.home(undefined, physical, {
      statusEveryMs: 50,
      onDiscard: (reason) => discards.push(reason),
    });
    await home.recover();
    // The guest is gone (the host stopped it): recovery's fresh start meets the deleted slot.
    over = true;
    f.controller.observe({ phase: "stopped", savedState: null });
    await vi.waitFor(() => expect(discards.length).toBeGreaterThan(0), { timeout: 10_000 });
    await vi.waitFor(() => expect(home.gate.phase).toBe("unavailable"));
    // Over is no failed start: the browser did not fail to come up, its target is gone.
    expect(await f.slot()).toMatchObject({ failedStarts: 0 });
  } finally {
    await f.close();
  }
});

// Against the real agent only: the host's own resume, after it consumed the right to resume.
it.skipIf(poolControllerKind() === "fake")(
  "wakes a parked browser whose saved state the host lost after consuming its resume as a cold start, paced, said as expired",
  async () => {
    const f = await poolFixture("resume-lost");
    try {
      const calls: string[] = [];
      const physical: BrowserPoolPhysicalController = {
        status: (slot, term) => f.controller.status(slot, term),
        result: (slot, term, id) => f.controller.result(slot, term, id),
        apply: async (call) => {
          if (call.kind !== "sign") calls.push(call.kind);
          return f.controller.apply(call);
        },
      };
      const home = f.home(undefined, physical, { refusedRetryMs: 60_000 });
      await home.recover();
      await f.openSession(home);
      expect(await home.tryPark()).toBe("parked");
      // The host consumes the resume, then its hypervisor fails it: the saved state is gone.
      (f.controller as AgentPoolController).failNext("resume", new Error("resume failed"));
      const waiting = home.gate.reserve(AbortSignal.timeout(30_000));
      await vi.waitFor(() => expect(home.report()?.refused).toBeDefined(), { timeout: 10_000 });
      // A refusal all the same: no start at once, no failed start, still parked.
      expect(calls).toEqual(["start", "pause", "resume"]);
      expect(await f.slot()).toMatchObject({ phase: "parked", failedStarts: 0 });
      // Asked again, it is a cold start, said as what it is: the live state expired.
      (await home.gate.reserve(AbortSignal.timeout(30_000))).release();
      (await waiting).release();
      expect(calls).toEqual(["start", "pause", "resume", "start"]);
      expect(await f.slot()).toMatchObject({
        phase: "running",
        failedStarts: 0,
        lastStart: { reason: "expired" },
      });
      await vi.waitFor(async () => expect((await f.row())?.state).toBe("failed"));
    } finally {
      await f.close();
    }
  },
);

it("keeps a repair decided for one instance off the fresh guest that replaced it (W13)", async () => {
  const f = await poolFixture("repair-leftover", { freshGuests: true });
  try {
    let reads = 0;
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => {
        reads++;
        return f.controller.status(slot, term);
      },
      result: (slot, term, id) => f.controller.result(slot, term, id),
      // A fresh start brings the slot's proxy back, as the host's own start does.
      apply: async (call) => {
        const result = await f.controller.apply(call);
        if (call.kind === "start" && result.applied) f.controller.observe({ proxy: "up" as never });
        return result;
      },
    };
    const home = f.home(undefined, physical, { statusEveryMs: 50 });
    await home.recover();
    // A command in flight holds the guest, so the repair decided for its instance waits.
    const command = await home.gate.reserve(AbortSignal.timeout(10_000));
    f.controller.observe({ proxy: "down" });
    await vi.waitFor(() => expect(home.report()).toMatchObject({ phase: "waking" }));
    // The person restarts the browser: a fresh guest, whose proxy serves.
    const restarting = home.restart();
    command.release();
    await restarting;
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    // Read after read, the fresh guest is never parked for the old instance's repair.
    const before = reads;
    await vi.waitFor(() => expect(reads).toBeGreaterThan(before + 5));
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    expect(home.report()).toBeUndefined();
  } finally {
    await f.close();
  }
});

/** The fixture's controller, counting the host's status reads: the loop's turns, with no clock. */
function countingStatus(f: Awaited<ReturnType<typeof poolFixture>>) {
  const counted = { reads: 0 };
  const physical: BrowserPoolPhysicalController = {
    status: (slot, term) => {
      counted.reads++;
      return f.controller.status(slot, term);
    },
    result: (slot, term, id) => f.controller.result(slot, term, id),
    apply: (call) => f.controller.apply(call),
  };
  return { counted, physical };
}

it("reports a running browser whose egress proxy is down, repairs it once by a park and a wake, and shows it paused if that did not", async () => {
  const f = await poolFixture("proxy-down");
  try {
    const { counted, physical } = countingStatus(f);
    const home = f.home(undefined, physical, { statusEveryMs: 50 });
    await home.recover();
    expect(home.report()).toBeUndefined();
    // The repair's wake waits here, so the parked guest can be seen: `resuming` says the wake
    // was asked, an event, not a clock.
    const resume = Promise.withResolvers<void>();
    const resuming = Promise.withResolvers<void>();
    f.controller.hold("resume", () => {
      resuming.resolve();
      return resume.promise;
    });
    f.controller.observe({ proxy: "down" });
    // While the repair runs the person is shown it waking, never "paused" first (W10).
    await vi.waitFor(() => expect(home.report()).toMatchObject({ phase: "waking" }));
    expect(home.report()?.proxyDown).toBeUndefined();
    // Nothing holds it: the Home parks it and wakes it again by itself, which is what brings a
    // proxy back. (It used to park and wait for demand to wake: a person watching would have
    // been shown a parked browser.)
    // Parked, its wake held: proxy down is a fact of the running instance, not shown now (W4).
    await resuming.promise;
    expect(["parked", "waking"]).toContain((await f.slot())?.phase);
    expect(home.report()?.proxyDown).toBeUndefined();
    resume.resolve();
    await vi.waitFor(() => expect(f.controller.effects).toEqual(["start", "pause", "resume"]));
    await vi.waitFor(async () => expect((await f.slot())?.phase).toBe("running"));
    // Down again after that wake (a real agent's wake brings it back once): shown paused, and
    // the repair is not made again for this instance, read after read.
    f.controller.observe({ proxy: "down" });
    await vi.waitFor(() => expect(home.report()).toMatchObject({ proxyDown: true }));
    const reads = counted.reads;
    await vi.waitFor(() => expect(counted.reads).toBeGreaterThan(reads + 5));
    expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(await f.slot()).toMatchObject({ phase: "running", failedStarts: 0 });
    // A park that is not a repair, and its wake, are a fresh chance: still down after them, the
    // repair is made once more, and once only.
    expect(await home.tryPark()).toBe("parked");
    (await home.gate.reserve(AbortSignal.timeout(10_000))).release();
    f.controller.observe({ proxy: "down" });
    await vi.waitFor(() =>
      expect(f.controller.effects).toEqual([
        "start",
        "pause",
        "resume",
        "pause",
        "resume",
        "pause",
        "resume",
      ]),
    );
    const again = counted.reads;
    await vi.waitFor(() => expect(counted.reads).toBeGreaterThan(again + 5));
    expect(f.controller.effects).toHaveLength(7);
    f.controller.observe({ proxy: "up" as never });
    await vi.waitFor(() => expect(home.report()).toBeUndefined());
  } finally {
    await f.close();
  }
});

it("waits for a command in flight before it repairs a guest whose egress proxy is down, and never pauses under it", async () => {
  const f = await poolFixture("proxy-down-command");
  try {
    const { counted, physical } = countingStatus(f);
    const home = f.home(undefined, physical, { statusEveryMs: 50 });
    await home.recover();
    // A command in flight: a reservation taken with demand, ended by its own bound.
    const command = await home.gate.reserve(AbortSignal.timeout(10_000));
    f.controller.observe({ proxy: "down" });
    await vi.waitFor(() => expect(home.report()).toMatchObject({ phase: "waking" }));
    const reads = counted.reads;
    await vi.waitFor(() => expect(counted.reads).toBeGreaterThan(reads + 5));
    // Turn after turn, nothing was paused under it.
    expect(f.controller.effects).toEqual(["start"]);
    expect(home.gate.phase).toBe("open");
    command.release();
    // Its end lets the repair go, with no read of the status needed first.
    await vi.waitFor(() => expect(f.controller.effects).toEqual(["start", "pause", "resume"]));
  } finally {
    await f.close();
  }
});

it("repairs a guest whose egress proxy is down while a person watches it: a viewer's sends wait for the wake", async () => {
  const f = await poolFixture("proxy-down-viewer");
  try {
    // Wait on the repair's own events rather than a 1 s clock: observing proxy-down through the
    // real agent takes its host check, status poll, and serialized journal/DB commits for park
    // and wake, none of which wait on the viewer.
    const resumed = Promise.withResolvers<void>();
    const sentAfterWake = Promise.withResolvers<void>();
    let sent = 0;
    let sentAtPause: number | undefined;
    let sentAtResume: number | undefined;
    let resumeApplied = false;
    let waitedForWake = false;
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => f.controller.status(slot, term),
      result: (slot, term, id) => f.controller.result(slot, term, id),
      apply: async (call) => {
        if (call.kind === "pause" && sentAtPause === undefined) sentAtPause = sent;
        const result = await f.controller.apply(call);
        if (call.kind === "resume" && result.applied) {
          sentAtResume = sent;
          resumeApplied = true;
          resumed.resolve();
        }
        return result;
      },
    };
    const home = f.home(undefined, physical, { statusEveryMs: 50 });
    await home.recover();
    // A viewer: sends with no demand (its frames' acknowledgements), one after another, each
    // admitted and released on the next turn of the event loop.
    const watching = new AbortController();
    const viewer = (async () => {
      while (!watching.signal.aborted) {
        const send =
          home.gate.backgroundNow() ??
          (await home.gate.background(watching.signal).catch(() => undefined));
        if (!send) return;
        if (send.waited) waitedForWake = true;
        sent++;
        if (resumeApplied) sentAfterWake.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        send.release();
      }
    })();
    try {
      f.controller.observe({ proxy: "down" });
      await resumed.promise;
      expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
      // No viewer send slipped through between pause and resume.
      expect(sentAtResume).toBe(sentAtPause);
      // The viewer's send waited on the gate and kept sending once the wake reopened it.
      await sentAfterWake.promise;
      expect(waitedForWake).toBe(true);
    } finally {
      watching.abort();
      await viewer;
    }
  } finally {
    await f.close();
  }
});

it("takes a stored, signed fenced answer to the park's retire as final too", async () => {
  const f = await poolFixture("over-fenced-retire");
  try {
    let fenced = false;
    const physical: BrowserPoolPhysicalController = {
      status: (slot, term) => f.controller.status(slot, term),
      result: (slot, term, id) => f.controller.result(slot, term, id),
      // Another term owns the slot now: the controller answers the retire's signature as fenced.
      apply: async (call) =>
        fenced && call.kind === "sign" && call.control?.kind === "retire"
          ? {
              id: call.id,
              applied: false,
              reason: "fenced",
              status: await f.controller.status(call.slotId, call.term),
            }
          : f.controller.apply(call),
    };
    const home = f.home(undefined, physical);
    await home.recover();
    fenced = true;
    expect(await home.tryPark()).toBe("vetoed");
    await vi.waitFor(() => expect(home.report()).toMatchObject({ refused: "fenced" }));
    const asked = Date.now();
    await expect(home.gate.reserve(AbortSignal.timeout(15_000))).rejects.toThrow("not ready");
    expect(Date.now() - asked).toBeLessThan(2_000);
  } finally {
    await f.close();
  }
});

it("stops a guest the controller reports for a removed device that never had a slot row", async () => {
  const f = await poolFixture("removed-no-slot");
  try {
    // A Home started a guest and died before its slot row was written.
    await f.controller.apply({
      id: randomUUID(),
      slotId: "slot-removed-no-slot",
      term: 1,
      kind: "start",
      expect: { instance: null, epoch: null, phase: "stopped", savedStateId: null },
    });
    expect((await f.controller.status("slot-removed-no-slot", 1)).phase).toBe("running");
    // The device was removed meanwhile.
    await f.database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", f.task.runnerId)
      .execute();
    const home = f.home();
    await home.recover();
    await withTimeout(home.released(), 10_000, {
      timeoutError: () => new Error("The removal did not end."),
    });
    expect(f.controller.effects).toEqual(["start", "stop"]);
    expect((await f.controller.status("slot-removed-no-slot", 1)).phase).toBe("stopped");
    expect(await f.slot()).toBeUndefined();
    expect(home.gate.phase).toBe("released");
  } finally {
    await f.close();
  }
});

it("chooses a restart asked while the loop reads the sessions without a channel before their reconnect", async () => {
  const f = await poolFixture("restart-during-scan");
  try {
    const home = f.home(undefined, f.controller, { channelDeadlineMs: 20_000 });
    await home.recover();
    await f.openSession(home);
    let firstAttach: string[] | undefined;
    f.onReattached(async () => {
      firstAttach ??= [...f.controller.effects];
    });
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    f.onScan(async () => {
      f.onScan(undefined);
      reading.resolve();
      await read.promise;
    });
    await f.loseChannel();
    home.channelLost(f.sessionId);
    await reading.promise;
    const restarting = home.restart({ key: "during-scan" });
    read.resolve();
    await restarting;
    // The restart went first: nothing was reattached to the guest it replaced.
    expect(firstAttach).toBeUndefined();
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
  } finally {
    await f.close();
  }
});

describe("with a runtime that cannot always be asked, as a remote one behind a relay", () => {
  it("recovers a parked browser after a Home restart with nothing cached, and wakes it", async () => {
    const f = await poolFixture("remote-parked", { remote: true });
    try {
      const first = f.home();
      await first.recover();
      await f.openSession(first);
      expect(await first.tryPark()).toBe("parked");
      first.close();
      // The new Home has only the slot row and the controller's signed status: paused.
      const next = f.home();
      await withTimeout(next.recover(), 10_000, {
        timeoutError: () => new Error("The parked browser was never recovered."),
      });
      expect(next.gate.phase).toBe("parked");
      expect(f.controller.effects).toEqual(["start", "pause"]);
      // Demand wakes it; the runtime is asked only once the guest runs again.
      (await next.gate.reserve(AbortSignal.timeout(10_000))).release();
      expect(f.controller.effects).toEqual(["start", "pause", "resume"]);
      expect(next.gate.phase).toBe("open");
      expect((await f.row())?.state).toBe("ready");
      expect(await f.slot()).toMatchObject({
        phase: "running",
        outcome: { adopted: [f.sessionId], lost: [] },
      });
    } finally {
      await f.close();
    }
  });

  it("starts a first guest where there is none, asking no runtime before it exists", async () => {
    const f = await poolFixture("remote-first", { remote: true });
    try {
      const home = f.home();
      await withTimeout(home.recover(), 10_000, {
        timeoutError: () => new Error("The first start never installed."),
      });
      expect(f.controller.effects).toEqual(["start"]);
      expect(home.gate.phase).toBe("open");
      await f.admitted();
    } finally {
      await f.close();
    }
  });

  it("removes a device with no guest, with and without a slot row", async () => {
    const never = await poolFixture("remote-removed-never", { remote: true });
    try {
      await never.database
        .updateTable("runners")
        .set({ revokedAt: new Date() })
        .where("id", "=", never.task.runnerId)
        .execute();
      const home = never.home();
      await home.recover();
      await withTimeout(home.released(), 10_000, {
        timeoutError: () => new Error("The removal with no guest did not end."),
      });
      expect(never.controller.effects).toEqual([]);
      expect(await never.slot()).toBeUndefined();
    } finally {
      await never.close();
    }
    const died = await poolFixture("remote-removed-died", { remote: true });
    try {
      const home = died.home();
      await home.recover();
      await died.openSession(home);
      // The guest died: the controller reports it stopped, and there is no runtime to ask.
      died.controller.observe({ phase: "stopped", savedState: null, epoch: null });
      await withTimeout(Promise.all([home.releaseDevice(), home.released()]), 10_000, {
        timeoutError: () => new Error("The removal of a dead guest did not end."),
      });
      expect(died.controller.effects).toEqual(["start"]);
      expect(await died.slot()).toBeUndefined();
      expect((await died.row())?.state).toBe("failed");
    } finally {
      await died.close();
    }
  });
});

it("keeps a restart's hold, and stops nothing, while a holder's outcome could not be written", async () => {
  const f = await poolFixture("restart-settle-fails");
  try {
    const home = f.home(undefined, f.controller, { quiesceMs: 200 });
    await home.recover();
    const order: string[] = [];
    const held = await home.gate.reserve(AbortSignal.timeout(10_000));
    let attempts = 0;
    held.onForcedEnd?.(async () => {
      attempts++;
      if (attempts === 1) {
        order.push(`write failed with ${f.controller.effects.join(",")}`);
        throw new Error("The outcome write failed.");
      }
      order.push(`written with ${f.controller.effects.join(",")}`);
    });
    await withTimeout(home.restart({ key: "settle-fails" }), 20_000, {
      timeoutError: () => new Error("The restart never went on after the write."),
    });
    // The first write failed: the hold stayed and no Stop came until the outcome was written.
    expect(order).toEqual(["write failed with start", "written with start"]);
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
    held.release();
  } finally {
    await f.close();
  }
});

it("sends a restart's applied Start's install again when it never reached the runtime, and starts no other guest", async () => {
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
    // One call id per intent (P1): the applied Start's guest is the restart's, so its install is
    // sent again; no second stop and start.
    expect(f.controller.effects).toEqual(["start", "stop", "start"]);
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
        poolState: async () => {
          const state = f.runtime.poolState() ?? null;
          if (state) seen.push(state.phase);
          return state;
        },
        controlPool: (control, signature) => f.runtime.controlPool(control, signature),
        endSession: (ticket) => f.runtime.endPoolSession(ticket),
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
      // Not known, never "no": the running page's last park is not what it holds now.
      expect.objectContaining({ reason: "person", typed: null }),
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
  const controller = await createPoolController({ slotId: "slot-once", term: 1 });
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
  await controller.close?.();
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
        poolState: async () => {
          const state = f.runtime.poolState()!;
          return dropAfterRetire && state.phase === "retired" ? { ...state, dropped: 1 } : state;
        },
        controlPool: async (control, signature) => {
          const state = await f.runtime.controlPool(control, signature);
          return dropAfterRetire && state.phase === "retired" ? { ...state, dropped: 1 } : state;
        },
        endSession: (ticket) => f.runtime.endPoolSession(ticket),
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
        poolState: async () => {
          if (unreadable > 0) {
            unreadable--;
            return null;
          }
          return f.runtime.poolState() ?? null;
        },
        controlPool: (control, signature) => f.runtime.controlPool(control, signature),
        endSession: (ticket) => f.runtime.endPoolSession(ticket),
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
        poolState: async () => f.runtime.poolState() ?? null,
        controlPool: (control, signature) =>
          control.kind === "release"
            ? Promise.reject(new Error("The release never applies."))
            : f.runtime.controlPool(control, signature),
        endSession: (ticket) => f.runtime.endPoolSession(ticket),
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

it("never serves from a guest whose lost session's pages could not be confirmed closed, and replaces it", async () => {
  // Each start is a fresh guest with an empty runtime, as against the agent: the guest that
  // replaces this one holds none of its stuck pages.
  const f = await poolFixture("end-unconfirmed", { freshGuests: true });
  try {
    const discards: string[] = [];
    const home = f.home(undefined, f.controller, {
      onDiscard: (reason) => discards.push(reason),
    });
    await home.recover();
    await f.openSession(home);
    const other = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await f.openSession(home, other);
    expect(await home.tryPark()).toBe("parked");
    // The first session is not reattached, and its page will not close: every close is taken
    // and none happens (the strongest close the runtime has fails too).
    f.skip.add(f.sessionId);
    const close = FakePage.prototype.close;
    const stuck = vi.spyOn(FakePage.prototype, "close").mockImplementation(async function (
      this: FakePage,
    ) {
      // Until the guest is given up for a fresh one (the loopback guest stands for the next one
      // too, and a fresh guest holds no stuck page).
      if (discards.length) return close.call(this);
      this.closeCount += 1;
    });
    const phases: string[] = [];
    const watched = f.runtime;
    const completes: number[] = [];
    const control = watched.controlPool.bind(watched);
    vi.spyOn(watched, "controlPool").mockImplementation((sent, signature) => {
      if (sent.kind === "complete") completes.push(sent.attempt ?? 0);
      return control(sent, signature);
    });
    const read = watched.poolState.bind(watched);
    vi.spyOn(watched, "poolState").mockImplementation(() => {
      const state = read();
      if (state) phases.push(state.phase);
      return state;
    });
    const woken = await home.gate.reserve(AbortSignal.timeout(30_000));
    woken.release();
    stuck.mockRestore();
    // That guest never served: its adoption failed, and a fresh guest replaced it (V2).
    expect(phases).not.toContain("running");
    expect(f.controller.effects.slice(0, 3)).toEqual(["start", "pause", "resume"]);
    expect(f.controller.effects.slice(3)).toContain("start");
    // At once, with that reason: the refusal reached the loop (W3), after one adoption's
    // complete, not after six wakes as unrecoverable.
    expect(discards).toEqual(["end-unconfirmed"]);
    expect(completes).toHaveLength(1);
    // Both sessions ended with the replaced guest, with their notes; none is closed on a guess.
    expect((await f.row(f.sessionId))?.state).toBe("failed");
    expect((await f.row(other))?.state).toBe("failed");
  } finally {
    await f.close();
  }
});

it("clears a prior refusal when a follow-up wake goes unanswered instead of repeating the stale refusal", async () => {
  const f = await poolFixture("refusal-then-silence");
  try {
    let mode: "normal" | "refuse" | "silent" = "normal";
    const port: BrowserPoolPhysicalController = {
      status: (slot, term) =>
        mode === "silent"
          ? Promise.reject(
              Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
            )
          : f.controller.status(slot, term),
      result: (slot, term, id) =>
        mode === "silent"
          ? Promise.reject(
              Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
            )
          : f.controller.result(slot, term, id),
      apply: async (call) => {
        if (mode === "silent") {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }
        if (mode === "refuse" && (call.kind === "resume" || call.kind === "start")) {
          return {
            id: call.id,
            applied: false,
            reason: "egress-required",
            status: await f.controller.status(call.slotId, call.term),
          };
        }
        return f.controller.apply(call);
      },
    };
    const home = f.home(undefined, port, {
      unreachableAfterMs: 30,
      refusedRetryMs: 10_000,
    });
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");

    // First wake is refused by the controller.
    mode = "refuse";
    await expect(
      home.gate.reserve(AbortSignal.timeout(5_000), { failOnRefusal: true }),
    ).rejects.toBeInstanceOf(BrowserPoolAttemptRefused);
    expect(home.report()?.refused).toBe("egress-required");

    // Next wake goes unanswered (host outage): the stale refusal must clear and unreachable take over.
    mode = "silent";
    await expect(
      home.gate.reserve(AbortSignal.timeout(150), { failOnRefusal: true }),
    ).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
    expect(home.unanswered).toBe(true);
    expect(home.report()?.refused).toBeUndefined();
    expect(home.report()?.unreachable).toBe(true);
  } finally {
    await f.close();
  }
});

it("delivers a refusal after an outage without waiting for the database announce bound", async () => {
  const f = await poolFixture("outage-then-refusal");
  try {
    let mode: "normal" | "silent" | "refuse" = "normal";
    let refusalReturned = false;
    let releaseAnnounce: (() => void) | undefined;
    let holdNextAnnounce = false;
    const rawConnection = f.database.connection.bind(f.database);
    vi.spyOn(f.database, "connection").mockImplementation(() => {
      const builder = rawConnection();
      const rawExecute = builder.execute.bind(builder);
      builder.execute = async (...args) => {
        if (holdNextAnnounce) {
          holdNextAnnounce = false;
          await new Promise<void>((resolve) => {
            releaseAnnounce = resolve;
          });
        }
        return rawExecute(...args);
      };
      return builder;
    });
    const port: BrowserPoolPhysicalController = {
      status: (slot, term) =>
        mode === "silent"
          ? Promise.reject(
              Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
            )
          : f.controller.status(slot, term),
      result: (slot, term, id) =>
        mode === "silent"
          ? Promise.reject(
              Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
            )
          : f.controller.result(slot, term, id),
      apply: async (call) => {
        if (mode === "silent") {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }
        if (mode === "refuse" && (call.kind === "resume" || call.kind === "start")) {
          refusalReturned = true;
          return {
            id: call.id,
            applied: false,
            reason: "egress-required",
            status: await f.controller.status(call.slotId, call.term),
          };
        }
        return f.controller.apply(call);
      },
    };
    const home = f.home(undefined, port, {
      unreachableAfterMs: 20,
      unansweredRetryMaxMs: 20,
      refusedRetryMs: 10_000,
      onStateChanged: () => {
        if (refusalReturned) {
          refusalReturned = false;
          holdNextAnnounce = true;
        }
      },
    });
    await home.recover();
    await f.openSession(home);
    expect(await home.tryPark()).toBe("parked");

    // Put the coordinator into unreachable state first.
    mode = "silent";
    await expect(
      home.gate.reserve(AbortSignal.timeout(120), { failOnRefusal: true }),
    ).rejects.toBeInstanceOf(BrowserPoolAdmissionClosed);
    await vi.waitFor(() => expect(home.report()?.unreachable).toBe(true), { timeout: 2_000 });

    // Now the host answers with a refusal while the DB announce is stalled: the waiting caller
    // must receive BrowserPoolAttemptRefused immediately, not miss its deadline waiting on #announce.
    mode = "refuse";
    try {
      await expect(
        home.gate.reserve(AbortSignal.timeout(250), { failOnRefusal: true }),
      ).rejects.toMatchObject({
        name: "BrowserPoolAttemptRefused",
        refusedReason: "egress-required",
      });
      expect(home.report()?.unreachable).toBeUndefined();
      expect(home.report()?.refused).toBe("egress-required");
    } finally {
      releaseAnnounce?.();
    }
  } finally {
    await f.close();
  }
});
