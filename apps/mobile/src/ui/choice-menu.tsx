import { MenuView, type MenuAction, type MenuComponentRef } from "@expo/ui/community/menu";
import { useRef, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { Symbol } from "./symbol.js";

export interface MenuChoice {
  readonly destructive?: boolean;
  readonly id: string;
  readonly title: string;
}

/**
 * A small control that opens the platform's own menu of choices: a pull-down
 * on iOS and a Compose menu on Android, so a list of more than three options
 * never has to squeeze into an alert. The label says what it does now or what
 * tapping it chooses; the choices say what each one will do.
 */
export function ChoiceMenu(props: {
  readonly accessibilityLabel: string;
  readonly busy?: boolean;
  readonly choices: readonly MenuChoice[];
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChoose: (id: string) => void;
}): ReactNode {
  const menu = useRef<MenuComponentRef>(null);
  const disabled = props.disabled === true || props.busy === true || props.choices.length === 0;
  const trigger = (
    <View
      accessibilityActions={disabled ? [] : [{ label: props.accessibilityLabel, name: "activate" }]}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy === true, disabled }}
      accessible
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate") menu.current?.show();
      }}
      style={[styles.trigger, disabled && styles.disabled]}
    >
      <Text
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={[type.secondary, styles.label]}
      >
        {props.busy === true ? "Saving…" : props.label}
      </Text>
      <Symbol name="chevron.down" size={11} tint={color.muted} />
    </View>
  );
  if (disabled) return trigger;
  const actions: MenuAction[] = props.choices.map((choice) => ({
    ...(choice.destructive === true ? { attributes: { destructive: true } } : {}),
    id: choice.id,
    title: choice.title,
  }));
  return (
    <MenuView
      actions={actions}
      colorScheme="dark"
      onPressAction={({ nativeEvent }) => props.onChoose(nativeEvent.event)}
      ref={menu}
    >
      {trigger}
    </MenuView>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.5 },
  label: { color: color.text, flexShrink: 1 },
  trigger: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
});
