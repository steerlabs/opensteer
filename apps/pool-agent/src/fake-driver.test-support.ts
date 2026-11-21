import { randomUUID } from "node:crypto";
import {
  NoSaveRoom,
  type GuestBoot,
  type GuestProcessState,
  type HypervisorDriver,
  type SavedImage,
  type SlotEgress,
} from "./driver.js";

type Operation =
  | "boot"
  | "sync"
  | "pause"
  | "resume"
  | "snapshot"
  | "restore"
  | "stepClock"
  | "kill"
  | "openNetwork"
  | "closeNetwork"
  | "discard"
  | "verify"
  | "inspect";

interface Process {
  readonly slotId: string;
  readonly jailId: string;
  state: "running" | "paused";
  /** Set when this process's memory was saved: running it again makes that image unsafe. */
  snapshotted: string | null;
}

/**
 * A hypervisor with no VMs: processes, images and networks are records, faults and gates are
 * injected, and the physical facts survive an agent restart (a new agent on the same driver),
 * exactly as real processes and files would. It fails a test that ever runs two writers.
 */
export class FakeHypervisorDriver implements HypervisorDriver {
  readonly startsEmpty: boolean;
  readonly processes = new Map<string, Process>();
  readonly images = new Map<string, { slotId: string; image: SavedImage; intact: boolean }>();
  readonly networks = new Map<string, "open" | "closed">();
  readonly prepared = new Set<string>();
  readonly operations: string[] = [];
  readonly violations: string[] = [];
  /** Images whose source process ran again after they were taken: never to be loaded. */
  readonly tainted = new Set<string>();
  readonly loaded = new Map<string, number>();
  /** Snapshots that published their image (late ones included). */
  snapshotsFinished = 0;
  #incarnation = randomUUID();
  #fingerprint = "fake-host-1";
  readonly #faults = new Map<Operation, { error?: Error; hang?: boolean; count: number }>();
  readonly #gates = new Map<Operation, Promise<void>>();
  readonly #unknown = new Map<string, number>();

  constructor(options: { startsEmpty?: boolean } = {}) {
    this.startsEmpty = options.startsEmpty ?? false;
  }

  /** The next `count` calls of `operation` fail with this error, or never answer. */
  fail(operation: Operation, error: Error | "hang", count = 1): void {
    this.#faults.set(operation, error === "hang" ? { hang: true, count } : { error, count });
  }

  /** Every `operation` waits for this promise before it acts. */
  gate(operation: Operation, until: Promise<void> | undefined): void {
    if (until) this.#gates.set(operation, until);
    else this.#gates.delete(operation);
  }

  /** The VMM's API does not answer the next `times` inspections (the process still exists). */
  answerUnknown(jailId: string, times = Number.POSITIVE_INFINITY): void {
    this.#unknown.set(jailId, times);
  }

  /** The host restarted: every process and every image is gone; the incarnation changes. */
  restartHost(): void {
    this.processes.clear();
    this.images.clear();
    this.networks.clear();
    this.#incarnation = randomUUID();
  }

  /** The guest died and its saved state vanished, as a physical fact the agent must notice. */
  loseGuest(slotId: string): void {
    for (const [id, process] of this.processes)
      if (process.slotId === slotId) this.processes.delete(id);
    for (const [id, image] of this.images) if (image.slotId === slotId) this.images.delete(id);
  }

  corrupt(savedStateId: string): void {
    const image = this.images.get(savedStateId);
    if (image) image.intact = false;
  }

  /** A newer host software or hardware: no older image loads. */
  changeFingerprint(value: string): void {
    this.#fingerprint = value;
  }

  writers(slotId: string): number {
    return [...this.processes.values()].filter((process) => process.slotId === slotId).length;
  }

  async incarnation(): Promise<string> {
    return this.#incarnation;
  }

  async fingerprint(): Promise<string> {
    return this.#fingerprint;
  }

  /** The host table was flushed: the next check re-applies it. */
  hostTableGone = false;
  hostRepairs = 0;

