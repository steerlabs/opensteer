import { requireNativeView } from "expo";
import type { ComponentType, Ref } from "react";
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

/** The editor's Markdown source, caret and revision, in UTF-16 source offsets. */
export interface NativeComposerState {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly eventCount: number;
  readonly generation: number;
  readonly composing: boolean;
}

export interface NativeComposerEditorRef {
  focus(): Promise<void>;
  blur(): Promise<void>;
  setSelection(start: number, end: number): Promise<void>;
  readState(): Promise<NativeComposerState>;
}

export interface NativeComposerEditorProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  /** `{ value, selection, tokens, eventCount, isNativeEcho, generation }`. */
  readonly documentJson: string;
  readonly themeJson: string;
  /** `{ fontSize, lineHeight, paddingVertical }`, already scaled for the person's text size. */
  readonly typographyJson: string;
  readonly placeholder: string;
  readonly label: string;
  readonly editable: boolean;
  readonly autoFocus: boolean;
  /** The most one pasted image may hold; a larger one is reported, not written. */
  readonly maxBytes: number;
  /** The draft identity captured by a paste that may finish after this view leaves. */
  readonly pasteTarget?: string | null;
  readonly style?: StyleProp<ViewStyle>;
  readonly onComposerChange: (event: NativeSyntheticEvent<NativeComposerState>) => void;
  readonly onComposerSelectionChange: (event: NativeSyntheticEvent<NativeComposerState>) => void;
  readonly onComposerFocus: () => void;
  readonly onComposerBlur: () => void;
  readonly onComposerPasteImages: (event: NativeSyntheticEvent<PastedImages>) => void;
  readonly onComposerContentSizeChange: (
    event: NativeSyntheticEvent<{ readonly height: number }>,
  ) => void;
  /** Backspace in an empty field, which deletes nothing. */
  readonly onComposerEmptyBackspace: () => void;
}

/**
 * A text view whose Markdown references are atomic chips: UITextView attachments on
 * iOS, replacement spans over the source on Android. It takes pasted and dropped
 * images itself, so they reach the composer rather than becoming text.
 */
export const NativeComposerEditor: ComponentType<NativeComposerEditorProps> =
  requireNativeView<NativeComposerEditorProps>("OpensteerComposerEditor");
