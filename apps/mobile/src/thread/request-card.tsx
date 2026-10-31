import type { HostClient, SurfaceModel } from "@opensteer/client/host";
import {
  browserAccessAvailableLabel,
  browserAccessGrantable,
  browserAccessGrantLabel,
  browserAccessInitialName,
  browserAccessInitialSelection,
  browserAccessResponse,
  browserAccessWarning,
  browserProfileSavePrompt,
  browserSignInProblemCopy,
  browserSignInProblemMessage,
  browserSiteLabel,
  chromeCandidateDetail,
  chromeSignInAvailability,
  fullAccessDeclineLabel,
  fullAccessRequestBody,
  HostClientRequestError,
  mutationIdempotencyKey,
  passwordSignInDeclineLabel,
  passwordSignInDecliningLabel,
  passwordSignInExpiry,
  passwordSignInOutcome,
  passwordSignInPrivacy,
  passwordSignInReasonLabel,
  passwordSignInWaitingOn,
  type BrowserAccessSelection,
  type ChromeSignInAvailability,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { computerAppAccessApproval, computerUseAccessLabel } from "@opensteer/client/integrations";
import {
  requestAgentProposedDetail,
  requestAgentProposedLabel,
  requestTitleText,
  type BrowserSourceId,
  type Request,
  type RequestFormField,
  type RequestOption,
  type RequestPayload,
  type RequestResponse,
} from "@opensteer/core";
import type {
  BrowserSignInDecision,
  BrowserSignInOutcome,
  BrowserSourceInspection,
} from "@opensteer/protocol/browser-sources";
import type { MachineSummary } from "@opensteer/protocol";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import {
  ChromeChoice,
  ChromeChoices,
  useChromeInspection,
} from "../browser/chrome-sign-in-parts.js";
import { operationDetail } from "../client/mobile-client.js";
import {
  color,
  controlBorderWidth,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import {
  AppText,
  monoFontFamily,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  StatusDot,
} from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IntegrationConnectSheet } from "./integration-connect-sheet.js";
import { InstallReview } from "./integration-install-review.js";
import { Symbol } from "../ui/symbol.js";
import { TextInput } from "../ui/text-input.js";
import { requestTitle, requestTitleLine } from "./docked-requests.js";
import {
  nextRequestSubmission,
  requestAnswerMaxLength,
  requestDraftValues,
  requestFieldMode,
  requestFormAnswers,
  requestFormProgress,
  requestFormProgressLabel,
  sameRequestResponse,
  toggleRequestChoice,
  withRequestDraftValues,
  type RequestFormDraft,
  type RequestSubmission,
} from "./request-form-model.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";

/**
 * Whatever went wrong, the answer may still have landed: a timeout or a lost
 * reply looks the same from here as a refusal that never reached the Host.
 */
const unconfirmedDetail = "Could not confirm your answer was sent.";

/** Each external decline marks its own control busy, never another kind's. */
const fullDiskAccessDeclineId = "full-disk-access-decline";
const computerAppAllowId = "computer-app-allow";
const computerAppDeclineId = "computer-app-decline";
const signInAllowId = "browser-sign-in-allow";
const signInDeclineId = "browser-sign-in-decline";
const browserAccessGrantId = "browser-access-grant";
const browserAccessDeclineId = "browser-access-decline";
const passwordSignInDeclineId = "password-sign-in-decline";

/**
 * What Opensteer is waiting on, as a card of its own above the composer.
 *
 * It sits above the bar rather than inside a frame drawn around both, because
 * the bar is one shape with one job and a question is a different object that
 * happens to have arrived. The ember edge is what ties them together: it is the
 * only vertical rule in the app, it points down at the field that answers, and
 * it costs the card no width.
 *
 * A successful dispatch only means the Host admitted the answer; the Runner
 * may still fail to take it and leave the same Request pending. So the card
 * holds no "answered" state of its own. It closes its sheet, and the Request
 * leaving the snapshot is what removes it.
 */
export function RequestCard(props: {
  /** False while the Host is unreachable: a decision is never queued. */
  readonly canRespond: boolean;
  /** Rechecks Composer state at the tap boundary, before dispatch. */
  readonly canStartResponse: () => boolean;
  readonly disabledReason: string | null;
  /** This is the Request a link or a notification arrived pointing at. */
  readonly highlighted: boolean;
  readonly hostClient: HostClient;
  /** The Deployment's computers, so a Request about one names it as the web does. */
  readonly machines: readonly MachineSummary[];
  readonly mutationGate: ThreadMutationGate;
  /** Opens the review sheet: the bar holds its shape while it is up. */
  readonly onPresent: () => void;
  readonly onSettle: () => void;
  /** The subagent that asked, by its title; absent or null when the Run's own agent did. */
  readonly subagentTitle?: string | null;
  readonly surface: SurfaceModel;
}): ReactNode {
  const { request } = props.surface;
  const presentation = request.presentation;
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The draft lives with the card, not the sheet, so closing the sheet to read
  // the transcript and opening it again finds every answer where it was left.
  const [answers, setAnswers] = useState<RequestFormDraft>({});
  // The connect sheet replaces the review sheet rather than stacking on it: two
  // modals deep is not a place to type a client secret.
  const [connecting, setConnecting] = useState(false);
  // Like the form draft, a profile choice survives closing the sheet. Undefined
  // means untouched, so the agent's suggestion still applies.
  const [browserSelection, setBrowserSelection] = useState<
    BrowserAccessSelection | null | undefined
  >(undefined);
  const [browserName, setBrowserName] = useState<string | undefined>(undefined);
  const responding = useRef(false);
  const held = useRef<RequestSubmission | null>(null);
  const mounted = useRef(true);
  const openRef = useRef(false);
  const settle = useRef(props.onSettle);

  useEffect(() => {
    settle.current = props.onSettle;
  }, [props.onSettle]);

  // The card is keyed by Request, so it unmounts when that Request is answered
  // elsewhere, cancelled, or displaced by a newer one — possibly with its sheet
  // up. The composer is told once, here, and a dispatch still in flight when
  // that happens must not tell it again on behalf of whatever replaced it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (openRef.current) {
        openRef.current = false;
        settle.current();
      }
    };
  }, []);

  useEffect(() => {
    void AccessibilityInfo.announceForAccessibility(
      `Opensteer needs your input. ${requestTitleText(request.presentation)}`,
    );
  }, [request.id, request.presentation]);

  const present = (): void => {
    props.onPresent();
    openRef.current = true;
    setOpen(true);
  };

  const dismiss = (): void => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    settle.current();
  };

  const signIn = request.payload.kind === "browser.sign-in" ? request.payload : null;
  const passwordSignIn =
    request.payload.kind === "browser.password-sign-in" ? request.payload : null;
  // Mac grants and saved-password sign-ins happen on that Mac. Phone access
  // and the other external decisions can be answered here.
  const externalDeclinable =
    request.status === "pending" &&
    props.surface.denied === null &&
    presentation.kind === "external" &&
    ((request.kind === "machine.full-disk-access" &&
      request.payload.kind === "machine.full-disk-access") ||
      (request.kind === "computer.app.access" && request.payload.kind === "computer.app.access") ||
      (request.kind === "browser.sign-in" && signIn !== null) ||
      (request.kind === "browser.password-sign-in" && passwordSignIn !== null) ||
      (request.kind === "browser.access" && request.payload.kind === "browser.access") ||
      (request.kind === "browser.profile.save" && request.payload.kind === "browser.profile.save"));
  const answerable =
    request.status === "pending" &&
    props.surface.denied === null &&
    (presentation.kind !== "external" || externalDeclinable);
  const title = requestTitle(request);
  const agentProposed = presentation.agentProposed === true;

  // Chrome is asked again while the card is on screen, so a Chrome opened or
  // signed in on the computer shows here without a tap.
  const live = useChromeInspection(
    props.hostClient,
    signIn?.site ?? "",
    signIn !== null && answerable && props.canRespond,
  );
  const [chosenSourceId, setChosenSourceId] = useState<string | null>(null);
  // An Allow the Host kept pending: Chrome is offline and it finishes by itself.
  const [allowed, setAllowed] = useState<BrowserSignInOutcome | null>(null);
  const heldSignIn = useRef<{ readonly key: string; readonly signature: string } | null>(null);
  const heldPasswordDecline = useRef<string | null>(null);

  // Choices and forms both come through here, so a retry is only ever the
  // response the person just chose, never one held from an earlier tap.
  const submit = async (response: RequestResponse, busyId: string): Promise<void> => {
    if (responding.current || !answerable || !props.canRespond || !props.canStartResponse()) {
      return;
    }
    const gate = props.mutationGate;
    const claim = gate.acquire("request");
    if (claim === null) return;
    const submission = nextRequestSubmission(held.current, response, () =>
      mutationIdempotencyKey(`request:${request.id}`),
    );
    held.current = submission;
    responding.current = true;
    setPendingId(busyId);
    setFailure(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: submission.idempotencyKey,
        requestId: request.id,
        response: submission.response,
        type: "request.respond",
      });
      if (held.current === submission) held.current = null;
      if (mounted.current) dismiss();
    } catch (error) {
      if (mounted.current) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const detail =
          error instanceof HostClientRequestError
            ? operationDetail(error, unconfirmedDetail)
            : unconfirmedDetail;
        setFailure(detail);
        void AccessibilityInfo.announceForAccessibility(detail);
      }
    } finally {
      responding.current = false;
      gate.release(claim);
      if (mounted.current) setPendingId(null);
    }
  };

  const allowComputerApp = async (): Promise<void> => {
    if (
      request.payload.kind !== "computer.app.access" ||
      request.payload.definitionId !== "android-phone" ||
      responding.current ||
      !answerable ||
      !props.canRespond ||
      !props.canStartResponse()
    )
      return;
    const claim = props.mutationGate.acquire("request");
    if (claim === null) return;
    const { access, definitionId, runnerId } = request.payload;
    responding.current = true;
    setPendingId(computerAppAllowId);
    setFailure(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`phone-request:${request.id}`),
        input: { access, app: null, definitionId, kind: "app", runnerId },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set") throw new Error(unconfirmedDetail);
      if (mounted.current) dismiss();
    } catch (error) {
      if (mounted.current) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const detail = operationDetail(error, unconfirmedDetail);
        setFailure(detail);
        void AccessibilityInfo.announceForAccessibility(detail);
      }
    } finally {
      responding.current = false;
      props.mutationGate.release(claim);
      if (mounted.current) setPendingId(null);
    }
  };

  // A sign-in has its own command: the answer names a Chrome and may need that
  // Chrome to finish, so the Host replies with what happened.
  const respondSignIn = async (decision: BrowserSignInDecision, busyId: string): Promise<void> => {
    if (signIn === null || responding.current || !answerable || !props.canRespond) return;
    if (!props.canStartResponse()) return;
    const gate = props.mutationGate;
    const claim = gate.acquire("request");
    if (claim === null) return;
    const signature = JSON.stringify(decision);
    if (heldSignIn.current?.signature !== signature) {
      heldSignIn.current = {
        key: mutationIdempotencyKey(`browser-sign-in:${request.id}`),
        signature,
      };
    }
    const held = heldSignIn.current;
    const domain = browserSiteLabel(signIn.site);
    responding.current = true;
    setPendingId(busyId);
    setFailure(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await props.hostClient.dispatch({
        decision,
        idempotencyKey: held.key,
        requestId: request.id,
        type: "browser.sign-in.respond",
      });
      if (heldSignIn.current === held) heldSignIn.current = null;
      if (!mounted.current) return;
      const outcome = result.type === "browser.sign-in.respond" ? result.outcome : null;
      if (
        outcome === null ||
        outcome.status === "applied" ||
        outcome.problem === "session-closed"
      ) {
        if (outcome !== null) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          void AccessibilityInfo.announceForAccessibility(
            outcome.status === "applied"
              ? `Signed in to ${domain} with ${outcome.sourceName}.`
              : `Allowed ${domain}.`,
          );
        }
        dismiss();
        return;
      }
      if (outcome.problem === "chrome-offline") {
        setAllowed(outcome);
        void AccessibilityInfo.announceForAccessibility(
          `Allowed. Open Chrome on that computer and ${domain} finishes by itself.`,
        );
        return;
      }
      const message = browserSignInProblemMessage(outcome.problem, {
        connectHere: false,
        context: "request",
        site: signIn.site,
        sourceName: outcome.sourceName,
      });
      setFailure(message);
      void AccessibilityInfo.announceForAccessibility(message);
    } catch (error) {
      if (mounted.current) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const detail =
          error instanceof HostClientRequestError
            ? operationDetail(error, unconfirmedDetail)
            : unconfirmedDetail;
        setFailure(detail);
        void AccessibilityInfo.announceForAccessibility(detail);
      }
    } finally {
      responding.current = false;
      gate.release(claim);
      if (mounted.current) setPendingId(null);
    }
  };
  // Only that Mac approves a saved-password sign-in; the phone's one answer is
  // no, through its own command, which the Mac settles.
  const declinePasswordSignIn = async (): Promise<void> => {
    if (passwordSignIn === null || responding.current || !answerable || !props.canRespond) return;
    if (!props.canStartResponse()) return;
    const gate = props.mutationGate;
    const claim = gate.acquire("request");
    if (claim === null) return;
    heldPasswordDecline.current ??= mutationIdempotencyKey(`password-sign-in:${request.id}`);
    responding.current = true;
    setPendingId(passwordSignInDeclineId);
    setFailure(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: heldPasswordDecline.current,
        requestId: request.id,
        type: "browser.password-sign-in.decline",
      });
      if (mounted.current) dismiss();
    } catch (error) {
      if (mounted.current) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const detail =
          error instanceof HostClientRequestError
            ? operationDetail(error, unconfirmedDetail)
            : unconfirmedDetail;
        setFailure(detail);
        void AccessibilityInfo.announceForAccessibility(detail);
      }
    } finally {
      responding.current = false;
      gate.release(claim);
      if (mounted.current) setPendingId(null);
    }
  };

  const signInLine =
    signIn === null || !answerable
      ? null
      : signInSummaryLine(signInAvailability(live.inspection), allowed !== null, signIn.site);

  const risk = presentation.kind === "choice" ? presentation.risk : undefined;
  // While this card's own answer is in flight the Thread reports "Sending your
  // response…"; the busy control already says that, and says it where it is.
  const reason = pendingId === null ? props.disabledReason : null;
  const form = answerable && presentation.kind === "form" ? presentation.fields : null;
  const review = answerable ? "Review" : "View";
  const askedBy = props.subagentTitle ? `Asked by subagent ${props.subagentTitle}` : null;
  return (
    <View style={[styles.card, props.highlighted && styles.cardHighlighted]}>
      <View style={styles.edge} />
      <View style={styles.body}>
        <Pressable
          accessibilityLabel={`${review} request: ${requestTitleLine(request)}`}
          accessibilityRole="button"
          onPress={present}
          style={({ pressed }) => [styles.summaryHead, pressed && styles.reviewPressed]}
        >
          <View style={styles.summaryText}>
            <AppText numberOfLines={2} role="title">
              {title}
            </AppText>
            {agentProposed ? (
              <AppText role="caption" tone="muted">
                {requestAgentProposedLabel}
              </AppText>
            ) : null}
            {risk === "medium" || risk === "high" ? <RiskLabel risk={risk} /> : null}
          </View>
          <AppText role="secondaryMedium" tone={answerable ? "ember" : "muted"}>
            {review}
          </AppText>
        </Pressable>
        {askedBy === null ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {askedBy}
          </AppText>
        )}
        {signInLine === null ? null : (
          <View style={styles.signInLine}>
            <StatusDot live={signInLine.live} tone={signInLine.tone} />
            <AppText role="caption" style={styles.signInLineText} tone="soft">
              {signInLine.text}
            </AppText>
          </View>
        )}
        {props.surface.queued > 0 ? (
          <AppText role="caption" tone="muted">
            {props.surface.queuedTitle === null
              ? `${props.surface.queued} more waiting`
              : `${props.surface.queued} more waiting, next: ${props.surface.queuedTitle}`}
          </AppText>
        ) : null}
        {!answerable || reason === null ? null : (
          <AppText role="caption" tone="muted">
            {reason}
          </AppText>
        )}
        {failure === null ? null : (
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        )}
      </View>
      <Sheet
        footer={
          form === null ? undefined : (
            <FormFooter
              answers={answers}
              canSend={props.canRespond && pendingId === null}
              failure={failure}
              fields={form}
              held={held.current}
              onSubmit={(formAnswers) => {
                Keyboard.dismiss();
                void submit({ answers: formAnswers, kind: "form" }, "form");
              }}
              pending={pendingId === "form"}
              reason={reason}
            />
          )
        }
        onClose={dismiss}
        open={open}
        title="Review request"
      >
        <View style={styles.sheetBody}>
          <View style={styles.sheetHead}>
            {risk === "medium" || risk === "high" ? <RiskBadge risk={risk} /> : null}
            <AppText role="displaySmall" selectable>
              {title}
            </AppText>
            {agentProposed ? (
              <AppText accessibilityHint={requestAgentProposedDetail} role="secondary" tone="muted">
                {requestAgentProposedLabel}
              </AppText>
            ) : null}
            {askedBy === null ? null : (
              <AppText role="secondary" tone="muted">
                {askedBy}
              </AppText>
            )}
          </View>
          {presentation.detail === undefined ||
          presentation.detail === "" ||
          // The agent's reason is labelled as the agent's in the body below.
          passwordSignIn !== null ? null : (
            <RequestDetail
              // Harness approvals carry the command or patch being approved,
              // which only reads correctly in its own columns.
              mono={request.kind === "harness.approval"}
              text={presentation.detail}
            />
          )}
          <RequestBody
            answers={answers}
            browserAccess={{
              hostClient: props.hostClient,
              name: browserName,
              onChangeName: setBrowserName,
              onRespond: (selection, name) =>
                void submit(
                  browserAccessResponse(selection, name),
                  selection === null ? browserAccessDeclineId : browserAccessGrantId,
                ),
              onSelect: setBrowserSelection,
              selection: browserSelection,
            }}
            canRespond={props.canRespond}
            failure={failure}
            onAnswersChange={setAnswers}
            onChoose={(optionId) => void submit({ kind: "choice", optionId }, optionId)}
            onConnectIntegration={() => {
              dismiss();
              setConnecting(true);
            }}
            onDeclineComputerApp={() =>
              void submit(
                { kind: "external", value: { decision: "declined" } },
                computerAppDeclineId,
              )
            }
            onAllowComputerApp={() => void allowComputerApp()}
            onDeclineFullDiskAccess={() =>
              void submit(
                { kind: "external", value: { decision: "declined" } },
                fullDiskAccessDeclineId,
              )
            }
            onDeclinePasswordSignIn={() => void declinePasswordSignIn()}
            signIn={{
              allowed,
              chosenSourceId,
              error: live.error,
              inspection: live.inspection,
              onAllow: (sourceId) =>
                void respondSignIn({ decision: "allow", sourceId }, signInAllowId),
              onChoose: setChosenSourceId,
              onDecline: () => void respondSignIn({ decision: "decline" }, signInDeclineId),
              workspaceName:
                props.hostClient
                  .getSnapshot()
                  .workspaces.find((workspace) => workspace.id === request.targetWorkspaceId)
                  ?.name ?? "this Workspace",
            }}
            machines={props.machines}
            pendingId={pendingId}
            reason={reason}
            surface={props.surface}
          />
        </View>
      </Sheet>
      <IntegrationConnectSheet
        hostClient={props.hostClient}
        onClose={() => setConnecting(false)}
        onResponded={() => setConnecting(false)}
        open={connecting}
        request={request}
      />
    </View>
  );
}

