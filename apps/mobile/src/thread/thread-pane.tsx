import { useThreadTranscript } from "@opensteer/client/react";
import {
  hostMessageOutbox,
  messageDeliveryStatusShown,
  splitLocalMessages,
  type MessageDeliveryAction,
} from "@opensteer/client/host";
import { presentMessageActionFailure, presentMessageTakeBack } from "@opensteer/client/feedback";
import { useClientConnection, useOutboxTranscript } from "@opensteer/client/react";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { issueLine } from "../ui/client-feedback.js";
import { useConnectionReady, useShowsLive } from "../ui/connection-live.js";
import { ConnectionRouteGate } from "../ui/route-gate.js";
import { UnavailableState } from "../ui/unavailable-state.js";
import { MessageDeliveryContext, type MessageDeliveryControls } from "./message-delivery.js";
import { TranscriptImageContext } from "@opensteer/client/react";
import { readTail, type TailReading } from "@opensteer/shared/tailFollow";
import { useThreadVisits } from "@opensteer/client/react";
import {
  messageAuthorName,
  conversationActivityTurn,
  conversationActivities,
  conversationPlaces,
  conversationRows,
  conversationTurnRevealing,
  groupTranscriptEntries,
  passwordsSetupOffer,
  incomingTranscriptMessages,
  observedSequence,
  threadActivity,
  threadActivityIndicator,
  threadPlacementOptions,
  threadComposerPlaceholder,
  threadStartHold,
  threadRequester,
  threadStartsRunForMessage,
  threadStopTarget,
  transcriptVoice,
  turnFolds,
  turnWords,
  usageLimitNotice,
  visibleTranscript,
  withoutOwnAssignment,
  type BrowserTabDestination,
  type HostClient,
  type HostSnapshot,
  type ConversationRow,
  type MessageEntry,
  type RequesterLink,
  type TabDestination,
  type ThreadActivityIndicator,
  type TranscriptGroup,
  type TranscriptVoice,
  type ThreadSummary,
  type WaitingInput,
} from "@opensteer/client/host";
import { computerUseNowSummary, threadComputerUseNow } from "@opensteer/client/integrations";
import type { BrowserPageContentPart } from "@opensteer/core";
import { useHostSnapshot, useWaitingInputs } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import { conversationActions } from "./conversation-actions.js";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from "react-native";
import Animated from "react-native-reanimated";
import { canRespondToRequests } from "@opensteer/client/host";
import type { ThreadDraftQuote } from "../client/thread-drafts.js";
import type { ArtifactContentPart, ContentPart } from "@opensteer/core";
import { useOpenPlace, useShowTab } from "../tabs/viewer-open.js";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { useAppForeground } from "../ui/foreground.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { useContentInsets, usePaneInView } from "../ui/pane.js";
import { useGutter, useReadingColumn } from "../ui/screen.js";
import { TaskScopeContext, ThreadMark, type TaskScope } from "./task-line.js";
import {
  sameTaskHeading,
  sameTaskOutcomes,
  TaskOutcomeLine,
  taskHeading,
  taskOutcomes,
  type TaskHeading,
  type TaskOutcome,
} from "./task-status.js";
import { WaitingQuestions } from "./waiting-questions.js";
import { ThreadServerApprovals } from "../computers/computer-app-approval.js";
import {
  TranscriptAppTabsContext,
  TranscriptSurfacesContext,
  type TranscriptAppTabs,
  type TranscriptSurfaces,
} from "./surface-chips.js";
import { TranscriptHostClientContext } from "./attachment-views.js";
import { AgentSessionPane, useSessionTask } from "./agent-session.js";
import { Composer } from "./composer.js";
import { ConversationLinksProvider } from "./conversation-links.js";
import { PersonalReferenceProvider } from "../markdown/reference-navigation.js";
import { ComposerDockLayout, DockScrollView, OverDock } from "./composer-dock.js";
import { AgentEngine } from "./agent-mark.js";
import { AgentListNestedContext, AgentMemoryContext } from "./subagent-rows.js";
import { RunningNowCapsule } from "./running-now.js";
import { RunPageSlot } from "./run-page.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";
import { useWaitingEdit } from "./waiting-edit.js";
import { WaitingEditBar } from "./waiting-dock.js";
import { AnswerPill } from "./answer-pill.js";
import { WaitingInputs } from "./waiting-inputs.js";
import { pillRowClearance } from "../ui/pill-metrics.js";
import {
  TranscriptComputersContext,
  computerLine,
  useKeptComputerStop,
  type TranscriptComputers,
} from "./computer-use-line.js";
import { VoiceDock } from "../voice/controls.js";
import { VoiceStartBar } from "../voice/start-bar.js";
import { useVoiceAskedRequest, useVoiceOn } from "../voice/use-voice-value.js";
import { useSidebarVisible } from "../sidebar/sidebar-context.js";
import { settingsDisabledReason } from "./settings/settings-controller.js";
import {
  TranscriptGroupRow,
  WorkingIndicator,
  replyActivityKeys,
  transcriptSpacing,
} from "./transcript.js";
import { bubble } from "./bubble.js";
import type { ThreadMutationOwner } from "./thread-mutation-gate.js";
import { useThreadMutation } from "./thread-mutation-registry.js";
import { UsageNotice } from "./usage-notice.js";

/**
 * One Thread: its transcript, and the surface that answers it.
 *
 * The list stays pinned to the newest entry only while the reader is already
 * there. Scrolling up during a run is a decision, and nothing yanks it back —
 * a pill appears instead, and the reader returns when they choose to.
 */

type TranscriptItem =
  | {
      /** In a conversation, the Activity this row's reply opens, or null. */
      readonly activityKey: string | null;
      /** The next row carries on from this one, so the tail belongs to that row. */
      readonly continued: boolean;
      readonly group: TranscriptGroup;
      readonly key: string;
      readonly kind: "group";
      /** A task this Thread was doing that ended with this turn, said under it. */
      readonly outcome: TaskOutcome | null;
      /** The air above this row, decided from what spoke before it. */
      readonly spacingTop: number;
      /** When this row was said, where a pause has passed in a conversation. */
      readonly time: string | null;
    }
  | { readonly indicator: ThreadActivityIndicator; readonly key: string; readonly kind: "working" };

/**
 * What the navigation bar says about this Thread: primitives only, so a header
 * that has not changed does not rebuild, and a streamed token never reaches the
 * bar at all.
 */
export interface ThreadHeaderState {
  readonly connectionLabel: string | null;
  readonly title: string;
  readonly icon: ThreadSummary["icon"];
  readonly color: ThreadSummary["color"];
  readonly isVoice: boolean;
  /** The work this Thread is doing for another conversation, or null. */
  readonly task: TaskHeading | null;
}

export function sameThreadHeader(
  left: ThreadHeaderState | null,
  right: ThreadHeaderState,
): boolean {
  return (
    left !== null &&
    left.connectionLabel === right.connectionLabel &&
    left.title === right.title &&
    left.icon === right.icon &&
    left.color === right.color &&
    left.isVoice === right.isVoice &&
    sameTaskHeading(left.task, right.task)
  );
}

interface ThreadPaneProps {
  readonly deploymentId: string;
  /**
   * Points at the top of the pane covered by a floating header, such as the
   * title over a conversation beside a page. The transcript starts below it
   * and scrolls under it. Left out, the screen's own navigation bar decides.
   */
  readonly headerClearance?: number;
  readonly hostClient: HostClient;
  /**
   * The exact update this screen was opened for, when a notification or link
   * named one. The transcript is loaded around it and the reader is left
   * there, rather than at whatever happens to be newest.
   */
  readonly messageId?: string | null;
  /**
   * Clears the anchor the screen was opened with, once the reader has left the
   * window it loaded. Without it the same id would be read as a fresh jump and
   * pull them straight back out of the live conversation.
   */
  readonly onAnchorReleased?: (() => void) | undefined;
  /** Opens another Thread on this deployment: a delegation, or a sender. */
  readonly onOpenThread: (threadId: string) => void;
  /**
   * Takes the reader away from a task that isn't on its Host, removed here or
   * on another device or never there, once the pane is in front of them.
   */
  readonly onGone: () => void;
  /** What the navigation bar should say, when there is one to say it. */
  readonly onHeader?: (header: ThreadHeaderState) => void;
  readonly requestId: string | null;
  /**
   * Drawn in a column beside a page, Mac app or phone rather than as its own
   * screen. The page is what the composer includes with the next message.
   */
  readonly withPage?: PageCompanion | undefined;
  readonly threadId: string;
}

/** The page in front of a conversation drawn beside it, or null for one with no web address. */
export interface PageCompanion {
  readonly page: BrowserPageContentPart | null;
  /**
   * Shows another browser tab in that page, in place, while it is a browser
   * tab: the conversation stays where it is, and following picks up there.
   */
  readonly showTab: ((tab: BrowserTabDestination) => void) | null;
}

