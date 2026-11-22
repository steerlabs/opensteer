/**
 * The physical controller the coordinator suite runs against: the fake controller, or the real
 * pool agent on a fake hypervisor behind its signed HTTP interface and the Home's real client.
 * The agent file sets `globalThis.opensteerPoolController = "agent"` before importing the suite.
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import type { BrowserPoolControl } from "../packages/browser-runtime-core/src/browser-pool.js";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalController,
  BrowserPoolPhysicalKind,
  BrowserPoolPhysicalStatus,
} from "../apps/host/src/browser/browser-pool-controller.js";
import { expectationOf } from "../apps/host/src/browser/browser-pool-controller.js";
import {
  FakeBrowserPoolController,
  type BrowserPoolFault,
} from "../apps/host/src/browser/browser-pool-controller.test-support.js";
import { BrowserPoolAgentClient } from "../apps/host/src/browser/browser-pool-agent-client.js";
import {
  homeKeyPair,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";
import { FakeHypervisorDriver } from "../apps/pool-agent/src/fake-driver.test-support.js";

export interface PoolControllerUnderTest extends BrowserPoolPhysicalController {
  readonly publicKey: KeyObject;
  readonly effects: string[];
  inject(kind: BrowserPoolPhysicalKind | `sign:${string}` | "any", fault: BrowserPoolFault): void;
  hold(kind: BrowserPoolPhysicalKind, until: () => Promise<void>): void;
  observe(change: Partial<BrowserPoolPhysicalStatus>): void;
  /** The real agent only: the slot's egress proxy fails its check on each start and wake. */
  refuseProxy?(refusing: boolean): void;
  close?(): Promise<void>;
}

export function poolControllerKind(): "fake" | "agent" {
  return (globalThis as { opensteerPoolController?: string }).opensteerPoolController === "agent"
    ? "agent"
    : "fake";
}

export async function createPoolController(options: {
  slotId: string;
  term: number;
  now?: () => number;
  /** Each start is a new guest with an empty runtime, as on a real host. */
  freshGuests?: boolean;
  /** The fence the loopback guest's runtime holds now: the fake sees its guest. */
  guest?: () => BrowserPoolControl["fence"] | null;
}): Promise<PoolControllerUnderTest> {
  if (poolControllerKind() === "fake") return new FakeBrowserPoolController(options);
  return AgentPoolController.create(options);
}

const homeVisible = new Set(["start", "pause", "resume", "stop"]);

/**
 * The agent through the network: faults are a request that never reaches it, a reply that
 * never comes back, or a request delivered twice, as the fake models them.
 */
export class AgentPoolController implements PoolControllerUnderTest {
  readonly publicKey: KeyObject;
  readonly #agent: TestPoolAgent;
  readonly #client: BrowserPoolAgentClient;
  readonly #slotId: string;
  readonly #faults: { kind: string; fault: BrowserPoolFault }[] = [];
  readonly #holds = new Map<BrowserPoolPhysicalKind, () => Promise<void>>();
  /** Effects of calls the harness made itself, as an earlier Home would have. */
  readonly #hidden = new Set<number>();
  #pending: Promise<void> = Promise.resolve();

  private constructor(
    agent: TestPoolAgent,
    client: BrowserPoolAgentClient,
    key: KeyObject,
    slotId: string,
  ) {
    this.#agent = agent;
    this.#client = client;
    this.publicKey = key;
    this.#slotId = slotId;
  }

  static async create(options: {
    slotId: string;
    term: number;
    now?: () => number;
    freshGuests?: boolean;
  }) {
    const agent = await startTestPoolAgent({
      // Its host check (which slots' proxies are down) runs often enough for a test to see it.
      hostCheckMs: 200,
      ...(options.now ? { now: options.now } : {}),
      // As a Cloud Computer's pool host runs: it pulls each slot's egress and confirms the slot's
      // proxy serves before a start or a wake answers.
      driver: new FakeHypervisorDriver({
        startsEmpty: options.freshGuests ?? false,
        pullsEgress: true,
      }),
      egressFetch: async () => ({
        upstreamUrl: "https://upstream.example:8443",
        username: "u-1",
        password: "the password",
      }),
    });
    const home = homeKeyPair();
    const summary = await agent.agent.createSlot({
      slotId: options.slotId,
      term: options.term,
      homeKey: home.spki,
      guest: testGuest,
    });
    const key = createPublicKey({
      key: Buffer.from(summary.controlKey, "base64"),
      format: "der",
      type: "spki",
    });
    const client = new BrowserPoolAgentClient({
      url: agent.url,
      homeKey: home.privateKey,
      agentKey: key,
      ...(options.now ? { now: options.now } : {}),
    });
    return new AgentPoolController(agent, client, key, options.slotId);
  }