function RiskLabel(props: { readonly risk: "high" | "medium" }): ReactNode {
  return (
    <AppText role="caption" style={props.risk === "high" ? styles.highRisk : styles.mediumRisk}>
      {props.risk === "high" ? "High risk" : "Medium risk"}
    </AppText>
  );
}

/** The same warning as the card's, framed, because in the sheet it precedes a decision. */
function RiskBadge(props: { readonly risk: "high" | "medium" }): ReactNode {
  const high = props.risk === "high";
  return (
    <View style={[styles.riskBadge, high ? styles.riskBadgeHigh : styles.riskBadgeMedium]}>
      <Symbol
        name="exclamationmark.triangle.fill"
        size={13}
        tint={high ? color.red : color.amber}
      />
      <RiskLabel risk={props.risk} />
    </View>
  );
}

/** The agent's own words, whole: a decision is not made on a clamped excerpt. */
function RequestDetail(props: { readonly mono: boolean; readonly text: string }): ReactNode {
  if (!props.mono) {
    return (
      <AppText role="secondary" selectable tone="soft">
        {props.text}
      </AppText>
    );
  }
  return (
    <View style={styles.monoDetail}>
      <AppText role="secondary" selectable style={styles.monoText}>
        {props.text}
      </AppText>
    </View>
  );
}

