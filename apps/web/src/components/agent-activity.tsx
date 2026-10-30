import { useTaskSnapshot } from "./task-rows.js";
import { taskMark, threadMark } from "@opensteer/client/host";
import {
  createContext,
  useContext,
  Fragment,
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  type AskAbout,
  type BrowserSessionSummary,
  incomingMessageAction,
  activityStepHead,
  conversationActivities,
  conversationActivityTurn,
  conversationRows,
  conversationTurn,
  formatClockTime,
  formatElapsed,
  groupTranscriptEntries,
  hasRunOutcome,
  silentRunLabel,
  isTerminalRunEntryStatus,
  incomingMessagePreview,
  messagePages,
  replyPlaces,
  runPages,
  runPlace,
  threadActivityIndicator,
  toolBody,
  turnComputer,
  turnState,
  workRows,
  workSummary,
  workspaceMonogram,
  messageAuthorName,
  messageFoldLines,
  turnFolds,
  type ActivityStepHead,
  type ActivityTone,
  type ConversationActivity as ReplyActivity,
  type ConversationActivitySelection,
  type AssignmentEntry,
  type DelegationEntry,
  type MessageEntry,
  type ReasoningEntry,
  type SelectionEntry,
  type RequestReceiptEntry,
  type RunEntry,
  type ThreadActivity,
  type ToolEntry,
  type TranscriptEntry,
  type TranscriptGroup,
  type Turn,
  type WorkEntry,
  type WorkRow,
  type WorkspaceSummary,
  type HostClient,
} from "@opensteer/client/host";
import {
  computerUseNow,
  computerUseNowSummary,
  computerUseStop,
  computerUseStopLabel,
  computerUseStops,
  computerUseStopSentence,
  type ComputerUseNow,
  type ComputerUseStop,
} from "@opensteer/client/integrations";
import {
  useComputerUseStop,
  useComputerUseStopForRun,
  useThreadPlace,
} from "@opensteer/client/react";
import type { AssignmentSummary, BrowserPageContentPart, WaitingRequest } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { AttachmentReader, MessageAttachments } from "./attachments/message-attachments.js";
import { Dialog } from "./dialog.js";
import { Icon, type IconName } from "./icon.js";
import { Popover } from "./popover.js";
import {
  appChip,
  pageChip,
  phoneChip,
  SurfaceChip,
  SurfaceChips,
  type ChipSurface,
} from "./surface-chips.js";
import { MessageFold } from "./message-fold.js";
import { WorkspaceOrb } from "./workspace-orb.js";
import { TaskMark, ChatOrb } from "./workspace/task-mark.js";
import { useRunPicture, Viewfinder } from "./workspace/viewfinder.js";
import { automationPath, useMediaQuery } from "../ui-utils.js";
import { AreaLink } from "./workspace/area-link.js";

const Markdown = lazy(() => import("./markdown.js"));

const TranscriptLive = createContext(true);
/**
 * The request a waiting turn waits on is on screen, above the composer: a
 * "Waiting for you" line beside it would only repeat it.
 */
const RequestShown = createContext(false);
/**
 * A conversation reads as messages: Opensteer's reply is its bubble, and what
 * the turn did on the way there opens from it on request.
 */
const ConversationMode = createContext(false);
/** Quotes a reply into this conversation's composer. */
const ReplyWith = createContext<((message: MessageEntry) => void) | undefined>(undefined);
/** Opens a reply's Activity from the control the reader pressed. */
const OpenActivity = createContext<((turnKey: string, opener: HTMLElement) => void) | undefined>(
  undefined,
);
/** Each conversation turn's Activity, by turn key: the reply it belongs to. */
const ActivityOfTurn = createContext<ReadonlyMap<string, ReplyActivity>>(new Map());
/** The Activity a reply, or its typing, opened and still owns, if one is open. */
const ActivityOpenedFrom = createContext<ReplyActivityOwner | null>(null);
/**
 * Hands the conversation the control the owned Activity hangs from. The reply
 * under way that opened it becomes a reply, and the panel moves to that
 * reply's More rather than losing what it hung from.
 */
const ActivityAnchor = createContext<Dispatch<SetStateAction<HTMLElement | null>> | undefined>(
  undefined,
);

/**
 * A reply whose menu, or whose typing, opened the Activity on
 * screen: that control holds the panel until it closes, and nothing else
 * claims it.
 */
export interface ReplyActivityOwner {
  /** The panel's id, for the owning control's `aria-controls`. */
  readonly panelId: string;
  readonly turnKey: string;
  /** Closes the panel: the typing pressed again. */
  readonly onClose: () => void;
}
/** Activity reads as sentences: what each step did, not how long it took. */
const QuietSteps = createContext(false);
/** Draws a task where it was handed out. */
type TaskRenderer = (entry: AssignmentEntry) => ReactNode;
const TaskViews = createContext<TaskRenderer | undefined>(undefined);
/** The reader's Home: a message from it leads to Home itself, not to a Thread page. */
const HomeThread = createContext<string | null>(null);
/** Every browser this reader can see, which a Run's pages are looked up in. */
const TranscriptBrowsers = createContext<readonly BrowserSessionSummary[]>([]);
/** Whose transcript this is and the reader's Workspaces, which say who speaks in it. */
const Speakers = createContext<{
  readonly threadId: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}>({ threadId: null, workspaces: [] });

/**
 * The reader's Macs, and the client that stops one. Given, a live turn at work
 * on one of them says so where its status goes, with the Stop that ends it.
 */
export interface TranscriptComputers {
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
}
const ReaderComputers = createContext<TranscriptComputers | null>(null);
/** Draws a working reply's live picture of its place; without it replies list chips only. */
const RunPictures = createContext<HostClient | null>(null);

const noWorkspaces: readonly WorkspaceSummary[] = [];
const noWaitingRequests: readonly WaitingRequest[] = [];
const noAssignments: Readonly<Record<string, AssignmentSummary>> = {};
const noBrowsers: readonly BrowserSessionSummary[] = [];

/**
 * The agent's side of the conversation.
 *
 * Prose and compact tool rows share the reading stream. The run's status is
 * a separate line: it never controls whether the agent's words are visible.
 */
