import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { color, space } from "../theme.js";
import { Symbol } from "./symbol.js";

/** Copying with the only signs a phone's clipboard has: a tap of the hand, and `copied` for a moment. */
export function useCopy(): { readonly copied: boolean; readonly copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );
  const copy = (text: string): void => {
    void Clipboard.setStringAsync(text).then(
      () => {
        void Haptics.selectionAsync();
        setCopied(true);
        if (reset.current !== null) clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopied(false), 1_500);
      },
      () => Alert.alert("Copy unavailable", "Select the text to copy it."),
    );
  };
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
