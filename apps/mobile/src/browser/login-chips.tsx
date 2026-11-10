import type { BrowserAutofillOffer } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import {
  color,
  controlBorderWidth,
  controlFontScaleLimit,
  pillHeight,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { enterInTurn, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * The saved logins the page offered for the field being typed into, as the
 * system's keyboard offers passwords above its keys: one chip each, the
 * username alone unless two would read the same. A row too long for the bar
 * scrolls.
 */
export function LoginChips(props: {
  readonly offer: BrowserAutofillOffer;
  /** The login being confirmed or filled; the others wait. */
  readonly busy: string | null;
  readonly onChoose: (loginId: string) => void;
}): ReactNode {
  const { accounts, role } = props.offer;
  const names = accounts.map(({ username }) => username.toLowerCase());
  return (
    <Animated.View exiting={exit} style={styles.strip}>
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
      >
        {accounts.map((account, index) => {
          const alike = names.indexOf(names[index]!) !== names.lastIndexOf(names[index]!);
          const name = account.username || account.label || "Saved login";
          const label = alike && account.username ? account.label : null;
          const busy = props.busy === account.id;
          const waiting = props.busy !== null && !busy;
          return (
            <Animated.View entering={enterInTurn(index)} key={account.id}>
              <Pressable
                accessibilityHint={
                  role === "code" ? "Fills its verification code" : "Fills this saved login"
                }
                accessibilityLabel={[name, label].filter(Boolean).join(", ")}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: props.busy !== null }}
                disabled={props.busy !== null}
                onPress={() => props.onChoose(account.id)}
                style={styles.target}
              >
                {({ pressed }) => (
                  <View style={[styles.face, pressed && styles.pressed, waiting && styles.waiting]}>
                    <View style={styles.glyph}>
                      {busy ? (
                        <ActivityIndicator
                          color={color.ember}
                          size="small"
                          style={styles.spinner}
                        />
                      ) : (
                        <Symbol
                          name={role === "code" ? "123.rectangle" : "key"}
                          size={15}
                          tint={color.ember}
                          weight="semibold"
                        />
                      )}
                    </View>
                    <AppText
                      maxFontSizeMultiplier={controlFontScaleLimit}
                      numberOfLines={1}
                      role="secondaryMedium"
                      style={styles.name}
                    >
                      {name}
                    </AppText>
                    {label === null ? null : (
                      <AppText
                        maxFontSizeMultiplier={controlFontScaleLimit}
                        numberOfLines={1}
                        role="caption"
                        style={styles.label}
                        tone="muted"
                      >
                        {label}
                      </AppText>
                    )}
                  </View>
                )}
              </Pressable>
            </Animated.View>
          );
        })}
      </ScrollView>
      <View pointerEvents="none" style={[styles.fade, styles.fadeStart]} />
      <View pointerEvents="none" style={[styles.fade, styles.fadeEnd]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  face: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderColor: color.emberLine,
    borderRadius: radius.full,
    borderWidth: controlBorderWidth,
    flexDirection: "row",
    gap: space[6],
    // Wide enough for most addresses, narrow enough that a second chip shows there is more.
    maxWidth: 216,
    minHeight: pillHeight,
    paddingEnd: space[14] - controlBorderWidth,
    paddingStart: space[10] - controlBorderWidth,
    paddingVertical: space[4] - controlBorderWidth,
  },
  // Chips scroll under the bar's gaps rather than stopping hard against their neighbours.
  fade: { bottom: 0, position: "absolute", top: 0, width: space[8] },
  fadeEnd: {
    backgroundImage: `linear-gradient(to right, ${color.background}00, ${color.background})`,
    end: 0,
  },
  fadeStart: {
    backgroundImage: `linear-gradient(to left, ${color.background}00, ${color.background})`,
    start: 0,
  },
  glyph: { alignItems: "center", height: 16, justifyContent: "center", width: 16 },
  label: { flexShrink: 0, maxWidth: 88 },
  name: { flexShrink: 1 },
  pressed: { backgroundColor: color.emberLine, transform: [{ scale: 0.97 }] },
  row: { alignItems: "center", gap: space[8], paddingHorizontal: space[8] },
  spinner: { transform: [{ scale: 0.75 }] },
  strip: { flex: 1, marginHorizontal: -space[8], minWidth: 0 },
  target: { justifyContent: "center", minHeight: touchTarget },
  waiting: { opacity: 0.45 },
});
