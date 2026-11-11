import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { TaskFolderSchema, type TaskFolder, type ThreadAccessMode } from "@opensteer/core";
import {
  accessModeConflict,
  accountGettingReady,
  allTasksFilters,
  allTasksRows,
  composerExecutionSelection,
  doneTaskList,
  lastExecutionSelection,
  newTaskDefaults,
  placementForSelection,
  taskFolderKey,
  taskMark,
  unwrapRpcResult,
  type ExecutionSelection,
  type TaskRow,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { composerDraftKeyFor, composerDrafts } from "../composer-drafts.js";
import { Composer, type ComposerSubmission } from "../composer.js";
import { ExecutionControls } from "../execution-controls.js";
import { UsageNotice } from "../usage-notice.js";
import {
  pendingScopeUnavailable,
  pendingStorageAvailable,
  pendingStorageUnavailable,
} from "../pending-sends.js";
import { AreaHeader, NewTaskMark } from "../workspace/conversation-header.js";
import { useWorkspace } from "../workspace/workspace-context.js";
import { useComposerContext } from "../workspace/composer-context.js";
import { useTaskDirectory } from "../workspace/task-directory.js";
import { useTaskSourceLookup } from "../../team/task-sources.js";
import { FolderChip } from "./folder-picker.js";
import { folderView, shortPath } from "./folder-groups.js";
import type { FolderBrowseView, FolderView, TaskRowView } from "./home-models.js";
import { needsYouItems, useNeedsYouAnswer } from "./needs-you-model.js";
import { AllTasksPage, TasksHome } from "./tasks-home.js";

/** Home: what should your agent do, and the composer that starts it in a folder. */
export function HomeRoute() {
  const { hostClient, snapshot } = useShell();
  const navigate = useNavigate();
  const draftId = useTaskDraftId();
  const [suggestion, setSuggestion] = useState<{ readonly key: number; readonly text: string } | null>(
    null,
  );
  const firstRun =
    (snapshot.tasks?.entries.length ?? 0) === 0 && snapshot.activeTasks.length === 0;
  return (
    <TasksHome
      composer={<NewTaskComposer draftId={draftId} key={draftId} suggestion={suggestion} />}
      firstRun={firstRun}
      header={<AreaHeader hostClient={hostClient} mark={<NewTaskMark />} title="New task" />}
      needsAccount={snapshot.harnesses.length === 0}
      onConnectAccount={() => void navigate("/settings/ai")}
      onSuggestion={(text) => setSuggestion((current) => ({ key: (current?.key ?? 0) + 1, text }))}
    />
  );
}

/** All tasks: every open task until Done, by filter; Needs you is a filter with its asks. */
export function AllTasksRoute() {
  const { hostClient, reportActionError, snapshot } = useShell();
  const { nav } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const filter = allTasksFilters.find((value) => value === params.get("filter")) ?? "all";
  const directory = useTaskDirectory(hostClient);
  const sourceOf = useTaskSourceLookup();
  const agentHome = snapshot.personalSettings?.agentHome ?? null;
  const quietTasks = snapshot.quietTasksAvailable === true;
  useEffect(() => {
    if (filter === "done" && quietTasks) void hostClient.loadDoneTasks().catch(() => undefined);
  }, [filter, hostClient, quietTasks]);
  const doneList = useMemo(() => doneTaskList(snapshot), [snapshot]);
  const { list } = directory;
  const rows = useMemo(
    () =>
      allTasksRows(list, filter, doneList?.rows ?? list.done).map((row) =>
        taskRowView(
          row,
          directory.attentionByThread.get(row.threadId)?.title ?? null,
          sourceOf,
          shortPath(row.folder.path, agentHome),
        ),
      ),
    [agentHome, directory.attentionByThread, doneList, filter, list, sourceOf],
  );
  const counts = useMemo(
    () => ({
      "needs-you": snapshot.needsYou?.count ?? 0,
      running: allTasksRows(list, "running").length,
      unread: allTasksRows(list, "unread").length,
      read: allTasksRows(list, "read").length,
    }),
    [list, snapshot.needsYou?.count],
  );
  const needsYou = useMemo(() => needsYouItems(snapshot, sourceOf), [snapshot, sourceOf]);
  const answer = useNeedsYouAnswer(hostClient, reportActionError);
  const [loadingMore, setLoadingMore] = useState(false);
  const hasMore =
    filter === "done"
      ? (doneList?.hasMore ?? false)
      : filter === "needs-you"
        ? (snapshot.needsYou?.window.hasMore ?? false)
        : list.hasMore;
  const loadMore = () => {
    setLoadingMore(true);
    void (
      filter === "done"
        ? hostClient.loadEarlierDoneTasks()
        : filter === "needs-you"
          ? hostClient.loadEarlierNeedsYou()
          : hostClient.loadEarlierTasks()
    )
      .catch(reportActionError)
      .finally(() => setLoadingMore(false));
  };
  return (
    <AllTasksPage
      actions={{
        onAnswer: answer.answer,
        onOpenTask: (taskId) => nav.openConversation(nav.threadPath(taskId)),
        onFilter: (next) => setParams(next === "all" ? {} : { filter: next }, { replace: true }),
        taskHref: (taskId) => nav.threadPath(taskId),
        ...(hasMore ? { onLoadMore: loadMore } : {}),
      }}
      counts={counts}
      filter={filter}
      header={
        <AreaHeader
          hostClient={hostClient}
          title={`All tasks${list.working.length + list.ready.length > 0 ? ` · ${list.working.length + list.ready.length} open` : ""}`}
        />
      }
      loadingMore={loadingMore}
      needsYou={needsYou}
      pending={answer.pending}
      rows={rows}
    />
  );
}

export function taskRowView(
  row: TaskRow,
  ask: string | null,
  sourceOf: ReturnType<typeof useTaskSourceLookup>,
  folder: string,
): TaskRowView {
  return {
    id: row.threadId,
    title: row.title,
    mark: taskMark(row),
    tone: row.tone,
    unread: row.unread,
    ask,
    source: sourceOf(row.threadId),
    folder,
    status: row.line || null,
    updatedAt: row.askedAt,
    canBeDone: row.canBeDone,
  };
}

/**
 * Which draft this page writes. An address without one is a blank task, so it
 * is given a new id on arrival: naming a draft nobody wrote is just a blank
 * page, which is why nothing is kept until something is written.
 */
function useTaskDraftId(): string {
  const [params] = useSearchParams();
  const named = params.get("draft");
  const draftId = useMemo(() => named ?? globalThis.crypto.randomUUID(), [named]);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (named !== null) return;
    const search = new URLSearchParams(location.search);
    search.set("draft", draftId);
    void navigate(
      { hash: location.hash, pathname: location.pathname, search: `?${search.toString()}` },
      { replace: true, state: location.state },
    );
  }, [draftId, location.hash, location.pathname, location.search, location.state, named, navigate]);
  return draftId;
}

