// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserFrameStore, BrowserFrameView } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { attachBrowserCanvas } from "./browser-presenter.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("reports a reconnected socket's replay of the already drawn picture as presented", async () => {
  const paints = new Map<number, FrameRequestCallback>();
  let requestId = 0;
  vi.stubGlobal("requestAnimationFrame", (paint: FrameRequestCallback) => {
    const id = ++requestId;
    paints.set(id, paint);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => paints.delete(id));
  const bitmap = { width: 800, height: 600, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const surfaceId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
  let frame: BrowserFrameView = {
    data: new Uint8Array([0xff, 0xd8, 0xff]),
    header: {
      encoding: "jpeg",
      frameId: 1,
      surfaceId,
      geometryRevision: 1,
      watchToken: "first-socket",
      viewportWidth: 800,
      viewportHeight: 600,
      rasterWidth: 800,
      rasterHeight: 600,
    },
  };
  const listeners = new Set<() => void>();
  const source: BrowserFrameStore = {
    get: () => frame,
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accept: vi.fn(),
    claim: vi.fn(),
  };
  const presented = vi.fn();
  const detach = attachBrowserCanvas(source, "browser-a", surfaceId, true, canvas, presented);
  try {
    expect(source.claim).toHaveBeenCalledWith("browser-a", surfaceId, "first-socket");
    expect(source.accept).not.toHaveBeenCalled();
    for (let step = 0; step < 6; step++) await Promise.resolve();
    const due = [...paints.values()];
    paints.clear();
    for (const paint of due) paint(0);
    expect(presented).toHaveBeenLastCalledWith(frame);
    const replay = { ...frame, header: { ...frame.header, watchToken: "reconnected-socket" } };
    frame = replay;
    listeners.forEach((listener) => listener());
    expect(source.claim).toHaveBeenLastCalledWith("browser-a", surfaceId, "reconnected-socket");
    expect(presented).toHaveBeenCalledTimes(2);
    expect(presented).toHaveBeenLastCalledWith(replay);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(source.accept).toHaveBeenLastCalledWith("browser-a", surfaceId, "reconnected-socket");
  } finally {
    detach();
    await Promise.resolve();
  }
});

it("leases the raster density each targeted pane displays and releases it on unmount", async () => {
  const paints = new Map<number, FrameRequestCallback>();
  let requestId = 0;
  vi.stubGlobal("requestAnimationFrame", (paint: FrameRequestCallback) => {
    const id = ++requestId;
    paints.set(id, paint);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => paints.delete(id));
  const paint = async () => {
    for (let step = 0; step < 6; step++) await Promise.resolve();
    const due = [...paints.values()];
    paints.clear();
    for (const callback of due) callback(0);
  };
  const resized = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #callback: () => void;
      constructor(callback: () => void) {
        this.#callback = callback;
      }
      observe() {
        resized.add(this.#callback);
      }
      disconnect() {
        resized.delete(this.#callback);
      }
    },
  );
  const ratioListeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_type: string, listener: () => void) => ratioListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => ratioListeners.delete(listener),
  }));
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal("createImageBitmap", async () => ({
    width: frame.header.rasterWidth,
    height: frame.header.rasterHeight,
    close: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const stage = document.createElement("div");
  const size = { width: 400, height: 300 };
  Object.defineProperty(stage, "clientWidth", { get: () => size.width });
  Object.defineProperty(stage, "clientHeight", { get: () => size.height });
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  document.body.append(stage);
  const surfaceId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000002");
  let frame: BrowserFrameView = {
    data: new Uint8Array([0xff, 0xd8, 0xff]),
    header: {
      encoding: "jpeg",
      frameId: 1,
      surfaceId,
      geometryRevision: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      rasterWidth: 1600,
      rasterHeight: 1200,
    },
  };
  const listeners = new Set<() => void>();
  const lease = { update: vi.fn(), release: vi.fn() };
  const source: BrowserFrameStore = {
    get: () => frame,
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rasterDemand: vi.fn(() => lease),
  };
  const detach = attachBrowserCanvas(source, "browser-b", surfaceId, true, canvas, vi.fn());
  expect(source.rasterDemand).toHaveBeenCalledWith("browser-b", surfaceId);
  // Unmeasured, the lease keeps asking for the densest raster.
  expect(lease.update).not.toHaveBeenCalled();
  await paint();
  // 400 CSS pixels at 2x show an 800 pixel wide page at density 1.
  expect(lease.update).toHaveBeenLastCalledWith(1);

  size.width = 600;
  size.height = 450;
  [...resized].forEach((callback) => callback());
  await paint();
  expect(lease.update).toHaveBeenLastCalledWith(1.5);

  vi.stubGlobal("devicePixelRatio", 1);
  [...ratioListeners].forEach((listener) => listener());
  expect(lease.update).toHaveBeenLastCalledWith(0.75);

  // A crop is measured against the region it shows, never enlarged past 1:1.
  frame = {
    ...frame,
    header: {
      ...frame.header,
      frameId: 2,
      capture: { width: 400, height: 300, revision: 1 },
      rasterWidth: 400,
      rasterHeight: 300,
    },
  };
  listeners.forEach((listener) => listener());
  await paint();
  expect(lease.update).toHaveBeenLastCalledWith(1);

  detach();
  await Promise.resolve();
  expect(lease.release).toHaveBeenCalledTimes(1);
  expect(resized.size).toBe(0);
  expect(ratioListeners.size).toBe(0);

  // The legacy session-wide stream has no exact target to state demand for.
  const legacy = attachBrowserCanvas(source, "browser-b", surfaceId, false, canvas, vi.fn());
  expect(source.rasterDemand).toHaveBeenCalledTimes(1);
  legacy();
  await Promise.resolve();
});
