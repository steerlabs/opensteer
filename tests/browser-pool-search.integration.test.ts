// V9: a test that searches. Seeded random schedules over the real guest runtime (pages from the
// fake launcher), the real store on PostgreSQL, the real coordinator and BrowserService, and the
// real pool agent (fake hypervisor, pulling each slot's egress) behind its signed client. A step
// may overlap the next one, started a seeded number of turns before it. After every step, and at
// rest, it checks what must always hold. Each schedule prints its seed and its steps; a failing
// seed is kept below as a named case.
(globalThis as { opensteerPoolController?: string }).opensteerPoolController = "agent";

import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPoolAgentClient } from "../apps/host/src/browser/browser-pool-agent-client.js";
import type { BrowserPoolPhysicalController } from "../apps/host/src/browser/browser-pool-controller.js";
import {
  BrowserPoolCoordinator,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { FakeHypervisorDriver } from "../apps/pool-agent/src/fake-driver.test-support.js";
import {
  homeKeyPair,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import {
  listBrowserPoolRetiredTargets,
  readBrowserPoolSlot,
  retireBrowserPoolTarget,
  TabStore,
} from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import { BrowserSessionIdSchema } from "../packages/protocol/src/browser.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { TestRuntimeConnection } from "./browser-pool-journey.test-support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

/** Deterministic random numbers from a seed (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]! };
}

/** How long one step may take; past it, a step waits for ever, which is a finding. */
const stepBoundMs = 30_000;
/** Once faults stop, how long every closing row has to be closed. */
const settleBoundMs = 30_000;
/** A session without a channel ends after this, on both sides (short, so schedules reach it). */
const channelDeadlineMs = 1_500;
/**
 * The causes a fresh start may have, each with the steps that can cause it (W16): a fresh start
 * for any other cause, or for one no such step came before, is a finding.
 */
const discardCauses: Readonly<Record<string, readonly Action[]>> = {
  // The runtime process restarted inside its guest, or the host stopped the guest.
  "guest-restarted": ["restart-runtime", "host-stops-guest"],
  "guest-changed": ["restart-runtime", "host-stops-guest"],
  // A stopped session's page would not close at a wake.
  "end-unconfirmed": ["fail-page-close", "fail-page-close-always"],
  // The host lost the saved state (a guest it stopped, a refusal that took it): a cold start.
  "live-state-unavailable": ["host-stops-guest", "proxy-refuses", "restart-runtime"],
};

const egressAnswer = {
  upstreamUrl: "https://upstream.example:8443",
  username: "u-1",
  password: "the password",
};

interface Guest {
  readonly runtime: BrowserRuntime;
  readonly server: BrowserRuntimeServer;
  readonly bridge: LocalBrowserRuntimeBridge;
  /** What its host last did to it: a paused or stopped guest answers nothing. */
  state: "running" | "paused" | "stopped";
}

/** One target: a slot on its own pool host, with every guest it has started. */
interface Target {
  readonly n: number;
  readonly slotId: string;
  readonly term: number;
  readonly agent: TestPoolAgent;
  readonly driver: FakeHypervisorDriver;
  readonly controlKey: KeyObject;
  readonly client: BrowserPoolAgentClient;
  answers: "signed" | "unsigned" | "unreachable";
  guest: Guest;
  readonly guests: Guest[];
  /** Its host fenced the Home's term, or deleted the slot: a new target is needed. */
  over: boolean;
  /** The starts its host has applied that the world has followed (a new guest each). */
  starts: number;
  /**
   * Its host fenced this Home's term: it refuses the Home's calls as not its own, which the Home
   * cannot tell from any other unauthenticated answer. It can never answer this Home again.
   */
  fenced: boolean;
}

/**
 * W7: what happened, in order, at every seam the search controls, and a replay that forces that
 * order. Each event is a stable name (the seam, the target, an occurrence count): a step's start
 * and end, each controller call and its answer, each runtime call and its answer, each channel
 * the Home opens, and each choice a step made (which session it stopped). Recording, events are
 * written down as they happen; replaying, each seam waits until its event is the next one the
 * trace expects. If the run leaves the trace (its next event does not come within
 * `divergeAfterMs`), the replay says where and runs free from there.
 *
 * Not under this control, and bounded instead: the coordinator's own timers (its backoffs and
 * its status reads) and PostgreSQL's commit order are not seams; they are seen only through the
 * calls they lead to, which are. The runtime's frames to the Home (a status, a closing) travel on
 * an in-process channel the trace does not order.
 */
class Sequencer {
  readonly events: string[] = [];
  readonly choices: number[] = [];
  /** What happened that is not ordered (a channel opened): written down, never waited for. */
  readonly notes: string[] = [];
  diverged: string | undefined;
  readonly #expected: readonly string[] | undefined;
  readonly #choices: readonly number[] | undefined;
  #next = 0;
  #choice = 0;
  readonly #counts = new Map<string, number>();
  constructor(replay?: {
    readonly events: readonly string[];
    readonly choices: readonly number[];
  }) {
    this.#expected = replay?.events;
    this.#choices = replay?.choices;
  }

  get replaying(): boolean {
    return this.#expected !== undefined && this.diverged === undefined;
  }

  /** The event `name` happens now; replaying, only once it is the trace's next. */
  async at(name: string): Promise<void> {
    const count = (this.#counts.get(name) ?? 0) + 1;
    this.#counts.set(name, count);
    const event = `${name}#${count}`;
    const turn = () => !this.replaying || this.#expected![this.#next] === event;
    if (!turn())
      await vi.waitUntil(turn, { timeout: divergeAfterMs, interval: 5 }).catch(() => undefined);
    if (!turn())
      this.diverged ??= `left the trace at event ${this.#next} (${
        this.#expected![this.#next] ?? "its end"
      }) with ${event}`;
    if (this.replaying) this.#next++;
    this.events.push(event);
  }

  /** A call at a seam: its start and its answer (or its failure) are both events. */
  async call<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.at(`${name}:call`);
    try {
      return await work();
    } finally {
      await this.at(`${name}:answer`);
    }
  }

  /** A choice among `count` things: the trace's, replaying; the random one, recording. */
  choose(count: number, random: () => number): number {
    const recorded = this.replaying ? this.#choices?.[this.#choice] : undefined;
    this.#choice++;
    const index =
      recorded !== undefined && recorded < count ? recorded : Math.floor(random() * count);
    this.choices.push(index);
    return index;
  }
}

/** Worlds made in this process: each one's key, with its seed, names its rows. */
let worlds = 0;

/** How long a replay waits for the trace's next event with nothing moving before it runs free. */
const divergeAfterMs = 5_000;

interface SearchTrace {
  readonly seed: number;
  readonly steps: readonly Step[];
  readonly events: readonly string[];
  readonly choices: readonly number[];
  readonly violations?: readonly string[];
}

/** This world's page-close faults (W16): its own pages only, never a prototype shared by all. */
interface CloseFaults {
  /** The next page close does not take. */
  next: boolean;
  /** No page close takes, call after call, until it heals. */
  always: boolean;
}

/** A context whose pages, the first and every one it opens, close as the world's faults say. */
class SearchContext extends FakeContext {
  readonly #faults: CloseFaults;
  constructor(pages: FakePage[], faults: CloseFaults) {
    super(pages);
    this.#faults = faults;
    for (const page of pages) this.#govern(page);
  }

  override async createPage(options: Parameters<FakeContext["createPage"]>[0] = {}) {
    return this.#govern((await super.createPage(options)) as FakePage);
  }

  #govern(page: FakePage): FakePage {
    const close = page.close.bind(page);
    const faults = this.#faults;
    page.close = async () => {
      if (faults.always || faults.next) {
        faults.next = false;
        page.closeCount += 1;
        return;
      }
      return close();
    };
    return page;
  }
}

async function world(key: string, sequencer: Sequencer, seed: number) {
  const closeFaults: CloseFaults = { next: false, always: false };
  const ids = random(seed ^ 0x2545f491);
  const hex = (count: number) =>
    Array.from({ length: count }, () => Math.floor(ids.next() * 16).toString(16)).join("");
  const seededUuid = () =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(ids.next() * 4)]}${hex(3)}-${hex(12)}`;
  const fixture = await createStoreFixture();
  cleanup.push(() => fixture.close());
  const task = await fixture.startRunFixture(key);
  const { database, store } = fixture;
  await database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
    .where("id", "=", task.runnerId)
    .execute();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-search-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const homeKey = homeKeyPair();
  const tickets = generateKeyPairSync("ed25519");
  const signer = new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey });
  const discards: string[] = [];

  // ---- The guest: one runtime per started guest, reached through its own server ---------------
  let generation = 0;
  const newGuest = async (controlKey: KeyObject): Promise<Guest> => {
    const index = ++generation;
    const runtime = new BrowserRuntime({
      runtimeId: "pool-runtime",
      launcher: new FakeLauncher(
        new FakeLaunchedBrowser(new SearchContext([new FakePage()], closeFaults)),
      ),
      sessionFilesRoot: join(root, `guest-${index}-sessions`),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        pooled: true,
        replayLedgerPath: join(root, `guest-${index}`, "private", "tickets.json"),
        resolvePublicKey: (id) => (id === "test" ? tickets.publicKey : null),
      }),
      pool: { controllerKey: controlKey, probePage: async () => [], channelDeadlineMs },
    });
    const bridgeToken = randomUUID();
    const server = new BrowserRuntimeServer({
      runtime,
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: () => {
          throw new Error("The loopback data bridge cannot replace the pooled ticket key.");
        },
      },
    });
    const address = await server.start();
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
    const guest: Guest = { runtime, server, bridge, state: "stopped" };
    cleanup.push(() => endGuest(guest));
    return guest;
  };
  /** The guest's VM is gone: its runtime goes with it. */
  const endGuest = async (guest: Guest) => {
    guest.state = "stopped";
    await guest.server.close().catch(() => undefined);
    await guest.runtime.shutdown().catch(() => undefined);
  };

  // ---- A target: its own pool host (the pair's agent on a fake hypervisor that pulls egress) ---
  let targets = 0;
  const newTarget = async (): Promise<Target> => {
    const n = ++targets;
    const slotId = `slot-${key}-${n}`;
    const driver = new FakeHypervisorDriver({
      startsEmpty: true,
      profilesMount: {},
      pullsEgress: true,
    });
    driver.profilesMounted = true;
    // The host's own check reads each slot's egress proxy (as the pair harness runs it).
    const agent = await startTestPoolAgent({
      driver,
      hostCheckMs: 200,
      egressFetch: async () => egressAnswer,
    });
    cleanup.push(() => agent.close());
    const summary = await agent.agent.createSlot({
      slotId,
      term: 1,
      homeKey: homeKey.spki,
      guest: testGuest,
    });
    const controlKey = createPublicKey({
      key: Buffer.from(summary.controlKey, "base64"),
      format: "der",
      type: "spki",
    });
    const target: Target = {
      n,
      slotId,
      term: 1,
      agent,
      driver,
      controlKey,
      answers: "signed",
      over: false,
      fenced: false,
      starts: 0,
      guests: [],
      guest: undefined as unknown as Guest,
      client: new BrowserPoolAgentClient({
        url: agent.url,
        homeKey: homeKey.privateKey,
        agentKey: controlKey,
        hostKey: agent.hostPublicKey,
        fetch: async (input, init) => {
          if (target.answers === "signed") return fetch(input, init);
          if (target.answers === "unreachable") throw new TypeError("fetch failed");
          return new Response(
            JSON.stringify({
              reply: { op: "refused", code: "unauthenticated", message: "Not authenticated." },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        },
      }),
    };
    target.guest = await newGuest(controlKey);
    target.guests.push(target.guest);
    return target;
  };
  let current = await newTarget();
  const all: Target[] = [current];
  const effects = (target = current) => target.agent.agent.effects(target.slotId);

  const connections: TestRuntimeConnection[] = [];
  const dropChannels = (code = 1011) => {
    current.guest.bridge.closeAll(code, "pool tunnel broke");
    for (const connection of connections.splice(0)) connection.lose(code, "pool tunnel broke");
  };
  /** A start on the host replaced the guest's VM, or only its runtime process restarts. */
  const replaceGuest = async (target: Target) => {
    const old = target.guest;
    target.guest = await newGuest(target.controlKey);
    // The VM goes on as it was: a runtime restart inside a running guest is still running (a
    // start sets it running itself).
    target.guest.state = old.state;
    target.guests.push(target.guest);
    if (target === current) dropChannels();
    await endGuest(old);
  };
  /**
   * The guest as its host has it, after any call (W16): a start the host applied is a new guest
   * (however the Home learned of it, by its answer or by reading its result later), and the
   * guest runs, sleeps or is gone as the host says. The world follows the host, never a reply.
   */
  const follow = async (target: Target) => {
    const starts = effects(target).filter((effect) => effect === "start").length;
    if (starts > target.starts) {
      target.starts = starts;
      await replaceGuest(target);
      target.guest.state = "running";
    }
    if (target.over) return;
    const phase = (
      await target.agent.agent.status(target.slotId, target.term).catch(() => undefined)
    )?.phase;
    if (phase === "running") target.guest.state = "running";
    else if (phase === "paused") target.guest.state = "paused";
    else if (phase === "stopped" && target.guest.state !== "stopped") await endGuest(target.guest);
  };
  const physical = (target: Target): BrowserPoolPhysicalController => {
    const followed = async <T>(work: () => Promise<T>) => {
      try {
        return await work();
      } finally {
        await follow(target);
      }
    };
    return {
      status: (slot, term) =>
        sequencer.call(`host:${target.n}:status`, () =>
          followed(() => target.client.status(slot, term)),
        ),
      result: (slot, term, id) =>
        sequencer.call(`host:${target.n}:result`, () =>
          followed(() => target.client.result(slot, term, id)),
        ),
      apply: (call) =>
        sequencer.call(`host:${target.n}:${call.kind}`, () =>
          followed(() => target.client.apply(call)),
        ),
    };
  };
  // The runtime's controls go through the host's relay: a paused or stopped guest, or a host
  // that does not answer, answers nothing (a relay refusal, unknown to the Home).
  const channel = (target: Target): BrowserPoolRuntimeChannel => {
    const relayed = <T>(call: () => Promise<T>) =>
      target.guest.state === "running" && target.answers === "signed"
        ? call()
        : Promise.reject(Object.assign(new Error("parked"), { name: "PoolRelayRefused" }));
    return {
      poolState: () =>
        sequencer.call(`runtime:${target.n}:state`, async () =>
          target.answers !== "signed"
            ? Promise.reject(Object.assign(new Error("parked"), { name: "PoolRelayRefused" }))
            : target.guest.state === "running"
              ? (target.guest.runtime.poolState() ?? null)
              : null,
        ),
      controlPool: (control, signature) =>
        sequencer.call(`runtime:${target.n}:${control.kind}`, () =>
          relayed(() => target.guest.runtime.controlPool(control, signature)),
        ),
      endSession: (ticket) =>
        sequencer.call(`runtime:${target.n}:end`, () =>
          relayed(() => target.guest.runtime.endPoolSession(ticket)),
        ),
    };
  };

  // ---- The Home -------------------------------------------------------------------------------
  const connect = (ticket: string) => {
    // Opening a channel is synchronous here: it is recorded, and never waited for.
    sequencer.notes.push(`channel:${current.n}`);
    const connection = new TestRuntimeConnection(current.guest.bridge, ticket);
    connections.push(connection);
    return connection;
  };
  const tabs = new TabStore(database);
  const errors: number[] = [];
  /** Every coordinator this world made: each is closed with it, none outlives its world (W16). */
  const coordinators: BrowserPoolCoordinator[] = [];
  cleanup.push(async () => {
    for (const coordinator of coordinators) coordinator.close();
  });
  const newCoordinator = (
    target: Target,
    drain?: { readonly instanceId: string; readonly epoch: number },
  ) => {
    const coordinator = new BrowserPoolCoordinator({
      ...(drain ? { drain } : {}),
      database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: target.slotId,
      term: target.term,
      runtime: channel(target),
      controller: physical(target),
      retryMs: 20,
      channelDeadlineMs,
      unreachableAfterMs: 1_000,
      // Unknown is asked again later each time; capped short here so that a schedule's rest,
      // which starts as the host answers again, is reached within the settle bound.
      unansweredRetryMaxMs: 2_000,
      // A refusal is asked again later each time too, capped as short.
      refusedRetryMs: 100,
      refusedRetryMaxMs: 2_000,
      // A running guest's status is read this often (its egress proxy can go down under it).
      statusEveryMs: 200,
      onError: () => errors.push(Date.now()),
      onDiscard: (reason) => discards.push(reason),
      // Each wait between the loop's turns ends as a recorded event, in the trace's order (W16).
      aroundWait: (kind, wait) => sequencer.call(`wait:${target.n}:${kind}`, wait),
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  type Home = { service: BrowserService; coordinator: BrowserPoolCoordinator };
  /**
   * A target change and a Home restart one at a time, as the Home's target chooser runs them:
   * the Home's stored target decides which target a starting Home adopts, never a change half
   * made beside it.
   */
  let changing: Promise<unknown> = Promise.resolve();
  const change = <T>(work: () => Promise<T>): Promise<T> => {
    const run = changing.then(work);
    changing = run.catch(() => undefined);
    return run;
  };
  let home: Home;
  /** As a pooled Home starts: the service first, its coordinator adopted once it has a target. */
  const startHome = async () => {
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      pooledRunner: task.runnerId,
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      signer,
      // Ids from the seed (W16): the order rows are taken in is the schedule's.
      newSessionId: () => BrowserSessionIdSchema.parse(`bsn_${seededUuid()}`),
      onError: () => {},
      onSessionsChanged: () => {},
      targetResolver: {
        placements: () => [
          {
            kind: "runner" as const,
            runnerId: task.runnerId,
            label: "Pooled test browser",
            runtimeId: "pool-runtime",
            environmentIds: [task.environmentId],
            available: true,
          },
        ],
        resolve: () => ({
          runtimeId: "pool-runtime",
          placementKey: "pool-test",
          main: true,
          surfaceState: 1,
          tabRestoreVersion: true,
          sharedControl: true,
          cdpBoundary: true,
          connect,
          connectionCommands: true,
          targetControl: true,
        }),
      },
    });
    // What a person reaches from here on is this Home, even before its pool is adopted.
    home = { service, coordinator: newCoordinator(current) };
    await service.initialize();
    await service.adoptPool(task.runnerId, home.coordinator);
    // Replaced targets a Stop still waits on are drained, from their records (W8).
    await drainRetired(service);
  };
  /** As the Home's target chooser does: every recorded replaced target is asked (W8). */
  const drainRetired = async (service: BrowserService) => {
    for (const retired of await listBrowserPoolRetiredTargets(database, task.runnerId)) {
      const target = all.find(({ slotId }) => slotId === retired.slotId);
      if (!target) continue;
      void service
        .drainPool(
          task.runnerId,
          newCoordinator(target, { instanceId: retired.instanceId, epoch: retired.epoch }),
        )
        .catch(() => undefined);
    }
  };
  await startHome();
  cleanup.push(async () => {
    home.coordinator.close();
    await home.service.close().catch(() => undefined);
  });
  const row = (sessionId: string) =>
    store.getBrowserSessionForOwner(BrowserSessionIdSchema.parse(sessionId), task.userId);
  const rows = () =>
    database
      .selectFrom("browserSessions")
      .select(["id", "state"])
      .where("runnerId", "=", task.runnerId)
      .execute();
  return {
    task,
    database,
    closeFaults,
    discards,
    errors,
    row,
    rows,
    /**
     * W8: a closing row names what it waits for, the target its binding names (the target whose
     * word ends it). It may stay closing only while that target really cannot answer this Home in
     * this world (its host unreachable, answering unsigned, or fenced): `unknown`. A closing row
     * that names nothing, or a target that can answer, is `open`: a fault at rest.
     */
    closingRows: async () => {
      const closing = (await rows()).filter(({ state }) => state === "closing");
      if (!closing.length) return { open: [], unknown: [] };
      const bound = new Map(
        (
          await database
            .selectFrom("browserPoolSessions")
            .select(["sessionId", "slotId", "term"])
            .where(
              "sessionId",
              "in",
              closing.map(({ id }) => id),
            )
            .execute()
        ).map((binding) => [binding.sessionId as string, binding]),
      );
      const cannotAnswer = (id: string) => {
        const binding = bound.get(id);
        const target = binding && all.find(({ slotId }) => slotId === binding.slotId);
        return !!target && (target.answers !== "signed" || target.fenced);
      };
      return {
        open: closing.filter(({ id }) => !cannotAnswer(id)),
        unknown: closing.filter(({ id }) => cannotAnswer(id)),
      };
    },
    signer,
    targets: () => all,
    current: () => current,
    slot: () => readBrowserPoolSlot(database, task.runnerId),
    unsettledCalls: async () =>
      (
        await database
          .selectFrom("browserPoolControllerCalls")
          .select("id")
          .where("runnerId", "=", task.runnerId)
          .where("settledAt", "is", null)
          .execute()
      ).length,
    replaceGuest: () => replaceGuest(current),
    dropChannels,
    answer: (mode: Target["answers"]) => {
      current.answers = mode;
    },
    home: () => home,
    restartHome: () =>
      change(async () => {
        home.coordinator.close();
        await home.service.close();
        // The Home's link to the Runner ends with it (1001 to each channel, as the relay does).
        dropChannels(1001);
        await startHome();
      }),
    /**
     * The account places a different target, on another host: the old coordinator retires,
     * the old target is forgotten, and the new one is adopted. The old host answers as it did.
     */
    swap: () =>
      change(async () => {
        const old = current;
        const next = await newTarget();
        all.push(next);
        await home.service.retirePool(task.runnerId, "browser-replaced");
        // As the Home's target chooser does: the old target is kept while a Stop waits on it.
        await retireBrowserPoolTarget(database, task.runnerId, { target: { n: old.n } });
        await drainRetired(home.service);
        current = next;
        home = { service: home.service, coordinator: newCoordinator(next) };
        await home.service.adoptPool(task.runnerId, home.coordinator);
      }),
    /** A newer term for the slot: the host fences this Home, and ends the guest. */
    fence: async () => {
      const target = current;
      await target.agent.agent.replaceKey({
        slotId: target.slotId,
        term: target.term + 1,
        homeKey: homeKeyPair().spki,
      });
      target.over = true;
      target.fenced = true;
      await endGuest(target.guest);
    },
    /** The provisioner deletes the slot: the host ends the guest and says so, signed. */
    deleteSlot: async () => {
      const target = current;
      await target.agent.agent.deleteSlot(target.slotId);
      target.over = true;
      await endGuest(target.guest);
    },
    /** The host stops the running guest by itself (a Home silent for long, say). */
    hostStops: async () => {
      const target = current;
      if (target.guest.state !== "running") return;
      target.driver.loseGuest(target.slotId);
      await endGuest(target.guest);
    },
    /** The slot's egress proxy goes down past its restarts; only a pause and a resume revive it. */
    proxyDown: () => current.driver.proxyDown.add(current.slotId),
    /** The slot's proxy fails its check on the next start or wake (the host refuses, signed). */
    proxyRefuses: () => current.driver.proxyUnhealthy.add(current.slotId),
    proxyHeals: () => {
      for (const target of all) target.driver.proxyUnhealthy.delete(target.slotId);
    },
  };
}

const actions = [
  "open",
  "open-two",
  "stop",
  "drop-channel",
  "park",
  "park-stop",
  "wake",
  "restart-runtime",
  "fail-page-close",
  "fail-page-close-always",
  "heal-page-close",
  "restart-home",
  "host-unreachable",
  "host-unsigned",
  "host-back",
  "proxy-down",
  "proxy-refuses",
  "proxy-heals",
  "browser-ends",
  "host-stops-guest",
  "swap",
  "fence",
  "slot-deleted",
  "release",
] as const;
type Action = (typeof actions)[number];
/**
 * A step as a named case writes it: the action, and `&n` when it overlaps the next one, which
 * starts `n` turns of the event loop after it.
 */
type Step = Action | `${Action}&${number}`;

/** Weighted: what a person does most (open, stop, park and wake) comes up most. */
const weights: Partial<Record<Action, number>> = {
  open: 3,
  stop: 3,
  park: 2,
  wake: 2,
  "fail-page-close": 2,
  swap: 1,
  fence: 0.3,
  "slot-deleted": 0.3,
  release: 0.15,
};
const weighted: readonly Action[] = actions.flatMap((action) =>
  Array.from({ length: Math.round((weights[action] ?? 1) * 20) }, () => action),
);
/** How often a step overlaps the next one. */
const overlapChance = 0.3;

function parse(step: Step): { action: Action; overlap: number | undefined } {
  const [action, turns] = step.split("&") as [Action, string | undefined];
  return { action, overlap: turns === undefined ? undefined : Number(turns) };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One schedule. Returns the violations it found (empty when everything held), with the steps that
 * led to each.
 */
async function schedule(
  seed: number,
  /** A number of random steps, or the exact steps of a named case. */
  steps: number | readonly Step[],
  /** A trace to replay (W7): its events' order is forced at every seam. */
  replay?: SearchTrace,
): Promise<{ violations: string[]; trace: SearchTrace; diverged?: string }> {
  // Steps come from the seed alone; a step's own choices from a second stream, so whether a
  // choice was made (it depends on what is open) never moves the steps that follow.
  const rng = random(seed);
  const choicesRng = random(seed ^ 0x5bd1e995);
  const sequencer = new Sequencer(replay);
  const count = typeof steps === "number" ? steps : steps.length;
  const w = await world(`search-${seed}-${++worlds}`, sequencer, seed);
  const violations: string[] = [];
  const log: string[] = [];
  /**
   * Every session seen: whether the person asked to stop it, whether that Stop returned, and
   * whether its runtime ended it on its own.
   */
  const opened = new Map<
    string,
    { stopAsked: boolean; stopped: boolean; served: boolean; stoppedAt?: number }
  >();
  /** The faults this schedule has injected so far. */
  const injected = new Set<Action>();
  /** The last step after which a target's guest could be gone (a swap, a removal, ...). */
  let targetEndedAt = -1;
  const done = () => ({
    violations,
    trace: {
      seed,
      steps: log.filter((step) => step !== "rest") as Step[],
      events: sequencer.events,
      choices: sequencer.choices,
      ...(violations.length ? { violations } : {}),
    },
    ...(sequencer.diverged ? { diverged: sequencer.diverged } : {}),
  });
  const say = (message: string) => {
    const line = `${message} (after: ${log.join(", ")})`;
    if (!violations.includes(line)) violations.push(line);
  };
  /**
   * A request a person or the Home makes. A park, a wake or an open may wait for the guest as
   * long as it takes (nothing answers): only this schedule stops waiting for it. A Stop and a
   * Home restart must finish within the bound: past it they are findings, and the schedule ends.
   */
  let stuck = false;
  let released = false;
  const bounded = async (name: string, work: () => Promise<unknown>, finding = false) => {
    await withTimeout(work(), stepBoundMs, {
      timeoutError: () => new Error(`${name} ran past its bound`),
    }).catch((error: unknown) => {
      if (finding && error instanceof Error && error.message.endsWith("ran past its bound")) {
        say(error.message);
        stuck = true;
      }
    });
  };
  // A session closed holds nothing in the ledger of any guest that serves, of any target: only
  // evidence about its own guest closes it.
  const checkClosed = async () => {
    const closed = (await w.rows()).filter(({ state }) => state === "closed");
    for (const target of w.targets())
      for (const guest of target.guests) {
        if (guest.state !== "running" || guest.runtime.poolState()?.phase !== "running") continue;
        for (const { id } of closed) {
          const holds = guest.runtime.pages.holdingsOf(id);
          if (holds.pages || holds.creations)
            say(
              `closed row ${id} while a running guest of target ${target.n} holds ${holds.pages} page(s)`,
            );
        }
      }
  };
  // What must hold after every step.
  const checkStep = async () => {
    await checkClosed();
    const slot = await w.slot();
    if (slot && slot.failedStarts > 0) say(`${slot.failedStarts} failed start(s) counted`);
    const report = w.home().coordinator.report();
    if (report?.proxyDown && slot?.phase !== "running")
      say(`proxy down shown while the slot is ${slot?.phase ?? "gone"}`);
    for (const reason of w.discards.splice(0))
      if (!(discardCauses[reason] ?? []).some((cause) => injected.has(cause)))
        say(`a fresh start for ${reason}`);
  };
  /** `served`: its open answered, so it had a page (one whose open never answered may not). */
  const track = (sessionId: string, served: boolean) => {
    const entry = opened.get(sessionId);
    if (entry) entry.served ||= served;
    else opened.set(sessionId, { stopAsked: false, stopped: false, served });
  };
  const open = async (idempotencyKey: string) => {
    const opening = await w
      .home()
      .service.openTab(w.task.userId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId: w.task.runnerId },
        idempotencyKey,
      })
      .catch(() => undefined);
    // A person's next tab opens in their browser session when one is open: it is the same
    // session, still theirs.
    if (opening) track(opening.sessionId, true);
  };
  const live = () => [...opened].filter(([, entry]) => !entry.stopAsked);
  const stop = async () => {
    const candidates = live();
    if (!candidates.length) return;
    const [sessionId, entry] = candidates[sequencer.choose(candidates.length, choicesRng.next)]!;
    entry.stopAsked = true;
    const service = w.home().service;
    await bounded(
      "stop",
      async () => {
        const stopped = await service
          .stop(w.task.userId, BrowserSessionIdSchema.parse(sessionId))
          .then(
            () => true,
            () => false,
          );
        if (!stopped) return;
        // "The person asked to stop" is durable before the Stop returns.
        const state = (await w.row(sessionId))?.state;
        if (state === "ready" || state === "starting")
          say(`stopped session ${sessionId} still ${state} after its Stop returned`);
        // A Stop never writes failed: a failed row had ended before it (a loss), and that Stop
        // stopped nothing.
        if (state === "failed") return;
        entry.stopped = true;
        entry.stoppedAt = log.length;
      },
      true,
    );
  };

  const run = async (action: Action, index: number) => {
    const home = w.home();
    switch (action) {
      case "open":
        return bounded("open", () => open(`open-${seed}-${index}`));
      case "open-two":
        // Two tabs asked for at once.
        return bounded("open-two", () =>
          Promise.all([open(`open-${seed}-${index}-a`), open(`open-${seed}-${index}-b`)]),
        );
      case "stop":
        return stop();
      case "park-stop": {
        // A park and a person's Stop at once.
        const park = home.coordinator.tryPark().catch(() => undefined);
        await stop();
        return bounded("park", () => park);
      }
      case "drop-channel":
        return w.dropChannels();
      case "park":
        return bounded("park", () => home.coordinator.tryPark().catch(() => undefined));
      case "wake":
        return bounded("wake", () =>
          home.coordinator.gate
            .reserve(AbortSignal.timeout(5_000))
            .then((reservation) => reservation.release())
            .catch(() => undefined),
        );
      case "restart-runtime":
        // Only the runtime process restarts; the guest's VM goes on running.
        if (w.current().guest.state === "running") await w.replaceGuest();
        return;
      case "fail-page-close":
        // The next page close does not take: the page stays.
        w.closeFaults.next = true;
        return;
      case "fail-page-close-always":
        // Every page close fails until it heals (a page that will not close, call after call).
        w.closeFaults.always = true;
        return;
      case "heal-page-close":
        w.closeFaults.always = false;
        return;
      case "restart-home":
        return bounded("restart-home", () => w.restartHome(), true);
      case "host-unreachable":
        return w.answer("unreachable");
      case "host-unsigned":
        return w.answer("unsigned");
      case "host-back":
        return w.answer("signed");
      case "proxy-down":
        return w.proxyDown();
      case "proxy-refuses":
        return w.proxyRefuses();
      case "proxy-heals":
        return w.proxyHeals();
      case "browser-ends": {
        // The runtime ends a live session on its own (its browser went): it says closing, then
        // closed, to whichever Home holds its channel.
        const guest = w.current().guest;
        const fence = guest.state === "running" ? guest.runtime.poolState()?.fence : undefined;
        const candidates = live();
        if (!fence || !candidates.length) return;
        const [sessionId] = candidates[sequencer.choose(candidates.length, choicesRng.next)]!;
        return bounded("browser-ends", () =>
          guest.runtime
            .endPoolSession(
              w.signer.issue({
                access: "read-write",
                creationOrigin: "person",
                actor: "person",
                identity: { kind: "fresh" },
                pool: { ...fence, end: true },
                runtimeId: "pool-runtime",
                sessionId: BrowserSessionIdSchema.parse(sessionId),
                subject: w.task.userId,
              }),
            )
            .catch(() => undefined),
        );
      }
      case "host-stops-guest":
        return w.hostStops();
      case "swap":
        return bounded("swap", () => w.swap(), true);
      case "fence":
        if (!w.current().over) await w.fence().catch(() => undefined);
        return;
      case "slot-deleted":
        if (!w.current().over) await w.deleteSlot().catch(() => undefined);
        return;
      case "release":
        released = true;
        // The removal's notes are written within the bound; the slot goes once the guest is
        // known stopped, which waits for its host's word (rest checks it).
        await bounded("release", () => home.service.poolDeviceRemoved(w.task.runnerId), true);
        return bounded("released", () => home.coordinator.released());
    }
  };
  let inflight: Promise<void> | undefined;
  for (let index = 0; index < count && !released; index++) {
    const step =
      typeof steps === "number"
        ? (() => {
            const action = rng.pick(weighted);
            return rng.next() < overlapChance
              ? (`${action}&${Math.floor(rng.next() * 4)}` as Step)
              : action;
          })()
        : steps[index]!;
    const { action, overlap } = parse(step);
    log.push(step);
    injected.add(action);
    if (
      ["swap", "release", "slot-deleted", "fence", "host-stops-guest", "restart-runtime"].includes(
        action,
      )
    )
      targetEndedAt = log.length;
    await sequencer.at(`step:${index}:${action}:start`);
    const work = run(action, index).then(async () => {
      await sequencer.at(`step:${index}:${action}:end`);
    });
    if (overlap !== undefined && !inflight) {
      // Overlaps the next step, which starts this many turns later.
      for (let turns = 0; turns < overlap; turns++) await turn();
      inflight = work;
      continue;
    }
    await work;
    if (inflight) await inflight;
    inflight = undefined;
    await checkStep();
    if (stuck) return done();
  }
  if (inflight) await inflight;
  await checkStep();
  if (stuck) return done();

  // At rest: faults stop, and what was asked is finished. A target that is over is replaced by
  // the account, as it would be.
  w.answer("signed");
  w.proxyHeals();
  w.closeFaults.next = false;
  w.closeFaults.always = false;
  log.push("rest");
  if (!released && w.current().over) await bounded("swap", () => w.swap(), true);
  if (stuck) return done();
  // An open that never answered within its bound may still have made a session: it is tracked.
  for (const { id } of await w.rows()) track(id, false);
  const settled = await vi
    .waitFor(
      async () => {
        await checkClosed();
        expect((await w.closingRows()).open).toEqual([]);
        const slot = await w.slot();
        // Released, the slot is gone; or, while its host cannot answer this Home (fenced, or
        // answering unsigned), releasing, its calls unsettled: unknown, never anything else (W16).
        const current = w.current();
        const cannotAnswer = current.fenced || current.answers !== "signed";
        if (released && !(cannotAnswer && slot?.phase === "releasing"))
          expect(slot).toBeUndefined();
        if (!released) expect(["running", "parked"]).toContain(slot?.phase);
        // Its calls settle unless its host cannot answer: then an open call is unknown, and
        // stays open (the search's seed 40485: a first install a fenced host never answered).
        if (!(released && cannotAnswer)) expect(await w.unsettledCalls()).toBe(0);
      },
      { timeout: settleBoundMs, interval: 100 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!settled) {
    const closing = (await w.closingRows()).open;
    const slot = await w.slot();
    say(
      `not at rest within ${settleBoundMs} ms: ${closing.length} closing row(s), slot ${
        slot?.phase ?? "gone"
      }, ${await w.unsettledCalls()} unsettled controller call(s)`,
    );
  }
  await checkStep();
  for (const [sessionId, entry] of opened) {
    const state = (await w.row(sessionId))?.state;
    // A session the person stopped never serves again.
    if (entry.stopped && (state === "ready" || state === "starting"))
      say(`stopped session ${sessionId} is ${state} at rest`);
    // A Stop's end is closed (or closing, unknown); failed only when its guest could be gone by
    // something after the Stop (W16).
    if (entry.stopped && state === "failed" && (entry.stoppedAt ?? 0) > targetEndedAt)
      say(`stopped session ${sessionId} failed with nothing after its Stop to end its guest`);
    if (entry.stopAsked) continue;
    // A session the person did not stop never ends closing or closed: it ends with a note.
    if (state === "closed" || state === "closing")
      say(`session ${sessionId} ${state} though the person never stopped it`);
    // A session that served a page and lost it has a note for it.
    if (state === "failed" && entry.served) {
      const notes = await w.database
        .selectFrom("browserPoolDocumentLosses")
        .select("surfaceId")
        .where("sessionId", "=", BrowserSessionIdSchema.parse(sessionId))
        .execute();
      if (!notes.length) say(`session ${sessionId} lost its page with no note`);
    }
  }
  // Nothing retries without a delay (no more than 100 failures in any second).
  const errors = w.errors;
  for (let start = 0, end = 0; end < errors.length; end++) {
    while (errors[end]! - errors[start]! > 1_000) start++;
    if (end - start > 100) {
      say(`the loop failed ${end - start} times within one second`);
      break;
    }
  }
  return done();
}

/**
 * The schedules the search found failing, kept: each is the exact steps of a seed that broke an
 * invariant at 73e64cc8b (or after it, before V1–V4), and what it showed.
 */
const named: readonly {
  readonly name: string;
  readonly seed: number;
  readonly steps: readonly Step[];
  /** A trace in browser-pool-search-traces/ to replay instead (W7). */
  readonly trace?: string;
}[] = [
  {
    // A Home restart waited for the pool's recovery while the host answered unsigned.
    name: "a Home starts while its host answers unsigned (seed 2)",
    seed: 2,
    steps: [
      "restart-home",
      "drop-channel",
      "stop",
      "wake",
      "host-unsigned",
      "restart-runtime",
      "wake",
      "park",
      "restart-home",
    ],
  },
  {
    // F6: a clean Home shutdown stopped a session the person never stopped.
    name: "a clean Home restart with a live session (seed 15)",
    seed: 15,
    steps: [
      "stop",
      "park",
      "park",
      "wake",
      "stop",
      "fail-page-close",
      "host-back",
      "drop-channel",
      "open",
      "park",
      "park",
      "drop-channel",
      "open",
      "restart-home",
      "stop",
      "open",
      "host-back",
      "host-back",
    ],
  },
  {
    // F5: a closing row stayed closing after the runtime restarted inside a running guest.
    name: "a runtime restart inside a running guest with a stopped session (seed 19)",
    seed: 19,
    steps: [
      "open",
      "drop-channel",
      "wake",
      "restart-home",
      "host-back",
      "drop-channel",
      "fail-page-close",
      "wake",
      "wake",
      "host-unreachable",
      "open",
      "wake",
      "restart-runtime",
      "park",
      "restart-runtime",
      "open",
      "open",
      "wake",
    ],
  },
  {
    // F3b: a session stopped while parked was closed, and the woken guest still held its page.
    name: "a Stop while parked, then a wake whose page close fails (seed 217)",
    seed: 217,
    steps: [
      "open",
      "park",
      "park",
      "park",
      "fail-page-close",
      "fail-page-close",
      "fail-page-close",
      "stop",
      "wake",
      "open",
      "wake",
      "stop",
      "park",
      "restart-home",
      "fail-page-close",
      "wake",
    ],
  },
  {
    // Ready sessions lost without a note after the runtime restarted inside a running guest.
    name: "a runtime restart inside a running guest with ready sessions (seed 222)",
    seed: 222,
    steps: [
      "stop",
      "restart-runtime",
      "host-unreachable",
      "open",
      "wake",
      "host-back",
      "drop-channel",
      "open",
      "open",
      "open",
      "park",
      "open",
      "fail-page-close",
      "restart-runtime",
      "wake",
      "open",
    ],
  },
  {
    // A closing row not closed at rest, after a Stop, a runtime restart and an unreachable host.
    name: "a Stop around a runtime restart and an unreachable host (seed 100)",
    seed: 100,
    steps: [
      "stop",
      "stop",
      "wake",
      "host-unreachable",
      "wake",
      "fail-page-close",
      "open",
      "wake",
      "stop",
      "restart-runtime",
      "stop",
      "open",
      "stop",
      "drop-channel",
      "host-back",
      "open",
    ],
  },
  {
    name: "a Stop, then a runtime restart inside a running guest, before rest (seed 226)",
    seed: 226,
    steps: [
      "restart-runtime",
      "wake",
      "stop",
      "wake",
      "open",
      "host-back",
      "host-unreachable",
      "park",
      "host-unreachable",
      "wake",
      "host-back",
      "host-unsigned",
      "open",
      "stop",
      "restart-runtime",
      "fail-page-close",
    ],
  },
  {
    name: "Home restarts around a Stop and a reopened browser (seed 227)",
    seed: 227,
    steps: [
      "restart-runtime",
      "fail-page-close",
      "host-back",
      "restart-runtime",
      "restart-home",
      "restart-home",
      "drop-channel",
      "open",
      "stop",
      "fail-page-close",
      "stop",
      "wake",
      "open",
      "restart-home",
      "fail-page-close",
      "wake",
    ],
  },
  {
    name: "a reopened browser after a Stop whose page close failed (seed 229)",
    seed: 229,
    steps: [
      "wake",
      "host-unsigned",
      "drop-channel",
      "drop-channel",
      "host-back",
      "open",
      "fail-page-close",
      "open",
      "stop",
      "fail-page-close",
      "stop",
      "drop-channel",
      "fail-page-close",
      "open",
      "wake",
      "fail-page-close",
    ],
  },
  {
    name: "ready sessions across a runtime restart and a park (seed 232)",
    seed: 232,
    steps: [
      "host-back",
      "open",
      "stop",
      "host-unreachable",
      "host-back",
      "wake",
      "fail-page-close",
      "open",
      "fail-page-close",
      "open",
      "restart-runtime",
      "wake",
      "fail-page-close",
      "park",
      "wake",
      "host-unreachable",
    ],
  },
  {
    name: "ready sessions across repeated runtime restarts (seed 236)",
    seed: 236,
    steps: [
      "open",
      "park",
      "fail-page-close",
      "drop-channel",
      "wake",
      "restart-runtime",
      "fail-page-close",
      "fail-page-close",
      "open",
      "open",
      "restart-runtime",
      "wake",
      "open",
      "fail-page-close",
      "restart-runtime",
      "open",
    ],
  },
  // ---- Re-check 9: found by the grown search (W0), or built by hand where it did not -------
  {
    // F1: a swap; the old target's Stop, left closing while its host did not answer, was closed
    // with the new target's evidence while the old guest still held its page.
    name: "a Stop on a target swapped away while its host did not answer (seed 5029)",
    seed: 5029,
    steps: [
      "drop-channel",
      "swap",
      "park-stop&0",
      "fail-page-close&1",
      "drop-channel&2",
      "park-stop",
      "open&1",
      "restart-runtime",
      "fail-page-close",
      "stop",
      "restart-home",
      "host-unreachable",
      "swap",
      "park&1",
      "park-stop",
      "stop",
      "wake",
      "stop&1",
      "host-back&1",
      "proxy-down&2",
    ],
  },
  {
    // F5 A: the proxy's repair parked the guest, and parked it still showed proxy down.
    name: "a park while the egress proxy is down (seed 5004)",
    seed: 5004,
    steps: ["wake", "open&2", "fail-page-close", "stop", "wake&3", "proxy-down&2", "park"],
  },
  {
    // F2 (by hand, the seam forced by overlap 0): a Stop while the broker finishes a lost channel
    // returned with the row still ready.
    name: "a Stop racing the end of a lost channel (F2, by hand)",
    seed: 9002,
    steps: ["open", "drop-channel&0", "stop"],
  },
  {
    // F5 B (by hand): a wake the real agent refuses for its proxy (and, today, loses the saved
    // state with): a fresh start into the same refusal at once.
    name: "a wake the host refuses for its egress proxy (F5 B, by hand)",
    seed: 9005,
    steps: ["open", "park", "proxy-refuses", "wake"],
  },
  {
    // The long run on the fixed code: A Stop on a target over by its host's signed word stayed closing: the guest was known gone.
    name: "a Stop after the slot was deleted, and a swap at rest (seed 10005)",
    seed: 10005,
    steps: [
      "fail-page-close",
      "restart-home",
      "host-unsigned",
      "fail-page-close-always",
      "park",
      "proxy-down",
      "park&0",
      "proxy-heals&0",
      "fail-page-close",
      "open",
      "swap&2",
      "restart-home&2",
      "stop",
      "wake",
      "open&0",
      "slot-deleted&2",
      "wake",
      "open",
      "slot-deleted",
      "proxy-down",
    ],
  },
  {
    // The long run on the fixed code: The search's own bound: a release's slot goes only on its host's word (fixed in the search).
    name: "a release while the host answers unsigned (seed 10006)",
    seed: 10006,
    steps: ["stop", "host-unsigned", "wake", "proxy-down", "stop", "proxy-heals", "release"],
  },
  {
    // The long run on the fixed code: A swap retired a target whose Stops its answering runtime could still end: nobody asked it.
    name: "Stops left closing by an unsigned host, then a swap as it answers again (seed 10009)",
    seed: 10009,
    steps: [
      "park-stop",
      "open-two&0",
      "fail-page-close",
      "host-unsigned&1",
      "proxy-down",
      "stop&0",
      "fail-page-close",
      "open-two",
      "restart-home&2",
      "wake&1",
      "heal-page-close",
      "drop-channel",
      "proxy-heals",
      "proxy-heals",
      "park-stop",
      "host-back&3",
      "swap",
      "browser-ends",
      "stop",
      "open",
    ],
  },
  {
    // The long run on the fixed code: A Stop on a fenced target stayed closing: the guest was known gone.
    name: "a Stop, then the term fenced (seed 10015)",
    seed: 10015,
    steps: [
      "fail-page-close",
      "drop-channel&3",
      "open",
      "browser-ends",
      "heal-page-close&3",
      "proxy-heals",
      "restart-runtime&0",
      "stop",
      "restart-home",
      "proxy-refuses&1",
      "fail-page-close&0",
      "wake&0",
      "heal-page-close",
      "park-stop",
      "stop",
      "restart-home",
      "fail-page-close",
      "fence",
      "proxy-down",
      "drop-channel&3",
    ],
  },
  {
    // The long run (seeds 20000 on): proxy down was shown again while the slot was preparing: the park's own status read set it.
    name: "a proxy down as the guest is parked (seed 20099)",
    seed: 20099,
    steps: [
      "stop",
      "proxy-heals&3",
      "stop",
      "host-stops-guest",
      "restart-home",
      "open&3",
      "wake",
      "open&2",
      "heal-page-close",
      "stop",
      "open&2",
      "park",
      "stop&2",
      "stop&2",
      "stop",
      "host-unsigned",
      "wake",
      "restart-runtime",
      "proxy-down",
      "wake",
    ],
  },
  {
    // The long run (seeds 20000 on): a failed start was counted for a fresh start given up as the slot moved under it (another Home's write), not for the browser failing to come up.
    name: "a fresh start a closed Home gave up, around Home restarts (seed 20196)",
    seed: 20196,
    steps: [
      "open",
      "proxy-down",
      "open",
      "restart-runtime&3",
      "host-back&1",
      "restart-home",
      "park-stop",
      "stop",
      "wake",
      "browser-ends",
      "wake",
      "proxy-heals",
      "open",
      "proxy-heals",
      "host-back&1",
      "fail-page-close",
      "proxy-heals",
      "restart-home",
      "drop-channel&2",
      "fail-page-close",
    ],
  },
  {
    // W12 (by hand): a Stop whose end its runtime has not answered yet (its page will not close)
    // when the target is replaced: the replaced target is asked until it answers.
    name: "a swap while a Stop waits on a page that will not close yet (W12, by hand)",
    seed: 9012,
    steps: ["open", "fail-page-close-always", "stop", "swap", "heal-page-close"],
  },
  {
    // W12 (by hand): a swap while the guest is parked, a Stop racing it.
    name: "a swap while parked, a Stop racing it (W12, by hand)",
    seed: 9013,
    steps: ["open", "park", "swap&0", "stop"],
  },
  {
    // The 30000 run: a replaced target's runtime restarted inside its guest, so no runtime under its fence could end a Stop it held: the drain now stops that guest (W12).
    name: "a schedule of the 30000 run (seed 30020)",
    seed: 30020,
    trace: "seed-30020.json",
    steps: [
      "proxy-refuses",
      "proxy-heals",
      "browser-ends&3",
      "open",
      "drop-channel&2",
      "open",
      "park-stop",
      "open&2",
      "wake",
      "wake",
      "park",
      "stop",
      "fail-page-close",
      "stop&0",
      "proxy-down",
      "fail-page-close",
      "host-back",
      "open",
      "swap&0",
      "restart-runtime",
    ],
  },
  {
    // The 30000 run: the search's own, before W16 (held on the final code three times, with and without the drain): kept so it cannot come back.
    name: "a schedule of the 30000 run (seed 30052)",
    seed: 30052,
    steps: [
      "stop",
      "drop-channel&1",
      "open",
      "open",
      "park",
      "open&1",
      "open",
      "open&3",
      "proxy-refuses&2",
      "swap",
      "restart-runtime",
      "open",
      "park-stop&1",
      "restart-home",
      "restart-home",
      "stop",
      "proxy-refuses&2",
      "proxy-refuses",
      "stop&1",
      "slot-deleted",
    ],
  },
  {
    // The 30000 run: the search's own, before W16 (held on the final code three times, with and without the drain): kept so it cannot come back.
    name: "a schedule of the 30000 run (seed 30106)",
    seed: 30106,
    steps: [
      "restart-runtime",
      "open-two",
      "proxy-down",
      "heal-page-close",
      "swap&1",
      "stop",
      "proxy-heals",
      "park",
      "wake&3",
      "open",
      "park-stop",
      "park",
      "browser-ends",
      "open",
      "open&2",
      "stop",
      "host-stops-guest",
      "host-unsigned",
      "host-unreachable",
      "fail-page-close",
    ],
  },
  {
    // The 30000 run: a target over by its deleted slot, replaced at rest, its Stop never asked again: the drain (W12).
    name: "a schedule of the 30000 run (seed 30115)",
    seed: 30115,
    steps: [
      "stop",
      "wake&1",
      "open-two&1",
      "proxy-refuses&2",
      "stop",
      "host-back",
      "restart-home",
      "stop",
      "host-unreachable",
      "heal-page-close&1",
      "host-back",
      "host-unreachable",
      "stop",
      "open-two",
      "slot-deleted",
      "park-stop",
      "proxy-heals&0",
      "fail-page-close-always",
      "stop&2",
      "proxy-refuses",
    ],
  },
  {
    // The 30000 run: the search's own: it modelled the guest from call answers, not from its host (W16).
    name: "a schedule of the 30000 run (seed 30155)",
    seed: 30155,
    trace: "seed-30155.json",
    steps: [
      "open",
      "host-back",
      "open",
      "proxy-heals&3",
      "park-stop&2",
      "proxy-refuses&1",
      "restart-home",
      "restart-runtime&2",
      "restart-runtime",
      "wake",
      "park",
      "host-unsigned",
      "fail-page-close-always",
      "open",
      "stop&3",
      "wake",
      "park-stop",
      "stop",
      "browser-ends",
      "browser-ends",
    ],
  },
  {
    // The 30000 run: the search's own, before W16 (held on the final code three times, with and without the drain): kept so it cannot come back.
    name: "a schedule of the 30000 run (seed 30189)",
    seed: 30189,
    steps: [
      "browser-ends",
      "open-two",
      "host-unsigned",
      "park",
      "fail-page-close&2",
      "open&2",
      "heal-page-close",
      "park",
      "stop",
      "park",
      "park&3",
      "open-two",
      "stop",
      "restart-home&2",
      "open&3",
      "proxy-down",
      "stop&3",
      "browser-ends",
      "slot-deleted",
      "stop",
    ],
  },
  {
    // The 30000 run: the search's own, before W16 (held on the final code three times, with and without the drain): kept so it cannot come back.
    name: "a schedule of the 30000 run (seed 30238)",
    seed: 30238,
    steps: [
      "open-two",
      "park&3",
      "host-unreachable",
      "wake&3",
      "slot-deleted",
      "stop",
      "wake",
      "stop&2",
      "open-two",
      "stop",
      "open",
      "open-two&2",
      "fail-page-close-always",
      "swap",
      "open",
      "host-unreachable",
      "wake&3",
      "host-unsigned",
      "swap",
      "stop&1",
    ],
  },
  {
    // The 30000 run: the search's own: it modelled the guest from call answers, not from its host (W16).
    name: "a schedule of the 30000 run (seed 30254)",
    seed: 30254,
    trace: "seed-30254.json",
    steps: [
      "fail-page-close",
      "park-stop",
      "open-two",
      "restart-home&0",
      "open&1",
      "open",
      "park-stop&0",
      "restart-home",
      "host-unsigned",
      "open",
      "heal-page-close",
      "stop",
      "drop-channel",
      "restart-runtime&2",
      "restart-runtime",
      "stop",
      "host-back",
      "browser-ends",
      "open",
      "wake",
    ],
  },
  {
    // The 30000 run: a deleted slot's and a fenced term's Stops after a swap at rest: the drain (W12).
    name: "a schedule of the 30000 run (seed 30262)",
    seed: 30262,
    steps: [
      "open",
      "browser-ends&3",
      "slot-deleted&1",
      "host-unreachable&1",
      "park-stop",
      "fail-page-close-always",
      "fence&3",
      "open",
      "stop",
      "wake&2",
      "park",
      "proxy-down&3",
      "browser-ends",
      "host-unreachable&2",
      "fail-page-close&1",
      "wake",
      "fence&0",
      "park-stop&3",
      "open&2",
      "fail-page-close&1",
    ],
  },
  {
    // The 30000 run: a deleted slot's Stop, replaced at rest: the drain (W12).
    name: "a schedule of the 30000 run (seed 30320)",
    seed: 30320,
    steps: [
      "drop-channel",
      "open-two",
      "drop-channel&2",
      "host-unreachable",
      "host-stops-guest&3",
      "park-stop",
      "fail-page-close&3",
      "wake&0",
      "slot-deleted&1",
      "fail-page-close-always",
      "drop-channel",
      "wake&2",
      "proxy-down&1",
      "host-unsigned",
      "stop&2",
      "stop",
      "drop-channel",
      "proxy-refuses",
      "fail-page-close-always",
      "wake",
    ],
  },
  {
    // The 30000 run: the search's own, before W16 (held on the final code three times, with and without the drain): kept so it cannot come back.
    name: "a schedule of the 30000 run (seed 30365)",
    seed: 30365,
    steps: [
      "host-unreachable&1",
      "wake&0",
      "slot-deleted",
      "browser-ends",
      "swap",
      "heal-page-close&0",
      "wake&3",
      "fail-page-close-always",
      "restart-home",
      "drop-channel&2",
      "open",
      "host-unreachable",
      "open",
      "open",
      "browser-ends&3",
      "stop",
      "host-unreachable",
      "slot-deleted",
      "wake",
      "swap",
    ],
  },
  {
    // The 30000 run: the search's own: a swap and a Home restart overlapped, which the Home's chooser never does (W16).
    name: "a schedule of the 30000 run (seed 30384)",
    seed: 30384,
    trace: "seed-30384.json",
    steps: [
      "stop",
      "proxy-heals",
      "park",
      "host-unsigned",
      "heal-page-close",
      "host-stops-guest&1",
      "restart-home",
      "restart-home&0",
      "swap&1",
      "proxy-heals",
      "stop",
      "open&3",
      "fail-page-close-always",
      "wake",
      "wake&3",
      "host-back",
      "stop",
      "wake",
      "restart-runtime",
      "fail-page-close&1",
    ],
  },
  {
    // The 30000 run: a deleted slot's Stop, replaced at rest: the drain (W12).
    name: "a schedule of the 30000 run (seed 30424)",
    seed: 30424,
    steps: [
      "open-two",
      "stop&2",
      "drop-channel",
      "drop-channel",
      "restart-home",
      "host-unreachable",
      "park",
      "park-stop",
      "stop&1",
      "host-unsigned",
      "open-two",
      "restart-home",
      "open",
      "wake&1",
      "host-unreachable",
      "slot-deleted&2",
      "open",
      "stop",
      "proxy-refuses",
      "fail-page-close-always",
    ],
  },
  {
    // The 30000 run: as 30020: a replaced target's runtime not under its fence (W12).
    name: "a schedule of the 30000 run (seed 30497)",
    seed: 30497,
    trace: "seed-30497.json",
    steps: [
      "open",
      "fail-page-close",
      "restart-runtime",
      "stop",
      "wake&2",
      "swap",
      "wake",
      "browser-ends",
      "proxy-refuses",
      "open",
      "fail-page-close-always&1",
      "host-unreachable",
      "open",
      "open",
      "park&2",
      "open",
      "slot-deleted&3",
      "host-unsigned",
      "open",
      "proxy-refuses&0",
    ],
  },
  {
    // The 30000 run: as 30020: a replaced target's runtime not under its fence (W12).
    name: "a schedule of the 30000 run (seed 30498)",
    seed: 30498,
    trace: "seed-30498.json",
    steps: [
      "open-two",
      "restart-runtime&1",
      "fail-page-close&1",
      "fail-page-close&2",
      "host-back&0",
      "fail-page-close",
      "stop",
      "swap",
      "proxy-refuses",
      "host-unreachable",
      "swap",
      "host-stops-guest&0",
      "park-stop&1",
      "wake",
      "wake&2",
      "wake",
      "stop",
      "proxy-heals",
      "open-two",
      "proxy-down&0",
    ],
  },
  {
    // The 40000 run: a release of a fenced target whose host never answered a first install:
    // that call is unknown and stays open; the search's own check was too strict (W16).
    name: "a release of a fenced target (seed 40458)",
    seed: 40458,
    trace: "seed-40458.json",
    steps: [
      "restart-runtime",
      "fence",
      "restart-home",
      "park",
      "restart-runtime",
      "stop&3",
      "fence&0",
      "host-unsigned&2",
      "proxy-down",
      "host-back",
      "stop",
      "host-back",
      "wake&3",
      "fail-page-close",
      "proxy-down",
      "wake",
      "release",
    ],
  },
  {
    // The 40000 run: a release of a fenced target whose host never answered a first install:
    // that call is unknown and stays open; the search's own check was too strict (W16).
    name: "a release of a fenced target (seed 40485)",
    seed: 40485,
    trace: "seed-40485.json",
    steps: [
      "fence",
      "open",
      "stop",
      "fail-page-close",
      "host-stops-guest&0",
      "restart-home",
      "host-unreachable",
      "wake",
      "wake&0",
      "open&2",
      "proxy-heals",
      "stop&3",
      "drop-channel&0",
      "proxy-refuses",
      "wake",
      "park-stop",
      "release",
    ],
  },
];

/** Where a schedule that broke an invariant leaves its trace (W7): a file to replay. */
const traceDirectory =
  process.env.OPENSTEER_POOL_SEARCH_TRACES ?? join(tmpdir(), "opensteer-pool-search-traces");
/** Named cases' own traces, kept with the suite. */
const namedTraces = join(import.meta.dirname, "browser-pool-search-traces");

function keepTrace(trace: SearchTrace): string {
  mkdirSync(traceDirectory, { recursive: true });
  const path = join(traceDirectory, `seed-${trace.seed}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(trace, null, 1)}\n`);
  return path;
}

function readTrace(path: string): SearchTrace {
  return JSON.parse(readFileSync(path, "utf8")) as SearchTrace;
}

const only = process.env.OPENSTEER_POOL_SEARCH_NAMED;
it.each(only ? named.filter(({ seed }) => only.split(",").includes(String(seed))) : named)(
  "holds every invariant for $name",
  { timeout: 20 * stepBoundMs },
  async ({ seed, steps, trace }) => {
    // A case kept with its trace replays the order it failed in; the others run their steps.
    const replay = trace ? readTrace(join(namedTraces, trace)) : undefined;
    const outcome = await schedule(seed, replay?.steps ?? steps, replay);
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    if (outcome.violations.length) console.log(`trace: ${keepTrace(outcome.trace)}`);
    expect(outcome.violations).toEqual([]);
  },
);

/**
 * Replays one trace by hand: `OPENSTEER_POOL_SEARCH_REPLAY=<trace.json>`. It says whether the run
 * kept to the trace, and what broke.
 */
const replayPath = process.env.OPENSTEER_POOL_SEARCH_REPLAY;
it.skipIf(!replayPath)("replays a trace", { timeout: 40 * stepBoundMs }, async () => {
  const replay = readTrace(replayPath!);
  const outcome = await schedule(replay.seed, replay.steps, replay);
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
  console.log(
    `pool search replay of seed ${replay.seed}: ${
      outcome.diverged ? `diverged: ${outcome.diverged}` : "kept to the trace"
    }; ${outcome.violations.length ? outcome.violations.join("; ") : "held"}; trace: ${keepTrace(
      outcome.trace,
    )}`,
  );
  expect(outcome.violations).toEqual([]);
});

/**
 * Runs given schedules by hand, each `OPENSTEER_POOL_SEARCH_REPEAT` times (default 1), keeping the
 * trace of every run that breaks an invariant: `OPENSTEER_POOL_SEARCH_SCHEDULE_FILE=<file>` holds
 * `[{ "seed": n, "steps": [...] }]` (a long run's failing schedules, say).
 */
const scheduleFile = process.env.OPENSTEER_POOL_SEARCH_SCHEDULE_FILE;
it.skipIf(!scheduleFile)("runs the schedules of a file", { timeout: 6 * 60 * 60_000 }, async () => {
  const schedules = JSON.parse(readFileSync(scheduleFile!, "utf8")) as {
    seed: number;
    steps: Step[];
  }[];
  const repeat = Number(process.env.OPENSTEER_POOL_SEARCH_REPEAT ?? 1);
  for (const { seed, steps } of schedules)
    for (let run = 1; run <= repeat; run++) {
      const { violations, trace } = await schedule(seed, steps);
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
      console.log(
        `pool search file seed ${seed} run ${run}: ${
          violations.length ? `${violations.join("; ")} trace: ${keepTrace(trace)}` : "held"
        }`,
      );
    }
});

/**
 * Schedules the suite runs every time: modest, bounded by `stepBoundMs` per step, and fixed (seeds
 * 1 to 6), so a gate never fails for a reason unrelated to the change under test. The longer
 * exploration runs by hand from another first seed, for example
 * `OPENSTEER_POOL_SEARCH_NAMED=none OPENSTEER_POOL_SEARCH_SEED=1000 OPENSTEER_POOL_SEARCH_SCHEDULES=500
 * OPENSTEER_POOL_SEARCH_STEPS=20`. Each schedule that breaks an invariant leaves its trace.
 */
const suiteSchedules = Number(process.env.OPENSTEER_POOL_SEARCH_SCHEDULES ?? 6);
const suiteSteps = Number(process.env.OPENSTEER_POOL_SEARCH_STEPS ?? 14);
const firstSeed = Number(process.env.OPENSTEER_POOL_SEARCH_SEED ?? 1);

it(
  `holds every invariant over ${suiteSchedules} seeded schedules of ${suiteSteps} steps`,
  { timeout: suiteSchedules * (suiteSteps * stepBoundMs + settleBoundMs + 60_000) },
  async () => {
    const found: string[] = [];
    for (let seed = firstSeed; seed < firstSeed + suiteSchedules; seed++) {
      const { violations, trace } = await schedule(seed, suiteSteps);
      const kept =
        violations.length || process.env.OPENSTEER_POOL_SEARCH_KEEP
          ? ` trace: ${keepTrace(trace)}`
          : "";
      console.log(
        `pool search seed ${seed}: ${violations.length ? violations.join("; ") : "held"}${kept}`,
      );
      found.push(...violations.map((violation) => `seed ${seed}: ${violation}`));
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    }
    expect(found).toEqual([]);
  },
);
