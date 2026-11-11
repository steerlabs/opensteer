import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, space, touchTarget } from "../theme.js";
import { AppText, PrimaryButton, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import type { ComputerChoiceView, FolderChoiceView, FolderEntryView } from "./home-models.js";

/**
 * Where a new task works: recent folders first (tasks' and channels'), then
 * the computers whose folders can be browsed. A computer that can't hold a
 * task right now is listed, dimmed, with the reason, so its absence is never
 * a mystery. Presented as the 60% form sheet.
 */
export function FolderSheetBody(props: {
  readonly recent: readonly FolderChoiceView[];
  readonly computers: readonly ComputerChoiceView[];
  readonly onChoose: (folderId: string) => void;
  readonly onBrowse: (computerId: string) => void;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={styles.sheet}>
      <AppText role="title" style={styles.heading}>
        Work in
      </AppText>
      {props.recent.length === 0 ? null : (
        <View style={styles.group}>
          <SectionLabel>Recent</SectionLabel>
          <RowGroup>
            {props.recent.map((folder) => (
              <SheetRow
                detail={folder.detail}
                icon={folder.home ? "house" : "folder"}
                key={folder.id}
                label={folder.label}
                onPress={() => props.onChoose(folder.id)}
                selected={folder.current}
              />
            ))}
          </RowGroup>
        </View>
      )}
      <View style={styles.group}>
        <SectionLabel>Choose a folder on</SectionLabel>
        <RowGroup>
          {props.computers.map((computer) => (
            <SheetRow
              detail={computer.unavailable}
              disabled={computer.unavailable !== null}
              icon={computerIcon(computer.kind)}
              key={computer.id}
              label={computer.name}
              onPress={() => props.onBrowse(computer.id)}
              push
            />
          ))}
        </RowGroup>
      </View>
    </ScrollView>
  );
}

/**
 * A computer's folders, pushed inside the sheet: folders only, read from its
 * Runner, with the folder being looked at offered at the bottom.
 */
export function FolderBrowserBody(props: {
  /** "~/code". */
  readonly path: string;
  readonly entries: readonly FolderEntryView[] | null;
  readonly failure: string | null;
  readonly onOpen: (path: string) => void;
  readonly onNewFolder: () => void;
  readonly onUse: () => void;
  /** "opensteer": the last part of `path`. */
  readonly name: string;
}): ReactNode {
  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.sheet}>
        <AppText numberOfLines={1} role="caption" tone="muted">
          {props.path}
        </AppText>
        {props.failure !== null ? (
          <AppText role="secondary" tone="danger">
            {props.failure}
          </AppText>
        ) : props.entries === null ? (
          <AppText role="secondary" tone="muted">
            Reading folders…
          </AppText>
        ) : (
          <RowGroup>
            {[
              ...props.entries.map((entry) => (
                <SheetRow
                  icon="folder"
                  key={entry.path}
                  label={entry.name}
                  onPress={() => props.onOpen(entry.path)}
                  push
                />
              )),
              <SheetRow
                icon="plus"
                key="new"
                label="New folder…"
                onPress={props.onNewFolder}
                tone="ember"
              />,
            ]}
          </RowGroup>
        )}
      </ScrollView>
      <View style={styles.use}>
        <PrimaryButton label={`Use “${props.name}”`} onPress={props.onUse} prominent />
      </View>
    </View>
  );
}

function computerIcon(kind: ComputerChoiceView["kind"]): SFSymbolName {
  return kind === "laptop" ? "laptopcomputer" : kind === "mini" ? "macmini" : "desktopcomputer";
}

function SheetRow(props: {
  readonly detail?: string | null;
  readonly disabled?: boolean;
  readonly icon: SFSymbolName;
  readonly label: string;
  readonly onPress: () => void;
  readonly push?: boolean;
  readonly selected?: boolean;
  readonly tone?: "ember";
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true, selected: props.selected === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.pressed,
        props.disabled === true && styles.disabled,
      ]}
    >
      <Symbol
        name={props.icon}
        size={17}
        tint={props.tone === "ember" ? color.ember : color.muted}
      />
      <View style={styles.words}>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="body"
          style={props.tone === "ember" ? styles.ember : undefined}
        >
          {props.label}
        </AppText>
        {props.detail ? (
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            tone="muted"
          >
            {props.detail}
          </AppText>
        ) : null}
      </View>
      {props.selected === true ? (
        <Symbol name="checkmark" size={16} tint={color.ember} weight="semibold" />
      ) : null}
      {props.push === true && props.disabled !== true ? (
        <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.5 },
  ember: { color: color.ember },
  fill: { flex: 1 },
  group: { gap: space[8] },
  heading: { paddingHorizontal: space[4] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[14],
    paddingVertical: space[6],
  },
  sheet: { gap: space[16], padding: space[16] },
  use: {
    ...material.float,
    borderRadius: 0,
    borderWidth: 0,
    paddingBottom: space[24],
    paddingHorizontal: space[16],
    paddingTop: space[12],
  },
  words: { flex: 1, minWidth: 0 },
});
