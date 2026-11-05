import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { memo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import type { NewTaskDraftSummary } from "../client/thread-drafts.js";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * A new task not yet sent. Discarding is a long press, as a task's actions are:
 * a sideways drag here already belongs to the drawer. A message the Host has not
 * answered may already be a task, so only opening it can settle it.
 */
export const DraftRow = memo(function DraftRow(props: {
  readonly draft: NewTaskDraftSummary;
  readonly onDiscard: (draft: NewTaskDraftSummary) => void;
  readonly onOpen: (draft: NewTaskDraftSummary) => void;
}): ReactNode {
  const { draft, onDiscard, onOpen } = props;
  const menu = useRef<MenuComponentRef>(null);
  // The native menu sizes itself to what it holds, so the row inside it is
  // given the width the list gave the row.
  const [width, setWidth] = useState<number | null>(null);
  const inMenu = !draft.held && width !== null;

  const content = (
    <Pressable
      accessibilityActions={draft.held ? [] : [{ label: "Discard draft", name: "discard" }]}
      accessibilityHint="Opens this draft"
      accessibilityLabel={`Draft, ${draft.title}${draft.held ? ", not confirmed" : ""}`}
      accessibilityRole="button"
      onAccessibilityAction={(event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === "discard") onDiscard(draft);
      }}
      onLongPress={
        // Android's menu opens from this handle; iOS opens its context menu
        // from the long press itself.
        !draft.held && Platform.OS === "android" ? () => menu.current?.show() : undefined
      }
      onPress={() => onOpen(draft)}
      style={({ pressed }) => [styles.row, inMenu && { width }, pressed && styles.pressed]}
    >
      <View style={styles.mark}>
        <Symbol name="pencil" size={11} tint={color.muted} />
      </View>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={styles.title}
      >
        {draft.title}
      </AppText>
      {draft.held ? (
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          Not confirmed
        </AppText>
      ) : null}
    </Pressable>
  );

  if (draft.held) return content;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {inMenu ? (
        <MenuView
          actions={[
            { attributes: { destructive: true }, id: "discard", image: "trash", title: "Discard" },
          ]}
          colorScheme="dark"
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "discard") onDiscard(draft);
          }}
          ref={menu}
          shouldOpenOnLongPress
        >
          {content}
        </MenuView>
      ) : (
        content
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  mark: {
    alignItems: "center",
    borderColor: color.muted,
    borderRadius: radius.full,
    borderStyle: "dashed",
    borderWidth: 1,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  pressed: { ...material.quiet },
  row: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    cursor: "pointer",
    flexDirection: "row",
    gap: space[12],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    paddingHorizontal: space[12] - 1,
  },
  title: { color: color.textSoft, flex: 1, minWidth: 0 },
});
