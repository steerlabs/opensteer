import { useThreadTranscript, usePersonalResources } from "@opensteer/client/react";
import { useOutboxTranscript } from "@opensteer/client/react";
import { hostMessageOutbox, splitLocalMessages } from "@opensteer/client/host";
import { useTaskSourceView } from "../team/team-attachments.js";
import { useThreadVisits } from "@opensteer/client/react";
import { ThreadServerApprovals } from "./computer-apps/thread-server-approvals.js";
import { threadMark, type PasswordsSetupOffer } from "@opensteer/client/host";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { readTail, type TailReading } from "@opensteer/shared/tailFollow";
import {
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { placeContentLabel, type ModelSelection, type Request } from "@opensteer/core";
import {
  type ConversationActivitySelection,
  canContinueThreadOnPlacement,
  canRespondToRequests,
  conversationActivityTurn,
  conversationTurnRevealing,
  groupTranscriptEntries,
  incomingTranscriptMessages,
  observedSequence,
  placementAccountTitle,
  selectionForModel,
  threadActivity,
  threadComposerPlaceholder,
  threadStartHold,
  threadStartsRunForMessage,
  threadStopTarget,
  taskWaitingReason,
  usageLimitReached,
  visibleTranscript,
  withoutOwnAssignment,
  workerAssignment,
  assignmentPresentation,
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
} from "@opensteer/client/host";
import { computerUseNowSummary, threadComputerUseNow } from "@opensteer/client/integrations";
import {
  useRunPage,
  useTabsRevision,
  useThreadInputQueue,
  useWaitingInputs,
} from "@opensteer/client/react";
import { fromLivePage, useMediaQuery, usePageVisible, useWindowInForeground } from "../ui-utils.js";
import { AgentTranscript, ConversationActivity } from "./agent-activity.js";
import { useShell } from "./app-shell.js";
import { ExecutionControls } from "./execution-controls.js";
import {
  applyThreadExecution,
  reviewExecutionSwitch,
  reviewFreshStart,
  type ReviewedChoice,
} from "./execution-review.js";
import { RunningNow } from "./running-now.js";
import { SubagentPane } from "./subagent-pane.js";
import {
  AgentEngine,
  AgentsLive,
  TaskRows,
  rememberAgentRow,
  returnToAgentRow,
} from "./subagent-rows.js";
import { BesideSlot } from "./workspace/workspace-layout.js";
import { UsageNotice } from "./usage-notice.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";
import { Icon } from "./icon.js";
import type { ComposerQuote } from "./composer.js";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { InputSurface, RequestStack, focusOpenRequest, useRequestDock } from "./input-surface.js";
import { useVoiceOn } from "@opensteer/client/react";
import { VoiceStart } from "./voice.js";
import { WaitingInputs } from "./waiting-inputs.js";
import { setThreadReading } from "./thread-reading.js";
import { ThreadFind } from "./thread-find.js";
import { BrandMark } from "./brand.js";
import { useVisualViewportKeyboardInset } from "./visual-viewport-keyboard.js";
import { ConversationHeader } from "./workspace/conversation-header.js";
import { useBarYield } from "./workspace/bar-yield.js";
import { destinationPlaceKey } from "./workspace/navigation.js";
import { meteredConnection, RunPage, useRoom, useTypingHere } from "./workspace/run-page.js";
import { RunPlacePictureScope, useDisplayDecoding } from "./workspace/run-place-picture.js";
import { LivePlace, useRunPlaceView } from "./workspace/viewfinder.js";
import { useWorkspace } from "./workspace/workspace-context.js";
import { TaskMark, TaskState, taskStateWords } from "./workspace/task-mark.js";
import { useTaskDirectory } from "./workspace/task-directory.js";
import { PersonalReferences } from "./references/reference-scope.js";
import { Unavailable } from "./references/unavailable.js";
import { useConnectionGate, useConnectionLive } from "./connection-shell.js";
import { Gated } from "./connection-gate.js";
import { notFound, useLinkedRequest } from "./references/linked-request.js";

export function ThreadRoute() {
  const { threadId } = useParams();
  return <ThreadSurface threadId={threadId ?? null} />;
}

/** One task, wherever it is reached from: a row, a link, Voice. */
export function ThreadSurface({ threadId }: { readonly threadId: string | null }) {
  const { hostClient, placements, snapshot } = useShell();
  const { nav } = useWorkspace();
  const navigate = useNavigate();
  const transcript = useThreadTranscript(hostClient, threadId);
  usePersonalResources(hostClient, threadResourceKinds);
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  const missing =
    thread === null && threadId !== null && snapshot.threadLookups[threadId] === "missing";
  useEffect(() => {
    if (!threadId) return;
    hostClient.activateThread(threadId);
    return () => hostClient.deactivateThread?.(threadId);
  }, [hostClient, threadId]);
  // Back to where the reader came from, or Home when a link opened the app here.
  const back = () => {
    const state: unknown = window.history.state;
    if (typeof state === "object" && state && "idx" in state && Number(state.idx) > 0)
      void navigate(-1);
    else nav.openConversation("/", { replace: true });
  };

  // Until the task arrives the route has nothing to show: its connection, or
  // its own read giving up, is the one thing said.
  const gate = useConnectionGate(hostClient.connection, {
    scope: "route",
    ready: thread !== null || missing || threadId === null,
    onBack: back,
    failed:
      threadId && snapshot.threadLookups[threadId] === "failed"
        ? { resource: "this task", onRetry: () => hostClient.activateThread(threadId) }
        : null,
  });
  // A link to a task that was deleted, or that this reader may not see, says so;
  // otherwise its connection or its own read does, until the task arrives and
  // renders in the same frame under the gate as it fades.
  const gateView = thread ? null : (
    <div className="thread">{missing ? <Unavailable onBack={back} /> : gate}</div>
  );
  return (
    <Gated gate={gateView}>
      {thread ? (
        <ThreadView
          key={`${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}:${thread.id}`}
          requests={transcript.requests}
          canLoadEarlier={transcript.hasMore}
          canLoadNewer={transcript.hasNewer}
          moreRequests={transcript.moreRequests}
          moreTools={transcript.moreTools ?? false}
          moreNodes={transcript.moreNodes ?? false}
          inputQueueError={transcript.inputQueueError}
          entries={transcript.entries}
          environmentStatus={
            snapshot.environments.find((item) => item.id === thread.environmentId)?.status ??
            "disconnected"
          }
          executionPlacements={placements.filter(
            (placement) =>
              placement.environmentId === thread.environmentId &&
              // Only Codex carries a call, so this Thread can change account but not engine.
              (thread.id !== snapshot.voiceThreadId || placement.driverKind === "codex"),
          )}
          thread={thread}
          runQueue={transcript.runQueue}
          detailCurrent={transcript.synchronized}
        />
      ) : null}
    </Gated>
  );
}

const threadResourceKinds = ["environment", "harness", "harness-catalog", "settings"] as const;
const noRuns: readonly import("@opensteer/client/host").RunQueueEntry[] = [];

interface ThreadViewProps {
  requests: readonly Request[];
  canLoadEarlier: boolean;
  canLoadNewer?: boolean;
  moreRequests?: boolean;
  moreTools?: boolean;
  moreNodes?: boolean;
  inputQueueError?: unknown;
  entries: readonly TranscriptEntry[];
  detailCurrent?: boolean;
  runQueue?: readonly import("@opensteer/client/host").RunQueueEntry[];
  environmentStatus: EnvironmentStatus;
  executionPlacements: ThreadPlacementOption[];
  thread: ThreadSummary;
}

/** Where each conversation was left, by deployment, user and Thread. */
const readingPositions = new Map<
  string,
  { readonly scrollTop: number; readonly seenSequence: string | null }
>();

const renderPasswordsSuggestion = (offer: PasswordsSetupOffer) => (
  <PasswordsSuggestion offer={offer} />
);

function ThreadView({
  canLoadEarlier,
  canLoadNewer = false,
  moreRequests = false,
  moreTools = false,
  moreNodes = false,
  inputQueueError,
  entries,
  environmentStatus,
  executionPlacements,
  requests,
  runQueue = noRuns,
  detailCurrent = true,
  thread,
}: ThreadViewProps) {
  const teamSource = useTaskSourceView(thread.teamOrigin);
  const { dock: workspaceDock, nav, phone, selection, work } = useWorkspace();
  // A subagent opened from this conversation: in its column, or beside it when it stands alone and wide.
  const [searchParams] = useSearchParams();
  const openedNode = searchParams.get("subagent");
  const besideSlot = useContext(BesideSlot);
  const wide = useMediaQuery("(min-width: 1000px)");
  const paneLayout = besideSlot && wide && !work && !phone ? "beside" : "push";
  const pushed = openedNode !== null && paneLayout === "push";
  const [nowOpen, setNowOpen] = useState(false);
  const [requestFolded, setRequestFolded] = useState(false);
  const phoneStage = phone && work;
  const keyboardInset = useVisualViewportKeyboardInset();
  const {
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    refreshHarnessCatalog,
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
  const composerInputRef = useRef<HTMLElement | null>(null);
  // Whether new content keeps the reader at the foot, and where the scroller stood when last read.
  const tailRef = useRef<TailReading>({ follows: true, offset: 0 });
  const scrollGeometryRef = useRef<{
    readonly scroller: HTMLElement;
    readonly height: number;
    readonly viewport: number;
  } | null>(null);
  const [atTail, setAtTail] = useState(true);
  const seenSequenceRef = useRef<string | null>(null);
  const [pendingUpdates, setPendingUpdates] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierAnchor = useRef<{
    readonly scroller: HTMLElement;
    readonly key: string | null;
    readonly messageId: string | null;
    readonly top: number;
    readonly rows: ReadonlySet<string>;
  } | null>(null);
  const earlierFocus = useRef<{ button: HTMLElement; scroller: HTMLElement } | null>(null);
  const earlierMotion = useRef<Animation | null>(null);
  useEffect(() => () => earlierMotion.current?.cancel(), []);
  // True while the reader is held in a window loaded around an older update.
  // The live conversation is not being shown, so the foot of what is on screen
  // is not the conversation's tail and nothing here may claim it is.
  const [historical, setHistorical] = useState(false);
  const [revealMessage, setRevealMessage] = useState<{ readonly id: string } | null>(null);
  // A message a link named that this conversation no longer holds, or could not reach.
  const [missingMessage, setMissingMessage] = useState<{
    readonly id: string;
    readonly unloaded: boolean;
  } | null>(null);
  const [returning, setReturning] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [finding, setFinding] = useState(false);
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
  // Each conversation, for each signed-in user of each deployment, has its own
  // composer: its draft, files and unsent message never follow the reader to
  // another one, and nothing that finishes late lands in the wrong one.
  const composerKey = `${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}:${thread.id}`;
  useEffect(() => {
    setHistorical(false);
    setActivityView(null);
  }, [composerKey]);
  const inputQueue = useThreadInputQueue(hostClient, thread.id);
  const waiting = useWaitingInputs(hostClient, thread.id);
  // Links in the transcript open tabs; a tab change gives them a new source to read.
  const tabRevision = useTabsRevision(hostClient);
  const tabSource = useMemo(
    () => ({ tabs: snapshot.tabs, browserProfiles: snapshot.browserProfiles, tabRevision }),
    [snapshot.tabs, snapshot.browserProfiles, tabRevision],
  );
  // The composer's own record: words sent as new from an open edit are kept the same way.
  const outbox = hostMessageOutbox(hostClient);
  // The Tasks count opens a task at its exact request; one already answered stays answered.
  const location = useLocation();
  const focusRequest =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusRequest" in location.state &&
    typeof location.state.focusRequest === "string"
      ? location.state.focusRequest
      : null;
  const voiceThread = snapshot.voiceThreadId === thread.id;
  const onCall = useVoiceOn();
  // On a call, this Thread's Requests ride on the call bar, on every screen.
  const dock = useRequestDock(thread.id, requests, voiceThread && onCall);
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
    if (!known && moreRequests && detailCurrent) {
      void hostClient.loadMoreOverlays(thread.id, "requests").catch(reportActionError);
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
  }, [
    detailCurrent,
    dockedRequests,
    focusTarget,
    hostClient,
    moreRequests,
    openRequest,
    openRequestId,
    requests,
    thread.id,
  ]);
  const conversational = thread.purpose === "voice";
  // In work, a message waiting behind the current turn stands unsent at the
  // conversation's foot until a Run takes it. In a conversation the reply under
  // way takes it, so the reader's own waiting words are a sent bubble there.
  const conversation = useMemo(
    () =>
      withoutOwnAssignment(
        visibleTranscript(entries, inputQueue, { conversation: conversational }),
        thread.id,
      ),
    [conversational, entries, inputQueue, thread.id],
  );
  // The same answer every surface gives: what this Thread is doing, and
  // which Run, if any, a Stop would reach.
  // This device's waiting messages, drawn where they will stand once sent. They
  // meet the Host's copies before the queue is taken out, so one the Host
  // already holds in its queue is drawn once, there.
  const projected = useOutboxTranscript(outbox, thread.id, entries, snapshot.user?.id ?? null);
  const withOutbox = useMemo(
    () =>
      projected === entries
        ? conversation
        : withoutOwnAssignment(
            visibleTranscript(projected, inputQueue, { conversation: conversational }),
            thread.id,
          ),
    [conversation, conversational, entries, inputQueue, projected, thread.id],
  );
  const hasQueuedInputs = Boolean(inputQueue?.items.length);
  const startsRun = threadStartsRunForMessage({ runQueue, thread });
  const local = useMemo(
    () => splitLocalMessages(withOutbox, !conversational, hasQueuedInputs, startsRun),
    [conversational, hasQueuedInputs, startsRun, withOutbox],
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
      runQueue
        .filter((run) => run.threadId === thread.id)
        .toSorted((left, right) => left.runOrdinal - right.runOrdinal),
    [runQueue, thread.id],
  );
  // The same answer every surface gives: what this Thread is doing, and
  // which Run, if any, a Stop would reach.
  const activity = threadActivity({ entries, runQueue: runQueue, thread });
  const stopTarget = threadStopTarget({ runQueue: runQueue, thread });

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
      setFollows(false);
      // What had arrived by then was seen; only what came after is new.
      seenSequenceRef.current = saved.seenSequence;
      scroller.scrollTop = saved.scrollTop;
    }
    return () => {
      if (!scroller) return;
      if (tailRef.current.follows) readingPositions.delete(composerKey);
      else
        readingPositions.set(composerKey, {
          scrollTop: scroller.scrollTop,
          seenSequence: seenSequenceRef.current,
        });
    };
  }, [composerKey]);

  const setFollows = (follows: boolean) => {
    tailRef.current = { ...tailRef.current, follows };
    setAtTail(follows);
    if (!follows) return;
    seenSequenceRef.current = observed;
    setPendingUpdates(0);
  };

  // Reads where the reader stands and keeps a follower at the foot; a scroll
  // up lets go at once, so nothing pulls back against it. Only a scroll that
  // moved nothing but the position is the reader's own: layout can deliver a
  // scroll before ResizeObserver, and a changed viewport, content height or
  // scroll owner does not mean the reader moved. Requests matter too: a docked
  // request grows the input surface and would otherwise push the newest
  // activity out of view.
  const readScroller = (scrolled: boolean) => {
    const scroller = currentScroller();
    if (!scroller) return;
    const before = scrollGeometryRef.current;
    const own =
      scrolled &&
      before?.scroller === scroller &&
      before.height === scroller.scrollHeight &&
      before.viewport === scroller.clientHeight;
    const previous =
      before?.scroller === scroller
        ? tailRef.current
        : { ...tailRef.current, offset: scroller.scrollTop };
    const { follows } = readTail(
      previous,
      scroller.scrollTop,
      scroller.scrollHeight - scroller.clientHeight,
      own,
    );
    if (follows && !own) scroller.scrollTop = scroller.scrollHeight;
    tailRef.current = { follows, offset: scroller.scrollTop };
    scrollGeometryRef.current = {
      scroller,
      height: scroller.scrollHeight,
      viewport: scroller.clientHeight,
    };
    if (follows !== previous.follows) setFollows(follows);
  };
  const keepTailInView = () => readScroller(false);
  const handleScroll = () => readScroller(true);
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

  // Arriving work never moves a reader who is elsewhere; it offers.
  useEffect(() => {
    if (tailRef.current.follows) {
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

  const abandonEarlier = () => {
    earlierAnchor.current = null;
    earlierMotion.current?.cancel();
  };

  const goToTail = () => {
    abandonEarlier();
    setFollows(true);
    keepTailInView();
  };

  // Restore before paint on every page, including pages that only add Activity.
  useLayoutEffect(() => {
    const held = earlierAnchor.current;
    if (!held) return;
    const { scroller, top } = held;
    // A message keeps its id when an older page renames the turn row it sits in.
    const element =
      (held.messageId === null
        ? null
        : scroller.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(held.messageId)}"]`,
          )) ??
      (held.key === null
        ? null
        : scroller.querySelector<HTMLElement>(
            `[data-transcript-row="${CSS.escape(held.key)}"]:not(:empty)`,
          ));
    if (element) scroller.scrollTop += element.getBoundingClientRect().top - top;
    if (loadingEarlier) return;
    earlierAnchor.current = null;
    if (!element) return;
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row]:not(:empty)")];
    const newestEarlier = rows.findLast(
      (row) =>
        !held.rows.has(row.dataset.transcriptRow!) &&
        !row.contains(element) &&
        Boolean(row.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    if (!newestEarlier) return;
    const from = scroller.scrollTop;
    scroller.scrollTop = Math.max(
      0,
      from -
        Math.min(scroller.clientHeight * 0.6, newestEarlier.getBoundingClientRect().height + 16),
    );
    const distance = scroller.scrollTop - from;
    const transcript = scroller.querySelector<HTMLElement>(".transcript");
    if (!transcript || !distance || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    // Compensate the scroll with a brief slide in the app's existing motion.
    const style = getComputedStyle(transcript);
    earlierMotion.current =
      transcript.animate?.(
        [{ transform: `translateY(${distance}px)` }, { transform: "translateY(0)" }],
        {
          duration: Number.parseFloat(style.getPropertyValue("--duration-med")) || 220,
          easing: style.getPropertyValue("--ease-out").trim() || "ease-out",
        },
      ) ?? null;
  }, [conversation, loadingEarlier]);

  useLayoutEffect(() => {
    if (loadingEarlier) return;
    const held = earlierFocus.current;
    earlierFocus.current = null;
    if (held && !held.button.isConnected && document.activeElement === document.body) {
      held.scroller.tabIndex = -1;
      held.scroller.focus({ preventScroll: true });
    }
  }, [loadingEarlier]);

  const loadEarlier = async () => {
    if (loadingEarlier) return;
    const scroller = currentScroller();
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const visible = (element: HTMLElement) => element.getBoundingClientRect().bottom > top;
    const anchorRow = scroller
      ? [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row]:not(:empty)")].find(
          visible,
        )
      : undefined;
    const anchorMessage = anchorRow
      ? [...anchorRow.querySelectorAll<HTMLElement>("[data-message-id]")].find(visible)
      : undefined;
    const anchor = anchorMessage ?? anchorRow;
    const item = entries.find(({ id }) => id === anchorMessage?.dataset.messageId);
    if (item)
      hostClient.setTranscriptAnchor(
        thread.id,
        "itemId" in item ? (item.itemId ?? item.id) : item.id,
      );
    else if (anchorRow?.dataset.transcriptRow) {
      const group = groupTranscriptEntries(conversation).find(
        ({ key }) => key === anchorRow.dataset.transcriptRow,
      );
      const first =
        group?.kind === "turn"
          ? (group.turn.work[0] ?? group.turn.reply ?? group.turn.run)
          : group?.entry;
      if (first)
        hostClient.setTranscriptAnchor(
          thread.id,
          "itemId" in first ? (first.itemId ?? first.id) : first.id,
        );
    }
    const button = scroller?.querySelector<HTMLElement>(".transcript__load-earlier") ?? null;
    earlierMotion.current?.cancel();
    if (scroller)
      earlierAnchor.current = {
        scroller,
        key: anchorRow?.dataset.transcriptRow ?? null,
        messageId: anchorMessage?.dataset.messageId ?? null,
        top: anchor?.getBoundingClientRect().top ?? top,
        rows: new Set(
          [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row]:not(:empty)")].map(
            (row) => row.dataset.transcriptRow!,
          ),
        ),
      };
    if (scroller && button && document.activeElement === button)
      earlierFocus.current = { button, scroller };
    setFollows(false);
    setLoadingEarlier(true);
    try {
      await hostClient.loadEarlierTranscript(thread.id);
    } catch (error) {
      reportActionError(error);
    } finally {
      setLoadingEarlier(false);
    }
  };

  /* ---- Reading position: exact jumps ---- */

  // A window behind another app shows nothing to anyone; returning to it records what it shows.
  const foreground = useWindowInForeground();
  useThreadVisits(hostClient, thread.id, foreground);

  // What a notification has to know before it decides to interrupt: one about
  // the conversation on screen, at its tail, in front of the reader, is
  // telling them what they are already watching.
  useEffect(() => {
    setThreadReading({ atLatest: atTail && !historical, threadId: thread.id });
    return () => setThreadReading(null);
  }, [atTail, historical, thread.id]);

  /**
   * Moves the reader to one exact message, and leaves them there. A message
   * still waiting to be taken is at the foot, not in the history; one the
   * conversation no longer holds says so rather than doing nothing.
   */
  const jumpToMessage = async (messageId: string): Promise<boolean> => {
    setMissingMessage(null);
    if (inputQueue?.items.some((item) => item.message.id === messageId)) {
      requestAnimationFrame(() =>
        currentScroller()
          ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
          ?.scrollIntoView({ block: "center" }),
      );
      return true;
    }
    setHistorical(true);
    setFollows(false);
    setRevealMessage({ id: messageId });
    const missing = async (unloaded: boolean) => {
      setMissingMessage({
        id: messageId,
        unloaded,
      });
      await returnToLatest().catch(() => undefined);
      return false;
    };
    try {
      await hostClient.loadTranscriptAround(thread.id, messageId);
    } catch (error) {
      return missing(!notFound(error));
    }
    const anchored = hostClient
      .getThreadTranscript(thread.id)
      ?.getSnapshot()
      .entries.find((entry) => entry.kind === "message" && entry.id === messageId);
    if (anchored?.kind === "message")
      hostClient.setTranscriptAnchor(thread.id, anchored.itemId ?? anchored.id);
    if (
      !(hostClient.getThreadTranscript(thread.id)?.getSnapshot().entries ?? []).some(
        (entry) => entry.kind === "message" && entry.id === messageId,
      )
    )
      return missing(false);
    requestAnimationFrame(() => {
      const target = currentScroller()?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.classList.add("transcript__found");
      window.setTimeout(() => target.classList.remove("transcript__found"), 2400);
    });
    return true;
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
    abandonEarlier();
    await hostClient.loadLatestTranscript(thread.id);
    // The anchor is spent. Releasing it from the address as well is what lets
    // the same update be opened again later as a fresh jump.
    anchored.current = null;
    releaseAnchor();
    setRevealMessage(null);
    setHistorical(false);
    setFollows(true);
    requestAnimationFrame(keepTailInView);
  };

  // A notification or a link can name the exact update it is about. The router
  // owns the query, so a second notification for this same conversation — which
  // pushes a new entry rather than popping one — is seen here.
  const [anchoredMessageId, releaseAnchor] = useAnchoredMessageId();
  const [linkSearch, setLinkSearch] = useSearchParams();
  const anchored = useRef<string | null>(null);
  useEffect(() => {
    if (!anchoredMessageId || anchored.current === anchoredMessageId) return;
    anchored.current = anchoredMessageId;
    // A Run's link names the message that started it; its Activity opens once that is loaded.
    const runId = linkSearch.get("runId");
    if (runId) releaseLinkParam("runId");
    void jumpToMessage(anchoredMessageId)
      .then((found) => {
        if (found && runId && conversational) openActivity({ kind: "run", runId }, null);
      })
      .catch(reportActionError);
  }, [anchoredMessageId]);

  const releaseLinkParam = (name: string) =>
    setLinkSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  // A Request a link named: one still waiting opens where it is answered,
  // exactly as the Tasks count opens it; a finished one is shown, never answered again.
  const linkedRequest = useLinkedRequest(hostClient, thread.id, (id) =>
    setFocusTarget({ id, key: location.key }),
  );

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

  /* ---- Quoting a reply ---- */

  /** Quotes a message into this conversation's own composer, focused and unsent. */
  const replyWith = (message: MessageEntry) => {
    const quote = quoteFromMessage(message);
    const key = composerDraftKeyFor(snapshot.deploymentId, snapshot.user?.id, {
      kind: "thread",
      threadId: thread.id,
    });
    if (!key) return;
    const editId = composerDrafts.read(key)?.editId;
    void composerDrafts
      .handBack(key, { edit: (text) => text, quote }, editId)
      .catch(reportActionError);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const canRespond = detailCurrent && canRespondToRequests(snapshot);
  const connectionLive = useConnectionLive(hostClient.connection);
  const live = detailCurrent && connectionLive && environmentStatus === "connected";
  // What this client holds of the account is current only while it is live.
  const startHold = live
    ? threadStartHold({ environments: snapshot.environments, runQueue: runQueue, thread })
    : null;
  const composerPlaceholder = thread.teamOrigin
    ? "Message your agent privately"
    : threadComposerPlaceholder(conversation.length === 0);
  // The field names whom it writes to: the task by its name.
  const recipient = useMemo(() => ({ lead: "Reply to", name: thread.title }), [thread.title]);
  // A fact about this task's own computer, never about this app's connection.
  const taskLabel =
    thread.status === "archived"
      ? "Archived"
      : environmentStatus === "disconnected"
        ? `${thread.runnerLabel} offline`
        : null;
  const taskStatus =
    taskLabel !== null ? (
      <span className="thread__connection" role="status">
        <span className="thread__connection-label">{taskLabel}</span>
      </span>
    ) : null;
  const historyState = snapshot.threadLookups[thread.id];
  const historyStatus =
    historyState === "loading" && live ? (
      <span className="thread__connection" role="status">
        Loading messages…
      </span>
    ) : null;
  const threadSelection = useMemo(
    () => ({
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      modelSelection: thread.modelSelection,
    }),
    [thread.environmentId, thread.harnessInstanceId, thread.modelSelection],
  );
  const usageAlternative = useMemo(
    () => usageLimitAlternative(executionPlacements, thread),
    [executionPlacements, thread],
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

  const title = conversationName(thread.title);
  // Under the name only when the task is not plainly working, and only what is known.
  const waitingReason = useMemo(
    () =>
      thread.status === "waiting" ? taskWaitingReason(snapshot, thread.id, threadRunQueue) : null,
    [snapshot, thread.id, thread.status, threadRunQueue],
  );
  // What the task's own strip used to say beyond its state — offline, its
  // account preparing, a result that could not be returned — is said here.
  const assignmentBlock = useMemo(() => {
    const assignment = workerAssignment(snapshot.assignments, thread.id);
    return assignment
      ? (blockingDetail(assignmentPresentation(assignment, snapshot))?.text ?? null)
      : null;
  }, [snapshot, thread.id]);
  const cause = taskStatus ?? historyStatus ?? waitingReason?.label ?? assignmentBlock;

  // On a phone with the conversation alone, its Run's page can stand above it.
  const threadRef = useRef<HTMLDivElement | null>(null);
  const pageHere = phone && !work;
  // Where the head has no room for the page's folded picture, folded is a row above the thread.
  const [pictureYielded, setPictureYielded] = useState(false);
  const runId = stopTarget?.id ?? null;
  const runPlace = useRunPlaceView(hostClient, runId, thread.id).place;
  // The middle showing the Run's own place shows its picture there; no form here needs one.
  const placeInMiddle =
    runPlace !== null &&
    selection.kind === "place" &&
    destinationPlaceKey(selection.destination) === runPlace.placeKey;
  const pageVisible = usePageVisible();
  const room = useRoom(threadRef, pageHere && runPlace !== null);
  const typing = useTypingHere(threadRef, keyboardInset);
  // The owner opens a Mac app's or phone's stream only once a decoder here can draw it.
  const decoding = useDisplayDecoding(
    runPlace !== null && (runPlace.kind === "window" || runPlace.kind === "phone"),
  );
  // Some form of the place is drawn: the page or its row here, or the head's
  // picture, which yields to the row where the bar has no room for it.
  const pictureShown = (!work || phone || workspaceDock.open) && !placeInMiddle;
  const runPage = useRunPage({
    hostClient,
    threadId: thread.id,
    runId,
    paneVisible: pictureShown,
    displayCapable: decoding !== null,
    // Only where a page can stand is its opening something the person sees.
    visible: pageHere && pageVisible,
    typing,
    scrolledUp: !atTail,
    cellular: meteredConnection(),
    room: pageHere ? room : null,
    headHasRoom: !pictureYielded,
  });
  // Pressing the folded picture hands focus to the page it opens.
  const focusPage = useRef(false);
  const { open: openRunPage } = runPage;
  const unfoldRunPage = useCallback(() => {
    focusPage.current = document.activeElement?.closest(".viewfinder") != null;
    openRunPage();
  }, [openRunPage]);
  // The row stands in for an open page that has no picture yet; one standing
  // in for the head's picture leaves the head as it is.
  const pageStands = runPage.shown === "page" || (runPage.shown === "row" && !pictureYielded);

  // On a phone with a page open, the conversation is a sheet under it: the
  // composer and the latest reply, opened to the whole conversation on request.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Choosing a place is choosing to look at it.
  useEffect(() => setSheetOpen(false), [phoneStage, selection]);
  useLayoutEffect(() => {
    if (sheetOpen) keepTailInView();
  }, [sheetOpen]);

  const threadPath = nav.threadPath(thread.id);
  const openSubagent = useCallback(
    (nodeId: string, replace: boolean) => {
      rememberAgentRow(nodeId);
      nav.openConversation(threadPath, { subagent: nodeId, ...(replace ? { replace } : {}) });
    },
    [nav, threadPath],
  );
  const closeSubagent = useCallback(
    () => nav.openConversation(threadPath, { replace: true }),
    [nav, threadPath],
  );
  // Back from a subagent, focus returns to the row it was opened from; the transcript never moved.
  const wasOpen = useRef(openedNode);
  useLayoutEffect(() => {
    if (wasOpen.current !== null && openedNode === null) returnToAgentRow(scrollRef.current);
    wasOpen.current = openedNode;
  }, [openedNode]);
  // In the column, the open running list and an open question are not both expanded.
  const showRunning = useCallback((open: boolean) => {
    setNowOpen(open);
    if (open) setRequestFolded(true);
  }, []);
  const unfoldRequest = useCallback(() => {
    setRequestFolded(false);
    setNowOpen(false);
  }, []);
  const engine = threadPlacement?.driverKind ?? null;
  const pane =
    openedNode === null ? null : (
      <AgentEngine value={engine}>
        <AgentsLive value={live}>
          <SubagentPane
            key={openedNode}
            layout={paneLayout}
            live={live}
            nodeId={openedNode}
            onClose={closeSubagent}
            onOpen={openSubagent}
            threadId={thread.id}
            threadTitle={title}
          />
        </AgentsLive>
      </AgentEngine>
    );
  // A question the open subagent asked is answered in its own view, not here as well.
  const dockItems = useMemo(
    () =>
      openedNode === null
        ? dockedRequests
        : dockedRequests.filter((item) => item.surface.request.originatingNodeId !== openedNode),
    [dockedRequests, openedNode],
  );
  // The composer answers the question the stack shows, never one answered elsewhere.
  const shownRequest =
    dockItems.find((item) => item.surface.request.id === openRequestId) ?? dockItems[0];
  const dockQuestion = shownRequest?.surface.textRole === "answer" ? shownRequest : null;

  return (
    <PersonalReferences client={hostClient} threadId={thread.id}>
      <RunPlacePictureScope
        decoding={decoding}
        enabled={pictureShown}
        hostClient={hostClient}
        picture={runPage.picture}
        threadId={thread.id}
      >
        <AgentEngine value={engine}>
          <AgentsLive value={live}>
            <div
              className={[
                "thread",
                pushed ? "thread--pushed" : "",
                phoneStage
                  ? `thread--sheet ${sheetOpen ? "thread--sheet-open" : "thread--sheet-closed"}`
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              ref={threadRef}
            >
              {phoneStage ? (
                <ConversationSheetHandle
                  hostClient={hostClient}
                  onToggle={setSheetOpen}
                  open={sheetOpen}
                  runId={stopTarget?.id ?? null}
                  threadId={thread.id}
                  title={title}
                />
              ) : null}
              <ConversationHeader
                key={thread.id}
                cause={cause}
                hostClient={hostClient}
                onFind={() => setFinding(true)}
                onPictureYield={setPictureYielded}
                onUnfold={runPage.page === null ? null : unfoldRunPage}
                pageOpen={pageHere && pageStands}
                threadId={thread.id}
                title={title}
                titleRef={headerTitleRef}
              />

              {finding ? (
                <ThreadFind
                  client={hostClient}
                  onClose={() => setFinding(false)}
                  onJump={async (messageId) => void (await jumpToMessage(messageId))}
                  threadId={thread.id}
                />
              ) : null}

              {/* Wider than a phone no page opens here, but the row still stands in for a yielded head. */}
              {runPage.entry === null ||
              !pictureShown ||
              !(pageHere || runPage.shown === "row") ? null : (
                <RunPage
                  focusPage={focusPage}
                  foldedHere={pictureYielded}
                  hostClient={hostClient}
                  key={`${thread.id}:${runPage.entry.runId}`}
                  onFold={runPage.fold}
                  onUnfold={runPage.page === null ? null : unfoldRunPage}
                  page={runPage.page}
                  room={room}
                  runId={runPage.entry.runId}
                  scrollRef={scrollRef}
                  shown={runPage.shown}
                  threadId={thread.id}
                  threadRef={threadRef}
                />
              )}

              <div
                className="thread__body"
                onScroll={handleScroll}
                onWheel={abandonEarlier}
                onTouchStart={abandonEarlier}
                onPointerDown={abandonEarlier}
                onKeyDown={(event) => {
                  if (
                    ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(
                      event.key,
                    )
                  )
                    abandonEarlier();
                }}
                ref={bodyRef}
              >
                <div className="thread__conversation">
                  <div className="transcript-scroll" onScroll={handleScroll} ref={scrollRef}>
                    <div
                      aria-live="polite"
                      className={
                        conversational ? "transcript transcript--conversation" : "transcript"
                      }
                      role="log"
                    >
                      {canLoadEarlier || loadingEarlier ? (
                        <button
                          className="btn btn--small transcript__load-earlier"
                          disabled={loadingEarlier}
                          aria-busy={loadingEarlier}
                          aria-label={
                            loadingEarlier ? "Loading earlier messages" : "Earlier messages"
                          }
                          onClick={() => void loadEarlier()}
                          type="button"
                        >
                          {loadingEarlier ? (
                            <span aria-hidden="true" className="spinner" />
                          ) : (
                            <Icon name="arrow-up" />
                          )}
                          <span className="transcript__earlier-label">
                            <span aria-hidden={loadingEarlier}>Earlier messages</span>
                            {loadingEarlier ? <span>Loading…</span> : null}
                          </span>
                        </button>
                      ) : null}
                      {/* Gone with the first message, this device's waiting ones too, so
                          their bubbles never jump when the Host takes them. */}
                      {withOutbox.length === 0 && historyState === undefined && !waiting?.length ? (
                        <EmptyThread voice={voiceThread} />
                      ) : null}
                      <AgentTranscript
                        teamChannelName={teamSource?.channel.name ?? null}
                        revealMessage={revealMessage}
                        key={thread.id}
                        attachmentReader={hostClient}
                        activity={activity}
                        browserSessions={tabSource}
                        browserUses={snapshot.browserUses}
                        // A conversation (Opensteer, a direct message) reads as messages, each
                        // turn's steps behind its reply; work keeps its whole trace in view.
                        conversation={conversational}
                        live={live}
                        computers={computers}
                        entries={local.transcript}
                        afterQueue={local.afterQueue}
                        waitingRequests={snapshot.waitingRequests}
                        assignments={snapshot.assignments}
                        inputQueuePaused={thread.inputQueuePaused}
                        renderPasswordsSuggestion={renderPasswordsSuggestion}
                        queued={
                          !conversational && (waiting || local.afterQueue.length) ? (
                            <WaitingInputs
                              client={hostClient}
                              disabled={!canRespond}
                              inputs={waiting ?? []}
                              local={local.afterQueue}
                              transcript={projected}
                              onError={reportActionError}
                              paused={inputQueue?.paused ?? false}
                              resumable={thread.status !== "archived"}
                              threadId={thread.id}
                              viewerUserId={snapshot.user?.id ?? null}
                            />
                          ) : null
                        }
                        {...(conversational
                          ? {
                              activityOwner:
                                activityView?.source === "reply" &&
                                activityView.selection.kind === "turn"
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
                        renderTask={(entries) => <TaskRows entries={entries} />}
                        requestShown={dockedRequests.length > 0}
                        startHold={startHold}
                        subagentReader={snapshot}
                        threadId={thread.id}
                        viewerUserId={snapshot.user?.id ?? null}
                      />
                      {missingMessage ? (
                        <Unavailable
                          backLabel="Dismiss"
                          inline
                          unloaded={missingMessage.unloaded ? "this message" : null}
                          onBack={() => setMissingMessage(null)}
                          onRetry={() =>
                            void jumpToMessage(missingMessage.id).catch(reportActionError)
                          }
                        />
                      ) : null}
                    </div>
                  </div>

                  {/* An anchored search leaves the reader in an older window, and the only
          way back is to load the live one — so the offer stands whether or not
          anything new has arrived since. */}
                  {canLoadNewer ? (
                    <button
                      className="transcript__jump"
                      type="button"
                      onClick={() =>
                        void hostClient.loadNewerTranscript(thread.id).catch(reportActionError)
                      }
                    >
                      <Icon name="chevron-down" /> Load newer
                    </button>
                  ) : historical ? (
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
                        pendingUpdates > 0
                          ? "transcript__jump"
                          : "transcript__jump transcript__jump--quiet"
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
                {/* An older window can't say what runs now; back at the latest, it returns. */}
                {voiceThread || historical ? null : (
                  <div className="running-now-slot">
                    <RunningNow
                      live={live}
                      onOpenChange={showRunning}
                      open={nowOpen}
                      scroller={scrollRef}
                      threadId={thread.id}
                    />
                  </div>
                )}
                <ThreadServerApprovals threadId={thread.id} />
                {/* Requests stay enabled offline; an answer then says it wasn't sent. */}
                <RequestStack
                  composer={!voiceThread}
                  disabled={false}
                  folded={requestFolded && nowOpen && !historical}
                  items={dockItems}
                  onOpen={openRequest}
                  onUnfold={unfoldRequest}
                  openId={openRequestId}
                  threadId={thread.id}
                />
                {inputQueueError !== undefined ? (
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void hostClient.loadThreadInputQueue(thread.id).catch(reportActionError)
                    }
                  >
                    Retry loading waiting messages
                  </button>
                ) : null}
                {(["tools", "nodes"] as const).map((kind) =>
                  (kind === "tools" ? moreTools : moreNodes) ? (
                    <button
                      key={kind}
                      className="btn"
                      type="button"
                      disabled={!canRespond}
                      onClick={() =>
                        void hostClient.loadMoreOverlays(thread.id, kind).catch(reportActionError)
                      }
                    >
                      {kind === "tools" ? "Show more tools" : "Show more subagents"}
                    </button>
                  ) : null,
                )}
                {moreRequests ? (
                  <button
                    className="btn"
                    disabled={!canRespond}
                    type="button"
                    onClick={() =>
                      void hostClient
                        .loadMoreOverlays(thread.id, "requests")
                        .catch(reportActionError)
                    }
                  >
                    Show more requests
                  </button>
                ) : null}
              </div>

              {conversational && activityView ? (
                <ConversationActivity
                  anchor={
                    activityView.source === "reply"
                      ? (activityOwnerAnchor ?? activityView.opener)
                      : (activityAnchor() ?? activityView.opener)
                  }
                  browserSessions={tabSource}
                  browserUses={snapshot.browserUses}
                  entries={conversation}
                  id={activityPanelId}
                  inputQueuePaused={thread.inputQueuePaused}
                  live={live}
                  onClose={() => setActivityView(null)}
                  returnFocusTo={activityView.opener}
                  reveal={activityView.reveal}
                  selection={activityView.selection}
                  subagentReader={snapshot}
                  threadId={thread.id}
                />
              ) : null}

              <div className="composer-dock">
                {voiceThread ? (
                  <VoiceStart
                    dockHidden={phoneStage && !sheetOpen}
                    controls={
                      <ExecutionControls
                        disabled={!canRespond}
                        onAuthenticate={openHarnessAuthentication ?? undefined}
                        onRefresh={refreshHarnessCatalog}
                        onApply={applyExecution}
                        placements={executionPlacements}
                        preferences={executionPreferences}
                        review={reviewSelection}
                        reviewFresh={reviewFresh}
                        selection={threadSelection}
                      />
                    }
                  />
                ) : null}
                {voiceThread ? null : (
                  <InputSurface
                    autoContext={false}
                    voice={false}
                    variant={conversational ? "conversation" : "work"}
                    key={composerKey}
                    composerHidden={dock.composerHidden}
                    voiceHidden={phoneStage && !sheetOpen}
                    disabled={false}
                    inputRef={composerInputRef}
                    onEscape={
                      dockedRequests.length > 0
                        ? () => focusOpenRequest(bodyRef.current)
                        : undefined
                    }
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
                    question={dockQuestion}
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
                    running={stopTarget !== null}
                    stopping={activity === "stopping"}
                    threadId={thread.id}
                    footerExtras={
                      <>
                        {/* The picker opens while a response runs. What it cannot do is
                  apply — and it says why, instead of being a dead control. */}
                        <ExecutionControls
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
                          selection={threadSelection}
                        />
                      </>
                    }
                  />
                )}
                {dock.composerHidden ? null : (
                  <UsageNotice
                    action={
                      usageAlternative ? (
                        <button
                          className="usage-notice__action"
                          disabled={switchingAccount || !canRespond}
                          onClick={() => {
                            setSwitchingAccount(true);
                            void applyExecution(
                              recoverySelection(usageAlternative, thread.modelSelection),
                            ).finally(() => setSwitchingAccount(false));
                          }}
                          title={`Switch to ${placementAccountTitle(usageAlternative)}`}
                          type="button"
                        >
                          {switchingAccount ? "Switching…" : "Switch account"}
                        </button>
                      ) : null
                    }
                    entries={entries}
                    placements={executionPlacements}
                    returnFocusTo={composerInputRef}
                    selection={threadSelection}
                  />
                )}
              </div>
              {pushed ? pane : null}
              {paneLayout === "beside" && besideSlot && pane
                ? createPortal(pane, besideSlot)
                : null}
              {linkedRequest}
            </div>
          </AgentsLive>
        </AgentEngine>
      </RunPlacePictureScope>
    </PersonalReferences>
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
function quoteFromMessage(message: MessageEntry): ComposerQuote {
  // A message of places alone is quoted by their names.
  const text = (
    message.body ||
    [...(message.pages ?? []), ...(message.places ?? [])].map(placeContentLabel).join(", ")
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return {
    attribution: messageAuthorName(message.author),
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

/**
 * The account to offer beside a usage-limit notice: a profile on this
 * Thread's own work location whose provider session the Thread can continue
 * in place — switching to anything else would silently start a different
 * conversation — and that is not itself out of capacity. Nothing here resends
 * the message: the reader chooses the account, then sends again.
 */
export function usageLimitAlternative(
  placements: readonly ThreadPlacementOption[],
  thread: ThreadSummary,
  now: number = Date.now(),
): ThreadPlacementOption | null {
  const here = placements.filter((placement) => placement.environmentId === thread.environmentId);
  const current = here.find(
    (placement) => placement.harnessInstanceId === thread.harnessInstanceId,
  );
  if (!current) return null;
  return (
    here.find(
      (placement) =>
        placement.harnessInstanceId !== thread.harnessInstanceId &&
        placement.available &&
        placement.sourceId === current.sourceId &&
        placement.models.some(
          (model) =>
            model.providerId === thread.modelSelection.providerId &&
            model.modelId === thread.modelSelection.modelId,
        ) &&
        canContinueThreadOnPlacement(thread, placement) &&
        !usageLimitReached(placement, thread.modelSelection, now),
    ) ?? null
  );
}

/* ---- The conversation under a page, on a phone ---- */

/**
 * The sheet's edge, under a place on a phone: who the conversation is with —
 * mark or orb, name, and whether it needs the reader — tapped or dragged to
 * open the whole conversation or put it away; beside it, the way back to the
 * conversation alone.
 */
function ConversationSheetHandle({
  hostClient,
  onToggle,
  open,
  runId,
  threadId,
  title,
}: {
  readonly hostClient: HostClient;
  readonly onToggle: (open: boolean) => void;
  readonly open: boolean;
  /** The conversation's working Run, whose page stands beside the handle when it is not the one shown. */
  readonly runId: string | null;
  readonly threadId: string;
  readonly title: string;
}) {
  const { nav } = useWorkspace();
  const directory = useTaskDirectory(hostClient);
  const tone = directory.rows.get(threadId)?.tone ?? "working";
  const start = useRef<number | null>(null);
  const dragged = useRef(false);
  const words = taskStateWords(tone);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // The name truncates first; then the chevron, the mark, the state and the
  // picture give way. Hide computer never does: it leads back to the page above.
  useBarYield(rowRef, 4);
  return (
    <div className="thread__sheet-row" ref={rowRef}>
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
        <span aria-hidden className="thread__sheet-mark" data-yield={2}>
          <TaskMark size={20} mark={threadMark(threadId, directory.snapshot)} />
        </span>
        <span className="thread__sheet-name" data-yield-name>
          {title}
        </span>
        <span className="conv-header__yield" data-yield={3}>
          <TaskState state={tone} />
        </span>
        <span className="conv-header__yield" data-yield={1}>
          <Icon
            className={open ? "thread__sheet-chevron" : "thread__sheet-chevron is-up"}
            name="chevron-down"
          />
        </span>
      </button>
      {runId === null ? null : (
        <span className="conv-header__yield" data-yield={4}>
          <LivePlace hostClient={hostClient} key={runId} runId={runId} threadId={threadId} />
        </span>
      )}
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

function EmptyThread({ voice = false }: { readonly voice?: boolean }) {
  return (
    <div className="hero__inner">
      <BrandMark large />
      <h2 className="hero__title">{voice ? "Talk to Opensteer" : "What can I help you with?"}</h2>
      <p className="hero__subtitle">
        {voice
          ? "Say what you need. It gets on with it, starts tasks for bigger work, and tells you when it needs you."
          : "Describe the outcome you want. Your agent works in this task’s folder and checks in when it needs you."}
      </p>
    </div>
  );
}
