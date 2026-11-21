/**
 * The pool agent daemon. It reconciles its journal with the host before it listens, so no
 * request is ever answered from a state it has not checked.
 */
import { mkdir } from "node:fs/promises";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { dirname } from "node:path";
import type { Server } from "node:http";
import { PoolAgent } from "./agent.js";
import { readAgentConfig } from "./config.js";
import { FirecrackerDriver } from "./firecracker/driver.js";
import { SlotJournal } from "./journal.js";
import { createAdminServer, createHomeServer, listen, parseProvisionerKey } from "./server.js";

function log(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? "/etc/opensteer-pool/agent.json";
  const config = await readAgentConfig(file);
  const driver = new FirecrackerDriver(config.driver);
  await driver.open();
  const agent = new PoolAgent({
    journal: new SlotJournal(config.journal),
    driver,
    retentionMs: config.retentionHours * 60 * 60_000,
    saveAfterMs: config.saveAfterSeconds === null ? null : config.saveAfterSeconds * 1000,
    maxConcurrentSaves: config.maxConcurrentSaves,
    log,
  });
  await agent.start();
  const servers: Server[] = [];
  const home = createHomeServer({ agent, log });
  const admin = createAdminServer({
    agent,
    log,
    provisionerKey: parseProvisionerKey(config.admin.provisionerKey),
  });
  for (const [server, target] of [
    [home, config.listen],
    [admin, config.admin.listen],
  ] as const) {
    if ("path" in target) await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
    await listen(server, target);
    if ("path" in target) await setPrivateFileMode(target.path);
    servers.push(server);
  }
  log({ event: "agent.ready", slots: agent.slotIds().length });
  const stop = () => {
    // The guests keep running; the next agent reconciles with them.
    agent.close();
    for (const server of servers) server.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  log({ event: "agent.failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
