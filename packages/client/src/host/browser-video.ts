import type {
  BrowserPresentationRef,
  BrowserVideoFrameHeader,
  BrowserVideoState,
} from "@opensteer/protocol";
import type { BrowserSurfaceId } from "@opensteer/core";
import type { MediaFrame } from "../media/display-media.js";
import type { BrowserFrameView } from "./client.js";
export type BrowserVideoFrame = MediaFrame<BrowserVideoFrameHeader>;
export interface BrowserVideoStore {
  selected(): boolean;
  budget(sessionId: string, surfaceId: string, width: number, height: number): void;
  onFrame(
    sessionId: string,
    surfaceId: string,
    listener: (frame: BrowserVideoFrame) => void,
  ): () => void;
  state(sessionId: string, surfaceId: string): BrowserVideoState | null;
  /** Called by the presentation owner in the operation that commits pixels. */
  presented(sessionId: string, surfaceId: string, header: BrowserVideoFrameHeader): void;
  failed(sessionId: string, surfaceId: string, reason: "unsupported" | "decoder"): void;
  retry(sessionId: string, surfaceId: string): void;
  keyframe(sessionId: string, surfaceId: string): void;
  gesture(
    sessionId: string,
    surfaceId: string,
    streamId: BrowserVideoFrameHeader["streamId"],
    reference: BrowserPresentationRef,
    gestureId: string,
    phase: "begin" | "cancel",
  ): void;
  click(
    sessionId: string,
    surfaceId: string,
    streamId: BrowserVideoFrameHeader["streamId"],
    reference: BrowserPresentationRef,
    gestureId: string,
    point: { x: number; y: number },
    modifiers: number,
  ): void;
}
/** Geometry for existing page chrome. H.264 bytes are delivered imperatively, never as an image. */
export function browserVideoFrameView(
  surfaceId: string,
  video: BrowserVideoFrameHeader,
): BrowserFrameView {
  const p = video.presentation;
  return {
    video,
    data: new Uint8Array(0),
    header: {
      encoding: "h264",
      surfaceId: surfaceId as BrowserSurfaceId,
      frameId: video.sequence,
      rasterWidth: p.rasterCrop.width,
      rasterHeight: p.rasterCrop.height,
      viewportWidth: p.rootCssWidth,
      viewportHeight: p.rootCssHeight,
    },
  };
}
