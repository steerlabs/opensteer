/**
 * The pool agent daemon. It reconciles its journal with the host before it listens, so no
 * request is ever answered from a state it has not checked.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { chown, mkdir, rm } from "node:fs/promises";
import { readPrivateFileText } from "@opensteer/shared/atomicPrivateFile";
import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { dirname } from "node:path";
import type { Server } from "node:http";
import { PoolAgent, type PoolAgentOptions } from "./agent.js";
import { readAgentConfig, refuseUnsupportedMode } from "./config.js";
import { FirecrackerDriver } from "./firecracker/driver.js";
import { SlotJournal } from "./journal.js";
import { createAdminServer, createHomeServer, listen, parseProvisionerKey } from "./server.js";
import { createRelayAuthServer } from "./relay.js";

export function log(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Runs the daemon; `extra` is for the bench entry only (fault injection), never production. */
export async function runDaemon(extra: Pick<PoolAgentOptions, "checkpoint"> = {}): Promise<void> {
  const file = process.argv[2] ?? "/etc/opensteer-pool/agent.json";
  const config = await readAgentConfig(file);
  refuseUnsupportedMode(config);
  const driver = new FirecrackerDriver(config.driver, log);
  await driver.open();
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
    ...extra,
  });
  await agent.start();
  const servers: Server[] = [];
  const hostKey = await readHostKey(config.admin.hostKeyFile);
  const home = createHomeServer({ agent, log, hostKey });
  const admin = createAdminServer({
    agent,
    log,
    provisionerKey: parseProvisionerKey(config.admin.provisionerKey),
    hostId: config.admin.hostId,
    hostKey,
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
  // The relay's question, on a socket only the relay's user (and root) may open.
  const relayUid = config.driver.network.relayUid;
  if (relayUid !== null) {
    const path = "/run/opensteer-pool/relay.sock";
    await mkdir(dirname(path), { recursive: true, mode: 0o711 });
    await rm(path, { force: true });
    const relayAuth = createRelayAuthServer((hello, clientKey) =>
      agent.authorizeRelay(hello, clientKey),
    );
    await new Promise<void>((resolve, reject) => {
      relayAuth.once("error", reject);
      relayAuth.listen(path, () => resolve());
    });
    await chown(path, relayUid, 0);
    await setPrivateFileMode(path);
    servers.push(relayAuth as unknown as Server);
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

/** The host key made at install: root-only, Ed25519. */
async function readHostKey(file: string): Promise<KeyObject> {
  const text = await readPrivateFileText(file, 16 * 1024, {
    invalid: () => new Error("The host key is unreadable."),
    exposed: () => new Error("The host key is readable by other users."),
  });
  if (!text) throw new Error(`The host key is missing at ${file}: run setup-host.sh install.`);
  const key = createPrivateKey(text);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The host key must be Ed25519.");
  return key;
}
