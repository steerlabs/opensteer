import {
  type AskAbout,
  askAboutLabel,
  messageAuthorName,
  conversationActivityTurn,
  conversationActivities,
  conversationSurfaces,
  conversationRows,
  conversationTurnRevealing,
  groupTranscriptEntries,
  incomingTranscriptMessages,
  observedSequence,
  threadActivity,
  threadActivityIndicator,
  threadPlacementOptions,
  threadComposerPlaceholder,
  threadStartHold,
  threadRequester,
  threadStopTarget,
  turnFolds,
  visibleTranscript,
  withoutOwnAssignment,
  type HostClient,
  type HostSnapshot,
  type ConversationRow,
  type MessageEntry,
  type RequesterLink,
  type SurfaceDestination,
  type ThreadActivityIndicator,
  type TranscriptGroup,
  type Turn,
  type WorkspaceSummary,
  type ThreadSummary,
} from "@opensteer/client/host";
import { computerUseNowSummary, threadComputerUseNow } from "@opensteer/client/integrations";
import { CHAT_THREAD_TITLE, type BrowserPageContentPart } from "@opensteer/core";
import { useHostSnapshot, useThreadInputQueue } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated from "react-native-reanimated";
import { canRespondToRequests, describeHostConnection } from "@opensteer/client/host";
import type { ThreadDraftQuote } from "../client/thread-drafts.js";
import type { ArtifactContentPart } from "@opensteer/core";
import { paramsDestination, sameDestination, surfaceRoute } from "../browser/surface-route.js";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { enter, exit } from "../ui/motion.js";
import { AppText, Notice, TypingDots } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter, useReadingColumn } from "../ui/screen.js";
import { TaskScopeContext, type TaskScope } from "./task-line.js";
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
import { waitingQuestion } from "./docked-requests.js";
import { FoldedRequest } from "./folded-request.js";
import { latestReplyLine } from "./latest-reply-line.js";
import { TranscriptSurfacesContext, type TranscriptSurfaces } from "./surface-chips.js";
import { AttachmentReader } from "./attachment-views.js";
import { Composer } from "./composer.js";
import { TabPreview } from "./tab-preview.js";
import { QueuedMessages } from "./queued-messages.js";
import {
  TranscriptComputersContext,
  computerLine,
  useKeptComputerStop,
  type TranscriptComputers,
} from "./computer-use-line.js";
import { homeIntroDraftKey } from "../screens/home-intro.js";
import { useSidebarVisible } from "../sidebar/sidebar-context.js";
import { settingsDisabledReason } from "./settings/settings-controller.js";
import {
  TranscriptGroupRow,
  WorkingIndicator,
  firstUnreadGroupKey,
  replyActivityKeys,
  transcriptSpacing,
  transcriptVoice,
} from "./transcript.js";
import type { ThreadMutationOwner } from "./thread-mutation-gate.js";
import { useThreadMutation } from "./thread-mutation-registry.js";

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
      readonly group: TranscriptGroup;
      readonly key: string;
      readonly kind: "group";
      /** A task this Thread was doing that ended with this turn, said under it. */
      readonly outcome: TaskOutcome | null;
      /** The air above this row, decided from what spoke before it. */
      readonly spacingTop: number;
      /** True for the row the "New" divider stands above. */
      readonly unreadBoundary: boolean;
    }
  | { readonly indicator: ThreadActivityIndicator; readonly key: string; readonly kind: "working" };

/**
 * What the navigation bar says about this Thread: primitives only, so a header
 * that has not changed does not rebuild, and a streamed token never reaches the
 * bar at all.
 */
export interface ThreadHeaderState {
  /** The pages and Mac apps the conversation is using, including work it handed out. */
  readonly surfaceCount: number;
  /** An agent is acting in one of them now. */
  readonly surfacesActing: boolean;
  readonly connectionLabel: string | null;
  readonly canRetry: boolean;
  readonly title: string;
  readonly workspaceName: string | null;
  readonly workspaceId: string | null;
  readonly workspaceColor: WorkspaceSummary["color"];
  readonly workspaceIcon: WorkspaceSummary["icon"];
  readonly icon: ThreadSummary["icon"];
  readonly color: ThreadSummary["color"];
  readonly isHome: boolean;
  /** The work this Thread is doing for another conversation, or null. */
  readonly task: TaskHeading | null;
}

