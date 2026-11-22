// V9: a test that searches. Seeded random schedules over the real guest runtime (pages from the
// fake launcher), the real store on PostgreSQL, the real coordinator and BrowserService, and the
// real pool agent (fake hypervisor) behind its signed client. After every step, and at rest, it
// checks what must always hold. Each schedule prints its seed; a failing seed is kept below as a
// named case.
(globalThis as { opensteerPoolController?: string }).opensteerPoolController = "agent";

import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
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
import { homeKeyPair, startTestPoolAgent, testGuest } from "../apps/pool-agent/src/test-support.js";
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
import { TabStore } from "../packages/database/src/index.js";
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

async function world(key: string) {
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

  // ---- The pool agent, as the pair runs it, behind the Home's signed client ------------------
  const slotId = `slot-${key}`;
  const driver = new FakeHypervisorDriver({ startsEmpty: true, profilesMount: {} });
  driver.profilesMounted = true;
  // The host's own check reads each slot's egress proxy (as the pair harness runs it).
  const agent = await startTestPoolAgent({ driver, hostCheckMs: 200 });
  cleanup.push(() => agent.close());
  const homeKey = homeKeyPair();
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
  let hostAnswers: "signed" | "unsigned" | "unreachable" = "signed";
  const client = new BrowserPoolAgentClient({
    url: agent.url,
    homeKey: homeKey.privateKey,
    agentKey: controlKey,
    hostKey: agent.hostPublicKey,
    fetch: async (input, init) => {
      if (hostAnswers === "signed") return fetch(input, init);
      if (hostAnswers === "unreachable") throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({
          reply: { op: "refused", code: "unauthenticated", message: "Not authenticated." },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    },
  });
  const effects = () => agent.agent.effects(slotId);

  // ---- The guest: one runtime per started guest, reached through its own server ---------------
  const tickets = generateKeyPairSync("ed25519");
  const signer = new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey });
  let generation = 0;
  const newGuest = async () => {
    const index = ++generation;
    const runtime = new BrowserRuntime({
      runtimeId: "pool-runtime",
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
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
    return { runtime, server, bridge };
  };
  let guest = await newGuest();
  /** What the agent last did to the guest: a paused or stopped guest answers nothing. */
  let guestState: "running" | "paused" | "stopped" = "stopped";
  const connections: TestRuntimeConnection[] = [];
  const dropChannels = (code = 1011) => {
    guest.bridge.closeAll(code, "pool tunnel broke");
    for (const connection of connections.splice(0)) connection.lose(code, "pool tunnel broke");
  };
  /** The guest's VM is replaced (a start), or only its runtime process restarts (VM running). */
  const replaceGuest = async () => {
    const old = guest;
    guest = await newGuest();
    dropChannels();
    await old.server.close().catch(() => undefined);
    await old.runtime.shutdown().catch(() => undefined);
  };
  cleanup.push(async () => {
    await guest.server.close().catch(() => undefined);
    await guest.runtime.shutdown().catch(() => undefined);
  });
  const physical: BrowserPoolPhysicalController = {
    status: (slot, term) => client.status(slot, term),
    result: (slot, term, id) => client.result(slot, term, id),
    apply: async (call) => {
      const starts = effects().filter((effect) => effect === "start").length;
      const result = await client.apply(call);
      if (effects().filter((effect) => effect === "start").length > starts) {
        await replaceGuest();
        guestState = "running";
      } else if (result.applied && call.kind === "pause") guestState = "paused";
      else if (result.applied && call.kind === "resume") guestState = "running";
      else if (result.applied && call.kind === "stop") guestState = "stopped";
      return result;
    },
  };
  // The runtime's controls go through the host's relay: a paused or stopped guest, or a host
  // that does not answer, answers nothing (a relay refusal, unknown to the Home).
  const relayed = <T>(call: () => Promise<T>) =>
    guestState === "running" && hostAnswers === "signed"
      ? call()
      : Promise.reject(Object.assign(new Error("parked"), { name: "PoolRelayRefused" }));
  const channel: BrowserPoolRuntimeChannel = {
    poolState: async () =>
      hostAnswers !== "signed"
        ? Promise.reject(Object.assign(new Error("parked"), { name: "PoolRelayRefused" }))
        : guestState === "running"
          ? (guest.runtime.poolState() ?? null)
          : null,
    controlPool: (control, signature) =>
      relayed(() => guest.runtime.controlPool(control, signature)),
    endSession: (ticket) => relayed(() => guest.runtime.endPoolSession(ticket)),
  };

  // ---- The Home -------------------------------------------------------------------------------
  const connect = (ticket: string) => {
    const connection = new TestRuntimeConnection(guest.bridge, ticket);
    connections.push(connection);
    return connection;
  };
  const tabs = new TabStore(database);
  const errors: number[] = [];
  const startHome = async () => {
    const coordinator = new BrowserPoolCoordinator({
      database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId,
      term: 1,
      runtime: channel,
      controller: physical,
      retryMs: 20,
      channelDeadlineMs,
      unreachableAfterMs: 1_000,
      // Unknown is asked again later each time; capped short here so that a schedule's rest,
      // which starts as the host answers again, is reached within the settle bound.
      unansweredRetryMaxMs: 2_000,
      // A running guest's status is read this often (its egress proxy can go down under it).
      statusEveryMs: 200,
      onError: () => errors.push(Date.now()),
    });
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      pools: new Map([[task.runnerId, coordinator]]),
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      signer,
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
    await service.initialize();
    return { service, coordinator };
  };
  let home = await startHome();
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
    effects,
    errors,
    row,
    rows,
    guest: () => guest,
    guestState: () => guestState,
    replaceGuest,
    dropChannels,
    /** The slot's egress proxy goes down past its restarts; only a pause and a resume revive it. */
    proxyDown: () => driver.proxyDown.add(slotId),
    answer: (mode: typeof hostAnswers) => {
      hostAnswers = mode;
    },
    home: () => home,
    restartHome: async () => {
      home.coordinator.close();
      await home.service.close();
      // The Home's link to the Runner ends with it (1001 to each channel, as the relay does).
      dropChannels(1001);
      home = await startHome();
    },
  };
}

type Action =
  | "open"
  | "stop"
  | "drop-channel"
  | "park"
  | "wake"
  | "restart-runtime"
  | "fail-page-close"
  | "restart-home"
  | "host-unreachable"
  | "host-unsigned"
  | "host-back"
  | "open-two"
  | "park-stop"
  | "proxy-down";

/** Weighted: what a person does most (open, stop, park and wake) comes up most. */
const actions: readonly Action[] = [
  "open",
  "open",
  "open",
  "stop",
  "stop",
  "stop",
  "drop-channel",
  "park",
  "park",
  "wake",
  "wake",
  "restart-runtime",
  "fail-page-close",
  "fail-page-close",
  "restart-home",
  "host-unreachable",
  "host-unsigned",
  "host-back",
  "open-two",
  "park-stop",
  "proxy-down",
];

/**
 * One schedule. Returns the violations it found (empty when everything held), with the steps that
 * led to each.
 */
async function schedule(
  seed: number,
  /** A number of random steps, or the exact steps of a named case. */
  steps: number | readonly Action[],
): Promise<string[]> {
  const rng = random(seed);
  const count = typeof steps === "number" ? steps : steps.length;
  const w = await world(`search-${seed}-${randomUUID().slice(0, 8)}`);
  const violations: string[] = [];
  const log: string[] = [];
  const opened = new Map<string, { tabId: string; stopped: boolean }>();
  let faultyHost = false;
  const say = (message: string) => violations.push(`${message} (after: ${log.join(", ")})`);
  /**
   * A request a person or the Home makes. A park, a wake or an open may wait for the guest as
   * long as it takes (nothing answers): only this schedule stops waiting for it. A Stop and a
   * Home restart must finish within the bound: past it they are findings, and the schedule ends.
   */
  let stuck = false;
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
  // Invariant 1: a closed row's session holds nothing in the ledger of a guest that serves.
  const checkClosed = async () => {
    const runtime = w.guest().runtime;
    if (w.guestState() !== "running" || runtime.poolState()?.phase !== "running") return;
    for (const { id, state } of await w.rows()) {
      if (state !== "closed") continue;
      const holds = runtime.pages.holdingsOf(id);
      if (holds.pages || holds.creations)
        say(`closed row ${id} while the running guest holds ${holds.pages} page(s)`);
    }
  };
  const open = async (home: ReturnType<typeof w.home>, idempotencyKey: string) => {
    const opening = await home.service
      .openTab(w.task.userId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId: w.task.runnerId },
        idempotencyKey,
      })
      .catch(() => undefined);
    // A person's next tab opens in their browser session when one is open: it is the same
    // session, still theirs.
    if (opening && !opened.has(opening.sessionId))
      opened.set(opening.sessionId, { tabId: opening.tabId, stopped: false });
  };
  for (let index = 0; index < count; index++) {
    const action = typeof steps === "number" ? rng.pick(actions) : steps[index]!;
    log.push(action);
    const home = w.home();
    switch (action) {
      case "open":
        await bounded("open", () => open(home, `open-${seed}-${index}`));
        break;
      case "open-two":
        // Two tabs asked for at once.
        await bounded("open-two", () =>
          Promise.all([
            open(home, `open-${seed}-${index}-a`),
            open(home, `open-${seed}-${index}-b`),
          ]),
        );
        break;
      case "park-stop": {
        // A park and a person's Stop at once.
        const live = [...opened].filter(([, entry]) => !entry.stopped);
        const park = home.coordinator.tryPark().catch(() => undefined);
        if (live.length) {
          const [sessionId, entry] = rng.pick(live);
          entry.stopped = true;
          await bounded(
            "stop",
            () =>
              home.service
                .stop(w.task.userId, BrowserSessionIdSchema.parse(sessionId))
                .catch(() => undefined),
            true,
          );
        }
        await bounded("park", () => park);
        break;
      }
      case "proxy-down":
        w.proxyDown();
        break;
      case "stop": {
        const live = [...opened].filter(([, entry]) => !entry.stopped);
        if (!live.length) break;
        const [sessionId, entry] = rng.pick(live);
        entry.stopped = true;
        await bounded(
          "stop",
          () =>
            home.service
              .stop(w.task.userId, BrowserSessionIdSchema.parse(sessionId))
              .catch(() => undefined),
          true,
        );
        break;
      }
      case "drop-channel":
        w.dropChannels();
        break;
      case "park":
        await bounded("park", () => home.coordinator.tryPark().catch(() => undefined));
        break;
      case "wake":
        await bounded("wake", () =>
          home.coordinator.gate
            .reserve(AbortSignal.timeout(5_000))
            .then((reservation) => reservation.release())
            .catch(() => undefined),
        );
        break;
      case "restart-runtime":
        // Only the runtime process restarts; the guest's VM goes on running.
        if (w.guestState() === "running") await w.replaceGuest();
        break;
      case "fail-page-close": {
        // The next page close does not take: the page stays.
        vi.spyOn(FakePage.prototype, "close").mockImplementationOnce(async function (
          this: FakePage,
        ) {
          this.closeCount += 1;
        });
        break;
      }
      case "restart-home":
        await bounded("restart-home", () => w.restartHome(), true);
        break;
      case "host-unreachable":
        faultyHost = true;
        w.answer("unreachable");
        break;
      case "host-unsigned":
        faultyHost = true;
        w.answer("unsigned");
        break;
      case "host-back":
        faultyHost = false;
        w.answer("signed");
        break;
    }
    await checkClosed();
    if (stuck) return violations;
  }
  // At rest: faults stop, and what was asked is finished.
  if (faultyHost) w.answer("signed");
  vi.restoreAllMocks();
  log.push("rest");
  const settled = await vi
    .waitFor(
      async () => {
        await checkClosed();
        const closing = (await w.rows()).filter(({ state }) => state === "closing");
        expect(closing).toEqual([]);
      },
      { timeout: settleBoundMs, interval: 100 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!settled) {
    const closing = (await w.rows()).filter(({ state }) => state === "closing");
    say(`${closing.length} closing row(s) not closed within ${settleBoundMs} ms of rest`);
  }
  await checkClosed();
  // Invariant 3: a session the person did not stop ends only with a note for its tab.
  for (const [sessionId, entry] of opened) {
    if (entry.stopped) continue;
    const state = (await w.row(sessionId))?.state;
    if (state === "closed") say(`session ${sessionId} closed though the person never stopped it`);
    if (state === "failed") {
      const notes = await w.database
        .selectFrom("browserPoolDocumentLosses")
        .select("surfaceId")
        .where("sessionId", "=", BrowserSessionIdSchema.parse(sessionId))
        .execute();
      if (!notes.length) say(`session ${sessionId} lost its page with no note`);
    }
  }
  // Invariant 4: nothing retries without a delay (no more than 100 failures in any second).
  const errors = w.errors;
  for (let start = 0, end = 0; end < errors.length; end++) {
    while (errors[end]! - errors[start]! > 1_000) start++;
    if (end - start > 100) {
      say(`the loop failed ${end - start} times within one second`);
      break;
    }
  }
  return violations;
}

