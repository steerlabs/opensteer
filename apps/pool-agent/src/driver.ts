/**
 * What the agent needs from a hypervisor. The agent owns every decision (identity, journal,
 * single use, expiry); a driver only does physical work and reports physical facts. A driver
 * never reads guest data: the one byte it accepts back from a guest is the helper's fixed
 * acknowledgement, compared and discarded.
 */

import type { BrowserPoolAgentGuestSpec } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";

export interface GuestBoot {
  readonly slotId: string;
  /** Unique per VMM process for the life of the host; a jail is never reused. */
  readonly jailId: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly profilePath: string;
  /** Public, non-secret boot parameters for the guest (controller key, sequence floor). */
  readonly parameters: Readonly<Record<string, string>>;
}

/** One saved guest: the driver's own description, opaque to the agent except for its id. */
export interface SavedImage {
  readonly savedStateId: string;
  /** The jail the image was taken in; a restore always uses a new one. */
  readonly sourceJailId: string;
  /** Files as written, with the facts that prove they were not changed since. */
  readonly files: readonly SavedFile[];
  /** The host hardware and software the image can be loaded on. */
  readonly fingerprint: string;
  readonly writtenAt: string;
  /** How long writing and syncing the image took. */
  readonly writeMs?: number;
}

export interface SavedFile {
  readonly name: string;
  readonly size: number;
  readonly inode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  /** SHA-256 of the small device-state file; null for the memory file, which is not hashed. */
  readonly sha256: string | null;
}

/**
 * A write of the driver's own durable state failed, before or after its rename: as for the
 * journal (rule S2), nothing may continue on what memory holds; the agent stops.
 */
export class DriverStateUncertain extends Error {
  override readonly name = "DriverStateUncertain";
}

/** The saved-state array cannot hold this guest's image now; nothing was written. */
export class NoSaveRoom extends Error {
  override readonly name = "NoSaveRoom";
}

export type GuestProcessState = "running" | "paused" | "absent" | "unknown";

export interface HypervisorDriver {
  /**
   * Whether a newly started guest begins with an empty runtime (a real micro-VM), so its
   * install control expects no fence; the loopback stand-in keeps one runtime across starts.
   */
  readonly startsEmpty: boolean;
  /** Changes when the host restarts or its saved-state array is re-keyed. */
  incarnation(): Promise<string>;
  /** The hardware and software a saved image is bound to. */
  fingerprint(): Promise<string>;
  /** Re-applies the host's own rules if they are gone; true if it had to. */
  ensureHost(): Promise<boolean>;
  /** Refuses a guest whose host paths are not inside the roots configured for them. */
  confineGuest(guest: BrowserPoolAgentGuestSpec): Promise<void>;
  /**
   * At agent start: learns in bulk which of these slots' networks exist, and makes or repairs
   * none (re-check finding 3). A slot whose network is missing gets it from prepareSlot when it
   * next starts or resumes.
   */
  prepareSlots(
    slots: readonly { readonly slotId: string; readonly egress: SlotEgress | undefined }[],
  ): Promise<void>;
  /**
   * The slot's number, network namespace, TAP and host-side egress. Idempotent, and cheap once
   * the slot is known to be prepared. Only the number and the host user are made under the
   * host-wide lock.
   */
  prepareSlot(slotId: string, egress: SlotEgress | undefined): Promise<void>;
  /** Removes everything prepareSlot made. Idempotent. */
  removeSlot(slotId: string): Promise<void>;
  /** Lets the guest reach its egress proxy (and the bridge seam reach the guest). */
  openNetwork(slotId: string): Promise<void>;
  /** Drops every packet to and from the guest except the agent's helper channel. */
  closeNetwork(slotId: string): Promise<void>;
  /** A cold boot on the profile disk; resolves when the guest helper answers. */
  boot(boot: GuestBoot, signal: AbortSignal): Promise<void>;
  /** Flushes the guest's filesystems to its disks (best effort, bounded by the signal). */
  sync(slotId: string, jailId: string, signal: AbortSignal): Promise<void>;
  pause(slotId: string, jailId: string, signal: AbortSignal): Promise<void>;
  /** Resumes vCPUs of a paused guest in the same process. */
  resume(slotId: string, jailId: string, signal: AbortSignal): Promise<void>;
  /** A full snapshot of a paused guest, written and synced; the guest stays paused. */
  /** Whether the saved-state array has room for this guest's image now (nothing reserved). */
  saveRoom(slotId: string, jailId: string): Promise<boolean>;
  snapshot(
    slotId: string,
    jailId: string,
    savedStateId: string,
    signal: AbortSignal,
  ): Promise<SavedImage>;
  /** A new jailed process loaded from the image with vCPUs paused. The image is consumed. */
  restore(boot: GuestBoot, image: SavedImage, signal: AbortSignal): Promise<void>;
  /** Steps the guest's wall clock from the host's; vCPUs must be running. */
  stepClock(slotId: string, jailId: string, signal: AbortSignal): Promise<void>;
  /** Whether the image is exactly as written and loadable here. Reads metadata only. */
  verify(slotId: string, image: SavedImage): Promise<boolean>;
  /** Deletes the image's files. Idempotent. */
  discard(slotId: string, savedStateId: string): Promise<void>;
  /** The state of one VMM process, from the process and its API, never from the guest. */
  inspect(slotId: string, jailId: string): Promise<GuestProcessState>;
  /** Ends every process of the slot and waits until none is left, then removes its jails. */
  kill(slotId: string, signal: AbortSignal): Promise<void>;
  /** Ends processes and removes jails and images that no slot record names. */
  sweep(
    known: ReadonlyMap<string, { jailId: string | null; savedStateId: string | null }>,
  ): Promise<readonly string[]>;
}

export interface SlotEgress {
  readonly upstreamUrl: string;
  readonly usernameFile: string;
  readonly passwordFile: string;
  readonly caFile?: string;
}
