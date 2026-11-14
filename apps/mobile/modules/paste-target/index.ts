import { requireNativeView } from "expo";
import type { ComponentType, ReactNode } from "react";
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native";

/** One pasted image, written to a temporary file this app owns. */
export interface PastedImage {
  readonly uri: string;
  readonly mediaType: string;
  readonly name: string;
}

export interface PastedImages {
  readonly images: readonly PastedImage[];
  /** Images on the pasteboard that could not be read. */
  readonly failed: number;
  /** Images over `maxBytes`, which were not written. */
  readonly tooLarge: number;
}

interface PasteTargetProps {
  readonly children: ReactNode;
  /** The most one image may hold where this field sends it. */
  readonly maxBytes: number;
  readonly onPasteImages: (event: NativeSyntheticEvent<PastedImages>) => void;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Holds a text field and takes the images pasted into it; pasted text still
 * goes to the field.
 */
export const PasteTarget: ComponentType<PasteTargetProps> =
  requireNativeView<PasteTargetProps>("OpensteerPasteTarget");
