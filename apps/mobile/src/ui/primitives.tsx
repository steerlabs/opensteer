import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  color,
  material,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";

/**
 * The pieces every screen is built from.
 *
 * There is no component here that only decorates. A pressed state, a spinner,
 * a status dot and its pulse each answer something the person did or needs to
 * know, and nothing here moves for any other reason.
 */

export type TextRole = keyof typeof type;

export function AppText(props: {
  /** What the text means beyond its words, for a screen reader: a phone has no tooltip. */
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly children: ReactNode;
  /** Which end a one-line text gives up; `head` keeps the newest words of a live caption. */
  readonly ellipsizeMode?: "head" | "tail";
  /** Set only where a fixed-height control would clip the text it holds. */
  readonly maxFontSizeMultiplier?: number;
  readonly numberOfLines?: number;
  readonly selectable?: boolean;
  readonly role?: TextRole;
  readonly tone?: "default" | "soft" | "muted" | "ember" | "emberDim" | "danger";
  readonly style?: StyleProp<TextStyle>;
}): ReactNode {
  const role = props.role ?? "body";
  return (
    <Text
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel}
      ellipsizeMode={props.ellipsizeMode}
      maxFontSizeMultiplier={props.maxFontSizeMultiplier}
      numberOfLines={props.numberOfLines}
      selectable={props.selectable}
      style={[type[role], { color: textTone(props.tone ?? "default") }, props.style]}
    >
      {props.children}
    </Text>
  );
}

function textTone(tone: "default" | "soft" | "muted" | "ember" | "emberDim" | "danger"): string {
  switch (tone) {
    case "danger":
      return color.red;
    case "ember":
      return color.ember;
    case "emberDim":
      return color.emberDim;
    case "muted":
      return color.muted;
    case "soft":
      return color.textSoft;
    case "default":
      return color.text;
  }
}

/**
 * A set of rows that belong together, drawn as one plate with a hairline
 * between each row — the shape the web's directory,
 * its option rows and its settings groups all share.
 *
 * It is what turns a stack of text into a list: the frame says where the list
 * starts and stops, so no row has to shout to be seen as one.
 */
