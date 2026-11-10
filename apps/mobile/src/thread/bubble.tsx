import { useCallback, useState, type ReactNode } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextLayoutEvent,
  type ViewStyle,
} from "react-native";
import { useSafeAreaFrame } from "react-native-safe-area-context";
import { TextLines } from "../markdown/text-lines.js";
import { color } from "../theme.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";

/** Messages' bubble, measured from its screenshots on iOS 26, in points at the default text size. */
export const bubble = {
  /** Between bubbles of one group, and between groups. */
  gap: 4,
  groupGap: 10,
  /** The share of the column a bubble of words may take. */
  maxWidth: "70%",
  padX: 14,
  padY: 10,
  /** On the continuous curve, which makes a one-line bubble a capsule. */
  radius: 20,
} as const;

/**
 * A hook under the corner, in two plain views: a turned bar in the bubble's
 * fill, then a circle of the ground over the pinch. SVG would cost a native
 * view and a parse for every bubble; these are two more rectangles.
 */
const tail = { angle: 32, drop: 4.05, height: 9, inset: 5.7, tip: 1.5, width: 16 };
const notch = { drop: 6.2, inset: 1.1, size: 11.6 };

const fittedLimit = 500;
const fitted = new Map<string, number>();

/**
 * A bubble's width from its longest line, as Messages sizes it: a Text left to
 * itself takes all the width it may. Measured once per text, text size and
 * column, and kept, so a row scrolled back into view lands at its width on its
 * first frame. The column is the pane's, not the window's: beside a page the
 * same words wrap narrower than in Chat alone.
 */
function useFit(words: string | null): {
  readonly onTextLayout: (event: TextLayoutEvent) => void;
  readonly width: number | undefined;
} {
  const { fontScale } = useWindowDimensions();
  const { width: pane } = useSafeAreaFrame();
  const { left, right } = useContentInsets();
  const column = pane - left - right - useGutter() * 2;
  const key = words === null ? null : `${fontScale}:${column}:${words}`;
  const [measured, setMeasured] = useState<{ key: string; width: number } | null>(null);
  const width = key === null ? undefined : measured?.key === key ? measured.width : fitted.get(key);
  const onTextLayout = useCallback(
    (event: TextLayoutEvent): void => {
      if (key === null) return;
      const longest = Math.ceil(Math.max(...event.nativeEvent.lines.map((line) => line.width)));
      setMeasured((current) => {
        const known = current?.key === key ? current.width : (fitted.get(key) ?? 0);
        if (longest <= known) return current;
        if (fitted.size >= fittedLimit) fitted.clear();
        fitted.set(key, longest);
        return { key, width: longest };
      });
    },
    [key],
  );
  return { onTextLayout, width };
}

export function Bubble(props: {
  readonly children: ReactNode;
  readonly fill: string;
  /** The words it holds, to size it by its longest line; null where it fills its column. */
  readonly fit: string | null;
  readonly side: "mine" | "theirs";
  readonly style?: StyleProp<ViewStyle>;
  readonly tail: boolean;
}): ReactNode {
  const { onTextLayout, width } = useFit(props.fit);
  return (
    <View
      style={[
        styles.bubble,
        { backgroundColor: props.fill },
        width !== undefined && { width: width + bubble.padX * 2 + 1 },
        props.style,
      ]}
    >
      {props.tail ? <Tail fill={props.fill} side={props.side} /> : null}
      <TextLines value={props.fit === null ? null : onTextLayout}>{props.children}</TextLines>
    </View>
  );
}

function Tail(props: { readonly fill: string; readonly side: "mine" | "theirs" }): ReactNode {
  const mine = props.side === "mine";
  return (
    <>
      <View
        style={[
          styles.tail,
          mine ? styles.tailMine : styles.tailTheirs,
          { backgroundColor: props.fill },
        ]}
      />
      <View style={[styles.notch, mine ? styles.notchMine : styles.notchTheirs]} />
    </>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderCurve: "continuous",
    borderRadius: bubble.radius,
    paddingHorizontal: bubble.padX,
    paddingVertical: bubble.padY,
  },
  notch: {
    backgroundColor: color.background,
    borderRadius: notch.size / 2,
    bottom: -notch.drop,
    height: notch.size,
    position: "absolute",
    width: notch.size,
  },
  notchMine: { right: -notch.inset },
  notchTheirs: { left: -notch.inset },
  tail: { bottom: -tail.drop, height: tail.height, position: "absolute", width: tail.width },
  tailMine: {
    borderBottomRightRadius: tail.tip,
    right: tail.inset,
    transform: [{ rotate: `${tail.angle}deg` }],
  },
  tailTheirs: {
    borderBottomLeftRadius: tail.tip,
    left: tail.inset,
    transform: [{ rotate: `${-tail.angle}deg` }],
  },
});
