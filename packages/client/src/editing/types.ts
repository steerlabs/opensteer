import type {
  EditingCommand,
  EditingComposition,
  EditingContext,
  EditingKeystroke,
  EditingTextEdit,
} from "@opensteer/protocol/editing";

/**
 * The boundary between a platform's text proxy (a hidden textarea on the web,
 * a native text view in Expo) and the shared editing core. Adapters translate
 * their platform's events into `EditingProxyEvent`s, in the order the platform
 * delivered them, and carry out the `EditingProxyInstruction`s the core returns.
 */

/** The viewer's platform decides what a chord means. */
export type EditingViewerPlatform = "mac" | "ios" | "windows" | "linux" | "chromeos" | "android";

export interface EditingKeyState {
  readonly key: string;
  readonly code: string;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  /** The key is AltGr-shifted: a character, never a Ctrl+Alt chord. */
  readonly altGraph: boolean;
  readonly location: 0 | 1 | 2 | 3;
  readonly repeat: boolean;
  /** The platform IME owns this key (`isComposing`, `Process` or key code 229). */
  readonly composing: boolean;
}

/** The proxy's text and selection after an event, in UTF-16 units. */
export interface EditingProxyState {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** The current preedit in value, as UTF-16 [start, end); null means none. */
  readonly markedRange?: { readonly start: number; readonly end: number } | null;
}

export interface EditingClipboardPayloadItem {
  readonly type: string;
  readonly name?: string;
  readonly bytes: Uint8Array;
}

export type EditingProxyEvent =
  | ({ readonly type: "keydown" | "keyup" } & EditingKeyState)
  | { readonly type: "compositionstart"; readonly proxy: EditingProxyState }
  | {
      readonly type: "compositionupdate";
      readonly data: string;
      readonly proxy: EditingProxyState;
    }
  | { readonly type: "compositionend"; readonly data: string; readonly proxy: EditingProxyState }
  | { readonly type: "beforeinput"; readonly inputType: string; readonly data: string | null }
  | {
      readonly type: "input";
      readonly inputType: string;
      readonly composing: boolean;
      readonly proxy: EditingProxyState;
    }
  /** A selection change with no text change, such as a keyboard's cursor gesture. */
  | { readonly type: "selection"; readonly proxy: EditingProxyState }
  | { readonly type: "paste"; readonly items: readonly EditingClipboardPayloadItem[] }
  | { readonly type: "copy" | "cut" }
  | { readonly type: "pointerdown" }
  | { readonly type: "blur" }
  /** The target's focused field changed, or it refused an edit as stale. */
  | { readonly type: "context"; readonly context: EditingContext | null };

/** What the person did, ready for the target's wire. */
export type EditingOperation =
  | { readonly kind: "key"; readonly keystroke: EditingKeystroke }
  | { readonly kind: "command"; readonly command: EditingCommand }
  | { readonly kind: "compose"; readonly composition: EditingComposition }
  | { readonly kind: "edit"; readonly edit: EditingTextEdit }
  | { readonly kind: "copy" | "cut" }
  | { readonly kind: "paste"; readonly items: readonly EditingClipboardPayloadItem[] };

export interface EditingProxyInstruction {
  /** Stop the platform's own handling of the event just delivered. */
  readonly preventDefault?: boolean;
  /** Replace the proxy's text and selection (never while the platform IME composes). */
  readonly set?: EditingProxyState;
}

export interface EditingStep {
  readonly operations: readonly EditingOperation[];
  readonly instruction: EditingProxyInstruction;
}

/** What the target can apply; the core never emits an operation outside it. */
export interface EditingTargetAbilities {
  /** The target shows compositions live (`compose`); otherwise the viewer draws the preedit. */
  readonly composition: boolean;
  /** The target verifies and applies range edits; otherwise the proxy keeps no mirror. */
  readonly rangeEdits: boolean;
  readonly commands: boolean;
  readonly clipboard: "full" | "text" | "none";
}
