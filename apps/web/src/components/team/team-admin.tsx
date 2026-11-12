import { useRef, useState } from "react";
import { QrCode } from "../first-run/qr-code.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SegmentedControl } from "../segmented-control.js";
import {
  SectionHeader,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
} from "../settings/primitives.js";
import { PersonAvatar, TeamTile } from "./team-marks.js";
import {
  firstName,
  plural,
  type NotifyLevel,
  type PersonView,
  type TeamTileView,
} from "./team-models.js";
import { age, shortDate } from "./team-time.js";

export type TeamRole = "owner" | "admin" | "member";

const roleWords: Readonly<Record<TeamRole, string>> = {
  admin: "Admin",
  member: "Member",
  owner: "Owner",
};

/* ---- People ---- */

export interface MemberAdminView {
  readonly person: PersonView;
  readonly email: string | null;
  readonly role: TeamRole;
  readonly groups: readonly string[];
  readonly lastActiveAt: string | null;
  readonly deactivated: boolean;
}

export interface PeopleAdminActions {
  readonly onInvite: () => void;
  readonly onSetRole: (personId: string, role: TeamRole) => void;
  readonly onAddToGroup: (personId: string) => void;
  readonly onDeactivate: (personId: string) => void;
  readonly onReactivate: (personId: string) => void;
}

/**
 * Everyone in the team, for its admins. Deactivating someone takes them out
 * of every channel and topic at once and cuts their link; their messages
 * stay, under their name. Admins manage lists; they never reach anyone's own
 * Opensteer or computer.
 */
