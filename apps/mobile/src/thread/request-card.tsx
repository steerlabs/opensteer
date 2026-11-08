import type { HostClient, HostSnapshot, SurfaceModel } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { requestAgentProposedLabel, requestTitleText, type Request } from "@opensteer/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useChromeInspection } from "../browser/chrome-sign-in-parts.js";
import { navigationRef } from "../navigation-ref.js";
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
import { AppText, monoFontFamily, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AnswerPill, AnswerRow } from "./answer-pill.js";
import { NativeMenu, type NativeMenuOption } from "./composer-menu.js";
import { requestTitle } from "./docked-requests.js";
import { IntegrationConnectCard } from "./integration-connect-sheet.js";
import {
  approvalMenuOptions,
  confirmHighRisk,
  requestCardAnswers,
  requestCardHeading,
  requestOptionLabel,
  threadTakesDenialReason,
  type CardChoice,
  type RequestCardAnswers,
} from "./request-answers.js";
import { signInAvailability, signInSummaryLine } from "./request-sign-in-status.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useRequestResponse } from "./use-request-response.js";

/**
 * A card that has just arrived ignores taps for this long. It appears directly
 * above the composer, under a thumb on its way to something else, and an answer
 * sent by accident cannot be taken back.
 */
const arrivalGuardMs = 450;

/** A title and three lines of command at the default size: more isn't read at a glance. */
const inlineBodyHeight = type.title.lineHeight * 2 + type.caption.lineHeight * 3;

export interface RequestCardProps {
  /** False while the Host is unreachable: a decision is never queued. */
  readonly canRespond: boolean;
  /** Rechecks Composer state at the tap boundary, before dispatch. */
  readonly canStartResponse: () => boolean;
  readonly deploymentId: string;
  readonly disabledReason: string | null;
  /** This is the Request a link or a notification arrived pointing at. */
  readonly highlighted: boolean;
  readonly hostClient: HostClient;
  readonly mutationGate: ThreadMutationGate;
  /** Opens a sheet the card itself draws: the bar holds its shape while it is up. */
  readonly onPresent: () => void;
  readonly onSettle: () => void;
  /** Lists what else is waiting. Voice says that in its own words. */
  readonly showQueue?: boolean;
  /** The subagent that asked, by its title; absent or null when the Run's own agent did. */
  readonly subagentTitle?: string | null;
  readonly surface: SurfaceModel;
}

/**
 * What Opensteer is waiting on, with the composer's own corner, margins and
 * control sizes, so the two read as one family. An ember rim and top light say
 * it is a question. Anything small enough is answered right here; everything
 * else opens the Request's sheet.
 *
 * A person only approves what they can see: Allow stands on the card only while
 * the whole request fits on it. Past that the card clips, and its answer is to
 * read the rest.
 */
export function RequestCard(props: RequestCardProps): ReactNode {
  if (props.surface.request.payload.kind === "integration.access") {
    return <ConnectCard {...props} />;
  }
  return <AnswerCard {...props} />;
}

function ConnectCard(props: RequestCardProps): ReactNode {
  const { request } = props.surface;
  const open = useRef(false);
  const settle = useRef(props.onSettle);
  settle.current = props.onSettle;
  // Keyed by Request, so this unmounts when it is answered with its sheet up.
  useEffect(
    () => () => {
      if (open.current) settle.current();
    },
    [],
  );
  return (
    <View style={[styles.card, styles.connect, props.highlighted && styles.cardHighlighted]}>
      <IntegrationConnectCard
        hostClient={props.hostClient}
        request={request}
        disabled={
          !props.canRespond || props.surface.denied !== null || request.status !== "pending"
        }
        disabledReason={props.disabledReason ?? props.surface.denied}
        canStartResponse={props.canStartResponse}
        mutationGate={props.mutationGate}
        onPresent={() => {
          props.onPresent();
          open.current = true;
        }}
        onClose={() => {
          if (open.current) {
            open.current = false;
            settle.current();
          }
        }}
        onResponded={() => {}}
      />
    </View>
  );
}

