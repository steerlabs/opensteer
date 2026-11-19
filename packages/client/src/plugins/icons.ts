import { pluginIconsMaxRefs } from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

interface Icon {
  /** Undefined until a read answers; null when the last read gave no image. */
  image: string | null | undefined;
  reading: boolean;
  /** Asked for again while a read was out, as after a reconnect: read again if it gives none. */
  again: boolean;
  readonly listeners: Set<() => void>;
}

/** Images kept past the rows showing them, so a list scrolled back shows them at once. */
const kept = 1_024;

/**
 * Plugin icons read from one Host and shared by every row that shows them. A
 * ref names the same image for good, so an image is read once per client;
 * refs asked for in the same turn are read together, a page of rows per read.
 * A read that gave no image, because the Host had none or did not answer, is
 * asked again when a row next mounts or the connection comes back.
 */
export class PluginIcons {
  readonly #host: Pick<HostClient, "rpc">;
  readonly #icons = new Map<string, Icon>();
  readonly #queued = new Set<string>();

  constructor(host: Pick<HostClient, "rpc">) {
    this.#host = host;
  }

  image(ref: string): string | null | undefined {
    return this.#icons.get(ref)?.image;
  }

  subscribe(ref: string, listener: () => void): () => void {
    const icon = this.#icon(ref);
    icon.listeners.add(listener);
    return () => {
      icon.listeners.delete(listener);
      if (!icon.listeners.size && icon.image === null && !icon.reading) this.#icons.delete(ref);
    };
  }

  /** Reads the ref with the others asked for this turn, unless it is read or being read. */
  request(ref: string): void {
    const icon = this.#icon(ref);
    if (typeof icon.image === "string") return;
    if (icon.reading) {
      if (!this.#queued.has(ref)) icon.again = true;
      return;
    }
    icon.reading = true;
    if (!this.#queued.size) queueMicrotask(() => this.#flush());
    this.#queued.add(ref);
  }

  #icon(ref: string): Icon {
    let icon = this.#icons.get(ref);
    if (!icon) {
      icon = { image: undefined, reading: false, again: false, listeners: new Set() };
      this.#icons.set(ref, icon);
      if (this.#icons.size > kept)
        for (const [old, value] of this.#icons) {
          if (this.#icons.size <= kept) break;
          if (old !== ref && !value.listeners.size && !value.reading) this.#icons.delete(old);
        }
    }
    return icon;
  }

  #flush(): void {
    const refs = [...this.#queued];
    this.#queued.clear();
    for (let start = 0; start < refs.length; start += pluginIconsMaxRefs) {
      const batch = refs.slice(start, start + pluginIconsMaxRefs);
      // A read settles only the entries it was sent for, never ones made since.
      const reading = batch.map((ref) => [ref, this.#icons.get(ref)] as const);
      void this.#host.rpc["plugins.icons.get"]({ refs: batch })
        .then(unwrapRpcResult)
        .then(
          ({ icons }) => {
            const images = new Map(icons.map(({ ref, image }) => [ref, image]));
            for (const [ref, icon] of reading) this.#settle(ref, icon, images.get(ref) ?? null);
          },
          () => {
            for (const [ref, icon] of reading) this.#settle(ref, icon, null);
          },
        );
    }
  }

  #settle(ref: string, icon: Icon | undefined, image: string | null): void {
    if (!icon || this.#icons.get(ref) !== icon) return;
    icon.reading = false;
    icon.image = image;
    const again = icon.again && image === null && icon.listeners.size > 0;
    icon.again = false;
    if (image === null && !icon.listeners.size) this.#icons.delete(ref);
    for (const listener of icon.listeners) listener();
    if (again) this.request(ref);
  }
}

const shared = new WeakMap<object, PluginIcons>();

/** The one icon cache for this Host client. */
export function pluginIcons(host: Pick<HostClient, "rpc">): PluginIcons {
  let icons = shared.get(host);
  if (!icons) shared.set(host, (icons = new PluginIcons(host)));
  return icons;
}
