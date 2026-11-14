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
  loadRetried?: boolean;
  pending?: Promise<AssetUrl>;
  resolve?: (value: AssetUrl) => void;
  timer?: ReturnType<typeof setTimeout>;
};
const unavailable: AssetUrl = { status: "unavailable", reason: "missing" };
const margin = 5 * 60_000;

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
    if (entry.pending) return entry.pending;
    if (
      !refresh &&
      entry.value &&
      (entry.value.status !== "ok" || Date.parse(entry.value.expiresAt) - Date.now() > margin)
    )
      return Promise.resolve(entry.value);
    entry.pending = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.#queue.add(entry);
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        void this.#flush();
      });
    }
    return entry.pending;
  }
  refreshReference(deploymentId: string, threadId: string, path: string) {
    for (const entry of this.#entries.values())
      if (
        entry.deploymentId === deploymentId &&
        entry.threadId === threadId &&
        entry.path === path
      ) {
        entry.loadRetried = false;
        void this.get(deploymentId, threadId, path, entry.variant, true);
      }
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
      if (entry.timer) clearTimeout(entry.timer);
      this.#emit();
      return false;
    }
    entry.loadRetried = true;
    delete entry.value;
    return (await this.get(deploymentId, threadId, path, variant, true)).status === "ok";
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
          let values: readonly AssetUrl[] = [];
          try {
            const result = await this.rpc["asset.urls"]({
              threadId: ThreadIdSchema.parse(batch[0]!.threadId),
              assets: batch.map(({ path, variant }) => ({ path, variant })),
            });
            if (result.ok) values = result.data.assets;
          } catch {
            /* Unreachable images keep the transcript readable. */
          }
          batch.forEach((entry, index) => {
            const value = values[index] ?? unavailable;
            entry.value = value;
            entry.resolve?.(value);
            delete entry.pending;
            delete entry.resolve;
            if (entry.timer) clearTimeout(entry.timer);
            if (!this.#disposed && value.status === "ok")
              entry.timer = setTimeout(
                () => {
                  void this.get(
                    entry.deploymentId,
                    entry.threadId,
                    entry.path,
                    entry.variant,
                    true,
                  );
                },
                Math.max(1000, Date.parse(value.expiresAt) - Date.now() - margin),
              );
          });
          this.#emit();
        }
      }),
    );
  }
  dispose() {
    this.#disposed = true;
    this.#release?.();
    for (const entry of this.#entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve?.(unavailable);
    }
    this.#entries.clear();
    this.#listeners.clear();
  }
}