function AnswerCard(props: RequestCardProps): ReactNode {
  const { deploymentId, surface } = props;
  const { request } = surface;
  const { presentation } = request;
  const { fontScale } = useWindowDimensions();
  const responder = useRequestResponse({
    canRespond: props.canRespond,
    canStartResponse: props.canStartResponse,
    gate: props.mutationGate,
    hostClient: props.hostClient,
    surface,
  });
  const { session } = responder;
  const answers = requestCardAnswers(request, surface.denied !== null);
  const title = requestTitle(request);
  const { context, question } = requestCardHeading(request, title);
  const proposed = presentation.agentProposed === true;
  const risky = answers.kind === "approve" && answers.highRisk;

  // Nothing about a card that hasn't been measured yet says it fits, so its
  // first frame can only under-offer. It is fading in during that frame.
  const limit = inlineBodyHeight * fontScale;
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const fits = bodyHeight !== null && bodyHeight <= limit;
  const overflows = bodyHeight !== null && !fits;

  useEffect(() => {
    void AccessibilityInfo.announceForAccessibility(
      `Opensteer needs your input. ${requestTitleText(presentation)}`,
    );
  }, [request.id, presentation]);

  const arrivedAt = useRef(Date.now());
  const settled = (): boolean => Date.now() - arrivedAt.current >= arrivalGuardMs;

  const signIn = request.payload.kind === "browser.sign-in" ? request.payload : null;
  const live = useChromeInspection(
    props.hostClient,
    signIn?.site ?? "",
    signIn !== null && surface.denied === null && props.canRespond && !session.sheetOpen,
  );
  const signInLine =
    signIn === null || surface.denied !== null
      ? null
      : signInSummaryLine(
          signInAvailability(live.inspection),
          session.allowed !== null,
          signIn.site,
        );

  const openSheet = (
    options: { readonly full?: boolean; readonly reason?: boolean } = {},
  ): void => {
    if (!navigationRef.isReady()) return;
    navigationRef.navigate("RequestSheet", {
      deploymentId,
      requestId: request.id,
      threadId: request.originatingThreadId,
      ...options,
    });
  };

  // While this card's own answer is in flight the busy control already says so.
  const reason = session.pendingId === null ? props.disabledReason : null;
  const locked = !props.canRespond || session.pendingId !== null;

  const send = (choice: CardChoice): void => {
    if (!settled()) return;
    void responder.submit(
      presentation.kind === "form"
        ? {
            answers: { [presentation.fields[0]!.id]: [choice.id] },
            kind: "form",
          }
        : { kind: "choice", optionId: choice.id },
      choice.id,
    );
  };

  return (
    <View style={[styles.card, props.highlighted && styles.cardHighlighted]}>
      <View style={[styles.clip, { maxHeight: limit }]}>
        <View
          onLayout={(event) => setBodyHeight(Math.ceil(event.nativeEvent.layout.height))}
          style={styles.body}
        >
          <View style={styles.head}>
            {risky ? (
              <View style={styles.riskMark}>
                <Symbol name="exclamationmark.triangle.fill" size={13} tint={color.red} />
              </View>
            ) : null}
            <AppText role="secondaryMedium" style={styles.question}>
              {question}
            </AppText>
            {props.showQueue === false ? null : (
              <WaitingMenu
                deploymentId={deploymentId}
                hostClient={props.hostClient}
                requestId={request.id}
              />
            )}
          </View>
          {context === null ? null : (
            <AppText role="caption" tone="soft">
              {context}
            </AppText>
          )}
          {proposed ? (
            <AppText role="caption" tone="muted">
              {requestAgentProposedLabel}
            </AppText>
          ) : null}
          {props.subagentTitle ? (
            <AppText numberOfLines={1} role="caption" tone="muted">
              Asked by subagent {props.subagentTitle}
            </AppText>
          ) : null}
          {signInLine === null ? null : (
            <View style={styles.signInLine}>
              <StatusDot live={signInLine.live} tone={signInLine.tone} />
              <AppText role="caption" style={styles.shrink} tone="soft">
                {signInLine.text}
              </AppText>
            </View>
          )}
          {presentation.detail === undefined ||
          presentation.detail === "" ||
          request.payload.kind === "browser.password-sign-in" ? null : (
            <AppText
              role="caption"
              style={request.kind === "harness.approval" ? styles.mono : styles.detail}
            >
              {presentation.detail}
            </AppText>
          )}
        </View>
        {overflows ? <View pointerEvents="none" style={styles.fade} /> : null}
      </View>
      {reason === null && session.failure === null ? null : (
        <View style={styles.status}>
          {reason === null ? null : (
            <AppText role="caption" tone="muted">
              {reason}
            </AppText>
          )}
          {session.failure === null ? null : (
            <AppText role="caption" tone="danger">
              {session.failure}
            </AppText>
          )}
        </View>
      )}
      <CardAnswers
        answers={answers}
        denied={surface.denied}
        fits={fits}
        locked={locked}
        measured={bodyHeight !== null}
        onReview={openSheet}
        onSend={send}
        overflows={overflows}
        pendingId={session.pendingId}
        request={request}
        settled={settled}
        takesReason={
          answers.kind === "approve" &&
          answers.takesReason &&
          // A Thread's engine doesn't change while it waits on a person.
          threadTakesDenialReason(props.hostClient.getSnapshot(), request.originatingThreadId)
        }
      />
    </View>
  );
}

