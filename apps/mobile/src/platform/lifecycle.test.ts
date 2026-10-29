import { describe, expect, it } from "vitest";
import {
  createMobileLifecycle,
  networkStateOf,
  type AppStateLike,
  type NetworkReading,
  type NetworkSource,
} from "./lifecycle.js";

class FakeAppState implements AppStateLike {
  currentState: string | null = "active";
  #listeners = new Set<(state: string) => void>();

  addEventListener(_type: "change", listener: (state: string) => void): { remove(): void } {
    this.#listeners.add(listener);
    return { remove: () => this.#listeners.delete(listener) };
  }

  change(state: string): void {
    this.currentState = state;
    for (const listener of this.#listeners) listener(state);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

class FakeNetwork implements NetworkSource {
  reading: NetworkReading = { isConnected: true, isInternetReachable: true };
  reads = 0;
  #listeners = new Set<(reading: NetworkReading) => void>();

  addNetworkStateListener(listener: (reading: NetworkReading) => void): { remove(): void } {
    this.#listeners.add(listener);
    return { remove: () => this.#listeners.delete(listener) };
  }

  async getNetworkStateAsync(): Promise<NetworkReading> {
    this.reads += 1;
    return this.reading;
  }

  emit(reading: NetworkReading): void {
    this.reading = reading;
    for (const listener of this.#listeners) listener(reading);
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("networkStateOf", () => {
  it("reads an unreachable internet as offline even when a radio is connected", () => {
    expect(networkStateOf({ isConnected: true, isInternetReachable: false })).toBe("offline");
  });
});

describe("createMobileLifecycle", () => {
  it("treats only `active` as the foreground", async () => {
    const appState = new FakeAppState();
    const lifecycle = createMobileLifecycle({ appState, network: new FakeNetwork() });
    const seen: string[] = [];
    lifecycle.onBackground(() => seen.push("background"));
    lifecycle.onForeground(() => seen.push("foreground"));

    appState.change("inactive");
    appState.change("background");
    appState.change("active");

    expect(seen).toEqual(["background", "foreground"]);
    expect(lifecycle.getSnapshot().visibility).toBe("foreground");
    lifecycle.dispose();
  });

  it("re-reads the network on every return to the foreground", async () => {
    const appState = new FakeAppState();
    const network = new FakeNetwork();
    const lifecycle = createMobileLifecycle({ appState, network });
    await settle();

    appState.change("background");
    // The phone moved while the process was suspended and nothing was delivered.
    network.reading = { isConnected: false };
    appState.change("active");
    await settle();

    expect(network.reads).toBe(2);
    expect(lifecycle.getSnapshot().network).toBe("offline");
    lifecycle.dispose();
  });

  it("forwards every network notification, repeats included", () => {
    // A Wi-Fi to cellular handover reports `online` on both sides of the move
    // and still invalidates every open socket, so a repeat is a notification
    // the client has to see rather than one this adapter may drop.
    const network = new FakeNetwork();
    const lifecycle = createMobileLifecycle({ appState: new FakeAppState(), network });
    const seen: string[] = [];
    lifecycle.onNetworkChange((state) => seen.push(state));

    network.emit({ isConnected: true, isInternetReachable: true });
    network.emit({ isConnected: true, isInternetReachable: true });
    network.emit({ isConnected: false });
    network.emit({ isConnected: false });

    expect(seen).toEqual(["online", "online", "offline", "offline"]);
    expect(lifecycle.getSnapshot().network).toBe("offline");
    lifecycle.dispose();
  });

  it("releases every platform subscription it took", () => {
    const appState = new FakeAppState();
    const lifecycle = createMobileLifecycle({ appState, network: new FakeNetwork() });

    expect(appState.listenerCount).toBe(1);
    lifecycle.dispose();
    expect(appState.listenerCount).toBe(0);
  });

  it("reports a failed network read instead of swallowing it", async () => {
    const failures: unknown[] = [];
    const network = new FakeNetwork();
    network.getNetworkStateAsync = () => Promise.reject(new Error("no radio"));
    const lifecycle = createMobileLifecycle({
      appState: new FakeAppState(),
      network,
      onReadFailure: (error) => failures.push(error),
    });
    await settle();

    expect(failures).toHaveLength(1);
    expect(lifecycle.getSnapshot().network).toBe("unknown");
    lifecycle.dispose();
  });
});
