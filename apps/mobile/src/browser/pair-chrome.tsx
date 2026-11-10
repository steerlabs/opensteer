import type { ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/** Android's touch target is Material's 48dp; iOS's is 44pt. */
const target = Platform.OS === "android" ? 48 : touchTarget;

/**
 * The pill over a pane beside a page while it has no Thread's own pill to
 * show — a task still being written, or a Thread whose name is on its way —
 * with the same menu place for putting the pane away.
 */
export function CompanionCapsule(props: {
  readonly actions: readonly NativeMenuOption[];
  readonly title: string;
}): ReactNode {
  return (
    <GlassSurface interactive shape="capsule" style={styles.capsule}>
      <NativeMenu
        accessibilityHint="Shows what you can do with this pane"
        accessibilityLabel={props.title === "" ? "Actions" : `${props.title}. Actions`}
        options={props.actions}
        triggerStyle={styles.capsuleTrigger}
      >
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
          style={styles.capsuleTitle}
        >
          {props.title}
        </AppText>
        <Symbol name="chevron.down" size={11} tint={color.muted} weight="bold" />
      </NativeMenu>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  capsule: { maxWidth: 320, paddingHorizontal: space[12] },
  capsuleTitle: { flexShrink: 1, fontWeight: "600" },
  capsuleTrigger: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space[4],
    minHeight: target,
  },
});
