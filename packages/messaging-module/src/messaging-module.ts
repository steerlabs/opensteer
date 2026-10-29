import type {
  ChannelAdapter,
  ChannelProvider,
  ChannelRuntimeCapability,
} from "@opensteer/channel-core";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { ChannelAdapterRegistry } from "./adapter-registry.js";
import { ChannelConnectionSupervisor } from "./connection-supervisor.js";
import { ChannelDeliveryWorker } from "./delivery-worker.js";
import { MessagingFrameRouter, RoutedChannelHostClient } from "./host-client.js";

/**
 * The `messaging` module of any Runner: the provider adapters it carries, the
 * sessions the Host assigns it, and the deliveries it claims, all over one
 * fenced module stream. The Deployment's messaging service runs one, and so
 * does a Mac whose Runner carries a transport only that Mac can hold.
 */
export class MessagingModule {
  readonly #adapters: ChannelAdapterRegistry;
  readonly #connections: ChannelConnectionSupervisor;
  readonly #router = new MessagingFrameRouter();
  readonly #worker: ChannelDeliveryWorker;
  #stream: { readonly stop: AbortController; readonly stream: RunnerModuleStream } | undefined;

  constructor(adapters: readonly ChannelAdapter[]) {
    this.#adapters = new ChannelAdapterRegistry(adapters);
    const host = new RoutedChannelHostClient(this.#router);
    this.#connections = new ChannelConnectionSupervisor(host, this.#adapters);
    this.#worker = new ChannelDeliveryWorker(host, this.#adapters);
    this.#router.setHandler((request, context) => this.#connections.handle(request, context));
    this.#worker.start();
  }

  /** Whether a module stream is attached now. */
  get attached(): boolean {
    return this.#router.attached;
  }

  capabilities(): readonly ChannelRuntimeCapability[] {
    return this.#adapters.capabilities();
  }

  providers(): readonly ChannelProvider[] {
    return this.#adapters.providers();
  }

  async attach(stream: RunnerModuleStream): Promise<void> {
    const generation = this.#router.attach(stream);
    this.#stream = { stop: new AbortController(), stream };
    try {
      await this.#connections.opened(generation);
    } catch (error) {
      this.#router.detach(new Error("The messaging module stream could not open"), stream);
      throw error;
    }
    this.#worker.resume();
  }

  async detach(): Promise<void> {
    const generation = this.#router.generation;
    this.#stream?.stop.abort(new Error("The messaging module stream closed"));
    this.#stream = undefined;
    this.#router.detach(new Error("The messaging module stream closed"));
    await this.#worker.pause();
    await this.#connections.disconnected(generation);
  }

  /** `signal` ends with the stream; a caller that has none gets the attach's own. */
  async handleFrame(frame: Buffer, isBinary: boolean, signal?: AbortSignal): Promise<void> {
    const current = signal ?? this.#stream?.stop.signal;
    if (!current) return;
    await this.#router.handleFrame(frame, isBinary, current);
  }

  async close(): Promise<void> {
    await this.#connections.close();
    await this.#worker.close();
    this.#stream?.stop.abort(new Error("The messaging module is stopping"));
    this.#router.detach(new Error("The messaging module is stopping"));
  }
}