function CardAnswers(props: {
  readonly answers: RequestCardAnswers;
  readonly denied: SurfaceModel["denied"];
  readonly fits: boolean;
  readonly locked: boolean;
  readonly measured: boolean;
  readonly onReview: (options?: { readonly full?: boolean; readonly reason?: boolean }) => void;
  readonly onSend: (choice: CardChoice) => void;
  readonly overflows: boolean;
  readonly pendingId: string | null;
  readonly request: Request;
  readonly settled: () => boolean;
  readonly takesReason: boolean;
}): ReactNode {
  const { answers, locked, onReview, onSend, overflows, pendingId, request, settled } = props;
  if (answers.kind === "none") {
    return (
      <View style={styles.waiting}>
        <AppText role="caption" tone="muted">
          {props.denied === null
            ? "Answer this on a computer."
            : props.denied === "administrator"
              ? "A Host administrator has to answer this."
              : "The person who started this task has to answer this."}
        </AppText>
        {overflows ? (
          <AnswerRow>
            <AnswerPill label="View" onPress={() => onReview()} tone="secondary" />
          </AnswerRow>
        ) : null}
      </View>
    );
  }
  if (answers.kind === "approve") {
    const more = approvalMenuOptions({
      answers,
      detail: request.presentation.detail ?? null,
      onAnswer: onSend,
      onSayWhy: () => onReview({ reason: true }),
      readable: props.fits,
      request,
      takesReason: props.takesReason,
      title: requestTitle(request),
    });
    const allowLabel = requestOptionLabel(request, answers.allow);
    return (
      <View style={styles.answers}>
        <AnswerRow
          leading={
            more.length === 0 ? undefined : (
              <NativeMenu
                accessibilityLabel="More answers"
                options={more}
                triggerStyle={styles.moreGlyph}
              >
                <View style={[styles.moreGlyph, locked && styles.dimmed]}>
                  <Symbol name="ellipsis" size={17} tint={color.textSoft} />
                </View>
              </NativeMenu>
            )
          }
        >
          <AnswerPill
            busy={pendingId === answers.decline.id}
            disabled={locked}
            label={requestOptionLabel(request, answers.decline)}
            onPress={() => onSend(answers.decline)}
            tone="secondary"
          />
          {props.fits || !props.measured ? (
            <AnswerPill
              busy={pendingId === answers.allow.id}
              disabled={locked || !props.measured}
              label={answers.highRisk ? `${allowLabel}…` : allowLabel}
              onPress={() => {
                if (answers.highRisk) {
                  if (settled()) {
                    confirmHighRisk(
                      requestTitle(request),
                      request.presentation.detail ?? null,
                      () => onSend(answers.allow),
                    );
                  }
                } else onSend(answers.allow);
              }}
              tone={answers.highRisk ? "danger" : "primary"}
            />
          ) : (
            <AnswerPill label="Review" onPress={() => onReview({ full: true })} tone="primary" />
          )}
        </AnswerRow>
      </View>
    );
  }
  if (answers.kind === "choose" && !overflows) {
    if (answers.look === "pills") {
      return (
        <View style={styles.pills}>
          {answers.options.map((option) => (
            <AnswerPill
              busy={pendingId === option.id}
              disabled={locked || !props.measured}
              key={option.id}
              label={option.label}
              onPress={() => onSend(option)}
              tone="secondary"
            />
          ))}
        </View>
      );
    }
    return (
      <View style={styles.rows}>
        {answers.options.map((option) => (
          <Pressable
            accessibilityHint="Sends this answer"
            accessibilityLabel={[option.label, option.description].filter(Boolean).join(", ")}
            accessibilityRole="button"
            accessibilityState={{
              busy: pendingId === option.id,
              disabled: locked || !props.measured,
            }}
            disabled={locked || !props.measured}
            key={option.id}
            onPress={() => onSend(option)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowText}>
              <AppText role="secondary">{option.label}</AppText>
              {option.description === undefined || option.description === "" ? null : (
                <AppText role="caption" tone="muted">
                  {option.description}
                </AppText>
              )}
            </View>
            {pendingId === option.id ? (
              <ActivityIndicator color={color.ember} size="small" />
            ) : null}
          </Pressable>
        ))}
      </View>
    );
  }
  // A question typed here only when no composer is there to take it.
  return (
    <View style={styles.answers}>
      <AnswerRow>
        <AnswerPill
          label={answers.kind === "sheet" ? answers.label : "Answer"}
          onPress={() => onReview()}
          tone="primary"
        />
      </AnswerRow>
    </View>
  );
}

