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
  };
  const presented = vi.fn();
  const detach = attachBrowserCanvas(source, "browser-a", surfaceId, true, canvas, presented);
  try {
    for (let step = 0; step < 6; step++) await Promise.resolve();
    const due = [...paints.values()];
    paints.clear();
    for (const paint of due) paint(0);
    expect(presented).toHaveBeenLastCalledWith(frame);
    const replay = { ...frame, header: { ...frame.header, watchToken: "reconnected-socket" } };
    frame = replay;
    listeners.forEach((listener) => listener());
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
