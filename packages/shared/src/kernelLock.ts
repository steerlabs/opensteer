/**
 * Kernel locks for local tooling: one keeps cleanup from deleting what a run
 * still uses, and one lets a single writer at a time rebuild a checkout's build
 * outputs. The kernel releases a lock when its descriptor closes or its process
 * dies, so no helper process is needed. Only Darwin, where these tools run, has
 * these locks; elsewhere holding is immediate.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./isRecord.js";
import { isNodeError } from "./nodeError.js";
import { noFollowFlag } from "./privateFiles.js";

export type KernelLockMode = "shared" | "exclusive";

/** `<pid>:<record>:<checkout>` of an ancestor that holds a checkout's build outputs. */
export const checkoutWriterVariable = "OPENSTEER_CHECKOUT_WRITER";

/** Tests point a contending process tree at a private lock directory. */
const directoryVariable = "OPENSTEER_LOCK_DIRECTORY";

export function lockDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment[directoryVariable] || path.join(homedir(), ".local/state/opensteer/locks");
}

/** Darwin open(2): O_SHLOCK and O_EXLOCK take a flock(2) lock atomically with the open. */
const lockFlags = { shared: 0x10, exclusive: 0x20 } as const;

/**
 * Opens `filename` holding a Darwin kernel lock, or returns undefined while a
 * conflicting descriptor holds it. Never unlink or replace a lock file:
 * contenders must keep opening one inode.
 * https://github.com/apple/darwin-xnu/blob/main/bsd/man/man2/open.2
 */
