import type {
  ChannelAdapter,
  ChannelProvider,
  ChannelRuntimeCapability,
  ChannelTransportKind,
} from "@opensteer/channel-core";

export class ChannelAdapterRegistry {
  readonly #adapters = new Map<ChannelProvider, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[]) {
    for (const adapter of adapters) {
      const provider = adapter.manifest.provider;
      if (this.#adapters.has(provider)) {
        throw new Error(`Channel adapter ${provider} was registered more than once`);
      }
      this.#adapters.set(provider, adapter);
    }
    if (this.#adapters.size === 0) throw new Error("Messaging service has no adapters");
  }

  get(provider: ChannelProvider, transportKind?: ChannelTransportKind): ChannelAdapter | null {
    const adapter = this.#adapters.get(provider) ?? null;
    if (adapter && transportKind && !adapter.manifest.transportKinds.includes(transportKind)) {
      return null;
    }
    return adapter;
  }

  providers(): readonly ChannelProvider[] {
    return this.capabilities().map(({ provider }) => provider);
  }

  capabilities(): readonly ChannelRuntimeCapability[] {
    return [...this.#adapters.values()]
      .map((adapter) => ({
        manifest: adapter.manifest,
        provider: adapter.manifest.provider,
        transportKinds: adapter.manifest.transportKinds,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }
}
