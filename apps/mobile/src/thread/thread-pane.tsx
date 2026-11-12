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
  type SurfaceDestination,
  type ThreadActivityIndicator,
  type TranscriptGroup,
  type TranscriptVoice,
  type ThreadSummary,
} from "@opensteer/client/host";
import { computerUseNowSummary, threadComputerUseNow } from "@opensteer/client/integrations";
import type { BrowserPageContentPart, TeamTaskOrigin } from "@opensteer/core";
import { AudienceLine, TaskSourceChip } from "../home/task-source.js";
import { useTeamsSnapshot } from "../team/team-context.js";
import { folderLabel } from "../home/folder-label.js";
import { useHostSnapshot, useThreadInputQueue } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import { conversationActions } from "./conversation-actions.js";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
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
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated from "react-native-reanimated";
import { canRespondToRequests, showsHostLive } from "@opensteer/client/host";
import type { ThreadDraftQuote } from "../client/thread-drafts.js";
import type { ArtifactContentPart } from "@opensteer/core";
import {
  paramsDestination,
  sameDestination,
  surfaceRoute,
  type OpensteerAppDestination,
} from "../browser/surface-route.js";
import { operationDetail } from "../client/mobile-client.js";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { enter, exit } from "../ui/motion.js";
import { AppText, Notice } from "../ui/primitives.js";
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
import { Composer } from "./composer.js";
import { ConversationLinksProvider } from "./conversation-links.js";
import { ComposerDockLayout } from "./composer-dock.js";
import { AgentEngine } from "./agent-mark.js";
import { AgentListNestedContext, AgentMemoryContext } from "./subagent-rows.js";
import { RunningNowCapsule } from "./running-now.js";
import { RunPageSlot } from "./run-page.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";
import { QueuedMessages } from "./queued-messages.js";
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
  /** Where the task works or came from: its folder, or "#support" for a team's ask. */
  readonly placeName: string | null;
  readonly placeKind: "folder" | "team" | null;
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
    left.placeName === right.placeName &&
    left.placeKind === right.placeKind &&
    left.icon === right.icon &&
    left.color === right.color &&
    left.isVoice === right.isVoice &&
    sameTaskHeading(left.task, right.task)
  );
}

/** How close to the bottom still counts as watching the newest entry. */
const tailThreshold = 96;
/** How close to the top asks for the page before this one. */
const headThreshold = 160;

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
   * Parent offset in screen coordinates. It is zero in both layouts this app
   * ships, and for the same reason: `KeyboardAvoidingView` measures itself
   * against its parent, and under a transparent header — the Thread screen's —
   * or a large-title one — the split's — that parent already starts at the top
   * of the window, so the header contributes nothing to add back.
   */
  readonly keyboardVerticalOffset?: number;
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
    agentHome: snapshot.personalSettings?.agentHome ?? null,
    voiceThreadId: snapshot.voiceThreadId,
    environments: snapshot.environments,
    harnesses: snapshot.harnesses,
    machines: snapshot.machines,
    waitingRequests: snapshot.waitingRequests,
    thread: snapshot.threads.find(({ id }) => id === threadId) ?? null,
    entries: snapshot.transcripts[threadId],
    window: snapshot.transcriptWindows[threadId],
    ownRequests: snapshot.requests[threadId],
    lookup: snapshot.threadLookups[threadId],
    readState: snapshot.threadReadStates[threadId],
    runQueue: snapshot.runQueue.filter((run) => run.threadId === threadId),
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
      case "runQueue":
        return sameEntries(left.runQueue, right.runQueue);
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
  // Keep the shared hook's load/retry lifecycle, using its store equality support.
  const state = useHostSnapshot(props.hostClient, isEqual);
  const selection = useMemo(() => select(state.snapshot), [select, state.snapshot]);
  return (
    <ThreadPaneForUser
      {...props}
      key={`${props.deploymentId}:${state.snapshot.user?.id ?? "signed-out"}:${props.threadId}`}
      loadError={state.loadError}
      reload={state.reload}
      snapshot={selection}
    />
  );
}