export function tryKernelLock(
  filename: string,
  mode: KernelLockMode = "exclusive",
): number | undefined {
  try {
    return openSync(
      filename,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        noFollowFlag() |
        lockFlags[mode],
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK"))
      return undefined;
    throw error;
  }
}

export interface LockOptions {
  /** What this holder does, shown to the processes waiting for it. */
  readonly purpose: string;
  /** Read for an ancestor's hold and updated while held; `process.env` by default. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

interface Owner {
  readonly pid: number;
  readonly purpose: string;
  readonly cwd: string;
  /** The owner's start time, which tells its process from a later one given the same pid. */
  readonly started: string;
  /** The slot it holds, such as `slot-0`. */
  readonly holds?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

/** When `pid` started, or undefined once it has exited. */
function startTime(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    // ps exits 1 for a pid that is gone; anything else must not pass silently.
    if (!alive(pid)) return undefined;
    throw error;
  }
}

let ownStart: string | undefined;

/** Whether owner record `<pid>-<id>` still holds a lock for this process to inherit. */
function inherits(owners: string, pid: number, id: string): boolean {
  let owner: Owner | undefined;
  try {
    owner = parseOwner(readFileSync(path.join(owners, `${pid}-${id}.json`), "utf8"));
  } catch {
    return false;
  }
  return owner?.pid === pid && startTime(pid) === owner.started;
}

/** Keeps an environment variable naming this hold for children, restoring it on release. */
function advertise(environment: NodeJS.ProcessEnv, name: string, value: string) {
  const previous = environment[name];
  environment[name] = value;
  return () => {
    if (previous === undefined) delete environment[name];
    else environment[name] = previous;
  };
}

/**
 * Holds the right to write a checkout's build outputs (`dist`, native helpers),
 * so two `pnpm check` runs in one checkout never rebuild them under each
 * other. Children inherit it through OPENSTEER_CHECKOUT_WRITER while its owner
 * record names the same live process (pid and start time), so a released hold,
 * a crash or a reused pid admits nothing.
 */
export async function holdCheckoutWrites(
  root: string,
  options: LockOptions,
): Promise<{ release(): void }> {
  if (process.platform !== "darwin") return { release() {} };
  const environment = options.environment ?? process.env;
  const checkout = realpathSync(root);
  const lock = path.join(
    lockDirectory(environment),
    `checkout-${createHash("sha256").update(checkout).digest("hex").slice(0, 16)}`,
  );
  const owners = `${lock}.owners`;
  const token = /^(\d+):([0-9a-f]{8}):(.+)$/su.exec(environment[checkoutWriterVariable] ?? "");
  if (token?.[3] === checkout && inherits(owners, Number(token[1]), token[2] ?? ""))
    return { release() {} };

  const hold = await holdKernelLocks({
    ...options,
    owners,
    label: `Build outputs of ${checkout}`,
    attempt: () => {
      const descriptor = tryKernelLock(lock);
      return descriptor === undefined ? "" : [descriptor];
    },
  });
  const restore = advertise(
    environment,
    checkoutWriterVariable,
    `${process.pid}:${hold.id}:${checkout}`,
  );
  return {
    release() {
      if (hold.release()) restore();
    },
  };
}

export interface KernelHold {
  /** Names the owner record, which an inherited token must match. */
  readonly id: string;
  /** Idempotent; returns whether this call released it. */
  release(): boolean;
}

/**
 * Retries `attempt` until it returns the descriptors to hold, keeping an owner
 * record under `owners` that waiters read. A failed attempt may return a
 * prefix naming what is full; the waiter prints it with the live holders.
 */
export async function holdKernelLocks(options: {
  readonly owners: string;
  readonly label: string;
  readonly purpose: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly attempt: () => number[] | string;
  /** Names what an admitted holder holds, for its owner record. */
  readonly holds?: () => string;
}): Promise<KernelHold> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  mkdirSync(options.owners, { recursive: true, mode: 0o700 });
  const id = randomUUID().slice(0, 8);
  const record = path.join(options.owners, `${process.pid}-${id}.json`);
  const incarnation = (ownStart ??= startTime(process.pid) ?? "");

  let reported: string | undefined;
  const started = performance.now();
  let descriptors: number[] = [];
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const result = options.attempt();
      if (typeof result !== "string") {
        descriptors = result;
        break;
      }
      const waitingFor = `${result}${describeOwners(options.owners, record)}`;
      if (waitingFor !== reported) {
        log(`${options.label} waiting for ${waitingFor}`);
        reported = waitingFor;
      }
      await delay(250, undefined, options.signal ? { signal: options.signal } : undefined);
    }
    const owner: Owner = {
      pid: process.pid,
      purpose: options.purpose,
      cwd: process.cwd(),
      started: incarnation,
      ...(options.holds ? { holds: options.holds() } : {}),
    };
    writeFileSync(`${record}.tmp`, JSON.stringify(owner), { mode: 0o600 });
    renameSync(`${record}.tmp`, record);
  } catch (error) {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(record, { force: true });
    throw error;
  }
  if (reported !== undefined)
    log(`${options.label} admitted after ${((performance.now() - started) / 1000).toFixed(0)} s`);
  let held = true;
  return {
    id,
    release() {
      if (!held) return false;
      held = false;
      rmSync(record, { force: true });
      for (const descriptor of descriptors) closeSync(descriptor);
      return true;
    },
  };
}

function parseOwner(text: string): Owner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    typeof value.purpose !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.started !== "string" ||
    (value.holds !== undefined && typeof value.holds !== "string")
  )
    return undefined;
  return {
    pid: value.pid as number,
    purpose: value.purpose,
    cwd: value.cwd,
    started: value.started,
    ...(typeof value.holds === "string" ? { holds: value.holds } : {}),
  };
}

/** Live owners other than this request; records of dead processes are removed. */
function describeOwners(owners: string, own: string): string {
  const live: Owner[] = [];
  for (const name of readdirSync(owners)) {
    const file = path.join(owners, name);
    if (!name.endsWith(".json") || file === own) continue;
    let owner: Owner | undefined;
    try {
      owner = parseOwner(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!owner) continue;
    if (alive(owner.pid)) live.push(owner);
    else rmSync(file, { force: true });
  }
  if (!live.length) return "an unrecorded holder (it may be finishing)";
  return live
    .sort((a, b) => (a.holds ?? "").localeCompare(b.holds ?? ""))
    .map(
      (owner) =>
        `${owner.holds ? `${owner.holds}: ` : ""}pid ${owner.pid} (${owner.purpose}; ${owner.cwd})`,
    )
    .join(", ");
}
