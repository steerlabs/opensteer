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
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";
import { createPoolController } from "./browser-pool-controller-under-test.test-support.js";

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

async function pair(key: string) {
  const fixture = await createStoreFixture();
  open.push(() => fixture.close());
  const task = await fixture.createRunFixture(key);
  const slotId = `slot-${key}`;
  const controller = await createPoolController({ slotId, term: 1, freshGuests: true });
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
  controller.apply = async (call) => {
    const starts = controller.effects.filter((effect) => effect === "start").length;
    const result = await apply(call).finally(() => answered.push(call.kind));
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
    };
    const port: BrowserPoolPhysicalController = crash
      ? {
          status: (slot, term) => crash.pass("status", () => controller.status(slot, term)),
          result: (slot, term, id) => crash.pass("result", () => controller.result(slot, term, id)),
          apply: (call) => crash.pass(call.kind, () => controller.apply(call)),
        }
      : controller;
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
    home,
    slot: () => readBrowserPoolSlot(fixture.database, task.runnerId),
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
