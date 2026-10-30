import { threadMark, type TaskMark as ResolvedTaskMark } from "@opensteer/client/host";
import { assignmentTitle } from "@opensteer/client/host";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { type Request, type RequestResponse } from "@opensteer/core";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import { ActionNote, ChoiceRows } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import {
  Composer,
  type ComposerRecipient,
  type ComposerRestore,
  type ComposerSubmission,
} from "./composer.js";
import { Icon, type IconName } from "./icon.js";
import { IntegrationInstallReview } from "./integration-install-review.js";
import { AgentProposedChip } from "./integrations/agent-proposed-chip.js";
import { AreaLink } from "./workspace/area-link.js";
import { useComposerContext } from "./workspace/composer-context.js";
import { TaskMark, TaskBadge } from "./workspace/task-mark.js";
import { sendMessageCommand, usePendingSends } from "./pending-sends.js";
import { VoiceButton, VoiceDock } from "./voice.js";
import { ThreadBrowserRequestAction } from "./thread-browser-access-action.js";
import { ThreadBrowserSignInAction } from "./thread-browser-sign-in-action.js";
import { ThreadComputerAppAccessAction } from "./thread-computer-app-access-action.js";
import { ThreadFullDiskAccessAction } from "./thread-full-disk-access-action.js";
import { ThreadPasswordSignInAction } from "./thread-password-sign-in-action.js";
import { ThreadIntegrationAction } from "./thread-integration-action.js";
import {
  browserSiteLabel,
  deriveSurface,
  mutationIdempotencyKey,
  requestsWaitingOn,
  waitingRequestSource,
  type HostSnapshot,
  type NodeEntry,
  type SurfaceModel,
} from "@opensteer/client/host";
import { integrationInstallNextStep } from "@opensteer/client/integrations";

