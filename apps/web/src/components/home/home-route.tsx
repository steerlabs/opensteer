import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { TaskFolderSchema, type TaskFolder, type ThreadAccessMode } from "@opensteer/core";
import {
  accessModeConflict,
  accountGettingReady,
  composerExecutionSelection,
  lastExecutionSelection,
  newTaskDefaults,
  placementForSelection,
  taskFolderKey,
  taskMark,
  taskTime,
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
import { useMinuteClock } from "../../ui-utils.js";
import { useTaskSourceLookup } from "../../team/task-sources.js";
import { FolderChip } from "./folder-picker.js";
import {
  folderRowLimit,
  folderSignal,
  folderView,
  groupByFolder,
  showDoneEvent,
} from "./folder-groups.js";
import type { FolderBrowseView, FolderGroupView, FolderView, TaskRowView } from "./home-models.js";
import { needsYouItems, useNeedsYouAnswer } from "./needs-you-model.js";
import { TasksHome } from "./tasks-home.js";

/**
 * Home: what should your agent do, the composer that starts it in a folder,
 * what waits on the person, then every task by folder.
 */
export function HomeRoute() {
  const { hostClient, reportActionError, snapshot } = useShell();
  const { nav } = useWorkspace();
  const navigate = useNavigate();
  const directory = useTaskDirectory(hostClient);
  const now = useMinuteClock();
  const sourceOf = useTaskSourceLookup();
  const draftId = useTaskDraftId();
  const [suggestion, setSuggestion] = useState<{ readonly key: number; readonly text: string } | null>(
    null,
  );
  const agentHome = snapshot.personalSettings?.agentHome ?? null;
  const computerName = useCallback(
    (computerId: string) =>
      snapshot.machines.find((machine) => machine.id === computerId)?.name ?? "Computer",
    [snapshot.machines],
  );
  const { list } = directory;
  const folders = useMemo<FolderGroupView[]>(
    () =>
      groupByFolder([...list.working, ...list.ready], agentHome, computerName).map((group) => ({
        folder: group.folder,
        tasks: group.rows.slice(0, folderRowLimit).map((row) =>
          taskRowView(row, directory.attentionByThread.get(row.threadId)?.title ?? null, sourceOf, now),
        ),
        more: Math.max(0, group.rows.length - folderRowLimit),
        ...folderSignal(group.rows),
      })),
    [agentHome, computerName, directory.attentionByThread, list.ready, list.working, now, sourceOf],
  );
  const needsYou = useMemo(() => needsYouItems(snapshot, sourceOf), [snapshot, sourceOf]);
  const answer = useNeedsYouAnswer(hostClient, reportActionError);
  const openTask = (taskId: string) => nav.openConversation(nav.threadPath(taskId));
  return (
    <TasksHome
      actions={{
        onAnswer: answer.answer,
        onOpenTask: openTask,
        onOpenNeedsYou: () => nav.openConversation("/needs-you"),
        onNewTaskIn: (folderId) =>
          void navigate({ pathname: "/", search: `?folder=${encodeURIComponent(folderId)}` }),
        onOpenDone: () => window.dispatchEvent(new Event(showDoneEvent)),
        onSuggestion: (text) => setSuggestion((current) => ({ key: (current?.key ?? 0) + 1, text })),
        onConnectAccount: () => void navigate("/settings/ai"),
        taskHref: (taskId) => nav.threadPath(taskId),
      }}
      composer={<NewTaskComposer draftId={draftId} key={draftId} suggestion={suggestion} />}
      doneCount={list.done.length}
      folders={folders}
      header={<AreaHeader hostClient={hostClient} mark={<NewTaskMark />} title="New task" />}
      needsAccount={snapshot.harnesses.length === 0}
      needsYou={needsYou}
    />
  );
}

export function taskRowView(
  row: TaskRow,
  ask: string | null,
  sourceOf: ReturnType<typeof useTaskSourceLookup>,
  now: number,
): TaskRowView {
  return {
    id: row.threadId,
    title: row.title,
    mark: taskMark(row),
    tone: row.tone,
    unread: row.unread,
    ask,
    source: sourceOf(row.threadId),
    status: row.line || null,
    updatedAt: taskTime(row, now) ?? "",
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