export function AgentTranscript({
  activity = "idle",
  attachmentReader = null,
  conversation = false,
  computers = null,
  live = true,
  entries,
  waitingRequests = noWaitingRequests,
  assignments = noAssignments,
  browserSessions = noBrowsers,
  engineName,
  homeThreadId = null,
  activityOwner = null,
  askAbout,
  onOpenActivity,
  onReply,
  onActivityAnchor,
  renderTask,
  requestShown = false,
  revealMessage = null,
  pictures = null,
  startHold = null,
  threadId = null,
  unreadBoundarySequence = null,
  inputQueuePaused = false,
  viewerUserId = null,
  workspaces = noWorkspaces,
}: {
  /** What the Thread is doing, which decides the line under its transcript. */
  activity?: ThreadActivity;
  /** The reply whose menu opened the Activity on screen, which its More then controls. */
  activityOwner?: ReplyActivityOwner | null;
  /** Reads the bytes behind message attachments; without it they show as names only. */
  attachmentReader?: HostClient | null;
  /**
   * Reads as a conversation: each turn shows its reply as Opensteer's message
   * and keeps everything else it did behind that message, until asked.
   */
  conversation?: boolean;
  computers?: TranscriptComputers | null;
  live?: boolean;
  entries: readonly TranscriptEntry[];
  waitingRequests?: readonly WaitingRequest[];
  assignments?: Readonly<Record<string, AssignmentSummary>>;
  browserSessions?: readonly BrowserSessionSummary[];
  /**
   * Names the engine behind a recorded selection, as the reader knows it.
   * Without it the marker names the model alone rather than guessing.
   */
  engineName?: ((harnessInstanceId: string) => string | null) | undefined;
  homeThreadId?: string | null;
  /** Given, every update published by another agent offers it. */
  askAbout?: AskAbout | undefined;
  /**
   * Given, each reply in a conversation that did anything on the way offers
   * its Activity, opened from the control the reader pressed.
   */
  onOpenActivity?: ((turnKey: string, opener: HTMLElement) => void) | undefined;
  /** Given, each reply in a conversation offers to be quoted into the composer. */
  onReply?: ((message: MessageEntry) => void) | undefined;
  /**
   * Draws a task's card under the reply that handed it out. Only a surface
   * holding the Host client can offer to view or stop one, so without it tasks
   * are not drawn.
   */
  renderTask?: TaskRenderer | undefined;
  /** Told the control the Activity on screen hangs from while a reply owns it. */
  onActivityAnchor?: Dispatch<SetStateAction<HTMLElement | null>> | undefined;
  /** A request waiting on the reader is on screen, so "Waiting for you" is not said again. */
  requestShown?: boolean;
  revealMessage?: { readonly id: string } | null;
  /**
   * Given, a reply whose Run is working draws a live picture of the place it
   * acted in last, under its chips ([`useRunPicture`](./workspace/viewfinder.tsx)).
   */
  pictures?: HostClient | null;
  /** Why the Thread's queued work has not started, from `threadStartHold`. */
  startHold?: string | null;
  /** The Thread this transcript is, whose mark its own replies wear. */
  threadId?: string | null;
  /**
   * How far the reader had read when they arrived, as the Host recorded it.
   * The divider stands before the first message published past it. Null for a
   * conversation this reader has never opened, which has no inside boundary.
   */
  unreadBoundarySequence?: string | null;
  inputQueuePaused?: boolean;
  viewerUserId?: string | null;
  workspaces?: readonly WorkspaceSummary[];
}) {
  const groups = useMemo(
    () => groupTranscriptEntries(entries, { inputQueuePaused, startHold, assignments }),
    [entries, inputQueuePaused, startHold, assignments],
  );
  const unreadBoundaryKey = useMemo(
    () => firstUnreadGroupKey(groups, conversation ? null : unreadBoundarySequence),
    [conversation, groups, unreadBoundarySequence],
  );
  const activities = useMemo(() => {
    const byTurn = new Map<string, ReplyActivity>();
    if (!conversation) return byTurn;
    for (const activity of conversationActivities(groups)) {
      for (const key of activity.keys) byTurn.set(key, activity);
    }
    return byTurn;
  }, [conversation, groups]);
  const threadPlace = useThreadPlace(pictures, threadId);
  const rows = useMemo(
    () =>
      conversation
        ? // Every turn at work on a computer is kept: its row decides in place
          // whether this reader is shown that Mac (ConversationTurn), and a
          // row that draws nothing takes no room on this screen. A reply
          // waiting on the person is kept while its live picture is.
          conversationRows(groups, {
            atComputer: (turn) => turnComputer(turn) !== null,
            live,
            waitingRequests,
            pictured: (turn) => runPlace(threadPlace, workingRunId(turn)) !== null,
          })
        : groups.map((group) => ({ group, key: group.key })),
    [conversation, groups, live, threadPlace, waitingRequests],
  );
  const indicator =
    live && !(requestShown && activity === "waiting_for_you")
      ? threadActivityIndicator(activity, { conversation, groups, startHold })
      : null;
  const speakers = useMemo(() => ({ threadId, workspaces }), [threadId, workspaces]);

  return (
    <TranscriptLive value={live}>
      <RequestShown value={requestShown}>
        <ConversationMode value={conversation}>
          <ReplyWith value={onReply}>
            <OpenActivity value={onOpenActivity}>
              <ActivityOfTurn value={activities}>
                <ActivityOpenedFrom value={activityOwner}>
                  <ActivityAnchor value={onActivityAnchor}>
                    <TaskViews value={renderTask}>
                      <HomeThread value={homeThreadId}>
                        <AttachmentReader value={attachmentReader}>
                          <ReaderComputers value={computers}>
                            <TranscriptBrowsers value={browserSessions}>
                              <Speakers value={speakers}>
                                <RunPictures value={pictures}>
                                  {rows.map(({ group, key }) => (
                                    <Fragment key={key}>
                                      {group.key === unreadBoundaryKey ? <UnreadDivider /> : null}
                                      {group.kind === "turn" ? (
                                        <TurnView
                                          reveal={revealMessage}
                                          turn={group.turn}
                                          turnKey={group.key}
                                        />
                                      ) : group.kind === "delegation" ? (
                                        <DelegationNotice delegation={group.entry} />
                                      ) : group.kind === "assignment" ? (
                                        renderTask?.(group.entry)
                                      ) : group.kind === "selection" ? (
                                        <SelectionMarker
                                          entry={group.entry}
                                          engineName={engineName}
                                        />
                                      ) : (
                                        <Message
                                          reveal={
                                            revealMessage?.id === group.entry.id
                                              ? revealMessage
                                              : null
                                          }
                                          message={group.entry}
                                          askAbout={askAbout}
                                          viewerUserId={viewerUserId}
                                          workspaces={workspaces}
                                        />
                                      )}
                                    </Fragment>
                                  ))}
                                  {indicator === null ? null : indicator.kind === "typing" ? (
                                    // No turn has begun, so there is no Activity to open yet.
                                    <div className="turn turn--conversation">
                                      <Typing />
                                    </div>
                                  ) : (
                                    <WorkingIndicator label={indicator.label} />
                                  )}
                                </RunPictures>
                              </Speakers>
                            </TranscriptBrowsers>
                          </ReaderComputers>
                        </AttachmentReader>
                      </HomeThread>
                    </TaskViews>
                  </ActivityAnchor>
                </ActivityOpenedFrom>
              </ActivityOfTurn>
            </OpenActivity>
          </ReplyWith>
        </ConversationMode>
      </RequestShown>
    </TranscriptLive>
  );
}

/* ---- A turn ---- */

function TurnView({
  reveal,
  turn,
  turnKey,
}: {
  /** A message the reader is being taken to: a fold holding it opens first. */
  reveal: { readonly id: string } | null;
  turn: Turn;
  turnKey: string;
}) {
  const live = useContext(TranscriptLive);
  const conversation = useContext(ConversationMode);
  const renderTask = useContext(TaskViews);
  // Open for as long as the reader is on the task: a fold they opened stays open.
  const [opened, setOpened] = useState(false);
  useLayoutEffect(() => {
    if (
      reveal !== null &&
      turn.work.some((entry) => entry.kind === "message" && entry.id === reveal.id) &&
      reveal.id !== turn.reply?.id
    )
      setOpened(true);
  }, [reveal, turn.reply, turn.work]);
  if (conversation) return <ConversationTurn turn={turn} turnKey={turnKey} />;
  const spoken = turn.reply ?? turn.work.find((entry) => entry.kind === "message");
  const outcome = turn.run !== null && showsRunOutcome(turn.run);
  const placesUnderOutcome = !turn.continued && outcome && turn.reply === null;
  return (
    <div className="turn" data-run-id={turn.runId ?? undefined}>
      <AgentByline author={spoken?.kind === "message" ? spoken.author : null} />
      <TurnContent
        fold={turnFolds(turn) ? { open: opened, onToggle: () => setOpened(!opened) } : undefined}
        turn={turn}
        live={live}
      />
      {turn.continued || placesUnderOutcome ? null : (
        <ReplySurfaces turn={turn} turnKey={turnKey} />
      )}
      {turn.assignments.map((entry) => (
        <Fragment key={entry.id}>{renderTask?.(entry)}</Fragment>
      ))}
      {turn.run && outcome ? <RunOutcome run={turn.run} /> : null}
      {placesUnderOutcome ? <ReplySurfaces turn={turn} turnKey={turnKey} /> : null}
    </div>
  );
}

/**
 * Who speaks, when it is not the task itself: a specialist's work keeps the
 * specialist's own orb and name, and the orb is Opensteer's for its own
 * conversation and its platform notes. A task's own turns have no byline,
 * because the header above them already names the task.
 */
function AgentByline({ author }: { author: MessageEntry["author"] | null }) {
  const homeThreadId = useContext(HomeThread);
  const reader = useContext(AttachmentReader);
  const { threadId: transcriptThreadId, workspaces } = useContext(Speakers);
  const agent = author?.kind === "agent" ? author : null;
  const threadId = agent?.threadId ?? transcriptThreadId;
  if (author?.kind === "platform" || threadId === null || threadId === homeThreadId) {
    return (
      <span className="msg--assistant__author">
        <ChatOrb size={16} />
        Opensteer
      </span>
    );
  }
  if (agent === null || agent.threadId === transcriptThreadId) return null;
  const specialist = workspaces.find(({ id, kind }) => id === agent.workspaceId && kind !== "main");
  if (specialist) {
    return (
      <span className="msg--assistant__author">
        <WorkspaceOrb
          icon={specialist.icon}
          name={specialist.name}
          size="tiny"
          color={specialist.color}
        />
        {agent.displayName}
      </span>
    );
  }
  return (
    <span className="msg--assistant__author">
      {reader ? (
        <BylineTaskMark reader={reader} threadId={agent.threadId} />
      ) : (
        <TaskMark size={16} mark={taskMark({ icon: null })} />
      )}
      {agent.displayName}
    </span>
  );
}

function BylineTaskMark({
  reader,
  threadId,
}: {
  readonly reader: HostClient;
  readonly threadId: string;
}) {
  const mark = threadMark(threadId, useTaskSnapshot(reader));
  return <TaskMark size={16} mark={mark} />;
}

