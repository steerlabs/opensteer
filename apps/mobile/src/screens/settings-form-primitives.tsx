import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { type SettingsActionModel } from "./settings-model.js";

export function Section(props: {
  readonly children: ReactNode;
  readonly footer?: string;
  readonly label: string;
}): ReactNode {
  return (
    <View style={styles.section}>
      <SectionLabel>{props.label}</SectionLabel>
      {props.children}
      {props.footer === undefined ? null : (
        <AppText role="caption" tone="muted">
          {props.footer}
        </AppText>
      )}
    </View>
  );
}

/**
 * A row about one thing: its mark, its name and a line under it. With
 * `onPress` it opens that thing, and says so with a chevron.
 */
export function LinkRow(props: {
  readonly accessibilityLabel?: string;
  readonly detail: string;
  readonly lead: ReactNode;
  readonly onPress: (() => void) | null;
  readonly title: string;
  /** A word before the chevron naming what the row does. */
  readonly trailing?: string;
}): ReactNode {
  const label = props.accessibilityLabel ?? `${props.title}, ${props.detail}`;
  const body = (
    <>
      {props.lead}
      <View style={[styles.text, styles.grow]}>
        <AppText role="body">{props.title}</AppText>
        <AppText role="secondary" tone="muted">
          {props.detail}
        </AppText>
      </View>
    </>
  );
  if (props.onPress === null) {
    return (
      <View accessible accessibilityLabel={label} style={styles.linkRow}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      {body}
      {props.trailing === undefined ? null : (
        <AppText role="secondary" tone="muted">
          {props.trailing}
        </AppText>
      )}
      <Symbol name="chevron.right" size={13} tint={color.muted} />
    </Pressable>
  );
}

/** A row's glyph on a quiet tile, so the list is scanned by shape before it is read. */
export function Tile(props: { readonly symbol: SFSymbolName }): ReactNode {
  return (
    <View style={styles.tile}>
      <Symbol name={props.symbol} size={16} tint={color.textSoft} />
    </View>
  );
}

export function actionRow(
  action: SettingsActionModel | null,
  onPress: () => void,
  key: string,
): ReactNode {
  return action === null ? null : (
    <View key={key} style={styles.actionRow}>
      <SecondaryButton
        disabled={action.disabled}
        label={action.label}
        onPress={onPress}
        tone={action.destructive === true ? "danger" : "default"}
      />
    </View>
  );
}

/**
 * The person, as one letter. It is neutral rather than tinted: a deployment's
 * mark carries a colour because there are several of them to tell apart, and
 * there is only ever one person signed in here.
 */
export function AvatarInitial(props: { readonly initial: string }): ReactNode {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.avatar}
    >
      <Text allowFontScaling={false} style={styles.avatarInitial}>
        {props.initial}
      </Text>
    </View>
  );
}

export function ErrorText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <AppText role="secondary" tone="danger">
        {props.detail}
      </AppText>
    </View>
  );
}

export const styles = StyleSheet.create({
  actionRow: { alignItems: "flex-start", padding: space[16] },
  avatar: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  avatarInitial: { color: color.textSoft, fontSize: 13, fontWeight: "700" },
  content: { gap: space[24], paddingTop: space[16] },
  grow: { flex: 1 },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  linkRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: { gap: space[8], padding: space[16] },
  rowInline: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[16],
  },
  section: { gap: space[8] },
  text: { flexShrink: 1, gap: space[2] },
  tile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xs,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
});
