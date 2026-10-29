import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isRecord } from "@opensteer/shared/isRecord";
import { isNodeError } from "@opensteer/shared/nodeError";
import { holdKernelLocks, tryKernelLock } from "@opensteer/shared/kernelLock";
import { noFollowFlag } from "@opensteer/shared/privateFiles";

export interface QueuedSlot {
  /** Which of the slots this holder has. */
  readonly slot: number;
  /** Idempotent. */
  release(): void;
}

/** Darwin open(2): O_SHLOCK and O_EXLOCK take a flock(2) lock atomically with the open. */
const lockFlags = { shared: 0x10, exclusive: 0x20 } as const;

let tickets = 0;

/**
 * A waiter's place in the queue: a file it keeps kernel-locked until admitted,
 * named so that names sort in arrival order (time, pid, then this process's
 * own sequence). Its owner's death releases the lock, so no ticket of a dead
 * waiter can hold the queue, whatever its pid has become since.
 */
function takeTicket(queue: string, purpose: string) {
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-${String(tickets++).padStart(6, "0")}`;
  const file = path.join(queue, name);
  const descriptor = openSync(
    file,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag() | lockFlags.exclusive,
    0o600,
  );
  writeSync(descriptor, JSON.stringify({ pid: process.pid, purpose, cwd: process.cwd() }));
  return {
    name,
    release() {
      rmSync(file, { force: true });
      closeSync(descriptor);
    },
  };
}

/** The live waiters that queued before `own`, first to last; tickets nobody holds are removed. */
function waitersAhead(queue: string, own: string): string[] {
  const waiters: string[] = [];
  for (const name of readdirSync(queue).sort()) {
    if (name >= own) break;
    const file = path.join(queue, name);
    try {
      closeSync(
        openSync(
          file,
          constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag() | lockFlags.shared,
        ),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      if (!isNodeError(error) || (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK"))
        throw error;
      // Locked: its waiter is alive and still queued.
      let waiter: unknown;
      try {
        waiter = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        waiter = undefined;
      }
      waiters.push(
        isRecord(waiter)
          ? `pid ${String(waiter.pid)} (${String(waiter.purpose)}; ${String(waiter.cwd)})`
          : "an earlier request",
      );
      continue;
    }
    rmSync(file, { force: true });
  }
  return waiters;
}

/**
 * Waits for one of `count` VM guest slots in `directory` and holds it until
 * `release()`. macOS runs at most two guests, so waiters take a free slot in
 * arrival order, and nobody stops a holder. A waiter prints who holds each
 * slot and who is queued ahead of it. Only Darwin, where guests run, has these
 * locks; elsewhere admission is immediate.
 */
export async function holdQueuedSlot(
  directory: string,
  options: {
    /** What waiters call a slot, such as "VM slot". */
    readonly label: string;
    /** The slots are the kernel locks `<directory>/slot-<n>` for n below `count`. */
    readonly count: number;
    readonly purpose: string;
    readonly signal?: AbortSignal;
    readonly log?: (line: string) => void;
  },
): Promise<QueuedSlot> {
  if (process.platform !== "darwin") return { slot: 0, release() {} };
  const queue = path.join(directory, "slot.queue");
  const ticket = takeTicket(queue, options.purpose);
  let slot = -1;
  let hold: Awaited<ReturnType<typeof holdKernelLocks>>;
  try {
    hold = await holdKernelLocks({
      ...options,
      owners: path.join(directory, "slot.owners"),
      holds: () => `slot-${slot}`,
      attempt: () => {
        const ahead = waitersAhead(queue, ticket.name);
        const full = `one of ${options.count} slots, held by `;
        if (ahead.length) return `${ahead.join(", ")}, then for ${full}`;
        for (let index = 0; index < options.count; index++) {
          const descriptor = tryKernelLock(path.join(directory, `slot-${index}`));
          if (descriptor === undefined) continue;
          slot = index;
          return [descriptor];
        }
        return full;
      },
    });
  } finally {
    ticket.release();
  }
  return {
    slot,
    release() {
      hold.release();
    },
  };
}
