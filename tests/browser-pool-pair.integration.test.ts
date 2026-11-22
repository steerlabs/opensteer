// The Home and the pool agent as the pair that will run: the Home's coordinator and real
// controller client against the real agent on a fake hypervisor, over its signed HTTP interface.
// These are the cases only the pair can prove (P1 and finding 2); the agent's own suite and the
// coordinator suite stay where they are.
(globalThis as { opensteerPoolController?: string }).opensteerPoolController = "agent";

import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserPoolAgentClient,
  BrowserPoolAgentSlotDeleted,
  BrowserPoolAgentUnavailable,
} from "../apps/host/src/browser/browser-pool-agent-client.js";
import {
  expectationOf,
  type BrowserPoolControllerCall,
  type BrowserPoolControllerResult,
  type BrowserPoolPhysicalController,
} from "../apps/host/src/browser/browser-pool-controller.js";
import {
  BrowserPoolCoordinator,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import {
  homeKeyPair,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import type { BrowserPoolControl } from "../packages/browser-runtime-core/src/browser-pool.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeTicketVerifier,
  testSessionFilesRoot,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import { readBrowserPoolSlot } from "../packages/database/src/browser-pool-store.js";
import { databaseOperation } from "../packages/database/src/operation-budget.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import {
  createBrowserSession,
  getBrowserSessionForOwner,
  transitionBrowserSession,
} from "../packages/database/src/browser-session-store.js";
import { BrowserSessionIdSchema } from "../packages/protocol/src/browser.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import { createPoolController } from "./browser-pool-controller-under-test.test-support.js";
import { FakeHypervisorDriver } from "../apps/pool-agent/src/fake-driver.test-support.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function agentSlot(slotId: string, term = 1, agent?: TestPoolAgent) {
  const running = agent ?? (await startTestPoolAgent());
  if (!agent) open.push(() => running.close());
  const home = homeKeyPair();
  const summary = await running.agent.createSlot({
    slotId,
    term,
    homeKey: home.spki,
    guest: testGuest,
  });
  const agentKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  const client = (fetchHook?: typeof fetch) =>
    new BrowserPoolAgentClient({
      url: running.url,
      homeKey: home.privateKey,
      agentKey,
      hostKey: running.hostPublicKey,
      ...(fetchHook ? { fetch: fetchHook } : {}),
    });
  return { agent: running, home, agentKey, client };
}

/** A fetch that keeps each genuine reply body, so a later request can be given an earlier one. */
function recorder() {
  const bodies: string[] = [];
  let substitute: string | undefined;
  const hook: typeof fetch = async (input, init) => {
    const answer = await fetch(input, init);
    const body = await answer.text();
    bodies.push(body);
    return new Response(substitute ?? body, { status: answer.status });
  };
  return {
    hook,
    bodies,
    answerWith: (body: string) => {
      substitute = body;
    },
  };
}

// ---- Finding 2: an answer is authenticated and bound to slot, term and request ----------------

it("refuses, at the real client, a genuine status of another slot", async () => {
  const a = await agentSlot("slot-a");
  const b = await agentSlot("slot-b", 1, a.agent);
  const ofB = recorder();
  await b.client(ofB.hook).status("slot-b", 1);
  const toA = recorder();
  toA.answerWith(ofB.bodies[0]!);
  await expect(a.client(toA.hook).status("slot-a", 1)).rejects.toThrow(BrowserPoolAgentUnavailable);
  await expect(a.client(toA.hook).status("slot-a", 1)).rejects.toThrow("not signed by the slot");
});

it("refuses, at the real client, a genuine status of an older term given for a newer one", async () => {
  const a = await agentSlot("slot-term");
  const network = recorder();
  const client = a.client(network.hook);
  await client.status("slot-term", 1);
  network.answerWith(network.bodies[0]!);
  await expect(client.status("slot-term", 2)).rejects.toThrow("not signed by the slot");
});