/**
 * Everything else waiting, in a menu rather than a sentence. Each goes to the
 * Thread that asked with the Request named, which is what a notification does;
 * the composer there puts that Request on its card.
 */
function WaitingMenu(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly requestId: string;
}): ReactNode {
  const waiting = useHostSelector(props.hostClient, selectWaiting);
  const others = waiting.filter(({ request }) => request.id !== props.requestId);
  if (others.length === 0) return null;
  const options: NativeMenuOption[] = others.map(({ request }) => ({
    id: request.id,
    label: requestTitle(request),
    onPress: () => {
      if (!navigationRef.isReady()) return;
      navigationRef.navigate("Thread", {
        deploymentId: props.deploymentId,
        requestId: request.id,
        threadId: request.originatingThreadId,
      });
    },
  }));
  const count = others.length + 1;
  return (
    <NativeMenu accessibilityLabel={`${count} waiting on you`} options={options}>
      <View style={styles.count}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          1 of {count}
        </AppText>
        <Symbol name="chevron.down" size={9} tint={color.muted} />
      </View>
    </NativeMenu>
  );
}

const selectWaiting = (snapshot: HostSnapshot) => snapshot.waitingRequests;

const styles = StyleSheet.create({
  // The last pill ends where the composer's send circle does, and its leading
  // slot stands over the `+`, whatever the difference in their rims.
  answers: { paddingBottom: 2, paddingLeft: 1, paddingRight: 6 },
  body: { gap: 1, paddingHorizontal: space[14] - controlBorderWidth, paddingTop: space[10] - 1 },
  card: { ...material.attention, borderRadius: radius.xxl, overflow: "hidden" },
  cardHighlighted: { backgroundColor: material.selected.backgroundColor },
  clip: { overflow: "hidden" },
  connect: { paddingHorizontal: space[12], paddingVertical: space[10] },
  // Its 44 points of touch reach past the line it sits on, without moving that line.
  count: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[2],
    marginRight: -space[8],
    marginVertical: (type.secondary.lineHeight - touchTarget) / 2,
    minHeight: touchTarget,
    paddingLeft: space[8],
    paddingRight: space[8],
  },
  detail: { color: color.textSoft },
  dimmed: { opacity: 0.45 },
  fade: {
    backgroundImage: `linear-gradient(rgba(20, 20, 20, 0), ${String(material.attention.backgroundColor)})`,
    bottom: 0,
    height: 28,
    left: 0,
    position: "absolute",
    right: 0,
  },
  head: { alignItems: "flex-start", flexDirection: "row", gap: space[6] },
  mono: { color: color.textSoft, fontFamily: monoFontFamily },
  moreGlyph: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  pills: {
    columnGap: space[6],
    flexDirection: "row",
    flexWrap: "wrap",
    paddingBottom: 2,
    paddingHorizontal: space[8],
  },
  question: { flex: 1 },
  riskMark: { justifyContent: "center", minHeight: type.secondary.lineHeight },
  row: {
    alignItems: "center",
    borderTopColor: color.lineStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[14] - controlBorderWidth,
    paddingVertical: space[8],
  },
  rowPressed: { backgroundColor: "rgba(255, 255, 255, 0.05)" },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  rows: { marginTop: space[8] },
  shrink: { flexShrink: 1 },
  signInLine: { alignItems: "center", flexDirection: "row", gap: space[8] },
  status: {
    gap: space[2],
    paddingHorizontal: space[14] - controlBorderWidth,
    paddingTop: space[4],
  },
  waiting: {
    gap: space[2],
    paddingBottom: space[10] - 1,
    paddingHorizontal: space[14] - controlBorderWidth,
    paddingTop: space[4],
  },
});
