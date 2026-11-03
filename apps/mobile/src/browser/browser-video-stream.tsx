import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { useEffect, useRef, useState, useSyncExternalStore, useCallback } from "react";
import { PixelRatio, Pressable, Text, View } from "react-native";
import {
  BrowserVideoFrameHeaderSchema,
  browserPresentationRef,
  validateBrowserH264,
  type BrowserVideoFrameHeader,
} from "@opensteer/protocol";
import { useBrowserPresentationWait } from "@opensteer/client/react";
import type { BrowserVideoFrame } from "@opensteer/client/host";
import {
  nativeBrowserVideoView,
  type NativeBrowserVideoDecoder,
} from "../computers/phone-display-native.js";
import type { BrowserStreamProps } from "./browser-stream.js";

/** Native pixels and touch identity stay in PhoneDisplay; React owns only visibility and chrome. */
export function BrowserVideoStream(props: BrowserStreamProps) {
  const { hostClient, session, tabId, active, interactive = false, inputEnabled = true } = props;
  const frames = interactive ? hostClient.browserFrames : hostClient.browserWatchFrames;
  const video = frames.video!;
  const [NativeVideo] = useState(nativeBrowserVideoView);
  const view = useRef<NativeBrowserVideoDecoder | null>(null);
  const current = useRef(props);
  current.current = props;
  const epoch = useRef("");
  const recovery = useRef({ requested: false, attempts: 0 });

  const visible = active && session.state === "ready";
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKeyframe = useCallback(() => {
    if (recovery.current.requested) return;
    recovery.current.requested = true;
    if (++recovery.current.attempts >= 3) {
      setReady(false);
      setError("Browser video decoding failed.");
      video.failed(session.id, tabId, "decoder");
    } else video.keyframe(session.id, tabId);
  }, [session.id, tabId, video]);
  const wait = useBrowserPresentationWait(hostClient, session.id, tabId, visible && interactive);
  const feed = useSyncExternalStore(
    useCallback(
      (listener) =>
        (interactive ? hostClient.subscribeBrowserViewer : hostClient.subscribeBrowserWatch)?.(
          session.id,
          tabId,
          listener,
        ) ?? (() => undefined),
      [hostClient, session.id, tabId, interactive],
    ),
    useCallback(
      () =>
        (interactive ? hostClient.browserViewerState : hostClient.browserWatchState)(
          session.id,
          tabId,
        ),
      [hostClient, session.id, tabId, interactive],
    ),
  );
  const identity = (event: { epoch: string; identity: string }): BrowserVideoFrameHeader | null => {
    if (event.epoch !== epoch.current || !current.current.active) return null;
    try {
      return BrowserVideoFrameHeaderSchema.parse(JSON.parse(event.identity));
    } catch {
      return null;
    }
  };
  useEffect(() => {
    if (!visible || !NativeVideo) return;
    return interactive
      ? hostClient.retainBrowserViewer(session.id, tabId)
      : hostClient.retainBrowserWatch(session.id, tabId);
  }, [NativeVideo, hostClient, interactive, session.id, tabId, visible]);
  useEffect(() => {
    let closed = false;
    let pending = 0;
    let tail = Promise.resolve();
    const clear = () => {
      epoch.current = `clear:${crypto.randomUUID()}`;
      setReady(false);
      recovery.current = { requested: false, attempts: 0 };
      void view.current?.reset(epoch.current);
    };
    clear();
    if (!visible || !NativeVideo) return clear;
    const unframe = video.onFrame(session.id, tabId, (frame: BrowserVideoFrame) => {
      if (closed) {
        frame.done();
        return;
      }
      if (pending >= 4) {
        frame.done();
        requestKeyframe();
        return;
      }
      pending++;
      tail = tail
        .then(async () => {
          if (closed) return;
          const decoder = view.current;
          if (!decoder) throw new Error("Update the Opensteer app for native browser video.");
          const { header } = frame;
          if (header.key) recovery.current.requested = false;
          validateBrowserH264(frame.payload, header);
          const next = `${frame.connection}:${header.streamId}:${header.generation}`;
          if (epoch.current !== next) {
            epoch.current = next;
            setReady(false);
            await decoder.reset(next);
          }
          if (closed) return;
          const crop = header.presentation.rasterCrop;
          const admitted = await decoder.decodeBytes(frame.payload, {
            epoch: next,
            width: header.width,
            height: header.height,
            pts: header.ptsUs,
            key: header.key,
            replayed: frame.replayed,
            identity: JSON.stringify(header),
            cropX: crop.x,
            cropY: crop.y,
            cropWidth: crop.width,
            cropHeight: crop.height,
          });
          if (!admitted) requestKeyframe();
        })
        .catch(() => {
          if (!closed) {
            setError("Browser video decoding failed.");
            requestKeyframe();
          }
        })
        .finally(() => {
          pending--;
          frame.done();
        });
    });
    const unstate = frames.subscribe(
      session.id,
      () => {
        const state = video.state(session.id, tabId);
        if (state?.state === "stopped" || state?.state === "failed") clear();
      },
      tabId,
    );
    // Shape changes are handled by native layout; its touch owner cancels any pending local transform.
    return () => {
      closed = true;
      unframe();
      unstate();
      clear();
    };
  }, [NativeVideo, frames, requestKeyframe, session.id, tabId, video, visible]);
  useEffect(() => {
    if (interactive && !inputEnabled)
      hostClient.sendBrowserCommand(session.id, {
        type: "input.cancel",
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
      });
  }, [hostClient, inputEnabled, interactive, session.id, tabId]);
  const shape = useRef("");
  const stage = useRef({ width: 0, height: 0 });
  if (!NativeVideo)
    return (
      <View style={[{ flex: 1, backgroundColor: "black", justifyContent: "center" }, props.style]}>
        <Text>Update the Opensteer app for native browser video.</Text>
      </View>
    );
  return (
    <View style={[{ flex: 1, backgroundColor: "black" }, props.style]}>
      <NativeVideo
        ref={view}
        style={{ flex: 1 }}
        pointerEvents={
          interactive && inputEnabled && visible && feed.status !== "unavailable" ? "auto" : "none"
        }
        onLayout={({ nativeEvent: { layout } }) => {
          stage.current = layout;
          video.budget(
            session.id,
            tabId,
            layout.width * PixelRatio.get(),
            layout.height * PixelRatio.get(),
          );
        }}
        onNeedsKeyframe={({ nativeEvent }) => {
          if (nativeEvent.epoch === epoch.current) requestKeyframe();
        }}
        onVideoPresented={({ nativeEvent: event }) => {
          const header = identity(event);
          if (!header) return;
          recovery.current = { requested: false, attempts: 0 };
          video.presented(session.id, tabId, header);
          video.budget(
            session.id,
            tabId,
            stage.current.width * PixelRatio.get(),
            stage.current.height * PixelRatio.get(),
          );
          setReady(true);
          wait.presented();
          const p = header.presentation;
          const next = `${p.rootCssWidth}:${p.rootCssHeight}`;
          if (shape.current !== next) {
            shape.current = next;
            current.current.onPageSize?.({ width: p.rootCssWidth, height: p.rootCssHeight });
          }
        }}
        onVideoGesture={({ nativeEvent: event }) => {
          const header = identity(event);
          if (
            !header ||
            !current.current.interactive ||
            (event.phase === "begin" && current.current.inputEnabled === false)
          )
            return;
          video.gesture(
            session.id,
            tabId,
            header.streamId,
            browserPresentationRef(header),
            event.gestureId,
            event.phase,
          );
          if (event.phase === "begin") current.current.onPointerDown?.();
        }}
        onVideoScroll={({ nativeEvent: event }) => {
          const header = identity(event);
          if (!header || !current.current.interactive || current.current.inputEnabled === false)
            return;
          hostClient.sendBrowserCommand(session.id, {
            type: "input.wheel",
            surfaceId: BrowserSurfaceIdSchema.parse(tabId),
            x: (event.x - header.presentation.rasterCrop.x) / header.presentation.rasterCrop.width,
            y: (event.y - header.presentation.rasterCrop.y) / header.presentation.rasterCrop.height,
            viewportWidth: header.presentation.rootCssWidth,
            viewportHeight: header.presentation.rootCssHeight,
            deltaX:
              (event.dx * header.presentation.rootCssWidth) / header.presentation.rasterCrop.width,
            deltaY:
              (event.dy * header.presentation.rootCssHeight) /
              header.presentation.rasterCrop.height,
            modifiers: [],
          });
          current.current.onScroll?.();
        }}
        onVideoTap={({ nativeEvent: event }) => {
          const header = identity(event);
          if (!header || !current.current.interactive || current.current.inputEnabled === false)
            return;
          video.click(
            session.id,
            tabId,
            header.streamId,
            browserPresentationRef(header),
            event.gestureId,
            { x: event.x, y: event.y },
            0,
          );
          current.current.onTap?.();
        }}
      />
      {!ready || feed.status === "unavailable" || error || wait.error ? (
        <View
          style={{ position: "absolute", inset: 0, justifyContent: "center", alignItems: "center" }}
        >
          <Text>{wait.error ?? error ?? feed.error ?? "Connecting…"}</Text>
          {wait.error || error || feed.error ? (
            <Pressable
              onPress={() => {
                setError(null);
                wait.retry();
                video.retry(session.id, tabId);
              }}
            >
              <Text>Retry viewing</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
