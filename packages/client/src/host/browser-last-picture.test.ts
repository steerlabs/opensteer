import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import type { BrowserFrameStore, BrowserFrameView } from "./client.js";
import { getBrowserLastPicture, rememberBrowserLastPicture } from "./browser-last-picture.js";

function setup() {
  const listeners = new Map<string, Set<() => void>>();
  const versions = new Map<string, number>();
  const frames: BrowserFrameStore = {
    get: () => null,
    invalidationKey: (session, tab = "") => versions.get(`${session}:${tab}`) ?? 0,
    subscribe: (session, listener, tab = "") => {
      tab = `${session}:${tab}`;
      const current = listeners.get(tab) ?? new Set();
      listeners.set(tab, current);
      current.add(listener);
      return () => {
        current.delete(listener);
      };
    },
  };
  const remember = (tab: string, session = "session") => {
    const frame: BrowserFrameView = {
      data: new Uint8Array([Number(tab.at(-1))]),
      header: {
        surfaceId: BrowserSurfaceIdSchema.parse(tab),
        frameId: 1,
        encoding: "jpeg",
        rasterWidth: 1,
        rasterHeight: 1,
        viewportWidth: 1,
        viewportHeight: 1,
      },
    };
    rememberBrowserLastPicture(frames, session, tab, frame);
    return frame;
  };
  return {
    frames,
    remember,
    listeners,
    revoke(tab: string, session = "session") {
      tab = `${session}:${tab}`;
      versions.set(tab, (versions.get(tab) ?? 0) + 1);
      for (const listener of listeners.get(tab) ?? []) listener();
    },
  };
}
const tab = (n: number) => `srf_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("last presented browser pictures", () => {
  it("bounds pictures and invalidation listeners to four recently used tabs", () => {
    const { frames, remember, listeners } = setup();
    for (let n = 1; n <= 4; n++) remember(tab(n));
    expect(getBrowserLastPicture(frames, "session", tab(1))).not.toBeNull();
    remember(tab(5));
    expect(getBrowserLastPicture(frames, "session", tab(2))).toBeNull();
    expect(listeners.get(`session:${tab(2)}`)?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "session", tab(1))).not.toBeNull();
  });

  it("forgets a closed or revoked tab even without a mounted presenter and isolates readers and sessions", () => {
    const { frames, remember, revoke, listeners } = setup();
    const a = remember(tab(1));
    remember(tab(2));
    expect(getBrowserLastPicture(frames, "session", tab(1))?.frame).toBe(a);
    expect(getBrowserLastPicture(setup().frames, "session", tab(1))).toBeNull();
    revoke(tab(1));
    expect(getBrowserLastPicture(frames, "session", tab(1))).toBeNull();
    expect(listeners.get(`session:${tab(1)}`)?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "new-session", tab(2))).toBeNull();
    expect(listeners.get(`session:${tab(2)}`)?.size).toBe(1);
    expect(getBrowserLastPicture(frames, "session", tab(2))).not.toBeNull();
  });

  it("shares one LRU across interleaved sessions and invalidates only the matching entry", () => {
    const { frames, remember, revoke, listeners } = setup();
    const a = remember(tab(1), "A");
    const b = remember(tab(1), "B");
    expect(getBrowserLastPicture(frames, "A", tab(1))?.frame).toBe(a);
    expect(getBrowserLastPicture(frames, "B", tab(1))?.frame).toBe(b);
    expect(getBrowserLastPicture(frames, "A", tab(2))).toBeNull();
    remember(tab(2), "A");
    const b2 = remember(tab(2), "B");
    expect(getBrowserLastPicture(frames, "A", tab(1))?.frame).toBe(a);
    remember(tab(3), "B");
    expect(getBrowserLastPicture(frames, "B", tab(1))).toBeNull();
    expect(listeners.get(`B:${tab(1)}`)?.size).toBe(0);
    revoke(tab(2), "A");
    expect(getBrowserLastPicture(frames, "A", tab(2))).toBeNull();
    expect(listeners.get(`A:${tab(2)}`)?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "B", tab(2))?.frame).toBe(b2);
    expect(getBrowserLastPicture(frames, "A", tab(1))?.frame).toBe(a);
  });
});
