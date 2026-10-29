import { markColorPaint, workspaceIconArt, workspaceMonogram } from "@opensteer/client/host";
import {
  markColors,
  workspaceIconNames,
  type MarkColor,
  type WorkspaceIconName,
} from "@opensteer/core";
import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, Field } from "./primitives.js";
import { WorkspaceIconGlyph, WorkspaceMark } from "./workspace-mark.js";
import { Symbol } from "./symbol.js";

const target = Platform.OS === "android" ? 48 : touchTarget;

export function ColorChoices(props: {
  readonly value: MarkColor | null;
  readonly disabled?: boolean;
  readonly onChange: (color: MarkColor) => void;
}): ReactNode {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Colour" style={styles.colors}>
      {markColors.map((hue) => (
        <Pressable
          key={hue}
          accessibilityLabel={hue[0]!.toUpperCase() + hue.slice(1)}
          accessibilityRole="radio"
          accessibilityState={{ checked: props.value === hue, disabled: props.disabled ?? false }}
          disabled={props.disabled}
          onPress={() => props.onChange(hue)}
          style={styles.swatchTarget}
        >
          <View
            style={[
              styles.swatch,
              {
                backgroundColor: markColorPaint[hue].tile[0],
                borderColor: props.value === hue ? color.text : color.lineStrong,
              },
            ]}
          >
            {props.value === hue ? (
              <Symbol name="checkmark" size={16} tint={color.text} weight="bold" />
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** The same searchable artwork for task edits and specialist creation/editing. */
export function IconChoices(props: {
  readonly color: MarkColor | null;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly onChange: (icon: WorkspaceIconName | null) => void;
  readonly value: WorkspaceIconName | null;
  readonly task?: boolean;
  readonly horizontal?: boolean;
}): ReactNode {
  const [query, setQuery] = useState("");
  const icons = useMemo(() => {
    const search = query.trim().toLowerCase();
    return workspaceIconNames.filter((icon) =>
      `${workspaceIconArt[icon].label} ${icon}`.toLowerCase().includes(search),
    );
  }, [query]);
  const ink =
    props.task && props.color !== null ? markColorPaint[props.color].glyph : color.textSoft;
  return (
    <View style={props.horizontal ? styles.inline : styles.grid}>
      <Field
        label="Search icons"
        input={{
          value: query,
          onChangeText: setQuery,
          placeholder: "Search icons",
          autoCorrect: false,
          autoCapitalize: "none",
          editable: !props.disabled,
        }}
      />
      <Pressable
        accessibilityLabel={props.task ? "Use default" : "Initials"}
        accessibilityRole="radio"
        accessibilityState={{
          checked: props.value === null || (props.task && props.value === "document"),
          disabled: props.disabled ?? false,
        }}
        disabled={props.disabled}
        onPress={() => props.onChange(null)}
        style={styles.default}
      >
        {props.task ? (
          <WorkspaceIconGlyph color={color.muted} icon="document" size={20} />
        ) : (
          <Text allowFontScaling={false} style={{ color: ink }}>
            {workspaceMonogram(props.name ?? "") || "Aa"}
          </Text>
        )}
        <AppText role="secondary">{props.task ? "Use default" : "Initials"}</AppText>
        {props.value === null || (props.task && props.value === "document") ? (
          <Symbol name="checkmark" size={16} tint={color.ember} />
        ) : null}
      </Pressable>
      <FlatList
        accessibilityRole="radiogroup"
        accessibilityLabel="Icons"
        data={icons}
        extraData={`${props.value}:${props.color}:${props.disabled}`}
        keyExtractor={(icon) => icon}
        horizontal={props.horizontal}
        numColumns={props.horizontal ? 1 : 5}
        columnWrapperStyle={props.horizontal ? undefined : styles.columns}
        initialNumToRender={props.horizontal ? 10 : 30}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.icons}
        ListEmptyComponent={
          <AppText role="secondary" tone="muted">
            No icons match
          </AppText>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityLabel={workspaceIconArt[item].label}
            accessibilityRole="radio"
            accessibilityState={{
              checked: props.value === item && !(props.task && item === "document"),
              disabled: props.disabled ?? false,
            }}
            disabled={props.disabled}
            onPress={() => props.onChange(item)}
            style={[
              styles.icon,
              props.value === item && styles.selected,
              props.disabled && styles.disabled,
            ]}
          >
            {props.task ? (
              <WorkspaceIconGlyph color={ink} icon={item} size={22} />
            ) : (
              <WorkspaceMark color={props.color} icon={item} name={props.name ?? ""} />
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  columns: { justifyContent: "space-between" },
  colors: { flexDirection: "row", flexWrap: "wrap" },
  swatchTarget: { alignItems: "center", justifyContent: "center", width: 48, height: 48 },
  swatch: {
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: radius.full,
    borderWidth: 2,
  },
  default: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: target,
    paddingHorizontal: space[8],
  },
  grid: { flex: 1, minHeight: 0, gap: space[12] },
  inline: { gap: space[8] },
  icon: {
    alignItems: "center",
    justifyContent: "center",
    width: 52,
    height: 52,
    margin: space[2],
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: "transparent",
  },
  selected: { backgroundColor: color.surfaceRaised, borderColor: color.ember },
  disabled: { opacity: 0.6 },
  icons: { paddingBottom: space[12] },
});
