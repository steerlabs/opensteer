import type { HostClient, WaitingAsk, WaitingInput } from "@opensteer/client/host";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { controlBorderWidth, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { AppText } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";
import { ComposerBar, composerLaneHeight } from "./composer-bar.js";
import type { WaitingEditController } from "./waiting-edit.js";

/**
 * A docked decision that has just arrived ignores taps for this long, as a
 * Request's card does: it appears under a thumb on its way somewhere else,
 * and an answer to a teammate cannot be taken back.
 */
const arrivalGuardMs = 450;

export interface AskDecisions {
  /** The ask being answered and how, while the Host has it. */
  readonly pending: { readonly messageId: string; readonly decision: "approve" | "decline" } | null;
  readonly failure: { readonly messageId: string; readonly detail: string } | null;
  decide(ask: WaitingAsk, decision: "approve" | "decline", revision?: number): Promise<void>;
}

/**
 * Answers teammates' asks in this task. Approval names the version the person
 * saw, so the Host refuses it if the words changed since; until the team
 * confirms, the ask stays in the list as approving.
 */
export function useAskDecisions(hostClient: HostClient): AskDecisions {
  const aiSharing = useAiSharing();
  const [pending, setPending] = useState<AskDecisions["pending"]>(null);
  const [failure, setFailure] = useState<AskDecisions["failure"]>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const decide = useCallback(
    async (ask: WaitingAsk, decision: "approve" | "decline", revision = ask.revision) => {
      if (busy.current) return;
      // Answering starts the agent on the ask, with the person's AI companies.
      if (decision === "approve" && !(await authorizeAiSharing(aiSharing, hostClient))) return;
      busy.current = true;
      setFailure(null);
      setPending({ decision, messageId: ask.messageId });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await hostClient.decideTeamAsk(
          decision === "approve"
            ? { decision, expectedRevision: revision, requestId: ask.requestId, teamId: ask.teamId }
            : { decision, requestId: ask.requestId, teamId: ask.teamId },
        );
      } catch (error) {
        if (!mounted.current) return;
        const detail = operationDetail(
          error,
          decision === "approve"
            ? "Your answer didn’t reach the team."
            : "This ask wasn’t declined.",
        );
        setFailure({ detail, messageId: ask.messageId });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        void AccessibilityInfo.announceForAccessibility(detail);
      } finally {
        busy.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [aiSharing, hostClient],
  );
  return useMemo(() => ({ decide, failure, pending }), [decide, failure, pending]);
}

/**
 * A teammate's ask, decided where the composer usually is: the ask itself can
 * scroll away on a small screen, and the decision never should. It says who is
 * asking and who will read the answer, then Decline and Answer, full width.
 */
export function WaitingAskDock(props: {
  readonly ask: WaitingAsk;
  readonly canRespond: boolean;
  readonly decisions: AskDecisions;
}): ReactNode {
  const { ask, decisions } = props;
  const arrivedAt = useRef(Date.now());
  const settled = (): boolean => Date.now() - arrivedAt.current >= arrivalGuardMs;
  const pending = decisions.pending?.messageId === ask.messageId ? decisions.pending : null;
  const failure = decisions.failure?.messageId === ask.messageId ? decisions.failure.detail : null;
  const elsewhere = ask.lease.kind === "other" ? ask.lease.deviceLabel : null;
  const locked = !props.canRespond || decisions.pending !== null;
  return (
    <View accessibilityLabel={`${ask.asker} is asking your agent`} style={styles.card}>
      <View style={styles.head}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
          {ask.asker} is asking your agent
        </AppText>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          {elsewhere === null ? ask.consent.line : `Being edited on ${elsewhere}`}
        </AppText>
        {failure === null ? null : (
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        )}
      </View>
      <View style={styles.pair}>
        <AnswerPill
          busy={pending?.decision === "decline"}
          disabled={locked}
          fill
          label="Decline"
          onPress={() => {
            if (settled()) void decisions.decide(ask, "decline");
          }}
          tone="secondary"
        />
        <AnswerPill
          {...(elsewhere === null ? { accessibilityHint: ask.consent.line } : {})}
          busy={pending?.decision === "approve"}
          disabled={locked || elsewhere !== null}
          fill
          label="Answer"
          onPress={() => {
            if (settled()) void decisions.decide(ask, "approve");
          }}
          tone="primary"
        />
      </View>
    </View>
  );
}

/**
 * Stands where the composer was while a waiting message is open in place, and
 * rides the keyboard as the composer does, so Save is in reach whether or not
 * the keyboard is up. An ask's bar answers it too: what was changed is saved
 * first, and the answer names the version saved.
 */
export function WaitingEditBar(props: {
  readonly canRespond: boolean;
  readonly decisions: AskDecisions;
  readonly editing: WaitingEditController;
  /** The item open, or null once it has left the list. */
  readonly item: WaitingInput | null;
  /** The words, and what was attached, on their way into a new message. */
  readonly onSendAsNew: (words: ReturnType<WaitingEditController["takeBack"]>) => void;
}): ReactNode {
  const { decisions, editing, item } = props;
  const edit = editing.edit;
  if (edit === null) return null;
  const ask = item?.kind === "ask" ? item : null;
  const saving = edit.phase === "saving";
  const ready = props.canRespond && edit.phase === "open" && decisions.pending === null;
  const cancel = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: saving }}
      disabled={saving}
      hitSlop={{ bottom: 2, left: 2, top: 2 }}
      onPress={editing.cancel}
      style={styles.cancel}
    >
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium" tone="soft">
        {edit.phase === "taken" ? "Discard" : "Cancel"}
      </AppText>
    </Pressable>
  );
  const answer = async (target: WaitingAsk): Promise<void> => {
    if (!editing.dirty) {
      editing.cancel();
      await decisions.decide(target, "approve");
      return;
    }
    const revision = await editing.save();
    if (revision !== null) await decisions.decide(target, "approve", revision);
  };
  const action =
    edit.phase === "taken" ? (
      <AnswerPill
        label="Send as new message…"
        onPress={() => props.onSendAsNew(editing.takeBack())}
        tone="primary"
      />
    ) : ask === null ? (
      <AnswerPill
        busy={saving}
        disabled={!ready || !editing.savable}
        label="Save"
        onPress={() => void editing.save()}
        tone="primary"
      />
    ) : (
      <View style={styles.actions}>
        {editing.dirty ? (
          <AnswerPill
            busy={saving}
            disabled={!ready || !editing.savable}
            label="Save"
            onPress={() => void editing.save()}
            tone="secondary"
          />
        ) : null}
        <AnswerPill
          accessibilityHint={ask.consent.line}
          busy={decisions.pending?.messageId === ask.messageId}
          disabled={!ready || !editing.savable || ask.approving}
          label={editing.dirty ? "Save and answer" : "Answer"}
          onPress={() => void answer(ask)}
          tone="primary"
        />
      </View>
    );
  return (
    <ComposerBar
      action={<View style={styles.trailing}>{action}</View>}
      {...(ask === null || edit.phase === "taken"
        ? {}
        : {
            caption: (
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={2}
                role="caption"
                tone="muted"
              >
                {ask.consent.line}
              </AppText>
            ),
          })}
      field={<View style={styles.lane} />}
      leading={cancel}
      shape="capsule"
    />
  );
}

const styles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row", gap: space[6] },
  // The text button stands where the `+` does, its touch the bar's full height.
  cancel: {
    justifyContent: "center",
    minHeight: composerLaneHeight,
    paddingHorizontal: space[12],
  },
  // The composer's corner, and a face inset to match it: 20 + 4 is its 24.
  card: { ...material.attention, borderRadius: radius.xxl, overflow: "hidden" },
  head: {
    gap: 1,
    paddingHorizontal: space[14] - controlBorderWidth,
    paddingTop: space[10] - controlBorderWidth,
  },
  lane: { minHeight: composerLaneHeight },
  pair: {
    flexDirection: "row",
    gap: space[6],
    // With the touch's 2 points around the face, 4 to the rim on every side.
    paddingBottom: space[2] - controlBorderWidth,
    paddingHorizontal: space[4] - controlBorderWidth,
    paddingTop: space[6],
  },
  trailing: { paddingRight: space[2] },
});