  get effects(): string[] {
    return this.#agent.agent
      .effects(this.#slotId)
      .filter((effect, index) => homeVisible.has(effect) && !this.#hidden.has(index));
  }

  inject(kind: BrowserPoolPhysicalKind | `sign:${string}` | "any", fault: BrowserPoolFault): void {
    this.#faults.push({ kind, fault });
  }

  hold(kind: BrowserPoolPhysicalKind, until: () => Promise<void>): void {
    this.#holds.set(kind, until);
  }

  refuseProxy(refusing: boolean): void {
    if (refusing) this.#agent.driver.proxyUnhealthy.add(this.#slotId);
    else this.#agent.driver.proxyUnhealthy.delete(this.#slotId);
  }

  /**
   * Only physical facts the agent can reach on its own: a guest and its saved state gone, or a
   * guest on a later epoch than this Home knows (an earlier Home paused and resumed it and its
   * adoption never arrived). The agent's epoch moves only by a resume, so the harness pauses and
   * resumes until it is there; those calls are the earlier Home's, not this one's effects. With
   * fresh guests the next start installs into an empty runtime, so the undelivered adoption
   * leaves nothing behind.
   */
  observe(change: Partial<BrowserPoolPhysicalStatus>): void {
    // A slot's egress proxy past its restarts, or back: the agent's host check reads it.
    if (Object.keys(change).length === 1 && "proxy" in change) {
      if (change.proxy === "down") this.#agent.driver.proxyDown.add(this.#slotId);
      else this.#agent.driver.proxyDown.delete(this.#slotId);
      return;
    }
    const { phase, savedState, epoch, ...rest } = change;
    if (phase === "stopped" && savedState === null) {
      this.#agent.driver.loseGuest(this.#slotId);
      return;
    }
    if (
      typeof epoch === "number" &&
      phase === undefined &&
      savedState === undefined &&
      !Object.keys(rest).length
    ) {
      this.#pending = this.#pending.then(() => this.#advanceEpoch(epoch));
      return;
    }
    throw new Error("The agent harness models only a lost guest or a later epoch.");
  }

  async #advanceEpoch(epoch: number): Promise<void> {
    const term = this.#agent.agent.authority(this.#slotId)?.term ?? 1;
    for (;;) {
      if ((await this.#client.status(this.#slotId, term)).epoch! >= epoch) return;
      for (const kind of ["pause", "resume"] as const) {
        const before = this.#agent.agent.effects(this.#slotId).length;
        const current = await this.#client.status(this.#slotId, term);
        const result = await this.#client.apply({
          id: randomUUID(),
          slotId: this.#slotId,
          term,
          kind,
          expect: expectationOf(current),
          ...(kind === "resume" ? { intent: { id: randomUUID(), sequence: 1 } } : {}),
        });
        if (!result.applied) throw new Error(`The harness ${kind} was refused: ${result.reason}.`);
        const after = this.#agent.agent.effects(this.#slotId).length;
        for (let index = before; index < after; index += 1) this.#hidden.add(index);
      }
    }
  }

  async result(slotId: string, term: number, id: string) {
    await this.#pending;
    return this.#client.result(slotId, term, id);
  }

  async status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus> {
    await this.#pending;
    return this.#client.status(slotId, term);
  }

  async apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
    await this.#pending;
    const fault = this.#take(call);
    if (fault === "request") throw new Error(`The ${call.kind} request was lost.`);
    const hold = this.#holds.get(call.kind);
    if (hold) {
      this.#holds.delete(call.kind);
      await hold();
    }
    const result = await this.#client.apply(call);
    if (fault === "duplicate") await this.#client.apply(call);
    if (fault === "reply") throw new Error(`The ${call.kind} reply was lost.`);
    return result;
  }

  close(): Promise<void> {
    return this.#agent.close();
  }

  #take(call: BrowserPoolControllerCall): BrowserPoolFault | undefined {
    const index = this.#faults.findIndex(
      (entry) =>
        entry.kind === call.kind ||
        entry.kind === "any" ||
        (call.kind === "sign" && entry.kind === `sign:${call.control?.kind}`),
    );
    if (index < 0) return undefined;
    return this.#faults.splice(index, 1)[0]!.fault;
  }
}
