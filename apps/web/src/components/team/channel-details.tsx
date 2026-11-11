import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SegmentedControl } from "../segmented-control.js";
import { AgentOrb } from "../workspace/task-mark.js";
import { FolderChip, type FolderPickerProps } from "../home/folder-picker.js";
import { PaneHeader } from "./channel-view.js";
import { PersonAvatar, peopleOnlyRule } from "./team-marks.js";
import {
  channelLabel,
  plural,
  type ChannelTopicRef,
  type ChannelView,
  type MemberEntryView,
  type NotifyLevel,
} from "./team-models.js";
import { shortWhen } from "./team-time.js";

export interface ChannelDetailsActions {
  readonly onClose: () => void;
  readonly onOpenMembers: () => void;
  readonly onNotify: (level: NotifyLevel) => void;
  readonly onOpenTopic?: ((topicId: string) => void) | undefined;
  readonly onLeave?: (() => void) | undefined;
  /** Manage access only, from here down. */
  readonly onSaveAbout?:
    ((about: { readonly name: string; readonly description: string }) => void) | undefined;
  readonly onSaveInstructions?: ((text: string) => void) | undefined;
  readonly onSetPrivate?: ((isPrivate: boolean) => void) | undefined;
  readonly onSetPeopleOnly?: ((peopleOnly: boolean) => void) | undefined;
  readonly onAttachTopic?: (() => void) | undefined;
  readonly onDetachTopic?: ((topicId: string) => void) | undefined;
  readonly onArchive?: (() => void) | undefined;
}

/**
 * A channel's settings beside it. Everyone reads all of it; people with
 * manage access edit it. "Your agent here" is the one part kept on the
 * reader's own Opensteer, not on the team server.
 */