/** The pane's complete read set; maps and run entries are scoped to this Thread. */
function selectThreadPane(snapshot: HostSnapshot, threadId: string) {
  return {
    assignments: snapshot.assignments,
    browserSessions: snapshot.browserSessions,
    browserProfiles: snapshot.browserProfiles,
    connection: snapshot.connection,
    connectionInterrupted: snapshot.connectionInterrupted,
    network: snapshot.network,
    session: snapshot.session,
    user: snapshot.user,
    voiceThreadId: snapshot.voiceThreadId,
    environments: snapshot.environments,
    harnesses: snapshot.harnesses,
    machines: snapshot.machines,
    waitingRequests: snapshot.waitingRequests,
    thread: snapshot.threads.find(({ id }) => id === threadId) ?? null,
    lookup: snapshot.threadLookups[threadId],
    // These helpers read requester/worker Threads and delegated work. Select their
    // answers against the full store so unrelated transcript maps cannot go stale.
    task: taskHeading(snapshot, threadId),
    outcomes: taskOutcomes(snapshot, threadId),
    requester: threadRequester(snapshot, threadId),
  };
}

type ThreadPaneSelection = ReturnType<typeof selectThreadPane>;

function sameThreadPaneSelection(left: ThreadPaneSelection, right: ThreadPaneSelection): boolean {
  return (Object.keys(left) as (keyof ThreadPaneSelection)[]).every((key) => {
    switch (key) {
      case "task":
        return sameTaskHeading(left.task, right.task);
      case "outcomes":
        return sameTaskOutcomes(left.outcomes, right.outcomes);
      case "requester":
        return (
          left.requester?.threadId === right.requester?.threadId &&
          left.requester?.title === right.requester?.title
        );
      default:
        return left[key] === right[key];
    }
  });
}

export function ThreadPane(props: ThreadPaneProps): ReactNode {
  const threadId = props.threadId;
  const select = useMemo(() => {
    const selections = new WeakMap<HostSnapshot, ThreadPaneSelection>();
    return (snapshot: HostSnapshot): ThreadPaneSelection => {
      const held = selections.get(snapshot);
      if (held !== undefined) return held;
      const next = selectThreadPane(snapshot, threadId);
      selections.set(snapshot, next);
      return next;
    };
  }, [threadId]);
  const isEqual = useCallback(
    (left: HostSnapshot, right: HostSnapshot) =>
      sameThreadPaneSelection(select(left), select(right)),
    [select],
  );
  const state = useHostSnapshot(props.hostClient, isEqual);
  const selection = useMemo(() => select(state.snapshot), [select, state.snapshot]);
  // A connected agent's own task: its activity and the agent's state, with no composer.
  const session = useSessionTask(props.hostClient, threadId);
  if (session !== null)
    return (
      <AgentSessionPane
        hostClient={props.hostClient}
        onHeader={props.onHeader}
        threadId={threadId}
        title={selection.thread?.title.trim() || session.agent.name}
        view={session}
      />
    );
  return (
    <ThreadPaneForUser
      {...props}
      key={`${props.deploymentId}:${state.snapshot.user?.id ?? "signed-out"}:${props.threadId}`}
      snapshot={selection}
    />
  );
}

