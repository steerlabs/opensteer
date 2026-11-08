import type { HostClient, SurfaceModel } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { color, controlFontScaleLimit, space, type } from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { ComposerBar, composerLaneHeight } from "./composer-bar.js";
import {
  requestAnswerMaxLength,
  requestDraftValues,
  withRequestDraftValues,
} from "./request-form-model.js";
import { updateRequestSession } from "./request-session.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useRequestResponse } from "./use-request-response.js";

/**
 * One open question, answered in the bar where a person already types. Its words
 * go to the agent and never join the Thread's draft, so what was being written
 * before the question came is still there after it.
 */
export function AnswerBar(props: {
  readonly canRespond: boolean;
  readonly canStartResponse: () => boolean;
  readonly fieldId: string;
  readonly gate: ThreadMutationGate;
  readonly hostClient: HostClient;
  /** Null when no Run is holding this question open to stop. */
  readonly onStop: (() => void) | null;
  readonly question: string;
  readonly stopBusy: boolean;
  readonly stopLabel: string;
  readonly surface: SurfaceModel;
}): ReactNode {
  const responder = useRequestResponse({
    canRespond: props.canRespond,
    canStartResponse: props.canStartResponse,
    gate: props.gate,
    hostClient: props.hostClient,
    surface: props.surface,
  });
  const { session } = responder;
  const { fieldId } = props;
  const answer = requestDraftValues(session.answers, fieldId)[0] ?? "";
  const change = (value: string): void =>
    updateRequestSession(session, {
      answers: withRequestDraftValues(session.answers, fieldId, value === "" ? [] : [value]),
    });
  const blank = answer.trim() === "";
  return (
    <ComposerBar
      action={
        blank && props.onStop !== null ? (
          <ComposerAction
            busy={props.stopBusy}
            disabled={props.stopBusy || !props.canRespond}
            kind="stop"
            label={props.stopLabel}
            onPress={props.onStop}
          />
        ) : (
          <ComposerAction
            busy={session.pendingId === "form"}
            disabled={blank || !props.canRespond || session.pendingId !== null}
            kind="send"
            label="Send answer"
            onPress={() =>
              void responder.submit({ answers: { [fieldId]: [answer] }, kind: "form" }, "form")
            }
          />
        )
      }
      caption={
        <View style={styles.caption}>
          <AppText role="secondaryMedium">{props.question}</AppText>
          {session.failure === null ? null : (
            <AppText role="caption" tone="danger">
              {session.failure}
            </AppText>
          )}
        </View>
      }
      field={
        <View style={styles.lane}>
          <TextInput
            accessibilityLabel={props.question}
            cursorColor={color.ember}
            maxFontSizeMultiplier={controlFontScaleLimit}
            maxLength={requestAnswerMaxLength}
            multiline
            onChangeText={change}
            placeholder="Answer…"
            placeholderTextColor={color.muted}
            selectionColor={color.ember}
            style={styles.input}
            value={answer}
          />
        </View>
      }
      shape="capsule"
    />
  );
}

const styles = StyleSheet.create({
  caption: { gap: space[2] },
  input: {
    color: color.text,
    fontSize: type.body.fontSize,
    fontWeight: type.body.fontWeight,
    includeFontPadding: false,
    maxHeight: type.body.lineHeight * 6,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
    textAlignVertical: "top",
  },
  lane: { flex: 1, justifyContent: "center", minHeight: composerLaneHeight },
});