export function sameThreadHeader(
  left: ThreadHeaderState | null,
  right: ThreadHeaderState,
): boolean {
  return (
    left !== null &&
    left.surfaceCount === right.surfaceCount &&
    left.surfacesActing === right.surfacesActing &&
    left.connectionLabel === right.connectionLabel &&
    left.canRetry === right.canRetry &&
    left.title === right.title &&
    left.workspaceName === right.workspaceName &&
    left.workspaceId === right.workspaceId &&
    left.workspaceColor === right.workspaceColor &&
    left.workspaceIcon === right.workspaceIcon &&
    left.icon === right.icon &&
    left.color === right.color &&
    left.isHome === right.isHome &&
    sameTaskHeading(left.task, right.task)
  );
}

/** Room enough, under a page, to read some of the conversation rather than its last line. */
const roomyHeight = 140;

/** How close to the bottom still counts as watching the newest entry. */
const tailThreshold = 96;
/** How close to the top asks for the page before this one. */
const headThreshold = 160;

interface ThreadPaneProps {
  readonly deploymentId: string;
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
  /** Clears `quote` once it is in the composer. */
  readonly onQuoteTaken?: () => void;
  /**
   * An update from another Thread to answer here, handed to the composer that
   * is already on screen. It is in this Thread's saved draft already.
   */
  readonly quote?: ThreadDraftQuote | null;
  readonly requestId: string | null;
  /**
   * Docked under a focused page or Mac app: collapsed, only the latest reply
   * and the composer; expanded, the transcript too. The page is what the
   * composer includes with the next message.
   */
  readonly sheet?: ConversationSheetMode | undefined;
  readonly threadId: string;
}

export interface ConversationSheetMode {
  readonly expanded: boolean;
  readonly onExpand: (expanded: boolean) => void;
  readonly page: BrowserPageContentPart | null;
}