/** Why the action beside it cannot run, and what the last attempt came to. */
function ResponseStatus(props: {
  readonly failure: string | null;
  readonly reason: string | null;
}): ReactNode {
  if (props.failure === null && props.reason === null) return null;
  return (
    <View style={styles.status}>
      {props.reason === null ? null : (
        <AppText role="secondary" tone="muted">
          {props.reason}
        </AppText>
      )}
      {props.failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {props.failure}
        </AppText>
      )}
    </View>
  );
}

function RequestBody(props: {
  readonly answers: RequestFormDraft;
  readonly browserAccess: BrowserAccessState;
  readonly canRespond: boolean;
  readonly failure: string | null;
  readonly onAnswersChange: (answers: RequestFormDraft) => void;
  readonly onChoose: (optionId: string) => void;
  readonly onConnectIntegration: () => void;
  readonly onAllowComputerApp: () => void;
  readonly onDeclineComputerApp: () => void;
  readonly onDeclineFullDiskAccess: () => void;
  readonly onDeclinePasswordSignIn: () => void;
  readonly machines: readonly MachineSummary[];
  readonly pendingId: string | null;
  readonly reason: string | null;
  readonly signIn: SignInState;
  readonly surface: SurfaceModel;
}): ReactNode {
  const { request } = props.surface;

  if (request.status !== "pending" && request.payload.kind === "browser.sign-in") {
    return <BrowserSignInResolved request={request} site={request.payload.site} />;
  }

  if (request.status !== "pending" && request.payload.kind === "browser.password-sign-in") {
    return <PasswordSignInResolved request={request} />;
  }

  if (request.status !== "pending") {
    return (
      <Notice
        detail="It has already been answered or withdrawn."
        title="This request is no longer waiting"
        tone="neutral"
      />
    );
  }

  if (props.surface.denied !== null) {
    return (
      <Notice
        detail={
          props.surface.denied === "administrator"
            ? "A Host administrator has to answer this. It stays open until they do."
            : "The person who started this task has to answer this. It stays open until they do."
        }
        title="Someone else answers this"
        tone="neutral"
      />
    );
  }

  switch (request.presentation.kind) {
    case "choice":
      return (
        <View style={styles.choices}>
          {request.payload.kind === "integration.install" ? (
            <InstallReview
              canInstall
              continuesToAccess={false}
              installedTitle={null}
              manifest={request.payload.manifest}
            />
          ) : null}
          <AppText role="caption" tone="muted">
            Tapping an answer sends it.
          </AppText>
          <ResponseStatus failure={props.failure} reason={props.reason} />
          <RowGroup>
            {request.presentation.options.map((option) => (
              <ChoiceOptionRow
                busy={props.pendingId === option.id}
                disabled={!props.canRespond || props.pendingId !== null}
                key={option.id}
                onPress={() => props.onChoose(option.id)}
                option={option}
              />
            ))}
          </RowGroup>
        </View>
      );
    case "form":
      return (
        <RequestForm
          answers={props.answers}
          // The draft stays editable while offline; only sending waits.
          disabled={props.pendingId !== null}
          fields={request.presentation.fields}
          onAnswersChange={props.onAnswersChange}
        />
      );
    case "external":
      // An integration access Request is answered here: the connect sheet runs
      // the same flow the browser does against this deployment's Host.
      return request.kind === "integration.access" ? (
        <Notice
          action={{ label: "Review connection", onPress: props.onConnectIntegration }}
          detail="Choose the account and the access this integration gets. Nothing is connected until you finish at the provider."
          title="This integration needs a connected account"
          tone="neutral"
        />
      ) : request.kind === "machine.full-disk-access" &&
        request.payload.kind === "machine.full-disk-access" ? (
        <View style={styles.choices}>
          <Notice
            detail={fullAccessRequestBody(request.payload.machineName)}
            title={`macOS permission needed on ${request.payload.machineName}`}
            tone="neutral"
          />
          <ResponseStatus failure={props.failure} reason={props.reason} />
          <SecondaryButton
            busy={props.pendingId === fullDiskAccessDeclineId}
            disabled={!props.canRespond || props.pendingId !== null}
            label={fullAccessDeclineLabel}
            onPress={props.onDeclineFullDiskAccess}
          />
        </View>
      ) : request.kind === "computer.app.access" &&
        request.payload.kind === "computer.app.access" ? (
        // Mac approval happens there; phone access can be set by its owner here.
        <ComputerAppAccessBody
          access={request.payload.access}
          canRespond={props.canRespond}
          definitionId={request.payload.definitionId}
          failure={props.failure}
          machines={props.machines}
          onAllow={props.onAllowComputerApp}
          onDecline={props.onDeclineComputerApp}
          pendingId={props.pendingId}
          reason={props.reason}
          runnerId={request.payload.runnerId}
        />
      ) : (request.kind === "browser.access" && request.payload.kind === "browser.access") ||
        (request.kind === "browser.profile.save" &&
          request.payload.kind === "browser.profile.save") ? (
        <BrowserAccessBody
          canRespond={props.canRespond}
          failure={props.failure}
          pendingId={props.pendingId}
          reason={props.reason}
          request={request}
          state={props.browserAccess}
        />
      ) : request.kind === "browser.password-sign-in" &&
        request.payload.kind === "browser.password-sign-in" ? (
        <PasswordSignInBody
          canRespond={props.canRespond}
          failure={props.failure}
          machines={props.machines}
          onDecline={props.onDeclinePasswordSignIn}
          payload={request.payload}
          pendingId={props.pendingId}
          reason={props.reason}
        />
      ) : request.kind === "browser.sign-in" && request.payload.kind === "browser.sign-in" ? (
        <BrowserSignInBody
          canRespond={props.canRespond}
          failure={props.failure}
          payload={request.payload}
          pendingId={props.pendingId}
          reason={props.reason}
          state={props.signIn}
        />
      ) : (
        <Notice
          detail="This request needs an action outside the mobile app. Open this thread in Opensteer on a computer for instructions."
          title="Answer this on a computer"
          tone="neutral"
        />
      );
  }
}

