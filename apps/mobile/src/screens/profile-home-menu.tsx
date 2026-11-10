import type { ProfileHomeChoice, ProfileHomeOption } from "@opensteer/client/host";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { color, controlFontScaleLimit, space, touchTarget, type } from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import { computerSymbols } from "./settings-model.js";

/** This phone, as the phone itself says it; every other device by its name. */
export function homeName(option: Pick<ProfileHomeOption, "here" | "name">): string {
  if (!option.here) return option.name;
  return Platform.OS === "ios" ? "This iPhone" : "This phone";
}

/** The device a new profile keeps its sign-ins on, chosen inside its name field. */
export function HomeMenu(props: {
  readonly disabled: boolean;
  readonly home: string;
  readonly homes: ProfileHomeChoice;
  readonly onChoose: (id: string) => void;
}): ReactNode {
  const chosen = props.homes.options.find(({ id }) => id === props.home)!;
  const name = homeName(chosen);
  const trigger = (
    <View
      accessibilityLabel={`Keep its sign-ins on ${name}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      accessible
      style={[styles.homeTrigger, props.disabled && styles.disabled]}
    >
      <Symbol name={computerSymbols[chosen.glyph]} size={15} tint={color.muted} />
      <Text
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={[type.secondary, styles.homeName]}
      >
        {name}
      </Text>
      <Symbol name="chevron.down" size={11} tint={color.muted} />
    </View>
  );
  if (props.disabled) return trigger;
  return (
    <MenuView
      actions={props.homes.options.map((option) => ({
        id: option.id,
        image: computerSymbols[option.glyph],
        state: option.id === props.home ? ("on" as const) : ("off" as const),
        title: homeName(option),
      }))}
      onPressAction={({ nativeEvent }) => props.onChoose(nativeEvent.event)}
      style={styles.homeMenu}
      title="Keep its sign-ins on"
    >
      {trigger}
    </MenuView>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.5 },
  homeName: { color: color.muted, flexShrink: 1 },
  homeMenu: { alignSelf: "stretch", flexShrink: 1, maxWidth: "50%" },
  homeTrigger: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
});
