// @vitest-environment happy-dom

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  GestureResponderEvent,
  PanResponderCallbacks,
  PanResponderGestureState,
} from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserFrameView,
  BrowserSessionSummary,
} from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, TargetedBrowserClientMessageSchema } from "@opensteer/protocol";
import type { PictureMetadata, PictureOutcome } from "../computers/phone-display-native.js";
import { BrowserStream, type BrowserStreamProps } from "./browser-stream.js";

const native = vi.hoisted(() => ({
  gestures: null as PanResponderCallbacks | null,
  /** The stage's frame, as its view lays out: a fold or resize changes it under a finger. */
  layout: { height: 600, width: 400, x: 0, y: 0 },
  /** The surface's arrangement, as the pane the stream is drawn in reports it. */
  geometry: "side:page@0",
  /** Which presenter the installed binary offers: Image data URIs, or the native picture view. */
  presenter: "image" as "image" | "picture",
  /** The native picture view's pending presentations and the generation it last cleared to. */
  presented: [] as {
    bytes: Uint8Array;
    metadata: PictureMetadata;
    settle: (outcome: PictureOutcome) => void;
  }[],
  generation: -1,
  cleared: null as null | ((event: { nativeEvent: { generation: number } }) => void),
  renders: 0,
}));
vi.mock("../ui/pane.js", () => ({ usePaneGeometry: () => native.geometry }));
vi.mock("../computers/phone-display-native.js", async () => {
  const React = await import("react");
  const Picture = React.forwardRef(
    (
      props: {
        accessibilityLabel?: string;
        onCleared?: (event: { nativeEvent: { generation: number } }) => void;
      },
      ref,
    ) => {
      native.cleared = props.onCleared ?? null;
      native.renders++;
      React.useImperativeHandle(ref, () => ({
        clear: async (generation: number) => {
          native.generation = generation;
          for (const { settle } of native.presented.splice(0)) settle("dropped");
        },
        present: (bytes: Uint8Array, metadata: PictureMetadata) =>
          new Promise<PictureOutcome>((settle) => {
            if (metadata.generation !== native.generation) settle("dropped");
            else native.presented.push({ bytes, metadata, settle });
          }),
      }));
      // Something is on screen exactly while the view says what it shows.
      return props.accessibilityLabel ? <img alt={props.accessibilityLabel} /> : null;
    },
  );
  return { nativePictureView: () => (native.presenter === "picture" ? Picture : null) };
});

vi.mock("react-native", () => ({
  Image: ({
    accessibilityLabel,
    onError,
    onLoad,
    source,
  }: {
    accessibilityLabel?: string;
    onError: () => void;
    onLoad: () => void;
    source: { uri: string };
  }) => <img alt={accessibilityLabel ?? ""} onError={onError} onLoad={onLoad} src={source.uri} />,
  PixelRatio: { get: () => 2 },
  PanResponder: {
    create: (gestures: PanResponderCallbacks) => {
      native.gestures = gestures;
      return { panHandlers: {} };
    },
  },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  StyleSheet: { create: (styles: object) => styles },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: {
      nativeEvent: { layout: { width: number; height: number; x: number; y: number } };
    }) => void;
  }) => {
    const { height, width, x, y } = native.layout;
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { height, width, x, y } } });
    }, [height, onLayout, width, x, y]);
    return <div>{children}</div>;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  native.gestures = null;
  native.layout = { height: 600, width: 400, x: 0, y: 0 };
  native.geometry = "side:page@0";
  native.presenter = "image";
  native.presented = [];
  native.generation = -1;
  native.cleared = null;
  native.renders = 0;
  document.body.replaceChildren();
});