type BrowserAccessState = {
  readonly hostClient: HostClient;
  readonly name: string | undefined;
  readonly onChangeName: (name: string) => void;
  readonly onRespond: (selection: BrowserAccessSelection | null, name: string) => void;
  readonly onSelect: (selection: BrowserAccessSelection) => void;
  readonly selection: BrowserAccessSelection | null | undefined;
};

/**
 * Which saved browser profile a Workspace's agents may use, or the name a
 * fresh session's sign-ins are saved under — the same choice the web offers.
 * Profiles come from the Host snapshot, never from the agent's words; a
 * profile already available to the Workspace says so and completes at once.
 */
function BrowserAccessBody(props: {
  readonly canRespond: boolean;
  readonly failure: string | null;
  readonly pendingId: string | null;
  readonly reason: string | null;
  readonly request: Request;
  readonly state: BrowserAccessState;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.state.hostClient);
  const { payload } = props.request;
  const save = payload.kind === "browser.profile.save";
  const suggestion = payload.kind === "browser.access" ? payload.suggestion : null;
  const profiles = snapshot.browserProfiles;
  const selection: BrowserAccessSelection | null =
    props.state.selection !== undefined
      ? props.state.selection
      : save
        ? { kind: "save" }
        : suggestion
          ? browserAccessInitialSelection(suggestion, profiles)
          : null;
  const name =
    props.state.name ??
    (payload.kind === "browser.profile.save"
      ? (payload.suggestedName ?? "")
      : suggestion
        ? browserAccessInitialName(suggestion)
        : "");
  const workspaceName =
    snapshot.workspaces.find((workspace) => workspace.id === props.request.targetWorkspaceId)
      ?.name ?? "this Workspace";
  const available = new Set(
    snapshot.browserProfileGrants
      .filter((grant) => grant.workspaceId === props.request.targetWorkspaceId)
      .map((grant) => grant.profileId),
  );
  const busy = props.pendingId !== null;
  const disabled = !props.canRespond || busy;
  const alreadyAvailable = selection?.kind === "existing" && available.has(selection.profileId);
  const choose = (next: BrowserAccessSelection): void => {
    void Haptics.selectionAsync();
    props.state.onSelect(next);
  };
  const nameField = (
    <TextInput
      accessibilityLabel="Profile name"
      autoCapitalize="words"
      cursorColor={color.ember}
      editable={!busy}
      maxFontSizeMultiplier={controlFontScaleLimit}
      maxLength={120}
      onChangeText={props.state.onChangeName}
      placeholder="New browser profile"
      placeholderTextColor={color.muted}
      selectionColor={color.ember}
      style={[type.body, styles.input, busy && styles.disabled]}
      value={name}
    />
  );
  return (
    <View style={styles.choices}>
      {save ? (
        <>
          <AppText role="secondary" tone="soft">
            {browserProfileSavePrompt(workspaceName)}
          </AppText>
          {nameField}
        </>
      ) : (
        <>
          <RowGroup>
            {profiles.map((profile) => (
              <FormChoiceRow
                description={
                  available.has(profile.id) ? browserAccessAvailableLabel(workspaceName) : undefined
                }
                disabled={busy}
                hint="Choose one"
                key={profile.id}
                label={profile.name}
                mode="one"
                onPress={() => choose({ kind: "existing", profileId: profile.id })}
                selected={selection?.kind === "existing" && selection.profileId === profile.id}
              />
            ))}
            <FormChoiceRow
              description={undefined}
              disabled={busy}
              hint="Choose one"
              label="Create a new profile"
              mode="one"
              onPress={() => choose({ kind: "new" })}
              selected={selection?.kind === "new"}
            />
          </RowGroup>
          {selection?.kind === "new" ? nameField : null}
          <AppText role="caption" tone="muted">
            {browserAccessWarning(workspaceName)}
          </AppText>
        </>
      )}
      <ResponseStatus failure={props.failure} reason={props.reason} />
      <PrimaryButton
        busy={props.pendingId === browserAccessGrantId}
        disabled={disabled || !browserAccessGrantable(selection, name, save ? [] : profiles)}
        label={save ? "Save profile" : browserAccessGrantLabel(alreadyAvailable)}
        onPress={() => props.state.onRespond(selection, name)}
      />
      <SecondaryButton
        busy={props.pendingId === browserAccessDeclineId}
        disabled={disabled}
        label="Not now"
        onPress={() => props.state.onRespond(null, name)}
      />
    </View>
  );
}

