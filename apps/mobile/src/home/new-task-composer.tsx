import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View, type TextInputInstance } from "react-native";
import { ComposerBar, ComposerGlyph, composerLaneHeight } from "../thread/composer-bar.js";
import {
  color,
  controlFontScaleLimit,
  material,
  pillHeight,
  radius,
  space,
  type,
} from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import type { FolderChoiceView } from "./home-models.js";

/**
 * Home's composer: one ask becomes one task, with an automatic title, in the
 * folder on its chip. At rest it is the capsule over the task list, and its
 * disc starts Voice; typing opens it into the two-row composer with the
 * folder chip in the toolbar. The model lives behind + (AI settings), as it
 * does in a task.
 */
export function NewTaskComposer(props: {
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly folder: FolderChoiceView;
  readonly onChooseFolder: () => void;
  /** The + menu: attach, AI settings. */
  readonly onPlus: () => void;
  readonly onDictate: () => void;
  readonly onStartVoice: () => void;
  readonly onStart: () => void;
  readonly starting: boolean;
  /** Why a task can't start yet ("Connect an AI account to start"), shown above the words. */
  readonly blocked: string | null;
}): ReactNode {
  const input = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);
  const empty = props.text.trim() === "";
  const open = focused || !empty;
  return (
    <ComposerBar
      {...(props.blocked === null || !open
        ? {}
        : {
            caption: (
              <AppText role="caption" tone="muted">
                {props.blocked}
              </AppText>
            ),
          })}
      field={
        <Pressable accessible={false} onPress={() => input.current?.focus()} style={styles.lane}>
          <TextInput
            accessibilityLabel="New task"
            cursorColor={color.ember}
            maxFontSizeMultiplier={controlFontScaleLimit}
            multiline
            onBlur={() => setFocused(false)}
            onChangeText={props.onChangeText}
            onFocus={() => setFocused(true)}
            placeholder="Ask your agent to…"
            placeholderTextColor={color.muted}
            ref={input}
            selectionColor={color.ember}
            style={styles.input}
            value={props.text}
          />
        </Pressable>
      }
      leading={
        <Pressable
          accessibilityLabel="Attach or change the AI"
          accessibilityRole="button"
          onPress={props.onPlus}
        >
          <ComposerGlyph icon="plus" />
        </Pressable>
      }
      {...(open
        ? { accessory: <FolderChip folder={props.folder} onPress={props.onChooseFolder} /> }
        : {})}
      action={
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Dictate"
            accessibilityRole="button"
            onPress={props.onDictate}
          >
            <ComposerGlyph icon="mic" />
          </Pressable>
          {empty ? (
            <Pressable
              accessibilityHint="Talk to Opensteer"
              accessibilityLabel="Voice"
              accessibilityRole="button"
              onPress={props.onStartVoice}
              style={styles.discTarget}
            >
              {({ pressed }) => (
                <View style={[styles.disc, pressed && styles.discPressed]}>
                  <Symbol name="waveform" size={17} tint={color.text} weight="semibold" />
                </View>
              )}
            </Pressable>
          ) : (
            <ComposerAction
              busy={props.starting}
              disabled={props.blocked !== null}
              kind="send"
              label="Start task"
              onPress={props.onStart}
            />
          )}
        </View>
      }
      shape={open ? "rounded" : "capsule"}
    />
  );
}

/** The folder a new task will work in. A task's folder never changes once it starts. */
export function FolderChip(props: {
  readonly folder: FolderChoiceView;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint="Chooses the folder this task works in"
      accessibilityLabel={`Works in ${props.folder.label}`}
      accessibilityRole="button"
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Symbol name={props.folder.home ? "house" : "folder"} size={13} tint={color.muted} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.chipLabel}
      >
        {props.folder.label}
      </AppText>
      <Symbol name="chevron.down" size={11} tint={color.muted} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row" },
  chip: {
    ...material.control,
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    height: pillHeight,
    maxWidth: 200,
    paddingHorizontal: space[10] - 1,
  },
  chipLabel: { color: color.textSoft, flexShrink: 1, fontWeight: "600" },
  chipPressed: { ...material.platePressed },
  disc: {
    ...material.quiet,
    alignItems: "center",
    borderRadius: radius.full,
    height: pillHeight + 2,
    justifyContent: "center",
    width: pillHeight + 2,
  },
  discPressed: { opacity: 0.6 },
  discTarget: { alignItems: "center", height: 44, justifyContent: "center", width: 44 },
  input: {
    color: color.text,
    flex: 1,
    fontSize: type.body.fontSize,
    fontWeight: type.body.fontWeight,
    includeFontPadding: false,
    maxHeight: 160,
    paddingHorizontal: 0,
    paddingVertical: 11,
    textAlignVertical: "top",
  },
  lane: { flex: 1, justifyContent: "center", minHeight: composerLaneHeight },
});
