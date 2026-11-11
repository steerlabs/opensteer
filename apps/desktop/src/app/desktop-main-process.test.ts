import { describe, expect, it, vi } from "vitest";
import {
  DesktopMainProcess,
  type DesktopWindowFactory,
  type DesktopWindowHandle,
} from "./desktop-main-process.js";

describe("DesktopMainProcess", () => {
  it("shows and focuses the startup window during loading with concurrent activations", async () => {
    const calls: string[] = [];
    const window = new TestWindow(calls);
    let finishLoading!: () => void;
    const loaded = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const windows = { create: vi.fn(() => ({ window, loaded })) };
    const main = new DesktopMainProcess({
      services: { start: async () => undefined, stop: async () => undefined },
      windows,
    });

    const starting = main.start({ openWindow: false });
    const activations = [main.activate(), main.activate()];
    try {
      expect(windows.create).toHaveBeenCalledOnce();
      expect(windows.create).toHaveBeenCalledWith(expect.any(Function), { show: false });
      expect(calls).toEqual(["window.show", "window.focus", "window.show", "window.focus"]);
      calls.length = 0;
      main.focus();
      expect(calls).toEqual(["window.show", "window.focus"]);
    } finally {
      finishLoading();
      await Promise.all([starting, ...activations]);
      await main.stop();
    }
    expect(calls).toContain("window.show");
    expect(calls).toContain("window.focus");
    expect(window.isDestroyed()).toBe(true);
  });

  it("stays hidden after shutdown, even for a window still loading or a pending link", async () => {
    const calls: string[] = [];
    let finishLoading!: () => void;
    const loaded = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const window = new TestWindow(calls);
    const main = new DesktopMainProcess({
      services: { start: async () => undefined, stop: async () => undefined },
      windows: { create: () => ({ window, loaded }) },
    });

    const starting = main.start();
    main.hideWindow();
    main.focus();
    await main.activate();
    expect(calls).toEqual(["window.hide"]);
    finishLoading();
    await starting;
    main.focus();
    await main.activate();

    expect(calls).toEqual(["window.hide"]);
    await main.stop();
  });

  it("opens the shell before optional services, recreates a closed window, and stops once", async () => {
    const calls: string[] = [];
    const onWindowClosed = vi.fn();
    let onClosed: (() => void) | undefined;
    const handles: TestWindow[] = [];
    const windows: DesktopWindowFactory = {
      create: (closed) => {
        calls.push("window.create");
        onClosed = closed;
        const handle = new TestWindow(calls);
        handles.push(handle);
        return { window: handle, loaded: Promise.resolve() };
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
      windows: { create: () => ({ window, loaded: Promise.resolve() }) },
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
    const windows = { create: vi.fn(() => ({ window, loaded: Promise.resolve() })) };
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
      windows: {
        create: () => ({
          window: new TestWindow([]),
          loaded: Promise.reject(new Error("Host page failed")),
        }),
      },
    });
    await expect(main.start()).rejects.toThrow("Host page failed");
    expect(services.start).not.toHaveBeenCalled();
    expect(services.stop).not.toHaveBeenCalled();
  });

  it("clears a failed loading window and allows the next activation to recreate it", async () => {
    const calls: string[] = [];
    const onWindowClosed = vi.fn();
    const failure = new Error("Host page failed");
    let failLoading!: (error: Error) => void;
    const loaded = new Promise<void>((_resolve, reject) => {
      failLoading = reject;
    });
    let closed: (() => void) | undefined;
    const first = new TestWindow(calls);
    const failed = new TestWindow(calls);
    const replacement = new TestWindow(calls);
    const windows = {
      create: vi
        .fn()
        .mockImplementationOnce((onClosed: () => void) => {
          closed = onClosed;
          return { window: first, loaded: Promise.resolve() };
        })
        .mockImplementationOnce((onClosed: () => void) => ({
          window: failed,
          loaded: loaded.catch((error: unknown) => {
            failed.destroy();
            onClosed();
            throw error;
          }),
        }))
        .mockReturnValueOnce({ window: replacement, loaded: Promise.resolve() }),
    };
    const main = new DesktopMainProcess({
      onWindowClosed,
      windows,
      services: { start: async () => undefined, stop: async () => undefined },
    });
    await main.start();
    first.markClosed();
    closed?.();
    const activating = main.activate();
    failLoading(failure);
    await expect(activating).rejects.toBe(failure);
    expect(failed.isDestroyed()).toBe(true);
    expect(onWindowClosed).toHaveBeenCalledTimes(2);
    await main.activate();
    expect(windows.create).toHaveBeenCalledTimes(3);
    expect(replacement.isDestroyed()).toBe(false);
    await main.stop();
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
      windows: { create: () => ({ window, loaded: Promise.resolve() }) },
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

  hide(): void {
    this.#calls.push("window.hide");
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