type SignInState = {
  readonly allowed: BrowserSignInOutcome | null;
  readonly chosenSourceId: string | null;
  readonly error: string | null;
  readonly inspection: BrowserSourceInspection | null;
  readonly onAllow: (sourceId: BrowserSourceId) => void;
  readonly onChoose: (sourceId: string) => void;
  readonly onDecline: () => void;
  readonly workspaceName: string;
};

type DotTone = "green" | "amber" | "red" | "muted" | "ember";

/**
 * Where a sign-in stands, read the way every client reads it. An Allow may
 * name an offline Chrome: the Request finishes when that Chrome comes back.
 */
function signInAvailability(
  inspection: BrowserSourceInspection | null,
): ChromeSignInAvailability | null {
  return inspection === null ? null : chromeSignInAvailability(inspection, { offlineCounts: true });
}

/** The card's one line under its title: where the sign-in stands right now. */
function signInSummaryLine(
  availability: ChromeSignInAvailability | null,
  allowed: boolean,
  site: string,
): { readonly live: boolean; readonly text: string; readonly tone: DotTone } | null {
  if (allowed) return { live: true, text: "Allowed. Finishes when Chrome is back.", tone: "amber" };
  if (availability === null) return null;
  switch (availability.kind) {
    case "no-chrome":
      return { live: false, text: signInCopy("no-chrome", site, null).title, tone: "muted" };
    case "choices": {
      const [first] = availability.choices;
      const name = availability.choices.length === 1 ? (first?.name ?? null) : null;
      if (first?.online !== true) {
        return { live: false, text: signInCopy("chrome-offline", site, name).title, tone: "amber" };
      }
      return name === null
        ? { live: false, text: "Choose which Chrome to use", tone: "green" }
        : { live: false, text: `Ready in ${name}`, tone: "green" };
    }
    case "problem":
      return {
        live: false,
        text: signInCopy(availability.problem, site, availability.sourceName).title,
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
  }
}

function signInCopy(
  problem: Parameters<typeof browserSignInProblemCopy>[0],
  site: string,
  sourceName: string | null,
): ReturnType<typeof browserSignInProblemCopy> {
  return browserSignInProblemCopy(problem, {
    connectHere: false,
    context: "request",
    site,
    sourceName,
  });
}

/**
 * An agent wants one site signed in, in its live browser, with the person's
 * own Chrome sign-in. The body says whose sign-in, who gets to use it, and
 * whether Chrome can supply it now; every problem names its one fix, and the
 * Request stays open until Chrome can answer.
 */
function BrowserSignInBody(props: {
  readonly canRespond: boolean;
  readonly failure: string | null;
  readonly payload: Extract<RequestPayload, { kind: "browser.sign-in" }>;
  readonly pendingId: string | null;
  readonly reason: string | null;
  readonly state: SignInState;
}): ReactNode {
  const { state } = props;
  const { site } = props.payload;
  const domain = browserSiteLabel(site);
  const availability = signInAvailability(state.inspection);
  const choices = availability?.kind === "choices" ? availability.choices : [];
  const selected =
    choices.length === 1
      ? choices[0]
      : choices.find((choice) => choice.sourceId === state.chosenSourceId);
  const candidates = state.inspection?.candidates ?? [];
  const busy = props.pendingId !== null;
  const status = signInStatus({
    allowed: state.allowed,
    availability,
    error: state.error,
    site,
  });
  return (
    <View style={styles.choices}>
      <AppText role="body">
        {`Your agent wants to use your ${domain} sign-in from ${selected?.name ?? "Chrome"}.`}
      </AppText>
      <AppText role="secondary" tone="soft">
        {`Agents in ${state.workspaceName} will be able to use ${domain} as you.`}
      </AppText>
      <View
        accessibilityLiveRegion="polite"
        accessible
        accessibilityLabel={
          status.detail === null ? status.title : `${status.title}. ${status.detail}`
        }
        style={styles.signInStatus}
      >
        <View style={styles.signInStatusHead}>
          <StatusDot live={status.live} tone={status.tone} />
          <AppText role="secondaryMedium" style={styles.signInLineText}>
            {status.title}
          </AppText>
        </View>
        {status.detail === null ? null : (
          <AppText role="secondary" tone="soft">
            {status.detail}
          </AppText>
        )}
      </View>
      {candidates.length > 1 && state.allowed === null ? (
        <ChromeChoices>
          {candidates.map((candidate) => (
            <ChromeChoice
              checked={selected?.sourceId === candidate.sourceId}
              detail={chromeCandidateDetail(candidate, site)}
              disabled={busy || !choices.some((choice) => choice.sourceId === candidate.sourceId)}
              key={candidate.sourceId}
              label={candidate.name}
              onPress={() => state.onChoose(candidate.sourceId)}
            />
          ))}
        </ChromeChoices>
      ) : null}
      <ResponseStatus failure={props.failure} reason={props.reason} />
      {state.allowed === null ? (
        <PrimaryButton
          busy={props.pendingId === signInAllowId}
          disabled={!props.canRespond || busy || selected === undefined}
          label="Allow"
          onPress={() => {
            if (selected !== undefined) state.onAllow(selected.sourceId);
          }}
        />
      ) : null}
      <SecondaryButton
        busy={props.pendingId === signInDeclineId}
        disabled={!props.canRespond || busy}
        label="Don’t allow"
        onPress={state.onDecline}
      />
      <AppText role="caption" tone="muted">
        Opensteer’s browser can’t use passkeys, so a site that asks for one, or ties a sign-in to
        one device, may still ask your agent to sign in.
      </AppText>
    </View>
  );
}

function signInStatus(input: {
  readonly allowed: BrowserSignInOutcome | null;
  readonly availability: ChromeSignInAvailability | null;
  readonly error: string | null;
  readonly site: string;
}): {
  readonly detail: string | null;
  readonly live: boolean;
  readonly title: string;
  readonly tone: DotTone;
} {
  const { availability, site } = input;
  const domain = browserSiteLabel(site);
  if (input.allowed !== null) {
    const name = input.allowed.status === "problem" ? input.allowed.sourceName : null;
    return {
      detail: "Open Chrome on that computer. This finishes by itself.",
      live: true,
      title: `Allowed. Waiting for ${name ?? "Chrome"}`,
      tone: "amber",
    };
  }
  if (availability === null) {
    return input.error === null
      ? { detail: null, live: true, title: "Checking Chrome…", tone: "muted" }
      : {
          detail: `${input.error} It checks again by itself.`,
          live: false,
          title: "Chrome couldn’t be checked",
          tone: "muted",
        };
  }
  switch (availability.kind) {
    case "no-chrome": {
      const copy = signInCopy("no-chrome", site, null);
      return { detail: copy.fix, live: false, title: copy.title, tone: "muted" };
    }
    case "choices": {
      const [first] = availability.choices;
      const single = availability.choices.length === 1 ? (first ?? null) : null;
      if (first?.online !== true) {
        const copy = signInCopy("chrome-offline", site, single?.name ?? null);
        return {
          detail: `${copy.fix ?? ""} Allow now; this finishes by itself when Chrome opens.`.trim(),
          live: false,
          title: copy.title,
          tone: "amber",
        };
      }
      return single !== null
        ? {
            detail: "Allow signs your agent in now.",
            live: false,
            title: `${single.name} is signed in to ${domain}`,
            tone: "green",
          }
        : {
            detail: "Choose which one to use.",
            live: false,
            title: `Several Chrome profiles are signed in to ${domain}`,
            tone: "green",
          };
    }
    case "problem": {
      const copy = signInCopy(availability.problem, site, availability.sourceName);
      return {
        detail: `${copy.fix ?? ""} This updates by itself.`.trim(),
        live: false,
        title: copy.title,
        tone: availability.problem === "chrome-offline" ? "amber" : "red",
      };
    }
  }
}

/** A sign-in Request that is no longer waiting, in the words of what happened. */
function BrowserSignInResolved(props: {
  readonly request: Request;
  readonly site: string;
}): ReactNode {
  const domain = browserSiteLabel(props.site);
  const { request } = props;
  const value =
    request.status === "fulfilled" && request.response.kind === "external"
      ? request.response.value
      : undefined;
  if (value?.["outcome"] === "applied") {
    const sourceName = typeof value["sourceName"] === "string" ? value["sourceName"] : "Chrome";
    const profileName = typeof value["profileName"] === "string" ? value["profileName"] : null;
    return (
      <Notice
        detail={`Used ${sourceName}.${profileName === null ? "" : ` Saved to profile ${profileName}.`}`}
        title={`Signed in to ${domain}`}
        tone="neutral"
      />
    );
  }
  if (value?.["outcome"] === "session-closed") {
    return (
      <Notice
        detail={`The agent’s browser closed first. Your agent signs in to ${domain} the next time it needs it.`}
        title={`Allowed ${domain}`}
        tone="neutral"
      />
    );
  }
  return (
    <Notice
      detail={
        request.status === "declined"
          ? `Your agent won’t use your ${domain} sign-in. Ask it again if you change your mind.`
          : "It has already been answered or withdrawn."
      }
      title={request.status === "declined" ? "Not allowed" : "This request is no longer waiting"}
      tone="neutral"
    />
  );
}

/** Often enough that the expiry never lags its deadline by more than a moment. */
const expiryTickMs = 5_000;

/**
 * An agent asked to sign in with a password saved on a Mac. The approval is
 * the card on that Mac, named — a phone is never it — and Don’t allow is the
 * phone's one control. The reason is the agent's own words, labelled as such.
 */
function PasswordSignInBody(props: {
  readonly canRespond: boolean;
  readonly failure: string | null;
  readonly machines: readonly MachineSummary[];
  readonly onDecline: () => void;
  readonly payload: Extract<RequestPayload, { kind: "browser.password-sign-in" }>;
  readonly pendingId: string | null;
  readonly reason: string | null;
}): ReactNode {
  const { payload } = props;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), expiryTickMs);
    return () => clearInterval(timer);
  }, []);
  const where =
    props.machines.find((machine) => machine.id === payload.runnerId)?.name ?? payload.computerName;
  const declining = props.pendingId === passwordSignInDeclineId;
  return (
    <View style={styles.choices}>
      <Notice
        detail={passwordSignInPrivacy(payload.site)}
        title={passwordSignInWaitingOn(where)}
        tone="neutral"
      />
      <View style={styles.status}>
        <AppText role="caption" tone="muted">
          {passwordSignInReasonLabel}
        </AppText>
        <AppText role="secondary" selectable tone="soft">
          {payload.reason}
        </AppText>
      </View>
      <AppText role="caption" tone="muted">
        {passwordSignInExpiry(payload.expiresAt, now)}
      </AppText>
      <ResponseStatus failure={props.failure} reason={props.reason} />
      <SecondaryButton
        accessibilityLabel={declining ? passwordSignInDecliningLabel : passwordSignInDeclineLabel}
        busy={declining}
        disabled={!props.canRespond || props.pendingId !== null}
        label={passwordSignInDeclineLabel}
        onPress={props.onDecline}
      />
    </View>
  );
}

