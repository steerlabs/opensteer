import { memo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useWindowedRows } from "../workspace/windowed-rows.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { useScrollEdges } from "../workspace/scroll-edges.js";
import { ChannelGlyph, TeamTile } from "./team-marks.js";
import type { ChannelRowView, TeamSidebarView, TeamTileView } from "./team-models.js";

export interface TeamSideActions {
  readonly onOpenChannel: (channelId: string) => void;
  readonly onNewChannel?: (() => void) | undefined;
  readonly onNewMessage?: (() => void) | undefined;
  readonly onBrowseChannels?: (() => void) | undefined;
  readonly onRemoveFromSidebar?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onInvite?: (() => void) | undefined;
}

export interface TeamMenuActions {
  readonly onKnowledge?: (() => void) | undefined;
  readonly onInvite?: (() => void) | undefined;
  readonly onSettings?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
  readonly onCreateTeam?: (() => void) | undefined;
  readonly onJoinTeam?: (() => void) | undefined;
}

/** What a segment says while the reader is on the other side. */
export type SegmentBadge =
  | { readonly kind: "needs-you"; readonly count: number }
  | { readonly kind: "new" }
  | { readonly kind: "mentions"; readonly count: number }
  | null;

export interface SwitchSegment {
  readonly id: string;
  readonly label: string;
  readonly tile?: TeamTileView | undefined;
  readonly badge: SegmentBadge;
  /** A team's menu, opened by the ⌄ on its segment while it is chosen. */
  readonly menu?: TeamMenuActions | undefined;
}

/**
 * Tasks and each team the computer joined, as one segmented control. A
 * segment holds its badge and, once chosen, its team's ⌄, so the chosen plate
 * carries all three. Both sides always keep their badge, and only the person
 * ever changes the side.
 */
export function SidebarSwitch({
  active,
  onSelect,
  segments,
}: {
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly segments: readonly SwitchSegment[];
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  return (
    <div aria-label="Tasks or a team" className="segmented side-switch" role="radiogroup">
      {segments.map((segment, index) => {
        const chosen = segment.id === active;
        const menu = chosen ? segment.menu : undefined;
        return (
          <div
            className={chosen ? "side-switch__segment is-chosen" : "side-switch__segment"}
            key={segment.id}
          >
            <button
              aria-checked={chosen}
              className="side-switch__option"
              data-value={segment.id}
              onClick={() => onSelect(segment.id)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? -1
                      : 0;
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? segments.length - 1
                      : step
                        ? (index + step + segments.length) % segments.length
                        : null;
                if (nextIndex === null) return;
                event.preventDefault();
                const next = segments[nextIndex]!;
                onSelect(next.id);
                const group = event.currentTarget.closest('[role="radiogroup"]');
                group
                  ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.id)}"]`)
                  ?.focus();
              }}
              role="radio"
              tabIndex={chosen ? 0 : -1}
              title={segment.label}
              type="button"
            >
              {segment.tile ? <TeamTile size={14} tile={segment.tile} /> : null}
              <span className="side-switch__label">{segment.label}</span>
              <Badge badge={segment.badge} />
            </button>
            {menu ? (
              <button
                aria-expanded={menuFor === segment.id}
                aria-haspopup="menu"
                aria-label={`${segment.label} menu`}
                className="side-switch__menu"
                onClick={() => setMenuFor(menuFor === segment.id ? null : segment.id)}
                ref={(element) => {
                  if (element) anchors.current.set(segment.id, element);
                }}
                type="button"
              >
                <Icon name="chevron-down" />
              </button>
            ) : null}
            {menuFor === segment.id && menu && anchors.current.get(segment.id) ? (
              <TeamMenu
                actions={menu}
                anchor={anchors.current.get(segment.id)!}
                name={segment.label}
                onClose={() => setMenuFor(null)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Badge({ badge }: { readonly badge: SegmentBadge }) {
  if (!badge) return null;
  if (badge.kind === "new")
    return <span aria-label="new result" className="task-row__unread" role="img" />;
  if (badge.count === 0) return null;
  return badge.kind === "needs-you" ? (
    <span aria-label={`${badge.count} need you`} className="side-needs__bang" role="img">
      !
    </span>
  ) : (
    <span aria-label={`${badge.count} mentions`} className="mention-count" role="img">
      {badge.count}
    </span>
  );
}

function TeamMenu({
  actions,
  anchor,
  name,
  onClose,
}: {
  readonly actions: TeamMenuActions;
  readonly anchor: HTMLElement;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const item = (label: string, run: (() => void) | undefined, danger = false) =>
    run ? (
      <button
        className={danger ? "picker__row picker__row--danger" : "picker__row"}
        key={label}
        onClick={() => {
          onClose();
          run();
        }}
        role="menuitem"
        type="button"
      >
        {label}
      </button>
    ) : null;
  return (
    <Popover anchor={anchor} below label={`${name} menu`} onClose={onClose}>
      {item("Knowledge", actions.onKnowledge)}
      {item("Invite people", actions.onInvite)}
      {item("Team settings", actions.onSettings)}
      {actions.onCreateTeam || actions.onJoinTeam ? <hr className="picker__divider" /> : null}
      {item("Create a team", actions.onCreateTeam)}
      {item("Join with an invite", actions.onJoinTeam)}
      {actions.onLeave ? <hr className="picker__divider" /> : null}
      {item(`Leave ${name}`, actions.onLeave, true)}
    </Popover>
  );
}

/**
 * The team's side: its channels, then its direct messages, each under a
 * label whose + makes one. Unread is weight; only mentions of the reader count.
 */
export function TeamSide({
  actions,
  hrefFor,
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
