import { questionTakesTyping, type HostClient, type SurfaceModel } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { color, controlFontScaleLimit, space, type } from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { ComposerBar, composerLaneHeight } from "./composer-bar.js";
import { requestAnswerMaxLength } from "./request-form-model.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useQuestionAnswering } from "./use-question-answering.js";

/**
 * The composer while a question is open: what is typed here is the answer to
 * the question in view on the card above, never a message, so the Thread's
 * draft is exactly where it was when the question has gone.
 */
export function AnswerBar(props: {
  readonly canRespond: boolean;
  readonly canStartResponse: () => boolean;
  readonly gate: ThreadMutationGate;
  readonly hostClient: HostClient;
  /** Null when no Run is holding this question open to stop. */
  readonly onStop: (() => void) | null;
  readonly stopBusy: boolean;
  readonly stopLabel: string;
  readonly surface: SurfaceModel;
}): ReactNode {
  const question = useQuestionAnswering({
    canRespond: props.canRespond,
    canStartResponse: props.canStartResponse,
    gate: props.gate,
    hostClient: props.hostClient,
    surface: props.surface,
  });
  const { draft, field, finishes, responder, step } = question;
  const { session } = responder;
  const typing = questionTakesTyping(field);
  return (
    <ComposerBar
      action={
        step.kind === "blocked" && draft.typed.trim() === "" && props.onStop !== null ? (
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
            disabled={step.kind === "blocked" || !props.canRespond || session.pendingId !== null}
            kind={finishes ? "send" : "next"}
            label={finishes ? "Answer" : "Next"}
            onPress={question.advance}
          />
        )
      }
      field={
        <View style={styles.lane}>
          <TextInput
            accessibilityLabel={field.prompt === "" ? "Your answer" : field.prompt}
            cursorColor={color.ember}
            editable={typing && props.canRespond && session.pendingId === null}
            maxFontSizeMultiplier={controlFontScaleLimit}
            maxLength={requestAnswerMaxLength}
            multiline
            onChangeText={question.type}
            placeholder={
              !typing
                ? "Choose an answer above"
                : (field.choices?.length ?? 0) === 0
                  ? "Type your answer…"
                  : "Type your own answer…"
            }
            placeholderTextColor={color.muted}
            selectionColor={color.ember}
            style={styles.input}
            value={draft.typed}
          />
        </View>
      }
      shape="capsule"
    />
  );
}

const styles = StyleSheet.create({
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
