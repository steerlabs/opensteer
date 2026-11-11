import {
  browserAccessChoices,
  browserAccessGrantable,
  browserAccessGrantLabel,
  browserAccessHomeChoice,
  browserAccessInitialName,
  browserAccessInitialSelection,
  browserAccessProfileNote,
  browserAccessResponse,
  browserAccessWarning,
  browserSiteLabel,
  canRespondToRequests,
  cardChoiceLabel,
  cardUseConsent,
  cardUseEmpty,
  chromeCandidateDetail,
  deriveSurface,
  fullAccessDeclineLabel,
  fullAccessRequestBody,
  mutationIdempotencyKey,
  passwordSignInAccountList,
  passwordSignInAllowLabel,
  passwordSignInAllowRemembers,
  passwordSignInConsent,
  passwordSignInExpiry,
  passwordSignInNoAccount,
  passwordSignInOnceLabel,
  passwordSignInOtherAccounts,
  passwordSignInPrivacy,
  passwordSignInReasonLabel,
  type BrowserAccessSelection,
  type HostClient,
  type PasswordSignInAccount,
  type PasswordSignInAccountGroup,
  type RequestAsker,
  type SurfaceModel,
} from "@opensteer/client/host";
import { computerAppAccessApproval, computerUseAccessLabel } from "@opensteer/client/integrations";
import { useHostSelector, useHostSnapshot } from "@opensteer/client/react";
import {
  requestAgentProposedDetail,
  requestAgentProposedLabel,
  requestOptionDeclines,
  type BrowserSourceId,
  type Request,
  type RequestFormField,
  type RequestOption,
  type RequestPayload,
} from "@opensteer/core";
import type { CardChoice, MachineSummary, PasswordSignInCard } from "@opensteer/protocol";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChromeChoice,
  ChromeChoices,
  useChromeInspection,
} from "../browser/chrome-sign-in-parts.js";
import { useComputerAppApproval } from "../computers/computer-app-approval.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { HomeMenu } from "../screens/profile-home-menu.js";
import { color, controlFontScaleLimit, radius, space, touchTarget, type } from "../theme.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Chip, monoFontFamily, Notice, StatusDot } from "../ui/primitives.js";
import { SheetBarButton } from "../ui/sheet-bar.js";
import { Symbol } from "../ui/symbol.js";
import { AnswerPill, AnswerRow } from "./answer-pill.js";
import { requestTitle } from "./docked-requests.js";
import { AskerByline, useRequestAsker } from "./asker-byline.js";
import { InstallReview } from "./integration-install-review.js";
import {
  approvalMenuOptions,
  confirmHighRisk,
  requestCardAnswers,
  requestOptionLabel,
  threadTakesDenialReason,
} from "./request-answers.js";
import { NativeMenu } from "./composer-menu.js";
import {
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
} from "./request-form-model.js";
import { updateRequestSession, type RequestSession } from "./request-session.js";
import { signInAvailability, signInStatus } from "./request-sign-in-status.js";
import { useThreadMutation } from "./thread-mutation-registry.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";
import { useRequestResponse, type RequestResponder } from "./use-request-response.js";

/** A native answer in English: the same word for a refusal on every kind of Request. */
const declineLabel = "Don’t Allow";

export type RequestSheetScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /** Answers pinned under a long request, which only a single-height sheet can hold. */
  readonly full?: boolean;
  /** "Don't Allow and say why": the sheet takes the reason instead. */
  readonly reason?: boolean;
  readonly requestId: string;
  readonly threadId: string;
}>;

/** The route names a Request and nothing else: what it asks is read from the Host. */
export function RequestSheetScreen(props: RequestSheetScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId, reason, requestId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Gone onClose={() => navigation.goBack()} />;
  }
  return (
    <SubscribedRequestSheet
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      key={`${deploymentId}:${requestId}`}
      reason={reason === true}
      requestId={requestId}
      threadId={threadId}
    />
  );
}

function SubscribedRequestSheet(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly reason: boolean;
  readonly requestId: string;
  readonly threadId: string;
}): ReactNode {
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(props.hostClient);
  const { requestId, threadId } = props;
  const request =
    (snapshot.requests[threadId] ?? []).find(({ id }) => id === requestId) ??
    snapshot.waitingRequests.find(({ request }) => request.id === requestId)?.request ??
    null;
  const pending = request?.status === "pending" ? request : null;
  // Admitted and gone can both ask to close; only the sheet itself may go back.
  const close = useRef(() => undefined as void);
  close.current = () => {
    if (navigation.isFocused()) navigation.goBack();
  };
  // Answered elsewhere, withdrawn or admitted: there is nothing left to decide here.
  useEffect(() => {
    if (pending === null) close.current();
  }, [pending === null]);
  if (pending === null || snapshot.user === null) return null;
  return (
    <SheetForRequest
      {...props}
      canRespond={canRespondToRequests(snapshot)}
      machines={snapshot.machines}
      onClose={() => close.current()}
      surface={deriveSurface([pending], snapshot.user)}
      userId={snapshot.user.id}
    />
  );
}