function folderFromKey(key: string | null): TaskFolder | null {
  if (!key) return null;
  try {
    const [computerId, path] = JSON.parse(key) as unknown[];
    const parsed = TaskFolderSchema.safeParse({ computerId, path });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function placeholderFor(
  hasSelection: boolean,
  blocked: ThreadPlacementOption | null,
  canCreate: boolean,
): string {
  if (!canCreate) return "This computer can’t start tasks right now.";
  if (blocked?.availability === "preparing")
    return `${accountGettingReady(`${blocked.accountName} on ${blocked.whereLabel}`)} — wait for it or choose another option.`;
  if (blocked)
    return `${blocked.accountName} on ${blocked.whereLabel} is unavailable — choose another option or wait for it to reconnect.`;
  if (!hasSelection) return "Choose an available model to start.";
  return "Ask your agent to…";
}

function NewTaskComposer({
  draftId,
  suggestion,
}: {
  readonly draftId: string;
  readonly suggestion: { readonly key: number; readonly text: string } | null;
}) {
  const { nav } = useWorkspace();
  const [params] = useSearchParams();
  const {
    createThreadAndSend,
    defaultPlacement,
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    refreshHarnessCatalog,
    placements,
    rememberExecution,
    snapshot,
  } = useShell();
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id ?? null;
  const draftKey = composerDraftKeyFor(deploymentId, userId, { kind: "task", draftId });
  const context = useComposerContext({ auto: true, draftKey, hostClient });
  const placeContext = useMemo(() => ({ context, hostClient }), [context, hostClient]);
  const defaults = newTaskDefaults(snapshot);
  const agentHome = defaults.folder;
  // The folder: the one this draft chose, then one the address names, then Agent home.
  const [folder, setFolder] = useState<TaskFolder | null>(
    () =>
      (draftKey ? composerDrafts.read(draftKey)?.folder : undefined) ??
      folderFromKey(params.get("folder")) ??
      agentHome,
  );
  const named = params.get("folder");
  useEffect(() => {
    const chosen = folderFromKey(named);
    if (chosen) setFolder(chosen);
  }, [named]);
  const current = folder ?? agentHome;
  const computerName = (computerId: string) =>
    snapshot.machines.find((machine) => machine.id === computerId)?.name ?? "This computer";
  // Only the hosting computer runs tasks in this build; the Host says which that is.
  const computers = defaults.environments.flatMap((environment) =>
    environment.runnerId === null
      ? []
      : [
          {
            id: environment.runnerId,
            name: computerName(environment.runnerId),
            kind: "laptop" as const,
            hosting: true,
            online: environment.connected,
          },
        ],
  );
  const recent = useMemo<FolderView[]>(() => {
    const seen = new Map<string, FolderView>();
    for (const thread of snapshot.threads)
      if (thread.purpose === "task" && !seen.has(taskFolderKey(thread.folder)))
        seen.set(taskFolderKey(thread.folder), folderView(thread.folder, agentHome, computerName));
    return [...seen.values()].slice(0, 6);
  }, [agentHome, snapshot.threads]);
  const [browsing, setBrowsing] = useState<FolderBrowseView | null>(null);
  const browse = (computerId: string, path: string | null) => {
    const computer = computers.find((candidate) => candidate.id === computerId);
    const at = path ?? agentHome?.path ?? "/";
    if (!computer) return;
    const crumbs = at
      .split("/")
      .filter(Boolean)
      .map((label, index, parts) => ({ label, path: `/${parts.slice(0, index + 1).join("/")}` }));
    setBrowsing({ computer, path: at, crumbs, entries: null });
    void hostClient.rpc["folder.files.list"]({
      folder: TaskFolderSchema.parse({ computerId, path: at }),
      parentKey: "",
    })
      .then(unwrapRpcResult)
      .then((page) =>
        setBrowsing((held) =>
          held?.path === at
            ? {
                ...held,
                entries: page.entries
                  .filter((entry) => entry.kind === "directory" && !entry.hidden)
                  .map((entry) => ({ name: entry.name, path: `${at.replace(/\/$/u, "")}/${entry.name}` })),
              }
            : held,
        ),
      )
      .catch((error: unknown) =>
        setBrowsing((held) =>
          held?.path === at
            ? { ...held, entries: [], error: error instanceof Error ? error.message : "Can’t read this folder." }
            : held,
        ),
      );
  };
  const [accessMode, setAccessMode] = useState<ThreadAccessMode>(executionPreferences.accessMode);
  const remembered = useMemo(
    () => lastExecutionSelection(executionPreferences),
    [executionPreferences],
  );
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const selection = useMemo(
    () => composerExecutionSelection({ chosen, defaultPlacement, placements, remembered }),
    [chosen, defaultPlacement, placements, remembered],
  );
  const blocked = useMemo(
    () => (selection === null ? (chosen ?? remembered) : null),
    [chosen, remembered, selection],
  );
  const blockedPlacement = useMemo(
    () => (blocked ? placementForSelection(placements, blocked) : null),
    [blocked, placements],
  );
  const selectedPlacement = useMemo(
    () => (selection ? placementForSelection(placements, selection) : null),
    [placements, selection],
  );
  const canCreateThread = defaults.canCreate && selection !== null && current !== null;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const storageReady = useMemo(() => pendingStorageAvailable(), []);
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
    draftKey && deploymentId ? { client: hostClient, scope: draftKey, deploymentId } : null;
  // A suggestion fills the draft; the person sends it.
  useEffect(() => {
    if (!suggestion || !draftKey) return;
    composerDrafts.update(draftKey, { text: suggestion.text });
    inputRef.current?.focus();
  }, [draftKey, suggestion]);

  const startThread = async (
    body: string,
    {
      attachments,
      places,
      idempotencyKey,
    }: Pick<ComposerSubmission, "attachments" | "places" | "idempotencyKey">,
  ) => {
    if (!selection || !current) throw new Error("The task could not be started.");
    const thread = await createThreadAndSend(
      current,
      { attachments, body, ...(places.length > 0 ? { places } : {}), idempotencyKey },
      selection,
      accessMode,
    );
    if (!thread) throw new Error("The task could not be started.");
    nav.openConversation(nav.threadPath(thread.id));
  };
  const currentView = current ? folderView(current, agentHome, computerName) : null;
  return (
    <>
      <Composer
        attachments={attachmentTarget}
        autoFocus
        dictationScope={`${deploymentId}/${userId}/new-task`}
        disabled={!canCreateThread}
        draftFolder={current ?? undefined}
        draftKey={draftKey}
        footerExtras={
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
        }
        inputRef={inputRef}
        key={suggestion?.key ?? 0}
        leadingFooter={
          currentView ? (
            <FolderChip
              browsing={browsing}
              computers={computers}
              current={currentView}
              onBrowse={browse}
              onChoose={(view) => {
                const next = [...(agentHome ? [agentHome] : []), ...snapshot.threads.map((thread) => thread.folder)].find(
                  (candidate) => taskFolderKey(candidate) === view.id,
                );
                if (next) setFolder(next);
              }}
              onUse={(computerId, path) => setFolder(TaskFolderSchema.parse({ computerId, path }))}
              recent={recent}
            />
          ) : null
        }
        onSend={startThread}
        placeContext={placeContext}
        placeholder={placeholderFor(selection !== null, blockedPlacement, defaults.canCreate)}
        sendBlocked={sendBlocked}
        sendLabel="Start task"
      />
      <UsageNotice placements={placements} returnFocusTo={inputRef} selection={selection} />
    </>
  );
}
