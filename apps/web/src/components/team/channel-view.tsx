import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { AgentCardRow, type AgentCardActions } from "./agent-status-card.js";
import { MessageRow, type MessageActions } from "./message-row.js";
import { joins, itemId, SystemRow } from "./message-list.js";
import { ChannelGlyph, PeopleOnlyBadge, PersonAvatar } from "./team-marks.js";
import {
  channelLabel,
  plural,
  type ChannelTab,
  type ChannelView as Channel,
  type MessageView,
  type TimelineItem,
} from "./team-models.js";
import { shortWhen } from "./team-time.js";

export interface ChannelMenuActions {
  readonly onOpenDetails?: (() => void) | undefined;
  readonly onOpenMembers?: (() => void) | undefined;
  readonly onSearch?: (() => void) | undefined;
  readonly onMarkRead?: (() => void) | undefined;
  readonly onCopyLink?: (() => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
}

/**
 * A channel or DM: its header, its tabs, the tab's body, and at most one pane
 * beside it (a thread, Details or Members). Below 1100px the pane covers the
 * channel instead of sitting beside it.
 */
export function ChannelScreen({
  banner,
  channel,
  children,
  menu = {},
  onTab,
  pane,
  tab,
}: {
  /** One line about the connection, shown only after it has lasted. */
  readonly banner?: ReactNode;
  readonly channel: Channel;
  readonly children: ReactNode;
  readonly menu?: ChannelMenuActions | undefined;
  readonly onTab: (tab: ChannelTab) => void;
  readonly pane?: ReactNode;
  readonly tab: ChannelTab;
}) {
  return (
    <div className={pane ? "team-view team-view--pane" : "team-view"}>
      <section aria-label={channelLabel(channel)} className="channel">
        <ChannelHeader channel={channel} menu={menu} />
        <ChannelTabs channel={channel} onTab={onTab} tab={tab} />
        {banner}
        <div className="channel__body" role="tabpanel">
          {children}
        </div>
      </section>
      {pane ? <aside className="team-pane">{pane}</aside> : null}
    </div>
  );
}

function ChannelHeader({
  channel,
  menu,
}: {
  readonly channel: Channel;
  readonly menu: ChannelMenuActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement | null>(null);
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const other = channel.kind === "dm" ? channel.people?.[0] : undefined;
  return (
    <header className="channel__head">
      <button
        aria-label={`${channelLabel(channel)} details`}
        className="channel__name"
        onClick={menu.onOpenDetails}
        title="Details"
        type="button"
      >
        <ChannelGlyph kind={channel.kind} people={channel.people} />
        <span className="channel__title">{channel.name}</span>
        <Icon className="channel__chevron" name="chevron-down" />
      </button>
      {channel.peopleOnly ? <PeopleOnlyBadge /> : null}
      <span className="channel__description">
        {other ? (other.presence === "active" ? "Active" : "Away") : channel.description}
      </span>
      {dm ? null : (
        <button
          aria-label={`${plural(channel.memberCount, "member")}`}
          className="channel__faces"
          onClick={menu.onOpenMembers}
          title="Members"
          type="button"
        >
          <span aria-hidden className="face-stack face-stack--20">
            {channel.faces.slice(0, 3).map((person) => (
              <PersonAvatar key={person.id} person={person} size={20} />
            ))}
          </span>
          <span className="channel__count">{channel.memberCount}</span>
        </button>
      )}
      {menu.onSearch ? (
        <button
          aria-label={`Search ${channelLabel(channel)}`}
          className="icon-btn"
          onClick={menu.onSearch}
          title={`Search ${channelLabel(channel)} · ⌘F`}
          type="button"
        >
          <Icon name="search" />
        </button>
      ) : null}
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label="More"
        className="icon-btn"
        onClick={() => setMenuOpen((open) => !open)}
        ref={more}
        title="More"
        type="button"
      >
        <Icon name="more" />
      </button>
      {menuOpen && more.current ? (
        <Popover
          align="end"
          anchor={more.current}
          below
          label="Channel"
          onClose={() => setMenuOpen(false)}
        >
          {(
            [
              ["Details", menu.onOpenDetails],
              ["Mark read", menu.onMarkRead],
              ["Copy link", menu.onCopyLink],
              [dm ? "Leave conversation" : `Leave ${channelLabel(channel)}`, menu.onLeave],
            ] as const
          ).map(([label, run]) =>
            run ? (
              <button
                className={
                  label.startsWith("Leave") ? "picker__row picker__row--danger" : "picker__row"
                }
                key={label}
                onClick={() => {
                  setMenuOpen(false);
                  run();
                }}
                role="menuitem"
                type="button"
              >
                {label}
              </button>
            ) : null,
          )}
        </Popover>
      ) : null}
    </header>
  );
}

function ChannelTabs({
  channel,
  onTab,
  tab,
}: {
  readonly channel: Channel;
  readonly onTab: (tab: ChannelTab) => void;
  readonly tab: ChannelTab;
}) {
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const tabs: readonly (readonly [ChannelTab, string, number | null])[] = [
    ["messages", "Messages", null],
    ["files", "Files", channel.fileCount],
    ["pinned", "Pinned", channel.pinCount],
    ...(dm ? [] : ([["knowledge", "Knowledge", null]] as const)),
  ];
  return (
    <div aria-label="Channel" className="channel__tabs" role="tablist">
      {tabs.map(([value, label, count]) => (
        <button
          aria-selected={tab === value}
          className="channel__tab"
          key={value}
          onClick={() => onTab(value)}
          role="tab"
          type="button"
        >
          {label}
          {count ? <span className="channel__tab-count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** The Messages tab: the timeline over its composer. */
export function ChannelMessages({
  composer,
  list,
}: {
  readonly composer: ReactNode;
  readonly list: ReactNode;
}) {
  return (
    <div className="channel__messages">
      {list}
      <div className="channel__composer">{composer}</div>
    </div>
  );
}

/** A pane's head: what it is, where, and the way to close it. */
export function PaneHeader({
  action,
  detail,
  onClose,
  title,
}: {
  readonly action?: ReactNode;
  readonly detail?: ReactNode;
  readonly onClose: () => void;
  readonly title: string;
}) {
  return (
    <header className="team-pane__head">
      <h2 className="team-pane__title">
        {title}
        {detail ? <span className="team-pane__detail">{detail}</span> : null}
      </h2>
      {action}
      <button
        aria-label={`Close ${title.toLowerCase()}`}
        className="icon-btn"
        onClick={onClose}
        title="Close · Esc"
        type="button"
      >
        <Icon name="close" />
      </button>
    </header>
  );
}

/**
 * A thread beside its channel: the root, a rule with the count, the replies
 * (agents' status cards among them) and a composer. One level: replies have
 * no replies. Esc closes it.
 */
export function ThreadPane({
  actions,
  cardActions,
  channel,
  composer,
  editingId = null,
  onClose,
  onEditingChange,
  replies,
  root,
}: {
  readonly actions?: MessageActions | undefined;
  readonly cardActions?: AgentCardActions | undefined;
  readonly channel: Channel;
  readonly composer: ReactNode;
  readonly editingId?: string | null;
  readonly onClose: () => void;
  readonly onEditingChange?: ((messageId: string | null) => void) | undefined;
  readonly replies: readonly TimelineItem[];
  readonly root: MessageView;
}) {
  const replyCount = replies.filter((item) => item.kind === "message").length;
  const scroller = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  // Opens at the newest reply, and follows new ones only while the reader is there.
  useLayoutEffect(() => {
    const list = scroller.current;
    if (list && atEnd.current) list.scrollTop = list.scrollHeight;
  }, [replies]);
  return (
    <div
      className="thread-pane"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <PaneHeader detail={channelLabel(channel)} onClose={onClose} title="Thread" />
      <div
        aria-label="Thread"
        className="thread-pane__scroll"
        onScroll={(event) => {
          const list = event.currentTarget;
          atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        }}
        ref={scroller}
        role="log"
      >
        <MessageRow
          actions={actions}
          editing={editingId === root.id}
          inThread
          message={root}
          onEditingChange={(editing) => onEditingChange?.(editing ? root.id : null)}
        />
        <div className="thread-pane__rule" role="separator">
          <span>{replyCount > 0 ? plural(replyCount, "reply", "replies") : "No replies yet"}</span>
        </div>
        {replies.map((item, index) => {
          const id = itemId(item);
          return (
            <div className="tlist__row" data-row-id={id} key={id}>
              {item.kind === "message" ? (
                <MessageRow
                  actions={actions}
                  editing={editingId === id}
                  grouped={joins(replies[index - 1], item.message)}
                  inThread
                  message={item.message}
                  onEditingChange={(editing) => onEditingChange?.(editing ? id : null)}
                />
              ) : item.kind === "card" ? (
                <AgentCardRow actions={cardActions} request={item.request} />
              ) : (
                <SystemRow at={item.at} icon={item.icon} text={item.text} />
              )}
            </div>
          );
        })}
      </div>
      <div className="thread-pane__composer">{composer}</div>
    </div>
  );
}

/** The start of a channel: what it is for, and the instructions every agent run here gets. */
export function ChannelIntro({ channel }: { readonly channel: Channel }) {
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  return (
    <div className="channel-intro">
      <h2 className="channel-intro__title">
        {dm
          ? `This is the start of your conversation with ${channel.name}`
          : `This is the start of ${channelLabel(channel)}`}
      </h2>
      {dm ? null : (
        <p className="channel-intro__meta">
          Created by {channel.createdBy} on {shortWhen(channel.createdAt)}
          {channel.description ? `. ${channel.description}` : ""}
        </p>
      )}
      {channel.peopleOnly ? (
        <p className="channel-intro__note">
          <PeopleOnlyBadge /> Agents can’t be asked, read or search here.
        </p>
      ) : channel.instructions ? (
        <p className="channel-intro__instructions">
          <Icon name="sparkles" />
          <span>
            <b>Instructions for agents:</b> {channel.instructions.text}
          </span>
        </p>
      ) : null}
    </div>
  );
}