/** The Thread's own gate and draft, as the composer holds them, from a sibling route. */
function SheetForRequest(props: {
  readonly canRespond: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
  readonly onClose: () => void;
  readonly reason: boolean;
  readonly surface: SurfaceModel | null;
  readonly userId: string;
}): ReactNode {
  const { deploymentId, hostClient, surface, userId } = props;
  const navigation = useNavigation();
  const threadId = surface?.request.originatingThreadId ?? "";
  const { drafts } = useMobileClient();
  const { gate, owner } = useThreadMutation({ deploymentId, threadId, userId });
  const archived = useHostSelector(
    hostClient,
    (snapshot) => snapshot.threads.find(({ id }) => id === threadId)?.status === "archived",
  );
  if (surface === null) return null;
  const pendingMessage = owner === "message" || drafts.readPending(deploymentId, userId, threadId);
  return (
    <RequestSheetContent
      canRespond={props.canRespond}
      canStartResponse={() =>
        !archived && drafts.readPending(deploymentId, userId, threadId) === null
      }
      disabledReason={
        archived
          ? "This thread is archived."
          : pendingMessage
            ? "Finish sending your message before responding."
            : owner === "settings"
              ? "Updating thread settings…"
              : null
      }
      gate={gate}
      hostClient={hostClient}
      machines={props.machines}
      onClose={props.onClose}
      reason={props.reason}
      onOpenSubagent={(asker) => {
        props.onClose();
        navigation.dispatch(
          StackActions.push("Subagent", {
            deploymentId,
            nodeId: asker.nodeId,
            threadId: asker.threadId,
          }),
        );
      }}
      surface={surface}
    />
  );
}

function Gone(props: { readonly onClose: () => void }): ReactNode {
  return (
    <View style={styles.gone}>
      <Notice
        detail="This deployment is no longer open."
        title="Can’t answer this here"
        tone="neutral"
      />
      <AnswerRow>
        <AnswerPill label="Close" onPress={props.onClose} tone="secondary" />
      </AnswerRow>
    </View>
  );
}

/**
 * Everything too large to answer on the card, in the form every sheet in the app
 * takes. The list is the sheet's direct child, because iOS sizes that list to
 * each detent; its bar is a sticky row in it rather than a sibling, which keeps
 * Send in reach above the keyboard at either height. Only a long request pins
 * answers under the list, and the route gives that one a single height.
 */
