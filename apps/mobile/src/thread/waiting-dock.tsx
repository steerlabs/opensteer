import {
  waitingDraftSave,
  type HostClient,
  type WaitingAsk,
  type WaitingInput,
} from "@opensteer/client/host";
import { useWaitingBody } from "@opensteer/client/react";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import { controlBorderWidth, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { AppText } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";
import { useAskShownWhole } from "./ask-shown.js";
import { ComposerBar, composerLaneHeight } from "./composer-bar.js";
import type { WaitingEditController } from "./waiting-edit.js";
import { failureWords } from "../ui/client-feedback.js";

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
        const detail =
          failureWords(
            error,
            decision === "approve"
              ? { label: "send your answer", done: "sent", happened: "your answer was sent" }
              : { label: "decline this ask", done: "declined", happened: "this ask was declined" },
            decision === "approve"
              ? "Your answer didn’t reach the team."
              : "This ask wasn’t declined.",
          ) ?? "";
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
  readonly hostClient: HostClient;
}): ReactNode {
  const { ask, decisions } = props;
  // A long ask's preview is clipped: Answer waits until its whole text is on screen.
  const body = useWaitingBody(props.hostClient, ask);
  // And unfolded in its bubble: Answer approves what the person can read.
  const whole = useAskShownWhole(ask.messageId) && body.status === "complete";
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
          {elsewhere !== null
            ? `Being edited on ${elsewhere}`
            : body.status === "loading"
              ? "Loading the whole ask…"
              : body.status === "failed"
                ? "Couldn’t load the whole ask."
                : ask.consent.line}
        </AppText>
        {body.status === "failed" && elsewhere === null ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={body.retry}>
            <AppText role="caption" tone="ember">
              Try again
            </AppText>
          </Pressable>
        ) : null}
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
          disabled={locked || elsewhere !== null || !whole}
          fill
          label="Answer"
          onPress={() => {
            if (settled() && whole && body.status === "complete")
              void decisions.decide(ask, "approve", body.revision);
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
 * first, and the answer names the version saved. Words that can't be saved
 * where they are, because the message left or changed under them, go on as a
 * new message instead, or are discarded.
 */
export function WaitingEditBar(props: {
  readonly canRespond: boolean;
  readonly decisions: AskDecisions;
  readonly editing: WaitingEditController;
  /** The item open, or null once it has left the list. */
  readonly item: WaitingInput | null;
  /** The words, and what was attached, on their way into a new message. */
  readonly onSendAsNew: Parameters<WaitingEditController["moveToDraft"]>[0];
}): ReactNode {
  const { decisions, editing, item } = props;
  const edit = editing.edit;
  if (edit === null) return null;
  const { draft } = edit;
  const ask = item?.kind === "ask" ? item : null;
  const saving = edit.phase === "saving";
  const stuck = edit.gone || draft.conflict !== null || edit.phase === "refused";
  const ready =
    props.canRespond &&
    edit.phase === "open" &&
    !edit.gone &&
    waitingDraftSave(draft) !== null &&
    decisions.pending === null;
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
        {stuck ? "Discard" : "Cancel"}
      </AppText>
    </Pressable>
  );
  // Consent names the version on screen: the words are saved first when changed.
  const answer = async (target: WaitingAsk): Promise<void> => {
    const revision = await editing.save();
    if (revision !== null) await decisions.decide(target, "approve", revision);
  };
  const action =
    ask === null && stuck ? (
      // A teammate's words aren't the person's to send as their own.
      edit.kind === "ask" || !draft.dirty ? null : (
        <AnswerPill
          busy={saving}
          disabled={saving}
          label="Send as new message…"
          onPress={() => void editing.moveToDraft(props.onSendAsNew)}
          tone="primary"
        />
      )
    ) : ask === null ? (
      <AnswerPill
        busy={saving}
        disabled={!ready}
        label="Save"
        onPress={() => void editing.save()}
        tone="primary"
      />
    ) : (
      <View style={styles.actions}>
        {draft.dirty ? (
          <AnswerPill
            busy={saving}
            disabled={!ready}
            label="Save"
            onPress={() => void editing.save()}
            tone="secondary"
          />
        ) : null}
        <AnswerPill
          accessibilityHint={ask.consent.line}
          busy={decisions.pending?.messageId === ask.messageId}
          disabled={!ready || ask.approving}
          label={draft.dirty ? "Save and answer" : "Answer"}
          onPress={() => void answer(ask)}
          tone="primary"
        />
      </View>
    );
  return (
    <ComposerBar
      action={<View style={styles.trailing}>{action}</View>}
      {...(ask === null
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
