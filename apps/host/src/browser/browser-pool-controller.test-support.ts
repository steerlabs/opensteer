import { browserPoolControlBytes, type BrowserPoolControl } from "@opensteer/browser-runtime-core";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type {
  BrowserPoolControllerCall,
  BrowserPoolControllerResult,
  BrowserPoolPhysicalController,
  BrowserPoolPhysicalKind,
  BrowserPoolPhysicalStatus,
} from "./browser-pool-controller.js";

export type BrowserPoolFault = "request" | "reply" | "duplicate";

/**
 * Stands in for a pool agent: it alone holds the control key, issues instance and epoch, keeps
 * one stored result per call, and can lose a request, lose a reply or apply a call twice.
 */
export class FakeBrowserPoolController implements BrowserPoolPhysicalController {
  readonly publicKey: KeyObject;
  readonly #privateKey: KeyObject;
  readonly #results = new Map<string, BrowserPoolControllerResult>();
  readonly #faults: { kind: string; fault: BrowserPoolFault }[] = [];
  readonly #holds = new Map<BrowserPoolPhysicalKind, () => Promise<void>>();
  readonly log: string[] = [];
  readonly retentionMs: number;
  #status: BrowserPoolPhysicalStatus;
  #sequence = 0;
  /** The fence the controller last installed in its guest; every control names it. */
  #installed: BrowserPoolControl["fence"] | null = null;
  #now: () => number;
  unreachable = false;

  /** Each started guest has a new runtime of its own, which holds no fence before its install. */
  readonly #freshGuests: boolean;

