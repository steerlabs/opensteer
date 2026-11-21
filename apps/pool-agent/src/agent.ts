/**
 * The pool agent: the only source of a guest's identity and the only writer of each slot's
 * profile disk. Every call is checked against slot, term and its expected predecessor, written
 * to the journal before it acts, and answered from its stored result when it comes again.
 * Anything recovery cannot prove ends in a stopped guest, so the next start is a cold one.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolRuntimeFence,
} from "@opensteer/browser-runtime-core/browser-pool";
import type {
  BrowserPoolAgentCall,
  BrowserPoolAgentGuestSpec,
  BrowserPoolAgentResult,
  BrowserPoolAgentSlotSummary,
  BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { signBrowserPoolAgentBytes } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type { GuestBoot, HypervisorDriver } from "./driver.js";
import type { PendingRecord, SlotJournal, SlotRecord } from "./journal.js";
import { Lane, Semaphore, within } from "./lane.js";

export interface PoolAgentDeadlines {
  readonly boot: number;
  readonly sync: number;
  readonly pause: number;
  readonly resume: number;
  readonly snapshot: number;
  readonly restore: number;
  readonly clock: number;
  readonly kill: number;
  readonly network: number;
}

export const defaultDeadlines: PoolAgentDeadlines = {
  boot: 30_000,
  sync: 5_000,
  pause: 5_000,
  resume: 5_000,
  snapshot: 120_000,
  restore: 30_000,
  clock: 3_000,
  kill: 15_000,
  network: 5_000,
};

export interface PoolAgentOptions {
  readonly journal: SlotJournal;
  readonly driver: HypervisorDriver;
  readonly now?: () => number;
  /** How long a parked guest's live state is kept from the moment it was parked. */
  readonly retentionMs?: number;
  /** How long a guest stays paused in memory before it is saved to disk; null keeps it there. */
  readonly saveAfterMs?: number | null;
  readonly maxConcurrentSaves?: number;
  /** How long a call's stored result answers a repeat of the call. */
  readonly resultRetentionMs?: number;
  readonly deadlines?: Partial<PoolAgentDeadlines>;
  /** Events about slots and steps; never guest data. */
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  /** Tests stop the agent dead at a named point, as a crash there would. */
  readonly checkpoint?: (point: string) => void;
}

interface Slot {
  record: SlotRecord;
  readonly lane: Lane;
  controlKey: KeyObject;
  homeKey: KeyObject;
  /** Wakes waiting for this slot: an idle save yields to them. */
  demand: number;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Thrown by a test checkpoint: the agent is dead from here on and writes nothing more. */
export class AgentCrashed extends Error {
  override readonly name = "AgentCrashed";
}

export class SlotNotFound extends Error {
  override readonly name = "SlotNotFound";
}

export class AgentUnavailable extends Error {
  override readonly name = "AgentUnavailable";
}

const maximumResults = 512;
const maximumEffects = 256;

export class PoolAgent {
  readonly #options: PoolAgentOptions;
  readonly #driver: HypervisorDriver;
  readonly #journal: SlotJournal;
  readonly #now: () => number;
  readonly #deadlines: PoolAgentDeadlines;
  readonly #saves: Semaphore;
  readonly #slots = new Map<string, Slot>();
  #incarnation = "";
  #dead = false;
  #closed = false;

  constructor(options: PoolAgentOptions) {
    this.#options = options;
    this.#driver = options.driver;
    this.#journal = options.journal;
    this.#now = options.now ?? Date.now;
    this.#deadlines = { ...defaultDeadlines, ...options.deadlines };
    this.#saves = new Semaphore(options.maxConcurrentSaves ?? 2);
  }

  get retentionMs(): number {
    return this.#options.retentionMs ?? 24 * 60 * 60_000;
  }

  /**
   * Reads the journal and reconciles every slot with the processes and files found. Ambiguity
   * ends in a stop, never in a second writer. Runs once, before any request is accepted.
   */
  async start(): Promise<void> {
    await this.#journal.open();
    this.#incarnation = await this.#driver.incarnation();
    for (const record of await this.#journal.list()) {
      const slot = this.#load(record);
      this.#slots.set(record.slotId, slot);
    }
    for (const slot of this.#slots.values()) await slot.lane.run(() => this.#settle(slot));
    const swept = await this.#driver.sweep(
      new Map(
        [...this.#slots.values()].map((slot) => [
          slot.record.slotId,
          {
            jailId: slot.record.jailId,
            savedStateId: slot.record.saved?.image ? slot.record.saved.id : null,
          },
        ]),
      ),
    );
    if (swept.length) this.#log({ event: "sweep", removed: swept });
    for (const slot of this.#slots.values()) this.#schedule(slot);
  }