it("refuses, at the real client, a replayed reply to an earlier request of the same slot and term", async () => {
  const a = await agentSlot("slot-replay");
  const network = recorder();
  const client = a.client(network.hook);
  const first = await client.status("slot-replay", 1);
  expect(first.phase).toBe("stopped");
  network.answerWith(network.bodies[0]!);
  await expect(client.status("slot-replay", 1)).rejects.toThrow("not signed by the slot");
});

// ---- P1: the agent's fence for a late Start ----------------------------------------------------

it("refuses a Start that arrives after its slot was deleted, by its term, and starts nothing", async () => {
  const a = await agentSlot("slot-late");
  const client = a.client();
  const status = await client.status("slot-late", 1);
  // The Home sent this Start; it reaches the agent only after the removal deleted the slot.
  const late: BrowserPoolControllerCall = {
    id: randomUUID(),
    slotId: "slot-late",
    term: 1,
    kind: "start",
    expect: expectationOf(status),
  };
  await a.agent.agent.deleteSlot("slot-late", 1);
  await expect(client.apply(late)).rejects.toThrow(BrowserPoolAgentSlotDeleted);
  // The slot made again for another Home, at a newer term: the old term's Start is still refused.
  const again = await agentSlot("slot-late", 2, a.agent);
  const outcome: BrowserPoolControllerResult | Error = await client.apply(late).then(
    (result) => result,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (!(outcome instanceof Error)) expect(outcome.applied).toBe(false);
  expect(a.agent.agent.effects("slot-late")).not.toContain("start");
  expect((await again.client().status("slot-late", 2)).phase).toBe("stopped");
});

// ---- P1: one call id per intent, through the coordinator --------------------------------------

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

/** The agent on a fake hypervisor whose profile disk can go and come back. */
async function mountedAgentController(
  slotId: string,
  driver = new FakeHypervisorDriver({ startsEmpty: true, profilesMount: {} }),
) {
  driver.profilesMounted = true;
  const agent = await startTestPoolAgent({ driver });
  const home = homeKeyPair();
  const summary = await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: home.spki,
    guest: testGuest,
  });
  const publicKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  const client = new BrowserPoolAgentClient({
    url: agent.url,
    homeKey: home.privateKey,
    agentKey: publicKey,
    // The host key alone signs the answer that the slot was deleted.
    hostKey: agent.hostPublicKey,
  });
  const visible = new Set(["start", "pause", "resume", "stop"]);
  /** The ids the Home asked the result of: it does so when a call's answer did not come. */
  const asked: string[] = [];
  return {
    driver,
    agent,
    asked,
    controller: {
      publicKey,
      get effects() {
        return agent.agent.effects(slotId).filter((effect) => visible.has(effect));
      },
      status: (slot: string, term: number) => client.status(slot, term),
      result: (slot: string, term: number, id: string) => {
        asked.push(id);
        return client.result(slot, term, id);
      },
      apply: (call: BrowserPoolControllerCall) => client.apply(call),
      hold: () => {
        throw new Error("Not held here.");
      },
      close: () => agent.close(),
    },
  };
}

