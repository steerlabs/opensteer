import { threadMark } from "@opensteer/client/host";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { useId, useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router";
import {
  harnessUsageLimitFailureCode,
  placeContentLabel,
  type ModelSelection,
  type Request,
} from "@opensteer/core";
import {
  type AskAbout,
  type ConversationActivitySelection,
  canContinueThreadOnPlacement,
  canRespondToRequests,
  conversationActivityTurn,
  conversationTurnRevealing,
  describeHostConnection,
  usageLimitReached,
  describeConnectionReset,
  groupTranscriptEntries,
  incomingTranscriptMessages,
  observedAccountConnection,
  observedSequence,
  placementAccountTitle,
  selectionForModel,
  threadActivity,
  threadComposerPlaceholder,
  threadStartHold,
  threadStopTarget,
  taskWaitingReason,
  visibleTranscript,
  withoutOwnAssignment,
  workerAssignment,
  assignmentPresentation,
  askAboutLabel,
  blockingDetail,
  conversationName,
  messageAuthorName,
  type EnvironmentStatus,
  type ExecutionSelection,
  type MessageEntry,
  type ThreadPlacementOption,
  type ThreadSummary,
  type HostClient,
  type TranscriptEntry,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { computerUseNowSummary, threadComputerUseNow } from "@opensteer/client/integrations";
import { useThreadInputQueue } from "@opensteer/client/react";
import { fromLivePage, useWindowInForeground } from "../ui-utils.js";
import { AgentTranscript, ConversationActivity } from "./agent-activity.js";
import { useShell } from "./app-shell.js";
import { ExecutionControls } from "./execution-controls.js";
import {
  applyThreadExecution,
  nextTurnNote,
  reviewExecutionSwitch,
  reviewFreshStart,
  type ReviewedChoice,
} from "./execution-review.js";
import { TaskLines } from "./task-line.js";
import { Icon } from "./icon.js";
import type { ComposerQuote, ComposerRestore } from "./composer.js";
import { InputSurface, RequestStack, focusOpenRequest, useRequestDock } from "./input-surface.js";
import { QueuedMessages } from "./queued-messages.js";
import { setThreadReading } from "./thread-reading.js";
import { ThreadFind } from "./thread-find.js";
import { BrandMark } from "./brand.js";
import { useVisualViewportKeyboardInset } from "./visual-viewport-keyboard.js";
import { ConversationHeader } from "./workspace/conversation-header.js";
import { WorkspaceOrb } from "./workspace-orb.js";
import { useWorkspace } from "./workspace/workspace-context.js";
import { TaskMark, TaskState, ChatOrb, taskStateWords } from "./workspace/task-mark.js";
import { homeThreadKind, useTaskDirectory } from "./workspace/task-directory.js";

export function ThreadRoute() {
  const { threadId } = useParams();
  const { snapshot } = useShell();
  const location = useLocation();
  if (threadId && homeThreadKind(threadId, snapshot) === "main")
    return <Navigate replace to={{ ...location, pathname: "/" }} state={location.state} />;
  return <ThreadSurface threadId={threadId ?? null} />;
}

/**
 * One conversation, wherever it is reached from. Home and a focused task are
 * the same surface: the only difference is what the breadcrumb calls it and
 * that Home never offers to hand a quote anywhere else.
 */
export function ThreadSurface({ threadId }: { readonly threadId: string | null }) {
  const { hostClient, placements, snapshot } = useShell();
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  const workspace = thread
    ? (snapshot.workspaces.find((candidate) => candidate.id === thread.workspaceId) ?? null)
    : null;
  useEffect(() => {
    if (threadId) hostClient.activateThread(threadId);
  }, [hostClient, threadId, thread?.id]);

  if (!thread || !workspace) {
    if (threadId && snapshot.threadLookups[threadId] === "missing")
      return <Navigate replace to="/" />;
    if (threadId && snapshot.threadLookups[threadId] === "failed")
      return (
        <div className="thread">
          <div className="hero" role="alert">
            <p>This conversation could not be loaded.</p>
            <button
              className="btn"
              onClick={() => hostClient.activateThread(threadId)}
              type="button"
            >
              Try again
            </button>
          </div>
        </div>
      );
    return (
      <div className="thread">
        <div className="hero" role="status" aria-label="Loading Thread">
          <span className="spinner" />
        </div>
      </div>
    );
  }
  return (
    <ThreadView
      key={`${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}:${thread.id}`}
      home={homeThreadKind(thread.id, snapshot) === "main"}
      requests={snapshot.requests[thread.id] ?? []}
      canLoadEarlier={snapshot.transcriptWindows[thread.id]?.hasMore ?? false}
      entries={snapshot.transcripts[thread.id] ?? []}
      environmentStatus={
        snapshot.environments.find((item) => item.id === thread.environmentId)?.status ??
        "disconnected"
      }
      executionPlacements={placements.filter(
        (placement) => placement.environmentId === thread.environmentId,
      )}
      thread={thread}
      workspace={workspace}
    />
  );
}

interface ThreadViewProps {
  requests: Request[];
  canLoadEarlier: boolean;
  entries: TranscriptEntry[];
  environmentStatus: EnvironmentStatus;
  executionPlacements: ThreadPlacementOption[];
  /** Whether this is the Home conversation, which owns quotes from elsewhere. */
  home?: boolean;
  thread: ThreadSummary;
  workspace: WorkspaceSummary;
}

/** Where each conversation was left, by deployment, user and Thread. */
const readingPositions = new Map<
  string,
  { readonly scrollTop: number; readonly seenSequence: string | null }
>();

function ThreadView({
  canLoadEarlier,
  entries,
  environmentStatus,
  executionPlacements,
  home = false,
  requests,
  thread,
  workspace,
}: ThreadViewProps) {
  const { phone, work } = useWorkspace();
  const phoneStage = phone && work;
  const keyboardInset = useVisualViewportKeyboardInset();
  const {
    askOpensteerAbout,
    clearHomeHandoff,
    executionPreferences,
    homeHandoff,
    hostClient,
    openHarnessAuthentication,
    refreshHarnessCatalog,
    placements,
    reportActionError,
    snapshot,
  } = useShell();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // On a phone the sheet is one scrolling body, transcript and requests
  // together; elsewhere the transcript scrolls on its own above the requests.
  const phoneStageRef = useRef(phoneStage);
  phoneStageRef.current = phoneStage;
  const currentScroller = () => (phoneStageRef.current ? bodyRef.current : scrollRef.current);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const followsTailRef = useRef(true);
  const scrollGeometryRef = useRef<{
    readonly scroller: HTMLElement;
    readonly height: number;
    readonly viewport: number;
  } | null>(null);
  const [atTail, setAtTail] = useState(true);
  const seenSequenceRef = useRef<string | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // True while the reader is held in a window loaded around an older update.
  // The live conversation is not being shown, so the foot of what is on screen
  // is not the conversation's tail and nothing here may claim it is.
  const [historical, setHistorical] = useState(false);
  const [revealMessage, setRevealMessage] = useState<{ readonly id: string } | null>(null);
  const [returning, setReturning] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [finding, setFinding] = useState(false);
  const [selectionNote, setSelectionNote] = useState<string | null>(null);
  // A reply's Activity while it is open: which reply, the control that opened
  // it, where it hangs, and a message a search or a link asked to be shown in
  // it. What the reply under way or a reply's menu opened, that reply owns;
  // what a link opened hangs under the header.
  const [activityView, setActivityView] = useState<{
    readonly opener: HTMLElement;
    readonly reveal: string | null;
    readonly selection: ConversationActivitySelection;
    readonly source: "header" | "reply";
  } | null>(null);
  // The control the owned Activity hangs from now: the reply under way that
  // opened it, then the More of the reply it became.
  const [activityOwnerAnchor, setActivityOwnerAnchor] = useState<HTMLElement | null>(null);
  const activityPanelId = useId();
  const headerTitleRef = useRef<HTMLHeadingElement | null>(null);
  // A queued message taken back to be reworded, on its way into the composer.
  // It belongs to the composer of the conversation it came from, and to no other.
  const [restoredDraft, setRestoredDraft] = useState<{
    readonly composer: string;
    readonly restore: ComposerRestore;
  } | null>(null);
  // Each conversation, for each signed-in user of each deployment, has its own
  // composer: its draft, files and unsent message never follow the reader to
  // another one, and nothing that finishes late lands in the wrong one.
  const composerKey = `${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}:${thread.id}`;
  useEffect(() => {
    // Handed over once; opening this conversation again starts from its own draft.
    setRestoredDraft(null);
    setSelectionNote(null);
    setHistorical(false);
    setActivityView(null);
  }, [composerKey]);
  const inputQueue = useThreadInputQueue(hostClient, thread.id);
  // The Tasks count opens a task at its exact request; one already answered stays answered.
  const location = useLocation();
  const focusRequest =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusRequest" in location.state &&
    typeof location.state.focusRequest === "string"
      ? location.state.focusRequest
      : null;
  const dock = useRequestDock(thread.id, requests);
  const { items: dockedRequests, openId: openRequestId, setOpenId: openRequest } = dock;
  // The exact request is opened and focused once it can be: its body may load
  // after the conversation does, and it may wait behind another request. Once
  // focused, or once that request is answered, the intent is spent — a newer
  // request that takes its place is never focused instead.
  const [focusTarget, setFocusTarget] = useState<{
    readonly id: string;
    readonly key: string;
  } | null>(null);
  useEffect(() => {
    setFocusTarget(focusRequest ? { id: focusRequest, key: location.key } : null);
  }, [focusRequest, location.key]);
  useEffect(() => {
    if (!focusTarget) return;
    const known = requests.find((request) => request.id === focusTarget.id);
    if (known && known.status !== "pending") {
      setFocusTarget(null);
      return;
    }
    if (!dockedRequests.some((item) => item.surface.request.id === focusTarget.id)) return;
    if (openRequestId !== focusTarget.id) {
      openRequest(focusTarget.id);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(
        `.request-card fieldset[data-request-id="${CSS.escape(focusTarget.id)}"]`,
      );
      if (!panel) return;
      const control = panel.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
      );
      (control ?? panel).focus();
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [dockedRequests, focusTarget, openRequest, openRequestId, requests]);
  const conversational = thread.role === "conversation";
  // In work, a message waiting behind the current turn stands in the tray above
  // the composer, not in the conversation, until a Run takes it. A conversation
  // has no tray: the reader's own waiting words are a sent bubble at its foot.
  const conversation = useMemo(
    () =>
      withoutOwnAssignment(
        visibleTranscript(entries, inputQueue, { conversation: conversational }),
        thread.id,
      ),
    [conversational, entries, inputQueue, thread.id],
  );
  const incomingMessages = useMemo(
    () => incomingTranscriptMessages(conversation, snapshot.user?.id ?? null, conversational),
    [conversation, conversational, snapshot.user?.id],
  );
  const observed = useMemo(
    () => observedSequence(conversation, conversational),
    [conversation, conversational],
  );

  const threadRunQueue = useMemo(
    () =>
      snapshot.runQueue
        .filter((run) => run.threadId === thread.id)
        .toSorted((left, right) => left.runOrdinal - right.runOrdinal),
    [snapshot.runQueue, thread.id],
  );
  // The same answer every surface gives: what this Thread is doing, and
  // which Run, if any, a Stop would reach.
  const activity = threadActivity({ entries, runQueue: snapshot.runQueue, thread });
  const stopTarget = threadStopTarget({ runQueue: snapshot.runQueue, thread });

  /**
   * What a candidate AI would do to this conversation, decided before
   * anything is applied. The picker shows the answer inline.
   */
  const reviewSelection = (selection: ExecutionSelection) =>
    reviewExecutionSwitch({
      placements: executionPlacements,
      runQueue: threadRunQueue,
      selection,
      thread,
    });

  /** What starting this same AI over again would do — the recovery, reviewed. */
  const reviewFresh = () =>
    reviewFreshStart({ placements: executionPlacements, runQueue: threadRunQueue, thread });

  /**
   * The single path that changes this Thread's execution: the picker, the
   * reviewed fresh start and the usage-limit recovery all take it. A reviewed
   * change carries the session the reader was looking at, so one that raced
   * admission is refused rather than applied to something they never saw.
   */
  const applyExecution = async (
    selection: ExecutionSelection,
    reviewed?: ReviewedChoice,
  ): Promise<boolean> => {
    try {
      const target = executionPlacements.find(
        (placement) =>
          placement.environmentId === selection.environmentId &&
          placement.harnessInstanceId === selection.harnessInstanceId,
      );
      if (!target) throw new Error("The selected AI engine is no longer available");
      await applyThreadExecution({
        hostClient,
        recheck: () => reviewSelection(selection),
        reviewed,
        selection,
        threadId: thread.id,
      });
      // Honest, and nothing more: the pill names what was chosen, and this
      // says what the next authorized work will use — or, when the queue
      // makes that claim false, says nothing about what runs next.
      setSelectionNote(
        [
          reviewed?.continuation?.fresh
            ? `${target.engineName} · ${target.accountName} started fresh.`
            : `Now using ${target.engineName} · ${target.accountName}.`,
          // Chat is never paused and keeps no queue: what is sent joins the reply.
          nextTurnNote({
            engineName: target.engineName,
            paused: !conversational && thread.inputQueuePaused,
            queuedCount: conversational ? 0 : (inputQueue?.items.length ?? 0),
          }),
        ]
          .filter((part): part is string => part !== null)
          .join(" "),
      );
      return true;
    } catch (error) {
      reportActionError(error);
      return false;
    }
  };

  // Coming back to a conversation left partway through — Home, after opening
  // one of its tasks — lands where the reader left it, not at its foot. The
  // position is held for this tab's life only; a reader at the foot is at
  // the foot again, however much arrived meanwhile.
  useLayoutEffect(() => {
    const scroller = currentScroller();
    const saved = readingPositions.get(composerKey);
    if (scroller && saved !== undefined) {
      followsTailRef.current = false;
      setAtTail(false);
      // What had arrived by then was seen; only what came after is new.
      seenSequenceRef.current = saved.seenSequence;
      scroller.scrollTop = saved.scrollTop;
    }
    return () => {
      if (!scroller) return;
      if (followsTailRef.current) readingPositions.delete(composerKey);
      else
        readingPositions.set(composerKey, {
          scrollTop: scroller.scrollTop,
          seenSequence: seenSequenceRef.current,
        });
    };
  }, [composerKey]);

  // Pin to the bottom while the reader is already there; never fight a
  // scroll-up. Requests matter too: a docked request grows the input surface
  // and would otherwise push the newest activity out of view.
  const keepTailInView = () => {
    const scroller = currentScroller();
    if (!scroller) return;
    if (followsTailRef.current) scroller.scrollTop = scroller.scrollHeight;
    scrollGeometryRef.current = {
      scroller,
      height: scroller.scrollHeight,
      viewport: scroller.clientHeight,
    };
  };
  useLayoutEffect(() => {
    keepTailInView();
  }, [conversation, inputQueue, keyboardInset, phoneStage, requests]);

  // Sizes that settle after the messages do — the viewfinder's frame, a
  // question docking above the composer — keep a reader at the foot there.
  useEffect(() => {
    const transcript = scrollRef.current;
    const body = bodyRef.current;
    if (!transcript || !body || typeof ResizeObserver === "undefined") return;
    const elements = [transcript, body, transcript.firstElementChild, body.lastElementChild].filter(
      (element): element is Element => element !== null,
    );
    return observeResize(elements, keepTailInView);
  }, []);

  const handleScroll = () => {
    const scroller = currentScroller();
    if (!scroller) return;
    const previous = scrollGeometryRef.current;
    // Layout can deliver a scroll before ResizeObserver. A changed viewport,
    // content height or scroll owner does not mean the reader left the tail.
    if (
      followsTailRef.current &&
      previous !== null &&
      (previous.scroller !== scroller ||
        previous.height !== scroller.scrollHeight ||
        previous.viewport !== scroller.clientHeight)
    ) {
      keepTailInView();
      return;
    }
    scrollGeometryRef.current = {
      scroller,
      height: scroller.scrollHeight,
      viewport: scroller.clientHeight,
    };
    const tail = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    followsTailRef.current = tail;
    setAtTail(tail);
    if (tail) {
      seenSequenceRef.current = observed;
      setPendingUpdates(0);
    }
  };

  // Arriving work never moves a reader who is elsewhere; it offers.
  useEffect(() => {
    if (followsTailRef.current) {
      seenSequenceRef.current = observed;
      setPendingUpdates(0);
      return;
    }
    const seen = seenSequenceRef.current;
    setPendingUpdates(
      seen === null
        ? 0
        : incomingMessages.filter((message) => BigInt(message.sequence) > BigInt(seen)).length,
    );
  }, [incomingMessages, observed]);

  const goToTail = () => {
    const scroller = currentScroller();
    if (!scroller) return;
    followsTailRef.current = true;
    setAtTail(true);
    seenSequenceRef.current = observed;
    setPendingUpdates(0);
    scroller.scrollTop = scroller.scrollHeight;
  };

  const loadEarlier = async () => {
    if (loadingEarlier) return;
    const scroller = currentScroller();
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const anchor = scroller
      ? [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (element) => element.getBoundingClientRect().bottom > top,
        )
      : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    setLoadingEarlier(true);
    try {
      await hostClient.loadEarlierTranscript(thread.id);
      requestAnimationFrame(() => {
        if (scroller && anchor?.isConnected && anchorTop !== undefined && !followsTailRef.current) {
          scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        }
      });
    } catch (error) {
      reportActionError(error);
    } finally {
      setLoadingEarlier(false);
    }
  };

  /* ---- Reading position: unread divider, read marking, exact jumps ---- */

  const readState = snapshot.threadReadStates?.[thread.id] ?? null;
  // Work transcripts keep the arriving read position while somebody catches
  // up. Conversations have no divider, but still wait for this reader's state
  // before marking anything read.
  const boundaryRef = useRef<{ readonly threadId: string; readonly readSequence: string | null }>({
    readSequence: null,
    threadId: "",
  });
  if (readState && boundaryRef.current.threadId !== thread.id) {
    boundaryRef.current = { readSequence: readState.readSequence, threadId: thread.id };
  }
  // Never read is not the same as read up to nothing: a conversation nobody has
  // opened has no boundary to draw inside it, only a beginning.
  const boundaryKnown = boundaryRef.current.threadId === thread.id;
  const unreadBoundarySequence = boundaryKnown ? boundaryRef.current.readSequence : null;

  // What this reader has actually seen published here: the furthest sequence
  // the loaded conversation carries. The Host's `unreadSequence` is not it —
  // that names content this page may never have rendered.
  const markedSequence = readState?.readSequence ?? null;
  // Coming back to the window is an observation of what is on screen; a window
  // that is merely visible behind another one is not.
  const foreground = useWindowInForeground();
  useEffect(() => {
    if (foreground) handleScroll();
  }, [foreground]);
  useEffect(() => {
    // Nothing is marked before the arriving read position is known: marking
    // first would move the boundary this visit is about to be drawn from, and
    // the history the reader has not seen would lose its divider.
    if (!boundaryKnown || historical || !atTail || !foreground) return;
    if (observed === null) return;
    if (markedSequence !== null && BigInt(markedSequence) >= BigInt(observed)) return;
    void hostClient.markThreadRead(thread.id, observed).catch(() => {
      // A read marker that did not land is retried by the next observation;
      // it is not worth interrupting the reader for.
    });
  }, [
    atTail,
    boundaryKnown,
    foreground,
    historical,
    hostClient,
    markedSequence,
    observed,
    thread.id,
  ]);

  // What a notification has to know before it decides to interrupt: one about
  // the conversation on screen, at its tail, in front of the reader, is
  // telling them what they are already watching.
  useEffect(() => {
    setThreadReading({ atLatest: atTail && !historical, threadId: thread.id });
    return () => setThreadReading(null);
  }, [atTail, historical, thread.id]);

  /** Moves the reader to one exact message, and leaves them there. */
  const jumpToMessage = async (messageId: string) => {
    // Set before the fetch, not after: the client pins the Thread to the
    // historical window as it answers, and a render in between would otherwise
    // read the foot of the old page as the conversation's tail and mark it.
    setHistorical(true);
    followsTailRef.current = false;
    setAtTail(false);
    setRevealMessage({ id: messageId });
    await hostClient.loadTranscriptAround(thread.id, messageId);
    requestAnimationFrame(() => {
      const target = currentScroller()?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.classList.add("transcript__found");
      window.setTimeout(() => target.classList.remove("transcript__found"), 2400);
    });
  };

  /**
   * Activity a search or a link opened hangs under the conversation's name, in
   * whichever header is on screen: the desktop header or the narrow top bar.
   */
  const activityAnchor = (): HTMLElement | null => headerTitleRef.current;

  /**
   * Opens a reply's Activity from the reply under way or a reply's menu, which
   * then owns it: it hangs from that control, and closing it returns the
   * reader there.
   */
  const openActivity = (
    selection: ConversationActivitySelection,
    opener: HTMLElement | null,
    reveal: string | null = null,
  ) => {
    const source = opener !== null && selection.kind === "turn" && reveal === null;
    const from = source ? opener : (opener ?? activityAnchor());
    if (from === null) return;
    setActivityView({ opener: from, reveal, selection, source: source ? "reply" : "header" });
  };

  // Something said on the way to a reply is not in the conversation: a search
  // or a link that names it opens the Activity of the reply it led to, and the
  // conversation shows that reply.
  const revealedActivity = useMemo(() => {
    if (!conversational || revealMessage === null) return null;
    const groups = groupTranscriptEntries(conversation, {
      inputQueuePaused: thread.inputQueuePaused,
    });
    const key = conversationTurnRevealing(groups, revealMessage.id);
    if (key === null) return null;
    const reply = conversationActivityTurn(groups, { key, kind: "turn" })?.reply ?? null;
    return { key, replyId: reply?.id ?? null };
  }, [conversation, conversational, revealMessage, thread.inputQueuePaused]);
  const revealedRef = useRef<{ readonly id: string } | null>(null);
  useEffect(() => {
    if (revealMessage === null || revealedActivity === null) return;
    if (revealedRef.current === revealMessage) return;
    revealedRef.current = revealMessage;
    openActivity({ key: revealedActivity.key, kind: "turn" }, null, revealMessage.id);
    const { replyId } = revealedActivity;
    if (replyId === null) return;
    requestAnimationFrame(() =>
      currentScroller()
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(replyId)}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }, [revealMessage, revealedActivity]);

  /** Puts the live conversation back and returns the reader to its foot. */
  const returnToLatest = async () => {
    await hostClient.loadLatestTranscript(thread.id);
    // The anchor is spent. Releasing it from the address as well is what lets
    // the same update be opened again later as a fresh jump.
    anchored.current = null;
    releaseAnchor();
    setRevealMessage(null);
    setHistorical(false);
    followsTailRef.current = true;
    setAtTail(true);
    seenSequenceRef.current = observed;
    setPendingUpdates(0);
    requestAnimationFrame(() => {
      const scroller = currentScroller();
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  };

  // A notification or a link can name the exact update it is about. The router
  // owns the query, so a second notification for this same conversation — which
  // pushes a new entry rather than popping one — is seen here.
  const [anchoredMessageId, releaseAnchor] = useAnchoredMessageId();
  const anchored = useRef<string | null>(null);
  useEffect(() => {
    if (!anchoredMessageId || anchored.current === anchoredMessageId) return;
    anchored.current = anchoredMessageId;
    void jumpToMessage(anchoredMessageId).catch(reportActionError);
  }, [anchoredMessageId]);

  // ⌘F / Ctrl+F searches this conversation rather than the rendered page,
  // which only holds the window that happens to be loaded.
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (fromLivePage(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setFinding(true);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  /* ---- Quoting an update ---- */

  /** Quotes a message into this conversation's own composer, focused and unsent. */
  const replyWith = (message: MessageEntry) => {
    const quote = quoteFromMessage(message, snapshot.homeThreadId);
    setRestoredDraft((current) => ({
      composer: composerKey,
      restore: { key: (current?.restore.key ?? 0) + 1, quote, text: "" },
    }));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };
  const quoteInto = (message: MessageEntry) => {
    // Opensteer is already the recipient; from a task, the question still goes to Opensteer.
    if (home) replyWith(message);
    else askOpensteerAbout(quoteFromMessage(message, snapshot.homeThreadId));
  };
  const askAbout: AskAbout = { label: askAboutLabel(home), quote: quoteInto };

  // A quote or request handed over from elsewhere lands in Chat's composer,
  // focused and unsent. It is taken once, so returning here later starts from
  // this conversation's own draft.
  useEffect(() => {
    if (!home || !homeHandoff) return;
    setRestoredDraft((current) => ({
      composer: composerKey,
      restore: {
        key: (current?.restore.key ?? 0) + 1,
        ...(homeHandoff.quote ? { quote: homeHandoff.quote } : {}),
        text: homeHandoff.text,
      },
    }));
    clearHomeHandoff();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [clearHomeHandoff, composerKey, home, homeHandoff]);

  const canRespond = canRespondToRequests(snapshot);
  const connection = describeHostConnection(snapshot);
  const live = canRespond && environmentStatus === "connected";
  // What this client holds of the account is current only while it is live.
  const startHold = live
    ? threadStartHold({ environments: snapshot.environments, runQueue: snapshot.runQueue, thread })
    : null;
  const composerPlaceholder = home
    ? "Ask Opensteer…"
    : threadComposerPlaceholder(conversation.length === 0);
  // The field names whom it writes to: Opensteer, or the task by its name.
  const recipient = useMemo(
    () => (home ? { lead: "Ask", name: "Opensteer" } : { lead: "Reply to", name: thread.title }),
    [home, thread.title],
  );
  const connectionLabel = !canRespond
    ? connection.label
    : thread.status === "archived"
      ? "Archived"
      : environmentStatus === "disconnected"
        ? `${thread.runnerLabel} offline`
        : null;
  const connectionStatus =
    connectionLabel !== null ? (
      <span className="thread__connection" role="status">
        <span className="thread__connection-label">{connectionLabel}</span>
        {connection.action === "retry" ? (
          <button
            type="button"
            onClick={() =>
              void hostClient.refresh({ retryConnection: true }).catch(() => undefined)
            }
          >
            Retry
          </button>
        ) : null}
      </span>
    ) : null;
  const historyState = snapshot.threadLookups[thread.id];
  const historyStatus =
    historyState === "failed" ? (
      <span className="thread__connection" role="alert">
        <span className="thread__connection-label">Could not load messages</span>
        <button type="button" onClick={() => hostClient.activateThread(thread.id)}>
          Retry
        </button>
      </span>
    ) : historyState === "loading" ? (
      <span className="thread__connection" role="status">
        Loading messages…
      </span>
    ) : null;
  const usageRecovery = useMemo(
    () => usageLimitRecovery(entries, executionPlacements, thread),
    [entries, executionPlacements, thread],
  );
  const computers = useMemo(
    () => ({ hostClient, machines: snapshot.machines }),
    [hostClient, snapshot.machines],
  );
  // What the jump button says while the reader is away from a turn at work on
  // their Mac: that is where its Stop is. Only asked while they are away, so a
  // reader following the tail never pays for grouping the transcript twice.
  const computerNow = useMemo(
    () =>
      live && !atTail
        ? threadComputerUseNow(
            groupTranscriptEntries(conversation, { inputQueuePaused: thread.inputQueuePaused }),
            snapshot.machines,
          )
        : null,
    [atTail, conversation, live, snapshot.machines, thread.inputQueuePaused],
  );
  // The engine this Thread runs on is the one that would have to enforce a new
  // access mode, so it is the one the menu asks about.
  const threadPlacement =
    executionPlacements.find(
      (placement) => placement.harnessInstanceId === thread.harnessInstanceId,
    ) ?? null;

  const title =
    !home && workspace.homeThreadId === thread.id
      ? workspace.name
      : conversationName(thread.id, thread.title, snapshot.homeThreadId);
  // Under the name only when the task is not plainly working, and only what is known.
  const waitingReason = useMemo(
    () => (thread.status === "waiting" ? taskWaitingReason(snapshot, thread.id) : null),
    [snapshot, thread.id, thread.status],
  );
  // What the task's own strip used to say beyond its state — offline, its
  // account preparing, a result that could not be returned — is said here.
  const assignmentBlock = useMemo(() => {
    const assignment = workerAssignment(snapshot.assignments, thread.id);
    return assignment
      ? (blockingDetail(assignmentPresentation(assignment, snapshot))?.text ?? null)
      : null;
  }, [snapshot, thread.id]);
  const cause = connectionStatus ?? historyStatus ?? waitingReason?.label ?? assignmentBlock;

  // On a phone with a page open, the conversation is a sheet under it: the
  // composer and the latest reply, opened to the whole conversation on request.
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!phoneStage) setSheetOpen(false);
  }, [phoneStage]);
  useLayoutEffect(() => {
    const scroller = currentScroller();
    if (sheetOpen && scroller && followsTailRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [sheetOpen]);

  return (
    <div
      className={[
        "thread",
        home ? "thread--home" : "",
        phoneStage
          ? `thread--sheet ${sheetOpen ? "thread--sheet-open" : "thread--sheet-closed"}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {phoneStage ? (
        <ConversationSheetHandle
          home={home}
          hostClient={hostClient}
          onToggle={setSheetOpen}
          open={sheetOpen}
          threadId={thread.id}
          title={title}
        />
      ) : null}
      <ConversationHeader
        key={thread.id}
        cause={cause}
        hostClient={hostClient}
        onFind={() => setFinding(true)}
        threadId={thread.id}
        title={title}
        titleRef={headerTitleRef}
      />

      {finding ? (
        <ThreadFind
          client={hostClient}
          homeThreadId={snapshot.homeThreadId}
          onClose={() => setFinding(false)}
          onJump={jumpToMessage}
          threadId={thread.id}
        />
      ) : null}

      <div className="thread__body" onScroll={handleScroll} ref={bodyRef}>
        <div className="thread__conversation">
          <div className="transcript-scroll" onScroll={handleScroll} ref={scrollRef}>
            <div
              aria-live="polite"
              className={conversational ? "transcript transcript--conversation" : "transcript"}
              role="log"
            >
              {canLoadEarlier ? (
                <button
                  className="btn btn--small transcript__load-earlier"
                  disabled={loadingEarlier}
                  onClick={() => void loadEarlier()}
                  type="button"
                >
                  <Icon name="arrow-up" />
                  {loadingEarlier ? "Loading…" : "Earlier messages"}
                </button>
              ) : null}
              {conversation.length === 0 && historyState === undefined ? (
                <EmptyThread home={home} />
              ) : null}
              <AgentTranscript
                revealMessage={revealMessage}
                key={thread.id}
                attachmentReader={hostClient}
                activity={activity}
                browserSessions={snapshot.browserSessions}
                // A conversation (Opensteer, a direct message) reads as messages, each
                // turn's steps behind its reply; work keeps its whole trace in view.
                conversation={conversational}
                live={live}
                // A recorded change names the engine it recorded, which is not
                // always one this conversation could run on now: searched across
                // every work location, so history keeps its own names.
                computers={computers}
                engineName={(harnessInstanceId) =>
                  placements.find((placement) => placement.harnessInstanceId === harnessInstanceId)
                    ?.engineName ?? null
                }
                entries={conversation}
                waitingRequests={snapshot.waitingRequests}
                assignments={snapshot.assignments}
                inputQueuePaused={thread.inputQueuePaused}
                homeThreadId={snapshot.homeThreadId}
                askAbout={askAbout}
                {...(conversational
                  ? {
                      activityOwner:
                        activityView?.source === "reply" && activityView.selection.kind === "turn"
                          ? {
                              onClose: () => setActivityView(null),
                              panelId: activityPanelId,
                              turnKey: activityView.selection.key,
                            }
                          : null,
                      onActivityAnchor: setActivityOwnerAnchor,
                      onOpenActivity: (key: string, opener: HTMLElement) =>
                        openActivity({ key, kind: "turn" }, opener),
                    }
                  : {})}
                onReply={replyWith}
                renderTask={(entries) => <TaskLines entries={entries} />}
                requestShown={dockedRequests.length > 0}
                startHold={startHold}
                threadId={thread.id}
                unreadBoundarySequence={unreadBoundarySequence}
                viewerUserId={snapshot.user?.id ?? null}
                pictures={hostClient}
                workspaces={snapshot.workspaces}
              />
            </div>
          </div>

          {/* An anchored search leaves the reader in an older window, and the only
          way back is to load the live one — so the offer stands whether or not
          anything new has arrived since. */}
          {historical ? (
            <button
              className="transcript__jump"
              disabled={returning}
              onClick={() => {
                setReturning(true);
                void returnToLatest()
                  .catch(reportActionError)
                  .finally(() => setReturning(false));
              }}
              type="button"
            >
              <Icon name="chevron-down" /> {returning ? "Loading…" : "Back to latest"}
            </button>
          ) : !atTail && computerNow ? (
            <button className="transcript__jump" onClick={goToTail} type="button">
              <Icon name="laptop" /> {computerUseNowSummary(computerNow)}
            </button>
          ) : !atTail ? (
            <button
              aria-label={pendingUpdates > 0 ? "Jump to new messages" : "Jump to latest"}
              className={
                pendingUpdates > 0 ? "transcript__jump" : "transcript__jump transcript__jump--quiet"
              }
              onClick={goToTail}
              title="Jump to latest"
              type="button"
            >
              <Icon name="chevron-down" />
              {pendingUpdates > 0 ? (
                <span>
                  {pendingUpdates === 1 ? "New message" : `${pendingUpdates} new messages`}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        <RequestStack
          disabled={!canRespond}
          items={dockedRequests}
          onOpen={openRequest}
          openId={openRequestId}
          threadId={thread.id}
        />
      </div>

      {conversational && activityView ? (
        <ConversationActivity
          anchor={
            activityView.source === "reply"
              ? (activityOwnerAnchor ?? activityView.opener)
              : (activityAnchor() ?? activityView.opener)
          }
          browserSessions={snapshot.browserSessions}
          entries={conversation}
          id={activityPanelId}
          inputQueuePaused={thread.inputQueuePaused}
          live={live}
          onClose={() => setActivityView(null)}
          returnFocusTo={activityView.opener}
          reveal={activityView.reveal}
          selection={activityView.selection}
        />
      ) : null}

      <div className="composer-dock">
        {selectionNote ? (
          <p className="thread__selection-note" role="status">
            {selectionNote}
          </p>
        ) : null}
        {usageRecovery ? (
          <div className="notice notice--warn" role="status">
            <Icon name="alert-circle" />
            <div>
              {usageRecovery.alternative && usageRecovery.alternativeAccountLabel ? (
                <>
                  Usage limit reached on {usageRecovery.accountLabel}. Switch to{" "}
                  {usageRecovery.alternativeAccountLabel}?
                </>
              ) : (
                <>
                  Usage limit reached on {usageRecovery.accountLabel}.
                  {usageRecovery.resetsAt === null ? " " : ` It resets ${usageRecovery.resetsAt}. `}
                  <Link to="/settings/ai-engines">Add another account</Link> to keep going.
                </>
              )}
            </div>
            {usageRecovery.alternative ? (
              <button
                className="btn btn--small"
                disabled={switchingAccount}
                onClick={() => {
                  const target = usageRecovery.alternative;
                  if (!target) return;
                  setSwitchingAccount(true);
                  void applyExecution(recoverySelection(target, thread.modelSelection)).finally(
                    () => setSwitchingAccount(false),
                  );
                }}
                type="button"
              >
                {switchingAccount ? "Switching…" : "Switch account"}
              </button>
            ) : null}
          </div>
        ) : null}
        {inputQueue && thread.role === "work" ? (
          <QueuedMessages
            client={hostClient}
            disabled={!canRespond || thread.status === "archived"}
            onEdit={(message) =>
              setRestoredDraft((current) => ({
                composer: composerKey,
                restore: { ...message, key: (current?.restore.key ?? 0) + 1 },
              }))
            }
            onError={reportActionError}
            queue={inputQueue}
          />
        ) : null}
        <InputSurface
          autoContext={home}
          variant={conversational ? "conversation" : "work"}
          key={composerKey}
          composerHidden={dock.composerHidden}
          disabled={!canRespond}
          inputRef={composerInputRef}
          onEscape={dockedRequests.length > 0 ? () => focusOpenRequest(bodyRef.current) : undefined}
          readOnly={thread.status === "archived"}
          onStop={
            stopTarget
              ? async () => {
                  try {
                    await hostClient.stopRun(thread.id);
                  } catch (error) {
                    reportActionError(error);
                  }
                }
              : undefined
          }
          placeholder={composerPlaceholder}
          recipient={recipient}
          // A conversation's Stop ends the reply under way, and Chat's cards each
          // stop their own task. A task's strip stops the task; this stops only
          // the turn under way, which leaves a task paused.
          stopLabel={
            conversational
              ? "Stop the reply"
              : workerAssignment(snapshot.assignments, thread.id)?.status === "open"
                ? "Pause this task"
                : "Stop the run"
          }
          restoredDraft={restoredDraft?.composer === composerKey ? restoredDraft.restore : null}
          running={stopTarget !== null}
          stopping={activity === "stopping"}
          threadId={thread.id}
          footerExtras={
            <>
              {/* The picker opens while a response runs. What it cannot do is
                  apply — and it says why, instead of being a dead control. */}
              <ExecutionControls
                suppressUsageNotice={usageRecovery !== null}
                access={{
                  engine: threadPlacement,
                  mode: thread.accessMode,
                  onApply: async (accessMode) => {
                    try {
                      await hostClient.updateThreadAccess(thread.id, accessMode);
                    } catch (error) {
                      reportActionError(error);
                    }
                  },
                }}
                disabled={!canRespond || thread.status === "archived"}
                onAuthenticate={openHarnessAuthentication ?? undefined}
                onRefresh={refreshHarnessCatalog}
                onApply={applyExecution}
                placements={executionPlacements}
                preferences={executionPreferences}
                returnFocusRef={composerInputRef}
                review={reviewSelection}
                reviewFresh={reviewFresh}
                selection={{
                  environmentId: thread.environmentId,
                  harnessInstanceId: thread.harnessInstanceId,
                  modelSelection: thread.modelSelection,
                }}
              />
            </>
          }
        />
      </div>
    </div>
  );
}

/**
 * The exact update a link or notification points at, under the parameter name
 * the deep-link reader in `@opensteer/core` uses. Read from the router rather
 * than `window.location`: a second notification for this same conversation
 * navigates without a `popstate` and would otherwise go unnoticed.
 */
function useAnchoredMessageId(): [string | null, () => void] {
  const [search, setSearch] = useSearchParams();
  const release = () => {
    const next = new URLSearchParams(search);
    if (!next.has("messageId")) return;
    next.delete("messageId");
    setSearch(next, { replace: true });
  };
  return [search.get("messageId"), release];
}

/**
 * A quote built from what the reader can already see. Only the source id is
 * authorization; the excerpt and attribution are there so they know what they
 * are about to ask about.
 */
function quoteFromMessage(message: MessageEntry, homeThreadId: string | null): ComposerQuote {
  // A message of places alone is quoted by their names.
  const text = (
    message.body ||
    [...(message.pages ?? []), ...(message.places ?? [])].map(placeContentLabel).join(", ")
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return {
    attribution: messageAuthorName(message.author, message.messageKind, homeThreadId),
    excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text,
    messageId: message.id,
  };
}

/** Keeps the reader on the model they chose when the target profile still offers it. */
function recoverySelection(
  placement: ThreadPlacementOption,
  current: ModelSelection,
): ExecutionSelection {
  const model = placement.models.find(
    (candidate) =>
      candidate.modelId === current.modelId && candidate.providerId === current.providerId,
  );
  return {
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: model ? selectionForModel(model, current.options) : placement.modelSelection,
  };
}

export interface ThreadUsageLimitRecovery {
  /** The account the failed Run was spending, named as the reader knows it. */
  readonly accountLabel: string;
  readonly alternative: ThreadPlacementOption | null;
  readonly alternativeAccountLabel: string | null;
  readonly resetsAt: string | null;
}

/**
 * What to offer once a Run has failed for want of plan capacity. A compatible
 * alternative is a profile on this Thread's own work location whose provider
 * session the Thread can continue in place — switching to anything else would
 * silently start a different conversation. Nothing here resends the message:
 * the reader chooses the account, then sends again.
 */
export function usageLimitRecovery(
  entries: readonly TranscriptEntry[],
  placements: readonly ThreadPlacementOption[],
  thread: ThreadSummary,
  now: number = Date.now(),
): ThreadUsageLimitRecovery | null {
  let latestRun: Extract<TranscriptEntry, { kind: "run" }> | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "run") {
      latestRun = entry;
      break;
    }
  }
  if (latestRun?.status !== "failed") return null;
  if (latestRun.error?.code !== harnessUsageLimitFailureCode) return null;
  const here = placements.filter((placement) => placement.environmentId === thread.environmentId);
  const current = here.find(
    (placement) => placement.harnessInstanceId === thread.harnessInstanceId,
  );
  const connection = current ? observedAccountConnection(current.observedConnections) : null;
  const alternative =
    here.find(
      (placement) =>
        placement.harnessInstanceId !== thread.harnessInstanceId &&
        placement.available &&
        current !== undefined &&
        placement.sourceId === current.sourceId &&
        placement.models.some(
          (model) =>
            model.providerId === thread.modelSelection.providerId &&
            model.modelId === thread.modelSelection.modelId,
        ) &&
        canContinueThreadOnPlacement(thread, placement) &&
        !usageLimitReached(placement, thread.modelSelection, now),
    ) ?? null;
  return {
    accountLabel: current ? placementAccountTitle(current) : "this account",
    alternative,
    alternativeAccountLabel: alternative ? placementAccountTitle(alternative) : null,
    resetsAt: connection ? describeConnectionReset(connection, now, thread.modelSelection) : null,
  };
}

/* ---- The conversation under a page, on a phone ---- */

/**
 * The sheet's edge, under a place on a phone: who the conversation is with —
 * mark or orb, name, and whether it needs the reader — tapped or dragged to
 * open the whole conversation or put it away; beside it, the way back to the
 * conversation alone.
 */
function ConversationSheetHandle({
  home,
  hostClient,
  onToggle,
  open,
  threadId,
  title,
}: {
  readonly home: boolean;
  readonly hostClient: HostClient;
  readonly onToggle: (open: boolean) => void;
  readonly open: boolean;
  readonly threadId: string;
  readonly title: string;
}) {
  const { nav } = useWorkspace();
  const directory = useTaskDirectory(hostClient);
  const specialistHome = directory.snapshot.workspaces.find(
    (workspace) => workspace.homeThreadId === threadId && workspace.kind === "specialized",
  );
  const tone = directory.rows.get(threadId)?.tone ?? "working";
  const start = useRef<number | null>(null);
  const dragged = useRef(false);
  const words = taskStateWords(tone);
  return (
    <div className="thread__sheet-row">
      <button
        aria-expanded={open}
        aria-label={`${title}${words ? ` — ${words}` : ""}. ${open ? "Show less of the conversation" : "Show the conversation"}`}
        className="thread__sheet-handle"
        onClick={() => {
          // The drag that ended here already decided.
          if (dragged.current) dragged.current = false;
          else onToggle(!open);
        }}
        onPointerDown={(event) => {
          start.current = event.clientY;
          dragged.current = false;
        }}
        onPointerUp={(event) => {
          const from = start.current;
          start.current = null;
          if (from === null || Math.abs(event.clientY - from) < 24) return;
          dragged.current = true;
          onToggle(event.clientY < from);
        }}
        type="button"
      >
        <span aria-hidden className="thread__sheet-grip" />
        <span aria-hidden className="thread__sheet-mark">
          {home ? (
            <ChatOrb size={20} />
          ) : specialistHome ? (
            <WorkspaceOrb
              icon={specialistHome.icon}
              name={specialistHome.name}
              color={specialistHome.color}
              size="small"
            />
          ) : (
            <TaskMark size={20} mark={threadMark(threadId, directory.snapshot)} />
          )}
        </span>
        <span className="thread__sheet-name">{title}</span>
        <TaskState state={tone} />
        <Icon
          className={open ? "thread__sheet-chevron" : "thread__sheet-chevron is-up"}
          name="chevron-down"
        />
      </button>
      <button
        aria-label="Hide computer"
        className="icon-btn thread__sheet-hide"
        onClick={() => nav.hideComputer()}
        title="Hide computer"
        type="button"
      >
        <Icon name="monitor-off" />
      </button>
    </div>
  );
}

/* ---- Empty state ---- */

function EmptyThread({ home = false }: { readonly home?: boolean }) {
  return (
    <div className="hero__inner">
      <BrandMark large />
      <h2 className="hero__title">What can I help you with?</h2>
      <p className="hero__subtitle">
        {home
          ? "Ask here. Updates from your tasks will arrive here too."
          : "Describe the outcome you want. Opensteer works in your Workspace and checks in when it needs you."}
      </p>
    </div>
  );
}
