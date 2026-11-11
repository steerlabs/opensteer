import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText, Toggle } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";

/**
 * The rows team pages are built from, inside the app's `RowGroup` plates: a
 * row that goes somewhere (with its current value), and a row that switches.
 */
export function LinkRow(props: {
  readonly icon?: SFSymbolName;
  readonly mark?: ReactNode;
  readonly label: string;
  readonly value?: string | null;
  readonly detail?: string | null;
  readonly onPress: () => void;
  readonly tone?: "default" | "danger" | "ember";
  /** No chevron: the row acts rather than goes. */
  readonly action?: boolean;
  readonly disabled?: boolean;
}): ReactNode {
  const tint =
    props.tone === "danger" ? color.red : props.tone === "ember" ? color.ember : color.muted;
  return (
    <Pressable
      accessibilityHint={props.detail ?? undefined}
      accessibilityLabel={props.value ? `${props.label}, ${props.value}` : props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.pressed,
        props.disabled === true && styles.disabled,
      ]}
    >
      {props.mark ??
        (props.icon === undefined ? null : <Symbol name={props.icon} size={17} tint={tint} />)}
      <View style={styles.words}>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="body"
          style={
            props.tone === "danger"
              ? styles.danger
              : props.tone === "ember"
                ? styles.ember
                : undefined
          }
        >
          {props.label}
        </AppText>
        {props.detail ? (
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={2}
            role="caption"
            tone="muted"
          >
            {props.detail}
          </AppText>
        ) : null}
      </View>
      {props.value ? (
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="secondary"
          style={styles.value}
        >
          {props.value}
        </AppText>
      ) : null}
      {props.action === true ? null : (
        <Symbol name="chevron.right" size={13} tint={color.mutedDim} weight="semibold" />
      )}
    </Pressable>
  );
}

export function SwitchSettingRow(props: {
  readonly icon?: SFSymbolName;
  readonly mark?: ReactNode;
  readonly label: string;
  readonly detail: string | null;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}): ReactNode {
  return (
    <View style={styles.row}>
      {props.mark ??
        (props.icon === undefined ? null : (
          <Symbol name={props.icon} size={17} tint={color.muted} />
        ))}
      <View style={styles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="body">
          {props.label}
        </AppText>
        {props.detail === null ? null : (
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
            {props.detail}
          </AppText>
        )}
      </View>
      <Toggle
        accessibilityHint={props.detail ?? undefined}
        accessibilityLabel={props.label}
        disabled={props.disabled}
        onChange={props.onChange}
        value={props.value}
      />
    </View>
  );
}

/** A note under a group of rows: what the setting above it means. */
export function GroupNote(props: { readonly children: string }): ReactNode {
  return (
    <AppText role="caption" style={styles.note} tone="muted">
      {props.children}
    </AppText>
  );
}

const styles = StyleSheet.create({
  danger: { color: color.red },
  disabled: { opacity: 0.45 },
  ember: { color: color.ember },
  note: { paddingHorizontal: space[4] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 6,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  value: { color: color.muted, flexShrink: 1, maxWidth: "45%" },
  words: { flex: 1, gap: 1, minWidth: 0 },
});