/** The pane's complete read set; maps and run entries are scoped to this Thread. */
function selectThreadPane(snapshot: HostSnapshot, threadId: string) {
  return {
    assignments: snapshot.assignments,
    browserSessions: snapshot.browserSessions,
    browserProfiles: snapshot.browserProfiles,
    connection: snapshot.connection,
    network: snapshot.network,
    session: snapshot.session,
    user: snapshot.user,
    homeThreadId: snapshot.homeThreadId,
    environments: snapshot.environments,
    harnesses: snapshot.harnesses,
    machines: snapshot.machines,
    waitingRequests: snapshot.waitingRequests,
    workspaces: snapshot.workspaces,
    thread: snapshot.threads.find(({ id }) => id === threadId) ?? null,
    entries: snapshot.transcripts[threadId],
    window: snapshot.transcriptWindows[threadId],
    ownRequests: snapshot.requests[threadId],
    lookup: snapshot.threadLookups[threadId],
    readState: snapshot.threadReadStates[threadId],
    runQueue: snapshot.runQueue.filter((run) => run.threadId === threadId),
    // These helpers read requester/worker Threads and delegated work. Select their
    // answers against the full store so unrelated transcript maps cannot go stale.
    task: snapshot.homeThreadId === threadId ? null : taskHeading(snapshot, threadId),
    outcomes: taskOutcomes(snapshot, threadId),
    requester: snapshot.homeThreadId === threadId ? null : threadRequester(snapshot, threadId),
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
      case "workspaces":
        return sameWorkspaceMarks(left.workspaces, right.workspaces);
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
  // True while the reader is held in a window loaded around an older update.
  // The live conversation is not on screen, so the foot of what is is not the
  // conversation's tail and nothing here may treat it as one.
  const [historical, setHistorical] = useState(false);
  const [returning, setReturning] = useState(false);
  // Folded under a page with room to spare, the sheet shows the conversation's
  // latest rows rather than one line of them.
  const [roomy, setRoomy] = useState(false);
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
  const keyboardVisible = useKeyboardVisible();
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
  useFocusEffect(
    useCallback(() => {
      // The Host holds one active Thread. Chat stays mounted under every task
      // and a tablet shows a task beside the list, so the pane in front of the
      // reader claims it as it comes into view, not merely as it mounts.
      hostClient.activateThread(threadId);
      return notifications.enterThread({ deploymentId, threadId });
    }, [deploymentId, hostClient, notifications, threadId]),
  );
  // Whether this conversation is the screen in front of the reader. Read
  // markers and alert suppression both depend on it: a pane under another
  // screen sees nothing, including on the render it first mounts on. The
  // sidebar covers the screen without blurring the route under it, so it
  // counts as looking away too.
  const sidebarVisible = useSidebarVisible();
  const focused = useIsFocused() && !sidebarVisible;
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
  const handedQuote = props.quote ?? null;
  const onQuoteTaken = props.onQuoteTaken;
  useEffect(() => {
    if (handedQuote === null) return;
    setRestoredDraft((current) => ({ key: (current?.key ?? 0) + 1, quote: handedQuote, text: "" }));
    onQuoteTaken?.();
  }, [handedQuote, onQuoteTaken]);

  const thread = snapshot.thread;
  const connection = describeHostConnection(snapshot);
  const canRespond = canRespondToRequests(snapshot);
  const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
  const live = canRespond && environment?.status === "connected";
  const connectionLabel = !canRespond
    ? connection.label
    : environment?.status === "disconnected"
      ? `${environment.name} offline`
      : null;
  const canRetry = connection.action === "retry";

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
  // A conversation (Chat, a direct message) reads as messages, each reply's
  // steps in its Activity; work keeps its whole trace in view.
  const conversational = thread?.role === "conversation";
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

  // Where the divider goes is decided from the read marker as it stood on
  // arrival. Letting it follow the marker would move it out from under a
  // reader who is still reading. Null — never opened — has no inside boundary.
  const boundary = useRef<{ readonly sequence: string | null; readonly threadId: string }>({
    sequence: null,
    threadId: "",
  });
  const arrivalReadState = snapshot.readState ?? null;
  if (arrivalReadState !== null && boundary.current.threadId !== threadId) {
    boundary.current = { sequence: arrivalReadState.readSequence, threadId };
  }
  const boundaryKnown = boundary.current.threadId === threadId;
  const unreadBoundarySequence = boundaryKnown ? boundary.current.sequence : null;

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

  // Every agent event stamps its own workspace's `updatedAt`, so
  // `snapshot.workspaces` is a fresh array many times a second while a run
  // streams. A transcript row reads a workspace's name and its mark and nothing
  // else, so the array is held across rebuilds that change neither.
  const heldWorkspaces = useRef<readonly WorkspaceSummary[]>(snapshot.workspaces);
  const workspaces = useMemo(() => {
    if (!sameWorkspaceMarks(heldWorkspaces.current, snapshot.workspaces)) {
      heldWorkspaces.current = snapshot.workspaces;
    }
    return heldWorkspaces.current;
  }, [snapshot.workspaces]);

  // The navigation bar carries the Thread's name, its workspace and its state,
  // and it is fed primitives rather than the Thread: a title that has not
  // changed must not rebuild a header while the transcript streams under it.
  const workspace =
    thread === null ? null : (workspaces.find(({ id }) => id === thread.workspaceId) ?? null);
  const isHome = snapshot.homeThreadId === threadId;
  const headerTitle = isHome ? CHAT_THREAD_TITLE : (thread?.title ?? null);
  const workspaceName = isHome || workspace?.kind === "main" ? null : (workspace?.name ?? null);
  const workspaceColor = workspace?.color ?? null;
  const workspaceIcon = workspace?.icon ?? null;
  const icon = thread?.icon ?? null;
  const markColor = thread?.color ?? null;
  const workspaceId = thread?.workspaceId ?? null;
  const conversationPages = useMemo(
    () => conversationSurfaces(snapshot, threadId),
    [snapshot, threadId],
  );
  const surfaceCount = conversationPages.length;
  const surfacesActing = conversationPages.some((item) => item.acting);
  // The split heading's own width, which the title's menu is sized to.
  // Held while it reads the same, so the bar rebuilds only when the task moves.
  const heldTask = useRef<TaskHeading | null>(null);
  const task = useMemo(() => {
    const next = snapshot.task;
    if (!sameTaskHeading(heldTask.current, next)) heldTask.current = next;
    return heldTask.current;
  }, [isHome, snapshot, threadId]);
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
      surfaceCount,
      surfacesActing,
      connectionLabel,
      canRetry,
      task,
      title: headerTitle ?? "Thread",
      workspaceName,
      workspaceId,
      workspaceColor,
      workspaceIcon,
      icon,
      color: markColor,
      isHome,
    });
  }, [
    surfaceCount,
    surfacesActing,
    connectionLabel,
    canRetry,
    headerTitle,
    onHeader,
    task,
    workspaceId,
    workspaceName,
    workspaceColor,
    workspaceIcon,
    icon,
    markColor,
    isHome,
  ]);

  // The rows the reader opened, for as long as this screen is up: answered
  // turns' steps and long messages' words.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = useCallback((rowKey: string) => {
    setOpenRows((open) => {
      const next = new Set(open);
      if (!next.delete(rowKey)) next.add(rowKey);
      return next;
    });
  }, []);
  const openStep = useCallback(
    (entryId: string) => navigation.navigate("ThreadStep", { deploymentId, entryId, threadId }),
    [deploymentId, navigation, threadId],
  );
  const openActivity = useCallback(
    (turnKey: string) =>
      navigation.navigate("ConversationActivity", { deploymentId, threadId, turnKey }),
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
    (place: LinkedPlace): void => {
      if (place.index >= 0) {
        scrollAttempts.current = 0;
        pinned.current = false;
        setAtTail(false);
        listRef.current?.scrollToIndex({ animated: false, index: place.index, viewPosition: 0.5 });
      }
      const { openKey } = place;
      if (openKey !== null) {
        setOpenRows((open) => (open.has(openKey) ? open : new Set(open).add(openKey)));
      }
      if (place.activityKey !== null) openActivity(place.activityKey);
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
    reveal(anchor);
  }, [anchor, anchorMessageId, focused, reveal]);
  useEffect(() => {
    if (requestId === null || revealed.current === requestId) return;
    // A Request still waiting is shown in the composer, and that spends the
    // link: its answer landing later, given here or anywhere, moves nothing.
    if (pendingRequest) {
      revealed.current = requestId;
      return;
    }
    if (receipt === null || (receipt.activityKey !== null && !focused)) return;
    revealed.current = requestId;
    reveal(receipt);
  }, [focused, pendingRequest, receipt, requestId, reveal]);
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
  const surfaces = useMemo<TranscriptSurfaces>(
    () => ({
      hostClient,
      turns: surfaceTurns,
      open: (destination: SurfaceDestination) => {
        const route = surfaceRoute(deploymentId, threadId, destination);
        const state = navigation.getState();
        const current = state?.routes[state.index];
        if (
          current?.name === "WorkspaceBrowser" &&
          sameDestination(paramsDestination(current.params), destination)
        )
          return;
        navigation.dispatch(StackActions.push("WorkspaceBrowser", route));
      },
    }),
    [deploymentId, hostClient, navigation, surfaceTurns, threadId],
  );
  const engineName = useCallback(
    (harnessInstanceId: string): string | null =>
      threadPlacementOptions(snapshot.environments, snapshot.harnesses).find(
        (option) => option.harnessInstanceId === harnessInstanceId,
      )?.engineName ?? null,
    [snapshot.environments, snapshot.harnesses],
  );

  /**
   * Quotes a published update into Chat's composer and goes back to Chat.
   *
   * It never sends, and the reply still addresses Opensteer even when the
   * update came from somewhere else. The quote is written to Chat's own draft
   * before the navigation, so it is there whether or not the navigation is
   * what finishes — and it is still there after a relaunch. Chat is the root
   * under this task, so going there returns to it rather than opening another.
   */
  const quoteIntoChat = useCallback(
    (message: MessageEntry): void => {
      if (viewerUserId === null) return;
      const homeThreadId = snapshot.homeThreadId;
      const quote = draftQuoteFrom(message, homeThreadId);
      if (homeThreadId === threadId) {
        setRestoredDraft((current) => ({ key: (current?.key ?? 0) + 1, quote, text: "" }));
        return;
      }
      // Before Home exists the quote joins the draft Home's first message is
      // written in, so the reply still addresses Opensteer rather than
      // silently becoming an answer to this task.
      void client.drafts
        .writeDraftQuote(deploymentId, viewerUserId, homeThreadId ?? homeIntroDraftKey, quote)
        .then(() => navigation.dispatch(StackActions.popTo("Home", { deploymentId, quote })))
        .catch(() => undefined);
    },
    [client.drafts, deploymentId, navigation, snapshot.homeThreadId, threadId, viewerUserId],
  );
  const askAbout = useMemo<AskAbout>(
    () => ({ label: askAboutLabel(isHome), quote: quoteIntoChat }),
    [isHome, quoteIntoChat],
  );
  /** Quotes a reply into this conversation's own composer, unsent. */
  const replyWith = useCallback(
    (message: MessageEntry): void => {
      const quote = draftQuoteFrom(message, snapshot.homeThreadId);
      setRestoredDraft((current) => ({ key: (current?.key ?? 0) + 1, quote, text: "" }));
    },
    [snapshot.homeThreadId],
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
  // The question docked above the composer, folded or not: a task held up by
  // it does not repeat it.
  const dockedRequestId = useMemo(
    () =>
      snapshot.user === null
        ? null
        : (waitingQuestion(snapshot.waitingRequests, threadId, snapshot.user)?.surface.request.id ??
          null),
    [snapshot.user, snapshot.waitingRequests, threadId],
  );
  const taskScope = useMemo<TaskScope>(
    () => ({
      dockedRequestId,
      hostClient,
      // Pushed, not navigated: navigating to the Thread route from a Thread
      // replaces this one's params, and back would skip past the conversation.
      onViewWork: (workerThreadId: string) =>
        navigation.dispatch(
          StackActions.push("Thread", { deploymentId, threadId: workerThreadId }),
        ),
    }),
    [deploymentId, dockedRequestId, hostClient, navigation],
  );
  // What the jump pill says while the reader is away from a turn at work on
  // their Mac: that is where its Stop is.
  const computerNow = useMemo(
    () => (live ? threadComputerUseNow(groups, snapshot.machines) : null),
    [groups, live, snapshot.machines],
  );
  const jumpToMac = computerNow !== null && !historical ? computerUseNowSummary(computerNow) : null;
  // Chat is the root every stack of Threads begins from, so a message from it
  // leads back there rather than opening Chat a second time over this task.
  const homeThreadId = snapshot.homeThreadId;
  const openSource = useCallback(
    (sourceThreadId: string) => {
      if (sourceThreadId === threadId) return;
      if (sourceThreadId === homeThreadId) {
        navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
        return;
      }
      onOpenThread(sourceThreadId);
    },
    [deploymentId, homeThreadId, navigation, onOpenThread, threadId],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TranscriptItem>) =>
      item.kind === "working" ? (
        <WorkingIndicator indicator={item.indicator} live={live} />
      ) : (
        <>
          {/* Rows open the files messages carry through this Thread's own client. */}
          <AttachmentReader value={hostClient}>
            <TranscriptGroupRow
              activityKey={item.activityKey}
              conversation={conversational}
              onOpenActivity={conversational ? openActivity : undefined}
              onOpenReplyUnderWay={conversational ? openLatestActivity : undefined}
              onReply={conversational ? replyWith : undefined}
              live={live}
              engineName={engineName}
              group={item.group}
              open={openRows.has(item.group.key)}
              onToggleOpen={toggleRow}
              highlightRequestId={requestId}
              askAbout={askAbout}
              onOpenStep={openStep}
              onOpenThread={openSource}
              spacingTop={item.spacingTop}
              unreadBoundary={item.unreadBoundary}
              homeThreadId={snapshot.homeThreadId}
              viewerUserId={viewerUserId}
              workspaces={workspaces}
            />
          </AttachmentReader>
          {item.outcome === null ? null : (
            <TaskOutcomeLine onOpenThread={openSource} outcome={item.outcome} />
          )}
        </>
      ),
    [
      anchorMessageId,
      askAbout,
      conversational,
      engineName,
      hostClient,
      live,
      openActivity,
      openLatestActivity,
      openSource,
      openStep,
      openRows,
      replyWith,
      requestId,
      snapshot.homeThreadId,
      viewerUserId,
      workspaces,
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
    let previous: ReturnType<typeof transcriptVoice> | null = null;
    const boundaryKey = firstUnreadGroupKey(groups, conversational ? null : unreadBoundarySequence);
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
      const spacingTop = transcriptSpacing(previous, voice);
      previous = voice;
      return {
        activityKey: activityKeys?.get(group.key) ?? null,
        group,
        key,
        kind: "group" as const,
        outcome: endings.get(index) ?? null,
        spacingTop,
        unreadBoundary: group.key === boundaryKey,
      };
    });
    if (indicator !== null) rows.push({ indicator, key: "working", kind: "working" });
    return rows;
  }, [conversational, drawn, groups, indicator, outcomes, unreadBoundarySequence, viewerUserId]);

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
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  // A collapsed sheet with no room shows one line of the latest reply, which
  // is not the conversation read.
  const transcriptShown = props.sheet === undefined || props.sheet.expanded || roomy;
  useEffect(() => {
    // Nothing is marked before the arriving read position is known: marking
    // first would move the boundary this visit's divider is drawn from, and
    // history the reader has not seen would lose it.
    if (!boundaryKnown || !focused || !atTail || !appActive || historical || !transcriptShown)
      return;
    if (observed === null) return;
    if (markedSequence !== null && BigInt(markedSequence) >= BigInt(observed)) return;
    void hostClient.markThreadRead(threadId, observed).catch(() => {
      // The next time they reach the foot marks it again; a read marker is
      // not worth interrupting anybody for.
    });
  }, [
    appActive,
    atTail,
    boundaryKnown,
    focused,
    historical,
    hostClient,
    markedSequence,
    observed,
    threadId,
    transcriptShown,
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
  const placement =
    threadPlacementOptions(snapshot.environments, snapshot.harnesses).find(
      (option) => option.harnessInstanceId === thread.harnessInstanceId,
    ) ?? null;
  const disabledReason =
    thread.status === "archived"
      ? "This thread is archived and cannot take new messages."
      : mutationOwner === "settings"
        ? "Updating thread settings…"
        : mutationOwner === "request"
          ? "Sending your response…"
          : null;

  // This pane's list scrolls under the Thread screen's transparent bar. iOS
  // takes the bar's height from the screen's own safe area; Android has no such
  // inset to read, so the number is stated there. A sheet has no bar over it.
  const sheet = props.sheet ?? null;
  const underHeader = sheet === null;
  const collapsed = sheet !== null && !sheet.expanded;
  const latest = collapsed ? latestReplyLine(groups, indicator) : null;
  // The latest line stands for the folded conversation when there is no room
  // for more of it: tapping it opens the rest.
  const latestLine =
    sheet === null ? null : (
      <Pressable
        accessibilityHint="Shows the conversation"
        accessibilityRole="button"
        onPress={() => sheet.onExpand(true)}
        style={({ pressed }) => [styles.latest, sides, pressed && styles.latestPressed]}
      >
        {latest?.kind === "typing" ? (
          <View accessibilityLabel="Opensteer is replying" accessible style={styles.latestText}>
            <TypingDots />
          </View>
        ) : (
          <AppText
            numberOfLines={1}
            role="secondary"
            style={styles.latestText}
            tone={latest === null ? "muted" : "soft"}
          >
            {latest?.text ?? "Ask about what you see"}
          </AppText>
        )}
        <Symbol name="chevron.up" size={12} tint={color.muted} />
      </Pressable>
    );
  const transcript = (
    <View style={styles.body}>
      <FlatList
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[
          styles.content,
          column,
          { ...sides, paddingTop: underHeader ? headerHeight + space[8] : space[8] },
        ]}
        data={items}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.key}
        ListEmptyComponent={
          sheet === null ? (
            <EmptyThread />
          ) : (
            // Under a page, before anything has been said, the page is the subject.
            <AppText role="secondary" style={styles.sheetEmpty} tone="muted">
              Ask about what you see
            </AppText>
          )
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
        // The list also changes height on its own: the keyboard opening, and
        // the composer growing as a Request docks into it or text wraps.
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
      />
      {/* An older window has to be left deliberately, and the way out is to
          load the live conversation — so the offer stands there whether or
          not anything new has arrived since. */}
      {!historical && atTail ? null : (
        <Animated.View entering={enter} exiting={exit} style={styles.jumpHome}>
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
  const content = (
    <>
      {collapsed ? (
        // Folded: as much of the conversation as the room under the page holds,
        // and at least its latest line, which opens the rest.
        <View
          onLayout={(event) => {
            const next = event.nativeEvent.layout.height >= roomyHeight;
            setRoomy((current) => (current === next ? current : next));
          }}
          style={styles.room}
        >
          {roomy ? transcript : latestLine}
        </View>
      ) : (
        transcript
      )}

      <View
        style={[
          styles.dock,
          column,
          {
            paddingBottom: (keyboardVisible ? 0 : insets.bottom) + space[8],
            // Tighter than the transcript's gutter: the bar floats over the
            // page rather than sitting in its column, and a floating thing
            // that lines up with the text under it reads as part of it.
            paddingLeft: space[8] + insets.left,
            paddingRight: space[8] + insets.right,
          },
        ]}
        testID="composer-dock"
      >
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
            {/* Folded under a page, the open tasks and the questions wait for the
                conversation to be opened; what needs the reader is one line. */}
            {collapsed ? (
              <FoldedRequest
                onReview={() => sheet.onExpand(true)}
                ownRequests={snapshot.ownRequests ?? []}
                threadId={thread.id}
                user={snapshot.user}
                waitingRequests={snapshot.waitingRequests}
              />
            ) : (
              <>
                <WaitingQuestions
                  canRespond={canRespond}
                  deploymentId={props.deploymentId}
                  drafts={client.drafts}
                  hostClient={props.hostClient}
                  machines={snapshot.machines}
                  onOpenTask={taskScope.onViewWork}
                  threadId={thread.id}
                  user={snapshot.user}
                  waitingRequests={snapshot.waitingRequests}
                />
              </>
            )}
            {/* The conversation's live tab, the one way straight to it: not
                under a page, which is already in front, nor while typing. */}
            {sheet === null && !keyboardVisible ? (
              <TabPreview
                deploymentId={props.deploymentId}
                hostClient={props.hostClient}
                threadId={thread.id}
              />
            ) : null}
            {/* One dock: the tray tucks under the composer's top edge, so the
                two share a wrapper the dock's own gap cannot reach between.
                Only work has a tray; a conversation shows what was sent. */}
            <View>
              {inputQueue === null || thread.role !== "work" ? null : (
                <QueuedMessages
                  canRespond={canRespond && thread.status !== "archived"}
                  hostClient={props.hostClient}
                  onEdit={(message) =>
                    setRestoredDraft((current) => ({ ...message, key: (current?.key ?? 0) + 1 }))
                  }
                  queue={inputQueue}
                />
              )}
              <Composer
                variant={conversational ? "conversation" : "work"}
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
                highlightRequestId={props.requestId}
                hostClient={props.hostClient}
                machines={snapshot.machines}
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
                page={sheet?.page ?? null}
                onChangeModel={() =>
                  navigation.navigate("ThreadSettings", {
                    deploymentId: props.deploymentId,
                    threadId: thread.id,
                  })
                }
                onFind={() =>
                  navigation.navigate("ThreadFind", {
                    deploymentId: props.deploymentId,
                    threadId: thread.id,
                  })
                }
                placeholder={
                  isHome
                    ? "Ask anything…"
                    : threadComposerPlaceholder(items.length === 0 && !canLoadEarlier)
                }
                requests={snapshot.ownRequests ?? []}
                requestFolded={collapsed}
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
                workspaceId={thread.workspaceId}
              />
            </View>
          </>
        )}
      </View>
    </>
  );
  // A sheet sits inside a screen that already keeps the keyboard clear; a
  // second avoiding view would lift the composer twice.
  const pane =
    sheet !== null ? (
      <View style={sheet.expanded ? styles.pane : styles.folded}>{content}</View>
    ) : (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={props.keyboardVerticalOffset ?? 0}
        style={styles.pane}
      >
        {content}
      </KeyboardAvoidingView>
    );
  return (
    <TaskScopeContext.Provider value={taskScope}>
      <TranscriptComputersContext.Provider value={computers}>
        <TranscriptSurfacesContext.Provider value={surfaces}>
          {pane}
        </TranscriptSurfacesContext.Provider>
      </TranscriptComputersContext.Provider>
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
function draftQuoteFrom(message: MessageEntry, homeThreadId: string | null): ThreadDraftQuote {
  const excerpt = message.body.replaceAll(/\s+/gu, " ").trim();
  return {
    attribution: messageAuthorName(message.author, message.messageKind, homeThreadId),
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
      group.turn.reply?.id !== entryId &&
      turnFolds(group.turn))
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
      sameSubagentWork(left.turn.subagentWork, right.turn.subagentWork) &&
      left.turn.reply === right.turn.reply &&
      sameEntries(left.turn.assignments, right.turn.assignments)
    );
  }
  return right.kind !== "turn" && right.kind === left.kind && left.entry === right.entry;
}

function sameEntries(left: readonly object[], right: readonly object[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** A subagent's steps are outside the turn's work, so a step it streams changes only these. */
function sameSubagentWork(left: Turn["subagentWork"], right: Turn["subagentWork"]): boolean {
  const nodeIds = Object.keys(left);
  return (
    nodeIds.length === Object.keys(right).length &&
    nodeIds.every((nodeId) => {
      const work = right[nodeId];
      return work !== undefined && sameEntries(left[nodeId] ?? [], work);
    })
  );
}

/** Only a workspace's name and its mark ever reach a transcript row. */
function sameWorkspaceMarks(
  left: readonly WorkspaceSummary[],
  right: readonly WorkspaceSummary[],
): boolean {
  return (
    left.length === right.length &&
    left.every((workspace, index) => {
      const other = right[index];
      return (
        workspace.id === other?.id &&
        workspace.kind === other.kind &&
        workspace.icon === other.icon &&
        workspace.name === other.name &&
        workspace.color === other.color
      );
    })
  );
}

function EmptyThread(): ReactNode {
  return (
    <View style={styles.empty}>
      <AppText role="displaySmall">What would you like to do?</AppText>
      <AppText role="secondary" tone="muted">
        Ask a question or describe a task.
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  // Folded, the pane grows into whatever the sheet is given and never below
  // its latest line and composer.
  folded: { flexGrow: 1 },
  centred: { flex: 1, gap: space[12], justifyContent: "center" },
  // No gap: each row carries the air above it, because how much belongs there
  // depends on whether the row before it was the same voice.
  content: { paddingBottom: space[16] },
  dock: { gap: space[8], paddingTop: space[8] },
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
  requesterPressed: { backgroundColor: color.surfacePressed },
  requesterTitle: { flexShrink: 1 },
  jump: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderColor: color.lineStrong,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    // Lifted off the transcript it floats over.
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  // Clear of the composer beneath it: the pill is an offer, and an offer that
  // touches the thing it sits on reads as part of it.
  jumpHome: { alignItems: "center", bottom: space[12], left: 0, position: "absolute", right: 0 },
  jumpPressed: { backgroundColor: color.surfacePressed },
  latest: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
  },
  latestPressed: { backgroundColor: color.surfacePressed },
  latestText: { flex: 1 },
  pane: { flex: 1 },
  // Its own basis is nothing and its least is the latest line, so the room is
  // exactly what the sheet has to spare, whatever it holds.
  // The latest line, when that is all there is room for, sits on the composer.
  room: { flexBasis: 0, flexGrow: 1, justifyContent: "flex-end", minHeight: touchTarget },
  sheetEmpty: { paddingVertical: space[8], textAlign: "center" },
});