/** A saved-password sign-in that is no longer waiting, in the card's own words. */
function PasswordSignInResolved(props: { readonly request: Request }): ReactNode {
  const outcome = passwordSignInOutcome(props.request);
  return (
    <Notice
      detail={
        outcome?.signedIn === true
          ? "Your agent checks the account before it continues."
          : "Your agent can ask again if it still needs this sign-in."
      }
      title={outcome?.text ?? "This request is no longer waiting"}
      tone="neutral"
    />
  );
}

/**
 * An agent asked to use an app on a Mac, or the whole screen of an agent
 * phone. Mac approval happens there; phone access can be allowed here.
 */
function ComputerAppAccessBody(props: {
  readonly access: "read" | "read-write";
  readonly canRespond: boolean;
  readonly definitionId: "android-phone" | "macos-app";
  readonly failure: string | null;
  readonly machines: readonly MachineSummary[];
  readonly onAllow: () => void;
  readonly onDecline: () => void;
  readonly pendingId: string | null;
  readonly reason: string | null;
  readonly runnerId: string;
}): ReactNode {
  // A computer this viewer cannot see is still somewhere; it is just not
  // named. The mobile app is never at the Mac it asks about.
  const approval = computerAppAccessApproval({
    definitionId: props.definitionId,
    machines: props.machines,
    onThatMac: false,
    runnerId: props.runnerId,
  });
  return (
    <View style={styles.choices}>
      <Notice
        detail={`${computerUseAccessLabel[props.access]}. ${approval.detail}`}
        title={approval.approveOn}
        tone="neutral"
      />
      <ResponseStatus failure={props.failure} reason={props.reason} />
      {props.definitionId === "android-phone" ? (
        <SecondaryButton
          busy={props.pendingId === computerAppAllowId}
          disabled={!props.canRespond || props.pendingId !== null}
          label="Allow"
          onPress={props.onAllow}
        />
      ) : null}
      <SecondaryButton
        busy={props.pendingId === computerAppDeclineId}
        disabled={!props.canRespond || props.pendingId !== null}
        label="Decline"
        onPress={props.onDecline}
      />
    </View>
  );
}

