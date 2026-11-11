import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  agentCardLabel,
  runningNow,
  sameRunningNow,
  SubagentCache,
  type HostSnapshot,
  type RunningNow as RunningNowModel,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { SubagentStop } from "./subagent-stop.js";
import { AgentMark, AgentPhrases, Elapsed, useOpenAgent } from "./subagent-rows.js";

/**
 * What runs in this conversation now, pinned between the transcript and the
 * composer and gone when nothing runs. Collapsed it is one line: how many,
 * and the newest thing one of them reported. It opens upward into the list,
 * each with its time and, where its engine allows, Stop.
 */
export const RunningNow = memo(function RunningNow({
  live: reachable,
  onOpenChange,
  open,
  scroller,
  threadId,
}: {
  /** Whether this conversation's computer is in reach; out of reach, all is last known. */
  live: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** The transcript, where the live row may already be saying the same thing. */
  scroller: RefObject<HTMLElement | null>;
  threadId: string;
}) {
  const { hostClient } = useShell();
  const cache = useMemo(() => new SubagentCache(), []);
  const select = useCallback(
    (snapshot: HostSnapshot) =>
      runningNow(reachable ? snapshot : { ...snapshot, connection: "offline" }, threadId, cache),
    [cache, reachable, threadId],
  );
  const live = useHostSelector(hostClient, select, sameRunningNow);
  // The last thing that ran stays drawn for a moment while the line leaves.
  const [leaving, setLeaving] = useState<RunningNowModel | null>(null);
  const shown = useRef<RunningNowModel | null>(null);
  useLayoutEffect(() => {
    if (live) {
      shown.current = live;
      setLeaving(null);
      return;
    }
    if (!shown.current) return;
    setLeaving(shown.current);
    shown.current = null;
    const timer = window.setTimeout(() => setLeaving(null), 160);
    return () => window.clearTimeout(timer);
  }, [live]);
  const model = live ?? leaving;
  const listId = useId();
  const repeated = useRowOnScreen(scroller, live?.newest?.key ?? null);
  useEffect(() => {
    if (!live && open) onOpenChange(false);
  }, [live, onOpenChange, open]);
  if (!model) return null;
  const newest = model.newest && !repeated ? model.newest : null;
  return (
    <section
      aria-hidden={live ? undefined : true}
      aria-label="Running now"
      className={[
        "running-now",
        open && live ? "running-now--open" : "",
        live ? "" : "running-now--leaving",
      ]
        .filter(Boolean)
        .join(" ")}
      inert={!live}
    >
      {open && live ? <RunningList id={listId} model={live} /> : null}
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-label={`${model.name}. ${open ? "Hide" : "Show"} the list`}
        className="running-now__bar"
        onClick={() => onOpenChange(!open)}
        type="button"
      >
        <span className="trace-step__icon">
          {model.lead ? (
            <AgentMark card={model.lead} />
          ) : (
            <span className="running-now__command-glyph">
              <Icon name="terminal" />
            </span>
          )}
        </span>
        <span className="running-now__what">
          <span className="running-now__count">{model.count}</span>
          <AgentPhrases
            after
            phrases={[
              ...model.detail,
              ...(newest && !open ? [{ text: newest.text, tone: "live" as const }] : []),
            ]}
          />
        </span>
        <span aria-hidden className="running-now__chevron">
          <Icon name="chevron-down" />
        </span>
      </button>
    </section>
  );
});

function RunningList({ id, model }: { id: string; model: RunningNowModel }) {
  const open = useOpenAgent();
  return (
    <ul className="running-now__list" id={id}>
      {model.rows.map(({ card, depth, within }) => (
        <li
          className="running-now__row"
          key={card.key}
          style={depth ? { paddingInlineStart: `${depth * 16}px` } : undefined}
        >
          <button
            aria-label={agentCardLabel(card, Date.now())}
            className="running-now__open"
            onClick={() => open(card)}
            type="button"
          >
            <span className="trace-step__icon">
              <AgentMark card={card} />
            </span>
            <span className="agent-step__text">
              <span className="running-now__title">
                <span className="trace-step__label">{card.title}</span>
                {within ? <span className="running-now__within">in {within}</span> : null}
              </span>
              <span className="agent-step__l2">
                <AgentPhrases phrases={card.detail} />
              </span>
            </span>
            <Elapsed
              className="trace-step__duration agent-step__time"
              endedAt={card.endedAt}
              startedAt={card.startedAt}
            />
          </button>
          <span className="running-now__stop">
            {card.stopping ? (
              <span
                aria-label={`Stopping ${card.title}`}
                className="spinner spinner--tiny"
                role="img"
              />
            ) : card.stop ? (
              <SubagentStop card={card} icon />
            ) : null}
          </span>
        </li>
      ))}
      {model.commands.map((command) => (
        <li className="running-now__row running-now__row--command" key={command.key}>
          <span className="running-now__open">
            <span className="trace-step__icon running-now__command-glyph">
              <Icon name="terminal" />
            </span>
            <span className="agent-step__text">
              <span className="running-now__title">
                <span className="trace-step__label">Command</span>
                <span className="trace-step__detail trace-step__detail--code">
                  {command.command}
                </span>
              </span>
              <span className="agent-step__l2">Running in the background</span>
            </span>
            <Elapsed
              className="trace-step__duration agent-step__time"
              endedAt={null}
              startedAt={command.startedAt}
            />
          </span>
          <span className="running-now__stop" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether the row that says `key`'s progress is on screen in the transcript,
 * so the line does not repeat it. Watched with an IntersectionObserver, and
 * looked for again only when the transcript's rows change.
 */
function useRowOnScreen(scroller: RefObject<HTMLElement | null>, key: string | null): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const root = scroller.current;
    if (!root || key === null) {
      setVisible(false);
      return;
    }
    let watched: Element | null = null;
    const intersection = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setVisible(last.isIntersecting);
      },
      { root },
    );
    const find = () => {
      const row = root.querySelector(
        `[data-agent-key="${CSS.escape(key)}"] > .trace-step__row .agent-step__live`,
      );
      if (row === watched) return;
      if (watched) intersection.unobserve(watched);
      watched = row;
      if (row) intersection.observe(row);
      else setVisible(false);
    };
    find();
    const mutation = new MutationObserver(find);
    mutation.observe(root, { childList: true, subtree: true });
    return () => {
      mutation.disconnect();
      intersection.disconnect();
    };
  }, [key, scroller]);
  return visible;
}
