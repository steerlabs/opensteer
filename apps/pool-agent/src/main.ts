/**
 * The pool agent daemon. It reconciles its journal with the host before it listens, so no
 * request is ever answered from a state it has not checked.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
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
  const crashAt = await testCrashPoint();
  const agent = new PoolAgent({
    journal: new SlotJournal(config.journal),
    driver,
    retentionMs: config.retentionHours * 60 * 60_000,
    saveAfterMs: config.saveAfterSeconds === null ? null : config.saveAfterSeconds * 1000,
    maxConcurrentSaves: config.maxConcurrentSaves,
    log,
    // Rule S2: a failed journal write ends the process; systemd starts it again
    // (Restart=always) and the new agent's recovery reads the disk. Guests keep running.
    fatal: (error: unknown) => {
      log({
        event: "agent.fatal",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(70);
    },
    ...(crashAt
      ? {
          checkpoint: (point: string) => {
            if (point !== crashAt) return;
            log({ event: "agent.test-crash", point });
            process.kill(process.pid, "SIGKILL");
          },
        }
      : {}),
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

/**
 * A real-host test of a restart in the middle of a transition: root writes a checkpoint name to
 * this file, the next agent reads and deletes it, and kills itself with SIGKILL at that point.
 * The file is in a root-only directory and is consumed once.
 */
async function testCrashPoint(): Promise<string | undefined> {
  const file = "/run/opensteer-pool/test-crash-at";
  const point = await readFile(file, "utf8").catch(() => undefined);
  if (point === undefined) return undefined;
  await rm(file, { force: true });
  return point.trim() || undefined;
}

main().catch((error: unknown) => {
  log({ event: "agent.failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