async function pair(key: string, mounted?: Awaited<ReturnType<typeof mountedAgentController>>) {
  const fixture = await createStoreFixture();
  open.push(() => fixture.close());
  const task = await fixture.createRunFixture(key);
  const slotId = `slot-${key}`;
  const controller = (mounted?.controller ??
    (await createPoolController({ slotId, term: 1, freshGuests: true }))) as Awaited<
    ReturnType<typeof createPoolController>
  >;
  open.push(async () => controller.close?.());
  const verifier = new FakeTicketVerifier();
  const newRuntime = () =>
    new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
      runtimeId: "pool-runtime",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
      pool: { controllerKey: controller.publicKey as KeyObject, probePage: async () => [] },
    });
  let runtime = newRuntime();
  open.push(() => runtime.shutdown());
  // A guest the agent started is a new runtime; a stored answer read again starts nothing.
  const apply = controller.apply.bind(controller);
  /** Each call the agent answered (or failed), by kind, once its request ended. */
  const answered: string[] = [];
  /** When each answer came back, by kind. */
  const answeredAt: { readonly kind: string; readonly at: number }[] = [];
  controller.apply = async (call) => {
    const starts = controller.effects.filter((effect) => effect === "start").length;
    const result = await apply(call).finally(() => {
      answered.push(call.kind);
      answeredAt.push({ kind: call.kind, at: Date.now() });
    });
    if (controller.effects.filter((effect) => effect === "start").length > starts) {
      const old = runtime;
      runtime = newRuntime();
      await old.shutdown().catch(() => undefined);
    }
    return result;
  };
  const homes: BrowserPoolCoordinator[] = [];
  open.push(async () => {
    for (const home of homes) home.close();
  });
  const home = (
    crash?: Crash,
    options: {
      /** Runs before every read of the runtime's state; a throw is a read that failed. */
      readingState?: () => Promise<void>;
      /** While false, every controller call fails as a pool host that cannot be reached. */
      reachable?: () => boolean;
      /** Runs before a runtime control is handed to the runtime, which then gets it as sent. */
      sending?: (control: BrowserPoolControl) => Promise<void>;
      /** The runtime's own answer to each control it was handed, whoever still waits for it. */
      landed?: (control: BrowserPoolControl, answer: Promise<unknown>) => void;
      extra?: Partial<ConstructorParameters<typeof BrowserPoolCoordinator>[0]>;
    } = {},
  ) => {
    const deliver = async (control: BrowserPoolControl, signature: Uint8Array) => {
      await options.sending?.(control);
      const answer = runtime.controlPool(control, signature);
      options.landed?.(control, answer);
      return answer;
    };
    const channel: BrowserPoolRuntimeChannel = {
      poolState: async () => {
        await options.readingState?.();
        return runtime.poolState() ?? null;
      },
      controlPool: (control, signature) =>
        crash
          ? crash.pass(`runtime:${control.kind}`, () => deliver(control, signature))
          : deliver(control, signature),
      endSession: (ticket) => runtime.endPoolSession(ticket),
    };
    const reach = <T>(call: () => Promise<T>) =>
      options.reachable && !options.reachable()
        ? Promise.reject(new Error("The pool host cannot be reached."))
        : call();
    const port: BrowserPoolPhysicalController = crash
      ? {
          status: (slot, term) => crash.pass("status", () => controller.status(slot, term)),
          result: (slot, term, id) => crash.pass("result", () => controller.result(slot, term, id)),
          apply: (call) => crash.pass(call.kind, () => controller.apply(call)),
        }
      : {
          status: (slot, term) => reach(() => controller.status(slot, term)),
          result: (slot, term, id) => reach(() => controller.result(slot, term, id)),
          apply: (call) => reach(() => controller.apply(call)),
        };
    const coordinator = new BrowserPoolCoordinator({
      database: fixture.database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId,
      term: 1,
      runtime: channel,
      controller: port,
      retryMs: 5,
      ...options.extra,
    });
    homes.push(coordinator);
    return coordinator;
  };
  return {
    controller,
    answered,
    /** When each answer of this kind came back. */
    times: (kind: string) => answeredAt.filter((entry) => entry.kind === kind).map(({ at }) => at),
    home,
    slot: () => readBrowserPoolSlot(fixture.database, task.runnerId),
    fixture,
    task,
    runtime: () => runtime,
    status: () => controller.status(slotId, 1),
  };
}

