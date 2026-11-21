/**
 * The physical controller the coordinator suite runs against: the fake controller, or the real
 * pool agent on a fake hypervisor behind its signed HTTP interface and the Home's real client.
 * The agent file sets `globalThis.opensteerPoolController = "agent"` before importing the suite.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalController,
  BrowserPoolPhysicalKind,
  BrowserPoolPhysicalStatus,
} from "../apps/host/src/browser/browser-pool-controller.js";
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

export interface PoolControllerUnderTest extends BrowserPoolPhysicalController {
  readonly publicKey: KeyObject;
  readonly effects: string[];
  inject(kind: BrowserPoolPhysicalKind | `sign:${string}` | "any", fault: BrowserPoolFault): void;
  hold(kind: BrowserPoolPhysicalKind, until: () => Promise<void>): void;
  observe(change: Partial<BrowserPoolPhysicalStatus>): void;
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

  static async create(options: { slotId: string; term: number; now?: () => number }) {
    const agent = await startTestPoolAgent(options.now ? { now: options.now } : {});
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
    return this.#agent.agent.effects(this.#slotId).filter((effect) => homeVisible.has(effect));
  }

  inject(kind: BrowserPoolPhysicalKind | `sign:${string}` | "any", fault: BrowserPoolFault): void {
    this.#faults.push({ kind, fault });
  }

  hold(kind: BrowserPoolPhysicalKind, until: () => Promise<void>): void {
    this.#holds.set(kind, until);
  }

  /** Only physical facts the agent can find on its own: a guest and its saved state gone. */
  observe(change: Partial<BrowserPoolPhysicalStatus>): void {
    if (change.phase === "stopped" && change.savedState === null) {
      this.#agent.driver.loseGuest(this.#slotId);
      return;
    }
    throw new Error("The agent harness models only a lost guest.");
  }

  status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus> {
    return this.#client.status(slotId, term);
  }

  result(slotId: string, term: number, id: string): Promise<BrowserPoolControllerResult | null> {
    return this.#client.result(slotId, term, id);
  }

  async apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
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
