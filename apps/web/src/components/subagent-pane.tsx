import { useLiveAgentCard, useThreadScope, useThreadTranscript } from "@opensteer/client/react";
import {
  Suspense,
  lazy,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { harnessCatalogEntry } from "@opensteer/core";
import { readTail, type TailReading } from "@opensteer/shared/tailFollow";
import {
  subagentDetail,
  subagentFooter,
  subagentSiblings,
  type AgentCard,
  type HostClient,
  type NodeDetailSnapshot,
  type NodeDetailSubscription,
  type NodeEntry,
  type SubagentDetail,
} from "@opensteer/client/host";
import { SubagentSteps, type TranscriptTextScope } from "./agent-activity.js";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { RequestStack, useDockedRequests } from "./input-surface.js";
import { LoadingRows } from "./loading-rows.js";
import { MessageFold } from "./message-fold.js";
import { SubagentStop } from "./subagent-stop.js";
import { useDeviceGrantFollowUps } from "./thread-device-access-action.js";
import {
  AgentEngine,
  AgentFolds,
  AgentMark,
  AgentProgressScope,
  Elapsed,
  WorkflowPhases,
} from "./subagent-rows.js";
import { readableMarkdown } from "./references/readable-markdown.js";

const Markdown = lazy(() => import("./markdown.js"));

const noSubscription = () => () => undefined;
const noDetail = () => null;

/**
 * Holds the one node watch this view may have: opened with the view,
 * released when it closes or another subagent replaces it.
 */
function useNodeDetail(
  hostClient: HostClient,
  threadId: string,
  nodeId: string,
): { readonly detail: NodeDetailSnapshot | null; readonly watch: NodeDetailSubscription | null } {
  const [watch, setWatch] = useState<NodeDetailSubscription | null>(null);
  useEffect(() => {
    const opened = hostClient.watchNode(threadId, nodeId);
    setWatch(opened);
    return () => {
      opened.release();
      setWatch((current) => (current === opened ? null : current));
    };
  }, [hostClient, nodeId, threadId]);
  const detail = useSyncExternalStore(
    watch?.subscribe ?? noSubscription,
    watch?.getSnapshot ?? noDetail,
  );
  return { detail, watch };
}

/** Where the pane sits: pushed into the conversation's column, or beside a wide conversation. */
export type SubagentPaneLayout = "push" | "beside";

/**
 * A subagent, opened in its conversation's place: who started it, what it was
 * asked, what it found and its own steps, with a footer in the composer's
 * place that says it can be watched, not messaged. Its header shows at once
 * from the conversation's own record; its steps arrive as they load.
 */
export function SubagentPane({
  layout,
  live,
  nodeId,
  onClose,
  onOpen,
  threadId,
  threadTitle,
}: {
  layout: SubagentPaneLayout;
  /** Whether this conversation's computer is in reach; out of reach, all is last known. */
  live: boolean;
  nodeId: string;
  onClose: () => void;
  /** Opens another subagent of this conversation; `replace` for a hop between siblings. */
  onOpen: (nodeId: string, replace: boolean) => void;
  threadId: string;
  threadTitle: string;
}) {
  const { hostClient } = useShell();
  const { entries } = useThreadTranscript(hostClient, threadId);
  // This conversation's own work, read live; the shell around it is the stable projection.
  const scope = useThreadScope(hostClient, threadId, entries);
  const snapshot = useMemo(
    () => ({
      ...scope,
      connection: live ? scope.connection : ("offline" as const),
      transcripts: { [threadId]: entries },
    }),
    [entries, live, scope, threadId],
  );
  const { detail, watch } = useNodeDetail(hostClient, threadId, nodeId);
  const summary =
    snapshot.transcripts[threadId]?.find(
      (entry): entry is NodeEntry => entry.kind === "node" && entry.nodeId === nodeId,
    ) ??
    detail?.node ??
    null;
  const loading: NodeDetailSnapshot = detail ?? {
    entries: [],
    error: null,
    hasMore: false,
    loadingOlder: false,
    node: null,
    nodeId,
    status: "loading",
    threadId,
  };
  const view =
    summary && summary.nodeKind !== "task" ? subagentDetail(loading, summary, snapshot) : null;
  const siblings = subagentSiblings(snapshot, threadId, nodeId);
  // A workflow's members report to the conversation; a subagent's own, to it.
  const parentId =
    view?.parent.nodeId &&
    snapshot.transcripts[threadId]?.some(
      (entry) =>
        entry.kind === "node" &&
        entry.nodeId === view.parent.nodeId &&
        entry.nodeKind !== "workflow",
    )
      ? view.parent.nodeId
      : null;
  const parentTitle = parentId && view ? view.parent.title : threadTitle;
  const back = () => {
    if (parentId && layout === "push") onOpen(parentId, false);
    else onClose();
  };
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tail = useRef<TailReading>({ follows: false, offset: 0 });
  useLayoutEffect(() => {
    tail.current = { follows: false, offset: 0 };
    titleRef.current?.focus({ preventScroll: true });
  }, [nodeId]);
  // Like the transcript: follow the newest step only once the reader is at the end.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    tail.current = readTail(tail.current, scroller.scrollTop, max, false);
    if (!tail.current.follows) return;
    scroller.scrollTop = scroller.scrollHeight;
    tail.current = { follows: true, offset: scroller.scrollTop };
  }, [detail?.entries, view?.state]);
  const kind = view?.card.origin === "task" ? "task" : "subagent";
  const hop = siblings && siblings.total > 1 ? siblings : null;
  return (
    <section
      aria-label={view?.card.title ?? "Subagent"}
      className={`subagent-pane subagent-pane--${layout}`}
      onKeyDown={(event) => {
        if (event.defaultPrevented || isTyping(event.target)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          back();
        } else if (hop && (event.key === "[" || event.key === "]")) {
          const target = event.key === "[" ? hop.previous : hop.next;
          if (target) {
            event.preventDefault();
            onOpen(target, true);
          }
        }
      }}
    >
      <header className="subagent-pane__head">
        {layout === "push" ? (
          <button
            aria-label={`Back to ${parentTitle}`}
            className="subagent-pane__back"
            onClick={back}
            title={parentTitle}
            type="button"
          >
            <Icon name="chevron-left" />
            <span>{parentTitle}</span>
          </button>
        ) : (
          <span className="subagent-pane__kind">{view?.card.noun ?? "Subagent"}</span>
        )}
        <div className="subagent-pane__end">
          {hop ? (
            <span className="subagent-pane__hop">
              <button
                aria-label={`Previous ${kind}`}
                className="icon-btn icon-btn--small"
                disabled={!hop.previous}
                onClick={() => hop.previous && onOpen(hop.previous, true)}
                title="Previous ["
                type="button"
              >
                <Icon name="chevron-left" />
              </button>
              <span aria-live="polite">
                {hop.index + 1} of {hop.total}
              </span>
              <button
                aria-label={`Next ${kind}`}
                className="icon-btn icon-btn--small"
                disabled={!hop.next}
                onClick={() => hop.next && onOpen(hop.next, true)}
                title="Next ]"
                type="button"
              >
                <Icon name="chevron-right" />
              </button>
            </span>
          ) : null}
          {layout === "beside" ? (
            <button
              aria-label={`Close ${view?.card.title ?? "subagent"}`}
              className="icon-btn"
              onClick={onClose}
              type="button"
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
      </header>
      <div
        className="subagent-pane__scroll"
        onScroll={(event) => {
          const scroller = event.currentTarget;
          tail.current = readTail(
            tail.current,
            scroller.scrollTop,
            scroller.scrollHeight - scroller.clientHeight,
            true,
          );
        }}
        ref={scrollRef}
      >
        <div className="subagent-pane__body">
          {view ? (
            <PaneBody
              live={live}
              scope={{ client: hostClient, threadId, nodeId, generation: detail?.generation }}
              onOpenAncestor={(id) => onOpen(id, false)}
              onRoot={onClose}
              onRetry={() => watch?.retry()}
              onEarlier={() => void watch?.loadOlder()}
              rootTitle={threadTitle}
              titleRef={titleRef}
              view={view}
            />
          ) : detail === null || detail.status === "loading" ? (
            <>
              <h2 className="subagent-pane__title" ref={titleRef} tabIndex={-1}>
                <span className="visually-hidden">Loading this subagent</span>
              </h2>
              <LoadingRows label="Loading this subagent" rows={4} />
            </>
          ) : (
            <div className="subagent-pane__gone" role="status">
              <h2 className="subagent-pane__title" ref={titleRef} tabIndex={-1}>
                This subagent can't be shown
              </h2>
              <p>It's no longer part of this conversation.</p>
              <button className="btn" onClick={onClose} type="button">
                Back to {threadTitle}
              </button>
            </div>
          )}
        </div>
      </div>
      {view ? (
        <PaneFooter nodeId={nodeId} parentTitle={parentTitle} threadId={threadId} view={view} />
      ) : null}
    </section>
  );
}

function isTyping(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
  );
}

