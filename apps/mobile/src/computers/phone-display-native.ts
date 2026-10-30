import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import type { ViewProps } from "react-native";

/** One encoded video frame, labelled with the decoder epoch it was queued under. */
export interface DisplayFrameMetadata {
  readonly epoch: string;
  readonly width: number;
  readonly height: number;
  readonly pts: number;
  readonly key: boolean;
  readonly replayed: boolean;
}

export interface NativeDecoder {
  reset(epoch: string): Promise<void>;
  decode(frame: DisplayFrameMetadata & { readonly data: string }): Promise<boolean>;
  /** Present only in a binary reporting `binaryPresentationVersion` 1 or later. */
  decodeBytes?(bytes: Uint8Array, metadata: DisplayFrameMetadata): Promise<boolean>;
}

export const NativeDisplay = requireNativeView<
  ViewProps & {
    ref?: Ref<NativeDecoder>;
    onReady?: (event: { nativeEvent: { epoch: string; width: number; height: number } }) => void;
    onNeedsKeyframe?: (event: { nativeEvent: { epoch: string } }) => void;
  }
>("PhoneDisplay");

/** What became of one delivered picture; each settles exactly once. */
export type PictureOutcome = "presented" | "failed" | "dropped";

export interface PictureMetadata {
  /** The clear generation it was sent under; the view draws no other. */
  readonly generation: number;
  /** Pictures sharing input geometry. A newer one under another fence supersedes a decode. */
  readonly fence: string;
  /** The encoded raster; a decoded image of any other size fails. */
  readonly width: number;
  readonly height: number;
  /** The page region the raster shows, laid out with aspect-fit and centred. */
  readonly regionWidth: number;
  readonly regionHeight: number;
  readonly upscale: boolean;
  readonly cornerRadius: number;
}

export interface NativePicture {
  clear(generation: number): Promise<void>;
  present(bytes: Uint8Array, metadata: PictureMetadata): Promise<PictureOutcome>;
}

export type NativePictureView = ComponentType<
  ViewProps & {
    ref?: Ref<NativePicture>;
    /** The view dropped its pixels by itself: the app left the foreground or the view its window. */
    onCleared?: (event: { nativeEvent: { generation: number } }) => void;
  }
>;

/**
 * Whether the installed binary takes bytes rather than base64 and has the
 * picture view. A JavaScript update can run on an older binary, so this reads
 * the binary's own declaration rather than guessing from the platform.
 */
export function phoneDisplayBinary(): boolean {
  const version =
    requireOptionalNativeModule<{ readonly binaryPresentationVersion?: number }>("PhoneDisplay")
      ?.binaryPresentationVersion ?? 0;
  return version >= 1;
}

let pictureView: NativePictureView | null = null;
/** The browser picture surface, or null on a binary without one. */
export function nativePictureView(): NativePictureView | null {
  if (!phoneDisplayBinary()) return null;
  pictureView ??= requireNativeView("PhoneDisplay", "PhoneDisplayPicture");
  return pictureView;
}