it.each([
  ["after its Start applied, before the answer was written", "start", "after"],
  [
    "after its Start's answer was written, before the guest was installed",
    "runtime:install",
    "before",
  ],
] as const)(
  "replaces the guest once for a restart a Home crash interrupted %s",
  async (_when, kind, when) => {
    const p = await pair(`once-${kind.replace(":", "-")}`);
    const crash = new Crash();
    const first = p.home(crash);
    await first.recover();
    expect(p.controller.effects).toEqual(["start"]);
    crash.arm(kind, when);
    void first.restart({ key: "once" }).catch(() => undefined);
    await vi.waitFor(() => expect(p.controller.effects).toEqual(["start", "stop", "start"]));
    await vi.waitFor(() => expect(crash.dead).toBe(true));
    first.close();
    const next = p.home();
    await next.recover();
    await vi.waitFor(async () =>
      expect(await p.slot()).toMatchObject({ phase: "running", restartKeys: ["once"] }),
    );
    // The applied Start's guest is the restart's: it is installed, never replaced again.
    expect(p.controller.effects).toEqual(["start", "stop", "start"]);
    const fence = (await p.status()).instance;
    expect((await p.slot())?.instanceId).toBe(fence);
    await next.restart({ key: "once" });
    expect(p.controller.effects).toEqual(["start", "stop", "start"]);
    expect(next.gate.phase).toBe("open");
  },
);

it("settles a Start still outstanding before a removal accepts stopped, so nothing starts after it", async () => {
  const p = await pair("removal-start");
  const first = p.home();
  await first.recover();
  // The restart's Start leaves the Home and is held on its way to the agent.
  const arrive = Promise.withResolvers<void>();
  p.controller.hold("start", () => arrive.promise);
  void first.restart({ key: "held" }).catch(() => undefined);
  await vi.waitFor(() => expect(p.controller.effects).toEqual(["start", "stop"]));
  await first.releaseDevice();
  await first.released();
  // The removal sent the same Start again by its id and stopped what it started.
  expect((await p.status()).phase).toBe("stopped");
  const afterRemoval = [...p.controller.effects];
  expect(afterRemoval.at(-1)).toBe("stop");
  // The held request arrives at last: the same id has its answer, and nothing starts.
  const starts = p.answered.filter((kind) => kind === "start").length;
  arrive.resolve();
  await vi.waitFor(() =>
    expect(p.answered.filter((kind) => kind === "start").length).toBe(starts + 1),
  );
  expect(p.controller.effects).toEqual(afterRemoval);
  expect((await p.status()).phase).toBe("stopped");
});

// ---- P3: a step's waits end with it; what it sent is fenced and read later --------------------

it("takes a restart asked while a step is failing at once, never after that step's backoff", async () => {
  const p = await pair("backoff");
  await p.home().recover();
  // A Home restart whose first read of the runtime fails, slowly; the backoff after a failure
  // is up to five seconds.
  const reading = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  let failed = false;
  const next = p.home(undefined, {
    readingState: async () => {
      if (failed) return;
      reading.resolve();
      await fail.promise;
      failed = true;
      throw new Error("The runtime read failed.");
    },
    extra: { retryMs: 60_000 },
  });
  void next.recover();
  await reading.promise;
  // Asked during the failing step: the turn's own change ends the backoff that follows it.
  const restarted = next.restart({ key: "during-backoff" });
  fail.resolve();
  const asked = Date.now();
  await restarted;
  expect(Date.now() - asked).toBeLessThan(4_000);
  expect(p.controller.effects).toEqual(["start", "stop", "start"]);
});

it("refuses a runtime control that lands after its step stopped waiting, by its sequence, and reads what is so", async () => {
  const p = await pair("late-control");
  // The retire leaves the Home and reaches the runtime only after the Home gave up on it and
  // released the intent.
  const late = Promise.withResolvers<void>();
  let held: BrowserPoolControl | undefined;
  let lateAnswer: Promise<unknown> | undefined;
  const home = p.home(undefined, {
    sending: async (control) => {
      if (control.kind !== "retire" || held) return;
      held = control;
      await late.promise;
    },
    landed: (control, answer) => {
      if (control === held) lateAnswer = answer;
      void answer.catch(() => undefined);
    },
    extra: { callTimeoutMs: 300 },
  });
  await home.recover();
  const parking = home.tryPark();
  await vi.waitFor(() => expect(held).toBeDefined());
  // The step read the runtime's state when the retire did not answer, and released the intent.
  expect(await parking).toBe("vetoed");
  const released = p.runtime().poolState();
  expect(released).toMatchObject({ phase: "running", cancelled: true });
  // The late retire lands now, after a newer control of the same slot: it is refused.
  late.resolve();
  await vi.waitFor(() => expect(lateAnswer).toBeDefined());
  await expect(lateAnswer).rejects.toThrow();
  expect(p.runtime().poolState()).toMatchObject({
    phase: "running",
    retired: null,
    revision: released?.revision,
  });
  expect((await p.slot())?.phase).toBe("running");
  expect(home.gate.phase).toBe("open");
});

