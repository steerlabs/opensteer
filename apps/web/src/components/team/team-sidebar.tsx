import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  moreTeamsKey,
  sideSwitchLayout,
  type SidebarSide,
  type SideSwitchMetrics,
} from "@opensteer/client/team";
import { useWindowedRows } from "../workspace/windowed-rows.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { useScrollEdges } from "../workspace/scroll-edges.js";
import { ChannelGlyph, TeamTile } from "./team-marks.js";
import type { ChannelRowView, TeamSidebarView, TeamTileView } from "./team-models.js";

export interface TeamSideActions {
  readonly onOpenChannel: (channelId: string) => void;
  readonly onKnowledge?: (() => void) | undefined;
  readonly onNewChannel?: (() => void) | undefined;
  readonly onNewMessage?: (() => void) | undefined;
  readonly onBrowseChannels?: (() => void) | undefined;
  readonly onRemoveFromSidebar?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onInvite?: (() => void) | undefined;
}

/** What a segment says while the reader is on the other side. */
export type SegmentBadge =
  { readonly kind: "needs-you"; readonly count: number } | { readonly kind: "new" } | null;

export interface SwitchTeam {
  readonly id: string;
  readonly name: string;
  readonly tile: TeamTileView;
  readonly mentions: number;
}

/**
 * Tasks and each team the computer joined, as one switch. Tasks keeps its own
 * width, the team last shown takes the rest and says its name, and every
 * other team is its mark, so a team is always one visible click away and
 * moving between Tasks and that team moves nothing but the plate.
 *
 * Every segment's place comes from `sideSwitchLayout`, so the plate and the
 * segments it slides over move from the same numbers in the same frame.
 */
