import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { useClientConnection } from "@opensteer/client/react";
import { clientScopeKey } from "@opensteer/client/connections";
import { useShell } from "../app-shell.js";
import { composerDraftKeyFor, composerDrafts, homeDraftId } from "../composer-drafts.js";
import { Composer, type ComposerSubmission } from "../composer.js";
import { personalReferenceCandidates } from "../composer-reference-picker.js";
import { ExecutionControls } from "../execution-controls.js";
import { UsageNotice } from "../usage-notice.js";
import { hostMessageOutbox } from "@opensteer/client/host";
import { presentClientIssue } from "@opensteer/client/feedback";
import { act, ActionNotDone, failureWords } from "../use-action.js";
import { AreaHeader, NewTaskMark } from "../workspace/conversation-header.js";
import { useWorkspace } from "../workspace/workspace-context.js";
import { useComposerContext } from "../workspace/composer-context.js";
import { TasksHome } from "./tasks-home.js";
import { belongsToPreviousLogin, heldTaskStart } from "./task-start.js";
import { setAsideStagedFiles } from "../attachments/use-staged-attachments.js";

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
  const { scope } = useClientConnection(hostClient.connection);
  const scopeKey = clientScopeKey(scope);
  const generation = useSyncExternalStore(composerDrafts.subscribe, () => {
    const draft = draftKey && composerDrafts.read(draftKey);
    return draft && draft.startPending !== false ? (draft.startGeneration ?? null) : null;
  });
  const draft = draftKey ? composerDrafts.read(draftKey) : null;
  const legacyStart = draft?.start !== undefined;
  const [journal, setJournal] = useState<{
    scope: string;
    generation: string;
    previousLogin: boolean;
    resume: boolean;
  } | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const activeJournal =
    journal?.scope === scopeKey && journal.generation === generation ? journal : null;
  const previousLogin =
    Boolean(scopeKey && draft?.startScope && draft.startScope !== scopeKey) ||
    activeJournal?.previousLogin === true;
  const resume = !previousLogin && (legacyStart || activeJournal?.resume === true);
  const startOwnerBound = draft?.startScope !== undefined;
  useEffect(() => {
    if (!scopeKey || !draftKey || !generation) return;
    let active = true;
    void Promise.all([
      heldTaskStart(scopeKey, draftKey, generation),
      startOwnerBound ? false : belongsToPreviousLogin(scopeKey, draftKey, generation),
    ]).then(
      ([resume, previousLogin]) => {
        if (active) setJournal({ scope: scopeKey, generation, resume, previousLogin });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [scopeKey, draftKey, generation, startOwnerBound]);
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
  const canCreateThread = resume || (canCreate && selection !== null);
  const inputRef = useRef<HTMLElement | null>(null);
  const accessConflict = selectedPlacement
    ? accessModeConflict(accessMode, selectedPlacement)
    : null;
  const sendBlocked = hostMessageOutbox(hostClient)
    ? resume
      ? null
      : accessConflict
    : presentClientIssue({ code: "storage-unavailable" }).title;
  const attachmentTarget =
    draftKey && deploymentId ? { client: hostClient, scope: draftKey, deploymentId } : null;
  // A suggestion fills the draft; the person sends it.
  useEffect(() => {
    if (!suggestion || !draftKey) return;
    composerDrafts.update(draftKey, { text: suggestion.text });
    inputRef.current?.focus();
  }, [draftKey, suggestion]);

  // Not started offline or refused: the composer keeps the draft and says why.
  const startThread = async (
    body: string,
    {
      attachments,
      places,
      idempotencyKey,
      quotedMessageId,
    }: Pick<ComposerSubmission, "attachments" | "places" | "idempotencyKey" | "quotedMessageId">,
  ) => {
    if (!canCreateThread || previousLogin)
      throw new ActionNotDone({ kind: "not-sent", issue: null });
    const message = {
      attachments,
      body,
      ...(places.length > 0 ? { places } : {}),
      idempotencyKey,
      ...(quotedMessageId ? { quotedMessageId } : {}),
    };
    const expected = draftKey && composerDrafts.read(draftKey)?.startGeneration;
    const login = clientScopeKey(hostClient.connection.getSnapshot().scope);
    try {
      const thread = await act(
        hostClient,
        { label: "start this task", done: "started", happened: "this task started" },
        () =>
          createThreadAndSend(
            message,
            canCreate ? selection : null,
            accessMode,
            draftKey,
            legacyStart,
          ),
      );
      if (!thread.preserveDraft) nav.openConversation(nav.threadPath(thread.id));
      return thread;
    } catch (error) {
      const reason = failureWords(error);
      if (
        reason &&
        draftKey &&
        expected &&
        login === clientScopeKey(hostClient.connection.getSnapshot().scope)
      ) {
        const held = composerDrafts.read(draftKey);
        if (held?.startGeneration === expected && held.startScope === login)
          composerDrafts.handBack(draftKey, { edit: (text) => text, reason });
      }
      throw error;
    }
  };
  return (
    <>
      {previousLogin ? (
        <p role="status">This draft belongs to your previous sign-in.</p>
      ) : (
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
          key={`${editorVersion}/${suggestion?.key ?? 0}`}
          onSend={startThread}
          placeContext={placeContext}
          placeholder={
            resume
              ? "Finish starting this task…"
              : placeholderFor(selection !== null, blockedPlacement, canCreate)
          }
          references={(query) => personalReferenceCandidates(hostClient, query)}
          sendBlocked={sendBlocked}
          sendLabel={resume ? "Resume task" : "Start task"}
        />
      )}
      {draftKey && (generation || legacyStart) ? (
        <button
          className="btn btn--ghost btn--small"
          onClick={() => {
            if (!composerDrafts.clear(draftKey)) {
              setDiscardError("Couldn't discard this draft. Try again.");
              return;
            }
            setDiscardError(null);
            setAsideStagedFiles(draftKey).forget();
            setEditorVersion((version) => version + 1);
          }}
          type="button"
        >
          Discard draft
        </button>
      ) : null}
      {discardError ? <p role="status">{discardError}</p> : null}
      <UsageNotice placements={placements} returnFocusTo={inputRef} selection={selection} />
    </>
  );
}