// ---- A refusal the Home does not know: not started, asked again later -------------------------

it("keeps a cold start the agent refuses for a missing profile disk not started, spaced, and starts once the disk is back", async () => {
  const mounted = await mountedAgentController("slot-disk-start");
  const p = await pair("disk-start", mounted);
  mounted.driver.profilesMounted = false;
  const home = p.home(undefined, { extra: { refusedRetryMs: 300 } });
  const recovered = home.recover();
  void recovered.catch(() => undefined);
  await vi.waitFor(() => expect(p.times("start").length).toBeGreaterThanOrEqual(3), {
    timeout: 15_000,
  });
  const [first, second, third] = p.times("start");
  // Not a lost profile, not a deleted or replaced slot: nothing was booted and nothing ended.
  expect(p.controller.effects).toEqual([]);
  expect(await p.slot()).toBeUndefined();
  expect(mounted.agent.agent.slotIds()).toContain("slot-disk-start");
  // Asked again later, each time later still: never in a loop.
  expect(second! - first!).toBeGreaterThanOrEqual(250);
  expect(third! - second!).toBeGreaterThanOrEqual(500);
  // The reason reaches the report, where the words a person sees are chosen.
  expect(home.report()).toMatchObject({ refused: "profile-disk-missing" });
  // The disk is back; the person asks for the browser: the same start goes through.
  mounted.driver.profilesMounted = true;
  const held = await home.gate.reserve(AbortSignal.timeout(20_000));
  held.release();
  await recovered;
  expect(p.controller.effects).toEqual(["start"]);
  expect(home.report()).toBeUndefined();
});

it("keeps a parked browser whose wake from disk the agent refuses for a missing profile disk, and wakes it once the disk is back", async () => {
  const mounted = await mountedAgentController("slot-disk-wake");
  const p = await pair("disk-wake", mounted);
  const home = p.home(undefined, { extra: { refusedRetryMs: 300 } });
  await home.recover();
  expect(await home.tryPark()).toBe("parked");
  // The host has written the parked guest to disk, and then lost its profile disk.
  const saved = (await p.status()).savedState!;
  await mounted.agent.agent.saveToDisk("slot-disk-wake", saved.id);
  mounted.driver.profilesMounted = false;
  // A person waits for the browser all along.
  const waiting = home.gate.reserve(AbortSignal.timeout(30_000));
  void waiting.catch(() => undefined);
  await vi.waitFor(() => expect(p.times("resume").length).toBeGreaterThanOrEqual(3), {
    timeout: 15_000,
  });
  const [first, second, third] = p.times("resume");
  // Its saved state is kept: never discarded for a fresh guest, nothing stopped or started.
  expect(p.controller.effects).toEqual(["start", "pause"]);
  expect((await p.status()).savedState?.id).toBe(saved.id);
  expect((await p.slot())?.phase).not.toBe("running");
  // Asked again later, each time later still, though a person is waiting: never in a loop.
  expect(second! - first!).toBeGreaterThanOrEqual(250);
  expect(third! - second!).toBeGreaterThanOrEqual(500);
  expect(home.report()).toMatchObject({ refused: "profile-disk-missing" });
  // The disk is back: the same browser wakes, from the state it saved.
  mounted.driver.profilesMounted = true;
  const again = await home.gate.reserve(AbortSignal.timeout(20_000));
  again.release();
  (await waiting).release();
  expect(p.controller.effects).toEqual(["start", "pause", "resume"]);
  expect((await p.slot())?.phase).toBe("running");
});

