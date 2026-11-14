import type { AssetUrl, AssetVariant, HostApiClient } from "@opensteer/protocol";
import { ThreadIdSchema } from "@opensteer/core";
import type { HostTransport } from "../connections/host-transport.js";

export type AssetRoute = Pick<HostTransport, "current" | "onAttachmentInvalidated">;
export type AssetMetadata = Extract<AssetUrl, { status: "ok" }>;
export type AssetImage = AssetMetadata & { readonly source: string };
type Entry = {
  deploymentId: string;
  threadId: string;
  path: string;
  variant: AssetVariant;
  value?: AssetUrl;
  /** When `value` was last confirmed by the Host. */
  confirmedAt?: number;
  /** A call naming this entry is in flight, foreground or background. */
  asking?: boolean;
  loadRetried?: boolean;
  pending?: Promise<AssetUrl>;
  resolve?: (value: AssetUrl) => void;
};
const unavailable: AssetUrl = { status: "unavailable", reason: "missing" };
const margin = 5 * 60_000;
/**
 * A cached address renders at once; one older than this is re-confirmed in the
 * background, so a file overwritten at the same path is never shown stale for
 * long, while remounts and re-renders cost no round trip.
 */
const revalidateAfter = 30_000;

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

export class AssetUrlStore {
  readonly #entries = new Map<string, Entry>();
  readonly #queue = new Set<Entry>();
  readonly #listeners = new Set<() => void>();
  readonly #release: (() => void) | undefined;
  #scheduled = false;
  #disposed = false;
  readonly rpc: HostApiClient;
  readonly route: {
    origin: (deploymentId: string) => Promise<string>;
    subscribe?: (listener: () => void) => () => void;
  };
  readonly desktop: boolean;
  constructor(
    rpc: HostApiClient,
    route: {
      origin: (deploymentId: string) => Promise<string>;
      subscribe?: (listener: () => void) => () => void;
    },
    desktop = false,
  ) {
    this.rpc = rpc;
    this.route = route;
    this.desktop = desktop;
    this.#release = route.subscribe?.(() => this.#emit());
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  async image(
    deploymentId: string,
    threadId: string,
    path: string,
    variant: AssetVariant,
  ): Promise<AssetImage | null> {
    const value = await this.get(deploymentId, threadId, path, variant);
    if (value.status !== "ok") return null;
    const origin = this.desktop ? "" : await this.route.origin(deploymentId);
    return { ...value, source: assetImageUrl(deploymentId, value.url, origin, this.desktop) };
  }
  get(
    deploymentId: string,
    threadId: string,
    path: string,
    variant: AssetVariant,
    refresh = false,
  ): Promise<AssetUrl> {
    if (this.#disposed) return Promise.resolve(unavailable);
    const key = JSON.stringify([deploymentId, threadId, path, variant]);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { deploymentId, threadId, path, variant };
      this.#entries.set(key, entry);
    }
    const value = entry.value;
    if (
      !refresh &&
      !entry.pending &&
      value &&
      (value.status !== "ok" || Date.parse(value.expiresAt) - Date.now() > margin)
    ) {
      if (!entry.asking && Date.now() - (entry.confirmedAt ?? 0) > revalidateAfter)
        this.#enqueue(entry);
      return Promise.resolve(value);
    }
    if (entry.pending) return entry.pending;
    entry.pending = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.#enqueue(entry);
    return entry.pending;
  }
  #enqueue(entry: Entry) {
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
    threadId: string,
    path: string,
    variant: AssetVariant,
  ): Promise<boolean> {
    const entry = this.#entries.get(JSON.stringify([deploymentId, threadId, path, variant]));
    if (!entry) return false;
    if (entry.pending && entry.loadRetried) return (await entry.pending).status === "ok";
    if (entry.loadRetried) {
      entry.value = unavailable;
      this.#emit();
      return false;
    }
    delete entry.value;
    const value = await this.get(deploymentId, threadId, path, variant, true);
    entry.loadRetried = true;
    return value.status === "ok";
  }
  async #flush() {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.#queue) {
      const key = JSON.stringify([entry.deploymentId, entry.threadId]);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    this.#queue.clear();
    await Promise.all(
      [...groups.values()].map(async (entries) => {
        for (let start = 0; start < entries.length; start += 32) {
          const batch = entries.slice(start, start + 32);
          let values: readonly AssetUrl[] | undefined;
          try {
            const result = await this.rpc["asset.urls"]({
              threadId: ThreadIdSchema.parse(batch[0]!.threadId),
              assets: batch.map(({ path, variant }) => ({ path, variant })),
            });
            if (result.ok) values = result.data.assets;
          } catch {
            /* A failed call is not an answer: the next render asks again. */
          }
          let changed = false;
          batch.forEach((entry, index) => {
            entry.asking = false;
            const value = values?.[index];
            // Only the Host's answer is remembered; a failed call is asked again.
            if (value) {
              if (!sameAsset(entry.value, value)) {
                changed = true;
                // A new address deserves its own load attempt.
                entry.loadRetried = false;
              }
              entry.value = value;
              entry.confirmedAt = Date.now();
            }
            entry.resolve?.(value ?? unavailable);
            delete entry.pending;
            delete entry.resolve;
          });
          if (changed) this.#emit();
        }
      }),
    );
  }
  dispose() {
    this.#disposed = true;
    this.#release?.();
    for (const entry of this.#entries.values()) entry.resolve?.(unavailable);
    this.#entries.clear();
    this.#listeners.clear();
  }
}

function sameAsset(left: AssetUrl | undefined, right: AssetUrl): boolean {
  if (!left || left.status !== right.status) return false;
  return left.status === "ok" && right.status === "ok"
    ? left.url === right.url
    : left.status === "unavailable" &&
        right.status === "unavailable" &&
        left.reason === right.reason;
}
