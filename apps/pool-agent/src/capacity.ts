/**
 * Round E, E4: how many guests a host holds in memory, as one arithmetic for the host's budget,
 * each guest's ceiling and the agent's admission. A guest running or paused in memory is held
 * to `memory.high` = its memory + 512 MiB inside one budget for all guests (the host's memory
 * less max(2 GiB, 10 %) less the proxies' slice), and its proxy to one proxy's ceiling inside
 * that slice. A start or a wake that would pass either is not let in: guests paused in memory
 * are saved to disk first, and if that is not enough it is refused as "not now".
 */

const mib = 1024 ** 2;

/** What a guest is charged while it is in memory: its `memory.high`. */
export function guestCharge(memoryMib: number): number {
  return (memoryMib + 512) * mib;
}

/** What all guests together may hold: the host less its own room and the proxies' slice. */
export function guestBudget(totalBytes: number, egressSliceBytes: number): number {
  return totalBytes - Math.max(2 * 1024 ** 3, Math.floor(totalBytes / 10)) - egressSliceBytes;
}

export interface HostCapacity {
  /** The guests' budget (`guests/memory.max`). */
  readonly guestBytes: number;
  /** How many slot proxies the slice holds at their own ceiling. */
  readonly proxies: number;
}

export function hostCapacity(
  totalBytes: number,
  egressSliceBytes: number,
  proxyBytes: number,
): HostCapacity {
  return {
    guestBytes: guestBudget(totalBytes, egressSliceBytes),
    proxies: Math.floor(egressSliceBytes / proxyBytes),
  };
}

/** Whether one more guest of `charge` fits beside the guests in memory (their charges). */
export function fits(capacity: HostCapacity, inMemory: readonly number[], charge: number): boolean {
  const used = inMemory.reduce((sum, each) => sum + each, 0);
  return used + charge <= capacity.guestBytes && inMemory.length + 1 <= capacity.proxies;
}
