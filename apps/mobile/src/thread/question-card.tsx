import {
  isQuestionOptionChosen,
  questionTakesTyping,
  type HostClient,
  type SurfaceModel,
} from "@opensteer/client/host";
import { requestTitleText } from "@opensteer/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { pushSubagent } from "../navigation-ref.js";
import {
  color,
  controlBorderWidth,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { ActionLine } from "../ui/action-line.js";
import { Symbol } from "../ui/symbol.js";
import { AnswerPill, AnswerRow } from "./answer-pill.js";
import { AskerByline, useRequestAsker } from "./asker-byline.js";
import { requestTitle } from "./docked-requests.js";
import { questionHeading } from "./request-answers.js";
import { arrivalGuardMs, WaitingMenu } from "./request-card.js";
import { requestAnswerMaxLength } from "./request-form-model.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useQuestionAnswering } from "./use-question-answering.js";

/** Past this the agent's note is folded to three lines, with More to read the rest. */
const detailFoldLength = 140;

export interface QuestionRequestCardProps {
  readonly canRespond: boolean;
  readonly canStartResponse: () => boolean;
  /**
   * What the composer under the card is holding. `answer`: this question's
   * answer, so the card has only its options. `message`: the person's own
   * draft, so the card offers to switch. Null: no composer is there, and the
   * card takes a typed answer itself.
   */
  readonly composer: "answer" | "message" | null;
  readonly deploymentId: string;
  readonly disabledReason: string | null;
  readonly highlighted: boolean;
  readonly hostClient: HostClient;
  readonly mutationGate: ThreadMutationGate;
  /** The composer is holding the message draft: hand it to this answer instead. */
  readonly onAnswerHere?: () => void;
  /** The composer is answering although a draft is waiting: give it back to the draft. */
  readonly onBackToMessage?: () => void;
  readonly showQueue?: boolean;
  readonly asker?: boolean;
  readonly surface: SurfaceModel;
}

/**
 * A question an agent asked: its options as a list to tap, a step at a time
 * when it asks several. Tapping a single choice answers it; any other answer is
 * typed in the composer below, or in the card where no composer stands.
 */
export function QuestionRequestCard(props: QuestionRequestCardProps): ReactNode {
  const { deploymentId, surface } = props;
  const { request } = surface;
  const { presentation } = request;
  const question = useQuestionAnswering({
    canRespond: props.canRespond,
    canStartResponse: props.canStartResponse,
    gate: props.mutationGate,
    hostClient: props.hostClient,
    surface,
  });
  const { draft, field, fields, index, responder, step } = question;
  const { session } = responder;
  const { height } = useWindowDimensions();
  const asked = useRequestAsker(props.hostClient, request);
  const asker = props.asker === false ? null : asked;
  const queue =
    props.showQueue === false ? null : (
      <WaitingMenu
        deploymentId={deploymentId}
        hostClient={props.hostClient}
        requestId={request.id}
      />
    );
  const { heading, prompt } = questionHeading(requestTitle(request), field.prompt);
  const detail = presentation.detail ?? "";
  const [unfolded, setUnfolded] = useState(false);
  const folds = detail.length > detailFoldLength || detail.split("\n").length > 3;

  useEffect(() => {
    void AccessibilityInfo.announceForAccessibility(
      `Opensteer needs your input. ${requestTitleText(presentation)}`,
    );
  }, [request.id, presentation]);

  const scroller = useRef<ScrollViewInstance>(null);
  const [scroll, setScroll] = useState({ box: 0, content: 0, offset: 0 });
  // Each question starts at its top, and says so when its options run on below.
  useEffect(() => {
    scroller.current?.scrollTo({ animated: false, y: 0 });
    scroller.current?.flashScrollIndicators();
  }, [index]);

  // Arriving right above the composer, the card is under a thumb already on
  // its way somewhere: a tap in its first moment never sends.
  const arrivedAt = useRef(Date.now());
  const settled = (): boolean => Date.now() - arrivedAt.current >= arrivalGuardMs;

  const reason = session.pendingId === null ? props.disabledReason : null;
  const locked = session.pendingId !== null;
  const several = fields.length > 1;
  const multi = field.multiSelect;
  const choices = field.choices ?? [];
  const typedHere = props.composer === null && questionTakesTyping(field);
  // The composer's own send is Next or Answer while it is the answer field.
  const advanceHere = props.composer !== "answer" && step.kind !== "blocked";

  return (
    <View style={[styles.card, props.highlighted && styles.cardHighlighted]}>
      {asker === null ? null : (
        <View style={styles.asker}>
          <AskerByline
            asker={asker}
            hostClient={props.hostClient}
            onOpen={() =>
              pushSubagent({ deploymentId, nodeId: asker.nodeId, threadId: asker.threadId })
            }
            trailing={queue}
          />
        </View>
      )}
      <View style={[styles.head, asker !== null && styles.headAfterAsker]}>
        <AppText
          {...(asker === null ? {} : { accessibilityLabel: `${asker.title} asks: ${heading}` })}
          role="secondaryMedium"
          style={styles.heading}
        >
          {heading}
        </AppText>
        {asker === null ? queue : null}
      </View>
      <View>
        <ScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(_, content) => setScroll((now) => ({ ...now, content }))}
          onLayout={(event) => {
            const box = event.nativeEvent.layout.height;
            setScroll((now) => ({ ...now, box }));
          }}
          onScroll={(event) => {
            const offset = event.nativeEvent.contentOffset.y;
            setScroll((now) => ({ ...now, offset }));
          }}
          ref={scroller}
          scrollEventThrottle={32}
          // Bounded so the composer and keyboard stay in view; long options scroll here.
          style={{ maxHeight: Math.max(160, Math.min(height * 0.32, 320)) }}
        >
          {detail === "" ? null : (
            <View style={styles.detail}>
              <AppText
                role="caption"
                tone="soft"
                {...(folds && !unfolded ? { numberOfLines: 3 } : {})}
              >
                {detail}
              </AppText>
              {folds ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={space[10]}
                  onPress={() => setUnfolded(!unfolded)}
                  style={styles.fold}
                >
                  <AppText role="caption" tone="ember">
                    {unfolded ? "Less" : "More"}
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          )}
          {several ? (
            <View style={styles.stepper}>
              <StepButton
                disabled={index === 0}
                icon="chevron.left"
                label="Previous question"
                onPress={() => question.go(index - 1)}
              />
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                role="caption"
                style={styles.stepLabel}
                tone="muted"
              >
                Question {index + 1} of {fields.length}
              </AppText>
              <StepButton
                disabled={index === fields.length - 1}
                icon="chevron.right"
                label="Next question"
                onPress={() => question.go(index + 1)}
              />
            </View>
          ) : null}
          {prompt === null ? null : (
            <AppText role="secondary" style={styles.prompt}>
              {prompt}
            </AppText>
          )}
          {choices.length === 0 ? null : (
            <View
              accessibilityRole={multi ? undefined : "radiogroup"}
              style={[styles.options, prompt === null && !several && styles.optionsAfterHead]}
            >
              {choices.map((choice, position) => {
                const chosen = isQuestionOptionChosen(draft, choice.value);
                const busy = session.pendingId === `option:${choice.value}`;
                return (
                  <Pressable
                    accessibilityHint={
                      multi
                        ? "Choose any"
                        : step.kind === "send" || !several
                          ? "Sends this answer"
                          : "Chooses this answer and moves on"
                    }
                    accessibilityLabel={[choice.label, choice.description]
                      .filter(Boolean)
                      .join(", ")}
                    accessibilityRole={multi ? "checkbox" : "radio"}
                    accessibilityState={{ busy, checked: chosen, disabled: locked }}
                    disabled={locked}
                    // Values are not required to be unique; their position is.
                    key={`${position}:${choice.value}`}
                    onPress={() => {
                      if (multi || settled()) question.choose(choice.value);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      chosen && styles.optionChosen,
                      pressed && styles.optionPressed,
                    ]}
                  >
                    <View style={styles.mark}>
                      {busy ? (
                        <ActivityIndicator color={color.ember} size="small" />
                      ) : (
                        <Symbol
                          name={
                            multi
                              ? chosen
                                ? "checkmark.square.fill"
                                : "square"
                              : chosen
                                ? "checkmark.circle.fill"
                                : "circle"
                          }
                          size={20}
                          tint={chosen ? color.ember : color.muted}
                        />
                      )}
                    </View>
                    <View style={styles.optionText}>
                      <AppText role="secondary">{choice.label}</AppText>
                      {choice.description === undefined || choice.description === "" ? null : (
                        <AppText role="caption" tone="muted">
                          {choice.description}
                        </AppText>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
        {/* More below: the last rows fade rather than ending at the card's edge as if they were all. */}
        {scroll.content - scroll.box - scroll.offset > 4 ? (
          <View pointerEvents="none" style={styles.fade} />
        ) : null}
      </View>
      {typedHere ? (
        <TextInput
          accessibilityLabel={field.prompt === "" ? heading : field.prompt}
          cursorColor={color.ember}
          editable={!locked}
          maxFontSizeMultiplier={controlFontScaleLimit}
          maxLength={requestAnswerMaxLength}
          multiline
          onChangeText={question.type}
          placeholder={choices.length === 0 ? "Type your answer…" : "Type your own answer…"}
          placeholderTextColor={color.muted}
          selectionColor={color.ember}
          style={[type.secondary, styles.input]}
          value={draft.typed}
        />
      ) : null}
      {reason === null && session.failure === null ? null : (
        <View style={styles.status}>
          {reason === null ? null : (
            <AppText role="caption" tone="muted">
              {reason}
            </AppText>
          )}
          {session.failure === null ? null : (
            <ActionLine line={session.failure} numberOfLines={2} />
          )}
        </View>
      )}
      {question.dismiss === null &&
      !advanceHere &&
      (props.onAnswerHere === undefined || !questionTakesTyping(field)) &&
      props.onBackToMessage === undefined ? (
        <View style={styles.end} />
      ) : (
        <View style={styles.foot}>
          <AnswerRow
            leading={
              question.dismiss === null ? undefined : (
                <Pressable
                  accessibilityHint="Tells the agent you won't answer this"
                  accessibilityRole="button"
                  accessibilityState={{ busy: session.pendingId === "dismiss", disabled: locked }}
                  disabled={locked}
                  onPress={question.dismiss}
                  style={styles.quiet}
                >
                  <AppText
                    maxFontSizeMultiplier={controlFontScaleLimit}
                    role="secondary"
                    tone="muted"
                  >
                    {session.pendingId === "dismiss" ? "Dismissing…" : "Dismiss"}
                  </AppText>
                </Pressable>
              )
            }
          >
            {props.onBackToMessage === undefined ? null : (
              <AnswerPill
                label="Back to message"
                onPress={props.onBackToMessage}
                tone="secondary"
              />
            )}
            {props.onAnswerHere === undefined || !questionTakesTyping(field) ? null : (
              <AnswerPill label="Type an answer" onPress={props.onAnswerHere} tone="secondary" />
            )}
            {advanceHere ? (
              <AnswerPill
                busy={session.pendingId === "form"}
                disabled={locked}
                label={question.finishes ? "Answer" : "Next"}
                onPress={question.advance}
                tone="primary"
              />
            ) : null}
          </AnswerRow>
        </View>
      )}
    </View>
  );
}

function StepButton(props: {
  readonly disabled: boolean;
  readonly icon: "chevron.left" | "chevron.right";
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.stepButton, props.disabled && styles.dimmed]}
    >
      <Symbol name={props.icon} size={13} tint={color.textSoft} weight="semibold" />
    </Pressable>
  );
}

/** The card's text inset: the composer's, less the card's rim. */
const inset = space[14] - controlBorderWidth;

const styles = StyleSheet.create({
  asker: { paddingHorizontal: inset, paddingTop: space[10] - 1 },
  card: { ...material.attention, borderRadius: radius.xxl, overflow: "hidden" },
  cardHighlighted: { backgroundColor: material.selected.backgroundColor },
  detail: { gap: space[2], paddingHorizontal: inset, paddingTop: space[2] },
  dimmed: { opacity: 0.35 },
  end: { height: space[12] },
  fade: {
    backgroundImage: `linear-gradient(rgba(20, 20, 20, 0), ${String(material.attention.backgroundColor)})`,
    bottom: 0,
    height: 36,
    left: 0,
    position: "absolute",
    right: 0,
  },
  fold: { alignSelf: "flex-start" },
  foot: { paddingBottom: 2, paddingLeft: space[4], paddingRight: 6 },
  head: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space[6],
    paddingHorizontal: inset,
    paddingTop: space[10] - 1,
  },
  headAfterAsker: { paddingTop: space[4] },
  heading: { flex: 1 },
  input: {
    ...material.control,
    borderRadius: radius.lg,
    color: color.text,
    marginHorizontal: space[8],
    marginTop: space[8],
    maxHeight: type.secondary.lineHeight * 5,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  mark: { alignItems: "center", justifyContent: "center", width: 22 },
  option: {
    alignItems: "center",
    borderTopColor: color.lineStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget + space[4],
    paddingHorizontal: inset,
    paddingVertical: space[8],
  },
  optionChosen: { backgroundColor: color.emberWash },
  optionPressed: { backgroundColor: "rgba(255, 255, 255, 0.05)" },
  optionText: { flex: 1, gap: 1, minWidth: 0 },
  options: { marginTop: space[8] },
  optionsAfterHead: { marginTop: space[10] },
  prompt: { paddingHorizontal: inset, paddingTop: space[4] },
  quiet: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[10] },
  status: { gap: space[2], paddingHorizontal: inset, paddingTop: space[6] },
  stepButton: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    marginVertical: -space[10],
    width: touchTarget - space[8],
  },
  stepLabel: { textAlign: "center" },
  stepper: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    marginLeft: inset - (touchTarget - space[8] - 13) / 2,
    paddingTop: space[6],
  },
});