export function ChannelDetails({
  actions,
  channel,
  folder,
  notify,
  topics,
  workingAgents,
}: {
  readonly actions: ChannelDetailsActions;
  readonly channel: ChannelView;
  /** Where the reader's agent works for asks started here; null hides it (people only). */
  readonly folder: FolderPickerProps | null;
  readonly notify: NotifyLevel;
  readonly topics: readonly ChannelTopicRef[];
  /** Agents mid-run in this channel, which making it people only would stop from posting. */
  readonly workingAgents: number;
}) {
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const manage = channel.canManage;
  const [confirming, setConfirming] = useState(false);
  const setPeopleOnly = (next: boolean) => {
    if (next && workingAgents > 0) setConfirming(true);
    else actions.onSetPeopleOnly?.(next);
  };
  return (
    <div className="details-pane">
      <PaneHeader detail={channelLabel(channel)} onClose={actions.onClose} title="Details" />
      <div className="details-pane__scroll">
        {dm ? null : <About actions={actions} channel={channel} />}
        {dm ? null : <Instructions actions={actions} channel={channel} />}
        {dm ? null : (
          <DetailsBlock title="Access">
            <div className="details-row">
              <SegmentedControl
                ariaLabel="Who can find it"
                disabled={!manage || !actions.onSetPrivate}
                onChange={(value) => actions.onSetPrivate?.(value === "private")}
                options={[
                  { label: "Public", value: "public" },
                  { label: "Private", value: "private" },
                ]}
                value={channel.kind === "private" ? "private" : "public"}
              />
              <span className="details-note">
                {channel.kind === "private"
                  ? "Only members can find and read it."
                  : "Anyone in the team can find and join it."}
              </span>
            </div>
            <div className="details-switch">
              <span className="details-switch__text">
                <span className="details-switch__title">People only</span>
                <span className="details-note">
                  {channel.peopleOnly
                    ? "On: no agent can be woken, read, search or open files here."
                    : "Off: members’ agents can read and post here when their owner asks."}
                </span>
              </span>
              <input
                aria-label="People only"
                checked={channel.peopleOnly}
                className="switch"
                disabled={!manage || !actions.onSetPeopleOnly}
                onChange={(event) => setPeopleOnly(event.currentTarget.checked)}
                role="switch"
                title={peopleOnlyRule}
                type="checkbox"
              />
            </div>
          </DetailsBlock>
        )}
        {dm ? null : (
          <DetailsBlock
            action={
              manage && actions.onAttachTopic ? (
                <button className="details-link" onClick={actions.onAttachTopic} type="button">
                  Attach a topic
                </button>
              ) : null
            }
            title="Knowledge"
          >
            <ul className="details-list">
              {topics.map((topic) => (
                <li className="details-list__row" key={topic.id}>
                  <button
                    className="details-list__main"
                    onClick={() => actions.onOpenTopic?.(topic.id)}
                    type="button"
                  >
                    <Icon name={topic.kind === "channel" ? "hash" : "table"} />
                    <span className="details-list__text">
                      <span className="details-list__name">{topic.name}</span>
                      <span className="details-note">{topic.detail}</span>
                    </span>
                  </button>
                  {manage && topic.kind === "shared" && actions.onDetachTopic ? (
                    <button
                      className="details-link"
                      onClick={() => actions.onDetachTopic?.(topic.id)}
                      type="button"
                    >
                      Detach
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </DetailsBlock>
        )}
        {folder ? (
          <DetailsBlock
            action={
              <span className="details-tag">
                <Icon name="laptop" />
                On your Opensteer
              </span>
            }
            icon={<AgentOrb size={16} />}
            title="Your agent here"
          >
            <div className="details-row details-row--spread">
              <span className="details-note">
                When you ask your agent in {channelLabel(channel)}, it works in
              </span>
              <FolderChip {...folder} />
            </div>
            <p className="details-note">Changing it affects new asks only.</p>
          </DetailsBlock>
        ) : null}
        <DetailsBlock title="Notify me about">
          <SegmentedControl
            ariaLabel="Notify me about"
            onChange={actions.onNotify}
            options={[
              { label: "Everything", value: "everything" },
              { label: "Mentions", value: "mentions" },
              { label: "Nothing", value: "nothing" },
            ]}
            value={notify}
          />
        </DetailsBlock>
        <div className="details-footer">
          {dm ? null : (
            <button className="btn btn--small" onClick={actions.onOpenMembers} type="button">
              <Icon name="users" />
              {plural(channel.memberCount, "member")}
            </button>
          )}
          {actions.onLeave ? (
            <button className="btn btn--small btn--danger" onClick={actions.onLeave} type="button">
              {dm ? "Leave conversation" : `Leave ${channelLabel(channel)}`}
            </button>
          ) : null}
          {manage && actions.onArchive ? (
            <button className="btn btn--small btn--ghost" onClick={actions.onArchive} type="button">
              Archive
            </button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <PeopleOnlyConfirm
          channelName={channelLabel(channel)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            actions.onSetPeopleOnly?.(true);
          }}
          workingAgents={workingAgents}
        />
      ) : null}
    </div>
  );
}

function DetailsBlock({
  action,
  children,
  icon,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly title: string;
}) {
  return (
    <section className="details-block">
      <header className="details-block__head">
        <h3 className="details-block__title">
          {icon}
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function About({
  actions,
  channel,
}: {
  readonly actions: ChannelDetailsActions;
  readonly channel: ChannelView;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description);
  const editable = channel.canManage && actions.onSaveAbout;
  return (
    <DetailsBlock
      action={
        editable && !editing ? (
          <button className="details-link" onClick={() => setEditing(true)} type="button">
            Edit
          </button>
        ) : null
      }
      title="About"
    >
      {editing ? (
        <form
          className="details-form"
          onSubmit={(event) => {
            event.preventDefault();
            actions.onSaveAbout?.({ name: name.trim(), description: description.trim() });
            setEditing(false);
          }}
        >
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="text-input"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <label className="field">
            <span className="field__label">What it’s for</span>
            <input
              className="text-input"
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </label>
          <div className="details-form__actions">
            <button
              className="btn btn--small btn--ghost"
              onClick={() => setEditing(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="btn btn--small btn--primary" disabled={!name.trim()} type="submit">
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="details-text">{channel.description || "No description yet."}</p>
      )}
    </DetailsBlock>
  );
}

/**
 * Configuration, not memory: added to every agent run started in this
 * channel. People with manage access edit it; agents never change it.
 */
function Instructions({
  actions,
  channel,
}: {
  readonly actions: ChannelDetailsActions;
  readonly channel: ChannelView;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(channel.instructions?.text ?? "");
  const editable = channel.canManage && actions.onSaveInstructions;
  const last = channel.instructions;
  return (
    <DetailsBlock
      action={
        editable && !editing ? (
          <button className="details-link" onClick={() => setEditing(true)} type="button">
            Edit
          </button>
        ) : !editable ? (
          <span className="details-quiet">Managers edit</span>
        ) : null
      }
      icon={<Icon name="sparkles" />}
      title="Instructions for agents"
    >
      {editing ? (
        <form
          className="details-form"
          onSubmit={(event) => {
            event.preventDefault();
            actions.onSaveInstructions?.(text.trim());
            setEditing(false);
          }}
        >
          <textarea
            aria-label="Instructions for agents"
            autoFocus
            className="text-input details-instructions__field"
            onChange={(event) => setText(event.target.value)}
            placeholder="Be brief. Cite the order number."
            rows={5}
            value={text}
          />
          <div className="details-form__actions">
            <button
              className="btn btn--small btn--ghost"
              onClick={() => setEditing(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="btn btn--small btn--primary" type="submit">
              Save
            </button>
          </div>
        </form>
      ) : last ? (
        <p className="details-instructions">{last.text}</p>
      ) : (
        <p className="details-text details-text--quiet">
          None yet.{editable ? " Add what every agent asked here should know." : ""}
        </p>
      )}
      <p className="details-note">
        Added to every agent run started in {channelLabel(channel)}. Everyone here can read them.
        {last ? ` Last changed by ${last.changedBy}, ${shortWhen(last.changedAt)}.` : ""}
      </p>
    </DetailsBlock>
  );
}

/** Making a channel people only while agents work here ends their runs without a post. */
export function PeopleOnlyConfirm({
  channelName,
  onCancel,
  onConfirm,
  workingAgents,
}: {
  readonly channelName: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly workingAgents: number;
}) {
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" onClick={onConfirm} type="button">
            Make people only
          </button>
        </>
      }
      labelledBy="people-only-confirm"
      onClose={onCancel}
      title={`Make ${channelName} people only?`}
    >
      <p className="team-dialog__text">
        {workingAgents === 1 ? "1 agent is" : `${workingAgents} agents are`} working here. They
        won’t be able to post their replies; their cards will say so. Their owners keep what they
        did in their own tasks.
      </p>
      <p className="team-dialog__text team-dialog__text--quiet">
        Members see one line in the channel. No agent can be woken, read, search or open files here
        until you turn it off.
      </p>
    </Dialog>
  );
}

export interface MembersActions {
  readonly onClose: () => void;
  /** People or groups; for a group DM, people, who then see its history. */
  readonly onAdd?: (() => void) | undefined;
  readonly onRemove?: ((entryId: string) => void) | undefined;
  readonly onSetManager?: ((entryId: string, manager: boolean) => void) | undefined;
}

/**
 * Who is in a channel: people and groups, with their role. A group counts as
 * every person in it, including people added to the group later. Removing
 * someone closes their live views at once.
 */
export function MembersPane({
  actions,
  canManage,
  channel,
  members,
}: {
  readonly actions: MembersActions;
  readonly canManage: boolean;
  readonly channel: ChannelView;
  readonly members: readonly MemberEntryView[];
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = members.filter((entry) =>
    needle === ""
      ? true
      : entry.kind === "person"
        ? entry.person.name.toLowerCase().includes(needle) ||
          entry.person.handle.toLowerCase().includes(needle)
        : entry.name.toLowerCase().includes(needle),
  );
  const groups = members.filter((entry) => entry.kind === "group");
  return (
    <div className="details-pane">
      <PaneHeader
        action={
          actions.onAdd ? (
            <button className="btn btn--small" onClick={actions.onAdd} type="button">
              Add people
            </button>
          ) : null
        }
        detail={String(channel.memberCount)}
        onClose={actions.onClose}
        title="Members"
      />
      <div className="details-pane__scroll">
        <label className="team-search-field">
          <Icon name="search" />
          <input
            aria-label="Find a member"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a member"
            value={query}
          />
        </label>
        <ul className="member-list">
          {shown.map((entry) => (
            <MemberRow
              actions={actions}
              canManage={canManage}
              entry={entry}
              key={entry.kind === "person" ? entry.person.id : entry.id}
            />
          ))}
        </ul>
        {groups.length > 0 ? (
          <p className="details-note">
            Groups count as members: everyone in{" "}
            {groups.map((group) => (group.kind === "group" ? group.name : "")).join(", ")} is in{" "}
            {channelLabel(channel)}, including people added to the group later.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MemberRow({
  actions,
  canManage,
  entry,
}: {
  readonly actions: MembersActions;
  readonly canManage: boolean;
  readonly entry: MemberEntryView;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const id = entry.kind === "person" ? entry.person.id : entry.id;
  const name = entry.kind === "person" ? entry.person.name : entry.name;
  return (
    <li className="member">
      {entry.kind === "person" ? (
        <PersonAvatar person={entry.person} presence size={28} />
      ) : (
        <span aria-hidden className="member__group">
          <Icon name="users" />
        </span>
      )}
      <span className="member__text">
        <span className="member__name">
          {name}
          {entry.kind === "person" && entry.person.you ? " (you)" : ""}
        </span>
        <span className="member__detail">
          {entry.kind === "person"
            ? `@${entry.person.handle}`
            : `Group · ${plural(entry.peopleCount, "person", "people")}`}
        </span>
      </span>
      <span className="member__role">{entry.manager ? "Manager" : "Member"}</span>
      {canManage && (actions.onRemove || actions.onSetManager) ? (
        <button
          aria-expanded={menu}
          aria-haspopup="menu"
          aria-label={`${name} options`}
          className="icon-btn icon-btn--small"
          onClick={() => setMenu((value) => !value)}
          ref={anchor}
          type="button"
        >
          <Icon name="more" />
        </button>
      ) : null}
      {menu && anchor.current ? (
        <Popover
          align="end"
          anchor={anchor.current}
          below
          label={name}
          onClose={() => setMenu(false)}
        >
          {actions.onSetManager ? (
            <button
              className="picker__row"
              onClick={() => {
                setMenu(false);
                actions.onSetManager?.(id, !entry.manager);
              }}
              role="menuitem"
              type="button"
            >
              {entry.manager ? "Make member" : "Make manager"}
            </button>
          ) : null}
          {actions.onRemove ? (
            <button
              className="picker__row picker__row--danger"
              onClick={() => {
                setMenu(false);
                actions.onRemove?.(id);
              }}
              role="menuitem"
              type="button"
            >
              Remove from channel
            </button>
          ) : null}
        </Popover>
      ) : null}
    </li>
  );
}
