import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { provisionalThreadTitle, type BrowserPageContentPart } from "@opensteer/core";
import {
  canRespondToRequests,
  accessModeConflict,
  placementForSelection,
  isHostRefusal,
  mutationIdempotencyKey,
  resolveExecutionSelection,
  sameStableHostSnapshot,
  type HostClient,
  type HostSnapshot,
  type ExecutionSelection,
} from "@opensteer/client/host";
import { useHostSelector, useHostSnapshot } from "@opensteer/client/react";
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
import { ActivityIndicator, StyleSheet, View, type TextInputInstance } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { newTaskDraftKey, type PendingCommand } from "../client/thread-drafts.js";
import type { FirstMessageAttachmentDraftScope } from "../platform/attachment-draft-files.js";
import { color } from "../theme.js";
import {
  attachmentKey,
  draftAttachmentPart,
  forgetDraftFiles,
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
import { beginPendingDelivery, sendPendingMessage } from "../thread/send-pending-message.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { Notice } from "../ui/primitives.js";
import { homeDraftId } from "../home/home-draft.js";

/** Ways to begin, each a sentence the reader can send or edit. */
const examples = [
  {
    label: "Find and compare something",
    text: "Find and compare the best options for this, then write up what you find:\n",
  },
  {
    label: "Plan before changing anything",
    text: "Draft a plan for this before making any changes:\n",
  },
] as const;

const selectUserId = (snapshot: { readonly user: { readonly id: string } | null }) =>
  snapshot.user?.id ?? null;

/**
 * A new task, before it exists: made by its first message, so looking and
 * leaving leaves nothing behind. Drawn as Home, or beside a page on a wider
 * window; both are views of the one Home draft. It mounts only once the
 * signed-in person is known, keyed by them, because its draft is theirs.
 */
export function NewTaskPane(props: {
  readonly autoFocus: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  /**
   * The Host has made the task. Answers whether the reader is now looking at
   * it, whose composer then sends the first message.
   */
  readonly onStarted: (threadId: string) => boolean;
  /** Set where a transparent navigation bar lies over the top of the pane. */
  readonly underHeader: boolean;
  /** Home's composer: with nothing written, its circle starts Voice. */
  readonly voice?: boolean;
}): ReactNode {
  const userId = useHostSelector(props.hostClient, selectUserId);
  if (userId === null) {
    return (
      <View style={styles.waiting}>
        <ActivityIndicator color={color.muted} />
      </View>
    );
  }
  return <NewTask {...props} key={userId} userId={userId} />;
}

function NewTask(props: {
  readonly autoFocus: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly onStarted: (threadId: string) => boolean;
  readonly underHeader: boolean;
  readonly userId: string;
  readonly voice?: boolean;
}): ReactNode {
  const navigation = useNavigation();
  const notifications = useMobileNotifications();
  const client = useMobileClient();
  const drafts = client.drafts;
  const { snapshot } = useHostSnapshot(props.hostClient, sameNewTaskSnapshot);
  const { deploymentId, hostClient, onStarted, userId } = props;
  const draftId = homeDraftId;
  const draftKey = newTaskDraftKey(draftId);
  useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  const draft = drafts.readDraft(deploymentId, userId, draftKey);
  const agentHome = snapshot.personalSettings?.agentHome.path ?? null;
  const text = draft?.text ?? "";
  const held = drafts.readPending(deploymentId, userId, draftKey);
  const input = useRef<TextInputInstance>(null);
  const files = useMemo<FirstMessageAttachmentDraftScope>(
    () => ({ deploymentId, draftId, kind: "new-task", userId }),
    [deploymentId, draftId, userId],
  );
  // The message and task it starts, already handed to the Host under keys it
  // may have accepted, are read from the same draft store as another view.
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const staged = useDraftAttachments({ client: hostClient, draftKey, drafts, files });
  // The page Ask put on this draft, kept with the words until it is sent or removed.
  const includedPage = draft?.page ?? null;

  const execution = useMemo(
    () => firstMessageExecution(snapshot),
    [snapshot.environments, snapshot.executionPreferences, snapshot.harnesses],
  );
  const { placements, selection } = execution;
  const blocker = firstMessageBlocker({
    attachmentsReady: staged.items.every((item) => draftAttachmentPart(item) !== null),
    connected: canRespondToRequests(snapshot),
    execution,
  });

  const changeText = (next: string): void => {
    void drafts.writeDraft(deploymentId, userId, draftKey, next).then(
      () => setDraftFailure(null),
      () => setDraftFailure("This draft could not be saved on this phone."),
    );
  };
  const changePage = (next: BrowserPageContentPart | null): void => {
    void drafts.writeDraftPage(deploymentId, userId, draftKey, next).then(
      () => setDraftFailure(null),
      () => setDraftFailure("This page could not be saved on this phone."),
    );
  };

  /**
   * Makes the task and hands it this message.
   *
   * The message and the command that makes the task are written to this phone
   * together, before the Host is asked, and stay written until the task holds
   * the message. A retry repeats both under their own keys, so an answer that
   * was lost is answered with the task the Host already made.
   */
  const aiSharing = useAiSharing();
  const send = useCallback(
    async (
      existing: PendingCommand | null,
      requestedSelection: ExecutionSelection | null = null,
    ): Promise<void> => {
      if (inFlight.current) return;
      if (!(await authorizeAiSharing(aiSharing, hostClient))) return;
      if (!mounted.current || inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setFailure(null);
      let claimed = existing;
      try {
        if (claimed === null) {
          const live = hostClient.getSnapshot();
          const liveExecution = firstMessageExecution(live);
          const chosen =
            requestedSelection === null
              ? liveExecution.selection
              : resolveExecutionSelection(requestedSelection, liveExecution.placements);
          if (chosen === null) throw new Error("Choose which AI runs this task before sending.");
          const placement = placementForSelection(liveExecution.placements, chosen);
          const accessReason =
            placement === null
              ? null
              : accessModeConflict(live.executionPreferences.accessMode, placement);
          if (accessReason !== null) throw new Error(accessReason);
          const words = text.trim();
          claimed = await claimFirstMessage({
            browserPage: includedPage,
            deploymentId,
            draftKey,
            drafts,
            idempotencyKey: mutationIdempotencyKey("message"),
            quote: null,
            staged,
            start: {
              accessMode: live.executionPreferences.accessMode,
              environmentId: chosen.environmentId,
              harnessInstanceId: chosen.harnessInstanceId,
              modelSelection: chosen.modelSelection,
              idempotencyKey: mutationIdempotencyKey("thread"),
              generateTitle: true,
              title: provisionalThreadTitle(words || (staged.items[0]?.name ?? "")),
            },
            text: words,
            userId,
          });
          changeText("");
        }
        const start = claimed.start;
        if (start === undefined)
          throw new Error("This message no longer says which task it starts.");
        const { generateTitle, ...creation } = start;
        const thread = await hostClient.createThread({
          ...creation,
          ...(generateTitle ? { generateTitle: true } : {}),
        });
        let opened = false;
        const owed = await handOverFirstMessage({
          claimed,
          deploymentId,
          draftKey,
          drafts,
          files,
          onReady: () => {
            const active = client.getSnapshot().selection;
            opened =
              mounted.current &&
              active.deploymentId === deploymentId &&
              active.hostClient === hostClient &&
              hostClient.getSnapshot().user?.id === userId &&
              onStarted(thread.id);
          },
          threadId: thread.id,
          userId,
        });
        if (opened) return;
        // The reader left while the task was being made, so no composer is
        // about to send this. It goes now, under the key it was claimed with;
        // if it cannot, it stays owed and the task's composer sends it when
        // the task is next opened.
        const finishDelivery = beginPendingDelivery(drafts, deploymentId, userId, owed);
        if (finishDelivery === null) return;
        try {
          if (
            !(await sendPendingMessage(
              hostClient,
              owed,
              () => authorizeAiSharing(aiSharing, hostClient),
              notifications.registration,
            ))
          )
            return;
          const cleared = await drafts.clearPending(
            deploymentId,
            userId,
            thread.id,
            owed.idempotencyKey,
          );
          if (cleared) {
            forgetDraftFiles({ deploymentId, threadId: thread.id, userId }, owed.localUris ?? []);
          }
        } finally {
          finishDelivery();
        }
      } catch (error) {
        // Only a screen still here can take the message back as a draft; one
        // that has gone leaves it held, and the next visit shows it.
        if (claimed !== null && isHostRefusal(error) && mounted.current) {
          // The Host said no, so no task was made: the message goes back to
          // being a draft, to be changed and sent anew under new keys.
          const refused = claimed;
          await drafts.clearPending(deploymentId, userId, draftKey, refused.idempotencyKey).then(
            (cleared) => {
              if (!cleared) return;
              changeText(refused.text);
              if (refused.browserPage !== undefined) changePage(refused.browserPage);
              staged.restore(
                (refused.attachments ?? []).map((part, index) => ({
                  localUri: refused.localUris?.[index] ?? null,
                  part,
                })),
              );
            },
            () => undefined,
          );
        }
        setFailure(operationDetail(error, "The task could not be started."));
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [
      aiSharing,
      client,
      deploymentId,
      draftKey,
      drafts,
      files,
      hostClient,
      includedPage,
      notifications,
      onStarted,
      staged,
      text,
      userId,
    ],
  );

  const empty = text.trim() === "" && held === null && staged.items.length === 0;

  return (
    <FirstMessageComposer
      autoFocus={props.autoFocus}
      blocker={blocker}
      voice={props.voice === true}
      held={held !== null}
      execution={execution}
      inputRef={input}
      onChangeText={changeText}
      onChooseAI={(pickerAttemptId, conversation) =>
        navigation.navigate("NewThread", {
          ...(conversation ? { conversation: true } : {}),
          deploymentId,
          ...(pickerAttemptId === undefined ? {} : { pickerAttemptId }),
        })
      }
      onRemoveQuote={noop}
      onSend={(selection) => void send(null, selection)}
      page={includedPage === null ? null : { onRemove: () => changePage(null), part: includedPage }}
      placeholder="Ask your agent to…"
      usageScope={{ deploymentId, userId }}
      quote={null}
      savedAttachmentKeys={draft?.attachments?.map(attachmentKey) ?? []}
      selectionLabel={
        selection === null && execution.blocked === null
          ? "Choose AI"
          : executionLabel(placements, (selection ?? execution.blocked)!)
      }
      sending={sending}
      staged={staged}
      text={text}
      underHeader={props.underHeader}
    >
      <FirstMessageInvitation
        detail={
          agentHome === null
            ? "Your agent works on this computer."
            : `Your agent works on this computer, in ${agentHome}.`
        }
        title="What should your agent do?"
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
          title="The task was not started"
        />
      )}
      {draftFailure === null ? null : (
        <Notice detail={draftFailure} title="This draft is not being saved" tone="neutral" />
      )}
      {held === null ? null : (
        <FirstMessageHeld
          onRetry={() => void send(held)}
          sending={sending}
          status="Not confirmed yet."
          text={held.text}
        />
      )}
    </FirstMessageComposer>
  );
}

function noop(): void {}

/**
 * What a new task reads — Agent home, the AI it would start on and whether
 * the Host can take it — and nothing a streamed token elsewhere changes.
 */
function sameNewTaskSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    sameStableHostSnapshot(previous, next) &&
    previous.executionPreferences === next.executionPreferences &&
    previous.personalSettings === next.personalSettings
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: "center", flex: 1, justifyContent: "center" },
});
