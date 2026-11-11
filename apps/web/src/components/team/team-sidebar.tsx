import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ChannelGlyph, TeamTile } from "./team-marks.js";
import type { ChannelRowView, TeamSidebarView } from "./team-models.js";

export interface TeamSectionActions {
  readonly onOpenChannel: (channelId: string) => void;
  /** Gives rows real addresses, so a modified click opens a new window. */
  readonly hrefFor?: ((channelId: string) => string) | undefined;
  readonly onNewChannel?: (() => void) | undefined;
  readonly onNewMessage?: (() => void) | undefined;
  readonly onBrowseChannels?: (() => void) | undefined;
  readonly onInvite?: (() => void) | undefined;
  readonly onKnowledge?: (() => void) | undefined;
  readonly onSearch?: (() => void) | undefined;
  readonly onMarkAllRead?: (() => void) | undefined;
  readonly onNotifications?: (() => void) | undefined;
  readonly onSettings?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
  readonly onMoreDms?: (() => void) | undefined;
  readonly onRemoveFromSidebar?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onUpdate?: (() => void) | undefined;
}

/**
 * One team in the sidebar: its head, its channels, then its direct messages.
 * Unread is weight, not a number; only mentions of the reader are counted.
 * Folded, the head still says how many mentions it hides.
 */
export function TeamSection({
  actions,
  folded,
  onToggleFold,
  openChannelId = null,
  team,
}: {
  readonly actions: TeamSectionActions;
  readonly folded: boolean;
  readonly onToggleFold: () => void;
  readonly openChannelId?: string | null;
  readonly team: TeamSidebarView;
}) {
  const name = team.tile.name;
  const headingId = `team-${team.id}`;
  if (team.connection === "removed" || team.connection === "left") {
    return (
      <section aria-labelledby={headingId} className="team-section team-section--gone">
        <div className="team-left">
          <TeamTile tile={team.tile} />
          <div className="team-left__text">
            <h2 className="team-left__title" id={headingId}>
              {team.connection === "removed" ? `You’re no longer in ${name}` : `You left ${name}`}
            </h2>
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
      </section>
    );
  }
  const mentions = [...team.channels, ...team.dms].reduce((sum, row) => sum + row.mentions, 0);
  const unreachable = team.connection === "offline" || team.connection === "reconnecting";
  const badge =
    team.connection === "offline"
      ? "Offline"
      : team.connection === "update-app" || team.connection === "update-server"
        ? "Update"
        : null;
  return (
    <section
      aria-labelledby={headingId}
      className={["team-section", unreachable || badge ? "team-section--dim" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="team-head">
        <button
          aria-expanded={!folded}
          className="team-head__main"
          onClick={onToggleFold}
          title={folded ? `Show ${name}` : `Fold ${name}`}
          type="button"
        >
          <TeamTile tile={team.tile} />
          <h2 className="team-head__title" id={headingId}>
            {name}
          </h2>
          {badge ? (
            <span className="team-head__badge" title={badgeTitle(team.connection, name)}>
              {badge}
            </span>
          ) : null}
          {folded && mentions > 0 ? (
            <span aria-label={`${mentions} mentions`} className="mention-count">
              {mentions}
            </span>
          ) : null}
          {folded ? <Icon className="team-head__chevron" name="chevron-right" /> : null}
        </button>
        {folded ? null : <TeamMenus actions={actions} name={name} />}
      </div>
      {folded ? null : (
        <ul aria-label={`${name} channels`} className="team-rows">
          {team.channels.map((row) => (
            <ChannelRow actions={actions} key={row.id} open={row.id === openChannelId} row={row} />
          ))}
          {team.dms.length > 0 || actions.onNewMessage ? (
            <li className="team-rows__subhead">Direct messages</li>
          ) : null}
          {team.dms.map((row) => (
            <ChannelRow actions={actions} key={row.id} open={row.id === openChannelId} row={row} />
          ))}
          {team.moreDms > 0 && actions.onMoreDms ? (
            <li>
              <button className="team-rows__more" onClick={actions.onMoreDms} type="button">
                {team.moreDms} more
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function badgeTitle(connection: TeamSidebarView["connection"], name: string): string {
  if (connection === "offline") return `Can’t reach ${name} right now`;
  if (connection === "update-app") return `Update Opensteer to keep using ${name}`;
  return `${name}’s server needs an update. It updates itself; try again shortly.`;
}

function ChannelRow({
  actions,
  open,
  row,
}: {
  readonly actions: TeamSectionActions;
  readonly open: boolean;
  readonly row: ChannelRowView;
}) {
  const dm = row.kind === "dm" || row.kind === "group-dm";
  const label = [
    dm ? row.name : `${row.kind === "private" ? "Private channel" : "Channel"} ${row.name}`,
    row.peopleOnly ? "people only" : null,
    row.mentions > 0 ? `${row.mentions} ${row.mentions === 1 ? "mention" : "mentions"}` : null,
    row.unread && row.mentions === 0 ? "unread" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const href = actions.hrefFor?.(row.id);
  const go = (event: MouseEvent<HTMLElement>) => {
    if (href && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    actions.onOpenChannel(row.id);
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
}

function TeamMenus({
  actions,
  name,
}: {
  readonly actions: TeamSectionActions;
  readonly name: string;
}) {
  const [open, setOpen] = useState<"add" | "more" | null>(null);
  const add = useRef<HTMLButtonElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const item = (label: string, run: (() => void) | undefined, danger = false) =>
    run ? (
      <button
        className={danger ? "picker__row picker__row--danger" : "picker__row"}
        key={label}
        onClick={() => {
          setOpen(null);
          run();
        }}
        role="menuitem"
        type="button"
      >
        {label}
      </button>
    ) : null;
  return (
    <>
      <button
        aria-expanded={open === "add"}
        aria-haspopup="menu"
        aria-label={`Add to ${name}`}
        className="side-row-action team-head__action"
        onClick={() => setOpen(open === "add" ? null : "add")}
        ref={add}
        title="New channel, message or invite"
        type="button"
      >
        <Icon name="plus" />
      </button>
      <button
        aria-expanded={open === "more"}
        aria-haspopup="menu"
        aria-label={`${name} menu`}
        className="side-row-action team-head__action"
        onClick={() => setOpen(open === "more" ? null : "more")}
        ref={more}
        title={`${name} menu`}
        type="button"
      >
        <Icon name="more" />
      </button>
      {open === "add" && add.current ? (
        <Popover anchor={add.current} below label={`Add to ${name}`} onClose={() => setOpen(null)}>
          {item("New channel", actions.onNewChannel)}
          {item("New message", actions.onNewMessage)}
          {item("Browse channels", actions.onBrowseChannels)}
          {item("Invite people", actions.onInvite)}
        </Popover>
      ) : null}
      {open === "more" && more.current ? (
        <Popover anchor={more.current} below label={`${name} menu`} onClose={() => setOpen(null)}>
          {item("Knowledge", actions.onKnowledge)}
          {item(`Search ${name}`, actions.onSearch)}
          {item("Mark all read", actions.onMarkAllRead)}
          {item("Notifications", actions.onNotifications)}
          {item("Team settings", actions.onSettings)}
          {item(`Leave ${name}`, actions.onLeave, true)}
        </Popover>
      ) : null}
    </>
  );
}