function ThreadPaneForUser(
  props: ThreadPaneProps & { readonly snapshot: ThreadPaneSelection },
): ReactNode {
  const client = useMobileClient();
  const navigation = useNavigation();
  const notifications = useMobileNotifications();
  const gutter = useGutter();
  const column = useReadingColumn();
  // The pane's own insets: a notch, the vertical bar or a reserved region can
  // stand at either side, so each side keeps its own as well as the gutter.
  const insets = useContentInsets();
  const sides = { paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right };
  // The transcript scrolls under a transparent bar, so its own content needs
  // the bar's height at the top. It is stated as padding on every platform:
  // iOS's automatic inset adjustment does not reach a list whose screen has
  // native bar items and a transparent bar, and left the first message under
  // the bar.
  const headerHeight = useHeaderHeight();
  const { snapshot } = props;
  const viewerUserId = snapshot.user?.id ?? null;
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  // Whether the list follows the newest entry, and where it stood when last read or moved.
  const tail = useRef<TailReading>({ follows: true, offset: 0 });
  const seenSequence = useRef<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState(0);
  // The reader's own scrolling: a finger on the list, and the fling it
  // releases. Only these decide whether they are reading back. They are kept
  // apart because iOS reports the end of a jump the app made itself as the end
  // of a fling, which must not end a drag still under the finger.
  const dragging = useRef(false);
  const flinging = useRef(false);
  // The list's real extent, as the native scroll view reports it. FlatList's
  // own `scrollToEnd` aims at the last row's estimated place and leaves out
  // the content's padding and the keyboard's inset, so until every row above
  // has been measured it stops short of the newest entry; these never do.
  const extent = useRef({ content: 0, inset: 0, viewport: 0 });
  const scrollToLatest = useCallback((animated: boolean): void => {
    const { content, inset, viewport } = extent.current;
    const offset = Math.max(0, content - viewport + inset);
    tail.current = { ...tail.current, offset };
    listRef.current?.scrollToOffset({ animated, offset });
  }, []);
  const renderScroll = useCallback(
    (scrollProps: ScrollViewProps) => (
      <DockScrollView
        {...scrollProps}
        onContentInsetChange={({ bottom }) => {
          extent.current.inset = bottom;
        }}
      />
    ),
    [],
  );
  const [atTail, setAtTail] = useState(true);
  // Whether the list follows the newest entry, and what the pill and reading state show of it.
  const follow = useCallback((follows: boolean): void => {
    tail.current = { ...tail.current, follows };
    setAtTail(follows);
  }, []);
  // How far below the bar the transcript starts, under the Run's page.
  const [pageInset, setPageInset] = useState(0);
  // True while the reader is held in a window loaded around an older update.
  // The live conversation is not on screen, so the foot of what is is not the
  // conversation's tail and nothing here may treat it as one.
  const [historical, setHistorical] = useState(false);
  const [returning, setReturning] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // A read the reader asked for that didn't come, with its own way to ask again.
  // Said only while the connection is fine: otherwise the pill says why.
  const [failure, setFailure] = useState<{
    readonly key: number;
    readonly resource: string;
    readonly retry: () => void;
  } | null>(null);
  const pendingMutationOwner = (): ThreadMutationOwner | null => null;
  // One gate per Thread, shared with the settings sheet: it is a sibling route
  // in the native stack, so no context of this pane's can reach it, and an
  // execution change still in flight has to keep Send blocked all the same.
  const { gate: mutationGate, owner: mutationOwner } = useThreadMutation(
    { deploymentId: props.deploymentId, threadId: props.threadId, userId: viewerUserId },
    pendingMutationOwner(),
  );
  const paging = useRef(false);
  const scrollRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAttempts = useRef(0);

  useEffect(
    () => () => {
      if (scrollRetry.current !== null) clearTimeout(scrollRetry.current);
    },
    [],
  );
  const deploymentId = props.deploymentId;
  const { hostClient, onHeader, threadId } = props;
  const inView = usePaneInView();
  const navigationFocused = useIsFocused();
  const appForeground = useAppForeground();
  const showing = inView && navigationFocused && appForeground;
  const threadDetail = useThreadTranscript(hostClient, threadId, showing);
  useFocusEffect(
    useCallback(() => {
      // The Host holds one active Thread. A task stays mounted under the one
      // over it, a tablet shows a task beside the list and a narrow window keeps a
      // page's companion out of view, so the pane in front of the reader claims
      // it as it comes into view, not merely as it mounts.
      if (!inView) return;
      hostClient.activateThread(threadId);
      const leave = notifications.enterThread({ deploymentId, threadId });
      return () => {
        leave();
        hostClient.deactivateThread?.(threadId);
      };
    }, [deploymentId, hostClient, inView, notifications, threadId]),
  );
  // Whether this conversation is the screen in front of the reader. Read
  // markers and alert suppression both depend on it: a pane under another
  // screen, or kept out of view in its own, sees nothing, including on the
  // render it first mounts on. The sidebar covers the screen without blurring
  // the route under it, so it counts as looking away too.
  const sidebarVisible = useSidebarVisible();
  const focused = navigationFocused && !sidebarVisible && inView;
  // What an arriving alert has to know before it interrupts: an alert about
  // the conversation in front of the reader, at its latest activity, is telling
  // them what they are already watching.
  useEffect(() => {
    notifications.readingLatest(
      { deploymentId, threadId: props.threadId },
      focused && atTail && !historical,
    );
  }, [atTail, deploymentId, focused, historical, notifications, props.threadId]);

  const inputQueue = threadDetail.inputQueue;
  const waiting = useWaitingInputs(hostClient, threadId, false);
  // A waiting message is held for editing only while its task is in front of
  // the reader: under another screen, out of view or in the background, it goes on.
  const editing = useWaitingEdit(
    hostClient,
    threadId,
    waiting,
    navigationFocused && inView && appForeground,
  );
  const [focusDraft, setFocusDraft] = useState(0);
  const [replyEditMessage, setReplyEditMessage] = useState<string | null>(null);
  const waitingEdit = editing.edit;
  const editingReply = waitingEdit !== null && waitingEdit.messageId === replyEditMessage;
  const drafts = client.drafts;
  const sendAsNew = useCallback(
    async (words: { readonly parts: readonly ContentPart[]; readonly text: string }) => {
      if (viewerUserId === null) return false;
      // Files go with it by reference; a page or app it named was this edit's alone.
      const attachments = words.parts.filter(
        (part): part is ArtifactContentPart => part.type === "artifact",
      );
      const complete = drafts.reserveEdit(deploymentId, viewerUserId, threadId);
      const kept = await complete((draft) => {
        const held = draft?.attachments ?? [];
        return {
          ...(words.text
            ? { text: draft?.text.trim() ? `${words.text}\n${draft.text}` : words.text }
            : {}),
          attachments: [
            ...attachments
              .filter((part) => !held.some((file) => file.attachmentId === part.artifactId))
              .map((part) => ({
                attachmentId: part.artifactId,
                localUri: null,
                mediaType: part.mediaType,
                name: part.name,
                sizeBytes: part.sizeBytes ?? 0,
                status: "staged" as const,
              })),
            ...held,
          ],
        };
      });
      if (kept) setFocusDraft((value) => value + 1);
      return kept;
    },
    [deploymentId, drafts, threadId, viewerUserId],
  );

  const thread = snapshot.thread;
  const canRespond = threadDetail.synchronized && canRespondToRequests(snapshot);
  const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
  const connectionLive = useShowsLive(props.hostClient.connection);
  const live = threadDetail.synchronized && connectionLive && environment?.status === "connected";
  const connectionReady = useConnectionReady(props.hostClient.connection);
  // A failed read is asked again once the connection is back; it says nothing until then.
  const { readyRevision } = useClientConnection(props.hostClient.connection);
  useEffect(() => setFailure(null), [readyRevision]);
  const connectionLabel =
    canRespond && environment?.status === "disconnected" ? `${environment.name} offline` : null;

  const entries = threadDetail.entries;
  // A voice conversation reads as messages, each reply's steps in its
  // Activity; a task keeps its whole trace in view.
  const conversational = thread?.purpose === "voice";
  // A manager the person talks to: no composer, and its calls open with a divider.
  const voiceThread = snapshot.voiceThreadId === threadId;
  const onCall = useVoiceOn();
  // On a call the bar carries what needs the person, so the pane docks it nowhere else.
  const askedRequestId = useVoiceAskedRequest();
  // The same answer every surface gives: what this Thread is doing, and
  // which Run, if any, a Stop would reach.
  const activity =
    thread === null ? "idle" : threadActivity({ entries, runQueue: threadDetail.runQueue, thread });
  const outbox = hostMessageOutbox(hostClient);
  const withOutbox = useOutboxTranscript(outbox, threadId, entries, viewerUserId);
  const visible = useMemo(
    () =>
      withoutOwnAssignment(
        visibleTranscript(withOutbox, inputQueue, { conversation: conversational }),
        threadId,
      ),
    [conversational, inputQueue, threadId, withOutbox],
  );
  const hasQueuedInputs = Boolean(inputQueue?.items.length);
  const startsRun =
    thread !== null && threadStartsRunForMessage({ runQueue: threadDetail.runQueue, thread });
  const local = useMemo(
    () => splitLocalMessages(visible, !conversational, hasQueuedInputs, startsRun),
    [conversational, hasQueuedInputs, startsRun, visible],
  );
  const conversation = local.transcript;
  // Messages still on this phone: which carry their status line, and what
  // Edit, Delete and Don't send do to them. Edit hands the words back to the
  // composer above any draft there, once the message can no longer go.
  const pendingKeys = useMemo(() => {
    const held = visible.flatMap((entry) =>
      entry.kind === "message" && entry.localDelivery !== undefined
        ? [{ key: entry.clientSendKey ?? entry.id, entry }]
        : [],
    );
    const shown = messageDeliveryStatusShown(held.map(({ entry }) => entry.localDelivery!.phase));
    return new Map(held.map(({ key, entry }, index) => [key, { entry, shown: shown[index]! }]));
  }, [visible]);
  const heldMessages = useRef(pendingKeys);
  heldMessages.current = pendingKeys;
  // What an action on one of them came to, beside that message, until the next one.
  const [deliveryNotice, setDeliveryNotice] = useState<ActionLineValue | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState<ReadonlyMap<string, string>>(new Map());
  const noteDelivery = useCallback((key: string, note: string | null) => {
    setDeliveryNotes((current) => {
      if ((current.get(key) ?? null) === note) return current;
      const next = new Map(current);
      if (note === null) next.delete(key);
      else next.set(key, note);
      return next;
    });
  }, []);
  const deliveryControls = useMemo<MessageDeliveryControls>(
    () => ({
      act: (key: string, action: MessageDeliveryAction) => {
        if (outbox === null || !heldMessages.current.has(key)) return;
        noteDelivery(key, null);
        const failed = (error: unknown) => noteDelivery(key, presentMessageActionFailure(error));
        if (action === "retry")
          void outbox.retry(key).then((result) => {
            if (result === "settled") noteDelivery(key, presentMessageTakeBack("sent"));
          }, failed);
        // Edit moves the whole message, its files and quote too, into the draft
        // above any words there; the queue lets go of it only once it is saved.
        else if (action === "edit")
          void outbox
            .restoreDraft(key)
            .then((outcome) => noteDelivery(key, presentMessageTakeBack(outcome)), failed);
        else if (action === "remove") {
          const uncertain =
            heldMessages.current.get(key)?.entry.localDelivery?.issue?.code === "unconfirmed";
          const name = hostClient.connection.getSnapshot().name;
          void outbox.removeLocalCopy(key).then(() => {
            if (uncertain)
              setDeliveryNotice(
                issueLine(
                  {
                    code: "message-removed-locally",
                    ...(name ? { name } : {}),
                  },
                  `removed:${key}`,
                ),
              );
          }, failed);
        } else void outbox.discard(key).catch(failed);
      },
      note: (key: string) => deliveryNotes.get(key) ?? null,
      statusShown: (key: string) => heldMessages.current.get(key)?.shown ?? true,
    }),
    [deliveryNotes, hostClient, noteDelivery, outbox],
  );
  const inputQueuePaused = thread?.inputQueuePaused ?? false;
  // What this client holds of the account is current only while it is live.
  const startHold =
    live && thread !== null
      ? threadStartHold({
          environments: snapshot.environments,
          runQueue: threadDetail.runQueue,
          thread,
        })
      : null;
  const grouped = useMemo(
    () =>
      groupTranscriptEntries(conversation, {
        inputQueuePaused,
        startHold,
        assignments: snapshot.assignments,
      }),
    [conversation, inputQueuePaused, startHold, snapshot.assignments],
  );
  // `groupTranscriptEntries` builds every group afresh, so one streamed delta
  // hands back a hundred new objects for a hundred rows that did not change. An
  // entry is only ever replaced when it changes, so a group standing on the same
  // entries is the same group — and handing the previous object back is the
  // whole of what lets a row decline to draw itself again.
  const heldGroups = useRef<readonly TranscriptGroup[]>(grouped);
  const groups = useMemo(() => {
    heldGroups.current = reuseUnchangedGroups(heldGroups.current, grouped);
    return heldGroups.current;
  }, [grouped]);
  const stopTarget =
    thread === null ? null : threadStopTarget({ runQueue: threadDetail.runQueue, thread });
  const keptStop = useKeptComputerStop(hostClient, stopTarget?.id ?? null);
  const computers = useMemo<TranscriptComputers>(
    () => ({ hostClient, kept: keptStop, machines: snapshot.machines }),
    [hostClient, keptStop, snapshot.machines],
  );
  // The rows the list draws, under the keys it draws them by. A conversation
  // leaves out a turn with nothing of its own to show before the air between
  // rows is measured, so the person's messages on either side of it sit together.
  // A turn kept only for its work on a Mac is drawn while its line is: a Mac this
  // reader is not shown, or a session gone with no Stop of theirs to keep, has none.
  const drawn = useMemo(
    () =>
      conversational
        ? conversationRows(groups, {
            atComputer: (turn) => computerLine(turn, computers, live) !== null,
            live,
            waitingRequests: snapshot.waitingRequests,
          })
        : groups.map((group) => ({ group, key: group.key })),
    [computers, conversational, groups, live, snapshot.waitingRequests],
  );
  const canLoadEarlier = threadDetail.hasMore;

  // A link may name the Request it is about. A Request still pending is docked
  // in the composer, which is already on screen; one already answered left its
  // record, an answered question as its own row and any other among the steps
  // of the turn that asked it, and the link goes there.
  const { onOpenThread, requestId } = props;
  const receiptId = useMemo(() => {
    if (requestId === null) return null;
    for (const group of groups) {
      if (group.kind === "question" && group.entry.requestId === requestId) return group.entry.id;
      if (group.kind !== "turn") continue;
      const receipt = group.turn.work.find(
        (entry) => entry.kind === "request" && entry.requestId === requestId,
      );
      if (receipt !== undefined) return receipt.id;
    }
    return null;
  }, [groups, requestId]);
  const revealed = useRef<string | null>(null);

  /**
   * The exact update a notification or link named.
   *
   * The window around it is loaded from the Host, then the reader is put on
   * that message and left there: tail-follow stays off, so work arriving
   * meanwhile does not pull them away from what they came to read.
   */
  const anchorMessageId = props.messageId ?? null;
  const anchored = useRef<string | null>(null);
  useEffect(() => {
    if (
      !threadDetail.synchronized ||
      anchorMessageId === null ||
      anchored.current === anchorMessageId
    )
      return;
    anchored.current = anchorMessageId;
    setHistorical(true);
    follow(false);
    const open = (): void => {
      setFailure(null);
      void hostClient
        .loadTranscriptAround(threadId, anchorMessageId)
        .catch(() => setFailure({ key: Date.now(), resource: "that update", retry: open }));
    };
    open();
  }, [anchorMessageId, follow, hostClient, threadDetail.synchronized, threadId]);

  /** Puts the live conversation back and returns the reader to its foot. */
  const returnToLatest = useCallback((): void => {
    if (returning) return;
    setReturning(true);
    setFailure(null);
    void hostClient
      .loadLatestTranscript(threadId)
      .then((landed) => {
        // A newer move of the reader's took over: it owns the position and the route.
        if (!landed) return;
        // The anchor is spent. It is released on the route too, so opening the
        // same message again is a new jump rather than a no-op.
        anchored.current = null;
        anchorShown.current = null;
        props.onAnchorReleased?.();
        setHistorical(false);
        follow(true);
        scrollToLatest(false);
        hostClient.revealedTranscriptMove(threadId);
      })
      .catch(() =>
        setFailure({ key: Date.now(), resource: "the latest messages", retry: returnToLatest }),
      )
      .finally(() => setReturning(false));
  }, [follow, hostClient, props.onAnchorReleased, returning, scrollToLatest, threadId]);
  const anchor = useMemo(
    () =>
      anchorMessageId === null
        ? null
        : linkedPlace(anchorMessageId, { conversational, drawn, groups }),
    [anchorMessageId, conversational, drawn, groups],
  );
  const anchorShown = useRef<string | null>(null);
  const receipt = useMemo(
    () => (receiptId === null ? null : linkedPlace(receiptId, { conversational, drawn, groups })),
    [conversational, drawn, groups, receiptId],
  );
  // The oldest turn loaded may still be missing its start, on the page before
  // it. Drawn now, that page would grow it in place under a reader near the
  // top, which no scroll anchor can hold still, so it waits for that page.
  // A link into it, or a list with nothing else to show, draws it, and a turn
  // once drawn stays drawn: the Run it belongs to names it across pages.
  const shownHead = useRef<{ readonly key: string; readonly runId: string | null } | null>(null);
  const head = drawn[0]?.group;
  const heldHead =
    canLoadEarlier &&
    drawn.length > 1 &&
    head?.kind === "turn" &&
    anchor?.index !== 0 &&
    receipt?.index !== 0 &&
    !(
      shownHead.current !== null &&
      (head.key === shownHead.current.key ||
        (head.turn.runId !== null && head.turn.runId === shownHead.current.runId))
    )
      ? 1
      : 0;
  if (heldHead === 0 && head?.kind === "turn") {
    shownHead.current = { key: head.key, runId: head.turn.runId };
  }

  const visibleItem = useRef<string | undefined>(undefined);
  const onVisibleItems = useRef(
    ({ viewableItems }: { viewableItems: readonly { item: TranscriptItem }[] }) => {
      const row = viewableItems[0]?.item;
      if (row?.kind !== "group") return;
      visibleItem.current = rowItemId(row);
    },
  ).current;
  // Where the reader is, asked only when the client needs it (a repair, a subscription): the row
  // the list last reported at the top of the screen, or none while following the latest.
  // Measured, the row also records its neighbours, nearest first (older, then newer), so a new cut
  // that lost it puts the reader on the nearest one left, or at the latest.
  const following = useRef(true);
  following.current = atTail && !historical;
  const measured = useRef<{ readonly targets: readonly string[] } | null>(null);
  const shownItems = useRef<readonly TranscriptItem[]>([]);
  useEffect(() => {
    hostClient.setTranscriptPosition(threadId, () => {
      measured.current = null;
      if (following.current) return undefined;
      const itemId = visibleItem.current;
      // Nothing reported yet: the list cannot tell, and the last place stands.
      if (itemId === undefined) return null;
      const rows = shownItems.current;
      const index = rows.findIndex((row) => rowItemId(row) === itemId);
      const near = (from: number, to: number, step: number) => {
        const ids: string[] = [];
        for (let at = from; at !== to && ids.length < 25; at += step) {
          const id = rowItemId(rows[at]!);
          if (id) ids.push(id);
        }
        return ids;
      };
      measured.current = {
        targets: [
          itemId,
          ...(index < 0 ? [] : [...near(index - 1, -1, -1), ...near(index + 1, rows.length, 1)]),
        ],
      };
      return itemId;
    });
    return () => hostClient.setTranscriptPosition(threadId, null);
  }, [hostClient, threadId]);
  const loadEarlier = useCallback(() => {
    if (paging.current || !canLoadEarlier) return;
    paging.current = true;
    setFailure(null);
    setLoadingEarlier(true);
    void hostClient
      .loadEarlierTranscript(threadId)
      .catch(() =>
        setFailure({ key: Date.now(), resource: "earlier messages", retry: loadEarlier }),
      )
      .finally(() => {
        paging.current = false;
        setLoadingEarlier(false);
      });
  }, [canLoadEarlier, hostClient, threadId]);

  const pendingRequest =
    requestId !== null && (threadDetail.requests ?? []).some((request) => request.id === requestId);
  // An answer on a page not loaded yet is paged back to. Whether it has a row
  // is not the question: in a conversation it never does.
  useEffect(() => {
    if (
      requestId !== null &&
      revealed.current !== requestId &&
      receiptId === null &&
      !pendingRequest &&
      !loadingEarlier &&
      failure === null
    )
      loadEarlier();
  }, [failure, loadEarlier, loadingEarlier, pendingRequest, receiptId, requestId]);

  // The navigation bar carries the task's name, where it works and its state,
  // and it is fed primitives rather than the Thread: a title that has not
  // changed must not rebuild a header while the transcript streams under it.
  const headerTitle = thread?.title ?? null;
  const icon = thread?.icon ?? null;
  const markColor = thread?.color ?? null;
  // The split heading's own width, which the title's menu is sized to.
  // Held while it reads the same, so the bar rebuilds only when the task moves.
  const heldTask = useRef<TaskHeading | null>(null);
  const task = useMemo(() => {
    const next = snapshot.task;
    if (!sameTaskHeading(heldTask.current, next)) heldTask.current = next;
    return heldTask.current;
  }, [snapshot, threadId]);
  // Held while it names the same conversation, so the list's header is not rebuilt as it streams.
  const found = snapshot.requester;
  const requesterThreadId = found?.threadId ?? null;
  const requesterTitle = found?.title ?? null;
  const requester = useMemo(
    () =>
      requesterThreadId === null || requesterTitle === null
        ? null
        : { threadId: requesterThreadId, title: requesterTitle },
    [requesterThreadId, requesterTitle],
  );
  useEffect(() => {
    onHeader?.({
      connectionLabel,
      task,
      title: headerTitle ?? "Thread",
      icon,
      color: markColor,
      isVoice: voiceThread,
    });
  }, [connectionLabel, headerTitle, onHeader, task, icon, markColor, voiceThread]);

  // The reader's choices survive rows leaving the list's mounted window.
  const [openRows, setOpenRows] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleRow = useCallback((rowKey: string, open: boolean) => {
    setOpenRows((choices) => new Map(choices).set(rowKey, !open));
  }, []);
  const openStep = useCallback(
    (entryId: string) => navigation.navigate("ThreadStep", { deploymentId, entryId, threadId }),
    [deploymentId, navigation, threadId],
  );
  const openActivity = useCallback(
    (turnKey: string, messageId?: string) =>
      navigation.navigate("ConversationActivity", {
        deploymentId,
        threadId,
        turnKey,
        ...(messageId === undefined ? {} : { messageId }),
      }),
    [deploymentId, navigation, threadId],
  );
  // The reply under way opens the latest Activity: that reply's, and still
  // that reply's once it has landed.
  const openLatestActivity = useCallback(
    () => navigation.navigate("ConversationActivity", { deploymentId, threadId }),
    [deploymentId, navigation, threadId],
  );
  // Puts the reader where a link points, and opens the Activity holding it.
  const reveal = useCallback(
    (place: LinkedPlace, entryId: string): void => {
      if (place.index >= 0) {
        scrollAttempts.current = 0;
        follow(false);
        listRef.current?.scrollToIndex({
          animated: false,
          index: place.index - heldHead,
          viewPosition: 0.5,
        });
      }
      const { openKey } = place;
      if (openKey !== null) {
        setOpenRows((open) =>
          open.get(openKey) === true ? open : new Map(open).set(openKey, true),
        );
      }
      if (place.activityKey !== null) openActivity(place.activityKey, entryId);
    },
    [follow, heldHead, openActivity],
  );
  useEffect(() => {
    if (anchorMessageId === null || anchor === null || anchorShown.current === anchorMessageId) {
      return;
    }
    // A sheet opens over the screen in front of the reader, never under it.
    if (anchor.activityKey !== null && !focused) return;
    anchorShown.current = anchorMessageId;
    reveal(anchor, anchorMessageId);
    // The linked message is on screen: the reader's move has landed. Until it is (a repair
    // replaced the rows), the move holds the position and its message is read again.
    hostClient.revealedTranscriptMove(threadId);
  }, [anchor, anchorMessageId, focused, hostClient, reveal, threadId]);
  useEffect(() => {
    if (requestId === null || revealed.current === requestId) return;
    // A Request still waiting is shown in the composer, and that spends the
    // link: its answer landing later, given here or anywhere, moves nothing.
    if (pendingRequest) {
      revealed.current = requestId;
      return;
    }
    if (receipt === null || receiptId === null || (receipt.activityKey !== null && !focused))
      return;
    revealed.current = requestId;
    reveal(receipt, receiptId);
  }, [focused, pendingRequest, receipt, receiptId, requestId, reveal]);
  // A chip opens exactly the page or app it names, pushed so Back returns to
  // where it was opened; one already in front is left as it is.
  const surfaceTurns = useMemo(
    () =>
      new Map(
        conversationActivities(groups).flatMap(({ keys, turn }) =>
          keys.map((key) => [key, turn] as const),
        ),
      ),
    [groups],
  );
  const showTab = props.withPage?.showTab ?? null;
  const showTabHere = useShowTab(deploymentId, threadId);
  const openPlace = useOpenPlace(deploymentId, threadId);
  // Beside a page, a page chip turns that page rather than stacking another.
  const openSurface = useCallback(
    (destination: TabDestination) => {
      const page = hostClient.getSnapshot().tabs.get(destination.tabId)?.kind === "page";
      if (page && showTab !== null) showTab({ tabId: destination.tabId });
      else openPlace(destination);
    },
    [hostClient, openPlace, showTab],
  );
  const appTabs = useMemo<TranscriptAppTabs>(() => ({ show: showTabHere }), [showTabHere]);
  const surfaces = useMemo<TranscriptSurfaces>(
    () => ({ hostClient, threadId, turns: surfaceTurns, open: openSurface }),
    [hostClient, openSurface, surfaceTurns, threadId],
  );
  /** Quotes a reply into this conversation's own composer, unsent. */
  const replyWith = useCallback(
    (message: MessageEntry): void => {
      if (viewerUserId === null) return;
      void drafts
        .writeDraftQuote(deploymentId, viewerUserId, threadId, draftQuoteFrom(message))
        .then(
          () => setFocusDraft((value) => value + 1),
          () => setDeliveryNotice(issueLine({ code: "draft-unsaved" }, `quote:${Date.now()}`)),
        );
    },
    [deploymentId, drafts, threadId, viewerUserId],
  );

  const incomingMessages = useMemo(
    () => incomingTranscriptMessages(conversation, viewerUserId, conversational),
    [conversation, conversational, viewerUserId],
  );
  const observed = useMemo(
    () => observedSequence(conversation, conversational),
    [conversation, conversational],
  );
  useEffect(() => {
    if (tail.current.follows) {
      seenSequence.current = observed;
      setPendingMessages(0);
      return;
    }
    const seen = seenSequence.current;
    setPendingMessages(
      seen === null
        ? 0
        : incomingMessages.filter((message) => BigInt(message.sequence) > BigInt(seen)).length,
    );
  }, [atTail, incomingMessages, observed]);
  const dockableWaiting = useMemo(
    () =>
      askedRequestId === null
        ? snapshot.waitingRequests
        : snapshot.waitingRequests.filter(({ request }) => request.id !== askedRequestId),
    [askedRequestId, snapshot.waitingRequests],
  );
  const dockableRequests = useMemo(
    () => (threadDetail.requests ?? []).filter(({ id }) => id !== askedRequestId),
    [askedRequestId, threadDetail.requests],
  );
  const taskScope = useMemo<TaskScope>(
    () => ({
      focused,
      hostClient,
      threadId,
      // Pushed, not navigated: navigating to the Thread route from a Thread
      // replaces this one's params, and back would skip past the conversation.
      onViewWork: (workerThreadId: string) =>
        navigation.dispatch(
          StackActions.push("Thread", { deploymentId, threadId: workerThreadId }),
        ),
      onOpenSubagent: (parentThreadId: string, nodeId: string) =>
        navigation.dispatch(
          StackActions.push("Subagent", { deploymentId, nodeId, threadId: parentThreadId }),
        ),
    }),
    [deploymentId, focused, hostClient, navigation, threadId],
  );
  // Which helper groups and phases the reader opened or closed, and which
  // cards stood outside a fold, for as long as this pane lives.
  const agentMemory = useRef(new Map<string, boolean>()).current;
  const openRunningNow = useCallback(
    () => navigation.navigate("RunningNow", { deploymentId, threadId }),
    [deploymentId, navigation, threadId],
  );
  // What the jump pill says while the reader is away from a turn at work on
  // their Mac: that is where its Stop is.
  const computerNow = useMemo(
    () => (live ? threadComputerUseNow(groups, snapshot.machines) : null),
    [groups, live, snapshot.machines],
  );
  const jumpToMac = computerNow !== null && !historical ? computerUseNowSummary(computerNow) : null;
  const openSource = useCallback(
    (sourceThreadId: string) => {
      if (sourceThreadId === threadId) return;
      onOpenThread(sourceThreadId);
    },
    [onOpenThread, threadId],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TranscriptItem>) =>
      item.kind === "working" ? (
        <WorkingIndicator indicator={item.indicator} live={live} />
      ) : (
        <>
          {/* Rows open the files messages carry through this Thread's own client. */}
          <TranscriptHostClientContext value={hostClient}>
            <TranscriptGroupRow
              activityKey={item.activityKey}
              continued={item.continued}
              conversation={conversational}
              onOpenActivity={conversational ? openActivity : undefined}
              onOpenReplyUnderWay={conversational ? openLatestActivity : undefined}
              onReply={conversational && !voiceThread ? replyWith : undefined}
              live={live}
              group={item.group}
              open={openRows.get(item.group.key) ?? null}
              onToggleOpen={toggleRow}
              reveal={anchorMessageId ?? receiptId}
              highlightRequestId={requestId}
              onOpenStep={openStep}
              onOpenThread={openSource}
              spacingTop={item.spacingTop}
              time={item.time}
              viewerUserId={viewerUserId}
              voiceThread={voiceThread}
            />
          </TranscriptHostClientContext>
          {item.outcome === null ? null : (
            <TaskOutcomeLine onOpenThread={openSource} outcome={item.outcome} />
          )}
        </>
      ),
    [
      anchorMessageId,
      conversational,
      hostClient,
      live,
      openActivity,
      openLatestActivity,
      openSource,
      openStep,
      openRows,
      replyWith,
      requestId,
      receiptId,
      viewerUserId,
      voiceThread,
    ],
  );

  const threadRuns = useMemo(
    () => threadDetail.runQueue.filter((run) => run.threadId === threadId),
    [threadDetail.runQueue, threadId],
  );
  const indicator = useMemo(
    () => threadActivityIndicator(activity, { conversation: conversational, groups, startHold }),
    [activity, conversational, groups, startHold],
  );
  // How each task this Thread finished ended, held while it reads the same.
  const heldOutcomes = useRef<ReadonlyMap<string, TaskOutcome>>(new Map());
  const outcomes = useMemo(() => {
    const next = snapshot.outcomes;
    if (!sameTaskOutcomes(heldOutcomes.current, next)) heldOutcomes.current = next;
    return heldOutcomes.current;
  }, [snapshot, threadId]);
  const items = useMemo(() => {
    let previous: TranscriptVoice | null = null;
    const places = conversational
      ? conversationPlaces(
          drawn.map(({ group }) => group),
          viewerUserId,
          Date.now(),
        )
      : null;
    const activityKeys = conversational ? replyActivityKeys(groups) : null;
    // A task's ending goes under the last stretch of the Run it ended with,
    // inside that row, so rows stay one to one with the groups links count.
    const lastTurn = new Map<string, number>();
    drawn.forEach(({ group }, index) => {
      if (group.kind === "turn" && group.turn.runId !== null) lastTurn.set(group.turn.runId, index);
    });
    const endings = new Map<number, TaskOutcome>();
    for (const [runId, outcome] of outcomes) {
      const index = lastTurn.get(runId);
      if (index !== undefined) endings.set(index, outcome);
    }
    const rows: TranscriptItem[] = drawn.map(({ group, key }, index) => {
      const voice = transcriptVoice(group, viewerUserId);
      const place = places?.[index];
      const spacingTop =
        place === undefined
          ? transcriptSpacing(previous, voice)
          : index === 0
            ? 0
            : place.joined
              ? bubble.gap
              : bubble.groupGap;
      previous = voice;
      return {
        activityKey: activityKeys?.get(group.key) ?? null,
        continued: place?.continued === true,
        group,
        key,
        kind: "group" as const,
        outcome: endings.get(index) ?? null,
        spacingTop,
        time: place?.time ?? null,
      };
    });
    if (indicator !== null) rows.push({ indicator, key: "working", kind: "working" });
    // Spaced as if the held turn were drawn, so drawing it later changes nothing below it.
    return heldHead === 0 ? rows : rows.slice(heldHead);
  }, [conversational, drawn, groups, heldHead, indicator, outcomes, viewerUserId]);
  shownItems.current = items;

  // A new cut (a repair, or a new subscription's snapshot) replaced the rows: the reader goes back
  // to the row measured just before it, else its nearest surviving neighbour, else the latest.
  // Until they drag, a reread that brings the measured row back puts them on it.
  const cuts = threadDetail.cuts ?? 0;
  const seenCuts = useRef(cuts);
  const restoring = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (seenCuts.current !== cuts) {
      seenCuts.current = cuts;
      restoring.current = following.current ? null : (measured.current?.targets ?? null);
      measured.current = null;
    }
    const targets = restoring.current;
    if (!targets) return;
    const index = targets
      .map((target) => items.findIndex((row) => rowItemId(row) === target))
      .find((found) => found >= 0);
    if (index === undefined) {
      follow(true);
      scrollToLatest(false);
      return;
    }
    listRef.current?.scrollToIndex({ animated: false, index, viewPosition: 0 });
    if (rowItemId(items[index]!) === targets[0]) restoring.current = null;
  }, [cuts, follow, items, scrollToLatest]);

  const queueFooter = useMemo(
    () =>
      // An open edit stays drawn whatever the queue says, so its words are never lost.
      thread !== null &&
      !conversational &&
      (waiting !== null || editing.edit !== null || local.afterQueue.length > 0) ? (
        <TranscriptHostClientContext value={hostClient}>
          <WaitingInputs
            canRespond={canRespond && !editingReply}
            editing={editingReply ? { ...editing, edit: null } : editing}
            hostClient={hostClient}
            items={waiting ?? noWaiting}
            local={local.afterQueue}
            onOpenThread={props.onOpenThread}
            paused={inputQueue?.paused ?? false}
            resumable={thread.status !== "archived"}
            threadId={threadId}
            transcript={withOutbox}
            viewerUserId={viewerUserId}
          />
        </TranscriptHostClientContext>
      ) : null,
    [
      thread,
      conversational,
      inputQueue,
      waiting,
      editing,
      editingReply,
      canRespond,
      hostClient,
      local.afterQueue,
      withOutbox,
      props.onOpenThread,
      threadId,
      viewerUserId,
    ],
  );
  const passwordsOffer = useMemo(() => passwordsSetupOffer(groups), [groups]);
  const loadMoreActivity = (kind: "tools" | "nodes") => {
    void hostClient.loadMoreOverlays(threadId, kind).catch(() =>
      setFailure({
        key: Date.now(),
        resource: "more activity",
        retry: () => loadMoreActivity(kind),
      }),
    );
  };
  const conversationFooter =
    passwordsOffer !== null && viewerUserId !== null && !(voiceThread && onCall) ? (
      <>
        <PasswordsSuggestion
          deploymentId={props.deploymentId}
          hostClient={hostClient}
          offer={passwordsOffer}
          style={styles.passwords}
          userId={viewerUserId}
        />
        {queueFooter}
      </>
    ) : (
      (queueFooter ?? undefined)
    );

  const loadWaitingMessages = () => {
    setFailure(null);
    void hostClient
      .loadThreadInputQueue(threadId)
      .catch(() =>
        setFailure({ key: Date.now(), resource: "waiting messages", retry: loadWaitingMessages }),
      );
  };
  const loadNewer = () => {
    setFailure(null);
    void hostClient
      .loadNewerTranscript(threadId)
      .catch(() => setFailure({ key: Date.now(), resource: "newer activity", retry: loadNewer }));
  };
  const listFooter = (
    <>
      {threadDetail.inputQueueError !== undefined ? (
        <AnswerPill
          tone="secondary"
          label="Retry loading waiting messages"
          onPress={loadWaitingMessages}
        />
      ) : null}
      {conversationFooter}
      {threadDetail.hasNewer ? (
        <AnswerPill tone="secondary" label="Load newer" onPress={loadNewer} />
      ) : null}
      {threadDetail.moreTools ? (
        <AnswerPill
          tone="secondary"
          label="Show more tools"
          onPress={() => loadMoreActivity("tools")}
        />
      ) : null}
      {threadDetail.moreNodes ? (
        <AnswerPill
          tone="secondary"
          label="Show more subagents"
          onPress={() => loadMoreActivity("nodes")}
        />
      ) : null}
    </>
  );

  // Never under a finger: the list moves only where the reader puts it.
  const keepPinned = (): void => {
    if (tail.current.follows && !dragging.current) scrollToLatest(false);
  };

  useThreadVisits(hostClient, threadId, focused && appForeground);

  // A task removed while open, here or on another device, is left as soon as
  // it is in front again; one never on this Host is left at once.
  const gone = thread === null && snapshot.lookup === "missing";
  const leftGone = useRef(false);
  const onGone = props.onGone;
  useEffect(() => {
    if (!gone) leftGone.current = false;
    else if (navigationFocused && !leftGone.current) {
      leftGone.current = true;
      onGone();
    }
  }, [gone, navigationFocused, onGone]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const max = contentSize.height + extent.current.inset - layoutMeasurement.height;
    // Only the reader's own finger, and the fling it releases, decide whether
    // they follow. The list also moves by itself — rows measured after the
    // jump to the end, a page arriving above, the dock growing as a Request
    // docks — and each of those changes the content or the list's size, which
    // `keepPinned` answers.
    const own = dragging.current || flinging.current;
    if (!own) {
      tail.current = { ...tail.current, offset: contentOffset.y };
      return;
    }
    tail.current = readTail(tail.current, contentOffset.y, max, true);
    const follows = tail.current.follows;
    // Only a change repaints: a scroll fires many times a second and the pill
    // is the only thing on screen that depends on it.
    setAtTail((current) => (current === follows ? current : follows));
    // Asked for a screen ahead of the top, so the page lands above the reader,
    // where the list keeps their place, instead of under them at the edge.
    if (
      contentOffset.y < layoutMeasurement.height &&
      contentSize.height > layoutMeasurement.height &&
      !follows
    )
      loadEarlier();
  };

  if (thread === null) {
    // Gone is a fact about the task; anything else not loaded yet is the
    // connection's to explain, and the gate does, or the read is under way.
    if (snapshot.lookup === "missing") return <UnavailableState onBack={onGone} />;
    if (!connectionReady)
      return (
        <ConnectionRouteGate
          connection={hostClient.connection}
          secondary={{ label: "Back", onPress: onGone }}
        />
      );
    return snapshot.lookup === "failed" ? (
      <View style={[styles.centred, sides]}>
        <ActionLine
          line={issueLine({ code: "read-failed", resource: "this task" }, "lookup", {
            label: "Try again",
            onPress: () => hostClient.activateThread(threadId),
          })}
          numberOfLines={2}
        />
      </View>
    ) : null;
  }

  // Access capabilities follow the engine that will enforce them.
  const placements = threadPlacementOptions(snapshot.environments, snapshot.harnesses);
  const placement =
    placements.find((option) => option.harnessInstanceId === thread.harnessInstanceId) ?? null;
  const usageNotice =
    snapshot.user === null
      ? null
      : usageLimitNotice({
          entries,
          placements,
          scope: { deploymentId: props.deploymentId, userId: snapshot.user.id },
          selection: thread,
        });
  const disabledReason =
    thread.status === "archived"
      ? "This thread is archived and cannot take new messages."
      : mutationOwner === "settings"
        ? "Updating thread settings…"
        : mutationOwner === "request"
          ? "Sending your response…"
          : null;

  const openSettings = (conversation?: boolean): void =>
    navigation.navigate("ThreadSettings", {
      ...(conversation ? { conversation: true } : {}),
      deploymentId: props.deploymentId,
      threadId: thread.id,
    });

  // This pane's list scrolls under the Thread screen's transparent bar. iOS
  // takes the bar's height from the screen's own safe area; Android has no such
  // inset to read, so the number is stated there. Beside a page there is no bar
  // over it, only what that surface floats there itself.
  const companion = props.withPage ?? null;
  const headerClearance = props.headerClearance ?? (companion === null ? headerHeight : 0);
  // Beside a page there is no title menu, so the composer's carries these.
  const actionsBesidePage =
    companion === null
      ? []
      : conversationActions({
          deploymentId: props.deploymentId,
          onFind: () =>
            navigation.navigate("ThreadFind", { deploymentId: props.deploymentId, threadId }),
          threadId,
        });
  const transcript = (clearance: number): ReactNode => (
    <View style={styles.body}>
      <MessageDeliveryContext value={deliveryControls}>
        <FlatList
          automaticallyAdjustsScrollIndicatorInsets={false}
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={[
            column,
            {
              ...sides,
              paddingBottom: clearance + space[16],
              paddingTop:
                headerClearance +
                pageInset +
                space[8] +
                (companion === null ? pillRowClearance : 0),
            },
          ]}
          data={items}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListFooterComponent={listFooter}
          // Beside a page, before anything has been said, the page is the subject;
          // a task holding only waiting words is not empty.
          ListEmptyComponent={
            companion === null && (snapshot.lookup === "loading" || !waiting?.length) ? (
              <EmptyThread loading={snapshot.lookup === "loading"} voice={voiceThread} />
            ) : undefined
          }
          ListHeaderComponent={
            <ThreadHeader
              earlier={canLoadEarlier}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={loadEarlier}
              onOpenRequester={openSource}
              requester={requester}
            />
          }
          // Paging upward inserts entries above what is being read; this is
          // what keeps the reader's place instead of jumping them to the top.
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          onContentSizeChange={(_width, height) => {
            extent.current.content = height;
            keepPinned();
          }}
          onLayout={(event) => {
            extent.current.viewport = event.nativeEvent.layout.height;
            keepPinned();
          }}
          onMomentumScrollBegin={() => {
            flinging.current = true;
          }}
          onMomentumScrollEnd={() => {
            flinging.current = false;
          }}
          onScroll={handleScroll}
          onViewableItemsChanged={onVisibleItems}
          onScrollBeginDrag={() => {
            dragging.current = true;
            restoring.current = null;
          }}
          onScrollEndDrag={() => {
            dragging.current = false;
          }}
          // `scrollToIndex` needs somewhere to go before the row it names has
          // been measured. FlatList hands back its own estimate for exactly
          // this, and one more layout pass then lands on the row.
          onScrollToIndexFailed={({ averageItemLength, index }) => {
            listRef.current?.scrollToOffset({
              animated: false,
              offset: averageItemLength * index,
            });
            if (scrollAttempts.current < 3) {
              scrollAttempts.current += 1;
              if (scrollRetry.current !== null) clearTimeout(scrollRetry.current);
              scrollRetry.current = setTimeout(
                () => listRef.current?.scrollToIndex({ animated: false, index, viewPosition: 0.5 }),
                150,
              );
            }
          }}
          ref={listRef}
          renderItem={renderItem}
          renderScrollComponent={renderScroll}
          // The pill and the load-earlier trigger both read scroll position, so
          // the list reports it every frame rather than every fourth one.
          scrollEventThrottle={16}
          scrollIndicatorInsets={{ bottom: clearance, top: headerClearance + pageInset }}
        />
      </MessageDeliveryContext>
      {snapshot.user === null ? null : (
        <RunPageSlot
          active={focused}
          beside={companion !== null}
          clearance={clearance}
          hostClient={hostClient}
          onInset={setPageInset}
          onOpen={openSurface}
          runId={stopTarget?.id ?? null}
          scrolledUp={historical || !atTail}
          threadId={threadId}
          top={headerClearance}
          yielding={editing.edit !== null}
        />
      )}
      {/* An older window has to be left deliberately, and the way out is to
          load the live conversation — so the offer stands there whether or
          not anything new has arrived since. */}
      <OverDock>
        {!historical && atTail ? null : (
          <Animated.View
            entering={enter}
            exiting={exit}
            style={[styles.jumpHome, { bottom: clearance + space[12] }]}
          >
            {/* An opaque capsule, not glass: it floats over whatever the
              reader scrolled to, their own ember messages included, and its
              words have to read over all of it. */}
            <Pressable
              accessibilityHint={jumpToMac === null ? undefined : "Jumps to the newest activity"}
              accessibilityLabel={
                jumpToMac ?? (pendingMessages > 0 ? "Jump to new messages" : "Jump to latest")
              }
              accessibilityRole="button"
              disabled={returning}
              onPress={() => {
                if (historical) {
                  returnToLatest();
                  return;
                }
                follow(true);
                scrollToLatest(true);
              }}
              style={({ pressed }) => [styles.jump, pressed && styles.jumpPressed]}
            >
              <AppText numberOfLines={1} role="secondaryMedium" tone="ember">
                {returning
                  ? "Loading…"
                  : historical
                    ? "Back to latest"
                    : (jumpToMac ??
                      (pendingMessages > 0
                        ? pendingMessages === 1
                          ? "New message"
                          : `${pendingMessages} new messages`
                        : "Jump to latest"))}
              </AppText>
              <Symbol name="chevron.down" size={14} tint={color.ember} />
            </Pressable>
          </Animated.View>
        )}
      </OverDock>
    </View>
  );
  // While a waiting message is open in place, the dock is its edit bar alone:
  // with the keyboard up on a small phone, anything else docked here leaves
  // no room for the words being edited. It all returns on Save or Cancel.
  const editingInPlace = editing.edit !== null;
  const dock = (
    <>
      {/* An older window can't say what runs now; back at the latest, it returns. */}
      {snapshot.user === null || voiceThread || historical || editingInPlace ? null : (
        <RunningNowCapsule
          hostClient={hostClient}
          observed={showing}
          onOpen={openRunningNow}
          reachable={live}
          threadId={threadId}
        />
      )}
      {deliveryNotice === null ? null : (
        <ActionLine line={deliveryNotice} onDismiss={() => setDeliveryNotice(null)} />
      )}
      {failure === null || !connectionReady ? null : (
        <ActionLine
          line={issueLine(
            { code: "read-failed", resource: failure.resource },
            String(failure.key),
            {
              label: "Try again",
              onPress: failure.retry,
            },
          )}
          onDismiss={() => setFailure(null)}
        />
      )}
      {snapshot.user === null ? null : (
        <>
          {(voiceThread && onCall) || editingInPlace ? null : (
            <ThreadServerApprovals hostClient={hostClient} threadId={thread.id} />
          )}
          {(voiceThread && onCall) || editingInPlace ? null : (
            <WaitingQuestions
              canRespond={canRespond}
              deploymentId={props.deploymentId}
              drafts={client.drafts}
              hostClient={props.hostClient}
              onOpenTask={taskScope.onViewWork}
              ownQuestions={voiceThread}
              threadId={thread.id}
              user={snapshot.user}
              waitingRequests={dockableWaiting}
            />
          )}
          {voiceThread ? (
            <>
              <VoiceDock slot />
              {onCall ? null : (
                <VoiceStartBar
                  hostClient={hostClient}
                  modelHold={settingsDisabledReason({
                    canRespond,
                    hasRun: threadRuns.length > 0,
                    mutationOwner,
                    kind: "thread",
                    thread,
                  })}
                  modelLabel={thread.modelLabel.trim() === "" ? "Choose model" : thread.modelLabel}
                  onChooseModel={openSettings}
                />
              )}
              <UsageNotice notice={usageNotice} onOpen={openSettings} />
            </>
          ) : (
            <>
              {waitingEdit?.replyFull ? (
                <AnswerPill
                  label={editingReply ? "Back to waiting edit" : "Edit reply draft"}
                  onPress={() => {
                    setReplyEditMessage(editingReply ? null : waitingEdit.messageId);
                    if (!editingReply) setFocusDraft((value) => value + 1);
                  }}
                  tone="secondary"
                />
              ) : null}
              {editingInPlace ? (
                editingReply ? null : (
                  <WaitingEditBar
                    canRespond={canRespond}
                    editing={editing}
                    onSendAsNew={sendAsNew}
                  />
                )
              ) : null}
              {/* Kept mounted while a waiting message is edited: it owns a send in flight. */}
              <View style={editingInPlace && !editingReply ? styles.hidden : undefined}>
                <Composer
                  observed={showing}
                  variant={conversational ? "conversation" : "work"}
                  voice={false}
                  accessMode={thread.accessMode}
                  accessModes={placement?.accessModes ?? null}
                  canRespond={canRespond}
                  deploymentId={props.deploymentId}
                  // Identity, not decoration: the composer's draft and its pending
                  // command belong to one Thread on one Deployment, so a navigation to
                  // another Thread builds a new one rather than inheriting this one's.
                  key={`${props.deploymentId}:${snapshot.user.id}:${thread.id}`}
                  disabledReason={disabledReason}
                  readOnly={thread.status === "archived"}
                  drafts={client.drafts}
                  driverKind={placement?.driverKind}
                  executionBlockedReason={
                    placement === null
                      ? "This AI account is no longer here."
                      : !placement.available
                        ? placement.detail
                        : null
                  }
                  engineName={placement?.engineName ?? thread.harnessLabel}
                  usageNotice={usageNotice}
                  highlightRequestId={props.requestId}
                  hostClient={props.hostClient}
                  // A thread with no model chosen yet says so on the pill, rather
                  // than naming a blank.
                  modelLabel={thread.modelLabel.trim() === "" ? "Choose model" : thread.modelLabel}
                  model={
                    placement?.models.find(
                      (m) =>
                        m.providerId === thread.modelSelection.providerId &&
                        m.modelId === thread.modelSelection.modelId,
                    ) ?? null
                  }
                  modelOptions={thread.modelSelection.options}
                  mutationGate={mutationGate}
                  // Once the Host's copy has taken its place, a send that then
                  // fails is the bar's to offer again, as for any held message.
                  conversationActions={actionsBesidePage}
                  page={companion?.page ?? null}
                  onChangeModel={openSettings}
                  placeholder={threadComposerPlaceholder(items.length === 0 && !canLoadEarlier)}
                  requests={editingReply ? [] : dockableRequests}
                  {...(threadDetail.moreRequests
                    ? {
                        onMoreRequests: () => {
                          void hostClient
                            .loadMoreOverlays(threadId, "requests")
                            .catch(() => undefined);
                        },
                      }
                    : {})}
                  focusDraft={focusDraft}
                  running={stopTarget !== null}
                  stopRunId={stopTarget?.id ?? null}
                  // A task card in a conversation stops its own task, and a task's
                  // title menu stops the task. In a conversation this ends only the
                  // reply under way; in a task it leaves the task paused.
                  stopLabel={
                    conversational
                      ? "Stop the reply"
                      : task?.open === true
                        ? "Pause this task"
                        : "Stop this run"
                  }
                  runStopping={activity === "stopping"}
                  // The sheet's own guard, in the sheet's own words: the model pill
                  // and the access menu change the same settings from here, so a
                  // change already in flight — including one whose sheet has since
                  // been dismissed — has to close both doors, not just that one.
                  settingsDisabledReason={settingsDisabledReason({
                    canRespond,
                    hasRun: threadRuns.length > 0,
                    mutationOwner,
                    kind: "thread",
                    thread,
                  })}
                  threadId={thread.id}
                  user={snapshot.user}
                />
              </View>
            </>
          )}
        </>
      )}
    </>
  );
  return (
    <TranscriptImageContext value={{ client: hostClient, threadId: thread.id }}>
      <TaskScopeContext.Provider value={taskScope}>
        <AgentEngine value={placement?.driverKind ?? null}>
          <AgentMemoryContext value={agentMemory}>
            <AgentListNestedContext value>
              <TranscriptComputersContext.Provider value={computers}>
                <TranscriptSurfacesContext.Provider value={surfaces}>
                  <TranscriptAppTabsContext.Provider value={appTabs}>
                    {/* Beside a page, the screen already keeps the keyboard clear. */}
                    <PersonalReferenceProvider
                      client={hostClient}
                      deploymentId={deploymentId}
                      threadId={threadId}
                    >
                      <ConversationLinksProvider
                        deploymentId={deploymentId}
                        hostClient={hostClient}
                        threadId={threadId}
                      >
                        <ComposerDockLayout avoidKeyboard={companion === null} dock={dock}>
                          {transcript}
                        </ComposerDockLayout>
                      </ConversationLinksProvider>
                    </PersonalReferenceProvider>
                  </TranscriptAppTabsContext.Provider>
                </TranscriptSurfacesContext.Provider>
              </TranscriptComputersContext.Provider>
            </AgentListNestedContext>
          </AgentMemoryContext>
        </AgentEngine>
      </TaskScopeContext.Provider>
    </TranscriptImageContext>
  );
}

