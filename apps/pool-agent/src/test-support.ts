import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoolAgent, type PoolAgentOptions } from "./agent.js";
import { FakeHypervisorDriver } from "./fake-driver.test-support.js";
import { SlotJournal } from "./journal.js";
import { createHomeServer, listen } from "./server.js";

export { FakeHypervisorDriver } from "./fake-driver.test-support.js";
export { PoolAgent, AgentCrashed } from "./agent.js";
export { SlotJournal } from "./journal.js";
export { createHomeServer, createAdminServer, listen } from "./server.js";

/** An agent on a fake hypervisor with a real journal and a real signed HTTP interface. */
export interface TestPoolAgent {
  readonly agent: PoolAgent;
  readonly journal: SlotJournal;
  readonly driver: FakeHypervisorDriver;
  readonly directory: string;
  readonly url: string;
  /** Kills this agent (its timers and server) and starts a new one on the same journal and driver. */
  restart(options?: Partial<PoolAgentOptions>): Promise<TestPoolAgent>;
  close(): Promise<void>;
}

/**
 * A journal whose writes can be made to fail before the rename (nothing published) or after it
 * (published, then an error, as a failed directory sync reports), or held at a gate.
 */
export class FaultyJournal extends SlotJournal {
  #fail: { readonly when: "before" | "after"; skip: number } | undefined;
  #gate: Promise<void> | undefined;
  writes = 0;
  /** Writes waiting at the gate now. */
  held = 0;

  /** The write after `skip` more successful ones fails. */
  failWrite(when: "before" | "after", skip = 0): void {
    this.#fail = { when, skip };
  }

  /** Every write waits for this promise before it starts. */
  holdWrites(until: Promise<void> | undefined): void {
    this.#gate = until;
  }

  override async write(record: Parameters<SlotJournal["write"]>[0]): Promise<void> {
    if (this.#gate) {
      this.held += 1;
      await this.#gate;
      this.held -= 1;
    }
    this.writes += 1;
    const fail = this.#fail;
    if (fail && fail.skip-- <= 0) {
      this.#fail = undefined;
      if (fail.when === "before") throw new Error("The journal disk refused the write.");
      await super.write(record);
      throw new Error("The journal directory sync failed after the rename.");
    }
    await super.write(record);
  }
}

export async function startTestPoolAgent(
  options: Partial<PoolAgentOptions> & {
    readonly directory?: string;
    readonly driver?: FakeHypervisorDriver;
    readonly faultyJournal?: boolean;
    /** Armed before the agent starts, so its own recovery writes can fail. */
    readonly journalFault?: { readonly when: "before" | "after"; readonly skip: number };
  } = {},
): Promise<TestPoolAgent> {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "opensteer-pool-agent-")));
  const driver = options.driver ?? new FakeHypervisorDriver();
  const journal =
    options.faultyJournal || options.journalFault
      ? new FaultyJournal(join(directory, "journal"))
      : new SlotJournal(join(directory, "journal"));
  if (options.journalFault)
    (journal as FaultyJournal).failWrite(options.journalFault.when, options.journalFault.skip);
  const agent = new PoolAgent({ saveAfterMs: null, ...options, journal, driver });
  await agent.start();
  const server: Server = createHomeServer({ agent, ...(options.now ? { now: options.now } : {}) });
  const address = (await listen(server, { host: "127.0.0.1", port: 0 })) as AddressInfo;
  const close = async () => {
    agent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    agent,
    journal,
    driver,
    directory,
    url: `http://127.0.0.1:${address.port}`,
    close,
    restart: async (next = {}) => {
      await close();
      return startTestPoolAgent({ ...options, ...next, directory, driver });
    },
  };
}

export function homeKeyPair(): { readonly privateKey: KeyObject; readonly spki: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

export const testGuest = {
  vcpus: 2,
  memoryMib: 2048,
  profilePath: "/var/lib/opensteer-pool/profiles/test.ext4",
};