  /** Stops timers. The guests keep running: an agent restart is not a guest restart. */
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) this.#unschedule(slot);
  }

  slotIds(): readonly string[] {
    return [...this.#slots.keys()];
  }

  /** The Home's key for this slot, to authenticate a request. */
  homeKey(slotId: string): { readonly key: KeyObject; readonly term: number } | undefined {
    const slot = this.#slots.get(slotId);
    return slot ? { key: slot.homeKey, term: slot.record.term } : undefined;
  }

  controlKey(slotId: string): KeyObject | undefined {
    return this.#slots.get(slotId)?.controlKey;
  }

  /** Applied effects in order, for diagnostics and tests. */
  effects(slotId: string): readonly string[] {
    return this.#slots.get(slotId)?.record.effects ?? [];
  }

  // ---- The controller interface ------------------------------------------------------------

  async status(slotId: string, term: number): Promise<BrowserPoolAgentStatus> {
    const slot = this.#require(slotId);
    if (term !== slot.record.term)
      throw new SlotNotFound("The pool agent does not know this slot and term.");
    // A read never waits behind a long step: it reports what the journal holds now.
    if (slot.lane.busy) return statusOf(slot.record);
    return slot.lane.run(async () => {
      await this.#settle(slot);
      return statusOf(slot.record);
    });
  }

  async result(slotId: string, term: number, id: string): Promise<BrowserPoolAgentResult | null> {
    const slot = this.#slots.get(slotId);
    if (!slot || term !== slot.record.term) return null;
    return structuredClone(stored(slot.record, id) ?? null);
  }

  async apply(call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const slot = this.#require(call.slotId);
    if (call.kind === "resume") slot.demand += 1;
    try {
      return structuredClone(await slot.lane.run(() => this.#apply(slot, call)));
    } finally {
      if (call.kind === "resume") slot.demand -= 1;
    }
  }

  // ---- Slot administration (the provisioner's interface) -----------------------------------

  async createSlot(input: {
    readonly slotId: string;
    readonly term: number;
    readonly homeKey: string;
    readonly guest: BrowserPoolAgentGuestSpec;
  }): Promise<BrowserPoolAgentSlotSummary> {
    const existing = this.#slots.get(input.slotId);
    if (existing) {
      // A repeated create with the same facts is the same create.
      if (existing.record.homeKey === input.homeKey && existing.record.term === input.term)
        return this.#summary(existing);
      throw new SlotConflict("The slot exists with another key or term.");
    }
    parsePublicKey(input.homeKey);
    if (!Number.isSafeInteger(input.term) || input.term < 1)
      throw new SlotConflict("The term must be a positive integer.");
    const { privateKey } = generateKeyPairSync("ed25519");
    const record: SlotRecord = {
      v: 1,
      slotId: input.slotId,
      term: input.term,
      homeKey: input.homeKey,
      controlKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      guest: input.guest,
      createdAt: new Date(this.#now()).toISOString(),
      instance: null,
      epoch: null,
      phase: "stopped",
      saved: null,
      sequence: 0,
      installed: null,
      diskGeneration: 0,
      jailId: null,
      jailGeneration: 0,
      incarnation: null,
      pending: null,
      results: [],
      effects: [],
    };
    await this.#driver.prepareSlot(input.slotId, input.guest.egress);
    await this.#write(record);
    const slot = this.#load(record);
    this.#slots.set(input.slotId, slot);
    this.#log({ event: "slot.created", slotId: input.slotId, term: input.term });
    return this.#summary(slot);
  }

  /** A new Home key and a higher term: every call of the previous term is fenced from now on. */
  async replaceKey(input: {
    readonly slotId: string;
    readonly term: number;
    readonly homeKey: string;
  }): Promise<BrowserPoolAgentSlotSummary> {
    const slot = this.#require(input.slotId);
    return slot.lane.run(async () => {
      if (input.term === slot.record.term && input.homeKey === slot.record.homeKey)
        return this.#summary(slot);
      if (!Number.isSafeInteger(input.term) || input.term <= slot.record.term)
        throw new SlotConflict("A replaced key needs a higher term.");
      const homeKey = parsePublicKey(input.homeKey);
      await this.#commit(slot, { ...slot.record, term: input.term, homeKey: input.homeKey });
      slot.homeKey = homeKey;
      this.#log({ event: "slot.key-replaced", slotId: input.slotId, term: input.term });
      return this.#summary(slot);
    });
  }

  /**
   * Ends the guest, erases its saved state and its network, and forgets the slot. The answer
   * is given only after the VMM's exit was observed and the files are gone. The profile disk
   * is the provisioner's and is left where it is.
   */
  async deleteSlot(slotId: string): Promise<boolean> {
    const slot = this.#slots.get(slotId);
    if (!slot) return true;
    return slot.lane.run(async () => {
      this.#unschedule(slot);
      await this.#kill(slot);
      if (slot.record.saved) await this.#driver.discard(slotId, slot.record.saved.id);
      await this.#driver.removeSlot(slotId);
      this.#guardAlive();
      await this.#journal.remove(slotId);
      this.#slots.delete(slotId);
      this.#log({ event: "slot.deleted", slotId });
      return true;
    });
  }

  summaries(): readonly BrowserPoolAgentSlotSummary[] {
    return [...this.#slots.values()].map((slot) => this.#summary(slot));
  }

  // ---- Calls --------------------------------------------------------------------------------

  async #apply(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = stored(slot.record, call.id);
    if (before) return before;
    // One recovery live and at start: an open step is settled before anything new runs.
    await this.#settle(slot);
    const settled = stored(slot.record, call.id);
    if (settled) return settled;
    const record = slot.record;
    const refusal = refusalOf(record, call);
    if (refusal) return this.#store(slot, record, refused(call.id, refusal, record));
    switch (call.kind) {
      case "start":
        return this.#start(slot, call);
      case "pause":
        return this.#pause(slot, call);
      case "resume":
        return this.#resume(slot, call);
      case "stop":
        return this.#stop(slot, call);
      case "sign":
        return this.#sign(slot, call);
    }
  }

  async #start(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = slot.record;
    const jailGeneration = before.jailGeneration + 1;
    const jailId = jailName(before.slotId, jailGeneration);
    const instance = randomUUID();
    const sequence = before.sequence + 1;
    await this.#commit(slot, {
      ...before,
      jailGeneration,
      pending: { kind: "call", call, step: "booting", at: this.#iso(), jailId },
    });
    this.#checkpoint("start:journaled");
    try {
      // Nobody else may write the profile: every earlier process of the slot is gone first.
      await this.#kill(slot);
      await within(this.#deadlines.network, "Closing the guest network", () =>
        this.#driver.closeNetwork(before.slotId),
      );
      await within(this.#deadlines.boot, "The guest boot", (signal) =>
        this.#driver.boot(this.#boot(slot, jailId, sequence), signal),
      );
      this.#checkpoint("start:booted");
      await within(this.#deadlines.network, "Opening the guest network", () =>
        this.#driver.openNetwork(before.slotId),
      );
    } catch (error) {
      if (error instanceof AgentCrashed) throw error;
      return this.#fail(slot, call, "start-failed", error);
    }
    const fence = { slot: before.slotId, term: before.term, instance, epoch: 1 };
    const control: BrowserPoolControl = {
      kind: "install",
      fence,
      sequence,
      expect: this.#driver.startsEmpty ? null : before.installed,
    };
    const next: SlotRecord = {
      ...slot.record,
      phase: "running",
      instance,
      epoch: 1,
      saved: null,
      sequence,
      installed: fence,
      diskGeneration: before.diskGeneration + 1,
      jailId,
      incarnation: this.#incarnation,
    };
    return this.#store(slot, next, this.#applied(call.id, next, slot, control), "start");
  }

  async #pause(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = slot.record;
    const jailId = before.jailId!;
    await this.#commit(slot, {
      ...before,
      pending: { kind: "call", call, step: "pausing", at: this.#iso() },
    });
    this.#checkpoint("pause:journaled");
    try {
      // The profile disk alone must be usable later: flush it while the guest still runs.
      await within(this.#deadlines.sync, "The guest flush", (signal) =>
        this.#driver.sync(before.slotId, jailId, signal),
      ).catch((error: unknown) => {
        if (error instanceof AgentCrashed) throw error;
        this.#log({ event: "sync.failed", slotId: before.slotId, message: messageOf(error) });
      });
      await within(this.#deadlines.pause, "The guest pause", (signal) =>
        this.#driver.pause(before.slotId, jailId, signal),
      );
      this.#checkpoint("pause:paused");
      await within(this.#deadlines.network, "Closing the guest network", () =>
        this.#driver.closeNetwork(before.slotId),
      );
    } catch (error) {
      if (error instanceof AgentCrashed) throw error;
      return this.#fail(slot, call, "pause-failed", error);
    }
    const parkedAt = this.#now();
    const saved = {
      id: randomUUID(),
      discardAt: new Date(parkedAt + this.retentionMs).toISOString(),
      parkedAt: new Date(parkedAt).toISOString(),
      tier: "memory" as const,
      diskGeneration: before.diskGeneration,
      image: null,
    };
    const next: SlotRecord = { ...slot.record, phase: "paused", saved };
    const result = this.#applied(call.id, next, slot);
    const answer = await this.#store(
      slot,
      next,
      { ...result, savedState: publicSaved(saved) },
      "pause",
    );
    this.#schedule(slot);
    return answer;
  }

  async #resume(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = slot.record;
    const saved = before.saved!;
    let jailId = before.jailId;
    let jailGeneration = before.jailGeneration;
    if (saved.tier === "disk") {
      jailGeneration += 1;
      jailId = jailName(before.slotId, jailGeneration);
    }
    this.#unschedule(slot);
    // The right to resume is consumed here, durably, before anything is loaded or thawed.
    await this.#commit(slot, {
      ...before,
      jailGeneration,
      pending: {
        kind: "call",
        call,
        step: "consumed",
        at: this.#iso(),
        ...(jailId ? { jailId } : {}),
      },
    });
    this.#checkpoint("resume:consumed");
    try {
      await within(this.#deadlines.network, "Closing the guest network", () =>
        this.#driver.closeNetwork(before.slotId),
      );
      if (saved.tier === "disk") {
        if (!saved.image || saved.diskGeneration !== before.diskGeneration)
          throw new Error("The saved state does not match the profile disk.");
        await this.#kill(slot);
        await within(this.#deadlines.restore, "The guest restore", (signal) =>
          this.#driver.restore(
            this.#boot(slot, jailId!, before.sequence + 1),
            saved.image!,
            signal,
          ),
        );
        this.#checkpoint("resume:restored");
      }
      await within(this.#deadlines.resume, "The guest resume", (signal) =>
        this.#driver.resume(before.slotId, jailId!, signal),
      );
      this.#checkpoint("resume:resumed");
      // The guest's wall clock is stepped before any traffic can reach it.
      await within(this.#deadlines.clock, "The guest clock step", (signal) =>
        this.#driver.stepClock(before.slotId, jailId!, signal),
      );
      await within(this.#deadlines.network, "Opening the guest network", () =>
        this.#driver.openNetwork(before.slotId),
      );
    } catch (error) {
      if (error instanceof AgentCrashed) throw error;
      return this.#fail(slot, call, "resume-failed", error);
    }
    const fence = {
      slot: before.slotId,
      term: before.term,
      instance: before.instance!,
      epoch: before.epoch! + 1,
    };
    const sequence = before.sequence + 1;
    const control: BrowserPoolControl = {
      kind: "adopt",
      fence,
      ...(call.intent ? { intent: call.intent } : {}),
      sequence,
      expect: before.installed,
    };
    const next: SlotRecord = {
      ...slot.record,
      phase: "running",
      epoch: fence.epoch,
      saved: null,
      sequence,
      installed: fence,
      jailId,
      incarnation: this.#incarnation,
    };
    return this.#store(slot, next, this.#applied(call.id, next, slot, control), "resume");
  }

  async #stop(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    await this.#commit(slot, {
      ...slot.record,
      pending: { kind: "call", call, step: "stopping", at: this.#iso() },
    });
    this.#checkpoint("stop:journaled");
    return this.#completeStop(slot, call);
  }

  async #completeStop(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    this.#unschedule(slot);
    await within(this.#deadlines.network, "Closing the guest network", () =>
      this.#driver.closeNetwork(slot.record.slotId),
    );
    await this.#kill(slot);
    this.#checkpoint("stop:killed");
    if (slot.record.saved) await this.#driver.discard(slot.record.slotId, slot.record.saved.id);
    const next: SlotRecord = { ...slot.record, phase: "stopped", saved: null, jailId: null };
    return this.#store(slot, next, this.#applied(call.id, next, slot), "stop");
  }

  async #sign(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const record = slot.record;
    const sequence = record.sequence + 1;
    const control = { ...call.control!, sequence, expect: record.installed } as BrowserPoolControl;
    const next: SlotRecord = { ...record, sequence };
    return this.#store(
      slot,
      next,
      this.#applied(call.id, next, slot, control),
      `sign:${control.kind}`,
    );
  }

  /**
   * A step failed or ran out of time: the outcome is not known, so the guest is ended and its
   * live state discarded. The call is answered with a refusal and the status as it is now.
   */
  async #fail(
    slot: Slot,
    call: BrowserPoolAgentCall,
    reason: string,
    error: unknown,
  ): Promise<BrowserPoolAgentResult> {
    this.#log({
      event: "call.failed",
      slotId: call.slotId,
      kind: call.kind,
      reason,
      message: messageOf(error),
    });
    await this.#lose(slot);
    return this.#store(slot, slot.record, refused(call.id, reason, slot.record));
  }

  // ---- Parked guests: the idle save and the discard ----------------------------------------

  #schedule(slot: Slot): void {
    this.#unschedule(slot);
    if (this.#closed) return;
    const saved = slot.record.saved;
    if (slot.record.phase !== "paused" || !saved) return;
    const discardIn = Date.parse(saved.discardAt) - this.#now();
    slot.expiryTimer = setTimeout(
      () => {
        void slot.lane
          .run(() => this.#settle(slot))
          .catch((error: unknown) => this.#background(slot, error));
      },
      Math.max(0, Math.min(discardIn, 2 ** 31 - 1)),
    );
    slot.expiryTimer.unref?.();
    const saveAfter = this.#options.saveAfterMs;
    if (saved.tier === "memory" && saveAfter !== null && saveAfter !== undefined) {
      const saveIn = Date.parse(saved.parkedAt) + saveAfter - this.#now();
      slot.saveTimer = setTimeout(
        () => {
          void this.saveToDisk(slot.record.slotId, saved.id).catch((error: unknown) =>
            this.#background(slot, error),
          );
        },
        Math.max(0, saveIn),
      );
      slot.saveTimer.unref?.();
    }
  }

  #unschedule(slot: Slot): void {
    if (slot.saveTimer) clearTimeout(slot.saveTimer);
    if (slot.expiryTimer) clearTimeout(slot.expiryTimer);
    slot.saveTimer = undefined;
    slot.expiryTimer = undefined;
  }

  #background(slot: Slot, error: unknown): void {
    if (error instanceof AgentCrashed) return;
    this.#log({
      event: "background.failed",
      slotId: slot.record.slotId,
      message: messageOf(error),
    });
  }

  /**
   * Moves a guest paused in memory to the saved-state array and ends its VMM, freeing its
   * memory. A wake that arrives first wins: the image is deleted unread and the guest resumes
   * from memory, so the image is never loaded after its source ran again.
   */
  async saveToDisk(slotId: string, savedStateId: string): Promise<"saved" | "skipped"> {
    const slot = this.#require(slotId);
    const eligible = () =>
      slot.record.phase === "paused" &&
      slot.record.saved?.id === savedStateId &&
      slot.record.saved.tier === "memory" &&
      slot.demand === 0 &&
      !this.#closed;
    if (!eligible()) return "skipped";
    const release = await this.#saves.acquire();
    try {
      return await slot.lane.run(async () => {
        await this.#settle(slot);
        if (!eligible()) return "skipped";
        const before = slot.record;
        await this.#commit(slot, {
          ...before,
          pending: { kind: "save", savedStateId, step: "writing", at: this.#iso() },
        });
        this.#checkpoint("save:journaled");
        let image;
        try {
          image = await within(this.#deadlines.snapshot, "The snapshot", (signal) =>
            this.#driver.snapshot(slotId, before.jailId!, savedStateId, signal),
          );
        } catch (error) {
          if (error instanceof AgentCrashed) throw error;
          this.#log({ event: "save.failed", slotId, message: messageOf(error) });
          await this.#driver.discard(slotId, savedStateId);
          await this.#commit(slot, { ...before, pending: null });
          return "skipped";
        }
        this.#checkpoint("save:written");
        if (slot.demand > 0) {
          // A wake is waiting: resume from memory and never load this image.
          await this.#driver.discard(slotId, savedStateId);
          await this.#commit(slot, { ...before, pending: null });
          return "skipped";
        }
        const withImage: SlotRecord = {
          ...before,
          saved: { ...before.saved!, image },
          pending: { kind: "save", savedStateId, step: "ending-vmm", at: this.#iso() },
        };
        await this.#commit(slot, withImage);
        this.#checkpoint("save:image-recorded");
        await this.#kill(slot);
        this.#checkpoint("save:vmm-ended");
        const next: SlotRecord = {
          ...withImage,
          saved: { ...withImage.saved!, tier: "disk" },
          jailId: null,
          pending: null,
          effects: bounded([...withImage.effects, "save"]),
        };
        await this.#commit(slot, next);
        this.#log({ event: "saved", slotId, savedStateId });
        return "saved";
      });
    } finally {
      release();
      this.#schedule(slot);
    }
  }

  // ---- Recovery ----------------------------------------------------------------------------

  /**
   * Settles whatever the journal left open and checks the slot's physical facts. Used before
   * every call, on reads when the slot is idle, and at start: one recovery, live and at start.
   */
  async #settle(slot: Slot): Promise<void> {
    const record = slot.record;
    if (record.incarnation !== null && record.incarnation !== this.#incarnation) {
      // A host restart ended every VMM and re-keyed the saved-state array.
      await this.#lose(slot, { incarnation: null });
      if (record.pending?.kind === "call")
        await this.#store(
          slot,
          slot.record,
          refused(record.pending.call.id, "host-restarted", slot.record),
        );
      return;
    }
    const pending = record.pending;
    if (pending) await this.#settlePending(slot, pending);
    await this.#check(slot);
  }

  async #settlePending(slot: Slot, pending: PendingRecord): Promise<void> {
    this.#log({
      event: "recover",
      slotId: slot.record.slotId,
      kind: pending.kind,
      step: pending.step,
    });
    if (pending.kind === "call") {
      if (pending.call.kind === "stop") {
        await this.#completeStop(slot, pending.call);
        return;
      }
      if (pending.call.kind === "sign") {
        // Nothing physical happened and no control left: the call is refused.
        await this.#store(slot, slot.record, refused(pending.call.id, "interrupted", slot.record));
        return;
      }
      // A start, pause or resume that may have done part of its work: the guest is ended.
      await this.#lose(slot);
      await this.#store(slot, slot.record, refused(pending.call.id, "interrupted", slot.record));
      return;
    }
    if (pending.kind === "discard") {
      await this.#lose(slot);
      return;
    }
    // An idle save: keep the image only if it is complete and its VMM never ran again.
    const saved = slot.record.saved;
    const jailId = slot.record.jailId;
    if (
      pending.step === "ending-vmm" &&
      saved?.image &&
      (await this.#driver.verify(slot.record.slotId, saved.image))
    ) {
      await this.#kill(slot);
      await this.#commit(slot, {
        ...slot.record,
        saved: { ...saved, tier: "disk" },
        jailId: null,
        pending: null,
        effects: bounded([...slot.record.effects, "save"]),
      });
      return;
    }
    await this.#driver.discard(slot.record.slotId, pending.savedStateId);
    const alive = jailId ? await this.#driver.inspect(slot.record.slotId, jailId) : "absent";
    if (alive === "paused" && saved)
      await this.#commit(slot, { ...slot.record, saved: { ...saved, image: null }, pending: null });
    else await this.#lose(slot);
  }

  /** The journal's view against the processes and files found; a mismatch loses live state. */
  async #check(slot: Slot): Promise<void> {
    const record = slot.record;
    const saved = record.saved;
    if (saved && Date.parse(saved.discardAt) <= this.#now()) {
      await this.#commit(slot, {
        ...record,
        pending: { kind: "discard", savedStateId: saved.id, step: "discarding", at: this.#iso() },
      });
      this.#checkpoint("discard:journaled");
      await this.#lose(slot);
      this.#log({
        event: "discarded",
        slotId: record.slotId,
        savedStateId: saved.id,
        reason: "expired",
      });
      return;
    }
    if (record.phase === "running" || (record.phase === "paused" && saved?.tier === "memory")) {
      const want = record.phase === "running" ? "running" : "paused";
      const state = record.jailId
        ? await this.#driver.inspect(record.slotId, record.jailId)
        : "absent";
      if (state === "unknown" || state === want) return;
      this.#log({ event: "guest.lost", slotId: record.slotId, expected: want, found: state });
      await this.#lose(slot);
      return;
    }
    if (record.phase === "paused" && saved?.tier === "disk") {
      if (saved.image && (await this.#driver.verify(record.slotId, saved.image))) return;
      this.#log({ event: "saved.lost", slotId: record.slotId, savedStateId: saved.id });
      await this.#lose(slot);
    }
  }

  /**
   * Live state is gone or cannot be trusted: end every process, delete the saved state, and
   * leave the slot stopped. The instance is kept, so the next start is visibly a new one.
   */
  async #lose(slot: Slot, extra: Partial<SlotRecord> = {}): Promise<void> {
    this.#unschedule(slot);
    await within(this.#deadlines.network, "Closing the guest network", () =>
      this.#driver.closeNetwork(slot.record.slotId),
    ).catch((error: unknown) => {
      if (error instanceof AgentCrashed) throw error;
      this.#log({
        event: "network.close-failed",
        slotId: slot.record.slotId,
        message: messageOf(error),
      });
    });
    await this.#kill(slot);
    const saved = slot.record.saved;
    if (saved) await this.#driver.discard(slot.record.slotId, saved.id);
    const lost = slot.record.phase !== "stopped" || saved !== null;
    await this.#commit(slot, {
      ...slot.record,
      phase: "stopped",
      epoch: lost ? null : slot.record.epoch,
      saved: null,
      jailId: null,
      pending: null,
      ...extra,
      effects: lost ? bounded([...slot.record.effects, "lost"]) : slot.record.effects,
    });
  }

  async #kill(slot: Slot): Promise<void> {
    await within(this.#deadlines.kill, "Ending the guest's processes", (signal) =>
      this.#driver.kill(slot.record.slotId, signal),
    );
  }

  // ---- Records ------------------------------------------------------------------------------

  #load(record: SlotRecord): Slot {
    return {
      record,
      lane: new Lane(),
      controlKey: createPrivateKey({
        key: Buffer.from(record.controlKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
      homeKey: parsePublicKey(record.homeKey),
      demand: 0,
      saveTimer: undefined,
      expiryTimer: undefined,
    };
  }

  #boot(slot: Slot, jailId: string, nextSequence: number): GuestBoot {
    const record = slot.record;
    return {
      slotId: record.slotId,
      jailId,
      vcpus: record.guest.vcpus,
      memoryMib: record.guest.memoryMib,
      profilePath: record.guest.profilePath,
      parameters: {
        "opensteer.pool.slot": record.slotId,
        "opensteer.pool.key": publicKeyOf(slot.controlKey),
        // The runtime refuses any control at or below this: a replay of an old one included.
        "opensteer.pool.floor": `${record.term}.${nextSequence - 1}`,
      },
    };
  }

  #applied(
    id: string,
    next: SlotRecord,
    slot: Slot,
    control?: BrowserPoolControl,
  ): BrowserPoolAgentResult {
    return {
      id,
      applied: true,
      status: statusOf(next),
      ...(control
        ? {
            control,
            signature: signBrowserPoolAgentBytes(browserPoolControlBytes(control), slot.controlKey),
          }
        : {}),
    };
  }

  async #store(
    slot: Slot,
    next: SlotRecord,
    result: BrowserPoolAgentResult,
    effect?: string,
  ): Promise<BrowserPoolAgentResult> {
    const now = this.#now();
    const retention = this.#options.resultRetentionMs ?? 24 * 60 * 60_000;
    const results = [
      ...next.results.filter((entry) => now - entry.at < retention),
      { at: now, result },
    ];
    await this.#commit(slot, {
      ...next,
      pending: null,
      results: results.slice(-maximumResults),
      effects: effect ? bounded([...next.effects, effect]) : next.effects,
    });
    return result;
  }

  async #commit(slot: Slot, record: SlotRecord): Promise<void> {
    await this.#write(record);
    slot.record = record;
  }

  async #write(record: SlotRecord): Promise<void> {
    this.#guardAlive();
    await this.#journal.write(record);
  }

  #guardAlive(): void {
    if (this.#dead) throw new AgentCrashed("The agent is dead.");
  }

  #checkpoint(point: string): void {
    this.#guardAlive();
    try {
      this.#options.checkpoint?.(point);
    } catch (error) {
      this.#dead = true;
      this.close();
      throw error instanceof AgentCrashed ? error : new AgentCrashed(point);
    }
  }

  #require(slotId: string): Slot {
    if (this.#dead) throw new AgentUnavailable("The agent is dead.");
    const slot = this.#slots.get(slotId);
    if (!slot) throw new SlotNotFound("The pool agent does not know this slot.");
    return slot;
  }

  #summary(slot: Slot): BrowserPoolAgentSlotSummary {
    return {
      slotId: slot.record.slotId,
      term: slot.record.term,
      controlKey: publicKeyOf(slot.controlKey),
      status: statusOf(slot.record),
    };
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #log(event: Readonly<Record<string, unknown>>): void {
    this.#options.log?.({ at: this.#iso(), ...event });
  }
}