export function RequestSheetContent(props: {
  readonly canRespond: boolean;
  readonly canStartResponse: () => boolean;
  readonly disabledReason: string | null;
  readonly gate: ThreadMutationGate;
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
  readonly onClose: () => void;
  readonly reason: boolean;
  /** Opens the asking subagent's own view, where it can be answered too. */
  readonly onOpenSubagent?: (asker: RequestAsker) => void;
  readonly surface: SurfaceModel;
}): ReactNode {
  const { surface } = props;
  const { request } = surface;
  const { presentation } = request;
  const asker = useRequestAsker(props.hostClient, request);
  const insets = useSafeAreaInsets();
  const computerApproval = useComputerAppApproval(props.hostClient);
  const close = (): void => {
    computerApproval.close();
    props.onClose();
  };
  const responder = useRequestResponse({
    canRespond: props.canRespond,
    canStartResponse: props.canStartResponse,
    gate: props.gate,
    hostClient: props.hostClient,
    onAdmitted: close,
    surface,
  });
  const { session } = responder;
  const answers = requestCardAnswers(request, surface.denied !== null);
  const title = requestTitle(request);
  // The agent's reason is labelled as the agent's in the password body below.
  const detail =
    presentation.detail === undefined ||
    presentation.detail === "" ||
    request.payload.kind === "browser.password-sign-in"
      ? null
      : presentation.detail;
  // While an answer is in flight the busy control already says so, and where.
  const blocked = session.pendingId === null ? props.disabledReason : null;
  // "Say why" comes from the card's menu by route, or from this sheet's own.
  const [askingWhy, setAskingWhy] = useState(props.reason);
  const reasonText = session.reason;
  const decline = answers.kind === "approve" ? answers.decline : null;

  useEffect(() => {
    updateRequestSession(session, { sheetOpen: true });
    return () => updateRequestSession(session, { sheetOpen: false });
  }, [session]);

  const form = presentation.kind === "form" ? presentation.fields : null;
  const formAnswers = form === null ? null : requestFormAnswers(form, session.answers);
  const retryingForm =
    session.failure !== null &&
    formAnswers !== null &&
    session.held !== null &&
    sameRequestResponse(session.held.response, { answers: formAnswers, kind: "form" });
  const canSend = props.canRespond && session.pendingId === null;
  const sendForm = (): void => {
    if (formAnswers === null) return;
    Keyboard.dismiss();
    void responder.submit({ answers: formAnswers, kind: "form" }, "form");
  };
  const sendReason = (): void => {
    if (decline === null || reasonText.trim() === "") return;
    Keyboard.dismiss();
    void responder.submit({ kind: "choice", optionId: decline.id, text: reasonText }, "reason");
  };

  const send = askingWhy ? (
    <AnswerPill
      busy={session.pendingId === "reason"}
      disabled={!canSend || reasonText.trim() === ""}
      label="Send"
      onPress={sendReason}
      tone="primary"
    />
  ) : form !== null && surface.denied === null ? (
    <AnswerPill
      busy={session.pendingId === "form"}
      disabled={!canSend || formAnswers === null}
      label={retryingForm ? "Try Again" : "Send"}
      onPress={sendForm}
      tone="primary"
    />
  ) : null;

  const list = (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.content,
        !askingWhy && answers.kind === "approve"
          ? null
          : { paddingBottom: insets.bottom + space[16] },
      ]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={[0]}
      style={styles.sheet}
    >
      <View style={styles.bar}>
        <SheetBarButton icon="xmark" label={`Close ${title}`} onPress={close} />
        <View accessibilityRole="header" style={styles.barTitle}>
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="title">
            {askingWhy ? "Tell the agent why" : title}
          </AppText>
        </View>
        {send ?? <View style={styles.barSpace} />}
      </View>
      <View style={styles.body}>
        {presentation.kind === "choice" && presentation.risk === "high" ? <HighRisk /> : null}
        {/* The bar holds one line of a title that may run to several. */}
        {!askingWhy && title.length > barTitleLength ? (
          <AppText role="bodyMedium" selectable>
            {title}
          </AppText>
        ) : null}
        {presentation.agentProposed === true ? (
          <AppText accessibilityHint={requestAgentProposedDetail} role="caption" tone="muted">
            {requestAgentProposedLabel}
          </AppText>
        ) : null}
        {asker === null || props.onOpenSubagent === undefined ? null : (
          <AskerByline
            asker={asker}
            hostClient={props.hostClient}
            onOpen={() => props.onOpenSubagent?.(asker)}
          />
        )}
        {detail === null ? null : (
          <RequestDetail mono={request.kind === "harness.approval"} text={detail} />
        )}
        {request.payload.kind === "integration.input" ? (
          <AppText role="secondary" tone="muted">
            Only this plugin receives what you enter. The agent never sees it.
          </AppText>
        ) : null}
        {askingWhy ? (
          <>
            <ResponseStatus failure={session.failure} reason={blocked} />
            <TextInput
              accessibilityLabel="Why the agent shouldn’t do this"
              autoFocus
              cursorColor={color.ember}
              maxFontSizeMultiplier={controlFontScaleLimit}
              maxLength={requestAnswerMaxLength}
              multiline
              onChangeText={(reason) => updateRequestSession(session, { reason })}
              placeholder="What should it do instead?"
              placeholderTextColor={color.muted}
              selectionColor={color.ember}
              style={[type.secondary, styles.input]}
              value={reasonText}
            />
          </>
        ) : (
          (computerApproval.content ?? (
            <RequestBody
              answers={answers}
              canRespond={props.canRespond}
              computerApproval={computerApproval}
              hostClient={props.hostClient}
              machines={props.machines}
              reason={blocked}
              responder={responder}
              surface={surface}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
  if (askingWhy || answers.kind !== "approve") return list;
  // A long approval: the same answers as its card, always in reach under it.
  const more = approvalMenuOptions({
    answers,
    detail,
    onAnswer: (option) => void responder.submit({ kind: "choice", optionId: option.id }, option.id),
    onSayWhy: () => setAskingWhy(true),
    readable: true,
    request,
    takesReason:
      answers.takesReason &&
      threadTakesDenialReason(props.hostClient.getSnapshot(), request.originatingThreadId),
    title,
  });
  return (
    <View style={styles.sheet}>
      {list}
      <View style={[styles.pinned, { paddingBottom: insets.bottom + space[6] }]}>
        <ResponseStatus failure={session.failure} reason={blocked} />
        <AnswerRow
          leading={
            more.length === 0 ? undefined : (
              <NativeMenu accessibilityLabel="More answers" options={more}>
                <View style={styles.moreGlyph}>
                  <Symbol name="ellipsis" size={17} tint={color.textSoft} />
                </View>
              </NativeMenu>
            )
          }
        >
          <AnswerPill
            busy={session.pendingId === answers.decline.id}
            disabled={!props.canRespond || session.pendingId !== null}
            label={requestOptionLabel(request, answers.decline)}
            onPress={() =>
              void responder.submit(
                { kind: "choice", optionId: answers.decline.id },
                answers.decline.id,
              )
            }
            tone="secondary"
          />
          <AnswerPill
            busy={session.pendingId === answers.allow.id}
            disabled={!props.canRespond || session.pendingId !== null}
            label={`${requestOptionLabel(request, answers.allow)}${answers.highRisk ? "…" : ""}`}
            onPress={() =>
              answers.highRisk
                ? confirmHighRisk(
                    title,
                    detail,
                    () =>
                      void responder.submit(
                        { kind: "choice", optionId: answers.allow.id },
                        answers.allow.id,
                      ),
                  )
                : void responder.submit(
                    { kind: "choice", optionId: answers.allow.id },
                    answers.allow.id,
                  )
            }
            tone={answers.highRisk ? "danger" : "primary"}
          />
        </AnswerRow>
      </View>
    </View>
  );
}

/** About what a sheet's bar shows on the narrowest phone before it cuts a title off. */
const barTitleLength = 30;

function HighRisk(): ReactNode {
  return (
    <View style={styles.highRisk}>
      <Symbol name="exclamationmark.triangle.fill" size={13} tint={color.red} />
      <AppText role="caption" style={styles.highRiskLabel}>
        High risk
      </AppText>
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
      <AppText role="caption" selectable style={styles.monoText}>
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
        <AppText role="caption" tone="muted">
          {props.reason}
        </AppText>
      )}
      {props.failure === null ? null : (
        <AppText role="caption" tone="danger">
          {props.failure}
        </AppText>
      )}
    </View>
  );
}

function RequestBody(props: {
  readonly answers: ReturnType<typeof requestCardAnswers>;
  readonly canRespond: boolean;
  readonly computerApproval: ReturnType<typeof useComputerAppApproval>;
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
  readonly reason: string | null;
  readonly responder: RequestResponder;
  readonly surface: SurfaceModel;
}): ReactNode {
  const { canRespond, reason, responder, surface } = props;
  const { request } = surface;
  const { session } = responder;

  if (surface.denied !== null) {
    return (
      <Notice
        detail={
          surface.denied === "administrator"
            ? "A Host administrator has to answer this. It stays open until they do."
            : surface.denied === "manager"
              ? "A manager of this project has to answer this. It stays open until they do."
              : surface.denied === "other"
                ? "You can’t answer this. It stays open until someone who can does."
                : "The person who started this task has to answer this. It stays open until they do."
        }
        title="Someone else answers this"
        tone="neutral"
      />
    );
  }

  // Its answers are pinned under the sheet's list.
  if (props.answers.kind === "approve") return null;

  const decline = (busyId: string): void =>
    void responder.submit({ kind: "external", value: { decision: "declined" } }, busyId);

  switch (request.presentation.kind) {
    case "choice": {
      const { options, risk } = request.presentation;
      const choose = (option: RequestOption): void => {
        const send = (): void =>
          void responder.submit({ kind: "choice", optionId: option.id }, option.id);
        if (risk === "high" && !requestOptionDeclines(option)) {
          confirmHighRisk(requestTitle(request), request.presentation.detail ?? null, send);
        } else send();
      };
      return (
        <View style={styles.section}>
          {request.payload.kind === "integration.install" ? (
            <InstallReview
              canInstall
              continuesToAccess={false}
              installedTitle={null}
              manifest={request.payload.manifest}
            />
          ) : null}
          <ResponseStatus failure={session.failure} reason={reason} />
          <View style={styles.group}>
            {options.map((option, index) => (
              <ChoiceOptionRow
                busy={session.pendingId === option.id}
                disabled={!canRespond || session.pendingId !== null}
                key={option.id}
                onPress={() => choose(option)}
                option={option}
                separated={index > 0}
              />
            ))}
          </View>
        </View>
      );
    }
    case "form":
      return (
        <>
          <ResponseStatus failure={session.failure} reason={reason} />
          <RequestForm
            answers={session.answers}
            // The draft stays editable while offline; only sending waits.
            disabled={session.pendingId !== null}
            fields={request.presentation.fields}
            onAnswersChange={(answers) => updateRequestSession(session, { answers })}
          />
        </>
      );
    case "external":
      return request.kind === "machine.full-disk-access" &&
        request.payload.kind === "machine.full-disk-access" ? (
        <View style={styles.section}>
          <Notice
            detail={fullAccessRequestBody(request.payload.machineName)}
            title={`macOS permission needed on ${request.payload.machineName}`}
            tone="neutral"
          />
          <ResponseStatus failure={session.failure} reason={reason} />
          <AnswerRow>
            <AnswerPill
              busy={session.pendingId === "full-disk-access-decline"}
              disabled={!canRespond || session.pendingId !== null}
              label={fullAccessDeclineLabel}
              onPress={() => decline("full-disk-access-decline")}
              tone="secondary"
            />
          </AnswerRow>
        </View>
      ) : request.kind === "computer.app.access" &&
        request.payload.kind === "computer.app.access" ? (
        <ComputerAppAccessBody
          access={request.payload.access}
          canRespond={canRespond}
          definitionId={request.payload.definitionId}
          failure={session.failure}
          machines={props.machines}
          onAllow={() => {
            const { payload } = request;
            if (payload.kind !== "computer.app.access") return;
            const { access, definitionId, runnerId, setupRequestId } = payload;
            void responder.attempt("computer-app-allow", { shareWithAi: true }, async () => {
              if (definitionId !== "android-phone") {
                await props.computerApproval.ask(setupRequestId);
                return;
              }
              const result = await props.hostClient.dispatch({
                idempotencyKey: mutationIdempotencyKey(`phone-request:${request.id}`),
                input: { access, app: null, definitionId, kind: "app", runnerId },
                type: "integration.computer.setup.set",
              });
              if (result.type !== "integration.computer.setup.set") {
                throw new Error("Could not confirm your answer was sent.");
              }
              responder.admitted();
            });
          }}
          onDecline={() => decline("computer-app-decline")}
          pendingId={session.pendingId}
          reason={reason}
          runnerId={request.payload.runnerId}
        />
      ) : request.kind === "browser.access" && request.payload.kind === "browser.access" ? (
        <BrowserAccessBody
          canRespond={canRespond}
          failure={session.failure}
          hostClient={props.hostClient}
          onRespond={(selection, name, home) =>
            void responder.submit(
              browserAccessResponse(selection, name, home),
              selection === null ? "browser-access-decline" : "browser-access-grant",
            )
          }
          pendingId={session.pendingId}
          reason={reason}
          request={request}
          session={session}
        />
      ) : request.kind === "browser.password-sign-in" &&
        request.payload.kind === "browser.password-sign-in" ? (
        <PasswordSignInBody
          canRespond={canRespond}
          hostClient={props.hostClient}
          payload={request.payload}
          reason={reason}
          requestId={request.id}
          responder={responder}
          workspaceId={request.targetWorkspaceId}
        />
      ) : request.kind === "browser.sign-in" && request.payload.kind === "browser.sign-in" ? (
        <BrowserSignInBody
          canRespond={canRespond}
          hostClient={props.hostClient}
          payload={request.payload}
          reason={reason}
          responder={responder}
          workspaceId={request.targetWorkspaceId}
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

/**
 * Which browser profile a Workspace's agents may use, including empty creation.
 * Profiles come from the Host snapshot, never from the agent's words; a
 * profile already available to the Workspace says so and completes at once.
 */
function BrowserAccessBody(props: {
  readonly canRespond: boolean;
  readonly failure: string | null;
  readonly hostClient: HostClient;
  readonly onRespond: (
    selection: BrowserAccessSelection | null,
    name: string,
    home: string | null,
  ) => void;
  readonly pendingId: string | null;
  readonly reason: string | null;
  readonly request: Request;
  readonly session: RequestSession;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const { session } = props;
  const { payload } = props.request;
  const suggestion = payload.kind === "browser.access" ? payload.suggestion : null;
  const profiles = snapshot.browserProfiles;
  const selection: BrowserAccessSelection | null =
    session.browserSelection !== undefined
      ? session.browserSelection
      : suggestion
        ? browserAccessInitialSelection(suggestion, profiles)
        : null;
  const name = session.browserName ?? (suggestion ? browserAccessInitialName(suggestion) : "");
  const choices = browserAccessChoices(snapshot, props.request.targetWorkspaceId);
  const hereId = useHereDeviceId(snapshot.deploymentId ?? "");
  const homes = browserAccessHomeChoice(snapshot, hereId, props.request);
  // The person's pick stands while it is still on offer; the default follows the list.
  const home = homes
    ? (homes.options.find(({ id }) => id === session.browserHome)?.id ?? homes.initial)
    : null;
  const busy = props.pendingId !== null;
  const disabled = !props.canRespond || busy;
  const choose = (next: BrowserAccessSelection): void => {
    void Haptics.selectionAsync();
    updateRequestSession(session, { browserSelection: next });
  };
  const changeName = (browserName: string): void => updateRequestSession(session, { browserName });
  return (
    <View style={styles.section}>
      <View style={styles.group}>
        {choices.profiles.map((profile, index) => (
          <FormChoiceRow
            description={browserAccessProfileNote(choices, profile) ?? undefined}
            disabled={busy}
            hint="Choose one"
            key={profile.id}
            label={profile.name}
            mode="one"
            onPress={() => choose({ kind: "existing", profileId: profile.id })}
            selected={selection?.kind === "existing" && selection.profileId === profile.id}
            separated={index > 0}
          />
        ))}
        <FormChoiceRow
          description={undefined}
          disabled={busy}
          hint="Choose one"
          label="New profile"
          mode="one"
          onPress={() => choose({ kind: "new" })}
          selected={selection?.kind === "new"}
          separated={choices.profiles.length > 0}
        />
      </View>
      {selection?.kind === "new" ? (
        <View style={styles.nameField}>
          {homes && home ? (
            <View style={styles.inputWithHome}>
              <ProfileNameInput
                busy={busy}
                onChangeText={changeName}
                style={[styles.inputBeforeHome, busy && styles.disabled]}
                value={name}
              />
              <HomeMenu
                disabled={busy}
                home={home}
                homes={homes}
                onChoose={(browserHome) => updateRequestSession(session, { browserHome })}
              />
            </View>
          ) : (
            <ProfileNameInput
              busy={busy}
              onChangeText={changeName}
              style={[styles.input, busy && styles.disabled]}
              value={name}
            />
          )}
          {choices.nameSuggestions.length > 0 ? (
            <View accessibilityLabel="Suggested names" style={styles.nameSuggestions}>
              {choices.nameSuggestions.map((suggestion) => (
                <Chip
                  accessibilityLabel={`Name it ${suggestion}`}
                  disabled={busy}
                  key={suggestion}
                  label={suggestion}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    changeName(suggestion);
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <AppText role="caption" tone="muted">
        {browserAccessWarning(choices)}
      </AppText>
      <ResponseStatus failure={props.failure} reason={props.reason} />
      <AnswerRow>
        <AnswerPill
          busy={props.pendingId === "browser-access-decline"}
          disabled={disabled}
          label="Not now"
          onPress={() => props.onRespond(null, name, null)}
          tone="secondary"
        />
        <AnswerPill
          busy={props.pendingId === "browser-access-grant"}
          disabled={disabled || !browserAccessGrantable(selection, name, profiles)}
          label={browserAccessGrantLabel(selection, choices)}
          onPress={() => props.onRespond(selection, name, home)}
          tone="primary"
        />
      </AnswerRow>
    </View>
  );
}

function ProfileNameInput(props: {
  readonly busy: boolean;
  readonly onChangeText: (name: string) => void;
  readonly style: TextInputProps["style"];
  readonly value: string;
}): ReactNode {
  return (
    <TextInput
      accessibilityLabel="Profile name"
      autoCapitalize="words"
      cursorColor={color.ember}
      editable={!props.busy}
      maxFontSizeMultiplier={controlFontScaleLimit}
      maxLength={120}
      onChangeText={props.onChangeText}
      placeholder="Personal, Work, Finance…"
      placeholderTextColor={color.muted}
      selectionColor={color.ember}
      style={[type.secondary, props.style]}
      value={props.value}
    />
  );
}

/**
 * An agent wants one site signed in, in its live browser, with the person's
 * own Chrome sign-in. The body says whose sign-in, who gets to use it, and
 * whether Chrome can supply it now; every problem names its one fix, and the
 * Request stays open until Chrome can answer.
 */
function BrowserSignInBody(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly payload: Extract<RequestPayload, { kind: "browser.sign-in" }>;
  readonly reason: string | null;
  readonly responder: RequestResponder;
  readonly workspaceId: string;
}): ReactNode {
  const { responder } = props;
  const { session } = responder;
  const { site } = props.payload;
  const domain = browserSiteLabel(site);
  const live = useChromeInspection(props.hostClient, site, props.canRespond);
  const workspaceName = useWorkspaceName(props.hostClient, props.workspaceId);
  const availability = signInAvailability(live.inspection);
  const choices = availability?.kind === "choices" ? availability.choices : [];
  const selected =
    choices.length === 1
      ? choices[0]
      : choices.find((choice) => choice.sourceId === session.chosenSourceId);
  const candidates = live.inspection?.candidates ?? [];
  const busy = session.pendingId !== null;
  const status = signInStatus({
    allowed: session.allowed,
    availability,
    error: live.error,
    site,
  });
  const allow = (sourceId: BrowserSourceId): void =>
    void responder.respondSignIn({ decision: "allow", sourceId }, "browser-sign-in-allow");
  return (
    <View style={styles.section}>
      <AppText role="secondary">
        {`Your agent wants to use your ${domain} sign-in from ${selected?.name ?? "Chrome"}.`}
      </AppText>
      <AppText role="caption" tone="soft">
        {`Agents in ${workspaceName} will be able to use ${domain} as you.`}
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
          <AppText role="secondaryMedium" style={styles.shrink}>
            {status.title}
          </AppText>
        </View>
        {status.detail === null ? null : (
          <AppText role="caption" tone="soft">
            {status.detail}
          </AppText>
        )}
      </View>
      {candidates.length > 1 && session.allowed === null ? (
        <ChromeChoices>
          {candidates.map((candidate) => (
            <ChromeChoice
              checked={selected?.sourceId === candidate.sourceId}
              detail={chromeCandidateDetail(candidate, site)}
              disabled={busy || !choices.some((choice) => choice.sourceId === candidate.sourceId)}
              key={candidate.sourceId}
              label={candidate.name}
              onPress={() => updateRequestSession(session, { chosenSourceId: candidate.sourceId })}
            />
          ))}
        </ChromeChoices>
      ) : null}
      <ResponseStatus failure={session.failure} reason={props.reason} />
      <AnswerRow>
        <AnswerPill
          busy={session.pendingId === "browser-sign-in-decline"}
          disabled={!props.canRespond || busy}
          label={declineLabel}
          onPress={() =>
            void responder.respondSignIn({ decision: "decline" }, "browser-sign-in-decline")
          }
          tone="secondary"
        />
        {session.allowed === null ? (
          <AnswerPill
            busy={session.pendingId === "browser-sign-in-allow"}
            disabled={!props.canRespond || busy || selected === undefined}
            label="Allow"
            onPress={() => {
              if (selected !== undefined) allow(selected.sourceId);
            }}
            tone="primary"
          />
        ) : null}
      </AnswerRow>
      <AppText role="caption" tone="muted">
        Opensteer’s browser can’t use passkeys, so a site that asks for one, or ties a sign-in to
        one device, may still ask your agent to sign in.
      </AppText>
    </View>
  );
}

function useWorkspaceName(hostClient: HostClient, workspaceId: string): string {
  return useHostSelector(
    hostClient,
    (snapshot) =>
      snapshot.workspaces.find(({ id }) => id === workspaceId)?.name ?? "this Workspace",
  );
}

/** Often enough that the expiry never lags its deadline by more than a moment. */
const expiryTickMs = 5_000;

function PasswordSignInBody(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly payload: Extract<RequestPayload, { kind: "browser.password-sign-in" }>;
  readonly reason: string | null;
  readonly requestId: string;
  readonly responder: RequestResponder;
  readonly workspaceId: string;
}): ReactNode {
  const { canRespond, hostClient, requestId, responder } = props;
  const { session } = responder;
  const workspaceName = useWorkspaceName(hostClient, props.workspaceId);
  const [now, setNow] = useState(() => new Date());
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [otherAccountsExpanded, setOtherAccountsExpanded] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), expiryTickMs);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!canRespond) return;
    let live = true;
    hostClient.rpc["browser.password-sign-in.get"]({ requestId })
      .then((result) => {
        if (!live) return;
        if (result.ok) updateRequestSession(session, { passwordCard: result.data });
        else updateRequestSession(session, { failure: result.error.message });
      })
      .catch(() => {
        if (live)
          updateRequestSession(session, { failure: "Opensteer Passwords could not be reached." });
      });
    return () => {
      live = false;
    };
  }, [canRespond, hostClient, requestId, session]);
  if (props.payload.credential === "card") {
    return (
      <CardUseBody
        canRespond={canRespond}
        chosenId={chosenId}
        now={now}
        onChoose={setChosenId}
        payload={props.payload}
        reason={props.reason}
        responder={responder}
        workspaceName={workspaceName}
      />
    );
  }
  const card = session.passwordCard;
  const accounts = card?.stage === "approval" ? card.accounts : [];
  const chosen = accounts.length === 1 ? accounts[0] : accounts.find(({ id }) => id === chosenId);
  const groups = passwordSignInAccountList(accounts, query);
  const disabled =
    !canRespond ||
    session.pendingId !== null ||
    Date.parse(props.payload.expiresAt) <= now.getTime();
  const renderGroups = (list: readonly PasswordSignInAccountGroup[]): ReactNode =>
    list.map((group, index) => (
      <View key={group.host ?? index} style={styles.accounts}>
        {group.host === null ? null : (
          <AppText role="caption" tone="muted">
            {group.host}
          </AppText>
        )}
        <View style={styles.group}>
          {group.rows.map(({ account, detail }, row) => (
            <FormChoiceRow
              accessibilityLabel={`Sign in as ${account.username}${group.host ? ` · ${group.host}` : ""}${detail ? ` · ${detail}` : ""}`}
              description={detail ?? undefined}
              disabled={disabled}
              hint="Choose one"
              key={account.id}
              label={account.username}
              mode="one"
              onPress={() => setChosenId(account.id)}
              selected={chosen?.id === account.id}
              separated={row > 0}
            />
          ))}
        </View>
      </View>
    ));
  const approve = (account: PasswordSignInAccount, remember: boolean): void =>
    void responder.respondPassword({ account, remember });
  return (
    <View style={styles.section}>
      <AppText role="secondary" tone="soft">
        {chosen
          ? passwordSignInConsent(workspaceName, props.payload.site, chosen.username, 5)
          : passwordSignInPrivacy(props.payload.site, props.payload.permissionVersion)}
      </AppText>
      <View>
        <AppText role="caption" tone="muted">
          {passwordSignInReasonLabel}
        </AppText>
        <AppText role="secondary" selectable>
          {props.payload.reason}
        </AppText>
      </View>
      {accounts.length > 8 ? (
        <TextInput
          accessibilityLabel="Filter accounts"
          autoCapitalize="none"
          cursorColor={color.ember}
          maxFontSizeMultiplier={controlFontScaleLimit}
          onChangeText={setQuery}
          placeholder="Filter accounts"
          placeholderTextColor={color.muted}
          selectionColor={color.ember}
          style={[type.secondary, styles.input]}
          value={query}
        />
      ) : null}
      {renderGroups(groups.primary)}
      {groups.others.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOtherAccountsExpanded((expanded) => !expanded)}
            style={styles.textAction}
          >
            <AppText role="secondary" tone="soft">
              {passwordSignInOtherAccounts(
                props.payload.site,
                groups.others.reduce((count, group) => count + group.rows.length, 0),
              )}
            </AppText>
          </Pressable>
          {otherAccountsExpanded || query.trim() !== "" ? renderGroups(groups.others) : null}
        </>
      ) : null}
      {card?.stage === "approval" && accounts.length === 0 ? (
        <AppText role="secondary">{passwordSignInNoAccount(props.payload.site)}</AppText>
      ) : null}
      {card?.stage === "gone" ? (
        <AppText role="secondary">This sign-in is no longer running.</AppText>
      ) : null}
      {chosen && card?.stage === "approval" ? (
        <AppText role="caption" tone="muted">
          {passwordSignInAllowRemembers(workspaceName, chosen.username)}
        </AppText>
      ) : null}
      <AppText role="caption" tone="muted">
        {passwordSignInExpiry(props.payload.expiresAt, now)}
      </AppText>
      <ResponseStatus failure={session.failure} reason={props.reason} />
      <AnswerRow>
        <AnswerPill
          accessibilityLabel={declineLabel}
          busy={session.pendingId === "password-sign-in-decline"}
          disabled={disabled}
          label={declineLabel}
          onPress={() => void responder.respondPassword()}
          tone="secondary"
        />
        {chosen && card?.stage === "approval" ? (
          <>
            <AnswerPill
              busy={session.pendingId === "password-once"}
              disabled={disabled}
              label={passwordSignInOnceLabel}
              onPress={() => approve(chosen, false)}
              tone="secondary"
            />
            <AnswerPill
              busy={session.pendingId === "password-allow"}
              disabled={disabled}
              label={passwordSignInAllowLabel}
              onPress={() => approve(chosen, true)}
              tone="primary"
            />
          </>
        ) : null}
      </AnswerRow>
    </View>
  );
}

function CardUseBody(props: {
  readonly canRespond: boolean;
  readonly chosenId: string | null;
  readonly now: Date;
  readonly onChoose: (id: string) => void;
  readonly payload: Extract<RequestPayload, { kind: "browser.password-sign-in" }>;
  readonly reason: string | null;
  readonly responder: RequestResponder;
  readonly workspaceName: string;
}): ReactNode {
  const { responder } = props;
  const { session } = responder;
  const card: PasswordSignInCard | null = session.passwordCard;
  const cards = card?.stage === "card-approval" ? card.cards : [];
  const chosen: CardChoice | undefined =
    cards.length === 1 ? cards[0] : cards.find(({ id }) => id === props.chosenId);
  const locked = !props.canRespond || session.pendingId !== null;
  const expired = Date.parse(props.payload.expiresAt) <= props.now.getTime();
  return (
    <View style={styles.section}>
      <AppText role="secondary" tone="soft">
        {cardUseConsent(props.workspaceName, props.payload.site, props.payload.expiresAt)}
      </AppText>
      <View>
        <AppText role="caption" tone="muted">
          {passwordSignInReasonLabel}
        </AppText>
        <AppText role="secondary">{props.payload.reason}</AppText>
      </View>
      {cards.length > 0 ? (
        <View style={styles.group}>
          {cards.map((choice, index) => (
            <FormChoiceRow
              description={undefined}
              disabled={locked || expired}
              hint="Choose one"
              key={choice.id}
              label={cardChoiceLabel(choice)}
              mode="one"
              onPress={() => props.onChoose(choice.id)}
              selected={chosen?.id === choice.id}
              separated={index > 0}
            />
          ))}
        </View>
      ) : null}
      {card?.stage === "card-approval" && cards.length === 0 ? (
        <AppText role="secondary">{cardUseEmpty(props.payload.computerName ?? "your Mac")}</AppText>
      ) : null}
      {card?.stage === "gone" ? (
        <AppText role="secondary">This card use is no longer running.</AppText>
      ) : null}
      <AppText role="caption" tone="muted">
        {passwordSignInExpiry(props.payload.expiresAt, props.now)}
      </AppText>
      <ResponseStatus failure={session.failure} reason={props.reason} />
      <AnswerRow>
        <AnswerPill
          disabled={locked}
          label={declineLabel}
          onPress={() => void responder.respondPassword()}
          tone="secondary"
        />
        {chosen ? (
          <AnswerPill
            disabled={locked || expired}
            label="Allow card use"
            onPress={() => void responder.respondPassword({ account: chosen, remember: false })}
            tone="primary"
          />
        ) : null}
      </AnswerRow>
    </View>
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
  const locked = !props.canRespond || props.pendingId !== null;
  return (
    <View style={styles.section}>
      <Notice
        detail={`${computerUseAccessLabel[props.access]}. ${approval.detail}`}
        title={approval.approveOn}
        tone="neutral"
      />
      <ResponseStatus failure={props.failure} reason={props.reason} />
      <AnswerRow>
        <AnswerPill
          busy={props.pendingId === "computer-app-decline"}
          disabled={locked}
          label={declineLabel}
          onPress={props.onDecline}
          tone="secondary"
        />
        <AnswerPill
          busy={props.pendingId === "computer-app-allow"}
          disabled={locked}
          label="Allow"
          onPress={props.onAllow}
          tone="primary"
        />
      </AnswerRow>
    </View>
  );
}

/** One named decision. The tap is the answer, so the row says so to a screen reader. */
function ChoiceOptionRow(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly option: RequestOption;
  readonly separated: boolean;
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
        styles.row,
        props.separated && styles.rowSeparated,
        pressed && styles.rowPressed,
        props.disabled && !props.busy && styles.disabled,
      ]}
    >
      <View style={styles.rowText}>
        <AppText role="secondaryMedium" tone={affirmative ? "ember" : "default"}>
          {props.busy ? "Sending…" : option.label}
        </AppText>
        {option.description === undefined ? null : (
          <AppText role="caption" tone="muted">
            {option.description}
          </AppText>
        )}
      </View>
      {props.busy ? <ActivityIndicator color={color.ember} /> : null}
    </Pressable>
  );
}

/**
 * Every question on one page, each a titled group, because an agent asks a few
 * and reading them together is part of answering them. A secret stays masked,
 * off autofill and out of the keyboard's dictionary.
 */
function RequestForm(props: {
  readonly answers: RequestFormDraft;
  readonly disabled: boolean;
  readonly fields: readonly RequestFormField[];
  readonly onAnswersChange: (answers: RequestFormDraft) => void;
}): ReactNode {
  const progress = requestFormProgress(props.fields, props.answers);
  return (
    <View style={styles.form}>
      {props.fields.map((field, index) => {
        const mode = requestFieldMode(field);
        const values = requestDraftValues(props.answers, field.id);
        const setValues = (next: readonly string[]): void =>
          props.onAnswersChange(withRequestDraftValues(props.answers, field.id, next));
        const hint = mode === "one" ? "Choose one" : mode === "many" ? "Choose any" : undefined;
        const name = field.prompt === "" ? (field.label ?? "Your answer") : field.prompt;
        const position =
          props.fields.length > 1 ? `question ${index + 1} of ${props.fields.length}` : null;
        return (
          <View key={field.id} style={styles.field}>
            {/* One header per question, so the rotor moves question to question. */}
            <View accessibilityRole="header" accessible style={styles.fieldHead}>
              <AppText role="secondaryMedium" selectable style={styles.shrink}>
                {name}
              </AppText>
              {hint === undefined ? null : (
                <AppText role="caption" tone="muted">
                  {hint}
                </AppText>
              )}
            </View>
            {mode === "unavailable" ? (
              <AppText role="caption" tone="soft">
                This question cannot accept an answer. Ask the agent to send it again.
              </AppText>
            ) : mode === "text" ? (
              <>
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
                  style={[type.secondary, styles.input, props.disabled && styles.disabled]}
                  value={values[0] ?? ""}
                />
                {field.secret ? (
                  <AppText role="caption" tone="muted">
                    Never saved in this Thread.
                  </AppText>
                ) : null}
              </>
            ) : (
              <View style={styles.group}>
                {(field.choices ?? []).map((choice, choiceIndex) => (
                  <FormChoiceRow
                    description={choice.description}
                    disabled={props.disabled}
                    hint={position === null ? hint : `${hint}, ${position}`}
                    // Values are not required to be unique; their position is.
                    key={`${choiceIndex}:${choice.value}`}
                    label={choice.label}
                    mode={mode}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setValues(toggleRequestChoice(field, values, choice.value));
                    }}
                    selected={values.includes(choice.value)}
                    separated={choiceIndex > 0}
                  />
                ))}
              </View>
            )}
          </View>
        );
      })}
      {progress.unavailable > 0 ? (
        <AppText role="caption" tone="muted">
          {requestFormProgressLabel(progress)}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * A choice that is only marked, never sent. The system's own mark for it: a
 * checkmark at the trailing edge of the chosen row, as Settings draws one.
 */
function FormChoiceRow(props: {
  readonly accessibilityLabel?: string;
  readonly description: string | undefined;
  readonly disabled: boolean;
  readonly hint: string | undefined;
  readonly label: string;
  readonly mode: "one" | "many";
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly separated: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.hint}
      accessibilityLabel={
        props.accessibilityLabel ?? [props.label, props.description].filter(Boolean).join(", ")
      }
      accessibilityRole={props.mode === "many" ? "checkbox" : "radio"}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        props.separated && styles.rowSeparated,
        pressed && styles.rowPressed,
        props.disabled && styles.disabled,
      ]}
    >
      <View style={styles.rowText}>
        <AppText role="secondary">{props.label}</AppText>
        {props.description === undefined || props.description === "" ? null : (
          <AppText role="caption" tone="muted">
            {props.description}
          </AppText>
        )}
      </View>
      {props.selected ? (
        <Symbol name="checkmark" size={15} tint={color.ember} weight="semibold" />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  accounts: { gap: space[6] },
  bar: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    flexDirection: "row",
    gap: space[4],
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[8],
    paddingTop: space[8],
  },
  barSpace: { width: touchTarget },
  barTitle: { alignItems: "center", flex: 1, minWidth: 0, paddingHorizontal: space[4] },
  body: { gap: space[12], paddingHorizontal: space[16], paddingTop: space[4] },
  content: { gap: space[4] },
  disabled: { opacity: 0.45 },
  field: { gap: space[6] },
  fieldHead: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: space[10],
    justifyContent: "space-between",
    marginHorizontal: space[2],
  },
  form: { gap: space[16] },
  gone: { gap: space[8], padding: space[16] },
  group: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  highRisk: { alignItems: "center", flexDirection: "row", gap: space[6] },
  highRiskLabel: { color: color.red },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: radius.lg,
    color: color.text,
    maxHeight: 200,
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
    textAlignVertical: "top",
  },
  // The same field as `input`, with the device a new profile lives on at its end.
  inputWithHome: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingStart: space[14],
  },
  inputBeforeHome: {
    color: color.text,
    flex: 1,
    minHeight: touchTarget,
    paddingVertical: space[10],
  },
  moreGlyph: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  monoDetail: {
    backgroundColor: color.surfaceCode,
    borderRadius: radius.lg,
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
  monoText: { color: color.textSoft, fontFamily: monoFontFamily },
  nameField: { gap: space[8] },
  nameSuggestions: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  pinned: {
    backgroundColor: color.surfaceElevated,
    gap: space[4],
    paddingHorizontal: space[10],
    paddingTop: space[4],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  rowPressed: { backgroundColor: "rgba(255, 255, 255, 0.05)" },
  rowSeparated: { borderTopColor: color.lineStrong, borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  section: { gap: space[10] },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  shrink: { flexShrink: 1 },
  signInStatus: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: radius.lg,
    gap: space[4],
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  signInStatusHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  status: { gap: space[4] },
  textAction: { justifyContent: "center", minHeight: touchTarget },
});
