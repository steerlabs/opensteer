import { fork } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { launchRegisteredWorkload } from "./journey-launch.js";
import {
  ProcessIdentitySchema,
  realProcessIO,
  sameProcess,
  verifiedGroup,
  stopRegisteredGroups,
  type ProcessIdentity,
} from "./journey-processes.js";

async function stop(identity: ProcessIdentity | undefined) {
  if (!identity) return;
  if (verifiedGroup(identity, realProcessIO.processes()))
    realProcessIO.signal(-identity.pgid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    if (!realProcessIO.processes().some((row) => sameProcess(identity, row))) return;
    await delay(20);
  }
  if (verifiedGroup(identity, realProcessIO.processes()))
    realProcessIO.signal(-identity.pgid, "SIGKILL");
}
it("killing the launcher before durable registration never starts an unregistered workload", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "journey-handshake-")));
  const sentinel = path.join(root, "started"),
    journal = path.join(root, "owned.json"),
    parentFile = path.join(root, "parent.mjs");
  writeFileSync(
    parentFile,
    `import { launchRegisteredWorkload } from ${JSON.stringify(new URL("./journey-launch.ts", import.meta.url).href)};
await launchRegisteredWorkload({command:'printf started > "$JOURNEY_TEST_SENTINEL"',log:${JSON.stringify(path.join(root, "work.log"))},register:async identity=>{process.send({identity});await new Promise(()=>{});}});`,
  );
  const parent = fork(parentFile, [], {
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    env: { ...process.env, JOURNEY_TEST_SENTINEL: sentinel },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let identity: ProcessIdentity | undefined;
  try {
    const [message] = await once(parent, "message", { signal: AbortSignal.timeout(5000) });
    identity = ProcessIdentitySchema.parse(message.identity);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
    const exited = once(parent, "exit");
    parent.kill("SIGKILL");
    await exited;
    for (
      let i = 0;
      i < 100 && realProcessIO.processes().some((row) => sameProcess(identity!, row));
      i++
    )
      await delay(20);
    expect(realProcessIO.processes().some((row) => sameProcess(identity!, row))).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      const exit = once(parent, "exit");
      parent.kill("SIGKILL");
      await exit;
    }
    await stop(identity);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
it("executes the workload only after its ownership record is durably published", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "journey-registered-")));
  const journal = path.join(root, "owned.json"),
    sentinel = path.join(root, "started");
  let identity: ProcessIdentity | undefined;
  try {
    const code = await launchRegisteredWorkload({
      command: 'test -f "$JOURNEY_TEST_RECORD" && printf registered > "$JOURNEY_TEST_SENTINEL"',
      log: path.join(root, "work.log"),
      env: { ...process.env, JOURNEY_TEST_RECORD: journal, JOURNEY_TEST_SENTINEL: sentinel },
      register: async (value) => {
        identity = value;
        await replacePrivateFileAtomically(journal, JSON.stringify(value));
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual(identity);
    expect(readFileSync(sentinel, "utf8")).toBe("registered");
    const registration = { groups: [identity!] };
    await stopRegisteredGroups(registration);
    await delay(0);
    await stopRegisteredGroups(registration);
    expect(registration.groups).toEqual([]);
  } finally {
    await stop(identity);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it.each([false, true])(
  "bounds a legacy interruption (ignores TERM: %s)",
  async (ignore) => {
    const { stopLegacyGroup } = await import("./journey-legacy-stop.js");
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "legacy-stop-")));
    const ready = path.join(root, "ready"),
      marker = path.join(root, "marker");
    let identity: ProcessIdentity | undefined;
    try {
      const command = ignore
        ? `trap '' TERM; touch "$READY"; while :; do sleep 0.1; done`
        : `trap 'sleep 0.3; touch "$MARKER"; exit 0' TERM; touch "$READY"; while :; do sleep 0.1; done`;
      const result = launchRegisteredWorkload({
        command,
        log: path.join(root, "log"),
        env: { ...process.env, READY: ready, MARKER: marker, OPENSTEER_LEGACY_GRACEFUL_STOP: "1" },
        register: async (value) => {
          identity = value;
        },
      });
      for (let i = 0; i < 200 && !existsSync(ready); i++) await delay(20);
      expect(existsSync(ready)).toBe(true);
      const start = Date.now();
      await stopLegacyGroup(identity!, realProcessIO, 1000);
      await result;
      expect(Date.now() - start).toBeLessThan(8000);
      expect(existsSync(marker)).toBe(!ignore);
    } finally {
      await stop(identity);
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