const surfaceId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
function session(viewerState: BrowserSessionSummary["viewerState"]): BrowserSessionSummary {
  return {
    access: "full-control",
    attachedRunIds: [],
    dialog: null,
    error: null,
    id: "bsn_00000000-0000-4000-8000-000000000001",
    origin: "agent",
    placement: { kind: "runner", runnerId: "runner-a" },
    profileId: null,
    runtimeId: "runtime-a",
    state: "ready",
    tabs: [{ active: true, id: surfaceId, title: "A page", url: "https://example.com" }],
    viewerError: null,
    viewerState,
    watchViewerError: null,
    watchViewerState: "synchronized",
    workspaceId: "workspace-a",
  };
}
function frame(): BrowserFrameView {
  return {
    data: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
    header: {
      encoding: "jpeg",
      watchToken: "00000000-0000-4000-8000-000000000001",
      frameId: 1,
      geometryRevision: 7,
      rasterHeight: 600,
      rasterWidth: 800,
      surfaceId,
      viewportHeight: 600,
      viewportWidth: 800,
    },
  };
}
function setup(interactive = true) {
  let picture: BrowserFrameView | null = null;
  let streaming = false;
  let feed = {
    frame: null as BrowserFrameView | null,
    error: null,
    status: "connecting" as "connecting" | "live",
  };
  let watch = { frame: null as BrowserFrameView | null, error: null, status: "live" as const };
  const listeners = new Set<() => void>();
  const demand = { update: vi.fn(), release: vi.fn() };
  const rasterDemand = vi.fn(() => demand);
  const frames: BrowserFrameStore = {
    rasterDemand,
    get: vi.fn(() => picture),
    subscribe: vi.fn((_sessionId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const viewerRelease = vi.fn();
  const watchRelease = vi.fn();
  const onTap = vi.fn();
  // Refuses exactly as the targeted control does: a dropped feed, then the wire
  // contract. A cancel is cleanup, which a dropped feed never refuses.
  let taken = Number.POSITIVE_INFINITY;
  const send = vi.fn((_sessionId: string, command: BrowserCommand) => {
    if (command.type !== "input.cancel" && taken-- <= 0)
      throw new Error("The targeted browser control is not synchronized.");
    TargetedBrowserClientMessageSchema.parse(command);
    if (command.type === "stream.subscribe") streaming = true;
    if (command.type === "stream.unsubscribe") streaming = false;
  });
  /** The feed goes away after the page takes `after` more commands. */
  const dropFeed = (after = 0) => {
    taken = after;
  };
  const hostClient: BrowserStreamProps["hostClient"] = {
    acceptBrowserWatchFrame: vi.fn(),
    browserFrames: frames,
    browserWatchFrames: frames,
    retainBrowserViewer: vi.fn(() => {
      streaming = true;
      return viewerRelease;
    }),
    retainBrowserWatch: vi.fn(() => watchRelease),
    sendBrowserCommand: send,
    browserViewerState: () => feed,
    browserWatchState: () => watch,
    subscribeBrowserWatch: (_sessionId, _tabId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (viewerState: BrowserSessionSummary["viewerState"], active = true) =>
    act(() => {
      feed = { ...feed, status: viewerState === "synchronized" ? "live" : "connecting" };
      root?.render(
        <BrowserStream
          active={active}
          hostClient={hostClient}
          interactive={interactive}
          label="A page, example.com"
          onTap={onTap}
          session={session(viewerState)}
          tabId={surfaceId}
        />,
      );
    });
  const emit = (target = surfaceId, header: Partial<BrowserFrameView["header"]> = {}) =>
    act(() => {
      if (!streaming && interactive) return;
      picture = { ...frame(), header: { ...frame().header, surfaceId: target, ...header } };
      feed = { ...feed, frame: picture };
      watch = { ...watch, frame: picture };
      for (const listener of listeners) listener();
    });
  /** The view finishes decoding the newest picture it holds, and draws it. */
  const decode = async (outcome: PictureOutcome = "presented") => {
    if (native.presenter === "image")
      return act(() => {
        const image = [...container.querySelectorAll("img")].at(-1);
        if (!image) throw new Error("The subscribed stream did not deliver an image.");
        image.dispatchEvent(new Event(outcome === "presented" ? "load" : "error"));
      });
    await act(async () => {
      const picture = native.presented.shift();
      if (!picture) throw new Error("The subscribed stream did not deliver a picture.");
      picture.settle(outcome);
    });
  };
  return {
    container,
    demand,
    rasterDemand,
    decode,
    dropFeed,
    emit,
    hostClient,
    onTap,
    render,
    send,
    viewerRelease,
    watchRelease,
  };
}

const sessionId = session("synchronized").id;
const tapPoint = {
  geometryRevision: 7,
  modifiers: [],
  surfaceId,
  viewportHeight: 600,
  viewportWidth: 800,
  x: 0.5,
  y: 0.5,
};
function touch(x: number, y: number, dx = 0, dy = 0) {
  return {
    event: { nativeEvent: { locationX: x, locationY: y } } as GestureResponderEvent,
    gesture: { dx, dy } as PanResponderGestureState,
  };
}

describe.each(["image", "picture"] as const)(
  "mobile browser stream lifecycle (%s)",
  (presenter) => {
    beforeEach(() => {
      native.presenter = presenter;
    });

    it("matches raster detail to its pane without retaking the feed, and releases it on hide", async () => {
      const { demand, rasterDemand, decode, emit, hostClient, render, send } = setup();
      render("synchronized");
      expect(rasterDemand).toHaveBeenCalledExactlyOnceWith(sessionId, surfaceId);
      expect(demand.update).toHaveBeenLastCalledWith(2);
      emit();
      await decode();
      expect(demand.update).toHaveBeenLastCalledWith(1);
      native.layout = { height: 450, width: 300, x: 0, y: 0 };
      render("synchronized");
      expect(demand.update).toHaveBeenLastCalledWith(0.75);
      native.layout = { height: 600, width: 800, x: 0, y: 0 };
      render("synchronized");
      expect(demand.update).toHaveBeenLastCalledWith(2);
      expect(hostClient.retainBrowserViewer).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      render("synchronized", false);
      expect(demand.release).toHaveBeenCalledTimes(1);
    });

    it("waits for synchronization, shows a requested frame, and maps a page tap", async () => {
      const { container, decode, emit, render, send } = setup();
      render("connecting");
      expect(send).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Connecting…");
      render("synchronized");
      emit();
      await decode();
      // The picture says nothing over itself: whether an agent acts is the page's bar to show.
      expect(container.textContent).toBe("");
      expect(container.querySelector('img[alt="A page, example.com"]')).not.toBeNull();
      const { event, gesture } = touch(200, 300);
      act(() => {
        native.gestures?.onPanResponderGrant?.(event, gesture);
        native.gestures?.onPanResponderRelease?.(event, gesture);
      });
      expect(send.mock.calls).toEqual(
        (["down", "up"] as const).map((action) => [
          sessionId,
          { ...tapPoint, action, button: "left", clickCount: 1, type: "input.pointer" },
        ]),
      );
    });

    it("drops a touch begun before the picture changed size, rather than aiming it at the old geometry", async () => {
      const { decode, emit, render, send } = setup();
      render("synchronized");
      emit();
      await decode();
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
      });
      // The window folds while the finger is down: the picture is redrawn smaller.
      native.layout = { height: 450, width: 300, x: 0, y: 0 };
      render("synchronized");
      act(() => {
        native.gestures?.onPanResponderRelease?.(touch(150, 225).event, touch(150, 225).gesture);
      });
      expect(send).not.toHaveBeenCalled();

      // A drag already scrolling stops scrolling at the resize, and nothing clicks.
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(150, 225).event, touch(150, 225).gesture);
        native.gestures?.onPanResponderMove?.(
          touch(140, 205, -10, -20).event,
          touch(140, 205, -10, -20).gesture,
        );
      });
      expect(send).toHaveBeenCalledTimes(1);
      native.layout = { height: 600, width: 400, x: 0, y: 0 };
      native.geometry = "side:page@0";
      render("synchronized");
      act(() => {
        native.gestures?.onPanResponderMove?.(
          touch(130, 185, -20, -40).event,
          touch(130, 185, -20, -40).gesture,
        );
        native.gestures?.onPanResponderRelease?.(
          touch(130, 185, -20, -40).event,
          touch(130, 185, -20, -40).gesture,
        );
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("drops a touch when the picture moved without changing size, or its pane was rearranged", async () => {
      const { decode, emit, render, send } = setup();
      render("synchronized");
      emit();
      await decode();
      const tapAt = (x: number, y: number) => {
        act(() => {
          native.gestures?.onPanResponderRelease?.(touch(x, y).event, touch(x, y).gesture);
        });
      };
      // The stage keeps its size but moves: a vertical bar or a sidebar moved the pane.
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
      });
      native.layout = { height: 600, width: 400, x: 80, y: 0 };
      render("synchronized");
      tapAt(200, 300);
      expect(send).not.toHaveBeenCalled();
      // The surface was rearranged around an unchanged stage: a posture or region change.
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
      });
      native.geometry = "tabletop:page@0";
      render("synchronized");
      tapAt(200, 300);
      expect(send).not.toHaveBeenCalled();
      // An undisturbed tap still lands.
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
      });
      tapAt(200, 300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("ends a gesture when the drawn geometry changes or a second contact joins", async () => {
      const { decode, emit, render, send } = setup();
      render("synchronized");
      emit();
      await decode();
      const first = touch(200, 300);
      act(() => native.gestures?.onPanResponderGrant?.(first.event, first.gesture));
      emit(surfaceId, {
        frameId: 2,
        geometryRevision: 8,
        watchToken: "00000000-0000-4000-8000-000000000002",
      });
      await decode();
      act(() => native.gestures?.onPanResponderRelease?.(first.event, first.gesture));
      expect(send).not.toHaveBeenCalled();
      const multi = {
        ...first.event,
        nativeEvent: {
          ...first.event.nativeEvent,
          touches: [first.event.nativeEvent, { ...first.event.nativeEvent, identifier: 2 }],
        },
      } as GestureResponderEvent;
      act(() => {
        native.gestures?.onPanResponderGrant?.(first.event, first.gesture);
        native.gestures?.onPanResponderMove?.(multi, touch(200, 330, 0, 30).gesture);
        native.gestures?.onPanResponderRelease?.(first.event, first.gesture);
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("scrolls the page under a drag without clicking it", async () => {
      const { decode, emit, render, send } = setup();
      render("synchronized");
      emit();
      await decode();
      act(() => {
        native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
        const { event, gesture } = touch(190, 280, -10, -20);
        native.gestures?.onPanResponderMove?.(event, gesture);
        native.gestures?.onPanResponderRelease?.(event, gesture);
      });
      // The picture is drawn at half size, so a finger's 10 by 20 points move the page 20 by 40.
      expect(send.mock.calls).toEqual([
        [sessionId, { ...tapPoint, deltaX: 20, deltaY: 40, type: "input.wheel" }],
      ]);
    });

    it("drops a touch when the feed has gone before the view could redraw", async () => {
      const { decode, dropFeed, emit, onTap, render } = setup();
      render("synchronized");
      emit();
      await decode();
      dropFeed();
      expect(() =>
        act(() => {
          native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
          native.gestures?.onPanResponderRelease?.(touch(200, 300).event, touch(200, 300).gesture);
          native.gestures?.onPanResponderGrant?.(touch(200, 300).event, touch(200, 300).gesture);
          const { event, gesture } = touch(190, 280, -10, -20);
          native.gestures?.onPanResponderMove?.(event, gesture);
          native.gestures?.onPanResponderRelease?.(event, gesture);
        }),
      ).not.toThrow();
      expect(onTap).not.toHaveBeenCalled();
    });

    it("lets go of a press whose release the page refused", async () => {
      const { decode, dropFeed, emit, onTap, render, send } = setup();
      render("synchronized");
      emit();
      await decode();
      dropFeed(1);
      const { event, gesture } = touch(200, 300);
      act(() => {
        native.gestures?.onPanResponderGrant?.(event, gesture);
        native.gestures?.onPanResponderRelease?.(event, gesture);
      });
      const click = { ...tapPoint, button: "left", clickCount: 1, type: "input.pointer" };
      expect(send.mock.calls).toEqual([
        [sessionId, { ...click, action: "down" }],
        [sessionId, { ...click, action: "up" }],
        [sessionId, { surfaceId, type: "input.cancel" }],
      ]);
      expect(onTap).not.toHaveBeenCalled();
    });

    it("takes no touch on a picture drawn without its geometry", async () => {
      const { decode, emit, render, send } = setup();
      render("synchronized");
      emit(surfaceId, { geometryRevision: undefined });
      await decode();
      const { event, gesture } = touch(200, 300);
      act(() => {
        native.gestures?.onPanResponderGrant?.(event, gesture);
        native.gestures?.onPanResponderRelease?.(event, gesture);
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("restarts the stream only after reconnecting, and releases a hidden viewer", async () => {
      const { container, decode, emit, render, send, viewerRelease } = setup();
      render("synchronized");
      emit();
      await decode();
      render("connecting");
      expect(send).not.toHaveBeenCalled();
      expect(
        native.gestures?.onStartShouldSetPanResponder?.(
          {} as GestureResponderEvent,
          {} as PanResponderGestureState,
        ),
      ).toBe(false);
      render("synchronized");
      expect(send).not.toHaveBeenCalled();
      render("synchronized", false);
      expect(container.querySelector("img")).toBeNull();
      expect(viewerRelease).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    });

    it("retains and subscribes to the exact tab and rejects a sibling picture", async () => {
      const { container, emit, hostClient, render, viewerRelease } = setup();
      render("synchronized");
      expect(hostClient.retainBrowserViewer).toHaveBeenCalledWith(
        session("synchronized").id,
        surfaceId,
        { captureRegion: true, rasterDemand: true },
      );
      expect(hostClient.browserFrames.subscribe).toHaveBeenCalledWith(
        session("synchronized").id,
        expect.any(Function),
        surfaceId,
      );
      emit(BrowserSurfaceIdSchema.parse("other-page"));
      expect(container.querySelector("img")).toBeNull();
      render("synchronized", false);
      expect(viewerRelease).toHaveBeenCalledOnce();
    });

    it("returns exact-tab credit and releases the viewer when leaving during decode", async () => {
      const { emit, hostClient, render, viewerRelease } = setup();
      render("synchronized");
      emit();
      act(() => root?.unmount());
      root = null;
      expect(viewerRelease).toHaveBeenCalledOnce();
      expect(hostClient.acceptBrowserWatchFrame).toHaveBeenCalledWith(
        session("synchronized").id,
        "00000000-0000-4000-8000-000000000001",
        surfaceId,
      );
    });

    it("uses only the passive feed for a preview", async () => {
      const { decode, emit, hostClient, render, send, watchRelease } = setup(false);
      render("synchronized");
      emit();
      await decode();
      expect(hostClient.retainBrowserWatch).toHaveBeenCalledWith(
        session("synchronized").id,
        surfaceId,
        { captureRegion: true, rasterDemand: true },
      );
      expect(hostClient.retainBrowserViewer).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      render("synchronized", false);
      expect(watchRelease).toHaveBeenCalledOnce();
    });
  },
);

describe("native browser picture presenter", () => {
  beforeEach(() => {
    native.presenter = "picture";
  });
  const tokenA = "00000000-0000-4000-8000-000000000001";
  const tokenB = "00000000-0000-4000-8000-00000000000b";
  const tap = () =>
    act(() => {
      const { event, gesture } = touch(200, 300);
      native.gestures?.onPanResponderGrant?.(event, gesture);
      native.gestures?.onPanResponderRelease?.(event, gesture);
    });

  it("aims input at the picture the view drew, not the newest received, and returns each receipt once", async () => {
    const { emit, decode, hostClient, render, send } = setup();
    render("synchronized");
    emit();
    await decode();
    emit(surfaceId, { frameId: 2, geometryRevision: 8, watchToken: tokenB });
    expect(
      native.presented.map(({ bytes, metadata }) => ({ bytes: [...bytes], metadata })),
    ).toEqual([
      {
        bytes: [0xff, 0xd8, 0xff],
        metadata: {
          cornerRadius: 0,
          fence: `${surfaceId}:800:600:8:`,
          generation: native.generation,
          height: 600,
          regionHeight: 600,
          regionWidth: 800,
          upscale: true,
          width: 800,
        },
      },
    ]);
    tap();
    expect(send.mock.calls.map(([, command]) => command)).toEqual([
      expect.objectContaining({ action: "down", geometryRevision: 7 }),
      expect.objectContaining({ action: "up", geometryRevision: 7 }),
    ]);
    await decode();
    send.mockClear();
    tap();
    expect(send.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ geometryRevision: 8 }));
    render("synchronized", false);
    expect(vi.mocked(hostClient.acceptBrowserWatchFrame).mock.calls).toEqual([
      [sessionId, tokenA, surfaceId],
      [sessionId, tokenB, surfaceId],
    ]);
  });

  it("renders for a drawn picture, never for a delivery alone", async () => {
    const { decode, emit, render } = setup();
    render("synchronized");
    emit();
    await decode();
    const renders = native.renders;
    emit(surfaceId, { frameId: 2, watchToken: tokenB });
    emit(surfaceId, { frameId: 3, watchToken: tokenB });
    expect(native.presented).toHaveLength(2);
    expect(native.renders).toBe(renders);
    await decode();
    expect(native.renders).toBe(renders + 1);
  });

  it("clears pixels and input when the view drops them by itself", async () => {
    const { container, decode, emit, render } = setup();
    render("synchronized");
    emit();
    await decode();
    expect(container.querySelector("img")).not.toBeNull();
    act(() => native.cleared?.({ nativeEvent: { generation: native.generation } }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Loading the page…");
    expect(
      native.gestures?.onStartShouldSetPanResponder?.(
        {} as GestureResponderEvent,
        {} as PanResponderGestureState,
      ),
    ).toBe(false);
  });

  it("returns a failed or abandoned picture's receipt once and never draws it late", async () => {
    const { container, decode, emit, hostClient, render } = setup();
    render("synchronized");
    emit();
    await decode("failed");
    expect(container.querySelector("img")).toBeNull();
    emit(surfaceId, { frameId: 2, watchToken: tokenB });
    const abandoned = native.presented[0];
    // Another tab comes in front before the view finishes: its picture is never drawn here.
    emit(BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000002"), {
      watchToken: "00000000-0000-4000-8000-00000000000c",
    });
    await act(async () => abandoned?.settle("presented"));
    expect(container.querySelector("img")).toBeNull();
    // Each delivery's receipt returns exactly once, whichever path settled it.
    expect(
      vi
        .mocked(hostClient.acceptBrowserWatchFrame)
        .mock.calls.map(([, token]) => token)
        .toSorted(),
    ).toEqual([tokenA, tokenB, "00000000-0000-4000-8000-00000000000c"]);
  });
});
