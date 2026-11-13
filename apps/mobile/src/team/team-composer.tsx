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
  touchTarget,
  type,
} from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { StagedAttachments } from "./attachments.js";
import { MentionList } from "./mention-list.js";
import { AgentOrb, PeopleOnlyBadge } from "./team-marks.js";
import type { AgentReach, MentionOption, StagedAttachmentView } from "./team-models.js";

export interface TeamComposerProps {
  /** "Message #support", "Reply…", "Message Maya". */
  readonly placeholder: string;
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly onSelectionChange?: (selection: {
    readonly start: number;
    readonly end: number;
  }) => void;
  readonly agent: AgentReach;
  readonly toMyAgent: boolean;
  readonly sticky?: boolean;
  readonly onToMyAgentChange: (on: boolean) => void;
  /** Asking with no Opensteer linked: opens "Connect your Opensteer". */
  readonly onAgentUnavailable: () => void;
  /** The @ list's rows while the reader is typing a mention; null when closed. */
  readonly mentions: readonly MentionOption[] | null;
  readonly onPickMention: (option: MentionOption) => void;
  /** Starts a mention: the parent inserts "@" where the cursor is. */
  readonly onMention: () => void;
  readonly attachments: readonly StagedAttachmentView[];
  readonly onAttach: () => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onSend: () => void;
  /** A one-time line above the composer, such as the hint after joining. */
  readonly hint?: ReactNode;
}

/**
 * The composer every team place shares.
 *
 * At rest it is the app's capsule with "Ask my agent" labelled at its end, at
 * thumb height. Focused or holding a draft it opens: the words on top, then
 * attach, @, the pill and send. With "to my agent" on, the rim turns ember and
 * the agent's chip leads the words; × or a backspace at the start turns it off.
 *
 * In a people-only place the pill is a People only badge. With no Opensteer
 * linked the pill still shows, and asking explains how to connect one.
 */
export function TeamComposer(props: TeamComposerProps): ReactNode {
  const input = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);
  const refused = props.attachments.some((file) => file.refused !== null);
  const uploading = props.attachments.some(
    (file) => file.progress !== null && file.refused === null,
  );
  const hasContent = props.text.trim() !== "" || props.attachments.length > 0;
  const toMyAgent = props.toMyAgent && props.agent === "available";
  const open = focused || hasContent || toMyAgent;
  const askPill =
    props.agent === "people-only" ? (
      <View style={styles.badgeSlot}>
        <PeopleOnlyBadge />
      </View>
    ) : (
      <AskMyAgentPill
        on={toMyAgent}
        onPress={() => {
          if (props.agent === "not-connected") props.onAgentUnavailable();
          else props.onToMyAgentChange(!toMyAgent);
        }}
      />
    );
  return (
    <View style={styles.stack}>
      {props.mentions === null ? null : (
        <MentionList onPick={props.onPickMention} options={props.mentions} />
      )}
      {props.hint ?? null}
      {props.sticky && (toMyAgent || props.agent === "available") ? (
        <Pressable accessibilityRole="button" onPress={() => props.onToMyAgentChange(!toMyAgent)}>
          <AppText role="caption" tone="muted">
            {toMyAgent ? "→ your agent ✕" : "+ your agent"}
          </AppText>
        </Pressable>
      ) : null}
      <View style={[styles.rim, toMyAgent && !props.sticky && styles.rimOn]}>
        <ComposerBar
          {...(props.attachments.length === 0 && !uploading
            ? {}
            : {
                caption: (
                  <View style={styles.caption}>
                    <StagedAttachments
                      files={props.attachments}
                      onRemove={props.onRemoveAttachment}
                    />
                    {uploading ? (
                      <AppText role="caption" style={styles.captionLine} tone="muted">
                        Sends when uploads finish
                      </AppText>
                    ) : null}
                  </View>
                ),
              })}
          field={
            <Pressable
              accessible={false}
              onPress={() => input.current?.focus()}
              style={styles.lane}
            >
              {toMyAgent && !props.sticky ? (
                <Pressable
                  accessibilityHint="Turns off asking your agent"
                  accessibilityLabel="To my agent"
                  accessibilityRole="button"
                  onPress={() => props.onToMyAgentChange(false)}
                  style={styles.agentChip}
                >
                  <AgentOrb size={14} />
                  <AppText
                    maxFontSizeMultiplier={controlFontScaleLimit}
                    role="secondaryMedium"
                    style={styles.agentChipText}
                  >
                    My agent
                  </AppText>
                </Pressable>
              ) : null}
              <TextInput
                accessibilityLabel={toMyAgent ? "Ask your agent" : props.placeholder}
                cursorColor={color.ember}
                maxFontSizeMultiplier={controlFontScaleLimit}
                multiline
                onBlur={() => setFocused(false)}
                onChangeText={props.onChangeText}
                onFocus={() => setFocused(true)}
                onKeyPress={(event) => {
                  if (toMyAgent && event.nativeEvent.key === "Backspace" && props.text === "") {
                    props.onToMyAgentChange(false);
                  }
                }}
                onSelectionChange={(event) =>
                  props.onSelectionChange?.(event.nativeEvent.selection)
                }
                placeholder={toMyAgent ? "Ask your agent…" : props.placeholder}
                placeholderTextColor={color.muted}
                ref={input}
                selectionColor={color.ember}
                style={styles.input}
                value={props.text}
              />
            </Pressable>
          }
          leading={
            <View style={styles.row}>
              <Pressable
                accessibilityLabel="Attach files"
                accessibilityRole="button"
                onPress={props.onAttach}
              >
                <ComposerGlyph icon="paperclip" />
              </Pressable>
              {open ? (
                <Pressable
                  accessibilityLabel="Mention someone"
                  accessibilityRole="button"
                  onPress={props.onMention}
                >
                  <ComposerGlyph icon="at" />
                </Pressable>
              ) : null}
            </View>
          }
          {...(open && !props.sticky ? { accessory: askPill } : {})}
          action={
            open ? (
              <ComposerAction
                busy={false}
                disabled={!hasContent || refused}
                kind="send"
                label={toMyAgent ? "Send to my agent" : "Send"}
                onPress={props.onSend}
              />
            ) : (
              <View style={styles.restAction}>{props.sticky ? null : askPill}</View>
            )
          }
          shape={open ? "rounded" : "capsule"}
        />
      </View>
    </View>
  );
}