function WorkStatus({
  onToggle,
  open,
  turn,
}: {
  /** Given, the line is the disclosure for the turn's folded trace. */
  onToggle?: () => void;
  open?: boolean;
  turn: Turn;
}) {
  const summary = useMemo(() => workSummary(turn), [turn]);
  const connected = useContext(TranscriptLive);
  const requestShown = useContext(RequestShown);
  const now = useComputerUseNow(turn);
  const kept = useKeptComputerStop(turn, now);
  const unsettled = summary.state !== "settled";
  const live = connected && unsettled;
  if (now) return <ComputerUseLine key={now.session.sessionId} now={now} />;
  if (kept) return <KeptComputerStopLine key={kept.sessionId} stop={kept} />;
  if (summary.state === "waiting" && requestShown && !onToggle) return null;
  const head = (
    <>
      <span className="work__label">
        {summary.state === "live" && restartPending(turn.run) ? restartingLabel : summary.label}
      </span>
      {!unsettled && summary.meta ? <span className="work__meta">{summary.meta}</span> : null}
      {!unsettled && summary.errors > 0 ? <ErrorCount count={summary.errors} /> : null}
      {live && summary.startedAt ? <LiveClock startedAt={summary.startedAt} /> : null}
    </>
  );
  return (
    <div aria-label="Agent status" className={live ? "work work--live" : "work"}>
      {onToggle ? (
        <button
          aria-expanded={open}
          className={
            open ? "work__head work__toggle work__toggle--open" : "work__head work__toggle"
          }
          onClick={onToggle}
          type="button"
        >
          {head}
          <span aria-hidden className="work__chevron">
            <Icon name="chevron-right" />
          </span>
        </button>
      ) : (
        <div className="work__head">{head}</div>
      )}
    </div>
  );
}

/**
 * The reader's Mac a live turn is working on, or null. A transcript that
 * cannot confirm what is live — its Host out of reach, its environment gone —
 * says so in its own status instead.
 */
function useComputerUseNow(turn: Turn): ComputerUseNow | null {
  const connected = useContext(TranscriptLive);
  const computers = useContext(ReaderComputers);
  return useMemo(
    () => (connected && computers ? computerUseNow(turn, computers.machines) : null),
    [computers, connected, turn],
  );
}

/**
 * The turn's status while it works on the reader's Mac: what it is doing,
 * then where, and the Stop. The app's chip under the reply is the one way to
 * the app itself. Screen readers hear the Mac once, when the line arrives, not
 * every step it takes there.
 */
function ComputerUseLine({ now }: { now: ComputerUseNow }) {
  const computers = useContext(ReaderComputers);
  const hostClient = computers?.hostClient ?? null;
  // The outcome belongs to the session, not to this line: the line leaves
  // with the session, which the Host forgets before the Mac has answered.
  const stop = useComputerUseStop(hostClient, now.session.sessionId);
  const stopping = stop?.phase === "stopping" || stop?.phase === "stopped";
  const failure = stop?.phase === "failed" ? stop : null;
  const sendStop = () => {
    if (!hostClient) return;
    computerUseStops(hostClient).stop({
      machineName: now.machine.name,
      runId: now.session.runId,
      sessionId: now.session.sessionId,
    });
  };
  return (
    <div className="computer-now">
      <span aria-hidden className="computer-now__glyph">
        <Icon name={now.kind === "phone" ? "phone" : "laptop"} />
      </span>
      <span className="computer-now__text">
        <span className="computer-now__action">{now.action}</span>
        {failure ? (
          <span className="computer-now__failure" role="alert">
            {failure.message ?? computerUseStopSentence(failure)}
          </span>
        ) : (
          <span className="computer-now__place">{now.place}</span>
        )}
      </span>
      <span className="visually-hidden" role="status">
        {computerUseNowSummary(now)}
      </span>
      <button
        aria-label={
          stopping
            ? undefined
            : now.kind === "phone"
              ? `Stop using phone, ${now.machine.name}`
              : computerUseStopLabel(now.machine.name)
        }
        className="computer-now__stop"
        disabled={stopping}
        onClick={sendStop}
        type="button"
      >
        {stopping
          ? computerUseStop.busyLabel
          : now.kind === "phone"
            ? "Stop using phone"
            : computerUseStop.label}
      </button>
    </div>
  );
}

/** How long a confirmed Stop stays on the line after its session has gone. */
const keptStoppedMs = 3_000;

/**
 * A Stop whose session has left the Mac's list before, or as, it was
 * answered. While the turn is still at work the line says so — `Stopping…`,
 * then `Stopped using Mac mini` for a moment — instead of reading as
 * ordinary work.
 */
function useKeptComputerStop(turn: Turn, now: ComputerUseNow | null): ComputerUseStop | null {
  const connected = useContext(TranscriptLive);
  const computers = useContext(ReaderComputers);
  const stop = useComputerUseStopForRun(computers?.hostClient ?? null, turn.runId);
  const settledAt = stop?.phase === "stopped" ? stop.settledAt : null;
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (settledAt === null) return;
    const timer = window.setTimeout(
      () => setExpired(settledAt),
      Math.max(0, keptStoppedMs - (performance.now() - settledAt)),
    );
    return () => window.clearTimeout(timer);
  }, [settledAt]);
  if (now !== null || stop === null || !connected || turnState(turn) === "settled") return null;
  if (stop.phase === "failed") return null;
  if (
    settledAt !== null &&
    (expired === settledAt || performance.now() - settledAt >= keptStoppedMs)
  ) {
    return null;
  }
  return stop;
}

/** The line a Stop leaves behind while its answer is on the way or just in. */
function KeptComputerStopLine({ stop }: { stop: ComputerUseStop }) {
  return (
    <div className="computer-now">
      <span aria-hidden className="computer-now__glyph">
        <Icon name="laptop" />
      </span>
      <span aria-atomic="true" className="computer-now__text" role="status">
        <span className="computer-now__action">{computerUseStopSentence(stop)}</span>
        {stop.phase === "stopping" ? (
          <span className="computer-now__place">On {stop.machineName}</span>
        ) : null}
      </span>
    </div>
  );
}

/* ---- A turn in a conversation ---- */

/**
 * One turn of a conversation. Opensteer's reply is its message, and until
 * there is one something holds its place: Opensteer typing, or its work on the
 * reader's Mac with the Stop for it. What the turn did on the way is its
 * Activity, opened from the typing or the reply's menu, so the conversation
 * reads as what was said.
 */
function ConversationTurn({ turn, turnKey }: { turn: Turn; turnKey: string }) {
  const live = useContext(TranscriptLive);
  const renderTask = useContext(TaskViews);
  const view = useMemo(() => conversationTurn(turn), [turn]);
  const now = useComputerUseNow(turn);
  const kept = useKeptComputerStop(turn, now);
  const composing = view.composing && live && now === null && kept === null;
  const working = turn.personWaiting !== false && live && workingRunId(turn) !== null;
  const startHold = live ? view.startHold : null;
  const outcome = turn.personWaiting !== false && turn.run !== null && showsRunOutcome(turn.run);
  // A Run that ended without a reply, stopped or failed, keeps its places under how it ended.
  const placesUnderOutcome = outcome && view.reply === null;
  const tasks = renderTask === undefined ? [] : turn.assignments;
  const openActivity = useContext(OpenActivity);
  // The conversation leaves out a turn with nothing of its own to show
  // (`conversationRows`). One can still come to nothing here for what
  // only this screen knows: a Mac session it is not shown, or tasks it has no
  // card for.
  if (
    !now &&
    !kept &&
    !composing &&
    !working &&
    !startHold &&
    !view.reply &&
    !outcome &&
    tasks.length === 0
  )
    return null;
  return (
    <div className="turn turn--conversation">
      {now ? (
        <ComputerUseLine key={now.session.sessionId} now={now} />
      ) : kept ? (
        <KeptComputerStopLine key={kept.sessionId} stop={kept} />
      ) : null}
      {composing && restartPending(turn.run) ? <RunRestart>{restartingLabel}</RunRestart> : null}
      {view.reply && turn.source ? <TurnSource source={turn.source} /> : null}
      {view.reply ? (
        <ReplyBubble message={view.reply} turnKey={turnKey} />
      ) : composing ? (
        <Typing turnKey={turnKey} />
      ) : startHold !== null ? (
        <WorkingIndicator label={startHold} />
      ) : null}
      {(view.reply || view.composing || working) && !placesUnderOutcome ? (
        <ReplySurfaces turn={turn} turnKey={turnKey} />
      ) : null}
      {tasks.map((entry) => (
        <Fragment key={entry.id}>{renderTask?.(entry)}</Fragment>
      ))}
      {turn.run && outcome ? (
        turn.run.status === "completed" && turn.run.replyMessageId === null ? (
          <button
            type="button"
            className="run-note run-note--worked"
            onClick={(event) => openActivity?.(turnKey, event.currentTarget)}
          >
            {silentRunLabel(turn.run)}
            <Icon name="chevron-right" />
          </button>
        ) : (
          <RunOutcome conversation run={turn.run} />
        )
      ) : null}
      {placesUnderOutcome ? <ReplySurfaces turn={turn} turnKey={turnKey} /> : null}
    </div>
  );
}

