import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { CHAT_THREAD_TITLE, type ThreadAccessMode } from "@opensteer/core";
import {
  accessModeConflict,
  placementForSelection,
  accountGettingReady,
  composerExecutionSelection,
  lastExecutionSelection,
  preparingPlacement,
  runsChosenExecution,
  type ExecutionSelection,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useShell } from "./app-shell.js";
import { VoiceButton, VoiceDock } from "./voice.js";
import { BrandMark } from "./brand.js";
import { Composer, type ComposerQuote, type ComposerSubmission } from "./composer.js";
import { ExecutionControls } from "./execution-controls.js";
import { UsageNotice } from "./usage-notice.js";
import {
  claimFirstMessage,
  discardStagedHomeMessage,
  homeFirstMessageSends,
  pendingScopeUnavailable,
  pendingStorageAvailable,
  pendingStorageUnavailable,
} from "./pending-sends.js";
import { AreaHeader } from "./workspace/conversation-header.js";
import { ChatOrb } from "./workspace/task-mark.js";
import { useComposerContext } from "./workspace/composer-context.js";

const suggestions = ["Help me plan my week", "Think through a decision"];

/**
 * Home before there is a Home.
 *
 * Nothing here pretends a conversation exists: the composer is real and its
 * draft is real, the execution choice is the reader's own, and the Home Thread
 * is created by the Host only when the first message has both. What is typed,
 * attached or quoted before then is kept and sent into the Home that creation
 * returns — the same message, under the same key.
 */