function PaneBody({
  live,
  scope,
  onEarlier,
  onOpenAncestor,
  onRetry,
  onRoot,
  rootTitle,
  titleRef,
  view,
}: {
  live: boolean;
  scope: TranscriptTextScope;
  onEarlier: () => void;
  onOpenAncestor: (nodeId: string) => void;
  onRetry: () => void;
  onRoot: () => void;
  rootTitle: string;
  titleRef: React.Ref<HTMLHeadingElement>;
  view: SubagentDetail;
}) {
  const { card } = view;
  const [askOpen, setAskOpen] = useState(false);
  const settled = card.endedAt !== null;
  return (
    <>
      {view.lineage.length > 0 ? (
        <nav aria-label="Started by" className="subagent-pane__path">
          <button onClick={onRoot} type="button">
            {rootTitle}
          </button>
          {view.lineage.map((ancestor) => (
            <span className="subagent-pane__step" key={ancestor.nodeId}>
              <Icon name="chevron-right" />
              <button onClick={() => onOpenAncestor(ancestor.nodeId)} type="button">
                {ancestor.title}
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      <h2 className="subagent-pane__title" ref={titleRef} tabIndex={-1}>
        {card.title}
      </h2>
      <p className="subagent-pane__meta">
        <AgentMark card={card} />
        <span className="subagent-pane__word" data-tone={card.tone}>
          {card.word}
        </span>
        <Elapsed
          className="subagent-pane__time"
          endedAt={card.endedAt}
          startedAt={card.startedAt}
        />
        <span aria-hidden>·</span>
        <span>{card.noun}</span>
        {card.modelLabel ? (
          <>
            <span aria-hidden>·</span>
            <span>{card.modelLabel}</span>
          </>
        ) : null}
      </p>
      {view.prompt ? (
        <section aria-label="Asked to" className="subagent-pane__section">
          <h3 className="eyebrow eyebrow--micro">Asked to</h3>
          <MessageFold lines={3} onOpenChange={setAskOpen} open={askOpen}>
            <p className="subagent-pane__ask">{view.prompt}</p>
          </MessageFold>
        </section>
      ) : null}
      {card.workflow ? (
        <section aria-label="Phases" className="subagent-pane__section">
          <h3 className="eyebrow eyebrow--micro">Phases</h3>
          <AgentFolds>
            <div className="turn__content">
              <WorkflowPhases card={card} />
            </div>
          </AgentFolds>
        </section>
      ) : null}
      {settled && (view.result || card.tone !== "finished") ? (
        <section aria-label="Result" className="subagent-pane__section">
          <h3 className="eyebrow eyebrow--micro">
            {card.tone === "finished" ? "Result" : "What happened"}
          </h3>
          <Outcome card={card} result={view.result} />
        </section>
      ) : null}
      {card.workflow ? null : (
        <section aria-label="Steps" className="subagent-pane__section">
          <h3 className="eyebrow eyebrow--micro">Steps</h3>
          <Steps
            live={live}
            scope={scope}
            onEarlier={onEarlier}
            onRetry={onRetry}
            settled={settled}
            view={view}
          />
        </section>
      )}
    </>
  );
}

/** A settled subagent's full result; a failed or stopped one leads with how it ended. */
function Outcome({ card, result }: { card: AgentCard; result: string | null }) {
  if (!result)
    return (
      <p className="subagent-pane__outcome" data-tone={card.tone}>
        {card.detail.map((phrase) => phrase.text).join(". ")}.
      </p>
    );
  return (
    <>
      {card.tone === "finished" || !card.detail[0] ? null : (
        <p className="subagent-pane__outcome" data-tone={card.tone}>
          {card.detail[0].text}.
        </p>
      )}
      <Suspense fallback={<p className="md-prose md-prose--plain">{readableMarkdown(result)}</p>}>
        <Markdown text={result} />
      </Suspense>
    </>
  );
}

function Steps({
  live,
  scope,
  onEarlier,
  onRetry,
  settled,
  view,
}: {
  live: boolean;
  scope: TranscriptTextScope;
  onEarlier: () => void;
  onRetry: () => void;
  settled: boolean;
  view: SubagentDetail;
}) {
  switch (view.state) {
    case "loading":
      return <LoadingRows label="Loading this subagent's steps" rows={3} />;
    case "error":
      return (
        <div className="subagent-pane__note" role="alert">
          <Icon name="alert-circle" />
          <span>Couldn't load its steps.</span>
          <button className="btn btn--small" onClick={onRetry} type="button">
            Try again
          </button>
        </div>
      );
    case "summary-only":
    case "unavailable":
      return (
        <p className="subagent-pane__note">
          <Icon name="eye" />
          <span>
            {view.state === "unavailable"
              ? "Update Opensteer on this computer to see a subagent's steps."
              : "Only its summary was recorded."}
          </span>
        </p>
      );
    case "ready":
    case "missing":
      return (
        <>
          {view.hasEarlier || view.loadingEarlier ? (
            <button
              aria-busy={view.loadingEarlier}
              className="trace__earlier"
              disabled={view.loadingEarlier}
              onClick={onEarlier}
              type="button"
            >
              {view.loadingEarlier ? "Loading…" : "Show earlier steps"}
            </button>
          ) : null}
          <AgentProgressScope value={scope.nodeId}>
            <SubagentSteps active={!settled} entries={view.entries} live={live} scope={scope} />
          </AgentProgressScope>
          <LiveStatus card={view.card} scope={scope} />
          {view.entries.length === 0 && !settled ? (
            <p className="subagent-pane__note">
              <span>Nothing to show yet.</span>
            </p>
          ) : null}
        </>
      );
  }
}

/** The subagent's live line: the one leaf its progress ticks redraw. */
function LiveStatus({ card: reported, scope }: { card: AgentCard; scope: TranscriptTextScope }) {
  const card = useLiveAgentCard(scope.client, reported, scope.nodeId);
  if (!card.moving || !card.detail[0]) return null;
  return (
    <div aria-label="Subagent status" className="work work--live">
      <div className="work__head">
        <span className="work__label" key={card.detail[0].text}>
          {card.detail[0].text}
        </span>
      </div>
    </div>
  );
}

/** In the composer's place: its question, if it asked one, and who it reports to. */
function PaneFooter({
  nodeId,
  parentTitle,
  threadId,
  view,
}: {
  nodeId: string;
  parentTitle: string;
  threadId: string;
  view: SubagentDetail;
}) {
  const { hostClient } = useShell();
  const { requests } = useThreadTranscript(hostClient, threadId);
  const engine = useContext(AgentEngine);
  const { card } = view;
  const items = useDockedRequests(hostClient, threadId, requests, false);
  const own = card.requestId
    ? items.filter((item) => item.surface.request.id === card.requestId)
    : [];
  const followUps = useDeviceGrantFollowUps({
    liveRequestIds: own.map((item) => item.surface.request.id),
    nodeId,
    threadId,
  });
  const footer = subagentFooter(
    card,
    parentTitle,
    engine ? (harnessCatalogEntry(engine)?.label ?? null) : null,
  );
  return (
    <div className="subagent-pane__foot">
      {own.length > 0 || followUps ? (
        <div className="input-surface">
          <RequestStack
            asker={false}
            disabled={false}
            items={own}
            onOpen={() => undefined}
            openId={card.requestId}
            subagentNodeId={nodeId}
            threadId={threadId}
          />
        </div>
      ) : null}
      <div className="subagent-pane__watch" role="note">
        <Icon name="eye" />
        <p>
          A {card.kind === "workflow" ? "workflow" : "subagent"} reports to{" "}
          <strong>{footer.reportsTo}</strong>. You can watch it, not message it.
          {footer.noStop ? ` ${footer.noStop}` : null}
        </p>
        <SubagentStop card={card} />
      </div>
    </div>
  );
}
