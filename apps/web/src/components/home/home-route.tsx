import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { ThreadAccessMode } from "@opensteer/core";
import {
  accessModeConflict,
  accountGettingReady,
  composerExecutionSelection,
  lastExecutionSelection,
  placementForSelection,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { composerDraftKeyFor, composerDrafts, homeDraftId } from "../composer-drafts.js";
import { Composer, type ComposerSubmission } from "../composer.js";
import { personalReferenceCandidates } from "../composer-reference-picker.js";
import { ExecutionControls } from "../execution-controls.js";
import { UsageNotice } from "../usage-notice.js";
import { hostMessageOutbox } from "@opensteer/client/host";
import { presentClientIssue } from "@opensteer/client/feedback";
import { ActionLine } from "../action-line.js";
import { useAction } from "../use-action.js";
import type { PendingSubmission } from "../../host/message-outbox.js";
import { AreaHeader, NewTaskMark } from "../workspace/conversation-header.js";
import { useWorkspace } from "../workspace/workspace-context.js";
import { useComposerContext } from "../workspace/composer-context.js";
import { TasksHome } from "./tasks-home.js";

/** Home: what should your agent do, and the composer that starts it. */
export function HomeRoute() {
  const { hostClient, snapshot } = useShell();
  const navigate = useNavigate();
  const draftId = useTaskDraftId();
  const [suggestion, setSuggestion] = useState<{
    readonly key: number;
    readonly text: string;
  } | null>(null);
  const firstRun = (snapshot.tasks?.entries.length ?? 0) === 0 && snapshot.activeTasks.length === 0;
  return (
    <TasksHome
      agentHome={snapshot.personalSettings?.agentHome.path ?? null}
      composer={<NewTaskComposer draftId={draftId} key={draftId} suggestion={suggestion} />}
      firstRun={firstRun}
      header={<AreaHeader hostClient={hostClient} mark={<NewTaskMark />} title="New task" />}
      needsAccount={snapshot.harnesses.length === 0}
      onConnectAccount={() => void navigate("/settings/ai")}
      onSuggestion={(text) => setSuggestion((current) => ({ key: (current?.key ?? 0) + 1, text }))}
    />
  );
}

/**
 * Which draft this page writes: Home keeps one unsent draft of its own and
 * shows it again on every return; there is no list of drafts. An address may
 * still name another.
 */
function useTaskDraftId(): string {
  const [params] = useSearchParams();
  return params.get("draft") ?? homeDraftId;
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
  const canCreate = snapshot.can?.createTasks === true;
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
  const canCreateThread = canCreate && selection !== null;
  const inputRef = useRef<HTMLElement | null>(null);
  const accessConflict = selectedPlacement
    ? accessModeConflict(accessMode, selectedPlacement)
    : null;
  const sendBlocked = hostMessageOutbox(hostClient)
    ? accessConflict
    : presentClientIssue({ code: "storage-unavailable" }).title;
  const attachmentTarget =
    draftKey && deploymentId ? { client: hostClient, scope: draftKey, deploymentId } : null;
  // A suggestion fills the draft; the person sends it.
  useEffect(() => {
    if (!suggestion || !draftKey) return;
    composerDrafts.update(draftKey, { text: suggestion.text });
    inputRef.current?.focus();
  }, [draftKey, suggestion]);

  // Not started offline: the draft stays and this line says why, above it.
  const start = useAction(hostClient, {
    label: "start",
    done: "started",
    thing: "this task",
    execute: (message: PendingSubmission) => createThreadAndSend(message, selection!, accessMode),
  });
  const startThread = async (
    body: string,
    {
      attachments,
      places,
      idempotencyKey,
    }: Pick<ComposerSubmission, "attachments" | "places" | "idempotencyKey">,
  ): Promise<false | undefined> => {
    if (!selection) return false;
    const outcome = await start.run({
      attachments,
      body,
      ...(places.length > 0 ? { places } : {}),
      idempotencyKey,
    });
    if (outcome.kind !== "confirmed") return false;
    nav.openConversation(nav.threadPath(outcome.value.id));
    return undefined;
  };
  return (
    <>
      {start.line ? (
        <div aria-live="polite" className="home-start-line">
          <ActionLine line={start.line} wrap />
        </div>
      ) : null}
      <Composer
        attachments={attachmentTarget}
        autoFocus
        dictationScope={`${deploymentId}/${userId}/new-task`}
        disabled={!canCreateThread}
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
        onSend={startThread}
        placeContext={placeContext}
        placeholder={placeholderFor(selection !== null, blockedPlacement, canCreate)}
        references={(query) => personalReferenceCandidates(hostClient, query)}
        sendBlocked={sendBlocked}
        sendLabel="Start task"
      />
      <UsageNotice placements={placements} returnFocusTo={inputRef} selection={selection} />
    </>
  );
}
