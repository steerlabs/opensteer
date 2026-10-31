import {
  accessModeOptions,
  canRespondToRequests,
  accessModeConflict,
  placementForSelection,
  mutationIdempotencyKey,
  resolveExecutionSelection,
  runsChosenExecution,
  sameStableHostSnapshot,
  type ExecutionSelection,
  type HostClient,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import type { ThreadAccessMode } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TextInputInstance } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import type { PendingCommand, ThreadDraftQuote } from "../client/thread-drafts.js";
import type { FirstMessageAttachmentDraftScope } from "../platform/attachment-draft-files.js";
import {
  attachmentKey,
  draftAttachmentPart,
  useDraftAttachments,
} from "../thread/draft-attachments.js";
import {
  claimFirstMessage,
  executionLabel,
  firstMessageBlocker,
  firstMessageExecution,
  FirstMessageComposer,
  FirstMessageExamples,
  FirstMessageHeld,
  FirstMessageInvitation,
  handOverFirstMessage,
} from "../thread/first-message.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { Notice, SecondaryButton } from "../ui/primitives.js";

/**
 * The draft key Home's first message is written under, before Home exists.
 *
 * It is not a Thread id and never reaches the Host: it only files this
 * person's words on this phone so that choosing an account, leaving the screen
 * or relaunching the app does not cost them.
 */
export const homeIntroDraftKey = "home-intro";

/** Two ways to begin, each a sentence the reader can send or edit. */
const examples = [
  {
    label: "Find and compare something",
    text: "Compare three quiet hotels in Kyoto for a weekend trip.",
  },
  {
    label: "Turn an idea into a plan",
    text: "Help me turn these notes into a clear project plan:\n",
  },
] as const;

/**
 * Chat, before there is a Chat.
 *
 * No conversation is invented: this is a real draft and a real choice of which
 * AI runs Home, and the Host creates the one Home only when the first message
 * has both. What was typed and attached here is handed to that Home as the
 * message it owes the Host, so its own composer sends it exactly as written.
 *
 * It is drawn in place on the Chat screen and mounted only once the signed-in
 * person is known, keyed by them: everything it restores is filed under that
 * person on this Deployment, and it is read once, as it mounts.
 */
