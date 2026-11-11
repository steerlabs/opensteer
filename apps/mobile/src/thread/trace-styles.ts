import { StyleSheet } from "react-native";
import { color, material, radius, space, touchTarget } from "../theme.js";

/**
 * The trace's one row shape, shared by a step and a subagent so the two read
 * as the same kind of thing: an icon slot, the words, the time and a chevron.
 */
export const trace = StyleSheet.create({
  figures: { fontVariant: ["tabular-nums"] },
  icon: { alignItems: "center", width: space[20] },
  /** A row's own rows hang off a hairline under its glyph. */
  lines: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: StyleSheet.hairlineWidth,
    marginLeft: space[10],
    paddingLeft: space[4],
  },
  pressed: { ...material.quiet },
  step: {
    alignItems: "center",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    marginHorizontal: -space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[8],
    paddingVertical: space[4],
  },
  stepCompact: { marginHorizontal: 0 },
  stepText: { flex: 1, gap: space[2] },
});