/** "Ask my agent" with the orb; on, it is ember and reads "To my agent ×". */
export function AskMyAgentPill(props: {
  readonly on: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={
        props.on ? "Turns off asking your agent" : "This message will ask your agent"
      }
      accessibilityLabel={props.on ? "To my agent" : "Ask my agent"}
      accessibilityRole="switch"
      accessibilityState={{ checked: props.on }}
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.pill,
        props.on && styles.pillOn,
        pressed && styles.pillPressed,
      ]}
    >
      <AgentOrb size={16} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={props.on ? styles.pillLabelOn : styles.pillLabel}
      >
        {props.on ? "To my agent" : "Ask my agent"}
      </AppText>
      {props.on ? <Symbol name="xmark" size={11} tint={color.ember} weight="bold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  agentChip: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.emberWash,
    borderRadius: radius.xs,
    flexDirection: "row",
    gap: space[4],
    marginRight: space[6],
    marginTop: 9,
    paddingHorizontal: space[6],
    paddingVertical: 2,
  },
  agentChipText: { color: color.ember, fontWeight: "600" },
  badgeSlot: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[6] },
  caption: { gap: space[6], marginHorizontal: -space[14] },
  captionLine: { paddingHorizontal: space[14] },
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
  lane: { alignItems: "flex-start", flex: 1, flexDirection: "row", minHeight: composerLaneHeight },
  pill: {
    ...material.control,
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    height: pillHeight,
    paddingLeft: space[8] - 1,
    paddingRight: space[12] - 1,
  },
  pillLabel: { color: color.textSoft, fontWeight: "600" },
  pillLabelOn: { color: color.ember, fontWeight: "700" },
  pillOn: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  pillPressed: { opacity: 0.7 },
  restAction: { justifyContent: "center", minHeight: touchTarget, paddingRight: space[4] },
  rim: { borderColor: "transparent", borderRadius: 26, borderWidth: 1 },
  // The attention rim: the one sign, before sending, that this message wakes an agent.
  rimOn: { borderColor: "rgba(230, 190, 176, 0.55)" },
  row: { flexDirection: "row" },
  stack: { gap: space[8] },
});
