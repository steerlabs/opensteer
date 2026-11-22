import type { BrowserSessionSummary } from "@opensteer/client/host";
import { browserPromptTextMaxLength } from "@opensteer/protocol";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, material, radius, space, touchTarget, type as textType } from "../theme.js";
import { AddressSentence } from "../ui/address-text.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { sentence } from "../ui/sentence-parts.js";
import { Symbol } from "../ui/symbol.js";

/**
 * A page's own alert, confirm or prompt, drawn as the system draws an alert
 * and naming the site that asks, so it is never taken for Opensteer's own. It
 * is the app's view rather than the system alert because the page can answer
 * or withdraw it from another screen, and only a view of the app's own goes
 * away when it does.
 */
export function PageDialog(props: {
  readonly channelReady: boolean;
  readonly dialog: NonNullable<BrowserSessionSummary["dialog"]>;
  readonly onAnswer: (accept: boolean) => void;
  readonly onPrompt: (text: string) => void;
  readonly promptText: string;
  readonly site: string | null;
}): ReactNode {
  const { dialog } = props;
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.dialogScrim}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <View style={styles.dialogFrom}>
          <Symbol name="globe" size={12} tint={color.muted} />
          {props.site === null ? (
            // A page with no web origin (about:blank, data:, file:) is named by no site: these
            // words, never cut, and nothing that looks like a site's name.
            <AppText role="caption" style={styles.dialogSite} tone="muted">
              This page says
            </AppText>
          ) : (
            // A decision with no way to see more: the whole origin, wrapping at its joints.
            <AddressSentence
              parts={sentence`${props.site} says`}
              role="caption"
              style={styles.dialogSite}
              tone="muted"
            />
          )}
        </View>
        <AppText role="secondary" style={styles.dialogMessage}>
          {dialog.message}
        </AppText>
        {dialog.type === "prompt" ? (
          <TextInput
            accessibilityLabel="Your answer"
            autoFocus
            editable={props.channelReady}
            key={dialog.id}
            keyboardAppearance="dark"
            maxLength={browserPromptTextMaxLength}
            onChangeText={props.onPrompt}
            selectionColor={color.ember}
            style={styles.input}
            value={props.promptText}
          />
        ) : null}
        <View style={styles.dialogActions}>
          {dialog.type === "alert" ? null : (
            <Pressable
              accessibilityHint="Dismisses this page’s dialog"
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              onPress={() => props.onAnswer(false)}
              style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}
            >
              <AppText role="secondaryMedium">Cancel</AppText>
            </Pressable>
          )}
          <Pressable
            accessibilityHint="Accepts this page’s dialog"
            accessibilityLabel="OK"
            accessibilityRole="button"
            onPress={() => props.onAnswer(true)}
            style={({ pressed }) => [
              styles.dialogButton,
              styles.dialogPrimary,
              pressed && styles.pressed,
            ]}
          >
            <AppText role="secondaryMedium" style={styles.dialogPrimaryText}>
              OK
            </AppText>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dialog: {
    ...material.float,
    borderRadius: radius.xxl + space[4],
    gap: space[10],
    maxWidth: 320,
    paddingBottom: space[14],
    paddingHorizontal: space[18],
    paddingTop: space[18],
    width: "100%",
  },
  dialogActions: { flexDirection: "row", gap: space[8], marginTop: space[6] },
  dialogButton: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget,
  },
  dialogFrom: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    justifyContent: "center",
  },
  dialogMessage: { textAlign: "center" },
  dialogPrimary: { backgroundColor: color.ember },
  dialogPrimaryText: { color: color.inkOnEmber },
  dialogScrim: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
    padding: space[24],
  },
  dialogSite: { flexShrink: 1 },
  input: {
    ...material.control,
    ...textType.secondary,
    borderRadius: radius.md,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  pressed: { opacity: 0.7 },
});