// ---- P7: removal closes a stopped session only with the guest's end ----------------------------

it("keeps a stopped session closing through a removal until the guest is known stopped", async () => {
  const p = await pair("removal-closing");
  let reachable = true;
  const home = p.home(undefined, { reachable: () => reachable });
  await home.recover();
  const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
  await createBrowserSession(p.fixture.database, {
    id: sessionId,
    ownerId: p.task.userId,
    opener: { kind: "person", userId: p.task.userId },
    origin: "person",
    placementKey: "pool-test",
    profileId: null,
    runnerId: p.task.runnerId,
    runtimeId: "pool-runtime",
  });
  await transitionBrowserSession(p.fixture.database, { sessionId, state: "ready" });
  await transitionBrowserSession(p.fixture.database, { sessionId, state: "closing" });
  // The pool host cannot be reached: the removal begins, and nothing shows the guest stopped.
  reachable = false;
  await home.releaseDevice();
  const state = async () =>
    (await getBrowserSessionForOwner(p.fixture.database, sessionId, p.task.userId))?.state;
  expect(await state()).toBe("closing");
  // Reached again: the guest is stopped with evidence, and only then is the session closed.
  reachable = true;
  await home.released();
  expect((await p.status()).phase).toBe("stopped");
  expect(await state()).toBe("closed");
});

// ---- P9: the choice of the next step has a bound, and a removal ends it ------------------------

it("lets a removal end a choice of the next step stuck on its read", async () => {
  const p = await pair("stuck-selection");
  let stall = false;
  let stalled = false;
  const home = p.home(undefined, {
    extra: {
      testHooks: {
        // A read that waits as a statement would on a lock: only its operation's signal ends it.
        readSlot: (async (...args: Parameters<typeof readBrowserPoolSlot>) => {
          if (!stall) return readBrowserPoolSlot(...args);
          stall = false;
          stalled = true;
          const operation = databaseOperation();
          return new Promise((_, reject) =>
            operation?.signal.addEventListener("abort", () => reject(operation.signal.reason), {
              once: true,
            }),
          );
        }) as typeof readBrowserPoolSlot,
      },
    },
  });
  await home.recover();
  stall = true;
  // Something wanted makes the loop choose again; its read of the slot is stuck.
  void home.tryPark().catch(() => undefined);
  await vi.waitFor(() => expect(stalled).toBe(true));
  await withTimeout(
    (async () => {
      await home.releaseDevice();
      await home.released();
    })(),
    10_000,
    { timeoutError: () => new Error("The removal waits behind a stuck choice of the next step.") },
  );
  expect((await p.status()).phase).toBe("stopped");
});

// ---- P10: a signed answer that the target is over is final ------------------------------------

it("finishes a removal whose slot the host already deleted, on the host's signed word", async () => {
  const mounted = await mountedAgentController("slot-over-release");
  const p = await pair("over-release", mounted);
  const home = p.home();
  await home.recover();
  await mounted.agent.agent.deleteSlot("slot-over-release");
  await withTimeout(
    (async () => {
      await home.releaseDevice();
      await home.released();
    })(),
    10_000,
    { timeoutError: () => new Error("The removal is still asking a deleted slot.") },
  );
  expect(await p.slot()).toBeUndefined();
});

