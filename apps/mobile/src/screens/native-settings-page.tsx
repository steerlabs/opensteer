import { FlatList, TextInput, View, ScrollView, Pressable, Alert } from "react-native";
import { AppText, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useState } from "react";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
export function NativeSettingsPage(props: NativeSettingsPageProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = props.sections.flatMap((section) => [
    { key: `${section.key}:heading`, kind: "heading" as const, section },
    ...(!section.collapsed || expanded.has(section.key)
      ? section.rows.map((row) => ({ ...row, key: `${section.key}:${row.key}` }))
      : []),
  ]);
  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          props.search ? (
            <TextInput
              accessibilityLabel="Search plugins"
              placeholder="Search plugins"
              value={props.search.value}
              onChangeText={props.search.onChange}
              style={{ minHeight: 48 }}
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 8 }}>
            {item.kind === "heading" ? (
              item.section.collapsed ? (
                <SecondaryButton
                  label={`${item.section.title}${expanded.has(item.section.key) ? " · Hide" : " · Show"}`}
                  onPress={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(item.section.key)) next.delete(item.section.key);
                      else next.add(item.section.key);
                      return next;
                    })
                  }
                />
              ) : (
                <AppText role="bodyMedium">{item.section.title}</AppText>
              )
            ) : (
              <Row row={item} />
            )}
          </View>
        )}
      />
    </Screen>
  );
}
function Row({ row }: { readonly row: NativeSettingsRow }) {
  if (row.kind === "chips")
    return (
      <ScrollView horizontal>
        {row.choices.map((choice) => (
          <Pressable
            key={choice.value}
            accessibilityRole="button"
            accessibilityLabel={choice.label}
            accessibilityState={{ selected: row.value === choice.value }}
            onPress={() => row.onChange(choice.value)}
            style={{ minHeight: 48, padding: 12 }}
          >
            <AppText>
              {row.value === choice.value ? "✓ " : ""}
              {choice.label}
            </AppText>
          </Pressable>
        ))}
      </ScrollView>
    );
  if (row.kind === "text") return <AppText>{row.label}</AppText>;
  if (row.kind === "button")
    return (
      <View>
        <SecondaryButton
          label={row.label}
          disabled={row.disabled ?? false}
          onPress={row.onPress}
          tone={row.destructive ? "danger" : "default"}
        />
        {row.actions?.length ? (
          <SecondaryButton
            label={`More actions for ${row.label}`}
            onPress={() =>
              Alert.alert(row.label, undefined, [
                ...row.actions!.map((action) => ({
                  text: action.label,
                  style: action.destructive ? ("destructive" as const) : ("default" as const),
                  onPress: action.onPress,
                })),
                { text: "Cancel", style: "cancel" },
              ])
            }
          />
        ) : null}
      </View>
    );
  if (row.kind === "toggle")
    return (
      <SwitchRow
        label={row.label}
        disabled={row.disabled ?? false}
        value={row.value}
        onChange={row.onChange}
      />
    );
  return (
    <TextInput
      accessibilityLabel={row.label}
      placeholder={row.label}
      secureTextEntry={row.secure ?? false}
      value={row.value}
      onChangeText={row.onChange}
      autoCapitalize="none"
      autoCorrect={false}
      style={{ minHeight: 48 }}
    />
  );
}
