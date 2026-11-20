import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { ReferenceVisibility } from "../markdown/reference-context.js";
import { color, space, touchTarget, type } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/**
 * A sent message's words, folded to `lines` of body text until the reader
 * opens them. Show more stands inside the message, and only when the words run
 * past the fold or `more` says what is drawn is an excerpt of something longer.
 */
export function MessageFold(props: {
  readonly children: ReactNode;
  readonly lines: number;
  /** The reader's own bubble is the accent, so its toggle takes the bubble's ink. */
  readonly mine: boolean;
  readonly more: boolean;
  readonly onToggle: () => void;
  readonly open: boolean;
}): ReactNode {
  // Lines of body text, which grow with the reader's text size.
  const { fontScale } = useWindowDimensions();
  const fold = props.lines * type.body.lineHeight * fontScale;
  const [height, setHeight] = useState<number | null>(null);
  const overflowing = height !== null && height > fold + 1;
  // Words folded out of sight look nothing up until the reader opens them.
  const visible = props.open || (height !== null && !overflowing);
  return (
    <>
      <View style={props.open ? undefined : [styles.fold, { maxHeight: fold }]}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <ReferenceVisibility value={visible}>{props.children}</ReferenceVisibility>
        </View>
      </View>
      {overflowing || props.more ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.open }}
          onPress={props.onToggle}
          style={styles.foldToggle}
        >
          <AppText
            role="secondaryMedium"
            style={props.mine ? styles.bubbleInk : undefined}
            tone="ember"
          >
            {props.open ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  bubbleInk: { color: color.bubbleInk },
  fold: { overflow: "scroll" },
  foldToggle: { justifyContent: "center", minHeight: touchTarget, paddingTop: space[4] },
});
