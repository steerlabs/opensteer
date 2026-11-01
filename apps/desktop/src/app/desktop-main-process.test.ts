import { describe, expect, it, vi } from "vitest";
import {
  DesktopMainProcess,
  type DesktopWindowFactory,
  type DesktopWindowHandle,
} from "./desktop-main-process.js";

describe("DesktopMainProcess", () => {
  it("opens the shell before optional services, recreates a closed window, and stops once", async () => {
    const calls: string[] = [];
    const onWindowClosed = vi.fn();
    let onClosed: (() => void) | undefined;
    const handles: TestWindow[] = [];
    const windows: DesktopWindowFactory = {
      create: async (closed) => {
        calls.push("window.create");
        onClosed = closed;
        const handle = new TestWindow(calls);
        handles.push(handle);
        return handle;
      },
    };
    const services = {
      start: vi.fn(async () => {
        calls.push("services.start");
      }),
      stop: vi.fn(async () => {
        calls.push("services.stop");
      }),
    };
    const main = new DesktopMainProcess({ onWindowClosed, services, windows });

    await main.start();
    expect(calls).toEqual(["window.create", "services.start"]);
    handles[0]?.markClosed();
    onClosed?.();
    expect(onWindowClosed).toHaveBeenCalledOnce();
    await main.activate();
    expect(handles).toHaveLength(2);
    main.focus();
    expect(calls.slice(-2)).toEqual(["window.show", "window.focus"]);
    await Promise.all([main.stop(), main.stop()]);
    expect(services.stop).toHaveBeenCalledTimes(1);
    expect(calls.slice(-2)).toEqual(["services.stop", "window.destroy"]);
  });

  it("keeps the window alive and allows a retry when durable shutdown fails", async () => {
    const calls: string[] = [];
    const window = new TestWindow(calls);
    let attempts = 0;
    const main = new DesktopMainProcess({
      services: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("browser process shutdown failed");
        }),
      },
      windows: { create: async () => window },
    });
    await main.start();

    await expect(main.stop()).rejects.toThrow("browser process shutdown failed");
    expect(window.isDestroyed()).toBe(false);
    await expect(main.stop()).resolves.toBeUndefined();
    expect(window.isDestroyed()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("starts hidden with its window ready for notifications and shows it when activated", async () => {
    const calls: string[] = [];
    const window = new TestWindow(calls);
    const windows = { create: vi.fn(async () => window) };
    const services = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const main = new DesktopMainProcess({ services, windows });

    await main.start({ openWindow: false });

    expect(services.start).toHaveBeenCalledOnce();
    expect(windows.create).toHaveBeenCalledOnce();
    expect(windows.create).toHaveBeenCalledWith(expect.any(Function), { show: false });
    await main.activate();
    expect(windows.create).toHaveBeenCalledOnce();
    expect(calls).toEqual(["window.show", "window.focus"]);
    await main.stop();
  });

  it("does not start optional services if the first window cannot load", async () => {
    const services = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const main = new DesktopMainProcess({
      services,
      windows: { create: async () => Promise.reject(new Error("Host page failed")) },
    });
    await expect(main.start()).rejects.toThrow("Host page failed");
    expect(services.start).not.toHaveBeenCalled();
    expect(services.stop).not.toHaveBeenCalled();
  });

  it("keeps the shell open and reports optional service startup failures nonfatally", async () => {
    const onServiceError = vi.fn();
    const window = new TestWindow([]);
    const main = new DesktopMainProcess({
      onServiceError,
      services: {
        start: async () => Promise.reject(new Error("device enrollment unavailable")),
        stop: vi.fn(async () => undefined),
      },
      windows: { create: async () => window },
    });

    await expect(main.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onServiceError).toHaveBeenCalledOnce());
    expect(window.isDestroyed()).toBe(false);
    await main.stop();
  });
});

class TestWindow implements DesktopWindowHandle {
  readonly #calls: string[];
  #destroyed = false;

  constructor(calls: string[]) {
    this.#calls = calls;
  }

  destroy(): void {
    this.#calls.push("window.destroy");
    this.#destroyed = true;
  }

  focus(): void {
    this.#calls.push("window.focus");
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  markClosed(): void {
    this.#destroyed = true;
  }

  show(): void {
    this.#calls.push("window.show");
  }
}
