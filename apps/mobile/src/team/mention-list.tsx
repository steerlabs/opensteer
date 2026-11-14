import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { AgentOrb, Avatar } from "./team-marks.js";
import type { MentionOption } from "./team-models.js";

/**
 * The @ list, right above the composer. My agent is always first; then the
 * people in this place, filtered as the reader types. Someone else's agent
 * appears only when its name is typed, dimmed, and inserting it names it
 * without waking it.
 */
export function MentionList(props: {
  readonly options: readonly MentionOption[];
  readonly onPick: (option: MentionOption) => void;
}): ReactNode {
  if (props.options.length === 0) return null;
  return (
    <View accessibilityRole="menu" style={styles.list}>
      {props.options.map((option, index) => (
        <MentionRow
          first={index === 0}
          key={optionKey(option)}
          onPick={props.onPick}
          option={option}
        />
      ))}
    </View>
  );
}

function optionKey(option: MentionOption): string {
  switch (option.kind) {
    case "my-agent":
      return "my-agent";
    case "person":
      return `person:${option.person.id}`;
    case "agent":
      return `agent:${option.owner.id}`;
  }
}

function MentionRow(props: {
  readonly first: boolean;
  readonly onPick: (option: MentionOption) => void;
  readonly option: MentionOption;
}): ReactNode {
  const { option } = props;
  const disabled = option.kind === "my-agent" && option.disabled;
  const title =
    option.kind === "my-agent"
      ? "My agent"
      : option.kind === "person"
        ? option.person.name
        : option.label;
  const detail =
    option.kind === "my-agent"
      ? option.detail
      : option.kind === "person"
        ? `@${option.person.handle}${option.person.externalTeam ? ` · External · ${option.person.externalTeam}` : ""}`
        : `Ask ${option.owner.name.split(" ")[0]}${option.owner.externalTeam ? ` · External · ${option.owner.externalTeam}` : ""}`;
  return (
    <Pressable
      accessibilityHint={option.kind === "agent" ? detail : undefined}
      accessibilityLabel={title}
      accessibilityRole="menuitem"
      accessibilityState={{ disabled }}
      // A disabled My agent still answers a tap: it says where the agent lives.
      onPress={() => props.onPick(option)}
      style={({ pressed }) => [
        styles.row,
        !props.first && styles.separated,
        option.kind === "my-agent" && !disabled && styles.mine,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.mark, disabled && styles.dim]}>
        {option.kind === "my-agent" ? (
          <AgentOrb size={26} />
        ) : (
          <Avatar
            agent={option.kind === "agent"}
            ground={color.surfaceElevated}
            person={option.kind === "person" ? option.person : option.owner}
            presence={option.kind === "person"}
            size={28}
          />
        )}
      </View>
      <View style={styles.words}>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
          style={
            disabled ? styles.titleDim : option.kind === "my-agent" ? styles.titleMine : undefined
          }
        >
          {title}
        </AppText>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={disabled ? 2 : 1}
          role="caption"
          tone="muted"
        >
          {detail}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dim: { opacity: 0.5 },
  list: { ...material.float, borderRadius: radius.lg, overflow: "hidden" },
  mark: { alignItems: "center", width: 28 },
  mine: { backgroundColor: "rgba(255, 255, 255, 0.04)" },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[14],
    paddingVertical: space[6],
  },
  separated: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  titleDim: { color: color.muted },
  titleMine: { fontWeight: "600" },
  words: { flex: 1, minWidth: 0 },
});