export function HomeIntro({
  onCreated,
  onHolding,
  workspace,
}: {
  /** Called with the Home the first send created, once it owes it this message. */
  readonly onCreated: (threadId: string) => void;
  /** Whether anything written, attached, quoted or in flight is still here. */
  readonly onHolding?: ((holding: boolean) => void) | undefined;
  readonly workspace: WorkspaceSummary;
}) {
  const {
    clearHomeHandoff,
    executionPreferences,
    homeDraft,
    homeHandoff,
    hostClient,
    openHarnessAuthentication,
    placements,
    rememberExecution,
    setHomeDraft,
    snapshot,
  } = useShell();
  const [accessMode, setAccessMode] = useState<ThreadAccessMode>(executionPreferences.accessMode);
  // One channel into the composer, so a quote handed over from a task and an
  // example prompt cannot cancel each other out. The draft kept by the shell
  // is restored first: it is what this reader had already written.
  const [restore, setRestore] = useState<{
    readonly key: number;
    readonly quote?: ComposerQuote | null;
    readonly text: string;
  } | null>(() => (homeDraft ? { key: 0, text: homeDraft } : null));
  const pushRestore = (next: { readonly quote?: ComposerQuote | null; readonly text: string }) =>
    setRestore((current) => ({ ...next, key: (current?.key ?? 0) + 1 }));
  useEffect(() => {
    if (!homeHandoff) return;
    setRestore((current) => ({
      key: (current?.key ?? 0) + 1,
      ...(homeHandoff.quote ? { quote: homeHandoff.quote } : {}),
      text: homeHandoff.text,
    }));
    clearHomeHandoff();
  }, [clearHomeHandoff, homeHandoff]);
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const remembered = useMemo(
    () => lastExecutionSelection(executionPreferences),
    [executionPreferences],
  );
  const runnable = useMemo(
    () => placements.filter((placement) => placement.available),
    [placements],
  );

  // One runnable account is shown and used; several, with nothing expressed,
  // is a question — picking one of them here would hide who pays for it.
  const onlyRunnable = runnable.length === 1 ? (runnable[0] ?? null) : null;
  const selection = useMemo(
    () =>
      composerExecutionSelection({
        chosen,
        defaultPlacement: onlyRunnable,
        placements,
        remembered,
      }),
    [chosen, onlyRunnable, placements, remembered],
  );
  // A choice that no longer runs stays named. Replacing it with another
  // account would quietly move the work — and the bill — somewhere else.
  const blocked = useMemo(
    () => (selection === null ? (chosen ?? remembered) : null),
    [chosen, remembered, selection],
  );
  const selectedPlacement = useMemo(
    () => (selection ? placementForSelection(placements, selection) : null),
    [placements, selection],
  );
  const blockedPlacement = useMemo(
    () => (blocked ? placementForSelection(placements, blocked) : null),
    [blocked, placements],
  );
  // An account getting ready, as one does after its computer starts, is only
  // a wait: naming it keeps the person from hunting for a fault. Their own
  // choice is the one they wait for; another getting ready would not let
  // them send.
  const preparing = useMemo(
    () =>
      blocked === null
        ? preparingPlacement(placements)
        : blockedPlacement?.availability === "preparing"
          ? blockedPlacement
          : null,
    [blocked, blockedPlacement, placements],
  );

  // Nothing chosen and something to choose: "Choose AI" is the composer's primary action.
  const choosable = selection === null && blocked === null && runnable.length > 0;
  const context = useComposerContext({ auto: true, hostClient });
  const placeContext = useMemo(() => ({ context, hostClient }), [context, hostClient]);
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
        : runnable.length === 0
          ? preparing
            ? `${accountGettingReady(preparing.accountName)}. You can send as soon as it is done.`
            : "Connect an AI account to start."
          : blocked !== null
            ? blockedPlacement?.availability === "preparing"
              ? `${accountGettingReady(blockedPlacement.accountName)}. Wait for it, or choose another AI to start.`
              : `${blocked.modelSelection.modelId} is unavailable right now. Choose another AI to start.`
            : selection === null
              ? "Choose an AI to start."
              : accessConflict !== null
                ? accessConflict
                : workspace.status !== "ready"
                  ? "Your Workspace storage is still being prepared."
                  : null;
  const attachmentTarget =
    deploymentId && userId
      ? {
          client: hostClient,
          scope: `${deploymentId}/${userId}/home/${workspace.id}`,
          workspaceId: workspace.id,
        }
      : null;

  // A send that ended without handing the message to Home leaves it saved:
  // the Host answered with a Home another device had already started on a
  // different AI, and an unsent message is not one to forget.
  const keepStaged = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The composer's own keeping, before Home has an id to keep it under. The
  // message is on disk before `createHome` is called, so a Home that arrives
  // mid-send — from this creation or from another device — finds it waiting.
  const stagedSends = useMemo(() => {
    const sends = deploymentId && userId ? homeFirstMessageSends({ deploymentId, userId }) : null;
    if (!sends) return null;
    return {
      ...sends,
      clear: (idempotencyKey: string) => {
        if (!keepStaged.current) sends.clear(idempotencyKey);
      },
    };
  }, [deploymentId, userId]);

  /**
   * The Host ensures the one Home in this person's Main Workspace and answers
   * with it, whether it made it or found it. The message is kept against that
   * id before anything sends it, so Home's own composer sends it exactly as
   * written — including the report it quotes. Only then does this intro hand
   * the route over; until it does, the draft, quote and files stay here.
   *
   * A Home another device started may run an AI, a reasoning level or an
   * access mode nobody chose here. Then nothing is sent and nothing is
   * changed: the message stays saved under its own key, and Home names what it
   * is actually running and asks.
   */
  const startHome = async (
    body: string,
    { attachments, content, places, idempotencyKey, quotedMessageId }: ComposerSubmission,
  ) => {
    if (!selection) throw new Error("Choose an AI first.");
    if (!deploymentId || !userId) throw new Error(pendingScopeUnavailable);
    const home = await hostClient.createHome({
      accessMode,
      environmentId: selection.environmentId,
      harnessInstanceId: selection.harnessInstanceId,
      modelSelection: selection.modelSelection,
      workspaceId: workspace.id,
    });
    if (!runsChosenExecution(home, { accessMode, selection }, placements)) {
      keepStaged.current = true;
      setHomeDraft("");
      onCreated(home.id);
      return;
    }
    claimFirstMessage(
      { deploymentId, threadId: home.id, userId },
      {
        attachments,
        body,
        ...(places.length > 0 ? { places } : {}),
        ...(content ? { content } : {}),
        idempotencyKey,
        ...(quotedMessageId ? { quotedMessageId } : {}),
      },
    );
    // Home owes it now, under the same key. The staging record has done its
    // job and must not be left for Home to be handed a second time.
    discardStagedHomeMessage({ deploymentId, userId });
    setHomeDraft("");
    onCreated(home.id);
  };

  return (
    <div className="thread thread--home">
      <AreaHeader hostClient={hostClient} mark={<ChatOrb size={22} />} title={CHAT_THREAD_TITLE} />

      <div className="hero">
        <div className="hero__inner">
          <BrandMark large />
          <h1 className="hero__title">What can I help you with?</h1>
          {runnable.length === 0 ? (
            <p className="hero__subtitle">
              <Link to="/settings/ai-engines">Connect an AI account</Link> to start. Whatever you
              write here is kept while you do.
            </p>
          ) : null}
          <VoiceDock />
          <Composer
            voice={<VoiceButton />}
            dictationScope={`${deploymentId}/${userId}/home/${workspace.id}`}
            inputRef={inputRef}
            placeContext={placeContext}
            variant="conversation"
            settingsRequired={choosable}
            attachments={attachmentTarget}
            autoFocus
            onSend={startHome}
            pendingSends={stagedSends}
            placeholder="Ask Opensteer…"
            onDraftChange={setHomeDraft}
            onHoldingChange={onHolding}
            restore={restore}
            sendBlocked={sendBlocked}
            sendLabel="Send message"
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
                  placements={placements}
                  preferences={executionPreferences}
                  required={choosable}
                  selection={selection}
                />
              </>
            }
          />
          <UsageNotice placements={placements} returnFocusTo={inputRef} selection={selection} />
          {/* A suggestion fills the draft. Sending stays a separate action, so
              nothing is started by reading an example. */}
          <div className="hero__suggestions">
            {suggestions.map((text) => (
              <button
                className="hero__suggestion"
                key={text}
                onClick={() => pushRestore({ text })}
                type="button"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
