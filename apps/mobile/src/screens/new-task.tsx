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
import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
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
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useThreadHeader } from "./thread-header.js";

export type NewTaskScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /** Main for a task from Tasks; a specialist's own Workspace from its page. */
  readonly workspaceId: string;
}>;

/** Two ways to begin a task, each a sentence the reader can send or edit. */
const examples = [
  {
    label: "Research something and write it up",
    text: "Research the best options for this and write up what you find:\n",
  },
  {
    label: "Plan before changing anything",
    text: "Draft a plan for this before making any changes:\n",
  },
] as const;

/**
 * A new task, before it exists.
 *
 * The task is made by its first message, as on the web: nothing is created by
 * opening this screen, so looking and leaving leaves nothing behind, and the
 * task is named from what it was asked to do. Once the Host has made it, the
 * task's own screen takes this one's place — Back still returns to where New
 * task was opened from.
 */
export function NewTaskScreen(props: NewTaskScreenProps): ReactNode {
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const { deploymentId, workspaceId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useThreadHeader({
    deploymentId,
    fallbackTitle: "New task",
    header: null,
    hostClient,
    threadId: null,
  });
  const onStarted = useCallback(
    (threadId: string): boolean => {
      // Left while the task was being made: there is no screen to replace.
      if (!navigation.isFocused()) return false;
      // The keyboard goes down with the screen it was typed on; the task
      // appears in its place with the message on its way.
      Keyboard.dismiss();
      navigation.dispatch(
        StackActions.replace("Thread", { deploymentId, started: true, threadId }),
      );
      return true;
    },
    [deploymentId, navigation],
  );

  if (hostClient === null) {
    return <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />;
  }
  return (
    <Screen edgeToEdge>
      <NewTaskPane
        autoFocus
        deploymentId={deploymentId}
        hostClient={hostClient}
        key={`${deploymentId}:${workspaceId}`}
        onStarted={onStarted}
        underHeader
        workspaceId={workspaceId}
      />
    </Screen>
  );
}

const selectUserId = (snapshot: { readonly user: { readonly id: string } | null }) =>
  snapshot.user?.id ?? null;

/**
 * The new task itself, wherever it is drawn: its own screen on a phone, the
 * detail beside Tasks on a wider window. It mounts only once the signed-in
 * person is known, keyed by them, because its draft is theirs.
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
  readonly workspaceId: string;
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
  readonly workspaceId: string;
}): ReactNode {
  const navigation = useNavigation();
  const notifications = useMobileNotifications();
  const client = useMobileClient();
  const drafts = client.drafts;
  const { snapshot } = useHostSnapshot(props.hostClient, sameNewTaskSnapshot);
  const { deploymentId, hostClient, onStarted, userId, workspaceId } = props;
  const draftKey = newTaskDraftKey(workspaceId);
  useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  const draft = drafts.readDraft(deploymentId, userId, draftKey);
  const text = draft?.text ?? "";
  const held = drafts.readPending(deploymentId, userId, draftKey);
  const input = useRef<TextInputInstance>(null);
  const files = useMemo<FirstMessageAttachmentDraftScope>(
    () => ({ deploymentId, kind: "new-task", userId, workspaceId }),
    [deploymentId, userId, workspaceId],
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
  const staged = useDraftAttachments({ client: hostClient, draftKey, drafts, files, workspaceId });
  // The page Ask put on this draft, kept with the words until it is sent or removed.
  const includedPage = draft?.page ?? null;

  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId) ?? null;
  const execution = useMemo(
    () => firstMessageExecution("task", snapshot),
    [snapshot.environments, snapshot.executionPreferences, snapshot.harnesses],
  );
  const { placements, selection } = execution;
  const blocker = firstMessageBlocker({
    attachmentsReady: staged.items.every((item) => draftAttachmentPart(item) !== null),
    connected: canRespondToRequests(snapshot),
    conflict: null,
    execution,
    target: "task",
    workspace,
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
  const send = useCallback(
    async (
      existing: PendingCommand | null,
      requestedSelection: ExecutionSelection | null = null,
    ): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setFailure(null);
      let claimed = existing;
      try {
        if (claimed === null) {
          const live = hostClient.getSnapshot();
          const liveExecution = firstMessageExecution("task", live);
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
              workspaceId,
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
          await sendPendingMessage(hostClient, owed, notifications.registration);
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
      workspaceId,
    ],
  );

  const specialist = workspace !== null && workspace.kind === "specialized" ? workspace : null;
  const empty = text.trim() === "" && held === null && staged.items.length === 0;

  return (
    <FirstMessageComposer
      autoFocus={props.autoFocus}
      blocker={blocker}
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
      placeholder="Describe the task…"
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
          specialist === null
            ? "It runs as its own task, apart from Chat, and you can follow it in Tasks."
            : "It works with this specialist’s own files, instructions and access."
        }
        title={
          specialist === null
            ? "What should this task take care of?"
            : `What should ${specialist.name} take care of?`
        }
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
 * What a new task reads — its Workspace, the AI it would start on and whether
 * the Host can take it — and nothing a streamed token elsewhere changes.
 */
function sameNewTaskSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return (
    sameStableHostSnapshot(previous, next) &&
    previous.executionPreferences === next.executionPreferences
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: "center", flex: 1, justifyContent: "center" },
});