it("ends the sessions of a browser whose slot the host deleted, sends nothing more, and refuses callers at once", async () => {
  const mounted = await mountedAgentController("slot-over-running");
  const p = await pair("over-running", mounted);
  const home = p.home();
  await home.recover();
  const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
  await createBrowserSession(p.fixture.database, {
    id: sessionId,
    ownerId: p.task.userId,
    opener: { kind: "person", userId: p.task.userId },
    origin: "person",
    placementKey: "pool-test",
    profileId: null,
    runnerId: p.task.runnerId,
    runtimeId: "pool-runtime",
  });
  await transitionBrowserSession(p.fixture.database, { sessionId, state: "ready" });
  await mounted.agent.agent.deleteSlot("slot-over-running");
  // The person's restart reaches the host, which says, signed, that the slot is gone.
  await expect(
    withTimeout(home.restart({ key: "over" }), 10_000, {
      timeoutError: () => new Error("The restart is still asking a deleted slot."),
    }),
  ).rejects.toThrow("not ready");
  expect(
    (await getBrowserSessionForOwner(p.fixture.database, sessionId, p.task.userId))?.state,
  ).toBe("failed");
  // A caller is refused at once rather than at its deadline, and nothing more reaches the host.
  const asked = Date.now();
  await expect(home.gate.reserve(AbortSignal.timeout(15_000))).rejects.toThrow("not ready");
  expect(Date.now() - asked).toBeLessThan(2_000);
  expect(home.report()).toMatchObject({ refused: "slot-deleted" });
  const calls = p.answered.length;
  await home.restart().catch(() => undefined);
  expect(p.answered.length).toBe(calls);
});

// ---- P11: a refused wake goes back to parked, and a refusal is not a failed start -------------

it("returns a refused wake to parked, and counts a refused restart as no failed start", async () => {
  const mounted = await mountedAgentController("slot-refused-parked");
  const p = await pair("refused-parked", mounted);
  const home = p.home(undefined, { extra: { refusedRetryMs: 60_000 } });
  await home.recover();
  expect(await home.tryPark()).toBe("parked");
  const saved = (await p.status()).savedState!;
  await mounted.agent.agent.saveToDisk("slot-refused-parked", saved.id);
  mounted.driver.profilesMounted = false;
  const wanting = new AbortController();
  void home.gate.reserve(wanting.signal).catch(() => undefined);
  await vi.waitFor(() => expect(p.times("resume").length).toBeGreaterThanOrEqual(1));
  // Refused with its saved state kept: parked again, so nothing wakes it while nobody waits.
  await vi.waitFor(async () => expect((await p.slot())?.phase).toBe("parked"));
  wanting.abort();
  mounted.driver.profilesMounted = true;
  const again = await home.gate.reserve(AbortSignal.timeout(20_000));
  again.release();
  expect(p.controller.effects).toEqual(["start", "pause", "resume"]);
  // A restart the controller refuses is reported with its reason, never counted as failed.
  mounted.driver.profilesMounted = false;
  void home.restart({ key: "refused" }).catch(() => undefined);
  await vi.waitFor(() => expect(home.report()).toMatchObject({ refused: "profile-disk-missing" }));
  expect((await p.slot())?.failedStarts).toBe(0);
});

// ---- P13: one id for a stop within a restart; a failed mark is not a failed start -------------

it("sends a restart's stop again by its own id after a Home went, and never counts a failed mark as a failed start", async () => {
  const p = await pair("stop-once");
  const crash = new Crash();
  const first = p.home(crash);
  await first.recover();
  // The stop applies and the Home goes before its answer is written.
  crash.arm("stop", "after");
  void first.restart({ key: "stop-once" }).catch(() => undefined);
  await vi.waitFor(() => expect(crash.dead).toBe(true));
  first.close();
  let marks = 0;
  const next = p.home(undefined, {
    extra: {
      testHooks: {
        markInstalled: async () => {
          marks++;
          throw new Error("The mark could not be written.");
        },
      },
    },
  });
  await next.recover();
  await vi.waitFor(async () =>
    expect(await p.slot()).toMatchObject({ phase: "running", restartKeys: ["stop-once"] }),
  );
  expect(p.controller.effects).toEqual(["start", "stop", "start"]);
  // The stop's journal row has its own answer, by its id: never closed as superseded.
  const stops = await p.fixture.database
    .selectFrom("browserPoolControllerCalls")
    .select("result")
    .where("kind", "=", "stop")
    .execute();
  expect(stops).toEqual([{ result: expect.objectContaining({ applied: true }) }]);
  // The slot holds the guest; a mark that failed leaves no "failed" behind.
  expect(marks).toBeGreaterThan(0);
  expect(next.report()).toBeUndefined();
  expect((await p.slot())?.failedStarts).toBe(0);
});

