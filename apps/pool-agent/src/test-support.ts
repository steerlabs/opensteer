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
  readonly driver: FakeHypervisorDriver;
  readonly directory: string;
  readonly url: string;
  /** Kills this agent (its timers and server) and starts a new one on the same journal and driver. */
  restart(options?: Partial<PoolAgentOptions>): Promise<TestPoolAgent>;
  close(): Promise<void>;
}

export async function startTestPoolAgent(
  options: Partial<PoolAgentOptions> & {
    readonly directory?: string;
    readonly driver?: FakeHypervisorDriver;
  } = {},
): Promise<TestPoolAgent> {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "opensteer-pool-agent-")));
  const driver = options.driver ?? new FakeHypervisorDriver();
  const agent = new PoolAgent({
    saveAfterMs: null,
    ...options,
    journal: new SlotJournal(join(directory, "journal")),
    driver,
  });
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
