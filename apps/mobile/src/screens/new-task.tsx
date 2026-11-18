import { clientIssue } from "@opensteer/client/feedback";
import { useClientConnection } from "@opensteer/client/react";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { issueLine } from "../ui/client-feedback.js";
import { notSentIssue } from "../ui/connection-live.js";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { provisionalThreadTitle, type BrowserPageContentPart, type UserId } from "@opensteer/core";
import {
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
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootParamList } from "../navigation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ComposerEditorHandle } from "@opensteer/client/references";
import * as Haptics from "expo-haptics";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { newTaskDraftKey, type TaskStartRecord } from "../client/thread-drafts.js";
import type { FirstMessageAttachmentDraftScope } from "../platform/attachment-draft-files.js";
import { color, space } from "../theme.js";
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
  FirstMessageInvitation,
  handOverFirstMessage,
} from "../thread/first-message.js";
import { FirstMessageStarted, type FirstMessageSent } from "../thread/first-message-started.js";
import { dismissKeyboard } from "../ui/composer-editor.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { bubbleSettleMs, exit } from "../ui/motion.js";
import { Notice } from "../ui/primitives.js";
import { homeDraftId } from "../home/home-draft.js";
import { delay } from "@opensteer/shared/delay";

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

const selectUserId = (snapshot: { readonly user: { readonly id: UserId } | null }) =>
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
  readonly userId: UserId;
  readonly voice?: boolean;
}): ReactNode {
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
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
  const held = drafts.readTaskStart(deploymentId, userId, draftKey);
  const input = useRef<ComposerEditorHandle>(null);
  const files = useMemo<FirstMessageAttachmentDraftScope>(
    () => ({ deploymentId, draftId, kind: "new-task", userId }),
    [deploymentId, draftId, userId],
  );
  // The message and task it starts, already handed to the Host under keys it
  // may have accepted, are read from the same draft store as another view.
  const [sending, setSending] = useState(false);
  // What was sent, from the moment Send is pressed until this screen is out
  // of sight: before it is written down, then held, then while the task fades
  // in over it, so nothing under the fade goes back to the invitation.
  const [starting, setStarting] = useState<FirstMessageSent | null>(null);
  const [handedOff, setHandedOff] = useState<FirstMessageSent | null>(null);
  const sentAt = useRef(0);
  const keyboardDown = useRef<Promise<void>>(Promise.resolve());
  const reduceMotion = useReducedMotion();
  // What Send came to when no task was started: said above the composer,
  // with the draft kept, until the words change or Send is pressed again.
  const [line, setLine] = useState<ActionLineValue | null>(null);
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
    execution,
  });

  const changeText = (next: string): void => {
    setLine(null);
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
      existing: TaskStartRecord | null,
      requestedSelection: ExecutionSelection | null = null,
    ): Promise<void> => {
      if (inFlight.current) return;
      // Offline a new task isn't started: nothing is written down or sent,
      // and the draft stays where it is.
      const unsent = existing === null ? notSentIssue(hostClient, "started") : null;
      if (unsent !== null) {
        setLine(issueLine(unsent, `not-started:${Date.now()}`));
        return;
      }
      // The field's last keystroke can still be on its way to React: read what it holds now.
      const field = input.current;
      let words = text.trim();
      if (existing === null && field !== null) {
        const flushed = await field
          .flushPendingInput(field.readSnapshot().generation)
          .catch(() => null);
        if (flushed === null || flushed.composing) return;
        words = flushed.text.trim();
      }
      if (!(await authorizeAiSharing(aiSharing, hostClient))) return;
      if (!mounted.current || inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setLine(null);
      let claimed = existing;
      try {
        if (claimed === null) {
          const live = hostClient.getSnapshot();
          const liveExecution = firstMessageExecution(live);
          const chosen =
            requestedSelection === null
              ? liveExecution.selection
              : resolveExecutionSelection(requestedSelection, liveExecution.placements);
          if (chosen === null)
            throw new NotStarted("Choose which AI runs this task before sending.");
          const placement = placementForSelection(liveExecution.placements, chosen);
          const accessReason =
            placement === null
              ? null
              : accessModeConflict(live.executionPreferences.accessMode, placement);
          if (accessReason !== null) throw new NotStarted(accessReason);
          const idempotencyKey = mutationIdempotencyKey("message");
          const attachments = staged.items.flatMap((item) => {
            const part = draftAttachmentPart(item);
            return part === null ? [] : [part];
          });
          // Seen and felt as Send is pressed: the screen turns into the task
          // it starts while the phone writes it down and the Host makes it.
          setStarting({
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(includedPage === null ? {} : { browserPage: includedPage }),
            idempotencyKey,
            text: words,
          });
          sentAt.current = Date.now();
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          keyboardDown.current = dismissKeyboard();
          // Emptied on screen only: the saved draft keeps the words until the
          // message holding them is written down. Reset, so a keystroke still
          // on its way from the field cannot refill it.
          const emptied = (field?.readSnapshot().generation ?? 0) + 1;
          field?.restore({
            composing: false,
            generation: emptied,
            selection: { start: 0, end: 0 },
            text: "",
          });
          claimed = await claimFirstMessage({
            browserPage: includedPage,
            deploymentId,
            draftKey,
            drafts,
            idempotencyKey,
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
          }).catch((error: unknown) => {
            // Not written down, so not sent: the words are back in the field.
            field?.restore({
              composing: false,
              generation: emptied + 1,
              selection: { start: words.length, end: words.length },
              text: words,
            });
            throw error;
          });
          changeText("");
        } else {
          sentAt.current = Date.now();
          keyboardDown.current = dismissKeyboard();
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
        await handOverFirstMessage({
          hostClient,
          claimed,
          deploymentId,
          draftKey,
          drafts,
          files,
          onReady: async () => {
            // The task takes over only once what was sent has settled where
            // the task draws it and the keyboard is down, so its first frame
            // is this one's last.
            const rising = reduceMotion ? 0 : sentAt.current + bubbleSettleMs - Date.now();
            await Promise.all([keyboardDown.current, rising > 0 ? delay(rising) : undefined]);
            const active = client.getSnapshot().selection;
            const shown = drafts.readTaskStart(deploymentId, userId, draftKey);
            opened =
              mounted.current &&
              active.deploymentId === deploymentId &&
              active.hostClient === hostClient &&
              hostClient.getSnapshot().user?.id === userId &&
              onStarted(thread.id);
            if (opened && shown !== null) setHandedOff(shown);
          },
          threadId: thread.id,
          userId,
        });
      } catch (error) {
        // Only a screen still here can take the message back as a draft; one
        // that has gone leaves it held, and the next visit shows it.
        if (claimed !== null && isHostRefusal(error) && mounted.current) {
          // The Host said no, so no task was made: the message goes back to
          // being a draft, to be changed and sent anew under new keys.
          const refused = claimed;
          await drafts.clearTaskStart(deploymentId, userId, draftKey, refused.idempotencyKey).then(
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
        // A refusal or a reason of this screen's own is said; an answer that
        // was lost leaves the message held, waiting to go once it can.
        if (mounted.current) {
          const key = `start:${Date.now()}`;
          if (error instanceof NotStarted)
            setLine({ key, text: error.words, tone: "muted", haptic: "warning" });
          else if (claimed === null) setLine(issueLine({ code: "storage-unavailable" }, key));
          else if (isHostRefusal(error)) {
            const issue = clientIssue(error, { operation: "action", label: "start this task" });
            if (issue !== null) setLine(issueLine({ ...issue, done: "started" }, key));
          }
        }
      } finally {
        inFlight.current = false;
        setSending(false);
        // Written down by now, or refused and back in the field.
        setStarting(null);
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
      onStarted,
      reduceMotion,
      staged,
      text,
      userId,
    ],
  );

  // A message already handed over under its keys goes on by itself: on
  // arrival, and each time the connection is ready again.
  const { phase, readyRevision } = useClientConnection(hostClient.connection);
  const resume = useRef(send);
  resume.current = send;
  const heldKey = held?.idempotencyKey ?? null;
  useEffect(() => {
    if (heldKey === null || phase !== "ready") return;
    const record = drafts.readTaskStart(deploymentId, userId, draftKey);
    if (record !== null) void resume.current(record);
  }, [deploymentId, draftKey, drafts, heldKey, phase, readyRevision, userId]);

  // Once the task has faded in over this screen, it is Home again underneath.
  useEffect(() => {
    if (handedOff === null) return;
    const settle = () => setHandedOff(null);
    const ended = navigation.addListener("transitionEnd", settle);
    const back = navigation.addListener("focus", settle);
    return () => {
      ended();
      back();
    };
  }, [handedOff, navigation]);

  const sent = held ?? starting ?? handedOff;
  const empty = text.trim() === "" && sent === null && staged.items.length === 0;

  return (
    <FirstMessageComposer
      autoFocus={props.autoFocus}
      blocker={blocker}
      voice={props.voice === true}
      onVoiceLine={setLine}
      held={held !== null}
      execution={execution}
      hostClient={hostClient}
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
      started={sent !== null}
      // While what was sent is being written down, the draft still holds it.
      text={starting === null ? text : ""}
      underHeader={props.underHeader}
    >
      {sent !== null ? (
        <FirstMessageStarted
          hostClient={hostClient}
          key={sent.idempotencyKey}
          message={sent}
          phase={sending || held === null ? "sending" : "waiting"}
          userId={userId}
        />
      ) : (
        <Animated.View exiting={exit} style={styles.invitation}>
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
          {line === null ? null : (
            <ActionLine line={line} numberOfLines={2} onDismiss={() => setLine(null)} />
          )}
          {draftFailure === null ? null : (
            <Notice detail={draftFailure} title="This draft is not being saved" tone="neutral" />
          )}
        </Animated.View>
      )}
    </FirstMessageComposer>
  );
}

function noop(): void {}

/** A reason this screen itself has for not starting the task; nothing was written down. */
class NotStarted extends Error {
  readonly words: string;
  constructor(words: string) {
    super(words);
    this.words = words;
  }
}

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
  // The composer's content keeps its own gap between the invitation's parts.
  invitation: { gap: space[16] },
  waiting: { alignItems: "center", flex: 1, justifyContent: "center" },
});