export function InputSurface({
  autoContext = false,
  variant = "work",
  composerHidden = false,
  disabled,
  readOnly = false,
  footerExtras,
  inputRef,
  onEscape,
  onStop,
  placeholder,
  recipient = null,
  requests,
  restoredDraft = null,
  running,
  stopLabel,
  stopping = false,
  threadId,
  voice = false,
}: {
  /** Chat follows the place in front while its draft is untouched; a task's reply never does. */
  autoContext?: boolean;
  variant?: "conversation" | "work";
  /** A form the open request collects its own answers in takes the field's place. */
  composerHidden?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  footerExtras?: ReactNode;
  /** See `Composer`'s `inputRef`. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null> | undefined;
  /** Escape in the field: back to the open request's answers, when one is docked. */
  onEscape?: (() => void) | undefined;
  onStop?: (() => Promise<void>) | undefined;
  placeholder: string;
  /** See `Composer`'s `recipient`. */
  recipient?: ComposerRecipient | null;
  /**
   * The conversation's requests, for a surface that docks them itself. A
   * conversation that lays them out apart from the composer passes none and
   * renders `RequestStack` where it wants them.
   */
  requests?: readonly Request[] | undefined;
  /** A message handed back to the composer; see `Composer`'s `restore`. */
  restoredDraft?: ComposerRestore | null;
  running: boolean;
  /** See `Composer`'s `stopLabel`. */
  stopLabel?: string | undefined;
  /** See `Composer`'s `stopping`. */
  stopping?: boolean;
  threadId: string;
  /** Chat's composer: the voice button beside Send, and the voice bar above it. */
  voice?: boolean;
}) {
  const { hostClient, snapshot, reportActionError } = useShell();
  const context = useComposerContext({ auto: autoContext, hostClient });
  const placeContext = useMemo(() => ({ context, hostClient }), [context, hostClient]);
  const workspaceId = snapshot.threads.find((thread) => thread.id === threadId)?.workspaceId;
  // The signed-in deployment and user the Host confirmed are what every kept
  // message and staged file belongs to; until both are known nothing is sent.
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id ?? null;
  const durable = usePendingSends(
    deploymentId && userId ? { deploymentId, threadId, userId } : null,
  );
  const attachmentTarget =
    workspaceId && deploymentId && userId
      ? { client: hostClient, scope: `${deploymentId}/${userId}/${threadId}`, workspaceId }
      : null;

  const sendMessage = async (
    body: string,
    { attachments, content, places, idempotencyKey, quotedMessageId }: ComposerSubmission,
  ): Promise<void> => {
    if (!body.trim() && attachments.length === 0 && places.length === 0 && !content?.length) return;
    await hostClient.dispatch(
      sendMessageCommand(threadId, {
        attachments,
        body,
        ...(places.length > 0 ? { places } : {}),
        ...(content ? { content } : {}),
        idempotencyKey,
        ...(quotedMessageId ? { quotedMessageId } : {}),
      }),
    );
  };

  const dock = useRequestDock(threadId, requests ?? noRequests);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const docked = requests !== undefined;
  if (
    snapshot.sharedTaskDoneAvailable &&
    snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null
  ) {
    return (
      <div className="input-surface">
        <p>
          This task is Done ·{" "}
          <button
            className="btn btn--ghost"
            type="button"
            disabled={disabled}
            onClick={() => void hostClient.setTaskDone(threadId, false).catch(reportActionError)}
          >
            <strong>Reopen</strong>
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className="input-surface" ref={rootRef}>
      {docked ? (
        <RequestStack
          disabled={disabled || readOnly}
          items={dock.items}
          onOpen={dock.setOpenId}
          openId={dock.openId}
          threadId={threadId}
        />
      ) : null}
      {voice ? <VoiceDock /> : null}
      <div hidden={composerHidden || (docked && dock.composerHidden)}>
        <Composer
          dictationScope={`${deploymentId}/${userId}/${threadId}`}
          hidden={composerHidden || (docked && dock.composerHidden)}
          variant={variant}
          placeContext={placeContext}
          attachments={attachmentTarget}
          disabled={disabled}
          readOnly={readOnly}
          footerExtras={footerExtras}
          inputRef={inputRef}
          onEscape={
            onEscape ??
            (docked && dock.items.length > 0 ? () => focusOpenRequest(rootRef.current) : undefined)
          }
          // A docked Request is answered with its own controls; what is typed
          // beside it is always an ordinary message.
          onSend={sendMessage}
          onStop={onStop}
          pendingSends={"sends" in durable ? durable.sends : null}
          placeholder={placeholder}
          recipient={recipient}
          restore={restoredDraft}
          running={running}
          stopping={stopping}
          {...(stopLabel === undefined ? {} : { stopLabel })}
          sendBlocked={"unavailable" in durable ? durable.unavailable : null}
          voice={voice ? <VoiceButton /> : undefined}
        />
      </div>
    </div>
  );
}

/* ---- The requests docked above the composer ---- */

/** One request in the dock: this conversation's own, or one asked by work it waits on. */
export interface DockedRequest {
  readonly surface: SurfaceModel;
  /** The task that asked, for a question arriving from work this conversation handed out. */
  readonly source: {
    readonly threadId: string;
    readonly title: string;
    readonly mark: ResolvedTaskMark;
  } | null;
}

/**
 * Every request waiting on the reader here, in the order they are answered:
 * the conversation's own (a live one first), then each question from work it
 * handed out. Each is decided on its own, so a denied or form request reads
 * the same whether it is first or not.
 */
export function useDockedRequests(
  threadId: string,
  requests: readonly Request[],
): readonly DockedRequest[] {
  const { snapshot } = useShell();
  const { user, waitingRequests } = snapshot;
  return useMemo(() => {
    const own = requests
      .filter((request) => request.status === "pending")
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
    const first = own.find((request) => request.mode === "live") ?? own[0];
    const ordered = first ? [first, ...own.filter((request) => request !== first)] : [];
    const docked: DockedRequest[] = [];
    for (const request of ordered) {
      const surface = deriveSurface([request], user);
      if (surface) docked.push({ source: null, surface });
    }
    for (const entry of requestsWaitingOn(waitingRequests, threadId)) {
      if (entry.request.originatingThreadId === threadId) continue;
      const surface = deriveSurface([entry.request], user);
      if (!surface) continue;
      const task = waitingRequestSource(entry, threadId);
      docked.push({
        source: task
          ? {
              threadId: task.workerThread.id,
              title: assignmentTitle(task, snapshot),
              mark: threadMark(task.workerThread.id, snapshot),
            }
          : null,
        surface,
      });
    }
    return docked;
  }, [requests, threadId, user, waitingRequests, snapshot.threads]);
}

const noRequests: readonly Request[] = [];

/** Which docked request is open: the reader's choice while it stands, else the first. */
export function useRequestDock(threadId: string, requests: readonly Request[]) {
  const items = useDockedRequests(threadId, requests);
  const [chosen, setOpenId] = useState<string | null>(null);
  const open = items.find((item) => item.surface.request.id === chosen) ?? items[0] ?? null;
  return {
    // A form collecting its own answers takes the field's place while it is open.
    composerHidden: open?.source === null && open.surface.textRole === "hidden",
    items,
    openId: open?.surface.request.id ?? null,
    setOpenId,
  };
}

/** Escape from the field lands on the open request's first answer. */
export function focusOpenRequest(scope: ParentNode | null) {
  scope
    ?.querySelector<HTMLElement>(
      ".request-card .action-rows button:not(:disabled), .request-card button:not(:disabled)",
    )
    ?.focus();
}

/**
 * The requests above the composer. The one in focus is shown whole — its
 * title, detail, every answer and where it is approved — never inside a
 * scroller of its own; each other one is a single row naming it, which opens
 * it in turn. One is open at a time.
 */
export function RequestStack({
  disabled,
  items,
  onOpen,
  openId,
  threadId,
}: {
  readonly disabled: boolean;
  readonly items: readonly DockedRequest[];
  readonly onOpen: (requestId: string) => void;
  /** The request the reader opened, or was sent to; the first one otherwise. */
  readonly openId: string | null;
  readonly threadId: string;
}) {
  if (items.length === 0) return null;
  const open = items.find((item) => item.surface.request.id === openId) ?? items[0];
  return (
    <div className="request-stack">
      {items.map((item) =>
        item === open ? (
          <div
            className={`${inputSurfaceClass(item.surface)} request-card`}
            key={item.surface.request.id}
          >
            {item.source ? (
              <AreaLink
                className="request-card__source"
                to={`/threads/${encodeURIComponent(item.source.threadId)}`}
              >
                <span className="task-request-mark">
                  <TaskMark size={16} mark={item.source.mark} />
                  <TaskBadge state="needs-you" />
                </span>
                <span className="request-card__source-name">{item.source.title}</span>
                <Icon name="chevron-right" />
              </AreaLink>
            ) : null}
            <RequestPanel
              disabled={disabled}
              surface={item.surface}
              threadId={item.source ? item.surface.request.originatingThreadId : threadId}
            />
          </div>
        ) : (
          <RequestRow item={item} key={item.surface.request.id} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}

/** A request waiting its turn: who or what asks, its title, and how many answers it hides. */
function RequestRow({
  item,
  onOpen,
}: {
  readonly item: DockedRequest;
  readonly onOpen: (requestId: string) => void;
}) {
  const { request } = item.surface;
  const title = requestTitle(request);
  const choices = request.presentation.kind === "choice" ? request.presentation.options.length : 0;
  const count = choices > 0 ? `${choices} ${choices === 1 ? "choice" : "choices"}` : null;
  return (
    <button
      aria-expanded={false}
      aria-label={[item.source?.title, title, count].filter(Boolean).join(", ")}
      className={`request-row${request.presentation.kind === "choice" && request.presentation.risk === "high" ? " request-row--high" : ""}`}
      data-request-id={request.id}
      onClick={() => onOpen(request.id)}
      title={item.source ? `${item.source.title}: ${title}` : title}
      type="button"
    >
      <span aria-hidden className="request-row__mark">
        {item.source ? (
          <span className="task-request-mark">
            <TaskMark size={16} mark={item.source.mark} />
            <TaskBadge state="needs-you" />
          </span>
        ) : (
          <Icon name={requestIcon(request)} />
        )}
      </span>
      <span className="request-row__title">{title}</span>
      {count ? <span className="request-row__count">{count}</span> : null}
      <Icon className="request-row__chevron" name="chevron-down" />
    </button>
  );
}

function inputSurfaceClass(surface: SurfaceModel | null): string {
  const risk =
    surface?.request.presentation.kind === "choice" ? surface.request.presentation.risk : undefined;
  return [
    "input-surface",
    surface ? "input-surface--action" : "",
    risk === "medium" ? "input-surface--medium" : "",
    risk === "high" ? "input-surface--high" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A request's name as the reader answers it; a sign-in names its site, whatever the wording. */
function requestTitle(request: Request): string {
  return request.payload.kind === "browser.sign-in" ||
    request.payload.kind === "browser.password-sign-in"
    ? `Sign in to ${browserSiteLabel(request.payload.site)}`
    : request.presentation.title;
}

/* ---- The focused Request ---- */

function RequestPanel({
  disabled,
  surface,
  threadId,
}: {
  disabled: boolean;
  surface: SurfaceModel;
  threadId: string;
}) {
  const { snapshot } = useShell();
  const { request } = surface;
  const subagent = askingSubagent(snapshot, request);
  // An agent's app request reads as the title and the model's own reason; the
  // card below says where it is answered.
  // A sign-in card names the site itself, whatever wording the Request carries.
  // A saved-password card labels the reason as the agent's inside the card.
  const detail =
    request.payload.kind === "browser.password-sign-in"
      ? undefined
      : request.payload.kind === "computer.app.access" || request.payload.kind === "browser.sign-in"
        ? request.payload.reason
        : request.presentation.detail;
  const title = requestTitle(request);
  return (
    <fieldset
      aria-label="Opensteer needs your input"
      className="action-panel"
      data-request-id={request.id}
      disabled={disabled}
      tabIndex={-1}
    >
      <div className="action-panel__head">
        <span aria-hidden className="action-panel__icon">
          <Icon name={requestIcon(request)} />
        </span>
        <span className="action-panel__title">{title}</span>
        {request.presentation.agentProposed ? <AgentProposedChip /> : null}
      </div>
      {subagent ? <p className="action-panel__asker">Asked by subagent {subagent}</p> : null}
      <div className="action-panel__content">
        {detail ? (
          <ActionDetail mono={request.kind === "harness.approval"}>{detail}</ActionDetail>
        ) : null}
        <ActionBody disabled={disabled} surface={surface} threadId={threadId} />
      </div>
    </fieldset>
  );
}

/**
 * The subagent that asked a Request, by its title: as the Host named it for
 * the reader to answer, or else as the asking Thread's transcript has it.
 */
function askingSubagent(
  snapshot: Pick<HostSnapshot, "transcripts" | "waitingRequests">,
  request: Request,
): string | null {
  const nodeId = request.originatingNodeId;
  if (nodeId === undefined) return null;
  const waiting = snapshot.waitingRequests.find((entry) => entry.request.id === request.id);
  if (waiting?.subagent) return waiting.subagent.title;
  const node = snapshot.transcripts[request.originatingThreadId]?.find(
    (entry): entry is NodeEntry => entry.kind === "node" && entry.nodeId === nodeId,
  );
  return node?.title ?? null;
}

function ActionBody({
  disabled,
  surface,
  threadId,
}: {
  disabled: boolean;
  surface: SurfaceModel;
  threadId: string;
}) {
  const { hostClient, reportActionError } = useShell();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { request } = surface;

  if (surface.denied) {
    return <DeniedRequestBody denied={surface.denied} request={request} />;
  }
  if (request.kind === "browser.access" || request.kind === "browser.profile.save") {
    return <ThreadBrowserRequestAction disabled={disabled} request={request} />;
  }
  if (request.kind === "browser.sign-in") {
    return <ThreadBrowserSignInAction disabled={disabled} request={request} />;
  }
  if (request.kind === "browser.password-sign-in") {
    return <ThreadPasswordSignInAction disabled={disabled} request={request} />;
  }
  if (request.kind === "integration.access") {
    return <ThreadIntegrationAction disabled={disabled} request={request} threadId={threadId} />;
  }
  if (request.kind === "machine.full-disk-access") {
    return <ThreadFullDiskAccessAction disabled={disabled} request={request} />;
  }
  if (request.kind === "computer.app.access") {
    return <ThreadComputerAppAccessAction disabled={disabled} request={request} />;
  }

  const respond = (response: RequestResponse, busyId: string) => {
    if (pendingId || disabled) return;
    setPendingId(busyId);
    void hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
        requestId: request.id,
        response,
        type: "request.respond",
      })
      .catch(reportActionError)
      .finally(() => setPendingId(null));
  };

  if (request.presentation.kind === "choice") {
    return (
      <>
        {request.payload.kind === "integration.install" ? (
          <>
            <IntegrationInstallReview manifest={request.payload.manifest} />
            <ActionNote>
              {integrationInstallNextStep({
                canInstall: true,
                continuesToAccess: false,
                installedTitle: null,
              })}
            </ActionNote>
          </>
        ) : null}
        <ChoiceRows
          autoFocus
          onSelect={(option) => respond({ kind: "choice", optionId: option.id }, option.id)}
          options={request.presentation.options}
          pendingId={pendingId}
        />
      </>
    );
  }
  return (
    <ActionForm
      request={request}
      onRespond={(response) => respond(response, "form")}
      pending={disabled || pendingId !== null}
    />
  );
}

/**
 * Only the decision is withheld from a viewer who cannot make it. What the agent
 * asked to install is still what that viewer would relay to whoever can approve
 * it, so the review stays above the note and only the action rows go.
 */
export function DeniedRequestBody({
  denied,
  request,
}: {
  denied: NonNullable<SurfaceModel["denied"]>;
  request: Request;
}) {
  return (
    <>
      {request.payload.kind === "integration.install" ||
      (request.payload.kind === "integration.access" && request.payload.manifest !== null) ? (
        <IntegrationInstallReview manifest={request.payload.manifest} />
      ) : null}
      <ActionNote>
        {denied === "administrator"
          ? "A Host administrator must complete this request."
          : "The person who started this task must answer this request."}
      </ActionNote>
    </>
  );
}

function requestIcon(request: Request): IconName {
  if (request.kind === "harness.input") return "help-circle";
  // A phone's access Request asks for the phone itself, so it reads as one.
  if (
    request.payload.kind === "computer.app.access" &&
    request.payload.definitionId === androidPhoneDefinitionId
  )
    return "phone";
  // Both name one enrolled computer, so both read as one.
  if (request.kind === "machine.full-disk-access" || request.kind === "computer.app.access")
    return "laptop";
  if (request.kind === "browser.sign-in" || request.kind === "browser.password-sign-in") {
    return "key";
  }
  if (request.kind.startsWith("browser.")) return "browser";
  if (request.kind.startsWith("integration.")) {
    return "puzzle";
  }
  return "shield";
}

/* ---- Detail: the substance of the decision, clamped until asked ---- */

function ActionDetail({ children, mono }: { children: string; mono: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = children.length > 320 || children.split("\n").length > 4;
  const className = [
    "action-detail",
    mono ? "action-detail--mono" : "",
    clampable && !expanded ? "action-detail--clamped" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="action-detail__frame">
      <div className={className}>{children}</div>
      {clampable ? (
        <button
          className="action-detail__more"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

/* ---- Forms: the request's own fields are the input ---- */

export function ActionForm({
  request,
  onRespond,
  pending,
}: {
  request: Request;
  onRespond: (response: RequestResponse) => void;
  pending: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  if (request.presentation.kind !== "form") return null;

  const setAnswer = (fieldId: string, values: string[]) => {
    setAnswers((current) => ({ ...current, [fieldId]: values }));
  };

  const complete = request.presentation.fields.every(
    (field) => (answers[field.id]?.length ?? 0) > 0,
  );

  const submit = () => {
    if (!complete || pending) return;
    onRespond({ answers, kind: "form" });
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <>
      {request.presentation.fields.map((field, fieldIndex) => (
        <div className="action-form__field" key={field.id}>
          {field.prompt ? (
            <p className="action-form__prompt" id={`question-${field.id}-prompt`}>
              {field.prompt}
            </p>
          ) : null}
          {field.choices && field.choices.length > 0 ? (
            <div
              aria-labelledby={field.prompt ? `question-${field.id}-prompt` : undefined}
              className="action-rows"
              role="group"
            >
              {field.choices.map((choice) => (
                <label
                  className={
                    answers[field.id]?.includes(choice.value)
                      ? "action-row action-row--selected"
                      : "action-row"
                  }
                  key={choice.value}
                >
                  <input
                    checked={answers[field.id]?.includes(choice.value) ?? false}
                    name={`question-${field.id}`}
                    onChange={(event) => {
                      if (field.multiSelect) {
                        const current = answers[field.id] ?? [];
                        setAnswer(
                          field.id,
                          event.target.checked
                            ? [...current, choice.value]
                            : current.filter((value) => value !== choice.value),
                        );
                      } else {
                        setAnswer(field.id, [choice.value]);
                      }
                    }}
                    type={field.multiSelect ? "checkbox" : "radio"}
                  />
                  <span className="action-row__text">
                    <span className="action-row__label">{choice.label}</span>
                    {choice.description ? (
                      <span className="action-row__desc">{choice.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            /* The prompt is the label. Without a prompt the field still needs
               a name, and "Your answer" is the honest one. */
            <input
              aria-label={field.prompt ? undefined : "Your answer"}
              aria-labelledby={field.prompt ? `question-${field.id}-prompt` : undefined}
              autoFocus={fieldIndex === 0}
              className="text-input"
              onChange={(event) =>
                setAnswer(field.id, event.target.value ? [event.target.value] : [])
              }
              onKeyDown={submitOnEnter}
              placeholder="Type your answer…"
              type={field.secret ? "password" : "text"}
              value={answers[field.id]?.[0] ?? ""}
            />
          )}
        </div>
      ))}
      <div className="action-buttons">
        <button
          className="btn btn--primary"
          disabled={!complete || pending}
          onClick={submit}
          type="button"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </>
  );
}
