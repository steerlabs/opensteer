import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { CHAT_THREAD_TITLE, type ThreadAccessMode } from "@opensteer/core";
import {
  accessModeConflict,
  placementForSelection,
  accessModeOptions,
  accountGettingReady,
  composerExecutionSelection,
  lastExecutionSelection,
  mainWorkspace,
  mutationIdempotencyKey,
  preparingPlacement,
  threadPlacementOptions,
  unwrapRpcResult,
  taskTime,
  workspaceTaskList,
  type EnvironmentSummary,
  type ExecutionSelection,
  type HostSnapshot,
  type ThreadPlacementOption,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { actionErrorMessage, useMinuteClock } from "../ui-utils.js";
import { useShell } from "./app-shell.js";
import { AssigneePicker } from "./assignee-picker.js";
import { Composer, type ComposerSubmission } from "./composer.js";
import { HomeIntro } from "./home-intro.js";
import { ThreadSurface } from "./thread-view.js";
import { WorkspaceNotificationMute } from "./workspace-notification-mute.js";
import {
  discardStagedHomeMessage,
  pendingScopeUnavailable,
  pendingStorageAvailable,
  pendingStorageUnavailable,
  promoteHomeFirstMessage,
  stagedHomeMessage,
} from "./pending-sends.js";
import { ExecutionControls } from "./execution-controls.js";
import {
  applyThreadExecution,
  reviewExecutionSwitch,
  reviewFreshStart,
  type ReviewedChoice,
} from "./execution-review.js";
import { Icon } from "./icon.js";
import { PageTopbar } from "./page-header.js";
import { AreaHeader, NewTaskMark } from "./workspace/conversation-header.js";
import { useWorkspace } from "./workspace/workspace-context.js";
import { useComposerContext } from "./workspace/composer-context.js";
import { WorkspaceIconChooser } from "./workspace-icon-picker.js";
import { AccessModeControl } from "./access-mode-control.js";
import { LoadingRows } from "./loading-rows.js";
import { TaskGroup, TaskRowLink, useTaskSnapshot } from "./task-rows.js";

/**
 * Home: the one conversation the app opens into.
 *
 * Once the Host has a Home Thread this is that conversation, rendered by the
 * same view every other conversation uses. Before it exists there is no Thread
 * to render and none is invented: the intro is a real composer whose draft,
 * files and quote are carried into the Home its first send creates.
 */
export function HomeRoute() {
  const { homeThreadId, snapshot } = useShell();
  const workspace = mainWorkspace(snapshot);
  // Decided on arrival and not revisited while the intro holds something: a
  // Home that appears from another device must not take somebody's draft,
  // quote or uploads away mid-sentence. With the composer empty there is
  // nothing to keep, and the conversation that now exists is what to show.
  const [arrivedWithoutHome] = useState(homeThreadId === null);
  const [introHolding, setIntroHolding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const threadId = created ?? homeThreadId;
  const stayInIntro = arrivedWithoutHome && created === null && (threadId === null || introHolding);
  if (stayInIntro || threadId === null) {
    if (!workspace) return <MainWorkspacePending snapshot={snapshot} />;
    return <HomeIntro onCreated={setCreated} onHolding={setIntroHolding} workspace={workspace} />;
  }
  return <HomeConversation threadId={threadId} />;
}

type FirstMessageHandover = "saved" | "sending" | "none" | { readonly error: string };

/**
 * Home, with any message written before it existed handed to it explicitly.
 *
 * That message can outlive the intro — a reload between creation and the send,
 * or a Home another device started on a different AI — and in every one of
 * those cases nobody has agreed that this Home should send it. So it is never
 * promoted on arrival: Home names what it runs, and the send is a press.
 */
function HomeConversation({ threadId }: { readonly threadId: string }) {
  const {
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    refreshHarnessCatalog,
    openMobileNavigation,
    placements,
    reportActionError,
    snapshot,
  } = useShell();
  const deploymentId = snapshot.deploymentId ?? "";
  const userId = snapshot.user?.id ?? "";
  const [handover, setHandover] = useState<FirstMessageHandover>(() =>
    deploymentId && userId && stagedHomeMessage({ deploymentId, userId }) !== "none"
      ? "saved"
      : "none",
  );
  useEffect(() => {
    if (handover !== "sending") return;
    try {
      promoteHomeFirstMessage({ deploymentId, threadId, userId });
      setHandover("none");
    } catch (error) {
      setHandover({ error: actionErrorMessage(error) });
    }
  }, [deploymentId, handover, threadId, userId]);

  if (handover === "none") return <ThreadSurface threadId={threadId} />;
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  const placement = thread
    ? (placements.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId &&
          candidate.harnessInstanceId === thread.harnessInstanceId,
      ) ?? null)
    : null;
  const running = placement
    ? `${placement.engineName} · ${placement.accountName}`
    : (thread?.harnessLabel ?? null);
  const accessLabel = thread
    ? (accessModeOptions.find((option) => option.mode === thread.accessMode)?.label ??
      thread.accessMode)
    : null;
  const discard = () => {
    discardStagedHomeMessage({ deploymentId, userId });
    setHandover("none");
  };
  // The Run queue Home has right now: a change of AI is refused while any of
  // it is nonterminal, exactly as it is inside the conversation. The accounts
  // offered are that conversation's own — a Thread stays on its work location.
  const homeRunQueue = snapshot.runQueue.filter((run) => run.threadId === threadId);
  const homePlacements = thread
    ? placements.filter((candidate) => candidate.environmentId === thread.environmentId)
    : placements;
  const applyExecution = async (
    selection: ExecutionSelection,
    reviewed?: ReviewedChoice,
  ): Promise<boolean> => {
    if (!thread) return false;
    try {
      await applyThreadExecution({
        hostClient,
        recheck: () =>
          reviewExecutionSwitch({
            placements: homePlacements,
            runQueue: homeRunQueue,
            selection,
            thread,
          }),
        reviewed,
        selection,
        threadId: thread.id,
      });
      return true;
    } catch (error) {
      reportActionError(error);
      return false;
    }
  };
  return (
    <div className="thread">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={CHAT_THREAD_TITLE} />
      <div className="hero">
        <div className="hero__inner">
          {typeof handover === "object" ? (
            <div className="notice notice--error" role="alert">
              <Icon name="alert-circle" />
              <div>The message you wrote for Chat could not be handed to it: {handover.error}</div>
              <button
                className="btn btn--small"
                onClick={() => setHandover("sending")}
                type="button"
              >
                Try again
              </button>
              <button className="btn btn--small btn--ghost" onClick={discard} type="button">
                Discard it
              </button>
            </div>
          ) : thread === null || running === null ? (
            <span aria-label="Opening Chat" className="spinner" role="status" />
          ) : (
            <>
              <h1 className="hero__title">Chat is already running</h1>
              <p className="hero__subtitle" role="status">
                Chat uses {thread.modelLabel} with {running} · {accessLabel}. Your message is saved
                and has not been sent.
              </p>
              {/* The same pickers the conversation itself has, on Chat itself:
                  changing the AI here is reviewed and refused mid-Run exactly as
                  it is there, and the saved message is untouched by it. */}
              <div className="hero__actions">
                <ExecutionControls
                  disabled={handover === "sending"}
                  onApply={applyExecution}
                  onAuthenticate={openHarnessAuthentication ?? undefined}
                  onRefresh={refreshHarnessCatalog}
                  placements={homePlacements}
                  preferences={executionPreferences}
                  review={(selection) =>
                    reviewExecutionSwitch({
                      placements: homePlacements,
                      runQueue: homeRunQueue,
                      selection,
                      thread,
                    })
                  }
                  reviewFresh={() =>
                    reviewFreshStart({ placements: homePlacements, runQueue: homeRunQueue, thread })
                  }
                  selection={{
                    environmentId: thread.environmentId,
                    harnessInstanceId: thread.harnessInstanceId,
                    modelSelection: thread.modelSelection,
                  }}
                />
                <AccessModeControl
                  disabled={handover === "sending"}
                  engine={placement}
                  mode={thread.accessMode}
                  onApply={async (accessMode) => {
                    try {
                      await hostClient.updateThreadAccess(thread.id, accessMode);
                    } catch (error) {
                      reportActionError(error);
                    }
                  }}
                />
              </div>
              <div className="hero__actions">
                <button
                  className="btn"
                  disabled={handover === "sending"}
                  onClick={() => setHandover("sending")}
                  type="button"
                >
                  Send it with {placement?.engineName ?? running}
                </button>
                <button className="btn btn--ghost" onClick={discard} type="button">
                  Discard it
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * New task: deliberately separate work, in the same Main Workspace. It is the
 * secondary action — Chat is where a person can simply keep asking.
 */
export function NewTaskRoute() {
  const { snapshot } = useShell();
  const homeWorkspace = mainWorkspace(snapshot);
  if (!homeWorkspace) return <MainWorkspacePending snapshot={snapshot} />;
  return <WorkspaceHome home workspace={homeWorkspace} />;
}

/** Main is the Host's to create, so its absence is a wait or a fault, not a choice. */
function MainWorkspacePending({ snapshot }: { readonly snapshot: HostSnapshot }) {
  const { hostClient, openMobileNavigation, reportActionError } = useShell();
  const loading = snapshot.workspaces.length === 0;
  return (
    <div className="thread">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={CHAT_THREAD_TITLE} />
      <div className="hero">
        <div className="hero__inner">
          {loading ? (
            <>
              <h1 className="hero__title">Preparing your Workspace…</h1>
              <span aria-label="Preparing your Workspace" className="spinner" role="status" />
            </>
          ) : (
            <>
              <h1 className="hero__title">Your Main Workspace isn’t available</h1>
              <p className="hero__subtitle">
                Chat lives in it, so this conversation cannot open until this deployment reports it.
              </p>
              <button
                className="btn"
                onClick={() => void hostClient.refresh().catch(reportActionError)}
                type="button"
              >
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceHomeRoute() {
  const { workspaceId } = useParams();
  const { hostClient, snapshot } = useShell();
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // Opening a specialist, from wherever it was opened, follows its stream.
  const activeWorkspaceId = workspace?.id ?? null;
  useEffect(() => {
    if (activeWorkspaceId) hostClient.activateWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, hostClient]);
  if (!workspace) return <Navigate replace to="/" />;
  if (workspace.kind === "main") return <Navigate replace to="/" />;
  return <WorkspaceHome key={workspace.id} home={false} workspace={workspace} />;
}

const suggestions = [
  "Summarize what changed here this week",
  "Research a topic and write up what you find",
  "Draft a plan before making any changes",
  "Organize the files here",
];

function WorkspaceHome({ home, workspace }: { home: boolean; workspace: WorkspaceSummary }) {
  const { nav } = useWorkspace();
  const {
    createThreadAndSend,
    defaultPlacement,
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    refreshHarnessCatalog,
    openSharing,
    placements,
    rememberExecution,
    snapshot,
  } = useShell();
  const [suggestionPending, setSuggestionPending] = useState(false);
  // A new task's draft follows the place in front until it is touched.
  const context = useComposerContext({ auto: true, hostClient });
  const placeContext = useMemo(() => ({ context, hostClient }), [context, hostClient]);
  const [accessMode, setAccessMode] = useState<ThreadAccessMode>(executionPreferences.accessMode);
  const remembered = useMemo(
    () => lastExecutionSelection(executionPreferences),
    [executionPreferences],
  );

  // The composer's execution choice: an explicit pick this visit wins outright,
  // otherwise the choice the Host remembers — both decisions, so neither is
  // replaced when it stops resolving. The default placement answers only when
  // nothing was ever chosen. Everything is re-validated on every render.
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const selection = useMemo(
    () => composerExecutionSelection({ chosen, defaultPlacement, placements, remembered }),
    [chosen, defaultPlacement, placements, remembered],
  );
  // A choice that no longer resolves is what the composer is blocked on,
  // whether it was made this visit or remembered from the last one. It stays
  // named in the picker instead of being replaced by another account.
  const blocked = useMemo(
    () => (selection === null ? (chosen ?? remembered) : null),
    [chosen, remembered, selection],
  );
  const blockedPlacement = useMemo(
    () => (blocked ? placementForSelection(placements, blocked) : null),
    [blocked, placements],
  );
  // The engine this Thread would start on decides which access modes it may be
  // started in; until one is resolved nothing is ruled out.
  const selectedPlacement = useMemo(
    () => (selection ? placementForSelection(placements, selection) : null),
    [placements, selection],
  );
  const canCreateThread = workspace.status === "ready" && selection !== null;
  // Files are staged in the Workspace the Thread will start in, before the
  // Thread exists; the first message is kept before anything sends it.
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id ?? null;
  const storageReady = useMemo(() => pendingStorageAvailable(), []);
  // An access mode the chosen engine cannot enforce is the person's to change;
  // the Host would refuse the Thread rather than run it in another mode.
  const accessConflict = selectedPlacement
    ? accessModeConflict(accessMode, selectedPlacement)
    : null;
  const sendBlocked =
    !deploymentId || !userId
      ? pendingScopeUnavailable
      : !storageReady
        ? pendingStorageUnavailable
        : accessConflict;
  const attachmentTarget =
    deploymentId && userId
      ? {
          client: hostClient,
          scope: `${deploymentId}/${userId}/new-thread/${workspace.id}`,
          workspaceId: workspace.id,
        }
      : null;

  const startThread = async (
    body: string,
    {
      attachments,
      places,
      idempotencyKey,
    }: Pick<ComposerSubmission, "attachments" | "places" | "idempotencyKey">,
  ) => {
    if (!selection) throw new Error("The Thread could not be started.");
    const thread = await createThreadAndSend(
      workspace.id,
      { attachments, body, ...(places.length > 0 ? { places } : {}), idempotencyKey },
      selection,
      accessMode,
    );
    if (!thread) throw new Error("The Thread could not be started.");
    // The new task opens where its draft was written; the place stays.
    nav.openConversation(nav.threadPath(thread.id));
  };

  const health = useMemo(() => workspaceHealth(workspace, snapshot), [snapshot, workspace]);
  const specialists = useMemo(
    () => snapshot.workspaces.filter((candidate) => candidate.kind === "specialized"),
    [snapshot.workspaces],
  );
  const greeting = home
    ? "What should this task take care of?"
    : `What should we take care of in ${workspace.name}?`;

  return (
    <div className="thread">
      <AreaHeader
        hostClient={hostClient}
        mark={home ? <NewTaskMark /> : null}
        title={home ? "New task" : workspace.name}
      />

      <div className={home ? "hero" : "hero hero--specialist"}>
        <div className="hero__inner">
          {home ? null : (
            <div className="hero__workspace">
              <WorkspaceIcon workspace={workspace} />
              <div className="hero__workspace-copy">
                <h1>{workspace.name}</h1>
                {workspace.description ? <p>{workspace.description}</p> : null}
              </div>
            </div>
          )}
          {home ? (
            <h1 className="hero__title">{health ? health.heading : greeting}</h1>
          ) : health ? (
            <h2 className="hero__title">{health.heading}</h2>
          ) : null}
          {home ? null : <SpecialistTasks workspaceId={workspace.id} />}
          {health ? (
            <>
              <p className="hero__subtitle">{health.body}</p>
              {health.action}
            </>
          ) : null}
          {health?.blocking ? null : (
            <>
              <Composer
                dictationScope={`${deploymentId}/${userId}/new-thread/${workspace.id}`}
                placeContext={placeContext}
                attachments={attachmentTarget}
                autoFocus
                disabled={!canCreateThread}
                onSend={startThread}
                placeholder={newThreadPlaceholder(
                  workspace.status,
                  selection !== null,
                  blockedPlacement,
                  workspace.kind === "main" ? "Opensteer" : workspace.name,
                )}
                sendBlocked={sendBlocked}
                sendLabel="Start task"
                leadingFooter={<AssigneePicker specialists={specialists} workspace={workspace} />}
                footerExtras={
                  <>
                    <ExecutionControls
                      access={{
                        engine: selectedPlacement,
                        mode: accessMode,
                        onApply: (mode) => {
                          setAccessMode(mode);
                          rememberExecution({ accessMode: mode });
                        },
                      }}
                      blocked={blocked}
                      onApply={(next) => {
                        setChosen(next);
                        rememberExecution({ selection: next });
                      }}
                      onAuthenticate={openHarnessAuthentication ?? undefined}
                      onRefresh={refreshHarnessCatalog}
                      placements={placements}
                      preferences={executionPreferences}
                      selection={selection}
                    />
                  </>
                }
              />
              <div className="hero__suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="hero__suggestion"
                    disabled={suggestionPending || !canCreateThread || sendBlocked !== null}
                    onClick={() => {
                      if (!selection) return;
                      setSuggestionPending(true);
                      // The shell presents creation errors; suggestions have no draft to retain.
                      void startThread(suggestion, {
                        attachments: [],
                        idempotencyKey: mutationIdempotencyKey("message"),
                        places: context.parts(),
                      })
                        .catch(() => undefined)
                        .finally(() => setSuggestionPending(false));
                    }}
                    type="button"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </>
          )}
          {!home && workspace.status === "ready" ? (
            <WorkspaceNotificationMute workspace={workspace} />
          ) : null}
          {!home && workspace.status === "ready" && snapshot.workspaceSharingAvailable ? (
            <button
              className="btn btn--ghost btn--small"
              onClick={() => openSharing(workspace.id)}
              type="button"
            >
              <Icon name="share" /> Share this specialist
            </button>
          ) : null}
          {!home && workspace.status === "ready" ? (
            <WorkspaceDeletionAction action="workspace.delete" workspaceId={workspace.id} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The specialist's own tasks, on the same rows and in the same groups as the
 * sidebar: Working, Ready, then Done. They are read for this Workspace
 * alone, so a specialist's older work shows here without paging the reader's
 * whole list.
 */
function SpecialistTasks({ workspaceId }: { readonly workspaceId: string }) {
  const { hostClient, reportActionError, setTaskDone } = useShell();
  const snapshot = useTaskSnapshot(hostClient);
  const now = useMinuteClock();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setFailed(false);
    void hostClient.loadWorkspaceTasks(workspaceId).catch((error: unknown) => {
      setFailed(true);
      reportActionError(error);
    });
  }, [attempt, hostClient, reportActionError, workspaceId]);
  const list = useMemo(() => workspaceTaskList(snapshot, workspaceId), [snapshot, workspaceId]);
  const loaded = snapshot.workspaceTasks[workspaceId] !== undefined;
  const groups = [
    { done: false, id: "specialist-working", rows: list.working, title: "Working" },
    { done: false, id: "specialist-ready", rows: list.ready, title: "Ready" },
    { done: true, id: "specialist-done", rows: list.done, title: "Done" },
  ].filter((group) => group.rows.length > 0);
  return (
    <section aria-label="Tasks" className="specialist-tasks">
      {loaded ? (
        groups.length === 0 ? (
          <p className="specialist-tasks__empty">No tasks yet.</p>
        ) : (
          groups.map((group) => (
            <TaskGroup
              count={group.done ? null : group.rows.length}
              id={group.id}
              key={group.id}
              title={group.title}
            >
              {group.rows.map((row) => (
                <li key={row.threadId}>
                  <TaskRowLink
                    done={group.done}
                    onSetDone={setTaskDone}
                    row={row}
                    time={taskTime(row, now)}
                  />
                </li>
              ))}
            </TaskGroup>
          ))
        )
      ) : failed ? (
        <p className="specialist-tasks__empty">
          Couldn’t load this specialist’s tasks.{" "}
          <button
            className="link-btn"
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : (
        <LoadingRows label="Loading tasks" rows={2} />
      )}
      {list.hasMore ? (
        <button
          className="btn btn--ghost btn--small specialist-tasks__more"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void hostClient
              .loadEarlierTasks(workspaceId)
              .catch(reportActionError)
              .finally(() => setLoadingMore(false));
          }}
          type="button"
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}

export function newThreadPlaceholder(
  workspaceStatus: WorkspaceSummary["status"],
  hasExecutionSelection: boolean,
  blockedPlacement: ThreadPlacementOption | null = null,
  assignee = "Opensteer",
): string {
  if (workspaceStatus !== "ready") return "This Workspace is not ready yet.";
  // Naming the blocked option is the whole point: the person chose it, and
  // silence would read as the app having lost their choice.
  if (blockedPlacement?.availability === "preparing") {
    return `${accountGettingReady(`${blockedPlacement.accountName} on ${blockedPlacement.whereLabel}`)} — wait for it or choose another option.`;
  }
  if (blockedPlacement) {
    return `${blockedPlacement.accountName} on ${blockedPlacement.whereLabel} is unavailable — choose another option or wait for it to reconnect.`;
  }
  if (!hasExecutionSelection) return "Choose an available model to start.";
  return `What should ${assignee} do?`;
}

/**
 * Where a new Thread would run right now.
 *
 * "none" means no connected work location can start a Thread.
 */
export function workLocationState(
  environments: readonly EnvironmentSummary[],
): "connected" | "none" {
  return environments.some((environment) => environment.connected) ? "connected" : "none";
}

export function workspaceHealth(
  workspace: WorkspaceSummary,
  snapshot: Pick<HostSnapshot, "environments" | "harnesses">,
): { action: React.ReactNode; blocking: boolean; body: string; heading: string } | null {
  const workLocation = workLocationState(snapshot.environments);
  const placements = threadPlacementOptions(snapshot.environments, snapshot.harnesses);
  const readyAiEngine = placements.some((placement) => placement.available);
  if (workspace.status === "provisioning") {
    return {
      action: <span className="spinner" role="status" aria-label="Preparing" />,
      blocking: true,
      body: "Your durable Workspace storage is being prepared. This usually takes a moment.",
      heading: "Preparing your Workspace…",
    };
  }
  if (workspace.status === "failed" || workspace.storageIssue) {
    return {
      action: <RetryStorage workspaceId={workspace.id} />,
      blocking: true,
      body:
        workspace.storageIssue?.message ??
        "Workspace storage needs attention before new Threads can start.",
      heading: "Workspace storage needs attention",
    };
  }
  if (workspace.status === "unavailable") {
    return {
      action: null,
      blocking: true,
      body: "This Workspace is temporarily unavailable. It will come back on its own.",
      heading: "Workspace temporarily unavailable",
    };
  }
  if (workspace.status === "deleting") {
    return {
      action: (
        <WorkspaceDeletionAction action="workspace.deletion.recover" workspaceId={workspace.id} />
      ),
      blocking: true,
      body: "Its files are kept for the retention window, then removed for good. You can still bring it back.",
      heading: "This specialist is scheduled for deletion",
    };
  }
  if (workLocation === "none") {
    return {
      action: null,
      blocking: true,
      body: "No place to run work is connected right now. New Threads stay unavailable until your Main execution environment is back.",
      heading: "Waiting for a place to run work",
    };
  }
  const preparing = readyAiEngine ? null : preparingPlacement(placements);
  if (preparing) {
    return {
      action: null,
      blocking: true,
      body: "This can take a few minutes after Opensteer starts. New Threads can start once it is done.",
      heading: accountGettingReady(preparing.accountName),
    };
  }
  if (!readyAiEngine) {
    return {
      action: (
        <Link className="btn" to="/settings/ai-engines">
          Open AI services
        </Link>
      ),
      blocking: true,
      body: "Connect an account to start a Thread on this work location.",
      heading: "Connect an AI service",
    };
  }
  return null;
}

/**
 * The large mark on a specialized Workspace's home. Only an owner may change
 * its icon, so the picker appears once the reader's membership says so; the
 * read is the one the sharing dialog uses.
 */
function WorkspaceIcon({ workspace }: { workspace: WorkspaceSummary }) {
  const { hostClient, reportActionError, snapshot } = useShell();
  const [pending, setPending] = useState(false);
  const [owner, setOwner] = useState(false);
  const userId = snapshot.user?.id ?? null;
  const changeable =
    workspace.kind === "specialized" &&
    workspace.status !== "deleting" &&
    workspace.status !== "deleted";
  // Membership can change while the page is open, so it is read again
  // whenever the window regains focus and after the Host refuses a change.
  const [membershipRead, setMembershipRead] = useState(0);
  useEffect(() => {
    const reread = () => setMembershipRead((count) => count + 1);
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  useEffect(() => {
    if (!changeable || userId === null) {
      setOwner(false);
      return;
    }
    let current = true;
    void hostClient.rpc["workspace.members.list"]({ workspaceId: workspace.id })
      .then(unwrapRpcResult)
      .then(({ members }) => {
        if (current) {
          setOwner(
            members.some(
              (member) =>
                member.userId === userId && member.role === "owner" && member.state === "active",
            ),
          );
        }
      })
      .catch(() => {
        // Unknown ownership is not ownership; the next focus reads it again.
        if (current) setOwner(false);
      });
    return () => {
      current = false;
    };
  }, [changeable, hostClient, membershipRead, userId, workspace.id]);
  return (
    <WorkspaceIconChooser
      editable={changeable && owner}
      icon={workspace.icon}
      name={workspace.name}
      onChange={(icon) => {
        setPending(true);
        void hostClient
          .dispatch({
            icon,
            idempotencyKey: mutationIdempotencyKey(`workspace-icon:${workspace.id}`),
            type: "workspace.icon.set",
            workspaceId: workspace.id,
          })
          .catch((error: unknown) => {
            setMembershipRead((count) => count + 1);
            reportActionError(error);
          })
          .finally(() => setPending(false));
      }}
      onColorChange={
        snapshot.taskMarksAvailable
          ? (color) => {
              setPending(true);
              void hostClient
                .dispatch({
                  type: "workspace.color.set",
                  workspaceId: workspace.id,
                  color,
                  idempotencyKey: mutationIdempotencyKey(`workspace-color:${workspace.id}`),
                })
                .catch((error: unknown) => {
                  setMembershipRead((count) => count + 1);
                  reportActionError(error);
                })
                .finally(() => setPending(false));
            }
          : undefined
      }
      pending={pending}
      color={workspace.color}
    />
  );
}

function WorkspaceDeletionAction({
  action,
  workspaceId,
}: {
  action: "workspace.delete" | "workspace.deletion.recover";
  workspaceId: string;
}) {
  const { hostClient, reportActionError } = useShell();
  const [pending, setPending] = useState(false);
  const deleting = action === "workspace.delete";
  return (
    <button
      className={deleting ? "btn btn--ghost btn--small" : "btn"}
      disabled={pending}
      onClick={() => {
        if (
          deleting &&
          !window.confirm("Delete this specialist? You can recover it during the retention window.")
        ) {
          return;
        }
        setPending(true);
        void hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey(`${action}:${workspaceId}`),
            type: action,
            workspaceId,
          })
          .catch(reportActionError)
          .finally(() => setPending(false));
      }}
      type="button"
    >
      {deleting
        ? pending
          ? "Deleting…"
          : "Delete this specialist"
        : pending
          ? "Recovering…"
          : "Keep this specialist"}
    </button>
  );
}

function RetryStorage({ workspaceId }: { workspaceId: string }) {
  const { hostClient, reportActionError } = useShell();
  const [retrying, setRetrying] = useState(false);
  return (
    <button
      className="btn"
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        void hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey(`workspace-storage:${workspaceId}`),
            type: "workspace.storage.retry",
            workspaceId,
          })
          .catch(reportActionError)
          .finally(() => setRetrying(false));
      }}
      type="button"
    >
      {retrying ? "Retrying…" : "Retry provisioning"}
    </button>
  );
}
