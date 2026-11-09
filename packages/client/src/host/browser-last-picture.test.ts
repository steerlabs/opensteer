import { describe, expect, it } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import type { BrowserFrameStore, BrowserFrameView } from "./client.js";
import type { PlaceItem } from "./places.js";
import {
  browserTabPicture,
  getBrowserLastPicture,
  keepBrowserLastPictures,
  rememberBrowserLastPicture,
} from "./browser-last-picture.js";

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
  const remember = (tab: string, session = "session", bytes = 1) => {
    const frame: BrowserFrameView = {
      data: new Uint8Array(bytes).fill(Number(tab.at(-1))),
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
  it("bounds pictures and invalidation listeners to eight recently used tabs and 3 MiB", () => {
    const { frames, remember, listeners } = setup();
    for (let n = 1; n <= 8; n++) remember(tab(n));
    expect(getBrowserLastPicture(frames, "session", tab(1))).not.toBeNull();
    remember(tab(9));
    expect(getBrowserLastPicture(frames, "session", tab(2))).toBeNull();
    expect(listeners.get(`session:${tab(2)}`)?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "session", tab(1))).not.toBeNull();
    remember(tab(1), "large", 2 * 1024 * 1024);
    remember(tab(2), "large", 2 * 1024 * 1024);
    expect(getBrowserLastPicture(frames, "large", tab(1))).toBeNull();
    expect(getBrowserLastPicture(frames, "session", tab(3))).toBeNull();
    expect(getBrowserLastPicture(frames, "large", tab(2))).not.toBeNull();
  });

  it("answers a list row from what is kept, never streaming, requesting or reordering", () => {
    const watch = setup();
    const control = setup();
    for (let n = 1; n <= 8; n++) watch.remember(tab(n));
    control.remember(tab(9));
    const asked: string[] = [];
    const spy = (frames: BrowserFrameStore): BrowserFrameStore => ({
      ...frames,
      get: () => {
        asked.push("get");
        return null;
      },
      subscribe: () => {
        asked.push("subscribe");
        return () => undefined;
      },
      rasterDemand: () => {
        asked.push("rasterDemand");
        throw new Error("A row asked for pictures.");
      },
    });
    const client = { browserWatchFrames: watch.frames, browserFrames: control.frames };
    expect(browserTabPicture(client, "session", tab(1))).toMatchObject({ width: 1, height: 1 });
    expect(browserTabPicture(client, "session", tab(9))?.uri).toBe("data:image/jpeg;base64,CQ==");
    expect(browserTabPicture(client, "session", tab(10))).toBeNull();
    expect(
      browserTabPicture(
        { browserWatchFrames: spy(watch.frames), browserFrames: spy(control.frames) },
        "session",
        tab(10),
      ),
    ).toBeNull();
    expect(asked).toEqual([]);
    // Asking left tab 1 the oldest, so it is the one a new picture replaces.
    watch.remember(tab(11));
    expect(browserTabPicture(client, "session", tab(1))).toBeNull();
  });

  it("forgets a picture once its tab closes or loads another page", () => {
    const { frames, remember, listeners } = setup();
    const place = (n: number, documentId: string | null) =>
      ({
        destination: { kind: "browser", sessionId: "session", tabId: tab(n) },
        browser: { sessionId: "session", documentId },
      }) as unknown as PlaceItem;
    keepBrowserLastPictures(frames, [place(1, "d1"), place(2, "d2")]);
    remember(tab(1));
    remember(tab(2));
    keepBrowserLastPictures(frames, [place(1, "d1"), place(2, "d2")]);
    expect(getBrowserLastPicture(frames, "session", tab(1))).not.toBeNull();
    keepBrowserLastPictures(frames, [place(1, "d1b"), place(2, "d2")]);
    expect(getBrowserLastPicture(frames, "session", tab(1))).toBeNull();
    expect(listeners.get(`session:${tab(1)}`)?.size).toBe(0);
    keepBrowserLastPictures(frames, [place(1, "d1b")]);
    expect(getBrowserLastPicture(frames, "session", tab(2))).toBeNull();
    expect(listeners.get(`session:${tab(2)}`)?.size).toBe(0);
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
    for (let n = 3; n <= 7; n++) remember(tab(n), "B");
    expect(getBrowserLastPicture(frames, "B", tab(1))).toBeNull();
    expect(listeners.get(`B:${tab(1)}`)?.size).toBe(0);
    revoke(tab(2), "A");
    expect(getBrowserLastPicture(frames, "A", tab(2))).toBeNull();
    expect(listeners.get(`A:${tab(2)}`)?.size).toBe(0);
    expect(getBrowserLastPicture(frames, "B", tab(2))?.frame).toBe(b2);
    expect(getBrowserLastPicture(frames, "A", tab(1))?.frame).toBe(a);
  });
});