export function RowGroup(props: { readonly children: readonly ReactNode[] }): ReactNode {
  const rows = props.children.filter((row) => row !== null && row !== false);
  return (
    <View style={styles.rowGroup}>
      {rows.map((row, index) => (
        // A group's rows are written out at the call site in a fixed order, so
        // the position in the frame is the identity: nothing here reorders.
        <View key={index} style={index === 0 ? undefined : styles.rowGroupSeparated}>
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * The name of a group of rows. It is sentence case in the quiet weight because
 * it is a signpost, not a heading: the rows under it are the screen's subject
 * and nothing above them should compete.
 */
export function SectionLabel(props: { readonly children: string }): ReactNode {
  return (
    <AppText role="secondaryMedium" tone="muted">
      {props.children}
    </AppText>
  );
}

export function PrimaryButton(props: {
  readonly busy?: boolean;
  /**
   * Sizes the button to its label instead of the line it sits on. A full-width
   * ember bar is the loudest thing a screen can hold, which is right for the
   * one action a step exists for and wrong for an action offered beside a list.
   */
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const disabled = props.disabled === true || props.busy === true;
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy ?? false, disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        props.compact === true && styles.buttonCompact,
        pressed && styles.primaryButtonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      {props.busy === true ? (
        <ActivityIndicator color={color.inkOnEmber} />
      ) : (
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          style={[type.action, styles.primaryButtonLabel]}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton(props: {
  readonly accessibilityLabel?: string;
  readonly busy?: boolean;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  /** Red for an act that takes something away, so the colour is the warning. */
  readonly tone?: "default" | "danger";
}): ReactNode {
  const danger = props.tone === "danger";
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy ?? false, disabled: props.disabled ?? false }}
      disabled={props.disabled === true || props.busy === true}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        props.compact === true && styles.buttonCompact,
        danger && styles.secondaryButtonDanger,
        pressed && (danger ? styles.secondaryButtonDangerPressed : styles.secondaryButtonPressed),
        (props.disabled === true || props.busy === true) && styles.buttonDisabled,
      ]}
    >
      {props.busy === true ? (
        <ActivityIndicator color={danger ? color.red : color.ember} />
      ) : (
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          style={[
            props.compact === true ? type.secondaryMedium : type.action,
            danger ? styles.secondaryButtonDangerLabel : styles.secondaryButtonLabel,
          ]}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * One of the doors on the Deployments empty state, and the rows of the
 * add-deployment sheet: a title, and the sentence that says who it is for.
 */
export function ChoiceRow(props: {
  readonly description: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.choiceRow,
        pressed && styles.rowPressed,
        props.disabled === true && styles.buttonDisabled,
      ]}
    >
      <AppText role="bodyMedium">{props.title}</AppText>
      <AppText role="secondary" tone="muted">
        {props.description}
      </AppText>
    </Pressable>
  );
}

/**
 * One setting that is on or off, stated as what it turns on. The label is the
 * whole control: there is no second line explaining what a switch does, because
 * a switch that needs one is named wrong.
 */
export function SwitchRow(props: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: boolean) => void;
  readonly value: boolean;
}): ReactNode {
  return (
    <View style={styles.switchRow}>
      <AppText role="body" style={styles.switchLabel}>
        {props.label}
      </AppText>
      <Switch
        accessibilityLabel={props.label}
        disabled={props.disabled}
        ios_backgroundColor={color.surfaceRaised}
        onValueChange={props.onChange}
        thumbColor={color.text}
        trackColor={{ false: color.surfaceRaised, true: color.ember }}
        value={props.value}
      />
    </View>
  );
}

/**
 * One state, as a colour. With `live` it breathes: that is the whole of how the
 * app says something is happening right now rather than merely being in a
 * state, and it is the one motion on screen that is not answering a touch — so
 * it is slow, shallow, and kept for work in progress and connections being
 * made. Reanimated skips it for anyone who has asked the system for less
 * movement; the colour alone still says the state.
 */
export function StatusDot(props: {
  readonly live?: boolean;
  /** Points across; a task's line uses the smaller dot beside its words. */
  readonly size?: 6 | 8;
  /** `ember` is the agent itself at work somewhere, as a live computer-use session is. */
  readonly tone: "green" | "amber" | "red" | "muted" | "ember";
}): ReactNode {
  const reduceMotion = useReducedMotion();
  const breathing = props.live === true && !reduceMotion;
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (!breathing) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [breathing, opacity]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[
        styles.statusDot,
        props.size === undefined ? null : { height: props.size, width: props.size },
        { backgroundColor: dotColor(props.tone) },
        animated,
      ]}
    />
  );
}

/**
 * Three dots rising in turn: someone composing a message. Under Reduce Motion
 * they hold still at a middle ink, which still reads as a message on its way.
 * `inline` is the same dots at the size of the words they follow, for a line
 * of text that is still being worked on.
 */
export function TypingDots(props: { readonly inline?: boolean }): ReactNode {
  const inline = props.inline === true;
  return (
    <View style={inline ? styles.typingDotsInline : styles.typingDots}>
      <TypingDot delay={0} inline={inline} />
      <TypingDot delay={150} inline={inline} />
      <TypingDot delay={300} inline={inline} />
    </View>
  );
}

function TypingDot(props: { readonly delay: number; readonly inline: boolean }): ReactNode {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(reduceMotion ? 0.6 : 0.3);
  useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withDelay(
      props.delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 360, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.3, { duration: 360, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(opacity);
  }, [opacity, props.delay, reduceMotion]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[props.inline ? styles.typingDotInline : styles.typingDot, animated]} />
  );
}

function dotColor(tone: "green" | "amber" | "red" | "muted" | "ember"): string {
  switch (tone) {
    case "ember":
      return color.ember;
    case "amber":
      return color.amber;
    case "green":
      return color.green;
    case "muted":
      return color.muted;
    case "red":
      return color.red;
  }
}

export function Field(props: {
  readonly hint?: string;
  readonly hintPosition?: "before" | "after";
  readonly label: string;
  readonly input: TextInputProps;
}): ReactNode {
  const hint =
    props.hint === undefined ? null : (
      <AppText role="caption" tone="muted">
        {props.hint}
      </AppText>
    );
  return (
    <View style={styles.field}>
      <AppText role="secondaryMedium" tone="soft">
        {props.label}
      </AppText>
      {props.hintPosition === "before" ? hint : null}
      <TextInput
        accessibilityHint={props.hint}
        accessibilityLabel={props.label}
        {...props.input}
        cursorColor={color.ember}
        maxFontSizeMultiplier={controlFontScaleLimit}
        placeholderTextColor={color.muted}
        selectionColor={color.ember}
        style={[type.body, styles.input]}
      />
      {props.hintPosition === "before" ? null : hint}
    </View>
  );
}

/**
 * What happened, and what to do next. Both halves are required: a failure with
 * no next step is a dead end, and this app has none.
 */
export function Notice(props: {
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly detail: string;
  readonly title: string;
  readonly tone?: "danger" | "neutral";
}): ReactNode {
  const danger = props.tone !== "neutral";
  return (
    <View style={[styles.notice, danger ? styles.noticeDanger : styles.noticeNeutral]}>
      <AppText role="secondaryMedium" tone={danger ? "danger" : "default"}>
        {props.title}
      </AppText>
      <AppText role="secondary" tone="soft">
        {props.detail}
      </AppText>
      {props.action === undefined ? null : (
        <SecondaryButton label={props.action.label} onPress={props.action.onPress} />
      )}
    </View>
  );
}

/**
 * A small control that states one current choice and opens the sheet that
 * changes it. The label is the choice, never the category: "Supervised", not
 * "Access: Supervised".
 */
export function Chip(props: {
  readonly accessibilityLabel: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const disabled = props.disabled === true || props.busy === true;
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={space[6]}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chip,
        pressed && styles.chipPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={[type.caption, styles.chipLabel]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The one place text stops wrapping: a command or a file is one long line. */
export const monoFontFamily = Platform.select({ android: "monospace", default: "Menlo" });

/**
 * Verbatim output — a command, a patch, a stack trace — inside its own scroller
 * so a long line moves sideways within the block instead of widening the page.
 *
 * Every block can be copied, because verbatim text on a phone is almost always
 * on its way somewhere else: a terminal, a message, a search. The control is
 * quiet caption text on the block's own top line; it says "Copied" for a
 * moment because the clipboard gives no other sign.
 */
export function CodeBlock(props: { readonly label?: string; readonly text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reset.current !== null) clearTimeout(reset.current);
    },
    [],
  );

  const copy = (): void => {
    void Clipboard.setStringAsync(props.text).then(
      () => {
        void Haptics.selectionAsync();
        setCopied(true);
        if (reset.current !== null) clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopied(false), 1500);
      },
      () => Alert.alert("Copy unavailable", "Please try again."),
    );
  };

  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHead}>
        <AppText numberOfLines={1} role="caption" style={styles.codeLabel} tone="muted">
          {props.label ?? ""}
        </AppText>
        <Pressable
          accessibilityLabel={copied ? "Copied" : "Copy this block"}
          accessibilityRole="button"
          hitSlop={space[12]}
          onPress={copy}
          style={styles.codeCopy}
        >
          <AppText role="caption" tone={copied ? "ember" : "muted"}>
            {copied ? "Copied" : "Copy"}
          </AppText>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={styles.codeScroll}
        // A code block inside a transcript must not steal the vertical drag.
        directionalLockEnabled
      >
        <Text selectable style={[type.caption, styles.codeText]}>
          {props.text}
        </Text>
      </ScrollView>
    </View>
  );
}

