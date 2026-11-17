import {
  ReferenceIdSchema,
  parseReferenceHref,
  type AgentEventView,
  type ReferenceId,
} from "@opensteer/core";
import {
  referenceResolveBatchSize,
  ReferenceResolveResultSchema,
  type AvailableReference,
  type ReferenceResolution,
} from "@opensteer/protocol";
import type { HostSnapshot } from "../host/client.js";
import type { ReferenceReadPorts, ReferenceState } from "./contracts.js";
import { localReference } from "./local.js";
import { heldThread } from "../host/task-list.js";
import type { IdReference as Reference } from "./links.js";

const unresolved: ReferenceState = { state: "unresolved" };
const failed: ReferenceState = { state: "failed" };
const unavailable: ReferenceState = { state: "unavailable" };
const revalidateAfter = 30_000;
const idleLimit = 1024;
interface Entry {
  readonly ref: Reference;
  readonly listeners: Set<() => void>;
  visible: number;
  state: ReferenceState;
  held: AvailableReference | null;
  blocked: boolean;
  parentThreadId: string | null;
  confirmedAt: number;
  version: number;
  explicit: boolean;
  pending?: Promise<ReferenceResolution>;
  resolve?: (answer: ReferenceResolution) => void;
  reject?: (error: unknown) => void;
}
export interface ReferenceStoreSource {
  readonly resolveReferences: ReferenceReadPorts["resolveReferences"];
  readonly getSnapshot: () => HostSnapshot;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly now?: () => number;
}