  constructor(options: {
    slotId: string;
    term: number;
    retentionMs?: number;
    now?: () => number;
    freshGuests?: boolean;
  }) {
    this.#freshGuests = options.freshGuests === true;
    const keys = generateKeyPairSync("ed25519");
    this.publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#status = {
      slotId: options.slotId,
      term: options.term,
      instance: null,
      epoch: null,
      phase: "stopped",
      savedState: null,
    };
  }

  /** The next matching call suffers this fault once; `sign:<kind>` names one signature. */
  inject(kind: BrowserPoolPhysicalKind | `sign:${string}` | "any", fault: BrowserPoolFault): void {
    this.#faults.push({ kind, fault });
  }

  /** The next matching call runs this when it arrives, and applies once it settles. */
  hold(kind: BrowserPoolPhysicalKind, until: () => Promise<void>): void {
    this.#holds.set(kind, until);
  }

  /** Physical facts a controller observes on its own, such as a guest that died. */
  observe(change: Partial<BrowserPoolPhysicalStatus>): void {
    this.#status = { ...this.#status, ...change };
  }

  /** The kinds that changed physical state, in order; signatures are not listed. */
  get effects(): string[] {
    return this.log.filter((entry) => !entry.startsWith("sign"));
  }

  async status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus> {
    if (this.unreachable) throw new Error("The pool controller is unreachable.");
    this.#expire();
    if (slotId !== this.#status.slotId || term !== this.#status.term)
      throw new Error("The pool controller does not know this slot and term.");
    return structuredClone(this.#status);
  }

  async result(slotId: string, term: number, id: string) {
    if (this.unreachable) throw new Error("The pool controller is unreachable.");
    if (slotId !== this.#status.slotId || term !== this.#status.term) return null;
    return structuredClone(this.#results.get(id) ?? null);
  }

  async apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
    if (this.unreachable) throw new Error("The pool controller is unreachable.");
    const fault = this.#takeFault(call);
    if (fault === "request") throw new Error(`The ${call.kind} request was lost.`);
    const hold = this.#holds.get(call.kind);
    if (hold) {
      this.#holds.delete(call.kind);
      await hold();
    }
    const result = this.#apply(call);
    if (fault === "duplicate") this.#apply(call);
    if (fault === "reply") throw new Error(`The ${call.kind} reply was lost.`);
    return structuredClone(result);
  }

  #takeFault(call: BrowserPoolControllerCall): BrowserPoolFault | undefined {
    const index = this.#faults.findIndex(
      (entry) =>
        entry.kind === call.kind ||
        entry.kind === "any" ||
        (call.kind === "sign" && entry.kind === `sign:${call.control?.kind}`),
    );
    if (index < 0) return undefined;
    return this.#faults.splice(index, 1)[0]!.fault;
  }

  #expire(): void {
    const saved = this.#status.savedState;
    if (saved && Date.parse(saved.discardAt) <= this.#now())
      this.#status = { ...this.#status, phase: "stopped", savedState: null, epoch: null };
  }

  #apply(call: BrowserPoolControllerCall): BrowserPoolControllerResult {
    const stored = this.#results.get(call.id);
    if (stored) return stored;
    this.#expire();
    const refuse = (reason: string): BrowserPoolControllerResult => {
      const result = { id: call.id, applied: false, reason, status: structuredClone(this.#status) };
      this.#results.set(call.id, result);
      return result;
    };
    const current = this.#status;
    if (call.slotId !== current.slotId || call.term !== current.term) return refuse("fenced");
    const expected = call.expect;
    if (
      expected.instance !== current.instance ||
      expected.epoch !== current.epoch ||
      expected.phase !== current.phase ||
      expected.savedStateId !== (current.savedState?.id ?? null)
    )
      return refuse("predecessor-changed");
    let result: BrowserPoolControllerResult;
    switch (call.kind) {
      case "sign": {
        const control = call.control;
        if (
          !control ||
          current.phase !== "running" ||
          control.kind === "install" ||
          control.kind === "adopt" ||
          control.fence.slot !== current.slotId ||
          control.fence.term !== current.term ||
          control.fence.instance !== current.instance ||
          control.fence.epoch !== current.epoch
        )
          return refuse("not-current");
        result = {
          id: call.id,
          applied: true,
          status: current,
          ...this.#signed({ ...control, expect: this.#installed }),
        };
        break;
      }
      case "pause": {
        if (current.phase !== "running") return refuse("not-running");
        const savedState = {
          id: randomUUID(),
          discardAt: new Date(this.#now() + this.retentionMs).toISOString(),
        };
        this.#status = { ...current, phase: "paused", savedState };
        result = { id: call.id, applied: true, status: this.#status, savedState };
        break;
      }
      case "resume": {
        if (current.phase !== "paused" || !current.savedState || !call.intent)
          return refuse("no-saved-state");
        // The saved state is consumed here: it can never be resumed twice.
        this.#status = {
          ...current,
          phase: "running",
          epoch: current.epoch! + 1,
          savedState: null,
        };
        const signed = this.#signed({
          kind: "adopt",
          fence: this.#fence(),
          intent: call.intent,
          expect: this.#installed,
        });
        this.#installed = this.#fence();
        result = { id: call.id, applied: true, status: this.#status, ...signed };
        break;
      }
      case "stop": {
        this.#status = { ...current, phase: "stopped", savedState: null };
        result = { id: call.id, applied: true, status: this.#status };
        break;
      }
      case "start": {
        if (current.phase !== "stopped") return refuse("not-stopped");
        this.#status = {
          ...current,
          phase: "running",
          instance: randomUUID(),
          epoch: 1,
          savedState: null,
        };
        const signed = this.#signed({
          kind: "install",
          fence: this.#fence(),
          expect: this.#freshGuests ? null : this.#installed,
        });
        this.#installed = this.#fence();
        result = { id: call.id, applied: true, status: this.#status, ...signed };
        break;
      }
    }
    this.log.push(call.kind === "sign" ? `sign:${call.control!.kind}` : call.kind);
    this.#results.set(call.id, result);
    return result;
  }

  #fence() {
    return {
      slot: this.#status.slotId,
      term: this.#status.term,
      instance: this.#status.instance!,
      epoch: this.#status.epoch!,
    };
  }

  /** Numbers each control: an applied one, or an older one, never applies again. */
  #signed(input: Omit<BrowserPoolControl, "sequence">) {
    const control: BrowserPoolControl = { ...input, sequence: ++this.#sequence };
    return {
      control,
      signature: sign(null, browserPoolControlBytes(control), this.#privateKey).toString("base64"),
    };
  }
}