export function Divider(): ReactNode {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  buttonCompact: { alignSelf: "flex-start", paddingHorizontal: space[14] - 1 },
  buttonDisabled: { opacity: 0.45 },
  rowGroup: {
    ...material.plate,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  rowGroupSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  switchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    justifyContent: "space-between",
    minHeight: touchTarget,
  },
  switchLabel: { flexShrink: 1 },
  // The composer's one accent belongs to Send; execution choices stay neutral.
  chip: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    maxWidth: 200,
    minHeight: 32,
    paddingHorizontal: space[12] - 1,
  },
  chipLabel: { color: color.textSoft },
  chipPressed: { ...material.platePressed },
  codeBlock: {
    // The web's own code ground, a step darker than the surface it sits on, at
    // the web's own measure: verbatim output needs room around it to be read as
    // a separate voice rather than as indented prose.
    backgroundColor: color.surfaceCode,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  codeCopy: { justifyContent: "center" },
  codeHead: { alignItems: "center", flexDirection: "row", gap: space[12] },
  codeLabel: { flex: 1 },
  codeScroll: { maxHeight: 320 },
  codeText: { color: color.textSoft, fontFamily: monoFontFamily },
  choiceRow: {
    borderRadius: radius.md,
    gap: space[4],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[14],
  },
  divider: { backgroundColor: color.line, height: StyleSheet.hairlineWidth },
  field: { gap: space[6] },
  input: {
    ...material.control,
    borderRadius: radius.sm,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  notice: {
    ...material.plate,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[14],
  },
  noticeDanger: { backgroundColor: color.redWash, borderColor: color.redLine },
  noticeNeutral: { ...material.plate },
  primaryButton: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.sm,
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[20] - 1,
    paddingVertical: space[12] - 1,
  },
  primaryButtonLabel: { color: color.inkOnEmber },
  primaryButtonPressed: { ...material.accentPressed },
  rowPressed: { ...material.quiet },
  secondaryButton: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.sm,
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[20],
    paddingVertical: space[12],
  },
  secondaryButtonDanger: { borderColor: color.redLine },
  secondaryButtonDangerLabel: { color: color.red },
  secondaryButtonDangerPressed: { backgroundColor: color.redWash },
  secondaryButtonLabel: { color: color.text },
  secondaryButtonPressed: { ...material.platePressed },
  statusDot: { borderRadius: radius.full, height: 8, width: 8 },
  typingDot: { backgroundColor: color.muted, borderRadius: radius.full, height: 7, width: 7 },
  typingDotInline: { backgroundColor: color.muted, borderRadius: radius.full, height: 3, width: 3 },
  typingDots: { flexDirection: "row", gap: 5 },
  typingDotsInline: { flexDirection: "row", gap: 2.5 },
});
