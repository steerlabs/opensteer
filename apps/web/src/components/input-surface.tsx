import { requestDecision } from "@opensteer/client/host";
import { clientScopeKey } from "@opensteer/client/connections";
import { assertMessageLogin, enqueueDraftReply, hostMessageOutbox } from "@opensteer/client/host";
import { presentClientIssue } from "@opensteer/client/feedback";
import { browserNoticeDismissals } from "./usage-notice.js";
import { isPluginRequest } from "@opensteer/client/plugins";
import { ThreadPluginAction } from "./plugins/plugin-request-action.js";
import { useCompactionOffer, useRequestAsker, useRequestPageTab } from "@opensteer/client/react";
import { workWords } from "@opensteer/client/host";
import { cardUseTitle } from "@opensteer/client/host";
import { threadMark, type TaskMark as ResolvedTaskMark } from "@opensteer/client/host";
import { assignmentTitle } from "@opensteer/client/host";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RequestDetail } from "./request-detail.js";
import { useScrollEdges } from "./workspace/scroll-edges.js";
import { type Request, type RequestResponse } from "@opensteer/core";
import { EngineDotMark } from "./subagent-rows.js";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { ActionNote, ChoiceRows } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { personalReferenceCandidates } from "./composer-reference-picker.js";
import {
  Composer,
  type ComposerRecipient,
  type ComposerRestore,
  type ComposerSubmission,
} from "./composer.js";
import { Icon, type IconName } from "./icon.js";
import { AreaLink } from "./workspace/area-link.js";
import { DeviceGrantDock } from "./workspace/device-grant-follow-ups.js";
import { useComposerContext } from "./workspace/composer-context.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";
import { TaskMark, TaskBadge } from "./workspace/task-mark.js";
import { sendMessageCommand, storageUnavailable } from "../host/message-outbox.js";
import { ActionLine } from "./action-line.js";
import { OperationRequestPanel, useOperationRequest } from "./agent-work.js";
import { requestAnswer, useAction } from "./use-action.js";
import { VoiceButton, VoiceDock } from "./voice.js";
import { ThreadBrowserRequestAction } from "./thread-browser-access-action.js";
import { ThreadBrowserSignInAction } from "./thread-browser-sign-in-action.js";
import { ThreadComputerAppAccessAction } from "./thread-computer-app-access-action.js";
import { ThreadFullDiskAccessAction } from "./thread-full-disk-access-action.js";
import {
  ThreadDeviceAccessAction,
  deviceAccessRequestTitle,
  useDeviceGrantFollowUps,
} from "./thread-device-access-action.js";
import { ThreadPasswordSignInAction } from "./thread-password-sign-in-action.js";
import { ThreadIntegrationAction } from "./thread-integration-action.js";
import {
  browserSiteLabel,
  deriveSurface,
  isQuestionRequest,
  mutationIdempotencyKey,
  requestsWaitingOn,
  waitingRequestSource,
  waitingRequestPresentationSource,
  type SurfaceModel,
} from "@opensteer/client/host";
import { AnswerField, QuestionBody, untitledQuestion } from "./question-answer.js";
import { useAnswersInComposer, useQuestionSessionKey } from "./question-session.js";

