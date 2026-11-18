// @vitest-environment happy-dom

import type { BrowserFrameView, BrowserWatchState, HostClient } from "@opensteer/client/host";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useFreshPicture } from "./fresh-picture.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A viewer whose feed goes live on receipt, as the Host session client's does. */
function viewer() {
  let state: BrowserWatchState = { frame: null, status: "connecting", error: null };
  let frame: BrowserFrameView | null = null;
  const frames = new Set<() => void>();
  const statuses = new Set<() => void>();
  const client = {
    browserFrames: {
      get: () => frame,
      subscribe: (_session: string, listener: () => void) => {
        frames.add(listener);
        return () => frames.delete(listener);
      },
    },
    browserViewerState: () => state,
    subscribeBrowserViewer: (_session: string, _surface: string, listener: () => void) => {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
  } as unknown as HostClient;
  const picture = (token: string): BrowserFrameView =>
    ({ data: new ArrayBuffer(0), header: { frameId: 1, watchToken: token } }) as never;
  return {
    client,
    picture,
    connect(admissionId: string) {
      state = { ...state, admissionId, status: "connecting" };
      for (const listener of statuses) listener();
    },
    receive(token: string) {
      frame = picture(token);
      const changed = state.status !== "live";
      state = { ...state, status: "live" };
      if (changed) for (const listener of statuses) listener();
      for (const listener of frames) listener();
      return frame;
    },
  };
}

describe("useFreshPicture", () => {
  // The cover over the last picture lifted when the reconnected viewer
  // received a frame, while its decode was still pending and the canvas
  // still held the old page.
  it("keeps the last picture covered until a picture from this connection is drawn", async () => {
    const feed = viewer();
    let seen: ReturnType<typeof useFreshPicture> | null = null;
    function Probe() {
      const state = feed.client.browserViewerState("bsn_1", "tab_1");
      seen = useFreshPicture(feed.client, "bsn_1", "tab_1", state);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const rerender = () => act(() => root.render(<Probe />));
    rerender();
    feed.connect("first");
    const first = feed.receive("one");
    rerender();
    act(() => seen!.presented(first));
    expect(seen!.fresh).toBe(true);

    feed.connect("second");
    rerender();
    expect(seen!.fresh).toBe(false);
    const second = feed.receive("two");
    rerender();
    // Received and live, but the decode is still pending: the old picture is on screen.
    expect(seen!.fresh).toBe(false);
    // The old picture finishing late belongs to the connection that went away.
    act(() => seen!.presented(first));
    expect(seen!.fresh).toBe(false);
    act(() => seen!.presented(second));
    expect(seen!.fresh).toBe(true);
    act(() => root.unmount());
  });
});