export function PeopleAdmin({
  actions,
  people,
  team,
}: {
  readonly actions: PeopleAdminActions;
  readonly people: readonly MemberAdminView[];
  readonly team: TeamTileView;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<"active" | "deactivated">("active");
  const [confirm, setConfirm] = useState<MemberAdminView | null>(null);
  const active = people.filter((entry) => !entry.deactivated);
  const needle = query.trim().toLowerCase();
  const rows = people.filter(
    (entry) =>
      entry.deactivated === (shown === "deactivated") &&
      (needle === "" ||
        entry.person.name.toLowerCase().includes(needle) ||
        entry.person.handle.toLowerCase().includes(needle) ||
        (entry.email ?? "").toLowerCase().includes(needle)),
  );
  return (
    <div className="team-admin">
      <SectionHeader
        action={
          <button className="btn btn--small btn--primary" onClick={actions.onInvite} type="button">
            <Icon name="plus" />
            Invite people
          </button>
        }
        lead={`${plural(active.length, "person", "people")} in ${team.name}`}
        title="People"
      />
      <div className="team-admin__toolbar">
        <label className="team-search-field">
          <Icon name="search" />
          <input
            aria-label="Find people"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find people"
            value={query}
          />
        </label>
        <SegmentedControl
          ariaLabel="Which people"
          onChange={setShown}
          options={[
            { label: "Active", value: "active" },
            { label: "Deactivated", value: "deactivated" },
          ]}
          value={shown}
        />
      </div>
      {rows.length === 0 ? (
        <p className="channel-tab__empty">
          {shown === "deactivated" ? "Nobody is deactivated." : "Nobody matches."}
        </p>
      ) : (
        <table className="team-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Groups</th>
              <th scope="col">Last active</th>
              <th aria-label="Actions" scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.person.id}>
                <td>
                  <span className="team-table__person">
                    <PersonAvatar person={entry.person} size={24} />
                    <span>
                      <span className="team-table__strong">
                        {entry.person.name}
                        {entry.person.you ? " (you)" : ""}
                      </span>
                      <span className="team-table__quiet">
                        @{entry.person.handle}
                        {entry.email ? ` · ${entry.email}` : ""}
                      </span>
                    </span>
                  </span>
                </td>
                <td>{roleWords[entry.role]}</td>
                <td className="team-table__soft">{entry.groups.join(", ") || "—"}</td>
                <td className="team-table__soft">
                  {entry.lastActiveAt ? age(entry.lastActiveAt) : "—"}
                </td>
                <td className="team-table__end">
                  {entry.deactivated ? (
                    <button
                      className="btn btn--small"
                      onClick={() => actions.onReactivate(entry.person.id)}
                      type="button"
                    >
                      Reactivate
                    </button>
                  ) : entry.person.you ? null : (
                    <PersonMenu actions={actions} entry={entry} onDeactivate={setConfirm} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirm ? (
        <Dialog
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirm(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  actions.onDeactivate(confirm.person.id);
                  setConfirm(null);
                }}
                type="button"
              >
                Deactivate
              </button>
            </>
          }
          labelledBy="deactivate-title"
          onClose={() => setConfirm(null)}
          title={`Deactivate ${confirm.person.name}?`}
        >
          <p className="team-dialog__text">
            {firstName(confirm.person)} leaves every channel and topic in {team.name} now, and their
            Opensteer’s link to {team.name} is cut. Their messages stay, under their name. What
            already reached their computer stays there.
          </p>
          <p className="team-dialog__text team-dialog__text--quiet">
            You can reactivate them later from Deactivated.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function PersonMenu({
  actions,
  entry,
  onDeactivate,
}: {
  readonly actions: PeopleAdminActions;
  readonly entry: MemberAdminView;
  readonly onDeactivate: (entry: MemberAdminView) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const item = (label: string, run: () => void, danger = false) => (
    <button
      className={danger ? "picker__row picker__row--danger" : "picker__row"}
      key={label}
      onClick={() => {
        setOpen(false);
        run();
      }}
      role="menuitem"
      type="button"
    >
      {label}
    </button>
  );
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${entry.person.name} options`}
        className="icon-btn icon-btn--small"
        onClick={() => setOpen((value) => !value)}
        ref={anchor}
        type="button"
      >
        <Icon name="more" />
      </button>
      {open && anchor.current ? (
        <Popover
          align="end"
          anchor={anchor.current}
          below
          label={entry.person.name}
          onClose={() => setOpen(false)}
        >
          {(["owner", "admin", "member"] as const)
            .filter((role) => role !== entry.role)
            .map((role) =>
              item(`Make ${roleWords[role].toLowerCase()}`, () =>
                actions.onSetRole(entry.person.id, role),
              ),
            )}
          {item("Add to group…", () => actions.onAddToGroup(entry.person.id))}
          {item("Deactivate…", () => onDeactivate(entry), true)}
        </Popover>
      ) : null}
    </>
  );
}

/* ---- Groups ---- */

export interface GroupSummaryView {
  readonly id: string;
  readonly name: string;
  readonly peopleCount: number;
}

export interface GroupDetailView extends GroupSummaryView {
  /** The groups this one sits inside. */
  readonly parents: readonly string[];
  readonly members: readonly (
    | { readonly kind: "person"; readonly person: PersonView }
    | { readonly kind: "group"; readonly group: GroupSummaryView }
  )[];
  /** What adding someone here gives them: every channel and topic that lists this group. */
  readonly usedBy: readonly {
    readonly kind: "channel" | "topic";
    readonly name: string;
    readonly level: string;
  }[];
}

export interface GroupsAdminActions {
  readonly onSelect: (groupId: string) => void;
  readonly onCreate: () => void;
  readonly onRename: (groupId: string) => void;
  readonly onDelete: (groupId: string) => void;
  readonly onAddMembers: (groupId: string) => void;
  readonly onRemoveMember: (groupId: string, memberId: string) => void;
}

/**
 * Groups nest: a channel or topic that lists a group includes everyone in it
 * and in its subgroups, now and later. "Used by" answers what adding someone
 * here gives them before anyone has to ask.
 */
export function GroupsAdmin({
  actions,
  groups,
  selected,
}: {
  readonly actions: GroupsAdminActions;
  readonly groups: readonly GroupSummaryView[];
  readonly selected: GroupDetailView | null;
}) {
  return (
    <div className="team-admin">
      <SectionHeader
        action={
          <button className="btn btn--small" onClick={actions.onCreate} type="button">
            <Icon name="plus" />
            New group
          </button>
        }
        lead="Add a group to a channel or topic and everyone in it, now and later, is on the list."
        title="Groups"
      />
      <div className="groups-admin">
        <ul aria-label="Groups" className="groups-admin__list">
          {groups.map((group) => (
            <li key={group.id}>
              <button
                aria-current={group.id === selected?.id ? "true" : undefined}
                className="groups-admin__group"
                onClick={() => actions.onSelect(group.id)}
                type="button"
              >
                <Icon name="users" />
                <span className="groups-admin__name">{group.name}</span>
                <span className="groups-admin__count">{group.peopleCount}</span>
              </button>
            </li>
          ))}
        </ul>
        {selected ? (
          <section className="group-detail">
            <header className="group-detail__head">
              <div>
                <h2 className="group-detail__title">{selected.name}</h2>
                <p className="group-detail__meta">
                  {plural(selected.peopleCount, "person", "people")}
                  {selected.parents.length > 0 ? ` · inside ${selected.parents.join(", ")}` : ""}
                </p>
              </div>
              <button
                className="btn btn--small"
                onClick={() => actions.onRename(selected.id)}
                type="button"
              >
                Rename
              </button>
              <button
                className="btn btn--small btn--danger"
                onClick={() => actions.onDelete(selected.id)}
                type="button"
              >
                Delete
              </button>
            </header>
            <SettingsGroup heading="In this group" headingId="group-members">
              {selected.members.map((member) =>
                member.kind === "person" ? (
                  <SettingsRow
                    action={
                      <button
                        className="btn btn--small btn--ghost"
                        onClick={() => actions.onRemoveMember(selected.id, member.person.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    }
                    key={member.person.id}
                    title={
                      <>
                        <PersonAvatar person={member.person} size={20} />
                        {member.person.name}
                      </>
                    }
                  />
                ) : (
                  <SettingsRow
                    action={
                      <button
                        className="btn btn--small btn--ghost"
                        onClick={() => actions.onRemoveMember(selected.id, member.group.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    }
                    detail={`Group · ${plural(member.group.peopleCount, "person", "people")}`}
                    key={member.group.id}
                    title={member.group.name}
                  />
                ),
              )}
              <div className="card__row">
                <button
                  className="btn btn--small"
                  onClick={() => actions.onAddMembers(selected.id)}
                  type="button"
                >
                  <Icon name="plus" />
                  Add people or groups
                </button>
              </div>
            </SettingsGroup>
            <section className="settings-group">
              <h2 className="settings-group__title">Used by</h2>
              {selected.usedBy.length === 0 ? (
                <p className="settings-footnote">No channel or topic lists this group yet.</p>
              ) : (
                <ul className="used-by">
                  {selected.usedBy.map((use) => (
                    <li className="used-by__chip" key={`${use.kind}:${use.name}`}>
                      <Icon name={use.kind === "channel" ? "hash" : "table"} />
                      {use.name} · {use.level}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>
        ) : (
          <p className="channel-tab__empty">Choose a group to see who’s in it.</p>
        )}
      </div>
    </div>
  );
}

/* ---- Invites ---- */

export interface InviteLinkView {
  readonly enabled: boolean;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * The team's invite link: on or off, copy, a code for phones, and a new link
 * that revokes the old one. Everyone it admits joins as a member.
 */
export function InvitesAdmin({
  copied = false,
  invite,
  onCopy,
  onNewLink,
  onToggle,
}: {
  readonly copied?: boolean;
  readonly invite: InviteLinkView;
  readonly onCopy: () => void;
  readonly onNewLink: () => void;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const [qr, setQr] = useState(false);
  return (
    <div className="team-admin">
      <SectionHeader
        lead="People join with their own Opensteer Account and bring their own agent."
        title="Invites"
      />
      <SettingsGroup
        heading={null}
        headingId="invite-link"
        note="A new link stops the old one working before anyone else signs in with it."
      >
        <SettingsRow
          action={
            <SettingsSwitch checked={invite.enabled} label="Invite link" onChange={onToggle} />
          }
          detail="One person can join with it, as a member."
          title="Invite link"
        />
        {invite.enabled ? (
          <div className="card__row invite-admin">
            <div className="invite-link__row">
              <span className="invite-link__url">
                <Icon name="link" />
                <span>{invite.url}</span>
              </span>
              <button className="btn btn--small" onClick={onCopy} type="button">
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                aria-expanded={qr}
                aria-label="Show a code for phones"
                className="icon-btn icon-btn--small"
                onClick={() => setQr((value) => !value)}
                title="Code for phones"
                type="button"
              >
                <Icon name="phone" />
              </button>
            </div>
            {qr ? <QrCode label="Invite link" value={invite.url} /> : null}
            <div className="invite-admin__foot">
              <button className="btn btn--small" onClick={onNewLink} type="button">
                <Icon name="reload" />
                New link
              </button>
              <span className="invite-admin__facts">Expires {shortDate(invite.expiresAt)}</span>
            </div>
          </div>
        ) : null}
      </SettingsGroup>
    </div>
  );
}

/* ---- Team settings ---- */

export interface TeamSettingsActions {
  readonly onRename: (name: string) => void;
  readonly onChangePhoto: () => void;
  readonly onNotify: (kind: "channels" | "dms", level: NotifyLevel) => void;
  readonly onLeave: () => void;
  /** Admins only. */
  readonly onTeamName?: ((name: string) => void) | undefined;
  readonly onTeamColor?: ((color: string) => void) | undefined;
}

/**
 * A team's group in Settings for everyone: your profile here (your handle is
 * fixed, and your agent's follows it), notification defaults, what the team
 * can see, and leaving. Admins also name the team.
 */
export function TeamSettings({
  actions,
  admin,
  me,
  notify,
  team,
  tileColors,
  webAddress,
}: {
  readonly actions: TeamSettingsActions;
  readonly admin: boolean;
  readonly me: PersonView;
  readonly notify: { readonly channels: NotifyLevel; readonly dms: NotifyLevel };
  readonly team: TeamTileView;
  readonly tileColors: readonly string[];
  readonly webAddress: string;
}) {
  const [leaving, setLeaving] = useState(false);
  const notifyOptions = [
    { label: "Everything", value: "everything" },
    { label: "Mentions", value: "mentions" },
    { label: "Nothing", value: "nothing" },
  ] as const;
  return (
    <div className="team-admin">
      <SectionHeader
        lead={`How you appear and what reaches you from ${team.name}.`}
        title={team.name}
      />
      <SettingsGroup heading="Your profile" headingId="team-profile">
        <SettingsRow
          action={
            <button className="btn btn--small" onClick={actions.onChangePhoto} type="button">
              Change photo
            </button>
          }
          title={
            <>
              <PersonAvatar person={me} size={20} />
              <NameField name={me.name} onSave={actions.onRename} />
            </>
          }
        />
        <SettingsRow
          detail={`Your agent is @${me.handle}-agent. Handles are given when you join and don’t change.`}
          title={`@${me.handle}`}
        />
      </SettingsGroup>
      <SettingsGroup heading="Notify me about" headingId="team-notify">
        <SettingsRow
          action={
            <SegmentedControl
              ariaLabel="Channels"
              onChange={(level) => actions.onNotify("channels", level)}
              options={notifyOptions}
              value={notify.channels}
            />
          }
          detail="A channel can change this in its Details."
          title="Channels"
        />
        <SettingsRow
          action={
            <SegmentedControl
              ariaLabel="Direct messages"
              onChange={(level) => actions.onNotify("dms", level)}
              options={notifyOptions}
              value={notify.dms}
            />
          }
          title="Direct messages"
        />
      </SettingsGroup>
      <SettingsGroup
        heading="About this team"
        headingId="team-about"
        note={`Admins can see what agents read, searched and posted in ${team.name}. Never anyone’s private task.`}
      >
        <SettingsRow detail={webAddress} title="Web address" />
        <SettingsRow detail="Opensteer Account" title="Sign-in" />
      </SettingsGroup>
      {admin ? (
        <SettingsGroup heading="Team" headingId="team-team">
          <SettingsRow
            title={
              <>
                <TeamTile size={20} tile={team} />
                {actions.onTeamName ? (
                  <NameField name={team.name} onSave={actions.onTeamName} />
                ) : (
                  team.name
                )}
              </>
            }
          />
          {actions.onTeamColor ? (
            <div className="card__row">
              <span className="card__row-body">
                <span className="card__row-title">Colour</span>
              </span>
              <span className="tile-colors" role="radiogroup" aria-label="Team colour">
                {tileColors.map((color) => (
                  <button
                    aria-checked={color === team.color}
                    aria-label={color}
                    className="tile-colors__swatch"
                    key={color}
                    onClick={() => actions.onTeamColor?.(color)}
                    role="radio"
                    style={{ background: color }}
                    type="button"
                  />
                ))}
              </span>
            </div>
          ) : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup heading={null} headingId="team-leave">
        <SettingsRow
          action={
            <button
              className="btn btn--small btn--danger"
              onClick={() => setLeaving(true)}
              type="button"
            >
              Leave {team.name}
            </button>
          }
          detail="Tasks your agent did for this team stay on your computer."
          title={`Leave ${team.name}`}
        />
      </SettingsGroup>
      {leaving ? (
        <Dialog
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setLeaving(false)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  setLeaving(false);
                  actions.onLeave();
                }}
                type="button"
              >
                Leave {team.name}
              </button>
            </>
          }
          labelledBy="leave-team-title"
          onClose={() => setLeaving(false)}
          title={`Leave ${team.name}?`}
        >
          <p className="team-dialog__text">
            You’ll lose access to its channels. Tasks your agent did for {team.name} stay on your
            computer.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function NameField({
  name,
  onSave,
}: {
  readonly name: string;
  readonly onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing)
    return (
      <span className="name-field">
        {name}
        <button className="details-link" onClick={() => setEditing(true)} type="button">
          Edit
        </button>
      </span>
    );
  return (
    <form
      className="name-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSave(value.trim());
        setEditing(false);
      }}
    >
      <input
        aria-label="Name"
        autoFocus
        className="text-input"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setEditing(false);
          }
        }}
        value={value}
      />
      <button className="btn btn--small btn--primary" type="submit">
        Save
      </button>
    </form>
  );
}
