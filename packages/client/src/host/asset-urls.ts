import { ThreadIdSchema } from "@opensteer/core";
import {
  AssetSourceSchema,
  type AssetUrl,
  type AssetVariant,
  type AssetSource,
} from "@opensteer/protocol";
import type { HostTransport } from "../connections/host-transport.js";
import type { ReferenceReadPorts } from "../references/contracts.js";

export type AssetRoute = Pick<HostTransport, "current" | "onAttachmentInvalidated">;
export type AssetMetadata = Extract<AssetUrl, { status: "ok" }>;
export type AssetImage = AssetMetadata & { readonly source: string };
export interface AssetReadOptions {
  readonly enabled?: boolean;
  readonly signal?: AbortSignal;
}
type Entry = {
  deploymentId: string;
  threadId: string | null;
  source: AssetSource;
  variant: AssetVariant;
  listeners: Set<() => void>;
  value?: AssetUrl;
  confirmedAt?: number;
  asking: boolean;
  loadRetried: boolean;
  persistent: boolean;
  signals: Map<AbortSignal, () => void>;
  version: number;
  pending?: Promise<AssetUrl>;
  resolve?: (value: AssetUrl) => void;
};
const unavailable: AssetUrl = { status: "unavailable", reason: "missing" };
const margin = 5 * 60_000;
const revalidateAfter = 30_000;
const remountAfter = 2_000;

