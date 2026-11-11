import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import {
  subagentDetail,
  threadMark,
  type HostClient,
  type NodeDetailSnapshot,
  type NodeDetailSubscription,
  type NodeEntry,
  type SubagentDetail,
} from "@opensteer/client/host";
import { SubagentSteps } from "./agent-activity.js";
import { AgentMark, AgentState, Elapsed, WorkflowPhases, rememberOpener } from "./agent-cards.js";
import { useShell } from "./app-shell.js";
import { SubagentStop } from "./subagent-stop.js";
import { Icon } from "./icon.js";
import { RequestStack, useDockedRequests } from "./input-surface.js";
import { LoadingRows } from "./loading-rows.js";
import { MessageFold } from "./message-fold.js";
import { AreaLink } from "./workspace/area-link.js";
import { ChatOrb, TaskMark } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

const Markdown = lazy(() => import("./markdown.js"));

/** `/threads/:threadId/subagents/:nodeId`: a subagent's own view, in its conversation's place. */
export function SubagentRoute() {
  const { nodeId, threadId } = useParams();
  if (!threadId || !nodeId) return <Navigate replace to="/" />;
  return <SubagentView key={`${threadId}:${nodeId}`} nodeId={nodeId} threadId={threadId} />;
}

const noSubscription = () => () => undefined;
const noDetail = () => null;

/**
 * Holds the one node watch this screen may have: opened with the view,
 * released when it closes or another subagent replaces it.
 */
function useNodeDetail(
  hostClient: HostClient,
  threadId: string | null,
  nodeId: string,
): { readonly detail: NodeDetailSnapshot | null; readonly watch: NodeDetailSubscription | null } {
  const [watch, setWatch] = useState<NodeDetailSubscription | null>(null);
  useEffect(() => {
    if (threadId === null) return;
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

function SubagentView({ nodeId, threadId }: { nodeId: string; threadId: string }) {
  const { hostClient, snapshot } = useShell();
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId) ?? null;
  useEffect(() => {
    hostClient.activateThread(threadId);
  }, [hostClient, threadId]);
  const { detail, watch } = useNodeDetail(hostClient, thread ? threadId : null, nodeId);
  const summary =
    snapshot.transcripts[threadId]?.find(
      (entry): entry is NodeEntry => entry.kind === "node" && entry.nodeId === nodeId,
    ) ??
    detail?.node ??
    null;
  const parentPath = useParentPath();
  if (!summary || !detail || summary.nodeKind === "task") {
    const gone =
      snapshot.threadLookups[threadId] === "missing" ||
      summary?.nodeKind === "task" ||
      detail?.status === "missing" ||
      detail?.status === "ready";
    if (gone) return <MissingSubagent to={parentPath(threadId)} />;
    if (detail?.status === "error")
      return (
        <div className="thread subagent-view">
          <div className="subagent-view__empty">
            <LoadError onRetry={() => watch?.retry()} />
          </div>
        </div>
      );
    return (
      <div className="thread subagent-view">
        <div className="subagent-view__empty">
          <LoadingRows label="Loading this subagent's steps" rows={3} />
        </div>
      </div>
    );
  }
  const view = subagentDetail(detail, summary, snapshot);
  if (view.state === "missing") return <MissingSubagent to={parentPath(threadId)} />;
  return <SubagentScreen view={view} watch={watch} />;
}

/** Where Open parent goes: the parent subagent's own view, or the conversation. */
function useParentPath(): (threadId: string, nodeId?: string) => string {
  const workspace = useOptionalWorkspace();
  return (threadId, nodeId) =>
    nodeId
      ? (workspace?.nav.subagentPath(threadId, nodeId) ??
        `/threads/${encodeURIComponent(threadId)}/subagents/${encodeURIComponent(nodeId)}`)
      : (workspace?.nav.threadPath(threadId) ?? `/threads/${encodeURIComponent(threadId)}`);
}

function useOpenParent(view: Pick<SubagentDetail, "card" | "parent">): () => void {
  const workspace = useOptionalWorkspace();
  const navigate = useNavigate();
  const parentPath = useParentPath();
  const to = parentPath(view.parent.threadId, view.parent.nodeId);
  return () => {
    rememberOpener(view.card);
    if (workspace) workspace.nav.openConversation(to);
    else void navigate(to);
  };
}

function SubagentScreen({
  view,
  watch,
}: {
  view: SubagentDetail;
  watch: NodeDetailSubscription | null;
}) {
  const { card } = view;
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const follows = useRef(true);
  const anchor = useRef<{ readonly element: Element; readonly top: number } | null>(null);
  const openParent = useOpenParent(view);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const held = anchor.current;
    if (held) {
      anchor.current = null;
      scroller.scrollTop += held.element.getBoundingClientRect().top - held.top;
    } else if (follows.current) scroller.scrollTop = scroller.scrollHeight;
  }, [view.entries, view.state]);
  const showEarlier = () => {
    const scroller = scrollRef.current;
    const first = scroller?.querySelector(".subagent-view__steps > .turn__content > *");
    if (first) anchor.current = { element: first, top: first.getBoundingClientRect().top };
    void watch?.loadOlder();
  };
  const settled = view.card.endedAt !== null;
  return (
    <div className="thread subagent-view">
      <SubagentHeader openParent={openParent} titleRef={titleRef} view={view} />
      <div className="thread__body">
        <div className="thread__conversation">
          <div
            className="transcript-scroll"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              follows.current =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
            }}
            ref={scrollRef}
          >
            <div className="transcript subagent-view__body">
              {view.hasEarlier || view.loadingEarlier ? (
                <button
                  aria-busy={view.loadingEarlier}
                  className="trace__earlier"
                  disabled={view.loadingEarlier}
                  onClick={showEarlier}
                  type="button"
                >
                  {view.loadingEarlier ? "Loading…" : "Show earlier steps"}
                </button>
              ) : null}
              {view.prompt ? <SubagentPrompt from={view.parent.title} text={view.prompt} /> : null}
              {card.kind === "workflow" ? <WorkflowPhases card={card} /> : null}
              <SubagentBody onRetry={() => watch?.retry()} settled={settled} view={view} />
            </div>
          </div>
        </div>
      </div>
      <div className="composer-dock">
        {card.requestId ? (
          <SubagentRequest requestId={card.requestId} threadId={view.parent.threadId} />
        ) : (
          <ReadOnlyBar onOpenParent={openParent} />
        )}
      </div>
    </div>
  );
}

