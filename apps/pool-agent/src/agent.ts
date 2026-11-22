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
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { browserPoolAgentRequestWindowMs } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolRuntimeFence,
} from "@opensteer/browser-runtime-core/browser-pool";
import type {
  BrowserPoolAgentCall,
  BrowserPoolAgentGuestRequest,
  BrowserPoolAgentGuestSpec,
  BrowserPoolAgentResult,
  BrowserPoolAgentSlotSummary,
  BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { signBrowserPoolAgentBytes } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import {
  poolRelayGrantBytes,
  type PoolRelayGrant,
  type PoolRelayHello,
} from "@opensteer/shared/poolRelay";
import type { RelayDecision } from "./relay.js";
import {
  DriverStateUncertain,
  NoSaveRoom,
  type GuestBoot,
  type GuestProcessState,
  type HypervisorDriver,
  type SlotEgress,
} from "./driver.js";
import { fits, guestCharge } from "./capacity.js";
import { ProfilesFull } from "./profiles.js";
import { acceptSlotEgress, type SlotEgressAnswer } from "./slot-egress-fetch.js";
import {
  isTombstone,
  type JournalRecord,
  type PendingRecord,
  type SlotJournal,
  type SlotRecord,
  type TombstoneRecord,
} from "./journal.js";
import { DeadlineExceeded, finishedWithin, Lane, mapLimit, Semaphore, within } from "./lane.js";

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
  readonly discard: number;
  readonly verify: number;
  /** How long a VMM whose API does not answer is asked again before its guest counts as lost. */
  readonly inspect: number;
  readonly sweep: number;
  /** How long a save that ran out of time waits for its writer before the VMM is ended. */
  readonly snapshotDrain: number;
  /** Round H: how long a slot's credentials are fetched from the account service. */
  readonly egress: number;
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
  discard: 30_000,
  verify: 10_000,
  inspect: 3_000,
  sweep: 60_000,
  snapshotDrain: 30_000,
  egress: 10_000,
};

/** The binding limit on how long a parked guest's live state may be kept. */
export const maximumRetentionMs = 24 * 60 * 60_000;

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
  /** How many stored answers a slot keeps (512). */
  readonly maxResults?: number;
  /** How often the host's own rules are checked for a flush or a reload. */
  readonly hostCheckMs?: number;
  /** How soon an unfinished step (a failed clean-up, a failed expiry) is tried again. */
  readonly retryMs?: number;
  /** A failed idle save is tried again after this, doubling each time up to 30 minutes. */
  readonly saveRetryMs?: number;
  /** A save the array had no room for waits for space to change, or this long (30 minutes). */
  readonly saveRoomRetryMs?: number;
  readonly deadlines?: Partial<PoolAgentDeadlines>;
  /** Events about slots and steps; never guest data. */
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  /** Tests stop the agent dead at a named point, as a crash there would. */
  readonly checkpoint?: (point: string) => void;
  /**
   * A journal write failed or its outcome is uncertain: the agent stops serving and this is
   * called. The daemon exits; the service manager starts it again and recovery reads the disk.
   */
  readonly fatal?: (error: unknown) => void;
  /**
   * Round H: on a host that pulls its slots' credentials, fetches one slot's from the account
   * service (`fetchSlotEgress`): its upstream, or null when none is assigned; a throw when the
   * fetch could not be completed. Required exactly when the driver pulls.
   */
  readonly egressFetch?: (slotId: string, signal: AbortSignal) => Promise<SlotEgressAnswer | null>;
}

interface Slot {
  record: SlotRecord;
  readonly lane: Lane;
  controlKey: KeyObject;
  homeKey: KeyObject;
  /** Grows with every Home key replacement: a request is served only by the key it was checked with. */
  keyGeneration: number;
  /** Deleted: nothing queued on this slot may act or write any more. */
  deleted: boolean;
  /** Wakes waiting for this slot: an idle save yields to them. */
  demand: number;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** An unfinished step (a failed clean-up, a failed expiry) is tried again from here. */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last job failed: the next timed attempt waits at least the retry interval. */
  failedAt: number | undefined;
  /** Idle saves of the current park that failed: the next one waits longer each time. */
  saveFailure: SaveFailure | undefined;
}

interface SaveFailure {
  readonly savedStateId: string;
  readonly count: number;
  /** performance.now() of the last failure. */
  readonly at: number;
  /** The array had no room: the space generation then; retried once space changed. */
  readonly room: number | undefined;
}

/** Thrown by a test checkpoint: the agent is dead from here on and writes nothing more. */
export class AgentCrashed extends Error {
  override readonly name = "AgentCrashed";
}

export class SlotNotFound extends Error {
  override readonly name = "SlotNotFound";
}

/** The request was authenticated with a Home key this slot no longer has. */
export class SlotFenced extends Error {
  override readonly name = "SlotFenced";
}

/** What authenticates a request for a slot: its Home key, that key's term and generation. */
export interface SlotAuthority {
  readonly key: KeyObject;
  readonly term: number;
  readonly generation: number;
  readonly deleted: boolean;
}

const tombstoneRetentionMs = 30 * 24 * 60 * 60_000;

export class AgentUnavailable extends Error {
  override readonly name = "AgentUnavailable";
}

/** A Home may repeat a call (with a fresh envelope) for this long after its first answer. */
const protectedAnswerMs = 2 * browserPoolAgentRequestWindowMs;
const maximumEffects = 256;