export class SlotConflict extends Error {
  override readonly name = "SlotConflict";
}

export function statusOf(record: SlotRecord): BrowserPoolAgentStatus {
  return {
    slotId: record.slotId,
    term: record.term,
    instance: record.instance,
    epoch: record.epoch,
    phase: record.phase,
    savedState: record.phase === "paused" && record.saved ? publicSaved(record.saved) : null,
  };
}

function publicSaved(saved: { readonly id: string; readonly discardAt: string }) {
  return { id: saved.id, discardAt: saved.discardAt };
}

function stored(record: SlotRecord, id: string): BrowserPoolAgentResult | undefined {
  return record.results.find((entry) => entry.result.id === id)?.result;
}

function refused(id: string, reason: string, record: SlotRecord): BrowserPoolAgentResult {
  return { id, applied: false, reason, status: statusOf(record) };
}

/** The checks every call passes before the journal is touched; a refusal changes nothing. */
function refusalOf(record: SlotRecord, call: BrowserPoolAgentCall): string | undefined {
  if (call.slotId !== record.slotId || call.term !== record.term) return "fenced";
  const expect = call.expect;
  if (
    expect.instance !== record.instance ||
    expect.epoch !== record.epoch ||
    expect.phase !== record.phase ||
    expect.savedStateId !== (record.phase === "paused" ? (record.saved?.id ?? null) : null)
  )
    return "predecessor-changed";
  switch (call.kind) {
    case "start":
      return record.phase === "stopped" ? undefined : "not-stopped";
    case "pause":
      return record.phase === "running" && record.jailId ? undefined : "not-running";
    case "resume":
      return record.phase === "paused" && record.saved && call.intent
        ? undefined
        : "no-saved-state";
    case "stop":
      return undefined;
    case "sign": {
      const control = call.control;
      const fence: BrowserPoolRuntimeFence | undefined = control?.fence;
      if (
        !control ||
        record.phase !== "running" ||
        control.kind === "install" ||
        control.kind === "adopt" ||
        !fence ||
        fence.slot !== record.slotId ||
        fence.term !== record.term ||
        fence.instance !== record.instance ||
        fence.epoch !== record.epoch
      )
        return "not-current";
      return undefined;
    }
  }
}

/** Jailer ids allow letters, digits and hyphens, up to 64. Slot ids are hashed into that. */
export function jailName(slotId: string, generation: number): string {
  return `${slotKey(slotId)}-${generation}`;
}

export function slotKey(slotId: string): string {
  return createHash("sha256").update(slotId).digest("hex").slice(0, 24);
}

function parsePublicKey(spki: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new SlotConflict("The Home key must be Ed25519.");
  return key;
}

function publicKeyOf(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

function bounded(effects: readonly string[]): readonly string[] {
  return effects.slice(-maximumEffects);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