function ThreadPaneForUser(
  props: ThreadPaneProps & {
    readonly loadError: string | null;
    readonly reload: () => Promise<void>;
    readonly snapshot: ThreadPaneSelection;
  },
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
  const { loadError, reload, snapshot } = props;
  const viewerUserId = snapshot.user?.id ?? null;
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  const pinned = useRef(true);
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
  // the content's padding, so until every row above has been measured it
  // stops short of the newest entry; these two numbers never do.
  const extent = useRef({ content: 0, viewport: 0 });
  const scrollToLatest = useCallback((animated: boolean): void => {
    const { content, viewport } = extent.current;
    listRef.current?.scrollToOffset({ animated, offset: Math.max(0, content - viewport) });
  }, []);
  const [atTail, setAtTail] = useState(true);
  // How far below the bar the transcript starts, under the Run's page.
  const [pageInset, setPageInset] = useState(0);
  // True while the reader is held in a window loaded around an older update.
  // The live conversation is not on screen, so the foot of what is is not the
  // conversation's tail and nothing here may treat it as one.
  const [historical, setHistorical] = useState(false);
  const [returning, setReturning] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pendingMutationOwner = (): ThreadMutationOwner | null =>
    viewerUserId !== null &&
    client.drafts.readPending(props.deploymentId, viewerUserId, props.threadId) !== null
      ? "message"
      : null;
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
  useFocusEffect(
    useCallback(() => {
      // The Host holds one active Thread. A task stays mounted under the one
      // over it, a tablet shows a task beside the list and a narrow window keeps a
      // page's companion out of view, so the pane in front of the reader claims
      // it as it comes into view, not merely as it mounts.
      if (!inView) return;
      hostClient.activateThread(threadId);
      return notifications.enterThread({ deploymentId, threadId });
    }, [deploymentId, hostClient, inView, notifications, threadId]),
  );
  // Whether this conversation is the screen in front of the reader. Read
  // markers and alert suppression both depend on it: a pane under another
  // screen, or kept out of view in its own, sees nothing, including on the
  // render it first mounts on. The sidebar covers the screen without blurring
  // the route under it, so it counts as looking away too.
  const sidebarVisible = useSidebarVisible();
  const focused = useIsFocused() && !sidebarVisible && inView;
  // What an arriving alert has to know before it interrupts: an alert about
  // the conversation in front of the reader, at its latest activity, is telling
  // them what they are already watching.
  useEffect(() => {
    notifications.readingLatest(
      { deploymentId, threadId: props.threadId },
      focused && atTail && !historical,
    );
  }, [atTail, deploymentId, focused, historical, notifications, props.threadId]);

  const inputQueue = useThreadInputQueue(hostClient, threadId);
  // A queued message taken back to be reworded, on its way into the composer.
  const [restoredDraft, setRestoredDraft] = useState<{
    readonly attachments?: readonly ArtifactContentPart[];
    readonly key: number;
    readonly quote?: ThreadDraftQuote | null;
    readonly text: string;
  } | null>(null);
  const restoreQueuedDraft = useCallback(
    (message: { readonly attachments: readonly ArtifactContentPart[]; readonly text: string }) =>
      setRestoredDraft((current) => ({ ...message, key: (current?.key ?? 0) + 1 })),
    [],
  );

  const thread = snapshot.thread;
  const canRespond = canRespondToRequests(snapshot);
  const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
  const live = showsHostLive(snapshot) && environment?.status === "connected";
  const connectionLabel =
    canRespond && environment?.status === "disconnected" ? `${environment.name} offline` : null;

  const entries = useMemo(() => snapshot.entries ?? [], [snapshot.entries, threadId]);
  // The Host names the subagent behind each Request waiting on this reader;
  // the loaded transcript names the ones behind a Request someone else answers.
  const subagentTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const entry of entries) if (entry.kind === "node") titles.set(entry.nodeId, entry.title);
    for (const { subagent } of snapshot.waitingRequests) {
      if (subagent !== null) titles.set(subagent.id, subagent.title);
    }
    return titles;
  }, [entries, snapshot.waitingRequests]);
  // A voice conversation reads as messages, each reply's steps in its
  // Activity; a task keeps its whole trace in view.
  const conversational = thread?.purpose === "voice";
  // A manager the person talks to: no composer, and its calls open with a divider.
  const voiceThread = snapshot.voiceThreadId === threadId;
  const onCall = useVoiceOn();
  // On a call the bar carries what needs the person, so the pane docks it nowhere else.
  const askedRequestId = useVoiceAskedRequest();
  // In work, a message waiting behind the current turn stands in the tray
  // above the composer until a Run takes it. A conversation has no tray: what
  // the reader just sent is drawn as sent.
  const conversation = useMemo(
    () =>
      withoutOwnAssignment(
        visibleTranscript(entries, inputQueue, { conversation: conversational }),
        threadId,
      ),
    [conversational, entries, inputQueue, threadId],
  );
  const inputQueuePaused = thread?.inputQueuePaused ?? false;
  // What this client holds of the account is current only while it is live.
  const startHold =
    live && thread !== null
      ? threadStartHold({
          environments: snapshot.environments,
          runQueue: snapshot.runQueue,
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
  // The same answer every surface gives: what this Thread is doing, and
  // which Run, if any, a Stop would reach.
  const activity =
    thread === null ? "idle" : threadActivity({ entries, runQueue: snapshot.runQueue, thread });
  const stopTarget =
    thread === null ? null : threadStopTarget({ runQueue: snapshot.runQueue, thread });
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
  const canLoadEarlier = snapshot.window?.hasMore ?? false;

  // A link may name the Request it is about. A Request still pending is docked
  // in the composer, which is already on screen; one already answered left its
  // record among the steps of the turn that asked it, and the link goes there.
  const { onOpenThread, requestId } = props;
  const receiptId = useMemo(() => {
    if (requestId === null) return null;
    for (const group of groups) {
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
    if (anchorMessageId === null || anchored.current === anchorMessageId) return;
    anchored.current = anchorMessageId;
    // Before the fetch, not after: the client pins this Thread to the
    // historical window as it answers, and a render in between would read the
    // foot of the old page as the tail and mark it read.
    setHistorical(true);
    pinned.current = false;
    setAtTail(false);
    void hostClient.loadTranscriptAround(threadId, anchorMessageId).catch((error: unknown) => {
      setFailure(operationDetail(error, "That update could not be opened."));
    });
  }, [anchorMessageId, hostClient, threadId]);

  /** Puts the live conversation back and returns the reader to its foot. */
  const returnToLatest = useCallback((): void => {
    if (returning) return;
    setReturning(true);
    setFailure(null);
    void hostClient
      .loadLatestTranscript(threadId)
      .then(() => {
        // The anchor is spent. It is released on the route too, so opening the
        // same message again is a new jump rather than a no-op.
        anchored.current = null;
        anchorShown.current = null;
        props.onAnchorReleased?.();
        setHistorical(false);
        pinned.current = true;
        setAtTail(true);
        scrollToLatest(false);
      })
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "The latest activity could not be loaded."));
      })
      .finally(() => setReturning(false));
  }, [hostClient, props.onAnchorReleased, returning, scrollToLatest, threadId]);
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

  const loadEarlier = useCallback(() => {
    if (paging.current || !canLoadEarlier) return;
    paging.current = true;
    setFailure(null);
    setLoadingEarlier(true);
    void hostClient
      .loadEarlierTranscript(threadId)
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "Earlier activity could not be loaded."));
      })
      .finally(() => {
        paging.current = false;
        setLoadingEarlier(false);
      });
  }, [canLoadEarlier, hostClient, threadId]);

  const pendingRequest =
    requestId !== null && (snapshot.ownRequests ?? []).some((request) => request.id === requestId);
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
  const teamOrigin = thread?.teamOrigin ?? null;
  const channelName = useChannelName(teamOrigin?.teamId ?? null, teamOrigin?.channelId ?? null);
  const placeKind = thread === null ? null : teamOrigin !== null ? "team" : "folder";
  const placeName =
    thread === null
      ? null
      : teamOrigin !== null
        ? `#${channelName ?? "channel"}`
        : folderLabel(thread.folder, snapshot.agentHome);
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
      placeName,
      placeKind,
      icon,
      color: markColor,
      isVoice: voiceThread,
    });
  }, [
    connectionLabel,
    headerTitle,
    onHeader,
    task,
    placeName,
    placeKind,
    icon,
    markColor,
    voiceThread,
  ]);

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
        pinned.current = false;
        setAtTail(false);
        listRef.current?.scrollToIndex({ animated: false, index: place.index, viewPosition: 0.5 });
      }
      const { openKey } = place;
      if (openKey !== null) {
        setOpenRows((open) =>
          open.get(openKey) === true ? open : new Map(open).set(openKey, true),
        );
      }
      if (place.activityKey !== null) openActivity(place.activityKey, entryId);
    },
    [openActivity],
  );
  useEffect(() => {
    if (anchorMessageId === null || anchor === null || anchorShown.current === anchorMessageId) {
      return;
    }
    // A sheet opens over the screen in front of the reader, never under it.
    if (anchor.activityKey !== null && !focused) return;
    anchorShown.current = anchorMessageId;
    reveal(anchor, anchorMessageId);
  }, [anchor, anchorMessageId, focused, reveal]);
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
  const inFront = useCallback(
    (destination: SurfaceDestination | OpensteerAppDestination) => {
      const state = navigation.getState();
      const current = state?.routes[state.index];
      return (
        current?.name === "WorkspaceBrowser" &&
        sameDestination(paramsDestination(current.params), destination)
      );
    },
    [navigation],
  );
  const showTab = props.withPage?.showTab ?? null;
  const openSurface = useCallback(
    (destination: SurfaceDestination | OpensteerAppDestination) => {
      if (inFront(destination)) return;
      if (destination.kind === "browser" && showTab !== null) {
        showTab(destination);
        return;
      }
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", surfaceRoute(deploymentId, threadId, destination)),
      );
    },
    [deploymentId, inFront, navigation, showTab, threadId],
  );
  const appTabs = useMemo<TranscriptAppTabs>(
    () => ({
      leave: (appId) => {
        if (inFront({ appId, kind: "opensteer-app" })) navigation.dispatch(StackActions.pop(1));
      },
      open: (appId) => openSurface({ appId, kind: "opensteer-app" }),
    }),
    [inFront, navigation, openSurface],
  );
  const surfaces = useMemo<TranscriptSurfaces>(
    () => ({ hostClient, threadId, turns: surfaceTurns, open: openSurface }),
    [hostClient, openSurface, surfaceTurns, threadId],
  );
  /** Quotes a reply into this conversation's own composer, unsent. */
  const replyWith = useCallback((message: MessageEntry): void => {
    const quote = draftQuoteFrom(message);
    setRestoredDraft((current) => ({ key: (current?.key ?? 0) + 1, quote, text: "" }));
  }, []);

  const incomingMessages = useMemo(
    () => incomingTranscriptMessages(conversation, viewerUserId, conversational),
    [conversation, conversational, viewerUserId],
  );
  const observed = useMemo(
    () => observedSequence(conversation, conversational),
    [conversation, conversational],
  );
  useEffect(() => {
    if (pinned.current) {
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
    () => (snapshot.ownRequests ?? []).filter(({ id }) => id !== askedRequestId),
    [askedRequestId, snapshot.ownRequests],
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
    () => snapshot.runQueue.filter((run) => run.threadId === threadId),
    [snapshot.runQueue, threadId],
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
    return rows;
  }, [conversational, drawn, groups, indicator, outcomes, viewerUserId]);

  const queueCanRespond = canRespond && thread?.status !== "archived";
  const queueFooter = useMemo(
    () =>
      thread !== null && !conversational && inputQueue !== null ? (
        <TranscriptHostClientContext value={hostClient}>
          <QueuedMessages
            canRespond={queueCanRespond}
            hostClient={hostClient}
            onEdit={restoreQueuedDraft}
            queue={inputQueue}
            viewerUserId={viewerUserId}
          />
        </TranscriptHostClientContext>
      ) : null,
    [
      thread,
      conversational,
      inputQueue,
      queueCanRespond,
      hostClient,
      restoreQueuedDraft,
      viewerUserId,
    ],
  );
  const passwordsOffer = useMemo(() => passwordsSetupOffer(groups), [groups]);
  const listFooter =
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

  // Never under a finger: the list moves only where the reader puts it.
  const keepPinned = (): void => {
    if (pinned.current && !dragging.current) scrollToLatest(false);
  };

  // Read is marked for what this reader actually reached: the foot of the
  // conversation, on the screen in front of them, with the app in front of
  // them. A background subscription observes nothing, and marks nothing.
  const readState = snapshot.readState ?? null;
  // What this screen has actually shown as published here. The Host's
  // `unreadSequence` is not that: it names content no page may have rendered,
  // so marking it would swallow history nobody saw.
  const markedSequence = readState?.readSequence ?? null;
  const readKnown = readState !== null;
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    // Until this reader's position arrives, a mark could only repeat it.
    if (!readKnown || !focused || !atTail || !appActive || historical) return;
    if (observed === null) return;
    if (markedSequence !== null && BigInt(markedSequence) >= BigInt(observed)) return;
    void hostClient.markThreadRead(threadId, observed).catch(() => {
      // The next time they reach the foot marks it again; a read marker is
      // not worth interrupting anybody for.
    });
  }, [
    appActive,
    atTail,
    focused,
    historical,
    hostClient,
    markedSequence,
    observed,
    readKnown,
    threadId,
  ]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const fromTail = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const tail = fromTail < tailThreshold;
    // Only the reader's own finger takes them off the newest entry. The list
    // also moves by itself — rows measured after the jump to the end, a page
    // arriving above, the dock growing as a Request docks — and reading any of
    // those as "scrolled up" strands a reader who never touched it. Each of
    // them changes the content or the list's size, and `keepPinned` answers
    // that; returning here also lets an animated jump to the end finish.
    if (!tail && !dragging.current && !flinging.current) return;
    pinned.current = tail;
    // Only a change repaints: a scroll fires many times a second and the pill
    // is the only thing on screen that depends on it.
    setAtTail((current) => (current === tail ? current : tail));
    if (contentOffset.y < headThreshold && contentSize.height > layoutMeasurement.height && !tail)
      loadEarlier();
  };

  if (thread === null) {
    return (
      <View style={[styles.centred, sides]}>
        {loadError !== null ? (
          <Notice
            title="This thread could not be loaded"
            detail={loadError}
            action={{ label: "Try again", onPress: () => void reload().catch(() => undefined) }}
          />
        ) : snapshot.lookup === "failed" ? (
          <Notice
            title="This thread could not be loaded"
            detail="Check your connection and try again."
            action={{ label: "Try again", onPress: () => hostClient.activateThread(threadId) }}
          />
        ) : snapshot.lookup === "missing" ? (
          <Notice
            detail="It may have been deleted, or it belongs to another deployment."
            title="This thread is not here"
            tone="neutral"
          />
        ) : (
          <AppText role="secondary" tone="muted">
            Opening this thread…
          </AppText>
        )}
      </View>
    );
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
      <FlatList
        automaticallyAdjustsScrollIndicatorInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[
          column,
          {
            ...sides,
            paddingBottom: clearance + space[16],
            paddingTop: headerClearance + pageInset + space[8],
          },
        ]}
        data={items}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.key}
        ListFooterComponent={listFooter}
        // Beside a page, before anything has been said, the page is the subject.
        ListEmptyComponent={
          companion === null ? (
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
        // The list also changes height on its own as the keyboard opens; the
        // composer growing changes its content's clearance instead.
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
        onScrollBeginDrag={() => {
          dragging.current = true;
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
        // The pill and the load-earlier trigger both read scroll position, so
        // the list reports it every frame rather than every fourth one.
        scrollEventThrottle={16}
        scrollIndicatorInsets={{ bottom: clearance, top: headerClearance + pageInset }}
      />
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
        />
      )}
      {/* An older window has to be left deliberately, and the way out is to
          load the live conversation — so the offer stands there whether or
          not anything new has arrived since. */}
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
              pinned.current = true;
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
    </View>
  );
  const dock = (
    <>
      {/* An older window can't say what runs now; back at the latest, it returns. */}
      {snapshot.user === null || voiceThread || historical ? null : (
        <RunningNowCapsule
          hostClient={hostClient}
          onOpen={openRunningNow}
          reachable={live}
          threadId={threadId}
        />
      )}
      {failure !== null ? (
        <Notice
          action={{ label: "Dismiss", onPress: () => setFailure(null) }}
          detail={failure}
          title="Something did not work"
        />
      ) : loadError !== null && canRespond ? (
        <Notice
          action={{ label: "Try again", onPress: () => void reload().catch(() => undefined) }}
          detail={loadError}
          title="This thread could not be loaded"
        />
      ) : snapshot.lookup === "failed" ? (
        <Notice
          action={{ label: "Try again", onPress: () => hostClient.activateThread(threadId) }}
          detail="Check your connection and try again."
          title="Messages could not be loaded"
        />
      ) : null}
      {snapshot.user === null ? null : (
        <>
          {voiceThread && onCall ? null : (
            <ThreadServerApprovals hostClient={hostClient} threadId={thread.id} />
          )}
          {voiceThread && onCall ? null : (
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
            <View>
              {teamOrigin === null ? null : (
                <TeamTaskSource channelName={channelName} origin={teamOrigin} />
              )}
              <Composer
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
                conversationActions={actionsBesidePage}
                page={companion?.page ?? null}
                onChangeModel={openSettings}
                placeholder={
                  teamOrigin !== null
                    ? "Message your agent privately"
                    : threadComposerPlaceholder(items.length === 0 && !canLoadEarlier)
                }
                requests={dockableRequests}
                restore={restoredDraft}
                running={stopTarget !== null}
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
                subagentTitles={subagentTitles}
                threadId={thread.id}
                user={snapshot.user}
              />
            </View>
          )}
        </>
      )}
    </>
  );
  return (
    <TaskScopeContext.Provider value={taskScope}>
      <AgentEngine value={placement?.driverKind ?? null}>
        <AgentMemoryContext value={agentMemory}>
          <AgentListNestedContext value>
            <TranscriptComputersContext.Provider value={computers}>
              <TranscriptSurfacesContext.Provider value={surfaces}>
                <TranscriptAppTabsContext.Provider value={appTabs}>
                  {/* Beside a page, the screen already keeps the keyboard clear. */}
                  <ConversationLinksProvider
                    deploymentId={deploymentId}
                    hostClient={hostClient}
                    threadId={threadId}
                  >
                    <ComposerDockLayout
                      avoidKeyboard={companion === null}
                      dock={dock}
                      keyboardVerticalOffset={props.keyboardVerticalOffset ?? 0}
                    >
                      {transcript}
                    </ComposerDockLayout>
                  </ConversationLinksProvider>
                </TranscriptAppTabsContext.Provider>
              </TranscriptSurfacesContext.Provider>
            </TranscriptComputersContext.Provider>
          </AgentListNestedContext>
        </AgentMemoryContext>
      </AgentEngine>
    </TaskScopeContext.Provider>
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
      : group.kind === "message"
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
  teamSource: { gap: space[6], paddingBottom: space[6] },
  body: { flex: 1 },
  centred: { flex: 1, gap: space[12], justifyContent: "center" },
  // The title's menu sizes to its own words, so the column holds it at the
  // start rather than stretching it across the pane.
  earlier: { alignItems: "center", paddingBottom: space[8] },
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
});