function SubagentHeader({
  openParent,
  titleRef,
  view,
}: {
  openParent: () => void;
  titleRef: React.Ref<HTMLHeadingElement>;
  view: SubagentDetail;
}) {
  const { snapshot } = useShell();
  const parentPath = useParentPath();
  const { card, parent } = view;
  const kind = card.kind === "workflow" ? "Workflow" : "Subagent";
  return (
    <header className="conv-header">
      <nav aria-label="Subagent lineage" className="conv-header__trail">
        <AreaLink
          aria-label={`Back to ${parent.title}`}
          className="conv-header__back"
          onClick={(event) => {
            event.preventDefault();
            openParent();
          }}
          title={parent.title}
          to={parentPath(parent.threadId, parent.nodeId)}
        >
          <Icon name="arrow-left" />
          {parent.nodeId ? (
            <Icon name="sparkles" />
          ) : parent.threadId === snapshot.homeThreadId ? (
            <ChatOrb size={16} />
          ) : (
            <TaskMark size={16} mark={threadMark(parent.threadId, snapshot)} />
          )}
          <span className="conv-header__back-title">{parent.title}</span>
        </AreaLink>
      </nav>
      <div className="conv-header__bar">
        <span aria-hidden className="conv-header__mark subagent-view__mark">
          <AgentMark card={card} />
        </span>
        <div className="conv-header__text">
          <h1 className="conv-header__title" ref={titleRef} tabIndex={-1} title={card.title}>
            <span className="conv-header__name conv-header__name--static">{card.title}</span>
          </h1>
          <p className="conv-header__cause">
            {card.modelLabel ? `${kind} · ${card.modelLabel}` : kind}
          </p>
        </div>
        <div className="conv-header__end subagent-view__state">
          <SubagentStop card={card} direct />
          <AgentState card={card} />
          <Elapsed className="agent-row__time" endedAt={card.endedAt} startedAt={card.startedAt} />
        </div>
      </div>
    </header>
  );
}