/**
 * The schedules the search found failing, kept: each is the exact steps of a seed that broke an
 * invariant at 73e64cc8b (or after it, before V1–V4), and what it showed.
 */
const named: readonly {
  readonly name: string;
  readonly seed: number;
  readonly steps: readonly Action[];
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
];

const only = process.env.OPENSTEER_POOL_SEARCH_NAMED;
it.each(only ? named.filter(({ seed }) => String(seed) === only) : named)(
  "holds every invariant for $name",
  { timeout: 20 * stepBoundMs },
  async ({ seed, steps }) => {
    const violations = await schedule(seed, steps);
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    expect(violations).toEqual([]);
  },
);

/**
 * Schedules the suite runs every time: modest, bounded by `stepBoundMs` per step, and fixed (seeds
 * 1 to 6), so a gate never fails for a reason unrelated to the change under test. The longer
 * exploration runs by hand from another first seed, for example
 * `OPENSTEER_POOL_SEARCH_NAMED=none OPENSTEER_POOL_SEARCH_SEED=1000 OPENSTEER_POOL_SEARCH_SCHEDULES=500
 * OPENSTEER_POOL_SEARCH_STEPS=20`.
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
      const violations = await schedule(seed, suiteSteps);
      console.log(
        `pool search seed ${seed}: ${violations.length ? violations.join("; ") : "held"}`,
      );
      found.push(...violations.map((violation) => `seed ${seed}: ${violation}`));
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    }
    expect(found).toEqual([]);
  },
);
