import {
  optionsSummary,
  reasoningLevel,
  accessModeOptions,
  accessModeUnavailableReason,
} from "@opensteer/client/host";
import type { ModelSelection, ThreadAccessMode } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import {
  color,
  material,
  controlFontScaleLimit,
  pillHeight,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import { EngineMark } from "./settings/engine-mark.js";

/** One execution choice; its sheet owns model options and access. */
export function ComposerPills(props: {
  readonly accessMode: ThreadAccessMode;
  readonly accessModes: readonly ThreadAccessMode[] | null;
  readonly blockedReason?: string | null | undefined;
  readonly disabledReason: string | null;
  readonly driverKind?: string | undefined;
  readonly engineName: string;
  readonly modelLabel: string;
  readonly model: HarnessModelDescriptor | null;
  readonly modelOptions: ModelSelection["options"];
  readonly onOpenModel: () => void;
  readonly onPresent: () => void;
}): ReactNode {
  const accessLabel =
    accessModeOptions.find((option) => option.mode === props.accessMode)?.label ?? props.accessMode;
  const reasoningLabel = props.model ? optionsSummary(props.model, props.modelOptions) : null;
  const level = props.model ? reasoningLevel(props.model, props.modelOptions) : null;
  const label = `${props.engineName} · ${props.modelLabel}`;
  const fullLabel = `AI: ${label}${reasoningLabel === null ? "" : ` · ${reasoningLabel}`}`;
  const blockedReason =
    props.blockedReason ??
    props.model?.unavailableReason ??
    accessModeUnavailableReason(props.accessMode, props);
  const blocked = blockedReason !== null;
  const summary =
    [reasoningLabel, blocked ? "Unavailable" : null].filter(Boolean).join(" · ") || null;
  // The model and its effort read as one phrase, "GPT-6.1 Terra Extra high".
  // Short of room the effort gives way to its bars first; only the model alone
  // is ever shortened.
  const fit = useFittedForm(
    [[props.modelLabel, summary], [props.modelLabel]].map((words) =>
      words.filter(Boolean).join(" "),
    ),
  );
  return (
    <View onLayout={fit.onLane}>
      <Pressable
        accessibilityHint={[
          "Opens AI settings",
          `Access: ${accessLabel}`,
          blockedReason,
          props.disabledReason,
        ]
          .filter(Boolean)
          .join(". ")}
        accessibilityLabel={fullLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabledReason !== null }}
        onPress={() => {
          if (props.disabledReason !== null) {
            Alert.alert(fullLabel, props.disabledReason);
            return;
          }
          props.onPresent();
          props.onOpenModel();
        }}
        style={({ pressed }) => [styles.touch, pressed && styles.pressed]}
      >
        <View onLayout={fit.onPill} style={styles.pill}>
          <EngineMark driverKind={props.driverKind ?? ""} />
          <Text
            ellipsizeMode="tail"
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            onLayout={fit.onText}
            style={[styles.name, blocked && styles.blocked]}
          >
            {props.modelLabel}
            {fit.form !== props.modelLabel && summary ? (
              <Text style={styles.summary}> {summary}</Text>
            ) : null}
          </Text>
          {fit.form === props.modelLabel && level ? (
            <View accessible={false} style={styles.level}>
              {Array.from({ length: level.steps }, (_, index) => (
                <View
                  key={index}
                  style={[
                    styles.levelBar,
                    // Rising from 40% to the full 12 points, like the web meter.
                    { height: 12 * (0.4 + (0.6 * index) / Math.max(1, level.steps - 1)) },
                    index < level.level && styles.levelBarOn,
                  ]}
                />
              ))}
            </View>
          ) : null}
          <Symbol
            name={blocked ? "exclamationmark.circle" : "chevron.down"}
            size={12}
            tint={blocked ? color.red : color.muted}
          />
        </View>
      </Pressable>
      {fit.gauge}
    </View>
  );
}

/**
 * The longest form whose natural width fits beside the capsule's mark and
 * chevron in the lane it is given. Text here shortens only from its tail,
 * which would cut the model's name before the words that matter less; each
 * form is measured whole, out of sight, instead. Until everything is
 * measured the capsule says it all.
 */
function useFittedForm(forms: readonly string[]): {
  readonly form: string;
  readonly gauge: ReactNode;
  readonly onLane: (event: LayoutChangeEvent) => void;
  readonly onPill: (event: LayoutChangeEvent) => void;
  readonly onText: (event: LayoutChangeEvent) => void;
} {
  const [lane, setLane] = useState<number | null>(null);
  const [pill, setPill] = useState<number | null>(null);
  const [text, setText] = useState<number | null>(null);
  const [natural, setNatural] = useState<Readonly<Record<string, number>>>({});
  const distinct = [...new Set(forms)];
  const room = lane !== null && pill !== null && text !== null ? lane - (pill - text) : null;
  const measured = distinct.every((form) => natural[form] !== undefined);
  const form =
    room === null || !measured
      ? forms[0]!
      : (forms.find((candidate) => natural[candidate]! <= room + 0.5) ?? forms.at(-1)!);
  const width = (set: (value: number) => void) => (event: LayoutChangeEvent) =>
    set(event.nativeEvent.layout.width);
  return {
    form,
    gauge: (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.gauge}
      >
        {distinct.map((candidate) => (
          <Text
            key={candidate}
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            onLayout={(event) => {
              const measuredWidth = event.nativeEvent.layout.width;
              setNatural((current) =>
                current[candidate] === measuredWidth
                  ? current
                  : { ...current, [candidate]: measuredWidth },
              );
            }}
            style={styles.name}
          >
            {candidate}
          </Text>
        ))}
      </View>
    ),
    onLane: width(setLane),
    onPill: width(setPill),
    onText: width(setText),
  };
}

const styles = StyleSheet.create({
  pill: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: "100%",
    minHeight: pillHeight,
    paddingHorizontal: space[10] - (1 - StyleSheet.hairlineWidth),
  },
  blocked: { color: color.red },
  level: { alignItems: "flex-end", flexDirection: "row", gap: 1.5, height: 12 },
  levelBar: { backgroundColor: color.lineStrong, borderRadius: 1, width: 2 },
  levelBarOn: { backgroundColor: color.muted },
  summary: { color: color.muted, fontWeight: "400" },
  // Wide enough that no form wraps or shortens while it is measured.
  gauge: {
    alignItems: "flex-start",
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 10000,
  },
  name: { ...type.caption, color: color.textSoft, flexShrink: 1, fontWeight: "600" },
  pressed: { opacity: 0.6 },
  touch: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    minWidth: 0,
    justifyContent: "center",
    minHeight: touchTarget,
  },
});