export class ReferenceStore {
  readonly #source: ReferenceStoreSource;
  readonly #entries = new Map<ReferenceId, Entry>();
  readonly #queue = new Set<Entry>();
  readonly #threadTitles = new Map<string, string>();
  readonly #release: (() => void) | undefined;
  #snapshot: HostSnapshot;
  #generation = 0;
  #scheduled = false;
  #flight: AbortController | null = null;
  #flightParents: Map<string, boolean> | null = null;
  #disposed = false;
  constructor(source: ReferenceStoreSource) {
    this.#source = source;
    this.#snapshot = source.getSnapshot();
    this.#release = source.subscribe?.(() => this.#sync());
  }
  #now() {
    return (this.#source.now ?? Date.now)();
  }
  #entry(id: ReferenceId): Entry {
    const canonical = ReferenceIdSchema.parse(id);
    let entry = this.#entries.get(canonical);
    if (!entry) {
      // A canonical reference ID never names a tab, whose links carry `tab/`.
      const ref = parseReferenceHref(`opensteer:${canonical}`) as Reference;
      entry = {
        ref,
        listeners: new Set(),
        visible: 0,
        state: unresolved,
        held: null,
        blocked: false,
        parentThreadId: null,
        confirmedAt: -Infinity,
        version: 0,
        explicit: false,
      };
    }
    this.#entries.delete(canonical);
    this.#entries.set(canonical, entry);
    this.#local(entry);
    return entry;
  }
  #set(entry: Entry, state: ReferenceState) {
    if (JSON.stringify(entry.state) === JSON.stringify(state)) return;
    entry.state = state;
    if (state.state === "available" && "threadId" in state.value)
      entry.parentThreadId = state.value.threadId;
    for (const listener of entry.listeners) listener();
  }
  #local(entry: Entry) {
    const held = localReference(this.#snapshot, entry.ref);
    const changed = JSON.stringify(held) !== JSON.stringify(entry.held);
    entry.held = held;
    if (held && (!entry.blocked || changed) && (changed || entry.state.state !== "available")) {
      entry.blocked = false;
      this.#set(entry, { state: "available", value: held });
    }
  }
  read(id: ReferenceId): ReferenceState {
    if (this.#disposed) return unresolved;
    this.#sync();
    const entry = this.#entry(id);
    this.#trim();
    return entry.state;
  }
  subscribe(
    id: ReferenceId,
    listener: () => void,
    options: { enabled?: boolean } = {},
  ): () => void {
    if (this.#disposed) return () => {};
    this.#sync();
    const entry = this.#entry(id);
    const enabled = options.enabled !== false;
    // Each retention has its own identity, even if a caller reuses its callback.
    const notify = () => listener();
    entry.listeners.add(notify);
    if (enabled) {
      entry.visible++;
      if (
        entry.state.state === "unresolved" ||
        ((entry.state.state === "available" || entry.state.state === "unavailable") &&
          (!entry.held || entry.blocked) &&
          this.#now() - entry.confirmedAt >= revalidateAfter)
      )
        void this.#request(entry);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(notify);
      if (enabled) entry.visible--;
      if (!entry.visible && !entry.explicit && this.#queue.delete(entry))
        this.#settle(entry, new Error("Reference is no longer visible"));
      this.#trim();
    };
  }
  resolve(id: ReferenceId, options: { refresh?: boolean } = {}): Promise<ReferenceResolution> {
    if (this.#disposed) return Promise.reject(new Error("Reference store is disposed"));
    this.#sync();
    const entry = this.#entry(id);
    if (!options.refresh && entry.state.state === "available" && entry.held && !entry.blocked)
      return Promise.resolve(entry.state.value);
    if (!options.refresh && this.#now() - entry.confirmedAt < revalidateAfter) {
      if (entry.state.state === "available") return Promise.resolve(entry.state.value);
      if (entry.state.state === "unavailable")
        return Promise.resolve({ status: "unavailable", id: entry.ref.id });
    }
    entry.explicit = true;
    return this.#request(entry);
  }
  #request(entry: Entry): Promise<ReferenceResolution> {
    if (!entry.pending) {
      entry.pending = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      void entry.pending.catch(() => undefined);
      this.#queue.add(entry);
      this.#schedule();
    }
    return entry.pending;
  }
  #schedule() {
    if (this.#disposed || this.#scheduled || this.#flight || !this.#queue.size) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#flush();
    });
  }
  #settle(entry: Entry, error?: unknown, answer?: ReferenceResolution) {
    if (answer) entry.resolve?.(answer);
    else entry.reject?.(error ?? new Error("Reference read invalidated"));
    delete entry.pending;
    delete entry.resolve;
    delete entry.reject;
    entry.explicit = false;
  }
  async #flush() {
    if (this.#disposed || this.#flight) return;
    this.#sync();
    const connected =
      this.#snapshot.connection === "connected" && this.#snapshot.session === "authenticated";
    const batch = [...this.#queue]
      .filter((entry) => entry.explicit || connected)
      .slice(0, referenceResolveBatchSize);
    if (!batch.length) return;
    batch.forEach((entry) => this.#queue.delete(entry));
    const generation = this.#generation;
    const versions = batch.map(({ version }) => version);
    const heldAtStart = batch.map(({ held }) => held);
    const controller = new AbortController();
    this.#flight = controller;
    const parents = new Map<string, boolean>();
    this.#flightParents = parents;
    try {
      const result = ReferenceResolveResultSchema.parse(
        await this.#source.resolveReferences(
          { ids: batch.map(({ ref }) => ref.id) },
          controller.signal,
        ),
      );
      if (
        result.results.length !== batch.length ||
        result.results.some((value, i) => value.id !== batch[i]!.ref.id)
      )
        throw new Error("Invalid reference batch response");
      this.#sync();
      if (generation !== this.#generation || this.#disposed) return;
      batch.forEach((entry, i) => {
        if (entry.version !== versions[i]) return;
        let value = result.results[i]!;
        if (
          value.status === "available" &&
          "threadId" in value &&
          value.threadId &&
          parents.has(value.threadId)
        ) {
          if (!parents.get(value.threadId)) {
            this.#invalidate(entry);
            return;
          }
          value = { status: "unavailable", id: entry.ref.id };
        }
        entry.confirmedAt = this.#now();
        entry.blocked = value.status === "unavailable";
        const newerHeld =
          entry.held && JSON.stringify(entry.held) !== JSON.stringify(heldAtStart[i]);
        this.#set(
          entry,
          value.status === "available"
            ? { state: "available", value: newerHeld ? entry.held! : value }
            : unavailable,
        );
        if (!entry.blocked) this.#local(entry);
        this.#settle(
          entry,
          undefined,
          value.status === "available" && newerHeld ? entry.held! : value,
        );
      });
    } catch (error) {
      if (generation !== this.#generation || this.#disposed) return;
      for (const [i, entry] of batch.entries()) {
        if (entry.version !== versions[i]) continue;
        // Authentication failure remains a failed read; the RPC adapter ends the session.
        if (!entry.held || entry.blocked) this.#set(entry, failed);
        this.#settle(entry, error);
      }
    } finally {
      if (this.#flight === controller) {
        this.#flight = null;
        this.#flightParents = null;
      }
      this.#trim();
      this.#schedule();
    }
  }
  #invalidate(entry: Entry, removed = false, restoreHeld = false) {
    entry.version++;
    this.#queue.delete(entry);
    this.#settle(entry);
    entry.confirmedAt = -Infinity;
    if (removed) {
      entry.blocked = true;
      this.#set(entry, unavailable);
      entry.confirmedAt = this.#now();
      return;
    }
    if (restoreHeld) entry.blocked = false;
    this.#local(entry);
    if (!entry.held || entry.blocked) {
      this.#set(entry, unresolved);
      if (entry.visible) void this.#request(entry);
    }
  }
  /** A targeted open's authoritative refusal, never a batch authentication failure. */
  unavailable(id: ReferenceId) {
    this.#sync();
    this.#invalidate(this.#entry(id), true);
  }
  accept(event: AgentEventView | { readonly type: null }): void {
    if (this.#disposed || event.type === null) return;
    this.#sync();
    const ids = new Set<string>();
    let parent = false;
    let removed = false;
    switch (event.type) {
      case "task.removed":
        ids.add(event.threadId);
        parent = true;
        removed = true;
        break;
      case "thread.created":
      case "thread.listed":
      case "thread.execution-updated":
        ids.add(event.threadId);
        parent = true;
        break;
      case "thread.state-changed": {
        const title = event.data.title;
        if (title === undefined) break;
        const previous =
          this.#threadTitles.get(event.threadId) ??
          heldThread(this.#snapshot, event.threadId)?.title;
        const relevant =
          this.#flight !== null ||
          [...this.#entries.values()].some(
            (entry) => entry.ref.id === event.threadId || entry.parentThreadId === event.threadId,
          );
        if (!relevant) break;
        this.#threadTitles.set(event.threadId, title);
        if (this.#threadTitles.size > idleLimit)
          this.#threadTitles.delete(this.#threadTitles.keys().next().value!);
        if (title !== previous || this.#entries.get(event.threadId)?.blocked) {
          ids.add(event.threadId);
          parent = true;
        }
        break;
      }
      case "request.opened":
      case "request.updated":
      case "request.resolved":
        ids.add(event.data.request.id);
        break;
      case "request.cancelled":
        ids.add(event.data.requestId);
        break;
      case "message.created":
      case "message.placed":
      case "message.updated":
        ids.add(event.data.message.id);
        break;
      case "assistant.message":
      case "voice.heard":
      case "message.injected":
        ids.add(event.data.messageId);
        break;
      case "thread-input.updated":
        ids.add(event.data.input.messageId);
        break;
      case "run.started":
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
      case "run.status":
        if (event.runId) ids.add(event.runId);
        break;
    }
    if (parent) this.#flightParents?.set(event.threadId, removed);
    for (const entry of this.#entries.values()) {
      if (ids.has(entry.ref.id) || (parent && entry.parentThreadId === event.threadId))
        this.#invalidate(entry, removed, ids.has(entry.ref.id));
    }
  }
  /** Personal stream reset or reconnect; one refresh for currently visible IDs. */
  reconnect() {
    if (this.#disposed) return;
    for (const entry of this.#entries.values()) this.#invalidate(entry);
  }
  #sync() {
    if (this.#disposed) return;
    const next = this.#source.getSnapshot();
    const previous = this.#snapshot;
    if (next === previous) return;
    this.#snapshot = next;
    if (
      next.deploymentId !== previous.deploymentId ||
      next.user?.id !== previous.user?.id ||
      next.sessionId !== previous.sessionId ||
      next.session !== previous.session
    ) {
      this.reset();
      return;
    }
    if (previous.connection !== "connected" && next.connection === "connected") this.reconnect();
    for (const entry of this.#entries.values()) {
      if (
        (entry.ref.kind === "computer" && previous.machineRevision !== next.machineRevision) ||
        (entry.ref.kind === "automation" && previous.triggerRevision !== next.triggerRevision)
      )
        this.#invalidate(entry, false, true);
      else this.#local(entry);
    }
  }
  reset() {
    this.#generation++;
    this.#flight?.abort();
    this.#flight = null;
    this.#flightParents = null;
    this.#queue.clear();
    this.#threadTitles.clear();
    this.#snapshot = this.#source.getSnapshot();
    for (const [id, entry] of this.#entries) {
      entry.version++;
      this.#settle(entry);
      entry.held = null;
      entry.parentThreadId = null;
      entry.blocked = false;
      entry.confirmedAt = -Infinity;
      this.#set(entry, unresolved);
      if (!entry.listeners.size) this.#entries.delete(id);
      else if (!this.#disposed && this.#snapshot.session === "authenticated") {
        this.#local(entry);
        if (entry.visible && !entry.held) void this.#request(entry);
      }
    }
  }
  #trim() {
    let idle = [...this.#entries.values()].filter(
      (entry) => !entry.listeners.size && !entry.pending,
    ).length;
    for (const [id, entry] of this.#entries) {
      if (idle <= idleLimit) break;
      if (!entry.listeners.size && !entry.pending) {
        this.#entries.delete(id);
        idle--;
      }
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release?.();
    this.reset();
    this.#entries.clear();
  }
}
