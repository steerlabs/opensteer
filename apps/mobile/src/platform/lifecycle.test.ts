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

  it("coalesces an unchanged foreground reread but forwards a handover", async () => {
    const appState = new FakeAppState();
    const network = new FakeNetwork();
    network.reading = { type: "WIFI", isConnected: true, isInternetReachable: true };
    const lifecycle = createMobileLifecycle({ appState, network });
    await settle();
    const seen: string[] = [];
    lifecycle.onNetworkChange((state) => seen.push(state));
    appState.change("background");
    appState.change("active");
    await settle();
    expect(seen).toEqual([]);
    network.emit({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
    expect(seen).toEqual(["online"]);
    // The phone moved back to Wi-Fi while suspended, with nothing delivered.
    appState.change("background");
    network.reading = { type: "WIFI", isConnected: true, isInternetReachable: true };
    appState.change("active");
    await settle();
    expect(seen).toEqual(["online", "online"]);
    lifecycle.dispose();
  });

  it("forwards every network notification, saying which ones the phone saw move", () => {
    // A Wi-Fi to cellular handover reports `online` on both sides and invalidates
    // every socket, while a repeat leaves them working unless the phone moved
    // between two Wi-Fi networks, so the client has to see both and tell them apart.
    const network = new FakeNetwork();
    const lifecycle = createMobileLifecycle({ appState: new FakeAppState(), network });
    const seen: string[] = [];
    lifecycle.onNetworkChange((state, path) => seen.push(`${state} ${path}`));

    const wifi = { isConnected: true, isInternetReachable: true, type: "WIFI" };
    network.emit(wifi);
    network.emit(wifi);
    network.emit({ ...wifi, type: "CELLULAR" });
    network.emit({ isConnected: false, type: "NONE" });
    network.emit({ isConnected: false, type: "NONE" });

    expect(seen).toEqual([
      "online changed",
      "online same",
      "online changed",
      "offline changed",
      "offline same",
    ]);
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