/** One named decision. The tap is the answer, so the row says so to a screen reader. */
function ChoiceOptionRow(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly option: RequestOption;
}): ReactNode {
  const { option } = props;
  const affirmative =
    option.hint === "allow-once" || option.hint === "allow-for-run" || option.hint === "confirm";
  return (
    <Pressable
      accessibilityHint="Sends this answer"
      accessibilityLabel={[option.label, option.description].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.optionRow,
        pressed && styles.optionRowPressed,
        props.disabled && !props.busy && styles.disabled,
      ]}
    >
      <View style={styles.optionText}>
        <AppText
          role={affirmative ? "bodyMedium" : "body"}
          tone={affirmative ? "ember" : "default"}
        >
          {props.busy ? "Sending…" : option.label}
        </AppText>
        {option.description === undefined ? null : (
          <AppText role="secondary" tone="muted">
            {option.description}
          </AppText>
        )}
      </View>
      {props.busy ? <ActivityIndicator color={color.ember} /> : null}
    </Pressable>
  );
}

function RequestForm(props: {
  readonly answers: RequestFormDraft;
  readonly disabled: boolean;
  readonly fields: readonly RequestFormField[];
  readonly onAnswersChange: (answers: RequestFormDraft) => void;
}): ReactNode {
  const numbered = props.fields.length > 1;

  return (
    <View style={styles.form}>
      {props.fields.map((field, index) => {
        const mode = requestFieldMode(field);
        const values = requestDraftValues(props.answers, field.id);
        const setValues = (next: readonly string[]): void =>
          props.onAnswersChange(withRequestDraftValues(props.answers, field.id, next));
        const position = numbered ? `Question ${index + 1} of ${props.fields.length}` : null;
        const meta = [position, field.label].filter((part) => part != null).join(" · ");
        const hint =
          mode === "one" ? "Choose one" : mode === "many" ? "Choose one or more" : undefined;
        const name = field.prompt === "" ? (field.label ?? "Your answer") : field.prompt;
        return (
          <View key={field.id} style={styles.field}>
            {meta === "" && field.prompt === "" ? null : (
              // One header per question, so the rotor moves question to question.
              <View accessibilityRole="header" accessible style={styles.fieldHead}>
                {meta === "" ? null : (
                  <AppText role="caption" tone="muted">
                    {meta}
                  </AppText>
                )}
                {field.prompt === "" ? null : (
                  <AppText role="bodyMedium" selectable>
                    {field.prompt}
                  </AppText>
                )}
              </View>
            )}
            {hint === undefined ? null : (
              <AppText role="caption" tone="muted">
                {hint}
              </AppText>
            )}
            {mode === "unavailable" ? (
              <AppText role="secondary" tone="soft">
                This question cannot accept an answer. Ask the agent to send it again.
              </AppText>
            ) : mode === "text" ? (
              <TextInput
                accessibilityLabel={name}
                autoCapitalize={field.secret ? "none" : "sentences"}
                autoComplete="off"
                autoCorrect={!field.secret}
                cursorColor={color.ember}
                editable={!props.disabled}
                importantForAutofill={field.secret ? "no" : "auto"}
                maxFontSizeMultiplier={controlFontScaleLimit}
                maxLength={requestAnswerMaxLength}
                // Long answers scroll within a bounded field; secrets stay on
                // one masked line.
                multiline={!field.secret}
                onChangeText={(value) => setValues(value ? [value] : [])}
                placeholder={field.secret ? "Hidden as you type" : "Type your answer"}
                placeholderTextColor={color.muted}
                scrollEnabled
                secureTextEntry={field.secret}
                selectionColor={color.ember}
                spellCheck={!field.secret}
                style={[
                  type.body,
                  styles.input,
                  { maxHeight: 200 },
                  props.disabled && styles.disabled,
                ]}
                value={values[0] ?? ""}
              />
            ) : (
              <RowGroup>
                {(field.choices ?? []).map((choice, choiceIndex) => (
                  <FormChoiceRow
                    description={choice.description}
                    disabled={props.disabled}
                    hint={position === null ? hint : `${hint}, ${position.toLowerCase()}`}
                    // Values are not required to be unique; their position is.
                    key={`${choiceIndex}:${choice.value}`}
                    label={choice.label}
                    mode={mode}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setValues(toggleRequestChoice(field, values, choice.value));
                    }}
                    selected={values.includes(choice.value)}
                  />
                ))}
              </RowGroup>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * A choice that is only marked, never sent. The indicator is drawn whether or
 * not the row is chosen, because an empty ring or box is what says a row can
 * be chosen at all, and its shape says how many may be.
 */
function FormChoiceRow(props: {
  readonly description: string | undefined;
  readonly disabled: boolean;
  readonly hint: string | undefined;
  readonly label: string;
  readonly mode: "one" | "many";
  readonly onPress: () => void;
  readonly selected: boolean;
}): ReactNode {
  const many = props.mode === "many";
  return (
    <Pressable
      accessibilityHint={props.hint}
      accessibilityLabel={[props.label, props.description].filter(Boolean).join(", ")}
      accessibilityRole={many ? "checkbox" : "radio"}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.choice,
        props.selected && styles.choiceSelected,
        pressed && styles.choicePressed,
        props.disabled && styles.disabled,
      ]}
    >
      <View
        style={[
          many ? styles.checkbox : styles.radio,
          props.selected && (many ? styles.checkboxOn : styles.radioOn),
        ]}
      >
        {props.selected ? (
          many ? (
            <Symbol name="checkmark" size={13} tint={color.inkOnEmber} weight="bold" />
          ) : (
            <View style={styles.radioDot} />
          )
        ) : null}
      </View>
      <View style={styles.optionText}>
        <AppText role={props.selected ? "bodyMedium" : "body"}>{props.label}</AppText>
        {props.description === undefined || props.description === "" ? null : (
          <AppText role="secondary" tone="muted">
            {props.description}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Send, how far the form is from being sendable, and why it cannot be sent
 * now, on the one line that is never scrolled away. Send stays disabled until
 * every question has an answer: the Host takes a form whole or not at all.
 */
function FormFooter(props: {
  readonly answers: RequestFormDraft;
  readonly canSend: boolean;
  readonly failure: string | null;
  readonly fields: readonly RequestFormField[];
  readonly held: RequestSubmission | null;
  readonly onSubmit: (answers: Record<string, string[]>) => void;
  readonly pending: boolean;
  readonly reason: string | null;
}): ReactNode {
  const progress = requestFormProgress(props.fields, props.answers);
  const answers = requestFormAnswers(props.fields, props.answers);
  const retrying =
    props.failure !== null &&
    answers !== null &&
    props.held !== null &&
    sameRequestResponse(props.held.response, { answers, kind: "form" });
  return (
    <View style={styles.footer}>
      <ResponseStatus failure={props.failure} reason={props.reason} />
      <View style={styles.footerRow}>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          role="secondary"
          style={styles.footerProgress}
          tone={progress.complete ? "soft" : "muted"}
        >
          {requestFormProgressLabel(progress)}
        </AppText>
        <PrimaryButton
          busy={props.pending}
          compact
          disabled={!props.canSend || answers === null}
          label={retrying ? "Try again" : progress.total === 1 ? "Send answer" : "Send answers"}
          onPress={() => {
            if (answers !== null) props.onSubmit(answers);
          }}
        />
      </View>
    </View>
  );
}

const indicatorSize = 22;

const styles = StyleSheet.create({
  body: { flex: 1, gap: space[6], paddingHorizontal: space[12], paddingVertical: space[10] },
  card: {
    backgroundColor: color.surfaceElevated,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    overflow: "hidden",
  },
  cardHighlighted: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  // Three points, not a hairline: this is the one ember rule in the app and at
  // a third of a point a 22% tint on near-black is not a line anyone sees.
  edge: { backgroundColor: color.ember, width: 3 },
  checkbox: {
    alignItems: "center",
    borderColor: color.lineControl,
    borderRadius: radius.xs,
    borderWidth: 2,
    height: indicatorSize,
    justifyContent: "center",
    // Centres the box on the label's first line, however many lines follow.
    marginTop: (type.body.lineHeight - indicatorSize) / 2,
    width: indicatorSize,
  },
  checkboxOn: { backgroundColor: color.ember, borderColor: color.ember },
  choice: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  choicePressed: { backgroundColor: color.surfacePressed },
  choiceSelected: { backgroundColor: color.emberWash },
  choices: { gap: space[8] },
  disabled: { opacity: 0.45 },
  field: { gap: space[6] },
  fieldHead: { gap: space[2] },
  footer: { gap: space[8] },
  footerProgress: { flex: 1 },
  footerRow: { alignItems: "center", flexDirection: "row", gap: space[12] },
  form: { gap: space[24] },
  highRisk: { color: color.red },
  input: {
    maxHeight: 200,
    backgroundColor: color.surfaceRaised,
    borderColor: color.lineControl,
    borderRadius: radius.sm,
    borderWidth: controlBorderWidth,
    color: color.text,
    marginTop: space[2],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
    textAlignVertical: "top",
  },
  mediumRisk: { color: color.amber },
  monoDetail: {
    backgroundColor: color.surfaceCode,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
  monoText: { color: color.textSoft, fontFamily: monoFontFamily },
  optionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
  optionRowPressed: { backgroundColor: color.surfacePressed },
  optionText: { flex: 1, gap: space[2] },
  radio: {
    alignItems: "center",
    borderColor: color.lineControl,
    borderRadius: radius.full,
    borderWidth: 2,
    height: indicatorSize,
    justifyContent: "center",
    marginTop: (type.body.lineHeight - indicatorSize) / 2,
    width: indicatorSize,
  },
  radioDot: { backgroundColor: color.ember, borderRadius: radius.full, height: 10, width: 10 },
  radioOn: { borderColor: color.ember },
  reviewPressed: { opacity: 0.68 },
  riskBadge: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[6],
    paddingHorizontal: space[10],
    paddingVertical: space[4],
  },
  riskBadgeHigh: { backgroundColor: color.redWash, borderColor: color.redLine },
  riskBadgeMedium: { backgroundColor: color.amberWash, borderColor: color.amberLine },
  sheetBody: { gap: space[16], paddingHorizontal: space[16], paddingTop: space[8] },
  sheetHead: { gap: space[8] },
  status: { gap: space[4] },
  summaryHead: { alignItems: "center", flexDirection: "row", gap: space[12] },
  summaryText: { flex: 1, gap: space[2] },
  signInLine: { alignItems: "center", flexDirection: "row", gap: space[8] },
  signInLineText: { flexShrink: 1 },
  signInStatus: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  signInStatusHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
});
