import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { type AgentCardActions } from "./agent-status-card.js";
import { MessageRow, type MessageActions } from "./message-row.js";
import { MessageList } from "./message-list.js";
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
  lead,
  menu = {},
  onTab,
  pane,
  tab,
}: {
  /** One line about the connection, shown only after it has lasted. */
  readonly banner?: ReactNode;
  /** The way back to the sidebar while it is a drawer or put away. */
  readonly lead?: ReactNode;
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
        <ChannelHeader channel={channel} lead={lead} menu={menu} />
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
  lead,
  menu,
}: {
  readonly channel: Channel;
  readonly lead: ReactNode;
  readonly menu: ChannelMenuActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement | null>(null);
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const other = channel.kind === "dm" ? channel.people?.[0] : undefined;
  return (
    <header className="channel__head">
      {lead}
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
          aria-label={
            channel.memberCount === null ? "Members" : plural(channel.memberCount, "member")
          }
          className={channel.faces.length > 0 ? "channel__faces" : "icon-btn"}
          onClick={menu.onOpenMembers}
          title="Members"
          type="button"
        >
          {channel.faces.length > 0 ? (
            <span aria-hidden className="face-stack face-stack--20">
              {channel.faces.slice(0, 3).map((person) => (
                <PersonAvatar key={person.id} person={person} size={20} />
              ))}
            </span>
          ) : (
            <Icon name="users" />
          )}
          {channel.memberCount === null ? null : (
            <span className="channel__count">{channel.memberCount}</span>
          )}
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
  back,
  detail,
  onClose,
  title,
}: {
  readonly action?: ReactNode;
  /** Docked beside a page, the way back to what this pane replaced. */
  readonly back?: { readonly label: string; readonly onBack: () => void } | undefined;
  readonly detail?: ReactNode;
  readonly onClose: () => void;
  readonly title: string;
}) {
  return (
    <header className="team-pane__head">
      {back ? (
        <button
          aria-label={`Back to ${back.label}`}
          className="icon-btn team-pane__back"
          onClick={back.onBack}
          title={`Back to ${back.label}`}
          type="button"
        >
          <Icon name="chevron-left" />
        </button>
      ) : null}
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
  flashId = null,
  hasOlder = false,
  onLoadOlder,
  onVisibleMessage,
  onBack,
  onClose,
  onEditingChange,
  replies,
  root,
}: {
  readonly actions?: MessageActions | undefined;
  /** Docked, the thread stands in the channel's place and ‹ goes back to it. */
  readonly onBack?: (() => void) | undefined;
  readonly cardActions?: AgentCardActions | undefined;
  readonly channel: Channel;
  readonly composer: ReactNode;
  readonly editingId?: string | null;
  readonly onClose: () => void;
  readonly onEditingChange?: ((messageId: string | null) => void) | undefined;
  readonly flashId?: string | null;
  readonly hasOlder?: boolean;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly onVisibleMessage?: ((id: string) => void) | undefined;
  readonly replies: readonly TimelineItem[];
  readonly root: MessageView;
}) {
  return (
    <div className="thread-pane">
      <PaneHeader
        back={onBack ? { label: channelLabel(channel), onBack } : undefined}
        detail={channelLabel(channel)}
        onClose={onClose}
        title="Thread"
      />
      <MessageList
        actions={actions}
        cardActions={cardActions}
        editingId={editingId}
        firstUnreadId={null}
        flashId={flashId}
        hasOlder={hasOlder}
        header={
          <>
            <div data-row-id={root.id}>
              <MessageRow
                actions={actions}
                editing={editingId === root.id}
                inThread
                message={root}
                onEditingChange={(id, editing) => onEditingChange?.(editing ? id : null)}
              />
            </div>
            <div className="thread-pane__rule" role="separator">
              <span>
                {root.thread?.replyCount
                  ? plural(root.thread.replyCount, "reply", "replies")
                  : "Replies"}
              </span>
            </div>
          </>
        }
        inThread
        items={replies}
        label="Thread replies"
        onEditingChange={onEditingChange}
        onLoadOlder={onLoadOlder}
        onVisibleMessage={onVisibleMessage}
      />
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
      {dm || !(channel.createdAt || channel.description) ? null : (
        <p className="channel-intro__meta">
          {[
            channel.createdAt
              ? `Created by ${channel.createdBy} on ${shortWhen(channel.createdAt)}`
              : null,
            channel.description || null,
          ]
            .filter(Boolean)
            .join(". ")}
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