/**
 * The Run a turn is working in, or null once it settled. A Run is on the
 * latest of its stretches only, so that stretch alone draws its picture.
 */
function workingRunId(turn: Turn): string | null {
  return turn.run !== null && turnState(turn) !== "settled" ? turn.runId : null;
}

/**
 * The pages and Mac apps a reply's Run worked in, under the reply: the way
 * back to exactly the browser or app it used. Every stretch of the Run counts,
 * so a reply that a message interrupted still lists what came before.
 */
function ReplySurfaces({ turn, turnKey }: { turn: Turn; turnKey: string }) {
  const sessions = useContext(TranscriptBrowsers);
  const computers = useContext(ReaderComputers);
  const pictures = useContext(RunPictures);
  const { threadId } = useContext(Speakers);
  const whole = useContext(ActivityOfTurn).get(turnKey)?.turn ?? turn;
  const surfaces = useMemo(
    () =>
      replyPlaces(whole, sessions, computers?.machines ?? []).map((place) =>
        place.kind === "page"
          ? pageChip(place.page, sessions)
          : place.kind === "phone"
            ? phoneChip(place.phone)
            : appChip(place.app),
      ),
    [computers?.machines, sessions, whole],
  );
  const working = workingRunId(turn);
  return pictures && working && threadId ? (
    <WorkingReplySurfaces
      hostClient={pictures}
      runId={working}
      surfaces={surfaces}
      threadId={threadId}
    />
  ) : (
    <SurfaceChips label={replySurfacesLabel} surfaces={surfaces} />
  );
}

const replySurfacesLabel = "Pages and apps this reply used";