export function HomeIntro(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  /** Home now holds the first message, or exists and nothing here is owed. */
  readonly onHomeReady: (threadId: string) => void;
  readonly onQuoteTaken: () => void;
  /** An update from a task to answer here, already saved in this draft. */
  readonly quote: ThreadDraftQuote | null;
  readonly userId: string;
  readonly workspaceId: string;
}): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const { snapshot } = useHostSnapshot(props.hostClient, sameIntroSnapshot);
  const { deploymentId, hostClient, onHomeReady, userId, workspaceId } = props;
  const drafts = client.drafts;
  const isCurrentHost = useCallback((): boolean => {
    const current = client.getSnapshot().selection;
    return (
      current.deploymentId === deploymentId &&
      current.hostClient === hostClient &&
      hostClient.getSnapshot().user?.id === userId
    );
  }, [client, deploymentId, hostClient, userId]);
  useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  const draft = drafts.readDraft(deploymentId, userId, homeIntroDraftKey);
  const text = draft?.text ?? "";
  const quote = draft?.quote ?? null;
  const held = drafts.readPending(deploymentId, userId, homeIntroDraftKey);
  const input = useRef<TextInputInstance>(null);
  // The files picked here belong to no Thread yet: they live in this person's
  // own intro scope until the real Home is there to own copies of them.
  const introFiles = useMemo<FirstMessageAttachmentDraftScope>(
    () => ({ deploymentId, kind: "home-intro", userId }),
    [deploymentId, userId],
  );
  // The update this first message answers lives with the shared draft, so it
  // survives leaving this screen and edits made from another mounted view.
  const [sending, setSending] = useState(false);
  // The Home the Host answered with when it is not the AI chosen here: another
  // device started it first. Held separately because the answer can arrive
  // before the snapshot carries that Home.
  const [answered, setAnswered] = useState<ThreadSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const staged = useDraftAttachments({
    client: hostClient,
    draftKey: homeIntroDraftKey,
    drafts,
    files: introFiles,
    workspaceId,
  });

  // A quote handed over while this screen is open. A task files it in Chat's
  // draft once Chat exists, but while this first message is still owed it
  // belongs here: it is moved into this draft, so it survives a relaunch and
  // does not wait in Chat's composer for the message after this one.
  const handedQuote = props.quote;
  const onQuoteTaken = props.onQuoteTaken;
  const quotedHome = snapshot.homeThreadId;
  useEffect(() => {
    if (handedQuote === null) return;
    onQuoteTaken();
    const failed = (): void => setDraftFailure("This quote could not be saved on this phone.");
    void drafts
      .writeDraftQuote(deploymentId, userId, homeIntroDraftKey, handedQuote)
      .then(() =>
        quotedHome === null
          ? undefined
          : drafts.writeDraftQuote(deploymentId, userId, quotedHome, null),
      )
      .catch(failed);
  }, [deploymentId, drafts, handedQuote, onQuoteTaken, quotedHome, userId]);

  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId) ?? null;
  const execution = useMemo(
    () => firstMessageExecution("home", snapshot),
    [snapshot.environments, snapshot.executionPreferences, snapshot.harnesses],
  );
  const { placements, selection: chosen } = execution;

  const homeThreadId = snapshot.homeThreadId;
  // Home can appear while this screen is open — another device, or an earlier
  // send whose answer was lost. With nothing written here there is nothing to
  // keep, so the conversation itself is the right thing to show.
  useEffect(() => {
    if (homeThreadId === null || inFlight.current) return;
    if (held !== null || quote !== null || text.trim() !== "" || staged.items.length > 0) return;
    if (isCurrentHost()) onHomeReady(homeThreadId);
  }, [held, homeThreadId, isCurrentHost, onHomeReady, quote, staged.items.length, text]);

  // The Home that already exists, and whether it runs what was chosen here —
  // account, model, options and access mode alike. A Home another device
  // started on a different one of those is not something to send into without
  // being asked: nothing here changes it, and nothing here starts a second one.
  //
  // The snapshot is authoritative the moment it carries Home; `answered` only
  // stands in for the window between the Host's answer and that arrival.
  const accessMode = snapshot.executionPreferences.accessMode;
  const existingHome =
    snapshot.threads.find(({ id }) => id === (homeThreadId ?? answered?.id)) ?? answered ?? null;
  const conflict =
    existingHome !== null &&
    chosen !== null &&
    !runsChosenExecution(existingHome, { accessMode, selection: chosen }, placements)
      ? existingHome
      : null;
  const conflictPlacement =
    conflict === null
      ? null
      : (placements.find(
          (placement) =>
            placement.environmentId === conflict.environmentId &&
            placement.harnessInstanceId === conflict.harnessInstanceId,
        ) ?? null);
  const conflictLabel =
    conflictPlacement === null
      ? (conflict?.harnessLabel ?? "another AI")
      : `${conflictPlacement.engineName} · ${conflictPlacement.accountName}`;
  // What Home actually runs, named in full: a different model or a different
  // access mode on the same engine is exactly one of the races this catches.
  const conflictRoute =
    conflict === null
      ? null
      : `${conflict.modelLabel} with ${conflictLabel} · ${accessModeLabel(conflict.accessMode)}`;

  const changeText = (next: string): void => {
    void drafts.writeDraft(deploymentId, userId, homeIntroDraftKey, next).then(
      () => setDraftFailure(null),
      () => setDraftFailure("This draft could not be saved on this phone."),
    );
  };

  const removeQuote = (): void => {
    void drafts.writeDraftQuote(deploymentId, userId, homeIntroDraftKey, null).catch(() => {
      setDraftFailure("This quote could not be saved on this phone.");
    });
  };

  const blocker = firstMessageBlocker({
    attachmentsReady: staged.items.every((item) => draftAttachmentPart(item) !== null),
    connected: canRespondToRequests(snapshot),
    conflict:
      conflict === null
        ? null
        : `Chat uses ${conflictRoute}. Send it there, or change what Chat uses.`,
    execution,
    target: "home",
    workspace,
  });

  /**
   * Creates the one Home and hands it this message.
   *
   * The message is written to this phone before the Host is called and stays
   * written until Home holds it, so an answer that never arrives is retried
   * under the same key rather than sent a second time.
   *
   * The Host answers with the one Home whether it made it or found it, so that
   * answer can be a Home another device started on a different AI. Then the
   * message stays written and unsent until somebody says to send it there.
   */
  const send = useCallback(
    async (
      existing: PendingCommand | null,
      acceptExisting = false,
      requestedSelection: ExecutionSelection | null = null,
    ): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setFailure(null);
      try {
        const live = hostClient.getSnapshot();
        const { placements: livePlacements, selection: rememberedSelection } =
          firstMessageExecution("home", live);
        const selection =
          requestedSelection === null
            ? rememberedSelection
            : resolveExecutionSelection(requestedSelection, livePlacements);
        if (selection === null) throw new Error("Choose which AI runs Chat before sending.");
        const placement = placementForSelection(livePlacements, selection);
        const accessReason =
          placement === null
            ? null
            : accessModeConflict(live.executionPreferences.accessMode, placement);
        if (accessReason !== null) throw new Error(accessReason);
        let claimed = existing;
        if (claimed === null) {
          claimed = await claimFirstMessage({
            deploymentId,
            draftKey: homeIntroDraftKey,
            drafts,
            idempotencyKey: mutationIdempotencyKey("message"),
            quote,
            staged,
            text: text.trim(),
            userId,
          });
          changeText("");
          removeQuote();
        }
        // The Host answers with the one Home whether it made it or found it,
        // so a Home another device created takes this message rather than
        // becoming a second one.
        const home = await hostClient.createHome({
          accessMode: live.executionPreferences.accessMode,
          environmentId: selection.environmentId,
          harnessInstanceId: selection.harnessInstanceId,
          modelSelection: selection.modelSelection,
          workspaceId,
        });
        if (
          !acceptExisting &&
          !runsChosenExecution(
            home,
            { accessMode: live.executionPreferences.accessMode, selection },
            livePlacements,
          )
        ) {
          setAnswered(home);
          return;
        }
        await handOverFirstMessage({
          claimed,
          deploymentId,
          draftKey: homeIntroDraftKey,
          drafts,
          files: introFiles,
          threadId: home.id,
          userId,
        });
        if (isCurrentHost()) onHomeReady(home.id);
      } catch (error) {
        setFailure(operationDetail(error, "Chat could not be started."));
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [
      deploymentId,
      drafts,
      hostClient,
      isCurrentHost,
      introFiles,
      onHomeReady,
      quote,
      staged,
      text,
      userId,
      workspaceId,
    ],
  );

  const chooseAI = (pickerAttemptId?: string, conversation?: boolean): void =>
    navigation.navigate("NewThread", {
      deploymentId,
      home: true,
      ...(conversation ? { conversation: true } : {}),
      ...(pickerAttemptId === undefined ? {} : { pickerAttemptId }),
    });
  const empty = text.trim() === "" && held === null && quote === null && staged.items.length === 0;

  return (
    <FirstMessageComposer
      voice
      blocker={blocker}
      held={held !== null}
      execution={execution}
      inputRef={input}
      onChangeText={changeText}
      onChooseAI={chooseAI}
      onRemoveQuote={removeQuote}
      onSend={(selection) => void send(null, false, selection)}
      placeholder="Ask anything…"
      usageScope={{ deploymentId, userId }}
      quote={quote}
      savedAttachmentKeys={draft?.attachments?.map(attachmentKey) ?? []}
      selectionLabel={
        chosen === null && execution.blocked === null
          ? "Choose AI"
          : executionLabel(placements, (chosen ?? execution.blocked)!)
      }
      sending={sending}
      staged={staged}
      text={text}
      underHeader
    >
      <FirstMessageInvitation
        detail="Ask here. Longer work you can follow shows up in Tasks."
        title="What can I help you get done?"
      />
      {empty ? (
        <FirstMessageExamples
          examples={examples}
          onPick={(example) => {
            changeText(example);
            input.current?.focus();
          }}
        />
      ) : null}
      {failure === null ? null : (
        <Notice
          action={{ label: "Dismiss", onPress: () => setFailure(null) }}
          detail={failure}
          title="Chat was not started"
        />
      )}
      {conflict === null ? null : (
        <>
          <Notice
            action={{
              label: `Send it with ${conflictLabel}`,
              onPress: () => void send(held, true),
            }}
            detail={`Chat uses ${conflictRoute}. Your message is saved and has not been sent.`}
            title="Chat is already running"
            tone="neutral"
          />
          {/* Chat's own AI is changed in its settings sheet, where a change
              is reviewed and refused mid-Run. Nothing here is discarded to
              get there: the message stays saved on this phone. */}
          <SecondaryButton
            compact
            label="Change what Chat uses"
            onPress={() =>
              navigation.navigate("ThreadSettings", { deploymentId, threadId: conflict.id })
            }
          />
        </>
      )}
      {draftFailure === null ? null : (
        <Notice detail={draftFailure} title="This draft is not being saved" tone="neutral" />
      )}
      {held === null ? null : (
        <FirstMessageHeld
          // While Chat is running an AI nobody chose here, the notice above is
          // the only way to send: sending it needs naming where.
          onRetry={conflict === null ? () => void send(held) : null}
          sending={sending}
          status={conflict === null ? "Not confirmed yet." : "Saved, not sent."}
          text={held.text}
        />
      )}
    </FirstMessageComposer>
  );
}

/**
 * What the first message reads — Main's readiness, the AI it would start on,
 * the connection, and the Home another device may have made with its access
 * mode — and nothing a token streaming elsewhere changes. It stays mounted
 * under every screen of the Deployment, so this is what keeps it still.
 */
function sameIntroSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    sameStableHostSnapshot(previous, next) &&
    previous.homeThreadId === next.homeThreadId &&
    previous.executionPreferences === next.executionPreferences &&
    (previous.threads === next.threads ||
      previous.threads.every(
        (thread, index) => thread.accessMode === next.threads[index]?.accessMode,
      ))
  );
}

/** An access mode in the product's words, falling back to the protocol's. */
function accessModeLabel(mode: ThreadAccessMode): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}