export function assetImageUrl(
  deploymentId: string,
  relative: string,
  origin: string,
  desktop: boolean,
): string {
  if (!relative.startsWith("/media/") || relative.startsWith("//"))
    throw new Error("Invalid media address");
  return desktop
    ? `app://opensteer/media/${encodeURIComponent(deploymentId)}/${relative.slice(7)}`
    : new URL(relative, origin).href;
}
function sourceValue(source: AssetSource | string): AssetSource {
  // Legacy image spellings are passed intact to the Host's confined normalizer.
  return AssetSourceSchema.parse(
    typeof source === "string" ? { kind: "path", path: source } : source,
  );
}
function entryKey(
  deploymentId: string,
  threadId: string | null,
  source: AssetSource,
  variant: AssetVariant,
) {
  return JSON.stringify([
    deploymentId,
    threadId,
    source.kind,
    source.kind === "path"
      ? source.path
      : source.kind === "transcript-image"
        ? source.imageId
        : source.attachmentId,
    variant,
  ]);
}
export class AssetUrlStore {
  readonly #entries = new Map<string, Entry>();
  readonly #queue = new Set<Entry>();
  readonly #listeners = new Set<() => void>();
  readonly #release: (() => void) | undefined;
  readonly #read: ReferenceReadPorts["assetUrls"];
  readonly #controllers = new Map<AbortController, readonly Entry[]>();
  #scheduled = false;
  #disposed = false;
  #generation = 0;
  readonly route: {
    origin: (deploymentId: string) => Promise<string>;
    subscribe?: (listener: () => void) => () => void;
  };
  readonly desktop: boolean;
  constructor(
    read: ReferenceReadPorts["assetUrls"],
    route: AssetUrlStore["route"],
    desktop = false,
  ) {
    this.#read = read;
    this.route = route;
    this.desktop = desktop;
    this.#release = route.subscribe?.(() => {
      for (const entry of this.#entries.values())
        for (const listener of entry.listeners) listener();
      for (const listener of this.#listeners) listener();
    });
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  subscribeImage(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    listener: () => void,
  ) {
    if (this.#disposed) return () => {};
    const entry = this.#entry(deploymentId, threadId, source, variant);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  #emit(entries: readonly Entry[]) {
    for (const entry of entries) for (const listener of entry.listeners) listener();
    for (const listener of this.#listeners) listener();
  }
  #entry(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
  ) {
    const value = sourceValue(source);
    const key = entryKey(deploymentId, threadId, value, variant);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {
        deploymentId,
        threadId,
        source: value,
        variant,
        listeners: new Set(),
        asking: false,
        loadRetried: false,
        persistent: false,
        signals: new Map(),
        version: 0,
      };
      this.#entries.set(key, entry);
    }
    return entry;
  }
  /** Holds an address the Host already minted elsewhere, so the image's first use reads nothing. */
  seed(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    value: AssetUrl,
  ) {
    if (this.#disposed) return;
    const entry = this.#entry(deploymentId, threadId, source, variant);
    entry.confirmedAt = Date.now();
    if (sameAsset(entry.value, value)) return;
    entry.value = value;
    entry.loadRetried = false;
    this.#emit([entry]);
  }
  async image(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    options: AssetReadOptions = {},
  ): Promise<AssetImage | null> {
    const generation = this.#generation;
    const value = await this.get(deploymentId, threadId, source, variant, false, options);
    if (
      value.status !== "ok" ||
      options.enabled === false ||
      options.signal?.aborted ||
      this.#disposed ||
      generation !== this.#generation
    )
      return null;
    const origin = this.desktop ? "" : await this.route.origin(deploymentId);
    if (options.signal?.aborted || this.#disposed || generation !== this.#generation) return null;
    return { ...value, source: assetImageUrl(deploymentId, value.url, origin, this.desktop) };
  }
  get(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    refresh = false,
    options: AssetReadOptions = {},
  ): Promise<AssetUrl> {
    if (this.#disposed || options.enabled === false || options.signal?.aborted)
      return Promise.resolve(unavailable);
    const entry = this.#entry(deploymentId, threadId, source, variant);
    const value = entry.value;
    if (
      !refresh &&
      !entry.pending &&
      value &&
      (value.status !== "ok" || Date.parse(value.expiresAt) - Date.now() > margin)
    ) {
      if (!entry.asking && Date.now() - (entry.confirmedAt ?? 0) > revalidateAfter) {
        this.#retain(entry, options.signal);
        this.#enqueue(entry);
      }
      return Promise.resolve(value);
    }
    if (!entry.pending)
      entry.pending = new Promise((resolve) => {
        entry.resolve = resolve;
      });
    this.#retain(entry, options.signal);
    this.#enqueue(entry);
    return entry.pending;
  }
  #retain(entry: Entry, signal?: AbortSignal) {
    if (!signal) {
      entry.persistent = true;
      return;
    }
    if (entry.signals.has(signal)) return;
    const release = () => {
      signal.removeEventListener("abort", release);
      entry.signals.delete(signal);
      if (entry.signals.size || entry.persistent) return;
      entry.version++;
      entry.asking = false;
      this.#queue.delete(entry);
      entry.resolve?.(unavailable);
      for (const [controller, batch] of this.#controllers)
        if (batch.every((entry) => !entry.asking)) controller.abort();
      delete entry.pending;
      delete entry.resolve;
    };
    entry.signals.set(signal, release);
    signal.addEventListener("abort", release, { once: true });
  }
  confirm(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    options: AssetReadOptions = {},
  ) {
    if (this.#disposed || options.enabled === false || options.signal?.aborted) return;
    const entry = this.#entries.get(entryKey(deploymentId, threadId, sourceValue(source), variant));
    if (entry?.value && !entry.asking && Date.now() - (entry.confirmedAt ?? 0) > remountAfter) {
      this.#retain(entry, options.signal);
      this.#enqueue(entry);
    }
  }
  #enqueue(entry: Entry) {
    if (entry.asking) return;
    entry.asking = true;
    this.#queue.add(entry);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#flush();
    });
  }
  async loadFailed(
    deploymentId: string,
    threadId: string | null,
    source: AssetSource | string,
    variant: AssetVariant,
    options: AssetReadOptions = {},
  ): Promise<boolean> {
    if (this.#disposed || options.enabled === false || options.signal?.aborted) return false;
    const entry = this.#entries.get(entryKey(deploymentId, threadId, sourceValue(source), variant));
    if (!entry) return false;
    if (entry.pending && entry.loadRetried) return (await entry.pending).status === "ok";
    if (entry.loadRetried) {
      entry.value = unavailable;
      this.#emit([entry]);
      return false;
    }
    entry.loadRetried = true;
    delete entry.value;
    const generation = this.#generation;
    const value = await this.get(deploymentId, threadId, source, variant, true, options);
    if (generation !== this.#generation || this.#disposed || options.signal?.aborted) return false;
    entry.loadRetried = true;
    return value.status === "ok";
  }
  async #flush() {
    if (this.#disposed) return;
    const groups = new Map<string, Entry[]>();
    for (const entry of this.#queue) {
      // A task's paths batch apart from everything else, in the shape every Host in the API
      // window reads, so one newer item cannot fail an older Host's whole batch.
      const legacy = entry.threadId !== null && entry.source.kind === "path";
      const key = JSON.stringify([entry.deploymentId, entry.threadId, legacy]);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    this.#queue.clear();
    const generation = this.#generation;
    await Promise.all(
      [...groups.values()].map(async (entries) => {
        for (let start = 0; start < entries.length; start += 32) {
          if (this.#disposed || generation !== this.#generation) return;
          const batch = entries.slice(start, start + 32).filter((entry) => entry.asking);
          if (!batch.length) continue;
          const versions = batch.map(({ version }) => version);
          const controller = new AbortController();
          this.#controllers.set(controller, batch);
          let values: readonly AssetUrl[] | undefined;
          try {
            values = (
              await this.#read(
                {
                  ...(batch[0]!.threadId === null
                    ? {}
                    : { threadId: ThreadIdSchema.parse(batch[0]!.threadId) }),
                  // Paths keep the shape every Host in the API window reads.
                  assets: batch.map(({ source, variant }) =>
                    source.kind === "path" ? { path: source.path, variant } : { source, variant },
                  ),
                },
                controller.signal,
              )
            ).assets;
          } catch {
            /* A failed mint is retryable on the next use. */
          } finally {
            this.#controllers.delete(controller);
          }
          if (this.#disposed || generation !== this.#generation) return;
          const changed: Entry[] = [];
          batch.forEach((entry, index) => {
            if (entry.version !== versions[index]) return;
            entry.asking = false;
            const value = values?.[index];
            if (value) {
              if (!sameAsset(entry.value, value)) {
                changed.push(entry);
                entry.loadRetried = false;
              }
              entry.value = value;
              entry.confirmedAt = Date.now();
            }
            entry.resolve?.(value ?? unavailable);
            delete entry.pending;
            delete entry.resolve;
            entry.persistent = false;
            for (const [signal, release] of entry.signals)
              signal.removeEventListener("abort", release);
            entry.signals.clear();
          });
          if (changed.length) this.#emit(changed);
        }
      }),
    );
  }
  reset() {
    this.#generation++;
    this.#queue.clear();
    for (const controller of this.#controllers.keys()) controller.abort();
    this.#controllers.clear();
    const entries = [...this.#entries.values()];
    for (const [key, entry] of this.#entries) {
      entry.version++;
      entry.resolve?.(unavailable);
      delete entry.value;
      delete entry.pending;
      delete entry.resolve;
      entry.asking = false;
      entry.loadRetried = false;
      entry.persistent = false;
      for (const [signal, release] of entry.signals) signal.removeEventListener("abort", release);
      entry.signals.clear();
      if (!entry.listeners.size) this.#entries.delete(key);
    }
    this.#emit(entries);
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release?.();
    this.reset();
    this.#listeners.clear();
  }
}
function sameAsset(left: AssetUrl | undefined, right: AssetUrl): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