export function SidebarSwitch({
  active,
  onSelect,
  recent,
  tasksBadge,
  teams,
}: {
  readonly active: SidebarSide;
  readonly onSelect: (side: SidebarSide) => void;
  /** The team that owns the named segment, from `recentTeam`. */
  readonly recent: string;
  readonly tasksBadge: SegmentBadge;
  readonly teams: readonly SwitchTeam[];
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const tasks = useRef<HTMLButtonElement | null>(null);
  const [size, setSize] = useState<Measured>(unmeasured);
  useLayoutEffect(() => {
    const measure = () => {
      if (!track.current || !tasks.current) return;
      const next = measureSwitch(track.current, tasks.current);
      setSize((held) => (sameMeasure(held, next) ? held : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (track.current) observer.observe(track.current);
    if (tasks.current) observer.observe(tasks.current);
    return () => observer.disconnect();
  }, []);
  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const layout = sideSwitchLayout(
    { teamIds, recent, width: size.width, tasks: size.tasks },
    size.metrics,
  );
  const measured = size.width > 0 && size.tasks > 0 && size.metrics.mark > 0;
  const moving = useMoving(`${active} ${recent}`);
  const frame = (key: string) => layout.segments.find((segment) => segment.key === key);
  // A team folded away is chosen through, and shown chosen on, the folded segment.
  const plate = frame(active) ?? frame(moreTeamsKey);
  const byId = new Map(teams.map((team) => [team.id, team]));
  const radios = layout.segments.flatMap((segment) =>
    segment.key === moreTeamsKey ? [] : [segment.key],
  );
  // Choosing a side navigates; the page that opens must not take focus from a
  // radio group the person is still moving through with the keyboard.
  const keyed = useRef<SidebarSide | null>(null);
  const focusSide = (side: SidebarSide) =>
    track.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(side)}"]`)?.focus();
  useEffect(() => {
    if (keyed.current !== active) return;
    keyed.current = null;
    focusSide(active);
  });
  const select = (side: SidebarSide, focus: boolean) => {
    if (focus) keyed.current = side;
    onSelect(side);
    if (focus) focusSide(side);
  };
  const keys = (event: KeyboardEvent<HTMLButtonElement>, side: SidebarSide) => {
    const index = radios.indexOf(side);
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : step
            ? (index + step + radios.length) % radios.length
            : null;
    if (next === null) return;
    event.preventDefault();
    select(radios[next]!, true);
  };
  const recentTeamView = byId.get(recent);
  return (
    <>
      <div
        aria-label="Tasks or a team"
        className="side-switch"
        data-measured={measured ? "" : undefined}
        data-moving={moving ? "" : undefined}
        ref={track}
        role="radiogroup"
      >
        {measured && plate ? (
          <span
            aria-hidden
            className="side-switch__plate"
            style={{ transform: `translateX(${plate.x}px)`, width: plate.width }}
          />
        ) : null}
        <button
          aria-checked={active === "tasks"}
          className="side-switch__segment side-switch__segment--tasks"
          data-value="tasks"
          onClick={() => select("tasks", false)}
          onKeyDown={(event) => keys(event, "tasks")}
          ref={tasks}
          role="radio"
          tabIndex={active === "tasks" ? 0 : -1}
          type="button"
        >
          <span className="side-switch__label">Tasks</span>
          <TasksBadge badge={tasksBadge} />
        </button>
        {layout.segments.map((segment) => {
          if (segment.key === "tasks") return null;
          const style = measured ? { width: segment.width } : undefined;
          if (segment.key === moreTeamsKey)
            return (
              <MoreTeams
                active={active}
                key={segment.key}
                onSelect={(side) => select(side, false)}
                style={style}
                teams={layout.folded.flatMap((id) => byId.get(id) ?? [])}
              />
            );
          const team = byId.get(segment.key);
          if (!team) return null;
          const named = team.id === recent && layout.named;
          const chosen = team.id === active;
          return (
            <button
              aria-checked={chosen}
              aria-label={withMentions(team.name, team.mentions)}
              className={`side-switch__segment${named ? " is-named" : ""}${team.id === recent ? " is-recent" : ""}`}
              data-value={team.id}
              key={team.id}
              onClick={() => select(team.id, false)}
              onKeyDown={(event) => keys(event, team.id)}
              role="radio"
              style={style}
              tabIndex={chosen ? 0 : -1}
              title={named ? undefined : withMentions(team.name, team.mentions)}
              type="button"
            >
              <span className="side-switch__face">
                <TeamTile size={18} tile={team.tile} />
                <span className="side-switch__label">{team.name}</span>
                {team.mentions > 0 ? (
                  <span aria-hidden className="mention-count">
                    {countText(team.mentions)}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {!layout.named && active !== "tasks" && recentTeamView ? (
        <p className="side-switch__title">
          <TeamTile size={20} tile={recentTeamView.tile} />
          <span className="side-switch__title-name">{recentTeamView.name}</span>
        </p>
      ) : null}
    </>
  );
}

interface Measured {
  readonly width: number;
  readonly tasks: number;
  readonly metrics: SideSwitchMetrics;
}

const unmeasured: Measured = {
  width: 0,
  tasks: 0,
  metrics: { padding: 0, gap: 0, mark: 0, named: 0 },
};

/** The track as drawn, with the measures `.side-switch` declares for the layout. */
function measureSwitch(track: HTMLElement, tasks: HTMLElement): Measured {
  const style = getComputedStyle(track);
  const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  return {
    width: track.clientWidth,
    tasks: tasks.offsetWidth,
    metrics: {
      padding: px("--switch-padding"),
      gap: px("--switch-gap"),
      mark: px("--switch-mark"),
      named: px("--switch-named"),
    },
  };
}

function sameMeasure(left: Measured, right: Measured): boolean {
  return (
    left.width === right.width &&
    left.tasks === right.tasks &&
    left.metrics.padding === right.metrics.padding &&
    left.metrics.gap === right.metrics.gap &&
    left.metrics.mark === right.metrics.mark &&
    left.metrics.named === right.metrics.named
  );
}

/**
 * True for as long as the plate and segments take to settle after the side or
 * the recent team changes, so only those move; a sidebar being resized follows
 * the pointer at once.
 */
function useMoving(key: string): boolean {
  const [last, setLast] = useState(key);
  const [moving, setMoving] = useState(false);
  // Set in the same render that moves the segments, so their transition is in
  // place when the new widths are.
  if (last !== key) {
    setLast(key);
    setMoving(true);
  }
  useEffect(() => {
    if (!moving) return;
    const settle = window.setTimeout(() => setMoving(false), 450);
    return () => window.clearTimeout(settle);
  }, [key, moving]);
  return moving;
}

/** The teams past what the track holds, behind one segment that lists them. */
function MoreTeams({
  active,
  onSelect,
  style,
  teams,
}: {
  readonly active: SidebarSide;
  readonly onSelect: (side: SidebarSide) => void;
  readonly style: CSSProperties | undefined;
  readonly teams: readonly SwitchTeam[];
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const mentions = teams.reduce((sum, team) => sum + team.mentions, 0);
  const label = `${teams.length} more ${teams.length === 1 ? "team" : "teams"}`;
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={withMentions(label, mentions)}
        className="side-switch__segment side-switch__more"
        onClick={() => setOpen((value) => !value)}
        ref={setAnchor}
        style={style}
        title={label}
        type="button"
      >
        <span className="side-switch__face">
          <Icon name="more" />
          {mentions > 0 ? (
            <span aria-hidden className="mention-count">
              {countText(mentions)}
            </span>
          ) : null}
        </span>
      </button>
      {open && anchor ? (
        <Popover align="end" anchor={anchor} below label={label} onClose={() => setOpen(false)}>
          {teams.map((team) => (
            <button
              aria-current={team.id === active ? "true" : undefined}
              className="picker__row"
              key={team.id}
              onClick={() => {
                setOpen(false);
                onSelect(team.id);
              }}
              role="menuitem"
              type="button"
            >
              <TeamTile size={18} tile={team.tile} />
              <span className="picker__label">{team.name}</span>
              {team.id === active ? <Icon name="check" /> : null}
              {team.mentions > 0 ? (
                <span
                  aria-label={mentionPhrase(team.mentions)}
                  className="mention-count"
                  role="img"
                >
                  {countText(team.mentions)}
                </span>
              ) : null}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

function TasksBadge({ badge }: { readonly badge: SegmentBadge }) {
  if (!badge) return null;
  if (badge.kind === "new")
    return <span aria-label="new result" className="task-row__unread" role="img" />;
  if (badge.count === 0) return null;
  return (
    <span aria-label={`${badge.count} need you`} className="side-needs__bang" role="img">
      !
    </span>
  );
}

function mentionPhrase(mentions: number): string {
  return mentions === 1 ? "1 mention" : `${mentions} mentions`;
}

function withMentions(label: string, mentions: number): string {
  return mentions === 0 ? label : `${label}, ${mentionPhrase(mentions)}`;
}

function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * The team's side: its channels, then its direct messages, each under a
 * label whose + makes one. Unread is weight; only mentions of the reader count.
 */
export function TeamSide({
  actions,
  hrefFor,
  knowledgeOpen = false,
  openChannelId = null,
  team,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  /** Kept the same between draws, so unchanged rows are not drawn again. */
  readonly actions: TeamSideActions;
  /** Gives rows real addresses, so a modified click opens a new window. */
  readonly hrefFor?: ((channelId: string) => string) | undefined;
  /** The team's knowledge is the page open. */
  readonly knowledgeOpen?: boolean;
  readonly openChannelId?: string | null;
  readonly team: TeamSidebarView;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: (() => void) | undefined;
}) {
  const name = team.tile.name;
  const scroller = useRef<HTMLDivElement | null>(null);
  useScrollEdges(scroller);
  if (team.connection === "sign-in")
    return (
      <div className="team-left">
        <p className="team-left__title">Sign in to {name}</p>
        <button className="btn btn--small" onClick={actions.onRetry} type="button">
          Sign in
        </button>
      </div>
    );
  if (team.connection === "removed" || team.connection === "left")
    return (
      <div className="team-left">
        <TeamTile tile={team.tile} />
        <div className="team-left__text">
          <p className="team-left__title">
            {team.connection === "removed" ? `You’re no longer in ${name}` : `You left ${name}`}
          </p>
          <p className="team-left__detail">Tasks it started stay in your list.</p>
        </div>
        {actions.onRemoveFromSidebar ? (
          <button
            className="btn btn--small btn--ghost"
            onClick={actions.onRemoveFromSidebar}
            type="button"
          >
            Remove
          </button>
        ) : null}
      </div>
    );
  const problem =
    team.connection === "offline"
      ? `Can’t reach ${name} right now.`
      : team.connection === "update-app"
        ? `Update Opensteer to keep using ${name}.`
        : team.connection === "update-server"
          ? `${name}’s server needs an update. It updates itself.`
          : null;
  return (
    <div
      className={problem ? "team-side team-side--dim" : "team-side"}
      data-scroll-edges=""
      ref={scroller}
    >
      {problem ? (
        <p className="team-side__problem" role="status">
          {problem}
          {team.connection === "offline" && actions.onRetry ? (
            <button className="link-button" onClick={actions.onRetry} type="button">
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {actions.onKnowledge ? (
        <ul aria-label={`${name} pages`} className="team-rows team-side__pages">
          <li className={knowledgeOpen ? "team-row is-filled" : "team-row"}>
            <button
              aria-current={knowledgeOpen ? "page" : undefined}
              className="team-row__main"
              onClick={actions.onKnowledge}
              type="button"
            >
              <span className="team-row__glyph">
                <Icon name="brain" />
              </span>
              <span className="team-row__name">Knowledge</span>
            </button>
          </li>
        </ul>
      ) : null}
      <SideLabel
        action={
          actions.onNewChannel
            ? ["New channel", actions.onNewChannel]
            : ["Browse channels", actions.onBrowseChannels]
        }
        label="Channels"
      />
      <ChannelRows
        label={`${name} channels`}
        rows={team.channels}
        scroll={scroller}
        hrefFor={hrefFor}
        onOpen={actions.onOpenChannel}
        openChannelId={openChannelId}
      />
      {actions.onBrowseChannels ? (
        <button className="team-side__action" onClick={actions.onBrowseChannels} type="button">
          <Icon name="search" />
          Browse channels
        </button>
      ) : null}
      {actions.onInvite ? (
        <button className="team-side__invite" onClick={actions.onInvite} type="button">
          <Icon name="plus" />
          Invite people
        </button>
      ) : null}
      <SideLabel action={["New message", actions.onNewMessage]} label="Direct messages" />
      <ChannelRows
        label={`${name} direct messages`}
        rows={team.dms}
        scroll={scroller}
        hrefFor={hrefFor}
        onOpen={actions.onOpenChannel}
        openChannelId={openChannelId}
      />
      {team.dms.length === 0 && !hasMore && actions.onNewMessage ? (
        <button className="team-side__action" onClick={actions.onNewMessage} type="button">
          <Icon name="plus" />
          Message someone
        </button>
      ) : null}
      {hasMore && onLoadMore ? (
        <button
          className="team-rows__more"
          disabled={loadingMore}
          onClick={onLoadMore}
          type="button"
        >
          {loadingMore ? "Loading…" : "More channels and messages"}
        </button>
      ) : null}
    </div>
  );
}

function ChannelRows({
  label,
  rows,
  scroll,
  hrefFor,
  onOpen,
  openChannelId,
}: {
  readonly label: string;
  readonly rows: readonly ChannelRowView[];
  readonly scroll: RefObject<HTMLDivElement | null>;
  readonly hrefFor: ChannelRowProps["hrefFor"];
  readonly onOpen: ChannelRowProps["onOpen"];
  readonly openChannelId: string | null;
}) {
  const list = useRef<HTMLUListElement | null>(null);
  const plan = useWindowedRows({
    list: scroll,
    rows: list,
    keys: rows.map((row) => row.id),
    estimate: () => 32,
    pinned: [openChannelId ?? ""],
    all: false,
  });
  return (
    <ul aria-label={label} className="team-rows" ref={list}>
      {plan.map((entry, index) =>
        "spacer" in entry ? (
          <li aria-hidden key={`spacer:${index}`} style={{ height: entry.spacer }} />
        ) : (
          <ChannelRow
            hrefFor={hrefFor}
            key={rows[entry.index]!.id}
            onOpen={onOpen}
            open={rows[entry.index]!.id === openChannelId}
            row={rows[entry.index]!}
          />
        ),
      )}
    </ul>
  );
}

function SideLabel({
  action: [name, run],
  label,
}: {
  readonly action: readonly [string, (() => void) | undefined];
  readonly label: string;
}) {
  return (
    <div className="side-head">
      <h3 className="side-head__title">{label}</h3>
      {run ? (
        <button
          aria-label={name}
          className="icon-btn icon-btn--small side-head__action"
          onClick={run}
          title={name}
          type="button"
        >
          <Icon name="plus" />
        </button>
      ) : null}
    </div>
  );
}

/** One channel or DM; drawn again only when what it shows changes. */
interface ChannelRowProps {
  readonly hrefFor: ((channelId: string) => string) | undefined;
  readonly onOpen: (channelId: string) => void;
  readonly open: boolean;
  readonly row: ChannelRowView;
}

const ChannelRow = memo(function ChannelRow({ hrefFor, onOpen, open, row }: ChannelRowProps) {
  const dm = row.kind === "dm" || row.kind === "group-dm";
  const label = [
    dm ? row.name : `${row.kind === "private" ? "Private channel" : "Channel"} ${row.name}`,
    row.peopleOnly ? "people only" : null,
    row.shared ? "shared channel" : null,
    row.mentions > 0 ? `${row.mentions} ${row.mentions === 1 ? "mention" : "mentions"}` : null,
    row.unread && row.mentions === 0 ? "unread" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const href = hrefFor?.(row.id);
  const go = (event: MouseEvent<HTMLElement>) => {
    if (href && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    onOpen(row.id);
  };
  const inner: ReactNode = (
    <>
      <span className="team-row__glyph">
        <ChannelGlyph kind={row.kind} people={row.people} />
      </span>
      <span className="team-row__name">{row.name}</span>
      {row.shared ? (
        <span title="Shared channel">
          <Icon name="link" />
        </span>
      ) : null}
      {row.peopleOnly ? <Icon className="team-row__people-only" name="user" /> : null}
      {row.mentions > 0 ? (
        <span aria-hidden className="mention-count">
          {row.mentions}
        </span>
      ) : null}
    </>
  );
  return (
    <li
      className={[
        "team-row",
        row.unread || row.mentions > 0 ? "is-unread" : "",
        row.muted ? "is-muted" : "",
        open ? "is-filled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-channel-id={row.id}
      data-motion-key={row.id}
    >
      {href ? (
        <a
          aria-current={open ? "page" : undefined}
          aria-label={label}
          className="team-row__main"
          href={href}
          onClick={go}
        >
          {inner}
        </a>
      ) : (
        <button
          aria-current={open ? "page" : undefined}
          aria-label={label}
          className="team-row__main"
          onClick={go}
          type="button"
        >
          {inner}
        </button>
      )}
    </li>
  );
}, sameChannelRow);

function sameChannelRow(before: ChannelRowProps, after: ChannelRowProps): boolean {
  return (
    before.open === after.open &&
    before.onOpen === after.onOpen &&
    before.hrefFor === after.hrefFor &&
    rowKeys.every((key) => before.row[key] === after.row[key])
  );
}

const rowKeys = [
  "id",
  "kind",
  "name",
  "unread",
  "mentions",
  "peopleOnly",
  "muted",
  "people",
] as const satisfies readonly (keyof ChannelRowView)[];
