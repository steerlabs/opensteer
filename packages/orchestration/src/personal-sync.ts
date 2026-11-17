import type {
  PersonalResumeCursor,
  PersonalScope,
  ScopedClientMessage,
  ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";

type Subscribe = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
type Address = Pick<Subscribe, "subscriptionId" | "generation">;
type Id = Address["subscriptionId"];
type CutFrame = Extract<
  ScopedHostMessage,
  {
    type: "host.snapshot" | "host.changes" | "host.snapshot-required" | "host.removed";
  }
>;
type WithoutAddress<T> = T extends CutFrame ? Omit<T, keyof Address> : never;
type Watch = Extract<ScopedClientMessage, { type: "client.resources.watch" }>;
type Resource = Omit<Extract<ScopedHostMessage, { type: "host.resource" }>, "type" | keyof Address>;

interface ScopeCut {
  readonly throughSequence: string;
  readonly cursor: PersonalResumeCursor | null;
  readonly frames: readonly WithoutAddress<CutFrame>[];
}

interface PersonalSyncPort {
  read(
    scope: PersonalScope,
    cursor: PersonalResumeCursor | null,
    signal: AbortSignal,
    anchorItemId?: string,
  ): Promise<ScopeCut>;
  send(encoded: string, guard: () => boolean, signal: AbortSignal): Promise<boolean>;
  readResources?(
    interests: readonly PersonalResourceKind[],
    installed: Watch["installed"],
    signal: AbortSignal,
  ): Promise<readonly Resource[]>;
  close(reason: string): void;
}

interface Credit {
  readonly through: string;
  readonly bytes: number;
  readonly changes: number;
  readonly durable: boolean;
}

interface Subscription {
  readonly request: Subscribe;
  readonly controller: AbortController;
  cursor: PersonalResumeCursor | null;
  pendingHead: bigint;
  credit: Credit[];
  bytes: number;
  changes: number;
  acknowledged: bigint;
  sending: boolean;
  synchronized: boolean;
  needsRepair: boolean;
  pauseCount: number;
  resources?: { interests: Watch["interests"]; installed: Watch["installed"]; dirty: boolean };
}

const scopeBudget = 256 * 1024;
const socketBudget = 512 * 1024;

export class PersonalSyncSocket {
  readonly #port: PersonalSyncPort;
  readonly #subscriptions = new Map<Id, Subscription>();
  readonly #generations = new Map<Id, number>();
  readonly #inFlight = new Map<Credit, Subscription>();
  readonly #fences = new Set<(scope: PersonalScope) => boolean>();
  #head = 0n;
  #closed = false;
  #pressureTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(port: PersonalSyncPort) {
    this.#port = port;
  }

  attach(request: Extract<ScopedClientMessage, { type: "client.attach" }>) {
    const { selected, ...shell } = request;
    this.subscribe(
      {
        type: "client.subscribe",
        scope: { kind: "shell" },
        subscriptionId: "shell",
        generation: shell.generation,
        ...(shell.cursor ? { cursor: shell.cursor } : {}),
      },
      { interests: shell.interests, installed: shell.installed },
    );
    if (selected) this.subscribe({ ...selected, type: "client.subscribe" });
  }

  watchResources(message: Watch) {
    const current = this.#subscriptions.get("shell");
    if (!current || current.request.generation !== message.generation) return;
    current.resources = { interests: message.interests, installed: message.installed, dirty: true };
    this.#schedule(current);
  }

  subscribe(request: Subscribe, resources?: Pick<Watch, "interests" | "installed">) {
    if (this.#closed || request.generation <= (this.#generations.get(request.subscriptionId) ?? 0))
      return;
    const peers = [...this.#subscriptions.values()].filter(
      (current) => current.request.subscriptionId !== request.subscriptionId,
    );
    if (
      request.scope.kind === "node" &&
      peers.filter((current) => current.request.scope.kind === "node").length >= 2
    ) {
      this.close("Too many node subscriptions");
      return;
    }
    const current: Subscription = {
      request,
      controller: new AbortController(),
      cursor: request.cursor ?? null,
      pendingHead: this.#head,
      credit: [],
      bytes: 0,
      changes: 0,
      acknowledged: 0n,
      sending: false,
      synchronized: false,
      needsRepair: false,
      pauseCount: [...this.#fences].filter((matches) => matches(request.scope)).length,
      ...(resources ? { resources: { ...resources, dirty: true } } : {}),
    };
    this.#subscriptions.get(request.subscriptionId)?.controller.abort();
    this.#generations.set(request.subscriptionId, request.generation);
    this.#subscriptions.set(request.subscriptionId, current);
    this.#schedule(current);
  }

  unsubscribe(address: Address) {
    const current = this.#subscriptions.get(address.subscriptionId);
    if (!current || current.request.generation !== address.generation) return;
    current.controller.abort();
    this.#subscriptions.delete(address.subscriptionId);
    this.#reschedule();
  }

  ack(input: Address & { readonly throughSequence: string }) {
    const current = this.#subscriptions.get(input.subscriptionId);
    if (!current || current.request.generation !== input.generation) return;
    const sent =
      current.credit.findLast((credit) => credit.durable)?.through ?? current.cursor?.afterSequence;
    const through = BigInt(input.throughSequence);
    if (!sent || through > BigInt(sent)) {
      this.close("Acknowledgement is ahead of delivered state");
      return;
    }
    if (through > current.acknowledged) current.acknowledged = through;
    if (this.#releaseCredits(current)) this.#reschedule();
  }

  #releaseCredits(current: Subscription) {
    const previous = current.credit.length;
    let kept = 0;
    for (const credit of current.credit) {
      if (
        credit.durable &&
        BigInt(credit.through) <= current.acknowledged &&
        !this.#inFlight.has(credit)
      ) {
        current.bytes -= credit.bytes;
        current.changes -= credit.changes;
      } else current.credit[kept++] = credit;
    }
    current.credit.length = kept;
    return kept < previous;
  }

  wake(head: string) {
    const sequence = BigInt(head);
    if (sequence <= this.#head || this.#closed) return;
    this.#head = sequence;
    for (const current of this.#subscriptions.values()) {
      if (sequence > current.pendingHead) current.pendingHead = sequence;
      if (current.resources) current.resources.dirty = true;
      this.#schedule(current);
    }
  }

  suspend(matches: (scope: PersonalScope) => boolean) {
    const affected = () =>
      [...this.#subscriptions.values()].filter((current) => matches(current.request.scope));
    this.#fences.add(matches);
    for (const current of affected()) current.pauseCount++;
    return {
      committed: () => {
        if (!this.#fences.delete(matches)) return;
        if (affected().length) this.close("Personal authority changed");
      },
      rolledBack: () => {
        if (!this.#fences.delete(matches)) return;
        for (const current of affected()) {
          current.pauseCount--;
          this.#schedule(current);
        }
      },
    };
  }

  close(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#pressureTimer);
    for (const current of this.#subscriptions.values()) current.controller.abort();
    this.#subscriptions.clear();
    this.#port.close(reason);
  }

  #matches(current: Subscription) {
    return (
      !this.#closed &&
      this.#subscriptions.get(current.request.subscriptionId) === current &&
      !current.controller.signal.aborted
    );
  }

  #reschedule() {
    clearTimeout(this.#pressureTimer);
    this.#pressureTimer = undefined;
    for (const current of this.#subscriptions.values()) this.#schedule(current);
  }

  #schedule(current: Subscription) {
    if (!this.#matches(current) || current.pauseCount > 0 || current.sending || current.needsRepair)
      return;
    if (
      current.synchronized &&
      current.pendingHead <= BigInt(current.cursor?.afterSequence ?? 0) &&
      !current.resources?.dirty
    )
      return;
    current.sending = true;
    void this.#drain(current)
      .catch(() => {
        if (this.#matches(current)) this.close("Personal scope delivery failed");
      })
      .finally(() => {
        current.sending = false;
        if (this.#pressureTimer === undefined) this.#schedule(current);
      });
  }

  async #drain(current: Subscription) {
    const { request, controller } = current;
    if (current.synchronized && current.pendingHead <= BigInt(current.cursor?.afterSequence ?? 0)) {
      await this.#sendResources(current);
      return;
    }
    const cursor = current.cursor;
    const cut = await this.#port.read(
      request.scope,
      cursor,
      controller.signal,
      request.anchorItemId,
    );
    if (!this.#matches(current)) return;
    const address = { subscriptionId: request.subscriptionId, generation: request.generation };
    for (const frame of cut.frames) {
      if (frame.type === "host.snapshot-required" || frame.type === "host.removed") {
        if (await this.#send(current, { ...frame, ...address })) current.needsRepair = true;
        return;
      }
      const sent = await this.#send(current, { ...frame, ...address });
      if (!sent) return;
      if (!cut.cursor) throw new Error("A durable personal cut needs a cursor");
      current.cursor = { ...cut.cursor, afterSequence: frame.throughSequence };
    }
    if (!this.#matches(current) || current.pauseCount > 0 || !cut.cursor) return;
    current.cursor = cut.cursor;
    if (!current.synchronized) {
      const sent = await this.#send(current, {
        type: "host.synchronized",
        ...address,
        scope: request.scope,
        throughSequence: cut.throughSequence,
      });
      if (sent) current.synchronized = true;
    }
    if (current.synchronized) await this.#sendResources(current);
  }

  async #sendResources(current: Subscription) {
    const watch = current.resources;
    if (!watch?.dirty) return;
    watch.dirty = false;
    if (!this.#port.readResources || !watch.interests.length) return;
    const views = await this.#port.readResources(
      watch.interests,
      watch.installed,
      current.controller.signal,
    );
    for (const view of views) {
      if (current.resources !== watch || !this.#matches(current)) return;
      if (!watch.interests.includes(view.kind)) continue;
      const sent = await this.#send(
        current,
        {
          type: "host.resource",
          subscriptionId: "shell",
          generation: current.request.generation,
          ...view,
        },
        () => current.resources === watch,
      );
      if (!sent) {
        watch.dirty = true;
        return;
      }
      watch.installed = { ...watch.installed, [view.kind]: view.revision };
    }
  }

  async #send(current: Subscription, frame: ScopedHostMessage, stillCurrent = () => true) {
    const guard = () => this.#matches(current) && current.pauseCount === 0 && stillCurrent();
    if (!guard()) return false;
    const encoded = JSON.stringify(frame);
    const bytes = Buffer.byteLength(encoded);
    const changes = frame.type === "host.changes" ? frame.changes.length : 0;
    let socketBytes = [...this.#subscriptions.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    let socketChanges = [...this.#subscriptions.values()].reduce(
      (sum, entry) => sum + entry.changes,
      0,
    );
    for (const [credit, entry] of this.#inFlight) {
      if (!this.#matches(entry)) {
        socketBytes += credit.bytes;
        socketChanges += credit.changes;
      }
    }
    if (bytes > scopeBudget || changes > 128)
      throw new Error("A single personal frame exceeded its credit");
    if (
      current.bytes + bytes > scopeBudget ||
      socketBytes + bytes > socketBudget ||
      current.changes + changes > 128 ||
      socketChanges + changes > 256
    ) {
      this.#pressureTimer ??= setTimeout(() => this.close("Personal sync credit expired"), 5000);
      return false;
    }
    const durable = frame.type === "host.snapshot" || frame.type === "host.changes";
    const credit: Credit = {
      through: "throughSequence" in frame ? frame.throughSequence : "0",
      bytes,
      changes,
      durable,
    };
    current.credit.push(credit);
    this.#inFlight.set(credit, current);
    current.bytes += bytes;
    current.changes += changes;
    let sent = false;
    try {
      const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(5000)]);
      sent = await this.#port.send(encoded, guard, signal);
      if (!sent && guard()) this.close("Personal sync transport did not dispatch a frame");
      return sent && this.#matches(current);
    } finally {
      this.#inFlight.delete(credit);
      if (!durable || !sent) {
        const index = current.credit.indexOf(credit);
        if (index >= 0) {
          current.credit.splice(index, 1);
          current.bytes -= bytes;
          current.changes -= changes;
        }
      }
      if (this.#releaseCredits(current)) this.#reschedule();
    }
  }
}