function ThreadHeader(props: {
  readonly earlier: boolean;
  readonly loadingEarlier: boolean;
  readonly onLoadEarlier: () => void;
  readonly onOpenRequester: (threadId: string) => void;
  /** The conversation this Thread works for, when the reader can open it. */
  readonly requester: RequesterLink | null;
}): ReactNode {
  const { requester } = props;
  return (
    <View style={styles.header}>
      {/* Above everything it did: the way back to the work it was for. */}
      {requester === null ? null : (
        <Pressable
          accessibilityLabel={`Back to ${requester.title}`}
          accessibilityRole="link"
          onPress={() => props.onOpenRequester(requester.threadId)}
          style={({ pressed }) => [styles.requester, pressed && styles.requesterPressed]}
        >
          <Symbol name="chevron.left" size={11} tint={color.muted} />
          <ThreadMark threadId={requester.threadId} />
          <AppText numberOfLines={1} role="caption" style={styles.requesterTitle} tone="muted">
            {requester.title}
          </AppText>
        </Pressable>
      )}
      {props.earlier ? (
        <View style={styles.earlier}>
          {props.loadingEarlier ? (
            <ActivityIndicator color={color.muted} size="small" />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={props.onLoadEarlier}
              style={styles.loadEarlier}
            >
              <AppText role="caption" tone="muted">
                Load earlier activity
              </AppText>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

const noWaiting: readonly WaitingInput[] = [];

/** A message as a quote: who wrote it, and enough of it to recognize. */
function draftQuoteFrom(message: MessageEntry): ThreadDraftQuote {
  const excerpt = message.body.replaceAll(/\s+/gu, " ").trim();
  return {
    attribution: messageAuthorName(message.author),
    excerpt: excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt,
    messageId: message.id,
  };
}

/** Where something a link names stands: the row to put the reader at, and the Activity to open. */
interface LinkedPlace {
  /** In a conversation, the turn whose Activity holds it; null for what the conversation shows itself. */
  readonly activityKey: string | null;
  /**
   * The row the link opens, once: a message whose words may be folded, or in a
   * task the answered turn whose folded steps hold it.
   */
  readonly openKey: string | null;
  /** Its drawn row, or -1 when it has none. */
  readonly index: number;
}

/**
 * Where a linked entry stands: its own row, or the turn it is in. In a
 * conversation, something said or asked on the way to a reply is in that
 * reply's Activity, so the reader is put at the reply's row and Activity
 * opens, even when the reply has no row of its own to be put at yet. Null
 * while the transcript does not hold it.
 */
function linkedPlace(
  entryId: string,
  view: {
    readonly conversational: boolean;
    readonly drawn: readonly ConversationRow[];
    readonly groups: readonly TranscriptGroup[];
  },
): LinkedPlace | null {
  const { drawn, groups } = view;
  const activityKey = view.conversational ? conversationTurnRevealing(groups, entryId) : null;
  const reply =
    activityKey === null
      ? null
      : (conversationActivityTurn(groups, { key: activityKey, kind: "turn" })?.key ?? null);
  const index = drawn.findIndex(({ group }) =>
    reply !== null
      ? group.key === reply
      : group.kind === "message" || group.kind === "question"
        ? group.entry.id === entryId
        : group.kind === "turn" && group.turn.work.some(({ id }) => id === entryId),
  );
  if (index < 0 && activityKey === null) return null;
  const group = drawn[index]?.group;
  const openKey =
    group?.kind === "message" ||
    (!view.conversational &&
      group?.kind === "turn" &&
      turnFolds(group.turn) &&
      !turnWords(group.turn).some(({ id }) => id === entryId))
      ? group.key
      : null;
  return { activityKey, index, openKey };
}

/**
 * The groups from before, wherever the new ones say the same thing. The reducer
 * replaces an entry only when that entry changed, so identity across a group's
 * entries settles the question without looking inside any of them.
 */
function reuseUnchangedGroups(
  previous: readonly TranscriptGroup[],
  next: readonly TranscriptGroup[],
): readonly TranscriptGroup[] {
  const held = new Map(previous.map((group) => [group.key, group]));
  return next.map((group) => {
    const prior = held.get(group.key);
    return prior !== undefined && sameGroup(prior, group) ? prior : group;
  });
}

function sameGroup(left: TranscriptGroup, right: TranscriptGroup): boolean {
  if (left.kind === "turn") {
    return (
      right.kind === "turn" &&
      left.turn.run === right.turn.run &&
      left.turn.personWaiting === right.turn.personWaiting &&
      left.turn.startedBy === right.turn.startedBy &&
      left.turn.source?.task === right.turn.source?.task &&
      left.turn.source?.createdAt === right.turn.source?.createdAt &&
      left.turn.continued === right.turn.continued &&
      left.turn.inputQueuePaused === right.turn.inputQueuePaused &&
      left.turn.startHold === right.turn.startHold &&
      sameEntries(left.turn.work, right.turn.work) &&
      sameEntries(left.turn.nodes ?? [], right.turn.nodes ?? []) &&
      left.turn.reply === right.turn.reply &&
      sameEntries(left.turn.assignments, right.turn.assignments)
    );
  }
  return (
    right.kind !== "turn" &&
    right.kind === left.kind &&
    left.entry === right.entry &&
    (left.kind !== "message" || (right.kind === "message" && left.joinedRun === right.joinedRun))
  );
}

function sameEntries(left: readonly object[], right: readonly object[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Opening reads back past turns it does not draw, so "nothing yet" waits for that. */
function EmptyThread(props: { readonly loading: boolean; readonly voice: boolean }): ReactNode {
  if (props.loading)
    return (
      <View style={styles.empty}>
        <AppText role="secondary" tone="muted">
          Loading messages…
        </AppText>
      </View>
    );
  return (
    <View style={styles.empty}>
      <AppText role="displaySmall">
        {props.voice ? "Say what you need done" : "What would you like to do?"}
      </AppText>
      <AppText role="secondary" tone="muted">
        {props.voice
          ? "Talk to Opensteer and it starts the work, keeps you posted and asks when it needs you."
          : "Ask a question or describe a task."}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  centred: { flex: 1, gap: space[12], justifyContent: "center" },
  // The title's menu sizes to its own words, so the column holds it at the
  // start rather than stretching it across the pane.
  // One height whether it offers the page or shows it loading, so the swap
  // never nudges the transcript under it.
  earlier: {
    alignItems: "center",
    minHeight: touchTarget,
    justifyContent: "center",
    marginBottom: space[8],
  },
  loadEarlier: { minHeight: touchTarget, justifyContent: "center", paddingHorizontal: space[12] },
  empty: { gap: space[12], paddingVertical: space[48] },
  header: { gap: space[8] },
  requester: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.xs,
    flexDirection: "row",
    gap: space[4],
    marginLeft: -space[6],
    maxWidth: "100%",
    minHeight: touchTarget,
    paddingHorizontal: space[6],
  },
  requesterPressed: { ...material.quiet },
  requesterTitle: { flexShrink: 1 },
  jump: {
    ...material.float,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[16] - (1 - StyleSheet.hairlineWidth),
    // Lifted off the transcript it floats over.
    zIndex: 6,
  },
  // Clear of the composer beneath it: the pill is an offer, and an offer that
  // touches the thing it sits on reads as part of it.
  jumpHome: { alignItems: "center", left: 0, position: "absolute", right: 0 },
  jumpPressed: { ...material.floatPressed },
  passwords: { marginTop: space[10] },
  hidden: { display: "none" },
});

/** The item a transcript row stands for: its first, which is what an anchor names. */
function rowItemId(row: TranscriptItem): string | undefined {
  if (row.kind !== "group") return undefined;
  const group = row.group;
  const entry =
    group.kind === "turn"
      ? (group.turn.work[0] ?? group.turn.reply ?? group.turn.run)
      : group.entry;
  return (entry && ("itemId" in entry ? (entry.itemId ?? entry.id) : entry.id)) || undefined;
}