/** A team channel's name, as the team this phone holds says it; null until it has. */
function useChannelName(teamId: string | null, channelId: string | null): string | null {
  const team = useTeamsSnapshot().teams.find((candidate) => candidate.teamId === teamId) ?? null;
  const session = team?.session ?? null;
  const read = useCallback(
    () =>
      session?.getSnapshot().sidebar?.channels.find((row) => row.channel.id === channelId)?.channel
        .name ?? null,
    [channelId, session],
  );
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Above a team task's composer: the way back to the thread that asked, and who
 * sees what the agent posts. Words typed here stay private to the task.
 */
function TeamTaskSource(props: {
  readonly origin: TeamTaskOrigin;
  readonly channelName: string | null;
}): ReactNode {
  const navigation = useNavigation();
  const team = useTeamsSnapshot().teams.find(
    (candidate) => candidate.teamId === props.origin.teamId,
  );
  const place = `#${props.channelName ?? "channel"}`;
  const available = team !== undefined && team.state !== "removed";
  return (
    <View style={styles.teamSource}>
      <TaskSourceChip
        onOpen={() =>
          navigation.navigate("TeamThread", {
            teamId: props.origin.teamId,
            channelId: props.origin.channelId,
            rootId: props.origin.threadRootId,
          })
        }
        source={{
          team: { id: props.origin.teamId, name: team?.name ?? "Team", imageUri: null },
          place,
          thread: "thread",
          available,
        }}
      />
      {available ? <AudienceLine text={`Replies post to ${place} in ${team.name}.`} /> : null}
    </View>
  );
}
