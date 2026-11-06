import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import type { BrowserFrameStore, BrowserFrameView } from "./client.js";
import { getBrowserLastPicture, rememberBrowserLastPicture } from "./browser-last-picture.js";

function setup() {
  const listeners = new Map<string, Set<() => void>>();
  const versions = new Map<string, number>();
  const frames: BrowserFrameStore = {
    get: () => null,
    invalidationKey: (_session, tab = "") => versions.get(tab) ?? 0,
    subscribe: (_session, listener, tab = "") => {
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
    revoke(tab: string) {
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
    expect(listeners.get(tab(2))?.size).toBe(0);
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
    expect(listeners.get(tab(1))?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "new-session", tab(2))).toBeNull();
    expect(listeners.get(tab(2))?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "session", tab(2))).toBeNull();
  });
});