/** A working reply's chips, the one its picture shows highlighted, and the picture under them. */
function WorkingReplySurfaces({
  hostClient,
  runId,
  surfaces,
  threadId,
}: {
  hostClient: HostClient;
  runId: string;
  surfaces: readonly ChipSurface[];
  threadId: string;
}) {
  const place = useRunPicture(hostClient, threadId, runId);
  return (
    <>
      <SurfaceChips
        activeKey={place?.placeKey ?? null}
        label={replySurfacesLabel}
        surfaces={surfaces}
      />
      {place ? (
        <div className="viewfinder-slot">
          <Viewfinder hostClient={hostClient} place={place} threadId={threadId} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The id of the Activity on screen while this turn's reply owns it, else
 * null. The typing opened it, or the reply's menu did, from this
 * turn or from an earlier stretch of the same reply: a message that joins a
 * reply renames the stretch it goes on in, and the panel stays that reply's.
 */
function useOwnedActivity(turnKey: string | null): string | null {
  const owner = useContext(ActivityOpenedFrom);
  const activities = useContext(ActivityOfTurn);
  if (owner === null || turnKey === null) return null;
  const activity = activities.get(turnKey);
  return owner.turnKey === turnKey ||
    (activity !== undefined && activity === activities.get(owner.turnKey))
    ? owner.panelId
    : null;
}

/** Hangs the owned Activity from `control` while `panelId` says this turn owns it. */
function useActivityAnchor(panelId: string | null, control: RefObject<HTMLElement | null>) {
  const setAnchor = useContext(ActivityAnchor);
  useLayoutEffect(() => {
    const element = control.current;
    if (panelId === null || setAnchor === undefined || element === null) return;
    setAnchor(element);
    return () => setAnchor((current) => (current === element ? null : current));
  }, [control, panelId, setAnchor]);
}

/** Opensteer's reply: a message, with what can be done with it one menu away. */
function ReplyBubble({
  message,
  turnKey = null,
}: {
  message: MessageEntry;
  /** The turn it answers, whose Activity it offers; none for a reply no turn wrote. */
  turnKey?: string | null;
}) {
  const replyWith = useContext(ReplyWith);
  const openActivity = useContext(OpenActivity);
  const activity = useContext(ActivityOfTurn).get(turnKey ?? "");
  const activityPanelId = useOwnedActivity(turnKey);
  // Touch has no hover, so a tap on the message is what shows its menu.
  const [tapped, setTapped] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // More stays in view while what it opened is open.
  const holding = menuOpen || activityPanelId !== null;
  const className = ["reply", tapped ? "reply--tapped" : "", holding ? "reply--menu" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      onPointerUp={(event) => {
        if (event.pointerType !== "touch") return;
        if (event.target instanceof Element && event.target.closest("a, button")) return;
        setTapped(!tapped);
      }}
    >
      <div className="reply__bubble">
        <Reply message={message} streaming={false} />
      </div>
      <ReplyMenu
        activityPanelId={activityPanelId}
        message={message}
        onActivity={
          openActivity && turnKey !== null && activity && activity.steps.length > 0
            ? (opener) => openActivity(turnKey, opener)
            : undefined
        }
        onOpenChange={setMenuOpen}
        onReply={replyWith}
        open={menuOpen}
      />
    </div>
  );
}

interface ReplyMenuItem {
  readonly icon: IconName;
  readonly label: string;
  readonly run: () => void;
}

/**
 * A reply's one control: More, opening Reply, Copy and Activity. The menu is
 * the shared anchored one — arrows, Home and End move through it; Escape
 * closes it and goes back to More; Tab closes it and moves on.
 */
function ReplyMenu({
  activityPanelId,
  message,
  onActivity,
  onOpenChange,
  onReply,
  open,
}: {
  /** The Activity this reply's menu opened, while it is open: More controls it. */
  activityPanelId: string | null;
  message: MessageEntry;
  onActivity: ((opener: HTMLElement) => void) | undefined;
  onOpenChange: (open: boolean) => void;
  onReply: ((message: MessageEntry) => void) | undefined;
  open: boolean;
}) {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  useActivityAnchor(activityPanelId, moreRef);
  const menuId = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // The clipboard exists only in a secure context; a Host reached over plain
  // HTTP leaves the reader selecting the text themselves.
  const clipboard = globalThis.navigator?.clipboard;
  const items: ReplyMenuItem[] = [
    ...(onReply && message.body
      ? [{ icon: "reply" as const, label: "Reply", run: () => onReply(message) }]
      : []),
    ...(clipboard && message.body
      ? [
          {
            icon: "copy" as const,
            label: "Copy",
            run: () => {
              void clipboard.writeText(message.body).then(
                () => setCopied(true),
                () => undefined,
              );
            },
          },
        ]
      : []),
    ...(onActivity
      ? [
          {
            icon: "list" as const,
            label: "Run details",
            run: () => {
              if (moreRef.current) onActivity(moreRef.current);
            },
          },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  const close = () => onOpenChange(false);
  return (
    <div className="reply__actions">
      <button
        aria-controls={open ? menuId : (activityPanelId ?? undefined)}
        aria-expanded={open || activityPanelId !== null}
        aria-haspopup="menu"
        aria-label="More"
        className="reply__action"
        onClick={() => onOpenChange(!open)}
        ref={moreRef}
        title="More"
        type="button"
      >
        <Icon name="more" />
      </button>
      {copied ? (
        <span className="visually-hidden" role="status">
          Copied
        </span>
      ) : null}
      {open && moreRef.current ? (
        <Popover
          anchor={moreRef.current}
          className="reply-menu"
          id={menuId}
          label="Message actions"
          onClose={close}
        >
          {items.map((item) => (
            <button
              className="picker__row"
              key={item.label}
              onClick={() => {
                close();
                item.run();
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab") close();
              }}
              role="menuitem"
              type="button"
            >
              <span className="picker__glyph">
                <Icon name={item.icon} />
              </span>
              <span className="picker__label">{item.label}</span>
            </button>
          ))}
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * Opensteer composing, in the shape its reply will take. Once the turn it is
 * for has done anything on the way, pressing it opens that reply's Activity,
 * where the reader is already looking, and holds it as a reply's More does;
 * until then there is nothing to open.
 */
function Typing({ turnKey = null }: { turnKey?: string | null }) {
  const openActivity = useContext(OpenActivity);
  const owner = useContext(ActivityOpenedFrom);
  const activity = useContext(ActivityOfTurn).get(turnKey ?? "");
  const panelId = useOwnedActivity(turnKey);
  const controlRef = useRef<HTMLButtonElement | null>(null);
  useActivityAnchor(panelId, controlRef);
  const dots = (
    <span aria-hidden className="typing__dots">
      <i />
      <i />
      <i />
    </span>
  );
  return (
    <div aria-label="Opensteer is replying" className="typing" role="status">
      {openActivity && turnKey !== null && activity && activity.steps.length > 0 ? (
        <button
          aria-controls={panelId ?? undefined}
          aria-expanded={panelId !== null}
          aria-haspopup="dialog"
          aria-label="Show what Opensteer is doing"
          className="typing__body typing__body--opens"
          onClick={(event) =>
            panelId !== null ? owner?.onClose() : openActivity(turnKey, event.currentTarget)
          }
          ref={controlRef}
          title="Show what Opensteer is doing"
          type="button"
        >
          {dots}
        </button>
      ) : (
        <span className="typing__body">{dots}</span>
      )}
    </div>
  );
}

/* ---- Activity ---- */

/**
 * What one reply did, opened on request: from its typing or the
 * reply's menu, or by a search or a link to one of its steps. Beside the
 * conversation it is a panel hung from the control that opened it, so what
 * the reader pressed stays in view, or under the header for a link; on a
 * narrow screen it is a sheet. Its steps are drawn as the turn draws them
 * anywhere, without timings or what they consumed.
 */
export function ConversationActivity({
  anchor,
  browserSessions = noBrowsers,
  entries,
  id,
  inputQueuePaused = false,
  live,
  onClose,
  returnFocusTo = null,
  reveal = null,
  selection,
}: {
  /** What the panel hangs from beside the conversation: the control that holds it, or the header. */
  anchor: HTMLElement;
  browserSessions?: readonly BrowserSessionSummary[];
  /** The conversation as it is drawn. */
  entries: readonly TranscriptEntry[];
  /** The panel's id, for the `aria-controls` of the control that opened it. */
  id?: string;
  inputQueuePaused?: boolean;
  live: boolean;
  onClose: () => void;
  /** Where closing returns the reader, when that is not `anchor`. */
  returnFocusTo?: HTMLElement | null;
  /** A message to show among the steps, for a search or a link that named it. */
  reveal?: string | null;
  selection: ConversationActivitySelection;
}) {
  const narrow = useMediaQuery("(max-width: 620px)");
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(
    () => groupTranscriptEntries(entries, { inputQueuePaused }),
    [entries, inputQueuePaused],
  );
  const activity = useMemo(() => conversationActivityTurn(groups, selection), [groups, selection]);
  useEffect(() => {
    if (reveal === null) return;
    const target = bodyRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(reveal)}"]`,
    );
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    target.classList.add("transcript__found");
    const timer = window.setTimeout(() => target.classList.remove("transcript__found"), 2400);
    return () => window.clearTimeout(timer);
  }, [activity?.key, reveal]);
  const subtitle =
    activity === null
      ? null
      : activity.live
        ? "Now"
        : activity.reply
          ? `Reply at ${formatClockTime(activity.reply.createdAt)}`
          : null;
  const body = (
    <TranscriptLive value={live}>
      <QuietSteps value>
        <TranscriptBrowsers value={browserSessions}>
          <div className="activity__body" ref={bodyRef}>
            {activity !== null && activity.steps.length > 0 ? (
              <TurnContent
                entries={activity.steps}
                live={live}
                status={false}
                turn={activity.turn}
              />
            ) : (
              <p className="activity__empty">
                {activity?.live ? "Nothing to show yet." : "Nothing to show."}
              </p>
            )}
          </div>
        </TranscriptBrowsers>
      </QuietSteps>
    </TranscriptLive>
  );
  if (narrow) {
    return (
      <Dialog
        id={id}
        labelledBy={titleId}
        onClose={onClose}
        returnFocusTo={returnFocusTo}
        title="Run details"
      >
        {subtitle ? <p className="activity__subtitle">{subtitle}</p> : null}
        {body}
      </Dialog>
    );
  }
  return (
    <Popover
      anchor={anchor}
      className="activity-popover"
      id={id}
      label="Run details"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      role="dialog"
    >
      <header className="activity__head">
        <div className="activity__titles">
          <h2 className="activity__title" id={titleId}>
            Run details
          </h2>
          {subtitle ? <p className="activity__subtitle">{subtitle}</p> : null}
        </div>
        <button aria-label="Close run details" className="icon-btn" onClick={onClose} type="button">
          <Icon name="close" />
        </button>
      </header>
      {body}
    </Popover>
  );
}

function TurnContent({
  entries,
  fold,
  live,
  status = true,
  turn,
}: {
  /** What of the turn to draw; all of its work unless a conversation keeps its reply apart. */
  entries?: readonly WorkEntry[];
  /**
   * Given, the turn's steps fold behind its status line, which leads the turn
   * and opens them in place. Folded, only the reply is drawn: the steps are
   * not mounted at all.
   */
  fold?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
  live: boolean;
  /** Whether the stream ends with its status line; a conversation's steps have none. */
  status?: boolean;
  turn: Turn;
}) {
  const active = turnState(turn) !== "settled";
  const silent = turn.run?.status === "completed" && turn.run.replyMessageId === null;
  const work = entries ?? turn.work;
  const folded = fold === undefined ? null : !fold.open;
  const rows = useMemo(() => {
    const statusRow = { kind: "status" as const, key: "status" };
    // The reply keeps its row's key either way, so folding never redraws it.
    if (folded !== null)
      return [statusRow, ...workRows(folded ? work.filter((entry) => entry === turn.reply) : work)];
    return [
      ...workRows(work),
      ...(status && (work.length > 0 || active || silent) ? [statusRow] : []),
    ];
  }, [work, active, folded, status, turn.reply, silent]);
  return (
    <div className="turn__content">
      {rows.map((row) =>
        row.kind === "status" ? (
          <WorkStatus
            key={row.key}
            turn={turn}
            {...(fold ? { onToggle: fold.onToggle, open: fold.open } : {})}
          />
        ) : (
          <WorkRowView active={active} key={row.key} live={live} row={row} turn={turn} />
        ),
      )}
    </div>
  );
}

function WorkRowView({
  active,
  live,
  row,
  turn,
}: {
  active: boolean;
  live: boolean;
  row: WorkRow;
  turn: Turn;
}) {
  switch (row.kind) {
    case "note":
      return <Reply message={row.entry} streaming={live && row.entry.streaming === true} />;
    case "reasoning":
      return <Reasoning entry={row.entry} active={active} />;
    case "subagent":
      return <SubagentRow active={active} live={live} row={row} turn={turn} />;
    case "steps":
      return <StepsRow row={row} />;
  }
}

/**
 * A subagent the agent started, standing where it started: what it was asked,
 * its own steps — subagents it started nest inside — and what it returned.
 * One at work opens as it starts, so its running step shows; one that arrives
 * finished stays closed until asked.
 */
function SubagentRow({
  active,
  live,
  row,
  turn,
}: {
  active: boolean;
  live: boolean;
  row: Extract<WorkRow, { kind: "subagent" }>;
  turn: Turn;
}) {
  const node = row.entry;
  const [open, setOpen] = useState(live && node.status === "running");
  const own = turn.subagentWork[node.nodeId];
  const rows = useMemo(() => workRows(own ?? []), [own]);
  // The model leaves the head once it is open, so the body's last line keeps it.
  const hasBody = Boolean(node.prompt || node.result || node.model) || rows.length > 0;
  return (
    <div className={open ? "subagent trace-step trace-step--open" : "subagent trace-step"}>
      <StepHead head={row.head} {...(hasBody ? { onToggle: () => setOpen(!open), open } : {})} />
      {open && hasBody ? (
        <div className="trace-step__body">
          {node.prompt ? <SubagentPrompt text={node.prompt} /> : null}
          {rows.length > 0 ? (
            <div className="subagent__steps">
              {rows.map((child) => (
                <WorkRowView active={active} key={child.key} live={live} row={child} turn={turn} />
              ))}
            </div>
          ) : null}
          {node.result ? (
            <>
              <span className="eyebrow eyebrow--micro">Result</span>
              <Suspense fallback={<p className="md-prose md-prose--plain">{node.result}</p>}>
                <Markdown text={node.result} />
              </Suspense>
            </>
          ) : null}
          {node.model ? <p className="subagent__facts">{node.model}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** What a subagent was asked: its first lines, and the rest on request. */
function SubagentPrompt({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 3;
  return (
    <div className="subagent__prompt">
      <p
        className={
          long && !full
            ? "subagent__prompt-text subagent__prompt-text--clamped"
            : "subagent__prompt-text"
        }
      >
        {text}
      </p>
      {long ? (
        <button
          aria-expanded={full}
          className="subagent__more"
          onClick={() => setFull(!full)}
          type="button"
        >
          {full ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

function StepsRow({ row }: { row: Extract<WorkRow, { kind: "steps" }> }) {
  const [open, setOpen] = useState(false);
  const [only] = row.entries;
  const single = row.entries.length === 1 ? only : undefined;
  const computer =
    row.group === "computer" && only?.kind === "tool"
      ? only.integration?.computerApp?.computer
      : null;
  return (
    <div className={open ? "trace-step trace-step--open" : "trace-step"}>
      <StepHead
        head={row.head}
        {...(single?.kind === "request" ? {} : { onToggle: () => setOpen(!open), open })}
      />
      {open && computer && !single ? <p className="trace-step__place">on {computer}</p> : null}
      {open && single?.kind === "tool" ? (
        <ToolDetail tool={single} />
      ) : open && !single ? (
        // One app's steps are one activity in order, so they read as a
        // timeline: each step's mark says how it went, not what kind it was.
        <div
          className={
            row.group === "computer"
              ? "trace-step__lines trace-step__lines--timeline"
              : "trace-step__lines"
          }
        >
          {row.entries.map((entry) => (
            <Step
              compact
              entry={entry}
              head={activityStepHead(entry)}
              key={entry.id}
              mark={row.group === "computer"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Reasoning({ entry, active }: { entry: ReasoningEntry; active: boolean }) {
  // Completed blocks arriving in a live snapshot deserve the same visibility
  // as streamed blocks. Completion and later activity never undo a reader's choice.
  const [open, setOpen] = useState(active || entry.state === "streaming");
  return (
    <div className="trace-thought">
      <StepHead head={activityStepHead(entry)} onToggle={() => setOpen(!open)} open={open} />
      {open ? (
        <div className="trace-step__thought">
          <Suspense fallback={<p className="md-prose md-prose--plain">{entry.text}</p>}>
            <Markdown text={entry.text} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

/** One step: its head, and — for anything with more to say — its detail in place. */
function Step({
  compact = false,
  entry,
  head,
  mark = false,
}: {
  compact?: boolean;
  entry: RequestReceiptEntry | ToolEntry;
  head: ActivityStepHead;
  mark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const className = [
    "trace-step",
    compact ? "trace-step--compact" : "",
    open ? "trace-step--open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (entry.kind === "request") {
    return (
      <div className={className}>
        <StepHead head={head} listed={compact} mark={mark} />
      </div>
    );
  }
  return (
    <div className={className}>
      <StepHead
        head={head}
        listed={compact}
        mark={mark}
        onToggle={() => setOpen(!open)}
        open={open}
      />
      {open ? <ToolDetail tool={entry} /> : null}
    </div>
  );
}

function ToolDetail({ tool }: { tool: ToolEntry }) {
  const body = useMemo(() => toolBody(tool), [tool]);
  const Section = body.collapsed ? DisclosedSection : OpenSection;
  return (
    <div className="trace-step__body">
      {body.summary ? <p className="trace-step__summary">{body.summary}</p> : null}
      {body.command ? <pre className="trace-code trace-code--command">{body.command}</pre> : null}
      {body.argumentsText ? <Section label="Input" text={body.argumentsText} /> : null}
      {body.output ? (
        <Section label={body.outputLabel} text={body.output} />
      ) : tool.state === "running" || body.summary ? null : (
        <span className="trace-step__empty">No output</span>
      )}
    </div>
  );
}

function OpenSection({ label, text }: { label: string; text: string }) {
  return (
    <>
      <span className="eyebrow eyebrow--micro">{label}</span>
      <pre className="trace-code">{text}</pre>
    </>
  );
}

/** Verbatim text a reader asks for: named, and closed until then. */
function DisclosedSection({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "trace-disclosure trace-disclosure--open" : "trace-disclosure"}>
      <button
        aria-expanded={open}
        className="eyebrow eyebrow--micro trace-disclosure__toggle"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span aria-hidden className="trace-disclosure__chevron">
          <Icon name="chevron-right" />
        </span>
        {label}
      </button>
      {open ? <pre className="trace-code">{text}</pre> : null}
    </div>
  );
}

/**
 * The one row shape every row and step shares: what kind of step, what
 * happened, what it happened to, and what it cost. Once open, the body says
 * the target in full, so the row drops its preview.
 */
function StepHead({
  head,
  listed = false,
  mark = false,
  onToggle,
  open,
}: {
  head: ActivityStepHead;
  /**
   * A step listed under a row, which already counts its errors: the step's own
   * glyph or mark says it failed, and one failure is counted once.
   */
  listed?: boolean;
  /** Draw how the step went in place of what kind it is, for a step inside a timeline. */
  mark?: boolean;
  onToggle?: () => void;
  open?: boolean;
}) {
  const live = useContext(TranscriptLive);
  const quiet = useContext(QuietSteps);
  const tone = !live && head.tone === "running" ? "neutral" : head.tone;
  const moving = live && head.tone === "running";
  const content = (
    <>
      <span
        className={`trace-step__icon trace-step__icon--${tone}${mark ? " trace-step__icon--mark" : ""}`}
      >
        <Icon
          name={mark ? toneMark(head.tone) : head.icon}
          title={
            head.tone === "running"
              ? live
                ? "Running"
                : "Last known: running"
              : head.tone === "error"
                ? "Returned an error"
                : head.tone === "stopped"
                  ? "Stopped"
                  : undefined
          }
        />
      </span>
      <span
        className={
          head.detail && !open ? "trace-step__label trace-step__label--beside" : "trace-step__label"
        }
      >
        {head.label}
      </span>
      {head.detail && !open ? (
        <span
          className={`trace-step__detail trace-step__detail--${head.detailKind}${moving ? " trace-step__detail--live" : ""}`}
          // While the step runs its detail is the work in progress; each new
          // value arrives as itself rather than overwriting the last in place.
          key={moving ? head.detail : undefined}
        >
          {head.detail}
        </span>
      ) : (
        <span className="trace-step__spacer" />
      )}
      {head.errors > 0 && !listed ? <ErrorCount count={head.errors} /> : null}
      {head.duration && !quiet ? (
        <span className="trace-step__duration">{head.duration}</span>
      ) : null}
      {onToggle ? (
        <span aria-hidden className="trace-step__chevron">
          <Icon name="chevron-right" />
        </span>
      ) : null}
    </>
  );

  // A step names no pages of its own: the Host records pages per Run, so the
  // reply lists them once, under the reply, rather than every browser step
  // repeating the whole Run's.
  return (
    <div className="trace-step__row">
      {onToggle ? (
        <button aria-expanded={open} className="trace-step__head" onClick={onToggle} type="button">
          {content}
        </button>
      ) : (
        <div className="trace-step__head">{content}</div>
      )}
    </div>
  );
}

function toneMark(tone: ActivityTone): "alert-circle" | "check" | "check-circle" | "dot" | "stop" {
  switch (tone) {
    case "error":
      return "alert-circle";
    case "stopped":
      return "stop";
    case "running":
      return "dot";
    case "decided":
      return "check-circle";
    case "done":
      return "check";
  }
}

function ErrorCount({ count }: { count: number }) {
  return <span className="trace-errors">{count === 1 ? "1 error" : `${count} errors`}</span>;
}

/** Time since the turn began, redrawn once a second and nothing else with it. */
function LiveClock({ startedAt }: { startedAt: string }) {
  const started = Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!Number.isFinite(started)) return null;
  return (
    <time className="work__clock" dateTime={startedAt}>
      {formatElapsed(now - started)}
    </time>
  );
}

/* ---- Messages ---- */

function Reply({ message, streaming }: { message: MessageEntry; streaming: boolean }) {
  return (
    <div aria-busy={streaming} className="msg--assistant__body" data-message-id={message.id}>
      {message.body ? (
        <Suspense fallback={<p className="md-prose md-prose--plain">{message.body}</p>}>
          <Markdown text={message.body} />
        </Suspense>
      ) : null}
      {streaming ? <span aria-hidden className="stream-caret" /> : null}
      <MessageAttachments attachments={message.attachments ?? []} />
    </div>
  );
}

/**
 * Message direction is a delivery contract. Conversation presentation also
 * considers authorship so another agent's update never looks like the reader's words.
 */
function Message({
  message,
  reveal,
  askAbout,
  viewerUserId,
  workspaces,
}: {
  message: MessageEntry;
  reveal: { readonly id: string } | null;
  askAbout?: AskAbout | undefined;
  viewerUserId: string | null;
  workspaces: readonly WorkspaceSummary[];
}) {
  const conversation = useContext(ConversationMode);
  if (message.messageKind === "assistant") {
    return conversation ? (
      <div className="turn turn--conversation">
        <ReplyBubble message={message} />
      </div>
    ) : (
      <div className="turn">
        <AgentByline author={message.author} />
        <Reply message={message} streaming={message.streaming === true} />
      </div>
    );
  }

  if (
    (conversation && message.author.kind !== "human") ||
    (message.author.kind === "platform" && message.author.cause === "run-recovery")
  ) {
    return (
      <UpdateLine
        author={message.author}
        message={message}
        askAbout={askAbout}
        reveal={reveal}
        workspaces={workspaces}
      />
    );
  }

  if (message.author.kind === "human" && message.author.userId === viewerUserId) {
    return <OwnMessage message={message} reveal={reveal} viewerUserId={viewerUserId} />;
  }

  return (
    <InputMessage
      message={message}
      askAbout={askAbout}
      reveal={reveal}
      viewerUserId={viewerUserId}
      workspaces={workspaces}
    />
  );
}

/** The reader's own message: their words in full, folded only once they run long. */
function OwnMessage({
  message,
  reveal,
  viewerUserId,
}: {
  message: MessageEntry;
  reveal: { readonly id: string } | null;
  viewerUserId: string | null;
}) {
  const [open, setOpen] = useState(reveal !== null);
  useLayoutEffect(() => {
    if (reveal !== null) setOpen(true);
  }, [reveal]);
  return (
    <div className="msg--user-row" data-message-id={message.id}>
      <MessagePages pages={message.pages ?? []} />
      <MessagePlaces places={message.places ?? []} />
      <MessageAttachments attachments={message.attachments ?? []} />
      {message.body ? (
        <div className="msg--user">
          <MessageFold
            lines={messageFoldLines(message, viewerUserId)}
            onOpenChange={setOpen}
            open={open}
          >
            {message.body}
          </MessageFold>
        </div>
      ) : null}
      {message.delivery ? (
        <p className="form-actions__error" role="alert">
          {message.delivery.reason}
        </p>
      ) : null}
    </div>
  );
}

/** The pages a person included with their message, above its words. */
function MessagePages({ pages }: { pages: readonly BrowserPageContentPart[] }) {
  const sessions = useContext(TranscriptBrowsers);
  if (pages.length === 0) return null;
  return (
    <div aria-label="Pages included" className="msg--user__pages" role="group">
      {pages.map((part) => (
        <SurfaceChip
          key={`${part.sessionId}:${part.tabId}`}
          surface={pageChip(messagePages([part], sessions)[0]!, sessions)}
          withSite
        />
      ))}
    </div>
  );
}

/** The Mac apps and phones a person included, named as they were when sent. */
function MessagePlaces({
  places,
}: {
  places: readonly NonNullable<MessageEntry["places"]>[number][];
}) {
  if (places.length === 0) return null;
  return (
    <div aria-label="Places included" className="msg--user__pages" role="group">
      {places.map((part) => (
        <SurfaceChip
          key={
            part.type === "phone"
              ? `${part.machineId}:${part.display}`
              : `${part.machineId}:${part.app.bundleId}`
          }
          surface={{
            acting: false,
            destination: null,
            ended: false,
            key:
              part.type === "phone"
                ? `phone:${part.machineId}`
                : `app:${part.machineId}:${part.app.bundleId}`,
            site: null,
            title: part.name,
            ...(part.type === "phone" ? { phone: true as const } : { app: part.app }),
          }}
        />
      ))}
    </div>
  );
}

/** Where this reader stopped last time: a position, not an alarm. */
/**
 * The group the divider stands before: the first one holding a message past the
 * reader's saved position. Compared by sequence, because a count of rows points
 * at the wrong one once own or withdrawn messages are in the window.
 */
export function firstUnreadGroupKey(
  groups: readonly TranscriptGroup[],
  boundarySequence: string | null,
): string | null {
  if (boundarySequence === null) return null;
  const boundary = BigInt(boundarySequence);
  const unread = (entry: { kind: string; sequence?: string | undefined }): boolean =>
    entry.kind === "message" && entry.sequence !== undefined && BigInt(entry.sequence) > boundary;
  for (const group of groups) {
    const found = group.kind === "turn" ? group.turn.work.some(unread) : unread(group.entry);
    if (found) return group.key;
  }
  return null;
}

function UnreadDivider() {
  return (
    <div aria-label="New since you were last here" className="unread-divider" role="separator">
      <span className="unread-divider__label">New</span>
    </div>
  );
}

/**
 * A change of the AI running this conversation, recorded by the Host.
 *
 * It is a platform event, not a message: it never claims the new engine
 * started, caught up or carried anything over, and it never rewrites what
 * came before it.
 */
function SelectionMarker({
  engineName,
  entry,
}: {
  engineName: ((harnessInstanceId: string) => string | null) | undefined;
  entry: SelectionEntry;
}) {
  const engine = engineName?.(entry.harnessInstanceId) ?? null;
  return (
    <p className="selection-marker" role="note">
      <span className="selection-marker__text">
        {engine === null
          ? `Switched to ${entry.modelSelection.modelId}`
          : `Switched to ${entry.modelSelection.modelId} on ${engine}`}
      </span>
      <time dateTime={entry.createdAt}>{formatClockTime(entry.createdAt)}</time>
    </p>
  );
}

type UpdateAuthor = Exclude<MessageEntry["author"], { kind: "human" }>;

/**
 * In a conversation, what another agent or an automation sent its agent: one
 * line saying who, and whether it was left for later or is work now, opening in
 * place to what was said. The conversation stays between the reader and the
 * agent they are talking to.
 */
function UpdateLine({
  author,
  message,
  askAbout,
  reveal,
  workspaces,
}: {
  author: UpdateAuthor;
  message: MessageEntry;
  askAbout?: AskAbout | undefined;
  reveal: { readonly id: string } | null;
  workspaces: readonly WorkspaceSummary[];
}) {
  const [open, setOpen] = useState(reveal !== null);
  useLayoutEffect(() => {
    if (reveal !== null) setOpen(true);
  }, [reveal]);
  const bodyId = useId();
  const source = updateSource(author, message.messageKind, workspaces, useContext(HomeThread));
  const said = incomingMessageAction(message);
  return (
    <div className="update-line" data-message-id={message.id}>
      <div className="update-line__head">
        <Icon className="update-line__glyph" name={source.glyph} />
        {source.href ? (
          <AreaLink className="update-line__source" to={source.href}>
            {source.name}
          </AreaLink>
        ) : (
          <span className="update-line__source">{source.name}</span>
        )}
        <button
          aria-controls={open ? bodyId : undefined}
          aria-expanded={open}
          className="update-line__toggle"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {said}
          <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </button>
      </div>
      {message.delivery ? (
        <p className="form-actions__error" role="alert">
          {message.delivery.reason}
        </p>
      ) : null}
      {open ? (
        <div className="update-line__body" id={bodyId}>
          <MessageAttachments attachments={message.attachments ?? []} />
          {message.body ? (
            <Suspense fallback={<p className="md-prose md-prose--plain">{message.body}</p>}>
              <Markdown text={message.body} />
            </Suspense>
          ) : null}
          {askAbout && author.kind === "agent" && message.body ? (
            <button
              className="btn btn--ghost btn--small update-line__ask"
              onClick={() => askAbout.quote(message)}
              type="button"
            >
              {askAbout.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TurnSource({ source }: { source: NonNullable<Turn["source"]> }) {
  const { workspaces } = useContext(Speakers);
  const home = useContext(HomeThread);
  if (source.author.kind === "human") return null;
  const from = source.task
    ? {
        glyph: "message" as const,
        name: source.task.workerThread.title,
        href: `/threads/${source.task.workerThread.id}`,
      }
    : updateSource(source.author, "input", workspaces, home);
  const content = (
    <>
      <Icon name={from.glyph} /> {from.name} ·{" "}
      <time dateTime={source.createdAt}>{formatClockTime(source.createdAt)}</time>
      {from.href ? " ›" : null}
    </>
  );
  return (
    <div className="turn-source">
      {from.href ? <AreaLink to={from.href}>{content}</AreaLink> : content}
    </div>
  );
}

/** Who an update came from, and where the reader can follow it. */
function updateSource(
  author: UpdateAuthor,
  kind: MessageEntry["messageKind"],
  workspaces: readonly WorkspaceSummary[],
  homeThreadId: string | null,
): { glyph: "bolt" | "message"; href: string | null; name: string } {
  const name = messageAuthorName(author, kind, homeThreadId);
  switch (author.kind) {
    case "agent":
      if (author.threadId === homeThreadId) return { glyph: "message", href: "/", name };
      return {
        glyph: "message",
        // Only a Thread the reader can open is a link: one behind a Workspace
        // they are not in is named and left at that.
        href: workspaces.some(({ id }) => id === author.workspaceId)
          ? `/threads/${author.threadId}`
          : null,
        name,
      };
    case "trigger":
    case "watch":
      return { glyph: "bolt", href: automationPath(author.triggerId), name };
    case "platform":
      return { glyph: "message", href: null, name };
  }
}

/**
 * What someone or something else sent this task, as one card: a single line
 * says who and when, the name of what sent it titles the card, and the words
 * fold to a few lines until opened. The card fills its column whatever it
 * holds, so a long address or a code line can never widen it.
 */
function InputMessage({
  message,
  askAbout,
  reveal,
  viewerUserId,
  workspaces,
}: {
  message: MessageEntry;
  reveal: { readonly id: string } | null;
  askAbout?: AskAbout | undefined;
  viewerUserId: string | null;
  workspaces: readonly WorkspaceSummary[];
}) {
  const conversation = useContext(ConversationMode);
  const [open, setOpen] = useState(reveal !== null);
  useLayoutEffect(() => {
    if (reveal !== null) setOpen(true);
  }, [reveal]);
  const preview = useMemo(() => incomingMessagePreview(message), [message]);
  const body = preview.truncated && !open ? preview.text : message.body;
  const source = inputSource(message, workspaces, useContext(HomeThread));

  // Quoting is offered for updates another agent published: those are the ones
  // a reader answers by reference. Their own collaborators' messages already
  // sit in the conversation they are replying in.
  const quotable = askAbout !== undefined && message.author.kind === "agent" && message.body !== "";
  // Like a reply's More, the action shows where a pointer rests or focus
  // lands; touch has no hover, so a tap on the message shows it.
  const [tapped, setTapped] = useState(false);

  return (
    <div
      className={[
        "msg--input",
        conversation ? "msg--input--conversation" : "",
        quotable ? "msg--input--quotable" : "",
        tapped ? "msg--input--tapped" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-message-id={message.id}
      onPointerUp={
        quotable
          ? (event) => {
              if (event.pointerType !== "touch") return;
              if (event.target instanceof Element && event.target.closest("a, button")) return;
              setTapped(!tapped);
            }
          : undefined
      }
    >
      <article className="input-card">
        <header className="input-card__meta">
          {source.glyph}
          <span className="input-card__sender" title={source.sender}>
            {source.sender}
          </span>
          <span aria-hidden className="input-card__sep">
            ·
          </span>
          <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>
          {source.open ? (
            <AreaLink
              aria-label={source.open.label}
              className="input-card__open"
              title={source.open.label}
              to={source.open.href}
            >
              <Icon name="chevron-right" />
            </AreaLink>
          ) : null}
        </header>
        {source.title ? (
          <p className="input-card__title" title={source.title}>
            {source.title}
          </p>
        ) : null}
        <MessageAttachments attachments={message.attachments ?? []} />
        {message.body ? (
          <MessageFold
            lines={messageFoldLines(message, viewerUserId)}
            more={preview.truncated && !open}
            onOpenChange={setOpen}
            open={open}
          >
            {source.markdown ? (
              <Suspense fallback={<p className="md-prose md-prose--plain">{body}</p>}>
                <Markdown text={body} />
              </Suspense>
            ) : (
              <p className="input-card__plain">{body}</p>
            )}
          </MessageFold>
        ) : null}
      </article>
      {message.delivery ? (
        <p className="form-actions__error" role="alert">
          {message.delivery.reason}
        </p>
      ) : null}
      {quotable ? (
        <div className="msg--input__actions">
          <button
            className="btn btn--ghost btn--small"
            onClick={() => askAbout?.quote(message)}
            type="button"
          >
            {askAbout?.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Who sent a message and where it leads. `sender` is one short word or name,
 * so the card's top line never wraps; what sent it by name, when it is a
 * thing rather than someone, is the card's `title`, which may take two lines.
 */
function inputSource(
  message: MessageEntry,
  workspaces: readonly WorkspaceSummary[],
  homeThreadId: string | null,
): {
  glyph: ReactNode;
  markdown: boolean;
  open: { href: string; label: string } | null;
  sender: string;
  title: string | null;
} {
  const { author } = message;
  const name = messageAuthorName(author, message.messageKind, homeThreadId);
  switch (author.kind) {
    case "agent": {
      if (author.threadId === homeThreadId) {
        return {
          glyph: <ChatOrb size={16} />,
          markdown: true,
          open: { href: "/", label: `Open ${name}` },
          sender: name,
          title: null,
        };
      }
      const workspace = workspaces.find(({ id }) => id === author.workspaceId);
      return {
        glyph: <SenderTaskMark threadId={author.threadId} workspace={workspace ?? null} />,
        markdown: true,
        // Only a Thread the reader can open is a link: someone else's task,
        // behind a Workspace they are not in, is named and left at that.
        open: workspace ? { href: `/threads/${author.threadId}`, label: "Open task" } : null,
        sender: workspace && workspace.kind !== "main" ? workspace.name : "From a task",
        title: name,
      };
    }
    case "trigger":
    case "watch":
      return {
        glyph: (
          <span aria-hidden className="input-card__glyph">
            <Icon name="bolt" />
          </span>
        ),
        markdown: true,
        open: { href: automationPath(author.triggerId), label: "Open automation" },
        sender: "Automation",
        title: name,
      };
    case "human":
      return {
        glyph: (
          <span aria-hidden className="input-card__glyph">
            <span>{workspaceMonogram(author.displayName)}</span>
          </span>
        ),
        markdown: false,
        open: null,
        sender: name,
        title: null,
      };
    case "platform":
      // The schema forbids platform-authored input; typed for exhaustiveness.
      return { glyph: null, markdown: false, open: null, sender: name, title: null };
  }
}

/** The sending task's own mark, as the sidebar shows it; a Workspace's orb where it cannot be read. */
function SenderTaskMark({
  threadId,
  workspace,
}: {
  readonly threadId: string;
  readonly workspace: WorkspaceSummary | null;
}) {
  const reader = useContext(AttachmentReader);
  if (reader) return <BylineTaskMark reader={reader} threadId={threadId} />;
  return workspace ? (
    <WorkspaceOrb icon={workspace.icon} name={workspace.name} size="tiny" color={workspace.color} />
  ) : (
    <span aria-hidden className="input-card__glyph">
      <Icon name="workspace" />
    </span>
  );
}

/* ---- Another Thread's work ---- */

function DelegationNotice({ delegation }: { delegation: DelegationEntry }) {
  const [open, setOpen] = useState(false);
  const head = useMemo(() => activityStepHead(delegation), [delegation]);
  const result = delegation.failure?.message ?? delegation.resultPreview;
  const hasBody = Boolean(delegation.taskPreview || result);
  const sessions = useContext(TranscriptBrowsers);
  // The pages the task's own Run used, each opening exactly where it was.
  const pages = useMemo(
    () => runPages(sessions, [delegation.childRunId]).map((page) => pageChip(page, sessions)),
    [delegation.childRunId, sessions],
  );

  return (
    <div className="delegation">
      <div className={open ? "trace-step trace-step--open" : "trace-step"}>
        <StepHead head={head} {...(hasBody ? { onToggle: () => setOpen(!open), open } : {})} />
        {open ? (
          <div className="trace-step__body">
            {delegation.taskPreview ? (
              <>
                <span className="eyebrow eyebrow--micro">Task</span>
                <p className="trace-step__task">{delegation.taskPreview}</p>
              </>
            ) : null}
            {result ? (
              <>
                <span className="eyebrow eyebrow--micro">Result</span>
                <Suspense fallback={<p className="md-prose md-prose--plain">{result}</p>}>
                  <Markdown text={result} />
                </Suspense>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <AreaLink className="delegation__open" to={`/threads/${delegation.childThread.id}`}>
        Open {delegation.childThread.title}
      </AreaLink>
      <SurfaceChips label={`Pages ${delegation.childThread.title} used`} surfaces={pages} />
    </div>
  );
}

/* ---- Run outcomes ---- */

const restartingLabel = "Restarting with your message";

/** A Run whose first attempt a restart replaced, to take a message steered into it. */
function restarted(run: RunEntry): boolean {
  return (run.attempt ?? 1) > 1;
}

/** A restarted Run back in its queue, before the attempt that takes the message is under way. */
function restartPending(run: RunEntry | null): boolean {
  return run !== null && restarted(run) && (run.status === "queued" || run.status === "starting");
}

/** Whether a finished Run says anything below its turn: an outcome of its own, or that it restarted. */
function showsRunOutcome(run: RunEntry): boolean {
  return hasRunOutcome(run) || (isTerminalRunEntryStatus(run.status) && restarted(run));
}

function RunRestart({ children }: { children: ReactNode }) {
  return (
    <p className="run-restart">
      <Icon name="reload" />
      {children}
    </p>
  );
}

function RunOutcome({
  conversation = false,
  run,
}: {
  /** A conversation says what happened to the reply, not to a Run. */
  conversation?: boolean;
  run: RunEntry;
}) {
  const restart = restarted(run) ? (
    <RunRestart>Restarted to include your message</RunRestart>
  ) : null;
  if (run.status === "failed") {
    return (
      <>
        <div className="run-failure" role="alert">
          <span className="run-failure__title">
            <Icon name="alert-circle" />
            {conversation ? "Opensteer couldn’t finish" : "Run failed"}
          </span>
          {run.error ? <p className="run-failure__message">{run.error.message}</p> : null}
          {run.error?.retryable ? (
            <p className="action-note">This looks temporary — sending again may work.</p>
          ) : null}
        </div>
        {restart}
      </>
    );
  }
  if (run.status === "interrupted") {
    return (
      <>
        <p className="run-note">
          <Icon name="stop" /> {conversation ? "Stopped." : "Run stopped."}
        </p>
        {restart}
      </>
    );
  }
  return restart;
}

/** A Thread at work before its Run has reported anything. */
function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="working" role="status">
      <span aria-hidden className="working__orb" />
      <span className="working__label">{label}</span>
    </div>
  );
}
