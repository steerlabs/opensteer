import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { color, space } from "../theme.js";
import { Symbol } from "./symbol.js";

/** Copying with the only signs a phone's clipboard has: a tap of the hand, and `copied` for a moment. */
export function useCopy(options?: {
  /** In place of the alert, for a screen with its own line to say so on. */
  readonly onFailure?: () => void;
}): { readonly copied: boolean; readonly copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );
  const failed = (): void => {
    if (options?.onFailure) options.onFailure();
    else Alert.alert("Copy unavailable", "Select the text to copy it.");
  };
  const copy = (text: string): Promise<void> =>
    Clipboard.setStringAsync(text).then((written) => {
      if (written === false) {
        failed();
        return;
      }
      void Haptics.selectionAsync();
      setCopied(true);
      if (reset.current !== null) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 1_500);
    }, failed);
  return { copied, copy };
}

/**
 * A bare mark beside or inside what it copies. The glyph is small and the place
 * a thumb lands on is not, so it costs a row of text no height.
 */
export function CopyMark(props: {
  readonly accessibilityLabel: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly text: string;
}): ReactNode {
  const { copied, copy } = useCopy();
  return (
    <Pressable
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={space[12]}
      onPress={() => copy(props.text)}
      style={props.style}
    >
      <Symbol
        name={copied ? "checkmark" : "square.on.square"}
        size={16}
        tint={copied ? color.ember : color.muted}
      />
    </Pressable>
  );
}
