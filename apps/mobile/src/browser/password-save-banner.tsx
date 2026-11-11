import {
  passwordSaveAction,
  passwordSaveDismissAction,
  passwordSavePrompt,
  type BrowserPasswordSaveState,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, material, radius, space } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { AppText, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * Asks, above the page's foot, whether to keep the login just typed on this
 * phone into a page on the Mac. Only the site and username are here; the
 * password stays on the Mac.
 */
export function PasswordSaveBanner(props: {
  readonly save: BrowserPasswordSaveState;
  readonly onAnswer: (save: boolean) => void;
  readonly bottom: number;
}): ReactNode {
  const prompt = passwordSavePrompt(props.save.offer.offer);
  return (
    <Animated.View
      accessibilityRole="alert"
      entering={appear}
      exiting={exit}
      style={[styles.card, { bottom: props.bottom }]}
    >
      <View style={styles.head}>
        <View style={styles.glyph}>
          <Symbol name="key" size={15} tint={color.ember} weight="semibold" />
        </View>
        <View style={styles.copy}>
          <AppText numberOfLines={2} role="secondaryMedium">
            {prompt.title}
          </AppText>
          {prompt.username ? (
            <AppText numberOfLines={1} role="caption" tone="soft">
              {prompt.username}
            </AppText>
          ) : null}
          <AppText numberOfLines={3} role="caption" tone="muted">
            {prompt.detail}
          </AppText>
        </View>
      </View>
      <View style={styles.actions}>
        <SecondaryButton
          compact
          disabled={props.save.pending}
          label={passwordSaveDismissAction}
          onPress={() => props.onAnswer(false)}
        />
        <PrimaryButton
          busy={props.save.pending}
          compact
          label={passwordSaveAction}
          onPress={() => props.onAnswer(true)}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space[8], justifyContent: "flex-end" },
  card: {
    ...material.float,
    borderRadius: radius.lg,
    gap: space[12],
    left: space[12],
    padding: space[12],
    position: "absolute",
    right: space[12],
  },
  copy: { flex: 1, gap: space[2], minWidth: 0 },
  glyph: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderRadius: radius.sm,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  head: { alignItems: "flex-start", flexDirection: "row", gap: space[10] },
});
