import { VoiceContext } from "@opensteer/client/react";
import type { VoiceSnapshot } from "@opensteer/client/voice";
import * as Haptics from "expo-haptics";
import type { HostClient } from "@opensteer/client/host";
import { useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { ActionLine, issueLine, type ActionLineValue } from "../ui/action-line.js";
import { notSentIssue } from "../ui/connection-live.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { voiceBarHeight } from "./controls.js";
import { useVoiceValue } from "./use-voice-value.js";

const selectAvailable = ({ available }: VoiceSnapshot) => available;

/**
 * Where a composer would stand on the Voice Thread: the one thing to do here,
 * and what it runs on. A call's bar takes this exact place.
 */
export function VoiceStartBar(props: {
  /** The computer the call would start on: offline, Talk says it didn't start. */
  readonly hostClient: HostClient;
  readonly modelLabel: string;
  /** Why the model cannot change right now, or null. */
  readonly modelHold: string | null;
  readonly onChooseModel: () => void;
}): ReactNode {
  const controller = useContext(VoiceContext);
  const available = useVoiceValue(selectAvailable);
  const ready = controller !== null && available;
  const held = props.modelHold !== null;
  const [line, setLine] = useState<ActionLineValue | null>(null);
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.column}>
      {ready ? null : (
        <AppText role="caption" style={styles.reason} tone="muted">
          Voice isn’t available right now. Check that Codex is signed in on your computer.
        </AppText>
      )}
      <View style={styles.bar}>
        <Pressable
          accessibilityLabel="Talk to Opensteer"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => {
            // A call needs the computer: offline it isn't started, and says so here.
            const unsent = notSentIssue(props.hostClient, "started");
            if (unsent !== null) {
              setLine(issueLine(unsent, `voice:${Date.now()}`));
              return;
            }
            setLine(null);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void controller?.start();
          }}
          style={({ pressed }) => [
            styles.talk,
            pressed && material.accentPressed,
            !ready && styles.dim,
          ]}
        >
          <Symbol name="waveform" size={17} tint={color.inkOnEmber} weight="semibold" />
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.talkLabel}
          >
            Talk to Opensteer
          </AppText>
        </Pressable>
        <Pressable
          accessibilityHint={props.modelHold ?? "Changes the model this conversation runs on"}
          accessibilityLabel={`Model: ${props.modelLabel}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: held }}
          disabled={held}
          onPress={() => props.onChooseModel()}
          style={({ pressed }) => [styles.model, pressed && material.quiet, held && styles.dim]}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            style={styles.modelLabel}
            tone="soft"
          >
            {props.modelLabel}
          </AppText>
          <Symbol name="chevron.down" size={11} tint={color.muted} weight="semibold" />
        </Pressable>
      </View>
      {line === null ? null : (
        <View style={styles.line}>
          <ActionLine line={line} onDismiss={() => setLine(null)} />
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[4],
    minHeight: voiceBarHeight,
    padding: space[6],
  },
  column: { gap: space[8] },
  dim: { opacity: 0.45 },
  line: { paddingHorizontal: space[12] },
  model: {
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    flexShrink: 1,
    gap: space[4],
    justifyContent: "center",
    maxWidth: "42%",
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  modelLabel: { flexShrink: 1 },
  reason: { paddingHorizontal: space[12], textAlign: "center" },
  talk: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.full,
    flex: 1,
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[14],
  },
  talkLabel: { color: color.inkOnEmber, flexShrink: 1 },
});