export class PoolAgent {
  readonly #options: PoolAgentOptions;
  readonly #driver: HypervisorDriver;
  readonly #journal: SlotJournal;
  readonly #now: () => number;
  readonly #deadlines: PoolAgentDeadlines;
  readonly #saves: Semaphore;
  /** Round D, D1: slots whose proxy is down, from the last host check. */
  #proxiesDown = new Set<string>();
  /** Round E, E4: slots let into memory whose start or wake has not finished. */
  readonly #admitting = new Set<string>();
  /** Deleted slots (re-check finding 4): no key of their own, and gone from #slots. */
  readonly #tombstones = new Map<
    string,
    { readonly record: TombstoneRecord; readonly homeKey: KeyObject }
  >();
  /** Grows each time an image is deleted: a save that had no room may fit now. */
  #spaceChanges = 0;
  readonly #slots = new Map<string, Slot>();
  /** Creates run one at a time: two creates of one id are one create. */
  readonly #admin = new Lane();
  #incarnation = "";
  #dead = false;
  #hostCheck: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: PoolAgentOptions) {
    this.#options = options;
    this.#driver = options.driver;
    this.#journal = options.journal;
    this.#now = options.now ?? Date.now;
    this.#deadlines = { ...defaultDeadlines, ...options.deadlines };
    this.#saves = new Semaphore(options.maxConcurrentSaves ?? 2);
    const retention = options.retentionMs ?? maximumRetentionMs;
    // The setting may lower the limit, never raise it.
    if (!(retention > 0 && retention <= maximumRetentionMs))
      throw new RangeError("A parked guest's live state is kept at most 24 hours.");
  }

  get retentionMs(): number {
    return this.#options.retentionMs ?? maximumRetentionMs;
  }

  /** Every driver step the agent awaits has a deadline. */
  #step<T>(name: keyof PoolAgentDeadlines, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const step = within(this.#deadlines[name], `The ${name} step`, work);
    if (name !== "discard") return step;
    return step.then((value) => {
      this.#spaceFreed();
      return value;
    });
  }

  /**
   * Reads the journal and reconciles every slot with the processes and files found. Ambiguity
   * ends in a stop, never in a second writer. Runs once, before any request is accepted.
   */
  async start(): Promise<void> {
    await this.#journal.open();
    // Round H: a host that pulls its slots' credentials has a way to fetch them, and only it.
    if (this.#driver.pullsEgress !== (this.#options.egressFetch !== undefined))
      throw new Error("The agent fetches slot egress exactly when its driver pulls it.");
    this.#incarnation = await this.#step("verify", () => this.#driver.incarnation());
    // Round E, E4: the room the agent admits guests into memory by, as computed on this host.
    const capacity = this.#driver.memoryCapacity();
    if (capacity) this.#log({ event: "capacity", ...capacity });
    for (const found of await this.#journal.list()) {
      let record: JournalRecord = found;
      // A tombstone written before re-check finding 4 still held the slot's key: replaced now.
      if (!isTombstone(record) && record.deletedAt) {
        record = tombstoneOf(record, record.deletedAt);
        await this.#write(record);
      }
      if (isTombstone(record)) {
        if (Date.parse(record.deletedAt) + tombstoneRetentionMs <= this.#now())
          await this.#removeRecord(record.slotId);
        else this.#keepTombstone(record);
        continue;
      }
      const slot = this.#load(record);
      this.#slots.set(record.slotId, slot);
    }
    // Re-check finding 3: the driver only learns, in bulk, which slots' networks exist. A host
    // restart removed every namespace, and no guest survived it, so nothing is made here: a
    // slot's network is made when it next starts or resumes. Then each slot's recovery runs with
    // bounded parallelism (each still alone on its own lane).
    await within(this.#deadlines.sweep, "Reading every slot's network", () =>
      this.#driver.prepareSlots(
        this.#live().map((slot) => ({
          slotId: slot.record.slotId,
          egress: slot.record.guest.egress,
        })),
      ),
    );
    // A crash between a create's number and its journal write leaves a number, a namespace and
    // a proxy socket no slot owns: they are removed before anything is served.
    const owned = new Set(this.#slots.keys());
    for (const slotId of await this.#step("verify", () => this.#driver.slotsKnown()))
      if (!owned.has(slotId)) {
        await this.#step("network", () => this.#driver.removeSlot(slotId));
        this.#log({ event: "slot.orphan-released", slotId });
      }
    await mapLimit(this.#live(), 16, (slot) => slot.lane.run(() => this.#settle(slot)));
    // Round I, U3: on a pulling host no guest keeps running behind a proxy unit an earlier
    // agent or configuration made (one that does not require an upstream, or loads its
    // credentials from elsewhere): it is ended. A guest paused in memory gets the slot's own
    // unit at its wake, before it runs.
    if (this.#driver.pullsEgress)
      for (const slot of this.#live())
        if (
          slot.record.phase === "running" &&
          !(await this.#step("verify", () =>
            this.#driver.proxyRequiresUpstream(slot.record.slotId),
          ))
        ) {
          await slot.lane.run(() => this.#lose(slot));
          this.#log({ event: "egress.unrequired-ended", slotId: slot.record.slotId });
        }
    const swept = await this.#step("sweep", () =>
      this.#driver.sweep(
        new Map(
          this.#live().map((slot) => [
            slot.record.slotId,
            {
              jailId: slot.record.jailId,
              savedStateId: slot.record.saved?.image ? slot.record.saved.id : null,
            },
          ]),
        ),
      ),
    );
    if (swept.length) this.#log({ event: "sweep", removed: swept });
    for (const slot of this.#live()) this.#schedule(slot);
    // Review G4(a): a flush or reload of the host's ruleset is noticed and repaired.
    this.#hostCheck = setInterval(() => {
      void this.#ensureHost().catch((error: unknown) =>
        this.#log({ event: "host-table.failed", message: messageOf(error) }),
      );
      // Round D, D1: which slots' proxies tripped their start limit.
      void this.#driver.proxiesDown().then(
        (down) => {
          const next = new Set(down);
          for (const slotId of next)
            if (!this.#proxiesDown.has(slotId)) this.#log({ event: "proxy.down", slotId });
          this.#proxiesDown = next;
        },
        (error: unknown) => this.#log({ event: "proxy.check-failed", message: messageOf(error) }),
      );
      // Re-check finding 4: tombstones are pruned while the agent runs.
      void this.#admin
        .run(() => this.#pruneTombstones())
        .catch((error: unknown) => {
          if (!(error instanceof AgentCrashed))
            this.#log({ event: "tombstones.failed", message: messageOf(error) });
        });
    }, this.#options.hostCheckMs ?? 10_000);
    this.#hostCheck.unref?.();
  }

  async #pruneTombstones(): Promise<void> {
    for (const [slotId, { record }] of this.#tombstones)
      if (Date.parse(record.deletedAt) + tombstoneRetentionMs <= this.#now()) {
        await this.#removeRecord(slotId);
        this.#tombstones.delete(slotId);
      }
  }

  #keepTombstone(record: TombstoneRecord): void {
    this.#tombstones.set(record.slotId, { record, homeKey: parsePublicKey(record.homeKey) });
  }

  /**
   * Before a start or a wake: the slot's network, and its proxy back if it tripped its limit
   * (round D, D1). Round E, E2: each step's host work takes the step's signal, and a step that
   * ran out of time is drained before this returns, so the slot's lane is never released (and
   * the slot never deleted, nor its number reused) while that work may still run.
   */
  async #prepareToRun(slotId: string, egress: SlotEgress | undefined): Promise<void> {
    await this.#drained(slotId, "network", (signal) =>
      this.#driver.prepareSlot(slotId, egress, signal),
    );
    await this.#reviveProxy(slotId, egress);
  }

  async #drained<T>(
    slotId: string,
    name: keyof PoolAgentDeadlines,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#step(name, work);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        this.#log({ event: "step.draining", slotId, step: name });
        await error.settled;
      }
      throw error;
    }
  }

  async #reviveProxy(slotId: string, egress: SlotEgress | undefined): Promise<void> {
    if (
      await this.#drained(slotId, "network", (signal) =>
        this.#driver.reviveProxy(slotId, egress, signal),
      )
    ) {
      this.#proxiesDown.delete(slotId);
      this.#log({ event: "proxy.revived", slotId });
    }
  }

  async #ensureHost(): Promise<void> {
    if (await this.#step("network", () => this.#driver.ensureHost()))
      this.#log({ event: "host-table.repaired" });
  }

  #live(): Slot[] {
    return [...this.#slots.values()].filter((slot) => !slot.deleted);
  }

  /** Stops timers. The guests keep running: an agent restart is not a guest restart. */
  close(): void {
    this.#closed = true;
    if (this.#hostCheck) clearInterval(this.#hostCheck);
    for (const slot of this.#slots.values()) this.#unschedule(slot);
  }

  slotIds(): readonly string[] {
    return this.#live().map((slot) => slot.record.slotId);
  }

  /**
   * The Home key, its term and its generation, read together: the server authenticates with
   * them, and the call is served only if the slot still has that generation when it acts.
   */
  authority(slotId: string): SlotAuthority | undefined {
    const slot = this.#slots.get(slotId);
    if (slot)
      return {
        key: slot.homeKey,
        term: slot.record.term,
        generation: slot.keyGeneration,
        deleted: slot.deleted,
      };
    const tombstone = this.#tombstones.get(slotId);
    return tombstone
      ? { key: tombstone.homeKey, term: tombstone.record.term, generation: 0, deleted: true }
      : undefined;
  }

  /**
   * The relay's question (pool-runtime-in-guest.md, decision 4): may this client key reach this
   * slot's bridge now? Only the slot's own relay key, at the slot's term, while its guest runs
   * with no step open. An unknown slot, another key and another term all get one answer; only
   * the slot's own key learns that it is parked. The grant is signed by the slot's control key.
   */
  authorizeRelay(hello: PoolRelayHello, clientKey: string): RelayDecision {
    const slot = this.#slots.get(hello.slot);
    const record = slot?.record;
    if (
      !slot ||
      !record ||
      slot.deleted ||
      this.#dead ||
      !record.relayKey ||
      record.relayKey !== clientKey ||
      record.term !== hello.term
    )
      return { ok: false, code: "refused" };
    if (
      record.phase !== "running" ||
      record.pending ||
      !record.jailId ||
      !record.instance ||
      record.epoch === null ||
      !record.bridgeToken
    )
      return { ok: false, code: "parked" };
    const grant: PoolRelayGrant = {
      slot: record.slotId,
      term: record.term,
      instance: record.instance,
      epoch: record.epoch,
      token: record.bridgeToken,
    };
    return {
      ok: true,
      target: this.#driver.bridgeTarget(record.slotId),
      grant,
      signature: signBrowserPoolAgentBytes(
        poolRelayGrantBytes(hello.nonce, grant),
        slot.controlKey,
      ),
    };
  }

  /** Only a live slot has one; a deleted slot's key was destroyed with it. */
  controlKey(slotId: string): KeyObject | undefined {
    const slot = this.#slots.get(slotId);
    return slot && !slot.deleted ? slot.controlKey : undefined;
  }

  /** Applied effects in order, for diagnostics and tests. */
  effects(slotId: string): readonly string[] {
    return this.#slots.get(slotId)?.record.effects ?? [];
  }

  // ---- The controller interface ------------------------------------------------------------

  async status(slotId: string, term: number, generation?: number): Promise<BrowserPoolAgentStatus> {
    const slot = this.#require(slotId);
    if (term !== slot.record.term)
      throw new SlotNotFound("The pool agent does not know this slot and term.");
    this.#admit(slot, generation);
    const withProxy = (status: BrowserPoolAgentStatus): BrowserPoolAgentStatus =>
      this.#proxiesDown.has(slotId) && status.phase !== "stopped"
        ? { ...status, proxy: "down" }
        : status;
    // A read never waits behind a long step: it reports what the journal holds now.
    if (slot.lane.busy) return withProxy(statusOf(slot.record));
    return this.#run(slot, async () => {
      this.#admit(slot, generation);
      await this.#settle(slot);
      return withProxy(statusOf(slot.record));
    });
  }

  async result(
    slotId: string,
    term: number,
    id: string,
    generation?: number,
  ): Promise<BrowserPoolAgentResult | null> {
    const slot = this.#slots.get(slotId);
    if (!slot || term !== slot.record.term) return null;
    this.#admit(slot, generation);
    return structuredClone(stored(slot.record, id) ?? null);
  }

  async apply(call: BrowserPoolAgentCall, generation?: number): Promise<BrowserPoolAgentResult> {
    const slot = this.#require(call.slotId);
    this.#admit(slot, generation);
    if (call.kind === "resume") slot.demand += 1;
    const arrived = performance.now();
    let started = arrived;
    try {
      return structuredClone(
        await this.#run(slot, () => {
          started = performance.now();
          // Checked again at the front of the lane: a key replaced or a slot deleted while
          // this call waited means it is not served, and it writes nothing.
          this.#admit(slot, generation);
          return this.#apply(slot, call);
        }),
      );
    } finally {
      if (call.kind === "resume") {
        slot.demand -= 1;
        // Where a wake's time went, outside its steps: waiting for the slot's lane, and all of it.
        this.#log({
          event: "resume.call",
          slotId: slot.record.slotId,
          lane_ms: round(started - arrived),
          total_ms: round(performance.now() - arrived),
        });
      }
    }
  }

  /** A deleted slot, or a request authenticated by a replaced Home key, is not served. */
  #admit(slot: Slot, generation: number | undefined): void {
    if (slot.deleted || this.#slots.get(slot.record.slotId) !== slot)
      throw new SlotNotFound("The pool agent does not know this slot.");
    if (generation !== undefined && generation !== slot.keyGeneration)
      throw new SlotFenced("The request was signed by a Home key this slot no longer has.");
  }

  /** One job on the slot's lane; whatever its outcome, the slot's timers are armed again. */
  #run<T>(slot: Slot, job: () => Promise<T>): Promise<T> {
    return slot.lane.run(job).then(
      (value) => {
        slot.failedAt = undefined;
        if (!this.#dead && !slot.deleted) this.#schedule(slot);
        return value;
      },
      (error: unknown) => {
        // Re-check finding 5: the driver's own durable state follows rule S2 as the journal.
        if (error instanceof DriverStateUncertain && !this.#dead) this.#die(error);
        slot.failedAt = performance.now();
        if (!this.#dead && !slot.deleted) this.#schedule(slot);
        throw error;
      },
    );
  }

  // ---- Slot administration (the provisioner's interface) -----------------------------------

  async createSlot(input: {
    readonly slotId: string;
    readonly term: number;
    readonly homeKey: string;
    readonly guest: BrowserPoolAgentGuestRequest;
    readonly relayKey?: string;
    readonly ticketKey?: { readonly keyId: string; readonly spki: string };
  }): Promise<BrowserPoolAgentSlotSummary> {
    return this.#admin.run(() => this.#create(input));
  }

  async #create(input: {
    readonly slotId: string;
    readonly term: number;
    readonly homeKey: string;
    readonly guest: BrowserPoolAgentGuestRequest;
    readonly relayKey?: string;
    readonly ticketKey?: { readonly keyId: string; readonly spki: string };
  }): Promise<BrowserPoolAgentSlotSummary> {
    const found = this.#slots.get(input.slotId);
    const existing = found && !found.deleted ? found : undefined;
    // Review G2: a deleted slot's tombstone keeps its last term. A create at or below it is a
    // replay of an earlier create, and changes nothing.
    const tombstone = this.#tombstones.get(input.slotId);
    if (tombstone && input.term <= tombstone.record.term)
      throw new SlotConflict("This slot was deleted at a later term than this create names.");
    if (existing) {
      // A repeated create with the same facts is the same create.
      if (existing.record.homeKey === input.homeKey && existing.record.term === input.term)
        return this.#summary(existing);
      throw new SlotConflict("The slot exists with another key or term.");
    }
    parsePublicKey(input.homeKey);
    if (input.relayKey) parsePublicKey(input.relayKey);
    if (input.ticketKey) parsePublicKey(input.ticketKey.spki);
    if (!Number.isSafeInteger(input.term) || input.term < 1)
      throw new SlotConflict("The term must be a positive integer.");
    // Round G: the slot's profile is its own. The agent derives its path from the slot id, makes
    // it when none is there and keeps one that is exactly as it is; a path the provisioner
    // names must be that same path. A make that failed leaves no slot and no file.
    const { profileMib, profilePath: named, ...spec } = input.guest;
    // Round H: a host that pulls its slots' credentials takes none from a create.
    if (this.#driver.pullsEgress && spec.egress !== undefined)
      throw new SlotConflict("This host pulls each slot's egress; a create names none.");
    const profilePath = this.#driver.profilePath(input.slotId);
    if (named !== undefined && named !== profilePath)
      throw new SlotConflict("A slot's profile is its own: its path is derived from the slot id.");
    if (named === undefined && profileMib === undefined)
      throw new SlotConflict("A create names the size of the slot's profile (profileMib).");
    if (profileMib !== undefined) {
      const profile = await this.#driver
        .ensureProfile(input.slotId, profileMib)
        .catch((error: unknown) => {
          // Round H: no room for it is a definite refusal; nothing was made.
          if (error instanceof ProfilesFull) throw new SlotConflict(error.message);
          throw error;
        });
      this.#log({ event: "profile.ready", slotId: input.slotId, made: profile.made });
    }
    const guest: BrowserPoolAgentGuestSpec = { ...spec, profilePath };
    const { privateKey } = generateKeyPairSync("ed25519");
    const record: SlotRecord = {
      v: 1,
      slotId: input.slotId,
      term: input.term,
      homeKey: input.homeKey,
      controlKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      relayKey: input.relayKey ?? null,
      ticketKey: input.ticketKey ? `${input.ticketKey.keyId}:${input.ticketKey.spki}` : null,
      bridgeToken: null,
      guest,
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
    // Review G9: the host paths a provisioner names stay under their configured roots.
    await this.#step("verify", () => this.#driver.confineGuest(guest)).catch((error: unknown) => {
      throw new SlotConflict(messageOf(error));
    });
    await this.#prepareCreated(input.slotId, guest);
    this.#checkpoint("create:prepared");
    await this.#write(record);
    const slot = this.#load(record);
    this.#tombstones.delete(input.slotId);
    this.#slots.set(input.slotId, slot);
    this.#log({ event: "slot.created", slotId: input.slotId, term: input.term });
    return this.#summary(slot);
  }

  /**
   * Re-check finding 5: a create whose network failed or ran out of time leaves no number. A
   * prepare that is still running is waited for (it does not stop at its deadline), then
   * everything it made is removed, before the next administration call runs.
   */
  async #prepareCreated(slotId: string, guest: BrowserPoolAgentGuestSpec): Promise<void> {
    try {
      // Round E, E2: its host tools take the step's signal, and the number stays held until
      // the prepare ended, so the removal below waits for it.
      await this.#step("network", (signal) =>
        this.#driver.prepareSlot(slotId, guest.egress, signal),
      );
    } catch (error) {
      if (error instanceof DriverStateUncertain) this.#die(error);
      if (error instanceof DeadlineExceeded) {
        this.#log({ event: "slot.create-draining", slotId });
        await finishedWithin(error.settled, this.#deadlines.sweep);
      }
      await this.#step("network", () => this.#driver.removeSlot(slotId)).catch(
        (cleanup: unknown) => {
          if (cleanup instanceof DriverStateUncertain) this.#die(cleanup);
          this.#log({ event: "slot.create-cleanup-failed", slotId, message: messageOf(cleanup) });
        },
      );
      throw error;
    }
  }

  /**
   * Round D, D2: a new Home for the slot, at a higher term. Its three public keys (slot key,
   * relay key, ticket key) replace the old set together, in one journal write, and the old set
   * is refused from that write on: knowing the next term is never enough. The guest does not
   * survive it (its ticket key is fixed at boot): it is ended and its saved state discarded, in
   * that same write, and the next start is cold.
   */
  async replaceKey(input: {
    readonly slotId: string;
    readonly term: number;
    readonly homeKey: string;
    readonly relayKey?: string;
    readonly ticketKey?: { readonly keyId: string; readonly spki: string };
  }): Promise<BrowserPoolAgentSlotSummary> {
    const slot = this.#require(input.slotId);
    const relayKey = input.relayKey ?? null;
    const ticketKey = input.ticketKey ? `${input.ticketKey.keyId}:${input.ticketKey.spki}` : null;
    return this.#run(slot, async () => {
      this.#admit(slot, undefined);
      const record = slot.record;
      if (
        input.term === record.term &&
        input.homeKey === record.homeKey &&
        relayKey === (record.relayKey ?? null) &&
        ticketKey === (record.ticketKey ?? null)
      )
        return this.#summary(slot);
      if (!Number.isSafeInteger(input.term) || input.term <= record.term)
        throw new SlotConflict("A replaced key needs a higher term.");
      const homeKey = parsePublicKey(input.homeKey);
      if (input.relayKey) parsePublicKey(input.relayKey);
      if (input.ticketKey) parsePublicKey(input.ticketKey.spki);
      // The old Home's queued calls are fenced before anything is ended. Round E, E1: and
      // again once the new keys are in place, because a call authenticated under the old key
      // while the guest was being stopped carries the generation of that window. Nothing
      // admitted under the old key acts after the replacement, whether or not it finished.
      slot.keyGeneration += 1;
      try {
        await this.#settle(slot);
        await this.#lose(slot, {
          extra: {
            term: input.term,
            homeKey: input.homeKey,
            relayKey,
            ticketKey,
            bridgeToken: null,
            results: [],
          },
        });
      } finally {
        if (slot.record.homeKey === input.homeKey) slot.homeKey = homeKey;
        slot.keyGeneration += 1;
      }
      this.#log({ event: "slot.key-replaced", slotId: input.slotId, term: input.term });
      return this.#summary(slot);
    });
  }

  /**
   * Ends the guest, erases its saved state and its network, and forgets the slot. The answer
   * is given only after the VMM's exit was observed and the files are gone. The profile disk
   * is left where it is, unless `eraseProfile` (round G): then it is removed last, and the
   * answer is given only once it is seen gone (or the delete fails). For a slot this agent does
   * not know (deleted, or never known here) a leftover profile at its path is removed the same
   * way. Nothing else ever removes a profile.
   */
  async deleteSlot(
    slotId: string,
    term?: number,
    options: { readonly eraseProfile?: boolean } = {},
  ): Promise<boolean> {
    return (await this.deleteSlotWithEvidence(slotId, term, options)).erased;
  }

  /**
   * `deleteSlot`, with what was seen gone. Round G, B: a slot's upstream credential files are
   * removed with it, before its record becomes a tombstone (so a failed removal leaves a slot
   * that a repeated delete finishes), except a file another live slot also names.
   * `credentialsErased` is present whenever every credential file the slot has is seen gone (none
   * counts), and on a pulling host for a slot it no longer knows; a file that cannot be removed
   * makes the delete fail, to be sent again.
   */
  async deleteSlotWithEvidence(
    slotId: string,
    term?: number,
    options: { readonly eraseProfile?: boolean } = {},
  ): Promise<{
    readonly erased: boolean;
    readonly profileErased?: true;
    readonly credentialsErased?: true;
  }> {
    let credentialsErased = false;
    const erase = async (path: string) => {
      if (!options.eraseProfile) return;
      await this.#driver.eraseProfile(path);
      this.#log({ event: "profile.erased", slotId });
    };
    const evidence = () => ({
      erased: true,
      ...(options.eraseProfile ? { profileErased: true as const } : {}),
      ...(credentialsErased ? { credentialsErased: true as const } : {}),
    });
    // Re-check finding 5: the administration lane, then the slot's own run wrapper. A create
    // waits for a delete in progress, and a delete that fails leaves the slot with its timers.
    return this.#admin.run(async () => {
      const slot = this.#slots.get(slotId);
      if (!slot || slot.deleted) {
        // Round I, U8: a delete naming a tombstoned slot carries a term not lower than its
        // tombstone's, so an old delete replayed never erases what a later slot kept.
        const tombstone = this.#tombstones.get(slotId);
        if (term !== undefined && tombstone && term < tombstone.record.term)
          throw new SlotConflict("This slot was deleted at a later term than this delete names.");
        // Round H: a slot it does not know: leftover pulled credentials at its derived paths.
        if (this.#driver.pullsEgress) {
          await this.#driver.eraseCredentials(this.#driver.pulledEgressFiles(slotId));
          credentialsErased = true;
        }
        await erase(this.#driver.profilePath(slotId));
        return evidence();
      }
      const profilePath = slot.record.guest.profilePath;
      return this.#run(slot, async () => {
        if (slot.deleted) {
          if (this.#driver.pullsEgress) {
            await this.#driver.eraseCredentials(this.#driver.pulledEgressFiles(slotId));
            credentialsErased = true;
          }
          await erase(profilePath);
          return evidence();
        }
        // Review G2: a delete names the term it deletes; a replay after the slot was recreated
        // at a higher term is refused.
        if (term !== undefined && term !== slot.record.term)
          throw new SlotConflict("The slot is at another term than this delete names.");
        this.#unschedule(slot);
        await this.#kill(slot);
        if (slot.record.saved)
          await this.#step("discard", () => this.#driver.discard(slotId, slot.record.saved!.id));
        await this.#step("network", () => this.#driver.removeSlot(slotId));
        // Round G, B: its proxy is gone; its credential files go before its record does.
        const egress = slot.record.guest.egress;
        // Round H: a pulling host's slot has its credentials at paths derived from its id.
        const files = this.#driver.pullsEgress
          ? [...this.#driver.pulledEgressFiles(slotId)]
          : egress
            ? [egress.usernameFile, egress.passwordFile, ...(egress.caFile ? [egress.caFile] : [])]
            : [];
        const named = new Set(
          this.#live()
            .filter((other) => other !== slot)
            .flatMap((other) => {
              const theirs = other.record.guest.egress;
              return theirs ? [theirs.usernameFile, theirs.passwordFile, theirs.caFile ?? ""] : [];
            }),
        );
        const own = files.filter((file) => !named.has(file));
        if (own.length < files.length) this.#log({ event: "credentials.shared", slotId });
        await this.#driver.eraseCredentials(own);
        // W10: proven gone whenever every file the slot has is gone, including when it has none.
        credentialsErased = own.length === files.length;
        // One write: the live record becomes a tombstone that holds nothing secret. From here
        // nothing queued may act, and the slot's control key is gone.
        const tombstone = tombstoneOf(slot.record, this.#iso());
        await this.#write(tombstone);
        slot.deleted = true;
        this.#slots.delete(slotId);
        this.#keepTombstone(tombstone);
        this.#log({ event: "slot.deleted", slotId });
        await erase(profilePath);
        return evidence();
      });
    });
  }

  summaries(): readonly BrowserPoolAgentSlotSummary[] {
    return this.#live().map((slot) => this.#summary(slot));
  }

  // ---- Calls --------------------------------------------------------------------------------

  async #apply(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = stored(slot.record, call.id);
    if (before) return before;
    // One recovery live and at start: an open step is settled before anything new runs.
    await this.#settle(slot);
    const settled = stored(slot.record, call.id);
    if (settled) return settled;
    // Finding 6: an answer the Home may still repeat is never evicted to make room; a new call
    // that would need its place is refused before it acts.
    if (!this.#hasRoom(slot.record))
      throw new AgentUnavailable("The slot answered too many calls recently; try again later.");
    const record = slot.record;
    const refusal = refusalOf(record, call);
    if (refusal) return this.#store(slot, record, refused(call.id, refusal, record));
    switch (call.kind) {
      case "start":
        return this.#withEgress(slot, call, () =>
          this.#admitted(slot, () => this.#start(slot, call)),
        );
      case "pause":
        return this.#pause(slot, call);
      case "resume":
        // A wake from memory keeps the memory it holds; a wake from disk needs room.
        return slot.record.saved?.tier === "disk"
          ? this.#withEgress(slot, call, () => this.#admitted(slot, () => this.#resume(slot, call)))
          : this.#resume(slot, call);
      case "stop":
        return this.#stop(slot, call);
      case "sign":
        return this.#sign(slot, call);
    }
  }

  /**
   * Round E, E4: a start or a wake from disk is let in only if its guest fits in the host's
   * memory beside the guests already there (running, paused in memory, or being let in). If it
   * does not, guests paused in memory are saved to disk first, oldest park first; if that is
   * not enough it is refused before anything is written, as "not now" (`unavailable`), which a
   * Home's journal already sends again later.
   */
  async #admitted<T>(slot: Slot, work: () => Promise<T>): Promise<T> {
    const capacity = this.#driver.memoryCapacity();
    if (!capacity) return work();
    const slotId = slot.record.slotId;
    const charge = guestCharge(slot.record.guest.memoryMib);
    const tried = new Set<string>();
    // Checked and reserved in one synchronous step: two starts never take the same room.
    while (!fits(capacity, this.#inMemory(slot), charge)) {
      const victim = [...this.#slots.values()]
        .filter(
          (other) =>
            other !== slot &&
            !other.deleted &&
            !tried.has(other.record.slotId) &&
            !this.#admitting.has(other.record.slotId) &&
            other.record.phase === "paused" &&
            other.record.saved?.tier === "memory" &&
            other.demand === 0 &&
            !other.lane.busy,
        )
        .sort((a, b) => Date.parse(a.record.saved!.parkedAt) - Date.parse(b.record.saved!.parkedAt))
        .at(0);
      if (!victim) {
        this.#log({ event: "capacity.refused", slotId });
        throw new AgentUnavailable(
          "This host has no memory for another guest now; try again later.",
        );
      }
      tried.add(victim.record.slotId);
      this.#log({ event: "capacity.save", slotId, saving: victim.record.slotId });
      await this.saveToDisk(victim.record.slotId, victim.record.saved!.id).catch((error: unknown) =>
        this.#background(victim, error),
      );
    }
    this.#admitting.add(slotId);
    try {
      return await work();
    } finally {
      this.#admitting.delete(slotId);
    }
  }

  /**
   * Round H, and round I (U1): no upstream, no start, and the host's credentials are a copy.
   * On a host that pulls its slots' credentials, every start and every wake from disk asks the
   * account service first, whether or not credentials are there, before anything is written or
   * booted (no guest of the slot runs, so its proxy's service is not running either).
   * - Given: checked as the proxy checks them (U2), written if they differ from what is there,
   *   and the start goes on (its proxy is defined again if the upstream differs).
   * - None assigned: what is there is removed, and a stored, signed `applied: false` with
   *   reason `egress-required` answers; nothing booted.
   * - Not completed (no answer, a refusal, a malformed answer, its deadline): what is there is
   *   used, if anything is; otherwise "try again" (`unavailable`), with nothing written.
   * A wake from memory asks nothing.
   */
  async #withEgress(
    slot: Slot,
    call: BrowserPoolAgentCall,
    work: () => Promise<BrowserPoolAgentResult>,
  ): Promise<BrowserPoolAgentResult> {
    const fetch = this.#options.egressFetch;
    const slotId = slot.record.slotId;
    if (!fetch) return work();
    let answer: SlotEgressAnswer | null;
    try {
      const fetched = await within(this.#deadlines.egress, "The slot's egress fetch", (signal) =>
        fetch(slotId, signal),
      );
      answer = fetched === null ? null : acceptSlotEgress(fetched);
    } catch (error) {
      // Never the error's text: it is the fetch's, and says nothing secret, but stays out anyway.
      this.#log({ event: "egress.fetch-failed", slotId, error: (error as Error)?.name ?? "error" });
      if (await this.#driver.hasPulledEgress(slotId)) {
        this.#log({ event: "egress.kept", slotId });
        return work();
      }
      throw new AgentUnavailable("The slot's egress could not be fetched; try again later.");
    }
    if (answer === null) {
      // The files, then the slot's proxy service: nothing keeps revoked credentials.
      await this.#driver.removePulledEgress(slotId);
      this.#log({ event: "egress.none", slotId });
      return this.#store(slot, slot.record, refused(call.id, "egress-required", slot.record));
    }
    const written = await this.#driver.writePulledEgress(slotId, answer);
    this.#log({ event: "egress.fetched", slotId, changed: written });
    return work();
  }

  /** The charges of every other guest in memory: running, paused there, or being let in. */
  #inMemory(except: Slot): number[] {
    const charges: number[] = [];
    for (const other of this.#slots.values()) {
      if (other === except || other.deleted) continue;
      const record = other.record;
      if (
        this.#admitting.has(record.slotId) ||
        record.phase === "running" ||
        (record.phase === "paused" && record.saved?.tier === "memory")
      )
        charges.push(guestCharge(record.guest.memoryMib));
    }
    return charges;
  }

  async #start(slot: Slot, call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const before = slot.record;
    const jailGeneration = before.jailGeneration + 1;
    const jailId = jailName(before.slotId, jailGeneration);
    const instance = randomUUID();
    const sequence = before.sequence + 1;
    // A new instance has a new bridge token (pool-runtime-in-guest.md, decision 3).
    const bridgeToken = randomBytes(32).toString("hex");
    await this.#commit(slot, {
      ...before,
      jailGeneration,
      bridgeToken,
      pending: { kind: "call", call, step: "booting", at: this.#iso(), jailId },
    });
    this.#checkpoint("start:journaled");
    try {
      await this.#ensureHost();
      // Re-check finding 3: a slot's namespace and proxy socket are made when it next runs.
      await this.#prepareToRun(before.slotId, before.guest.egress);
      // Nobody else may write the profile: every earlier process of the slot is gone first.
      await this.#kill(slot);
      await within(this.#deadlines.network, "Closing the guest network", () =>
        this.#driver.closeNetwork(before.slotId),
      );
      await within(this.#deadlines.boot, "The guest boot", (signal) =>
        this.#driver.boot(this.#boot(slot, jailId, sequence), signal),
      );
      await within(this.#deadlines.clock, "The bridge token", (signal) =>
        this.#driver.deliverToken(before.slotId, jailId, bridgeToken, signal),
      );
      this.#checkpoint("start:booted");
      await within(this.#deadlines.network, "Opening the guest network", () =>
        this.#driver.openNetwork(before.slotId),
      );
    } catch (error) {
      if (error instanceof AgentCrashed) throw error;
      if (error instanceof DriverStateUncertain) this.#die(error);
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
        if (error instanceof DriverStateUncertain) this.#die(error);
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
      if (error instanceof DriverStateUncertain) this.#die(error);
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
    const consumedAt = performance.now();
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
    const steps: Record<string, number> = { journal: round(performance.now() - consumedAt) };
    let mark = performance.now();
    const step = (name: string) => {
      const at = performance.now();
      steps[name] = Math.round((at - mark) * 10) / 10;
      mark = at;
    };
    try {
      await this.#ensureHost();
      step("host");
      await this.#prepareToRun(before.slotId, before.guest.egress);
      step("prepare");
      await within(this.#deadlines.network, "Closing the guest network", () =>
        this.#driver.closeNetwork(before.slotId),
      );
      step("close");
      if (saved.tier === "disk") {
        if (!saved.image || saved.diskGeneration !== before.diskGeneration)
          throw new Error("The saved state does not match the profile disk.");
        await this.#kill(slot);
        step("kill");
        await within(this.#deadlines.restore, "The guest restore", (signal) =>
          this.#driver.restore(
            this.#boot(slot, jailId!, before.sequence + 1),
            saved.image!,
            signal,
          ),
        );
        step("restore");
        this.#checkpoint("resume:restored");
      }
      await within(this.#deadlines.resume, "The guest resume", (signal) =>
        this.#driver.resume(before.slotId, jailId!, signal),
      );
      step("vcpus");
      this.#checkpoint("resume:resumed");
      // The guest's wall clock is stepped before any traffic can reach it.
      await within(this.#deadlines.clock, "The guest clock step", (signal) =>
        this.#driver.stepClock(before.slotId, jailId!, signal),
      );
      step("clock");
      // The same instance keeps its token; it is given again after every resume, so a guest
      // restored from disk has it from outside, as a freshly booted one does.
      if (before.bridgeToken)
        await within(this.#deadlines.clock, "The bridge token", (signal) =>
          this.#driver.deliverToken(before.slotId, jailId!, before.bridgeToken!, signal),
        );
      step("token");
      await within(this.#deadlines.network, "Opening the guest network", () =>
        this.#driver.openNetwork(before.slotId),
      );
      step("network");
      this.#log({ event: "resumed", slotId: before.slotId, tier: saved.tier, steps });
    } catch (error) {
      if (error instanceof AgentCrashed) throw error;
      if (error instanceof DriverStateUncertain) this.#die(error);
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
    if (slot.record.saved)
      await this.#step("discard", () =>
        this.#driver.discard(slot.record.slotId, slot.record.saved!.id),
      );
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
    return (await this.#lose(slot, { answer: { id: call.id, reason } }))!;
  }

  // ---- Parked guests: the idle save and the discard ----------------------------------------

  /**
   * Arms the slot's timers from its record. Called after every job on its lane, whatever the
   * outcome (finding 10): an expiry that fired early because the clock moved, or whose clean-up
   * failed, is armed again; an unfinished step is retried without waiting for a call.
   */
  #schedule(slot: Slot): void {
    this.#unschedule(slot);
    if (this.#closed || this.#dead || slot.deleted) return;
    const retry = this.#options.retryMs ?? 5_000;
    const floor =
      slot.failedAt === undefined ? 0 : Math.max(0, slot.failedAt + retry - performance.now());
    if (slot.record.pending) {
      slot.retryTimer = setTimeout(
        () => {
          void this.#run(slot, () => this.#settle(slot)).catch((error: unknown) =>
            this.#background(slot, error),
          );
        },
        Math.max(floor, retry),
      );
      slot.retryTimer.unref?.();
      return;
    }
    const saved = slot.record.saved;
    if (slot.record.phase !== "paused" || !saved) return;
    const discardIn = Date.parse(saved.discardAt) - this.#now();
    slot.expiryTimer = setTimeout(
      () => {
        void this.#run(slot, () => this.#settle(slot)).catch((error: unknown) =>
          this.#background(slot, error),
        );
      },
      Math.max(floor, Math.min(Math.max(0, discardIn), 2 ** 31 - 1)),
    );
    slot.expiryTimer.unref?.();
    const saveAfter = this.#options.saveAfterMs;
    if (saved.tier === "memory" && saveAfter !== null && saveAfter !== undefined) {
      const saveIn = Math.max(
        Date.parse(saved.parkedAt) + saveAfter - this.#now(),
        this.#saveBackoff(slot, saved.id),
      );
      slot.saveTimer = setTimeout(
        () => {
          void this.saveToDisk(slot.record.slotId, saved.id).catch((error: unknown) =>
            this.#background(slot, error),
          );
        },
        Math.max(floor, saveIn),
      );
      slot.saveTimer.unref?.();
    }
  }

  /**
   * Re-check finding 1: how long a failed save of this park waits before it is tried again. A
   * failure doubles the wait from 30 s up to 30 minutes; a save the array had no room for is
   * tried again once space changed (an image was deleted) or after 30 minutes.
   */
  #saveBackoff(slot: Slot, savedStateId: string): number {
    const failure = slot.saveFailure;
    if (!failure || failure.savedStateId !== savedStateId) return 0;
    const maximum = 30 * 60_000;
    const wait =
      failure.room === undefined
        ? Math.min(maximum, (this.#options.saveRetryMs ?? 30_000) * 2 ** (failure.count - 1))
        : failure.room === this.#spaceChanges
          ? (this.#options.saveRoomRetryMs ?? maximum)
          : 0;
    return Math.max(0, failure.at + wait - performance.now());
  }

  #saveFailed(slot: Slot, savedStateId: string, room: boolean): void {
    const previous = slot.saveFailure;
    slot.saveFailure = {
      savedStateId,
      count: previous?.savedStateId === savedStateId ? previous.count + 1 : 1,
      at: performance.now(),
      room: room ? this.#spaceChanges : undefined,
    };
  }

  /** An image was deleted: saves waiting for room are tried again. */
  #spaceFreed(): void {
    this.#spaceChanges += 1;
    for (const other of this.#slots.values())
      if (other.saveFailure?.room !== undefined && !other.lane.busy) this.#schedule(other);
  }

  #unschedule(slot: Slot): void {
    if (slot.saveTimer) clearTimeout(slot.saveTimer);
    if (slot.expiryTimer) clearTimeout(slot.expiryTimer);
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    slot.saveTimer = undefined;
    slot.expiryTimer = undefined;
    slot.retryTimer = undefined;
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
      return await this.#run(slot, async () => {
        this.#admit(slot, undefined);
        await this.#settle(slot);
        if (!eligible()) return "skipped";
        const before = slot.record;
        // Re-check finding 1: a save the array has no room for is not journaled or tried.
        if (!(await this.#step("inspect", () => this.#driver.saveRoom(slotId, before.jailId!)))) {
          const waiting = slot.saveFailure;
          if (waiting?.savedStateId !== savedStateId || waiting.room !== this.#spaceChanges)
            this.#log({ event: "save.no-room", slotId });
          this.#saveFailed(slot, savedStateId, true);
          return "skipped";
        }
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
          if (error instanceof DriverStateUncertain) this.#die(error);
          this.#log({ event: "save.failed", slotId, message: messageOf(error) });
          this.#saveFailed(slot, savedStateId, error instanceof NoSaveRoom);
          // Finding 3: a snapshot that ran out of time may still be writing. Its writer is
          // waited for, and ended with its VMM if it does not finish, before the image is
          // deleted and the slot released, so no image can appear afterwards.
          if (error instanceof DeadlineExceeded) {
            if (!(await finishedWithin(error.settled, this.#deadlines.snapshotDrain))) {
              await this.#lose(slot);
              // Re-check finding 9: the lane stays held until the writer has ended, however
              // long that takes (its own API call has a bound), so nothing runs beside it.
              if (!(await finishedWithin(error.settled, this.#deadlines.kill))) {
                this.#log({ event: "save.writer-late", slotId });
                await error.settled.catch(() => undefined);
              }
              await this.#step("discard", () => this.#driver.discard(slotId, savedStateId));
              return "skipped";
            }
          }
          await this.#step("discard", () => this.#driver.discard(slotId, savedStateId));
          await this.#commit(slot, { ...before, pending: null });
          return "skipped";
        }
        this.#checkpoint("save:written");
        if (slot.demand > 0) {
          // A wake is waiting: resume from memory and never load this image.
          await this.#step("discard", () => this.#driver.discard(slotId, savedStateId));
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
        slot.saveFailure = undefined;
        return "saved";
      });
    } finally {
      release();
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
      await this.#lose(slot, {
        extra: { incarnation: null },
        ...(record.pending?.kind === "call"
          ? { answer: { id: record.pending.call.id, reason: "host-restarted" } }
          : {}),
      });
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
      // A start, pause or resume that may have done part of its work: the guest is ended, and
      // its answer is stored in that same write.
      await this.#lose(slot, { answer: { id: pending.call.id, reason: "interrupted" } });
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
      (await this.#step("verify", () => this.#driver.verify(slot.record.slotId, saved.image!)))
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
    await this.#step("discard", () =>
      this.#driver.discard(slot.record.slotId, pending.savedStateId),
    );
    const alive = jailId ? await this.#confirm(slot.record.slotId, jailId) : "absent";
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
      // Finding 4: an unknown is asked again over a bounded wait, and never accepted.
      const state = record.jailId ? await this.#confirm(record.slotId, record.jailId) : "absent";
      if (state === want) return;
      this.#log({ event: "guest.lost", slotId: record.slotId, expected: want, found: state });
      await this.#lose(slot);
      return;
    }
    if (record.phase === "paused" && saved?.tier === "disk") {
      if (
        saved.image &&
        (await this.#step("verify", () => this.#driver.verify(record.slotId, saved.image!)))
      )
        return;
      this.#log({ event: "saved.lost", slotId: record.slotId, savedStateId: saved.id });
      await this.#lose(slot);
    }
  }

  /**
   * Live state is gone or cannot be trusted: end every process, delete the saved state, and
   * leave the slot stopped. The instance is kept, so the next start is visibly a new one.
   */
  async #lose(
    slot: Slot,
    options: {
      readonly extra?: Partial<SlotRecord>;
      /** Rule S1: the call this recovery answers, stored in the same write as the stop. */
      readonly answer?: { readonly id: string; readonly reason: string };
    } = {},
  ): Promise<BrowserPoolAgentResult | undefined> {
    this.#unschedule(slot);
    await within(this.#deadlines.network, "Closing the guest network", () =>
      this.#driver.closeNetwork(slot.record.slotId),
    ).catch((error: unknown) => {
      if (error instanceof AgentCrashed) throw error;
      if (error instanceof DriverStateUncertain) this.#die(error);
      this.#log({
        event: "network.close-failed",
        slotId: slot.record.slotId,
        message: messageOf(error),
      });
    });
    await this.#kill(slot);
    const saved = slot.record.saved;
    if (saved)
      await this.#step("discard", () => this.#driver.discard(slot.record.slotId, saved.id));
    const lost = slot.record.phase !== "stopped" || saved !== null;
    const stopped: SlotRecord = {
      ...slot.record,
      phase: "stopped",
      epoch: lost ? null : slot.record.epoch,
      saved: null,
      jailId: null,
      pending: null,
      ...options.extra,
      effects: lost ? bounded([...slot.record.effects, "lost"]) : slot.record.effects,
    };
    if (!options.answer) {
      await this.#commit(slot, stopped);
      return undefined;
    }
    const result = refused(options.answer.id, options.answer.reason, stopped);
    await this.#commit(slot, this.#withResult(stopped, result));
    return result;
  }

  async #kill(slot: Slot): Promise<void> {
    await within(this.#deadlines.kill, "Ending the guest's processes", (signal) =>
      this.#driver.kill(slot.record.slotId, signal),
    );
  }

  /**
   * The VMM's state, asked again while it answers "unknown" for up to the inspect deadline. Still
   * unknown means it cannot be confirmed: the caller treats the guest as lost.
   */
  async #confirm(slotId: string, jailId: string): Promise<GuestProcessState> {
    // Re-check finding 9: one bound for the whole wait, however many reads it takes.
    const until = performance.now() + this.#deadlines.inspect;
    for (;;) {
      const left = Math.max(1, until - performance.now());
      const state = await within(left, "The inspect step", () =>
        this.#driver.inspect(slotId, jailId),
      ).catch((error: unknown): GuestProcessState => {
        if (error instanceof AgentCrashed) throw error;
        if (error instanceof DriverStateUncertain) this.#die(error);
        return "unknown";
      });
      const remaining = until - performance.now();
      if (state !== "unknown" || remaining <= 0) return state;
      await sleep(Math.min(100, remaining));
    }
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
      keyGeneration: 0,
      deleted: false,
      demand: 0,
      saveTimer: undefined,
      expiryTimer: undefined,
      retryTimer: undefined,
      failedAt: undefined,
      saveFailure: undefined,
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
        // The one ticket key the guest's runtime trusts: its Home's. Public.
        ...(record.ticketKey ? { "opensteer.pool.ticket": record.ticketKey } : {}),
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
    await this.#commit(slot, this.#withResult(next, result, effect));
    return result;
  }

  /**
   * The record with this answer stored and no step open. Answers older than the result retention
   * go; past the count limit only answers older than twice the request window go, since a Home may
   * still repeat a younger one. After retention an id is unknown: its expected predecessor is what
   * refuses a late repeat.
   */
  #withResult(next: SlotRecord, result: BrowserPoolAgentResult, effect?: string): SlotRecord {
    const now = this.#now();
    const results = [...this.#retained(next, now), { at: now, result }];
    while (results.length > this.#maxResults && now - results[0]!.at >= protectedAnswerMs)
      results.shift();
    return {
      ...next,
      pending: null,
      results,
      effects: effect ? bounded([...next.effects, effect]) : next.effects,
    };
  }

  #retained(record: SlotRecord, now: number) {
    const retention = this.#options.resultRetentionMs ?? 24 * 60 * 60_000;
    return record.results.filter((entry) => now - entry.at < retention);
  }

  #hasRoom(record: SlotRecord): boolean {
    const now = this.#now();
    const results = this.#retained(record, now);
    return results.length < this.#maxResults || now - results[0]!.at >= protectedAnswerMs;
  }

  get #maxResults(): number {
    return this.#options.maxResults ?? 512;
  }

  async #commit(slot: Slot, record: SlotRecord): Promise<void> {
    await this.#write(record);
    slot.record = record;
  }

  /**
   * Rule S2: a write that fails, before or after its rename, ends the agent. Nothing continues
   * on an in-memory record the disk may not hold; the next agent reads what is on disk.
   */
  async #write(record: JournalRecord): Promise<void> {
    this.#guardAlive();
    try {
      await this.#journal.write(record);
    } catch (error) {
      this.#die(error);
    }
  }

  async #removeRecord(slotId: string): Promise<void> {
    this.#guardAlive();
    try {
      await this.#journal.remove(slotId);
    } catch (error) {
      this.#die(error);
    }
  }

  #die(error: unknown): never {
    this.#dead = true;
    this.close();
    this.#log({ event: "agent.journal-failed", message: messageOf(error) });
    this.#options.fatal?.(error);
    throw new AgentCrashed("A journal write failed: the agent stops and recovery reads the disk.");
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
    if (!slot || slot.deleted) throw new SlotNotFound("The pool agent does not know this slot.");
    return slot;
  }

  #summary(slot: Slot): BrowserPoolAgentSlotSummary {
    return {
      slotId: slot.record.slotId,
      term: slot.record.term,
      controlKey: publicKeyOf(slot.controlKey),
      status: statusOf(slot.record),
      ...(slot.record.phase === "paused" && slot.record.saved
        ? {
            parked: {
              tier: slot.record.saved.tier,
              ...(slot.record.saved.image?.writeMs === undefined
                ? {}
                : { writeMs: slot.record.saved.image.writeMs }),
            },
          }
        : {}),
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

function tombstoneOf(record: SlotRecord, deletedAt: string): TombstoneRecord {
  return { v: 1, slotId: record.slotId, term: record.term, homeKey: record.homeKey, deletedAt };
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