  async ensureHost(): Promise<boolean> {
    if (!this.hostTableGone) return false;
    this.hostTableGone = false;
    this.hostRepairs += 1;
    return true;
  }

  async confineGuest(guest: { readonly profilePath: string }): Promise<void> {
    if (guest.profilePath.split("/").includes(".."))
      throw new Error("The profile path leaves its root.");
  }

  async prepareSlots(
    slots: readonly { readonly slotId: string; readonly egress: SlotEgress | undefined }[],
  ): Promise<void> {
    // Only learns what exists: a slot's network is made when it next starts or resumes.
    void slots;
  }

  /** How long making one slot's namespace and proxy socket takes; one at a time, host-wide. */
  prepareMs = 0;
  #prepareLock: Promise<void> = Promise.resolve();

  async prepareSlot(slotId: string, _egress: SlotEgress | undefined): Promise<void> {
    if (this.prepared.has(slotId)) return;
    const turn = this.#prepareLock.then(async () => {
      if (this.prepareMs) await new Promise((resolve) => setTimeout(resolve, this.prepareMs));
    });
    this.#prepareLock = turn.catch(() => undefined);
    await turn;
    this.prepared.add(slotId);
    this.networks.set(slotId, this.networks.get(slotId) ?? "closed");
  }

  /** A host reboot: no guest, no namespace, no proxy socket survives; files on disk do. */
  rebootHost(): void {
    this.processes.clear();
    this.prepared.clear();
    this.networks.clear();
  }

  async removeSlot(slotId: string): Promise<void> {
    this.prepared.delete(slotId);
    this.networks.delete(slotId);
  }

  async openNetwork(slotId: string): Promise<void> {
    await this.#enter("openNetwork", slotId);
    this.networks.set(slotId, "open");
  }

  async closeNetwork(slotId: string): Promise<void> {
    await this.#enter("closeNetwork", slotId);
    this.networks.set(slotId, "closed");
  }

  async boot(boot: GuestBoot, _signal: AbortSignal): Promise<void> {
    if (!this.prepared.has(boot.slotId))
      this.violations.push(`booted ${boot.slotId} without its network`);
    await this.#enter("boot", boot.slotId);
    this.#oneWriter(boot.slotId);
    this.processes.set(boot.jailId, {
      slotId: boot.slotId,
      jailId: boot.jailId,
      state: "running",
      snapshotted: null,
    });
  }

  async sync(slotId: string, jailId: string): Promise<void> {
    await this.#enter("sync", slotId);
    this.#process(jailId, "running");
  }

  async pause(slotId: string, jailId: string): Promise<void> {
    await this.#enter("pause", slotId);
    this.#process(jailId, "running").state = "paused";
  }

  async resume(slotId: string, jailId: string): Promise<void> {
    await this.#enter("resume", slotId);
    const process = this.#process(jailId, "paused");
    if (process.snapshotted) {
      // Its image may never be loaded now; the agent must have deleted it already.
      if (this.images.has(process.snapshotted))
        this.violations.push(`resumed ${jailId} while its image ${process.snapshotted} exists`);
      this.tainted.add(process.snapshotted);
      process.snapshotted = null;
    }
    process.state = "running";
  }

  /**
   * The memory is captured when the call arrives; the image is published once the gate opens,
   * whatever the caller's signal says, as a Firecracker API call that was already sent would.
   */
  /** Whether the saved-state array has room for an image. */
  room = true;

  async saveRoom(_slotId: string, jailId: string): Promise<boolean> {
    this.#process(jailId, "paused");
    return this.room;
  }

  async snapshot(slotId: string, jailId: string, savedStateId: string): Promise<SavedImage> {
    const process = this.#process(jailId, "paused");
    if (!this.room) throw new NoSaveRoom("The saved-state array has no room for this guest.");
    process.snapshotted = savedStateId;
    await this.#enter("snapshot", slotId);
    const image: SavedImage = {
      savedStateId,
      sourceJailId: jailId,
      files: [
        {
          name: "vmstate",
          size: 24_580,
          inode: 1,
          mtimeNs: "1",
          ctimeNs: "1",
          sha256: "0".repeat(64),
        },
        { name: "memory", size: 1 << 30, inode: 2, mtimeNs: "1", ctimeNs: "1", sha256: null },
      ],
      fingerprint: this.#fingerprint,
      writtenAt: new Date().toISOString(),
    };
    this.images.set(savedStateId, { slotId, image, intact: true });
    this.snapshotsFinished += 1;
    return image;
  }

  async restore(boot: GuestBoot, image: SavedImage): Promise<void> {
    if (!this.prepared.has(boot.slotId))
      this.violations.push(`restored ${boot.slotId} without its network`);
    await this.#enter("restore", boot.slotId);
    const stored = this.images.get(image.savedStateId);
    if (!stored || !stored.intact) throw new Error("The image is missing or damaged.");
    if (this.tainted.has(image.savedStateId))
      this.violations.push(`loaded ${image.savedStateId} after its source ran again`);
    this.loaded.set(image.savedStateId, (this.loaded.get(image.savedStateId) ?? 0) + 1);
    if (this.loaded.get(image.savedStateId)! > 1)
      this.violations.push(`loaded ${image.savedStateId} twice`);
    this.#oneWriter(boot.slotId);
    // Loading consumes the image: its files are unlinked once mapped.
    this.images.delete(image.savedStateId);
    this.processes.set(boot.jailId, {
      slotId: boot.slotId,
      jailId: boot.jailId,
      state: "paused",
      snapshotted: null,
    });
  }

  async stepClock(slotId: string, jailId: string): Promise<void> {
    await this.#enter("stepClock", slotId);
    this.#process(jailId, "running");
  }

  async verify(slotId: string, image: SavedImage): Promise<boolean> {
    await this.#enter("verify", slotId);
    const stored = this.images.get(image.savedStateId);
    return !!stored && stored.intact && image.fingerprint === this.#fingerprint;
  }

  async discard(slotId: string, savedStateId: string): Promise<void> {
    await this.#enter("discard", slotId);
    this.images.delete(savedStateId);
  }

  async inspect(slotId: string, jailId: string): Promise<GuestProcessState> {
    await this.#enter("inspect", slotId);
    const unknown = this.#unknown.get(jailId) ?? 0;
    if (unknown > 0 && this.processes.has(jailId)) {
      this.#unknown.set(jailId, unknown - 1);
      return "unknown";
    }
    return this.processes.get(jailId)?.state ?? "absent";
  }

  async kill(slotId: string): Promise<void> {
    await this.#enter("kill", slotId);
    for (const [id, process] of this.processes)
      if (process.slotId === slotId) this.processes.delete(id);
  }

  async sweep(
    known: ReadonlyMap<string, { jailId: string | null; savedStateId: string | null }>,
  ): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const [id, process] of this.processes) {
      if (known.get(process.slotId)?.jailId !== id) {
        this.processes.delete(id);
        removed.push(`process:${id}`);
      }
    }
    for (const [id, image] of this.images) {
      if (known.get(image.slotId)?.savedStateId !== id) {
        this.images.delete(id);
        removed.push(`image:${id}`);
      }
    }
    return removed;
  }

  #oneWriter(slotId: string): void {
    if (this.writers(slotId) > 0) this.violations.push(`two writers of ${slotId}`);
  }

  #process(jailId: string, state: Process["state"]): Process {
    const process = this.processes.get(jailId);
    if (!process) throw new Error(`No process ${jailId}.`);
    if (process.state !== state)
      throw new Error(`Process ${jailId} is ${process.state}, not ${state}.`);
    return process;
  }

  async #enter(operation: Operation, slotId: string): Promise<void> {
    this.operations.push(`${operation}:${slotId}`);
    const gate = this.#gates.get(operation);
    if (gate) await gate;
    const fault = this.#faults.get(operation);
    if (fault) {
      fault.count -= 1;
      if (fault.count <= 0) this.#faults.delete(operation);
      if (fault.hang) await new Promise<never>(() => {});
      throw fault.error!;
    }
  }
}
