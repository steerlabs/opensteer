import { type HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { memo, useMemo, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { color, controlFontScaleLimit, pillHeight, radius, space, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { agentsPillSelector, samePlain } from "./agent-select.js";

/** Below this dock width the pill keeps its count and drops its noun. */
const narrowDock = 340;

/**
 * The agents working for this conversation, as a small capsule leading the
 * composer dock while any of them is live. It opens Around on its Agents page;
 * once the last one settles it leaves, and the header's Around control is the
 * way to the roster.
 */
export const AgentsPill = memo(function AgentsPill(props: {
  readonly hostClient: HostClient;
  readonly onOpen: () => void;
  readonly threadId: string;
}): ReactNode {
  const select = useMemo(() => agentsPillSelector(props.threadId), [props.threadId]);
  const pill = useHostSelector(props.hostClient, select, samePlain);
  const keyboard = useKeyboardVisible();
  const narrow = useWindowDimensions().width < narrowDock;
  if (pill === null || keyboard) return null;
  const count = `${pill.live}/${pill.total}`;
  return (
    <Animated.View entering={enter} exiting={exit} style={styles.place}>
      <Pressable
        accessibilityHint="Shows the agents working for this conversation"
        accessibilityLabel={`${pill.live} of ${pill.total} agents working${
          pill.needsYou > 0
            ? `, ${pill.needsYou} ${pill.needsYou === 1 ? "needs" : "need"} you`
            : ""
        }`}
        accessibilityRole="button"
        onPress={() => {
          Keyboard.dismiss();
          props.onOpen();
        }}
        style={({ pressed }) => [styles.target, pressed && styles.pressed]}
      >
        <GlassSurface shape="capsule" style={styles.capsule} tint={color.floatTint}>
          <Symbol name="person.2" size={13} tint={color.textSoft} />
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="caption"
            style={styles.figures}
            tone="soft"
          >
            {narrow ? count : `${count} agents`}
          </AppText>
          {pill.needsYou > 0 ? <View style={styles.attention} /> : null}
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  place: { alignSelf: "flex-start" },
  target: { justifyContent: "center", minHeight: touchTarget },
  pressed: { opacity: 0.7 },
  capsule: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: pillHeight,
    paddingHorizontal: space[12],
  },
  figures: { fontVariant: ["tabular-nums"] },
  attention: { backgroundColor: color.amber, borderRadius: radius.full, height: 6, width: 6 },
});