// ---- P14: a driver slower than the Home's call timeout ----------------------------------------

/**
 * Boot, restore and kill wait, while slow, until the test lets them go: as Firecracker's do,
 * longer than the Home's call timeout (the agent's own deadlines are 30 s; the Home's 10 s).
 */
class SlowDriver extends FakeHypervisorDriver {
  /** The kinds that are slow now; the others go at once (a start's own cleanup kill included). */
  readonly slow = new Set<string>();
  #release = Promise.withResolvers<void>();
  readonly waiting: string[] = [];
  letGo(): void {
    this.#release.resolve();
    this.#release = Promise.withResolvers<void>();
  }
  async #wait(kind: string): Promise<void> {
    if (!this.slow.has(kind)) return;
    this.waiting.push(kind);
    await withTimeout(this.#release.promise, 60_000, {
      timeoutError: () => new Error(`The slow ${kind} was never let go.`),
    });
  }
  override async boot(...args: Parameters<FakeHypervisorDriver["boot"]>): Promise<void> {
    await this.#wait("boot");
    return super.boot(...args);
  }
  override async restore(...args: Parameters<FakeHypervisorDriver["restore"]>): Promise<void> {
    await this.#wait("restore");
    return super.restore(...args);
  }
  override async kill(...args: Parameters<FakeHypervisorDriver["kill"]>): Promise<void> {
    await this.#wait("kill");
    return super.kill(...args);
  }
}

it("waits out a slow boot, restore and kill by asking for the result by id, and neither starts twice nor discards", async () => {
  const driver = new SlowDriver({ startsEmpty: true, profilesMount: {} });
  driver.profilesMounted = true;
  const mounted = await mountedAgentController("slot-slow-driver", driver);
  const p = await pair("slow-driver", mounted);
  const home = p.home(undefined, { extra: { callTimeoutMs: 400 } });
  const slowly = async (kind: string, work: () => Promise<unknown>) => {
    const asked = mounted.asked.length;
    const waits = driver.waiting.filter((entry) => entry === kind).length;
    driver.slow.add(kind);
    const done = work();
    // The Home's call timed out and it asked for the result by its id; only then is it let go.
    await vi.waitFor(
      () => {
        expect(driver.waiting.filter((entry) => entry === kind).length).toBe(waits + 1);
        expect(mounted.asked.length).toBeGreaterThan(asked);
      },
      { timeout: 15_000 },
    );
    driver.slow.delete(kind);
    driver.letGo();
    await done;
  };
  // A cold start whose boot is slower than the call timeout.
  await slowly("boot", () => home.recover());
  expect(p.controller.effects).toEqual(["start"]);
  // A wake from disk whose restore is slower.
  expect(await home.tryPark()).toBe("parked");
  const saved = (await p.status()).savedState!;
  await mounted.agent.agent.saveToDisk("slot-slow-driver", saved.id);
  await slowly("restore", async () => {
    const held = await home.gate.reserve(AbortSignal.timeout(30_000));
    held.release();
  });
  expect(p.controller.effects).toEqual(["start", "pause", "resume"]);
  // A restart whose stop's kill is slower.
  await slowly("kill", () => home.restart({ key: "slow" }));
  expect(p.controller.effects).toEqual(["start", "pause", "resume", "stop", "start"]);
  expect(driver.boots.length).toBe(3);
  expect((await p.slot())?.failedStarts).toBe(0);
  expect(home.gate.phase).toBe("open");
});