export function InputSurface({
  autoContext = false,
  variant = "work",
  composerHidden = false,
  voiceHidden = false,
  disabled,
  readOnly = false,
  footerExtras,
  inputRef,
  onEscape,
  onStop,
  placeholder,
  question = null,
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
  /** A call's pill can't dock here: this surface is off screen. */
  voiceHidden?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  footerExtras?: ReactNode;
  /** See `Composer`'s `inputRef`. */
  inputRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Escape in the field: back to the open request's answers, when one is docked. */
  onEscape?: (() => void) | undefined;
  onStop?: (() => Promise<void>) | undefined;
  placeholder: string;
  /**
   * The question docked above, for a surface whose requests are laid out apart
   * from it; the composer becomes its answer. A surface docking its own
   * requests finds its question itself.
   */
  question?: DockedRequest | null;
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
  /** Chat's composer, which offers the voice button beside Send. */
  voice?: boolean;
}) {
  const { hostClient, snapshot } = useShell();
  const { deploymentId } = snapshot;
  const reopen = useAction(
    hostClient,
    {
      label: "reopen this task",
      done: "reopened",
      happened: "this task reopened",
      execute: () => hostClient.setTaskDone(threadId, false),
    },
    `reopen:${threadId}`,
  );
  const userId = snapshot.user?.id ?? null;
  const draftKey = composerDraftKeyFor(deploymentId, userId, { kind: "thread", threadId });
  const context = useComposerContext({ auto: autoContext, draftKey, hostClient });
  const placeContext = useMemo(() => ({ context, hostClient }), [context, hostClient]);
  // The signed-in deployment and user the Host confirmed are what every kept
  // message and staged file belongs to; until both are known nothing is sent.
  const outbox = hostMessageOutbox(hostClient);
  const attachmentTarget =
    deploymentId && draftKey ? { client: hostClient, scope: draftKey, deploymentId } : null;

  const compactionOffer = useCompactionOffer(
    snapshot.threads.find((t) => t.id === threadId)?.returnHint,
    `${deploymentId}/${userId}/${threadId}`,
    browserNoticeDismissals("opensteer.usage-notices.dismissed"),
  );
  const sendMessage = async (
    body: string,
    {
      attachments,
      places,
      idempotencyKey,
      quotedMessageId,
      compaction,
      draftRevision,
      scope,
    }: ComposerSubmission,
  ) => {
    if (!body.trim() && attachments.length === 0 && places.length === 0) return;
    if (!outbox) throw storageUnavailable();
    if (!scope || !draftKey || !draftRevision) throw storageUnavailable();
    const login = clientScopeKey(scope)!;
    const assertCurrent = () => {
      assertMessageLogin(scope, hostClient.connection.getSnapshot().scope);
      composerDrafts.bindReply(draftKey, login, draftRevision);
    };
    const id = await enqueueDraftReply(
      outbox,
      scope,
      sendMessageCommand(threadId, {
        attachments,
        ...(compaction ? { compaction } : {}),
        body,
        ...(places.length > 0 ? { places } : {}),
        idempotencyKey,
        ...(quotedMessageId ? { quotedMessageId } : {}),
      }),
      { revision: draftRevision, assertCurrent, draftKey },
    );
    const cleared = await composerDrafts.consumeReply(draftKey, draftRevision, () => {
      assertMessageLogin(scope, hostClient.connection.getSnapshot().scope);
    });
    if (cleared) void outbox.forgetHandoff(scope, id).catch(() => {});
    return { replyCleared: cleared };
  };

  const dock = useRequestDock(threadId, requests ?? noRequests);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const docked = requests !== undefined;
  const asked = docked ? dock.question : question;
  const questionKey = useQuestionSessionKey(asked?.surface.request ?? null);
  const answering = useAnswersInComposer(threadId, questionKey);
  const messageHidden = composerHidden || (docked && dock.composerHidden) || answering;
  const done = snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null;
  // A Host that reopens a Done task for its writer keeps the composer; an older one asks first.
  if (done && !snapshot.quietTasksAvailable) {
    return (
      <div className="input-surface">
        <p>
          This task is Done ·{" "}
          <button
            className="btn btn--ghost"
            type="button"
            disabled={reopen.running}
            onClick={() => void reopen.run()}
          >
            <strong>Reopen</strong>
          </button>
        </p>
        {reopen.line ? <ActionLine line={reopen.line} /> : null}
      </div>
    );
  }
  return (
    <div className="input-surface" ref={rootRef}>
      {done ? <p className="input-surface__done">Done · Sending reopens it</p> : null}
      {docked ? (
        <RequestStack
          composer
          disabled={disabled || readOnly}
          items={dock.items}
          onOpen={dock.setOpenId}
          openId={dock.openId}
          threadId={threadId}
        />
      ) : null}
      {composerHidden || (docked && dock.composerHidden) ? null : (
        <VoiceDock hidden={voiceHidden} />
      )}
      {answering && asked ? (
        <AnswerField
          composer
          disabled={disabled || readOnly}
          key={asked.surface.request.id}
          onEscape={
            onEscape ??
            (docked && dock.items.length > 0 ? () => focusOpenRequest(rootRef.current) : undefined)
          }
          onStop={onStop}
          request={asked.surface.request}
          running={running}
          {...(stopLabel === undefined ? {} : { stopLabel })}
          stopping={stopping}
        />
      ) : null}
      <div hidden={messageHidden}>
        <Composer
          compactionOffer={compactionOffer}
          connection={hostClient.connection}
          dictationScope={`${deploymentId}/${userId}/${threadId}`}
          draftKey={draftKey}
          hidden={messageHidden}
          variant={variant}
          placeContext={placeContext}
          attachments={attachmentTarget}
          disabled={false}
          readOnly={readOnly}
          footerExtras={footerExtras}
          inputRef={inputRef}
          onEscape={
            onEscape ??
            (docked && dock.items.length > 0 ? () => focusOpenRequest(rootRef.current) : undefined)
          }
          // Beside anything but a question, what is typed is an ordinary message.
          onSend={sendMessage}
          onStop={onStop}
          placeholder={placeholder}
          recipient={recipient}
          references={(query) => personalReferenceCandidates(hostClient, query)}
          restore={restoredDraft}
          running={running}
          stopping={stopping}
          {...(stopLabel === undefined ? {} : { stopLabel })}
          sendBlocked={outbox ? null : presentClientIssue({ code: "storage-unavailable" }).title}
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
  held: boolean,
): readonly DockedRequest[] {
  const { snapshot } = useShell();
  const { user, waitingRequests } = snapshot;
  return useMemo(() => {
    if (held) return [];
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
      const worker = waitingRequestPresentationSource(entry, threadId);
      docked.push({
        source: worker
          ? { threadId: worker.id, title: worker.title, mark: threadMark(worker.id, snapshot) }
          : task
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
  }, [held, requests, threadId, user, waitingRequests, snapshot.threads]);
}

const noRequests: readonly Request[] = [];

/** Which docked request is open: the reader's choice while it stands, else the first. */
export function useRequestDock(threadId: string, requests: readonly Request[], held = false) {
  const items = useDockedRequests(threadId, requests, held);
  const [chosen, setOpenId] = useState<string | null>(null);
  const open = items.find((item) => item.surface.request.id === chosen) ?? items[0] ?? null;
  return {
    // A form collecting its own answers takes the field's place while it is open.
    composerHidden: open?.source === null && open.surface.textRole === "hidden",
    /** The open request when it's a question the composer answers. */
    question: open?.surface.textRole === "answer" ? open : null,
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
  asker = true,
  composer = false,
  disabled,
  folded = false,
  items,
  onOpen,
  onUnfold,
  openId,
  subagentNodeId,
  threadId,
}: {
  /** Names the subagent that asked; its own view already is that subagent. */
  readonly asker?: boolean;
  /** A composer below takes a question's typed answer; without one its card brings a field. */
  readonly composer?: boolean;
  readonly disabled: boolean;
  /** Something else above the composer is open, so the request shows only its title line. */
  readonly folded?: boolean;
  readonly items: readonly DockedRequest[];
  readonly onOpen: (requestId: string) => void;
  /** The folded title line was pressed: open the request whole again. */
  readonly onUnfold?: () => void;
  /** The request the reader opened, or was sent to; the first one otherwise. */
  readonly openId: string | null;
  /** This is that subagent's own view: only the follow-ups it asked for. */
  readonly subagentNodeId?: string;
  readonly threadId: string;
}) {
  const followUps = useDeviceGrantFollowUps({
    liveRequestIds: items.map((item) => item.surface.request.id),
    nodeId: subagentNodeId,
    threadId,
  });
  const index = Math.max(
    0,
    items.findIndex((item) => item.surface.request.id === openId),
  );
  const open = items[index];
  if (!open) return followUps ? <div className="request-stack">{followUps}</div> : null;
  if (folded)
    return (
      <div className="request-stack">
        <RequestRow item={open} onOpen={() => onUnfold?.()} />
      </div>
    );
  const pager =
    items.length > 1 ? (
      <RequestPager
        index={index}
        onOpen={(next) => {
          const target = items[next];
          if (target) onOpen(target.surface.request.id);
        }}
        total={items.length}
      />
    ) : null;
  return (
    <div className="request-stack">
      {followUps}
      <div
        className={`${inputSurfaceClass(open.surface)} request-card`}
        key={open.surface.request.id}
      >
        {open.source ? (
          <div className="request-card__by">
            <AreaLink
              className="request-card__source"
              to={`/tasks/${encodeURIComponent(open.source.threadId)}`}
            >
              <span className="task-request-mark">
                <TaskMark size={16} mark={open.source.mark} />
                <TaskBadge state="needs-you" />
              </span>
              <span className="request-card__source-name">{open.source.title}</span>
              <Icon name="chevron-right" />
            </AreaLink>
            {pager}
          </div>
        ) : asker ? (
          <AskerByline pager={pager} request={open.surface.request} />
        ) : pager ? (
          <div className="request-card__by">{pager}</div>
        ) : null}
        <RequestPageLink request={open.surface.request} />
        <DeviceGrantDock value={threadId}>
          <DockedRequestPanel
            composer={composer}
            disabled={disabled}
            surface={open.surface}
            threadId={open.source ? open.surface.request.originatingThreadId : threadId}
            viewThreadId={threadId}
          />
        </DeviceGrantDock>
      </div>
    </div>
  );
}

/** A question or a sign-in, which is answered in a page: its page is one click away. */
function aboutAPage(request: Request): boolean {
  return (
    isQuestionRequest(request) ||
    request.payload.kind === "browser.sign-in" ||
    request.payload.kind === "browser.password-sign-in"
  );
}

/**
 * "Open the page": the Request's own tab, or its task's only page, for a Request answered
 * in a page, such as signing in to a site. Nothing when that is not one page, or while that
 * page is already shown.
 */
function RequestPageLink({ request }: { readonly request: Request }) {
  const { hostClient } = useShell();
  const workspace = useOptionalWorkspace();
  const page = useRequestPageTab(hostClient, aboutAPage(request) ? request : null);
  const shown =
    workspace?.selection.kind === "place" &&
    workspace.selection.destination.kind === "tab" &&
    workspace.selection.destination.tabId === page?.tabId;
  if (!workspace || !page || shown) return null;
  return (
    <button
      className="btn btn--small request-card__page"
      onClick={() => workspace.nav.showPlace({ kind: "tab", tabId: page.tabId })}
      type="button"
    >
      <Icon name="globe" />
      {workWords("ask.openPage")}
    </button>
  );
}

/** "1 of 2", with the way to each: one request is shown whole at a time. */
function RequestPager({
  index,
  onOpen,
  total,
}: {
  readonly index: number;
  readonly onOpen: (index: number) => void;
  readonly total: number;
}) {
  return (
    <span className="request-card__pager">
      <button
        aria-label="Previous request"
        className="icon-btn icon-btn--small"
        disabled={index === 0}
        onClick={() => onOpen(index - 1)}
        type="button"
      >
        <Icon name="chevron-left" />
      </button>
      <span aria-live="polite">
        {index + 1} of {total}
      </span>
      <button
        aria-label="Next request"
        className="icon-btn icon-btn--small"
        disabled={index === total - 1}
        onClick={() => onOpen(index + 1)}
        type="button"
      >
        <Icon name="chevron-right" />
      </button>
    </span>
  );
}

/**
 * Who asked, for a question a subagent asked: its mark and name, and the
 * subagent it runs inside when it is nested. It opens the asker.
 */
function AskerByline({ pager, request }: { pager: ReactNode; request: Request }) {
  const { hostClient } = useShell();
  const workspace = useOptionalWorkspace();
  const asker = useRequestAsker(hostClient, request);
  if (!asker) return pager ? <div className="request-card__by">{pager}</div> : null;
  return (
    <div className="request-card__by">
      <button
        aria-label={`Asked by subagent ${asker.title}. Open it`}
        className="request-card__asker"
        onClick={() =>
          workspace?.nav.openConversation(workspace.nav.threadPath(asker.threadId), {
            subagent: asker.nodeId,
          })
        }
        type="button"
      >
        <EngineDotMark dot="needs" />
        <strong>{asker.title}</strong>
        <span className="request-card__within">· {asker.byline}</span>
      </button>
      {pager}
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
  if (request.payload.kind === "browser.password-sign-in" && request.payload.credential === "card")
    return cardUseTitle(request.payload.site);
  if (request.payload.kind === "device.access") return deviceAccessRequestTitle(request.payload);
  // An engine's lone question is its own heading; the stock title adds nothing.
  if (
    request.presentation.kind === "form" &&
    request.presentation.title === untitledQuestion &&
    request.presentation.fields.length === 1 &&
    request.presentation.fields[0]!.prompt.trim() !== ""
  )
    return request.presentation.fields[0]!.prompt.trim();
  return request.payload.kind === "browser.sign-in" ||
    request.payload.kind === "browser.password-sign-in"
    ? `Sign in to ${browserSiteLabel(request.payload.site)}`
    : request.presentation.title;
}

/* ---- The focused Request ---- */

/** A connected agent's direct operation gets its own card; every other request, the panel. */
function DockedRequestPanel(props: Parameters<typeof RequestPanel>[0]) {
  const operation = useOperationRequest(props.surface.request);
  return operation ? (
    <OperationRequestPanel
      disabled={props.disabled}
      request={props.surface.request}
      view={operation}
    />
  ) : (
    <RequestPanel {...props} />
  );
}

function RequestPanel({
  composer,
  disabled,
  surface,
  threadId,
  viewThreadId,
}: {
  composer: boolean;
  disabled: boolean;
  surface: SurfaceModel;
  threadId: string;
  /** The task on screen, whose composer sits below. */
  viewThreadId: string;
}) {
  const { hostClient } = useShell();
  const { request } = surface;
  const asker = useRequestAsker(hostClient, request);
  // An agent's app request reads as the title and the model's own reason; the
  // card below says where it is answered.
  // A sign-in card names the site itself, whatever wording the Request carries.
  // A saved-password card labels the reason as the agent's inside the card.
  const detail =
    request.payload.kind === "browser.password-sign-in"
      ? undefined
      : request.payload.kind === "computer.app.access" ||
          request.payload.kind === "browser.sign-in" ||
          request.payload.kind === "device.access"
        ? request.payload.reason
        : request.presentation.detail;
  const title = requestTitle(request);
  // An access card names the app and the reason itself, so the panel's own
  // head would only say them twice.
  const ownHead = request.kind === "integration.access" && !surface.denied;
  const contentRef = useRef<HTMLDivElement | null>(null);
  useScrollEdges(contentRef);
  return (
    <fieldset
      aria-label={asker ? `${asker.title} asks: ${title}` : "Opensteer needs your input"}
      className="action-panel"
      data-request-id={request.id}
      disabled={disabled}
      tabIndex={-1}
    >
      {ownHead ? null : (
        <div className="action-panel__head">
          <span aria-hidden className="action-panel__icon">
            <Icon name={requestIcon(request)} />
          </span>
          <span className="action-panel__title">{title}</span>
        </div>
      )}
      <div className="action-panel__content" data-scroll-edges="" ref={contentRef}>
        {detail && !ownHead ? (
          <RequestPanelDetail
            key={request.id}
            markdown={
              request.kind === "person.question" &&
              !(
                request.presentation.kind === "form" &&
                request.presentation.detailFormat === "plain"
              )
            }
            mono={request.kind === "harness.approval"}
            text={detail}
          />
        ) : null}
        {isQuestionRequest(request) && !surface.denied ? (
          <QuestionBody
            composer={composer}
            disabled={disabled}
            request={request}
            threadId={viewThreadId}
            title={title}
          />
        ) : (
          <ActionBody disabled={disabled} surface={surface} threadId={threadId} />
        )}
      </div>
    </fieldset>
  );
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
  const { hostClient } = useShell();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { request } = surface;
  // Approve and deny stay enabled offline; the answer says it wasn't sent, under the buttons.
  const answer = useAction(
    hostClient,
    {
      ...requestAnswer,
      execute: (response: RequestResponse) =>
        hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
          ...requestDecision(request),
          response,
          type: "request.respond",
        }),
    },
    `request:${request.id}`,
  );

  if (surface.denied) {
    return <DeniedRequestBody denied={surface.denied} />;
  }
  if (request.kind === "browser.access") {
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
  if (request.kind === "device.access") {
    return <ThreadDeviceAccessAction disabled={disabled} request={request} />;
  }
  if (request.kind === "computer.app.access") {
    return <ThreadComputerAppAccessAction disabled={disabled} request={request} />;
  }
  if (isPluginRequest(request)) {
    return <ThreadPluginAction disabled={disabled} request={request} />;
  }

  const respond = (response: RequestResponse, busyId: string) => {
    if (pendingId || disabled) return;
    setPendingId(busyId);
    void answer.run(response).finally(() => setPendingId(null));
  };
  const line = answer.line ? <ActionLine line={answer.line} wrap /> : null;

  if (request.presentation.kind === "choice") {
    return (
      <>
        <ChoiceRows
          autoFocus
          onSelect={(option) => respond({ kind: "choice", optionId: option.id }, option.id)}
          options={request.presentation.options}
          pendingId={pendingId}
        />
        {line}
      </>
    );
  }
  return (
    <>
      <ActionForm
        request={request}
        onRespond={(response) => respond(response, "form")}
        pending={disabled || pendingId !== null}
      />
      {line}
    </>
  );
}

/** Only the decision is withheld from a viewer who cannot make it. */
export function DeniedRequestBody({ denied }: { denied: NonNullable<SurfaceModel["denied"]> }) {
  return (
    <ActionNote>
      {denied === "administrator"
        ? "A Host administrator must complete this request."
        : "The person who started this task must answer this request."}
    </ActionNote>
  );
}

function requestIcon(request: Request): IconName {
  if (request.kind === "harness.input" || request.kind === "person.question") return "help-circle";
  // A phone's access Request asks for the phone itself, so it reads as one.
  if (
    request.payload.kind === "computer.app.access" &&
    isPhoneDisplayDefinitionId(request.payload.definitionId)
  )
    return "phone";
  // Both name one enrolled computer, so both read as one.
  if (
    request.kind === "machine.full-disk-access" ||
    request.kind === "computer.app.access" ||
    request.kind === "device.access"
  )
    return "laptop";
  if (request.kind === "browser.sign-in" || request.kind === "browser.password-sign-in")
    return "key";
  if (request.kind.startsWith("browser.")) return "browser";
  if (request.kind.startsWith("integration.") || request.kind.startsWith("plugin.")) {
    return "puzzle";
  }
  return "shield";
}

/** The open Request's detail, folded again for each Request the panel shows. */
function RequestPanelDetail(props: { markdown: boolean; mono: boolean; text: string }) {
  const [open, setOpen] = useState(false);
  return <RequestDetail {...props} onOpenChange={setOpen} open={open} />;
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