/** What the parent asked it, in the register of a message someone else sent. */
function SubagentPrompt({ from, text }: { from: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg--input">
      <article className="input-card">
        <header className="input-card__from" title={`From ${from}`}>
          <span className="input-card__sender">
            <span className="input-card__name">From {from}</span>
          </span>
        </header>
        <MessageFold lines={5} onOpenChange={setOpen} open={open}>
          <p className="input-card__plain">{text}</p>
        </MessageFold>
      </article>
    </div>
  );
}

function SubagentBody({
  onRetry,
  settled,
  view,
}: {
  onRetry: () => void;
  settled: boolean;
  view: SubagentDetail;
}) {
  const { snapshot } = useShell();
  const live = snapshot.connection !== "offline" && snapshot.network !== "offline";
  switch (view.state) {
    case "loading":
      return <LoadingRows label="Loading this subagent's steps" rows={3} />;
    case "error":
      return <LoadError onRetry={onRetry} />;
    case "summary-only":
    case "unavailable":
      return (
        <>
          <Note title="Only a summary is available.">
            {view.state === "unavailable"
              ? "Update Opensteer on this computer to see a subagent's steps."
              : "This subagent's steps weren't recorded."}
          </Note>
          <Result text={view.result} />
        </>
      );
    case "ready":
    case "missing":
      return (
        <>
          <div className="turn subagent-view__steps">
            <SubagentSteps active={!settled} entries={view.entries} live={live} />
          </div>
          <Result text={view.result} />
        </>
      );
  }
}

function Note({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="run-note subagent-view__note">
      <Icon name="alert-circle" />
      <div>
        <strong>{title}</strong>
        <br />
        {children}
      </div>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="run-note subagent-view__note" role="alert">
      <Icon name="alert-circle" />
      <div>
        <strong>Couldn't load this subagent's steps.</strong>
        <div className="subagent-view__retry">
          <button className="btn" onClick={onRetry} type="button">
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function Result({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <section aria-label="Result" className="subagent-view__result">
      <span className="eyebrow eyebrow--micro">Result</span>
      <Suspense fallback={<p className="md-prose md-prose--plain">{text}</p>}>
        <Markdown text={text} />
      </Suspense>
    </section>
  );
}

function MissingSubagent({ to }: { to: string }) {
  const workspace = useOptionalWorkspace();
  const navigate = useNavigate();
  return (
    <div className="thread subagent-view">
      <div className="subagent-view__empty" role="status">
        <h1 className="subagent-view__empty-title">This subagent can't be shown</h1>
        <button
          className="btn"
          onClick={() => (workspace ? workspace.nav.openConversation(to) : void navigate(to))}
          type="button"
        >
          Open parent
        </button>
      </div>
    </div>
  );
}

/** In the composer's place: you watch a subagent, its parent steers it. */
function ReadOnlyBar({ onOpenParent }: { onOpenParent: () => void }) {
  return (
    <div className="agent-readonly-slot">
      <div aria-label="Runs on its own" className="agent-readonly" role="note">
        <span aria-hidden className="agent-readonly__glyph">
          <Icon name="eye" />
        </span>
        <div className="agent-readonly__text">
          <p className="agent-readonly__title">Runs on its own</p>
          <p className="agent-readonly__detail">
            You can't message a subagent. Its parent decides what it does.
          </p>
        </div>
        <button className="btn" onClick={onOpenParent} type="button">
          Open parent
        </button>
      </div>
    </div>
  );
}

/** The parent's own Request panel for what this subagent asked, answered right here. */
function SubagentRequest({ requestId, threadId }: { requestId: string; threadId: string }) {
  const { snapshot } = useShell();
  const items = useDockedRequests(threadId, snapshot.requests[threadId] ?? noRequests, false);
  const own = items.filter((item) => item.surface.request.id === requestId);
  return (
    <div className="agent-readonly-slot input-surface">
      <RequestStack
        asker={false}
        disabled={false}
        items={own}
        onOpen={() => undefined}
        openId={requestId}
        threadId={threadId}
      />
    </div>
  );
}

const noRequests: readonly never[] = [];
