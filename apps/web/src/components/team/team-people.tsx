import { useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router";
import {
  createTeamInvitationDraft,
  formatRelativeTime,
  levelLabel,
  memberKindLabel,
  memberPreviewCopy,
  memberStateLabel,
  teamReasonText,
  invitationTrustConfirmation,
  invitationTrustNote,
  teamInvitationUrl,
  type MemberDetailView,
  type TeamAccess,
} from "@opensteer/client/host";
import { useHostRead, usePagedList } from "@opensteer/client/react";
import type { MemberChange, MemberState, MemberSummary } from "@opensteer/protocol";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader, SettingsSegmented, formatWhen } from "../settings/primitives.js";
import {
  CanNote,
  ShowMore,
  TeamAvatar,
  TeamError,
  TeamSection,
  TeamStateNotice,
  formatDay,
  useShellTeam,
} from "./team-ui.js";

export function TeamTabs() {
  return (
    <nav aria-label="People and groups" className="settings-segmented team-tabs">
      <NavLink
        className={({ isActive }) => (isActive ? "is-active" : "")}
        end={false}
        to="/settings/team/people"
      >
        People
      </NavLink>
      <NavLink
        className={({ isActive }) => (isActive ? "is-active" : "")}
        to="/settings/team/groups"
      >
        Groups
      </NavLink>
    </nav>
  );
}

export function MemberChips({
  member,
}: {
  readonly member: Pick<MemberSummary, "administrator" | "kind" | "state">;
}) {
  return (
    <>
      {member.administrator ? <span className="chip chip--accent">Admin</span> : null}
      {member.kind === "guest" ? <span className="chip">Guest</span> : null}
      {member.state !== "active" ? (
        <span className={`chip ${member.state === "suspended" ? "chip--warn" : "chip--muted"}`}>
          {memberStateLabel(member.state)}
        </span>
      ) : null}
    </>
  );
}

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

export function TeamPeoplePage() {
  const { team, summary, generation, identity, error: summaryError } = useShellTeam();
  const teamName = summary?.team.name ?? "the team";
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"all" | MemberState>("all");
  const [inviting, setInviting] = useState(false);
  const debounced = useDebounced(query);
  const list = usePagedList(
    team
      ? (cursor: string | null) =>
          team.people({
            limit: 30,
            ...(cursor ? { cursor } : {}),
            ...(debounced ? { query: debounced } : {}),
            ...(state === "all" ? {} : { state }),
          })
      : null,
    `team-people:${identity}:${debounced}:${state}:${generation}`,
  );
  if (!team) return null;
  const people = list.items;
  return (
    <>
      <SectionHeader
        action={
          summary?.can.invite.allowed ? (
            <button
              className="btn btn--primary btn--small"
              onClick={() => setInviting(true)}
              type="button"
            >
              <Icon name="plus" /> Invite people
            </button>
          ) : null
        }
        lead={`Everyone in ${teamName}. Open a person to see what they can use, switch them off or on, or make them an admin.`}
        title="People"
      />
      <TeamStateNotice error={summaryError} team={teamName} />
      <TeamTabs />
      <div className="team-filters">
        <label className="projects-page__filter team-filters__search">
          <Icon name="search" />
          <input
            aria-label="Find people"
            className="text-input"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Find people"
            type="search"
            value={query}
          />
        </label>
        <SettingsSegmented
          label="Show"
          onChange={setState}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "suspended", label: "Suspended" },
            { value: "removed", label: "Removed" },
          ]}
          value={state}
        />
      </div>
      <div className="card team-people">
        {list.first === null ? (
          list.error ? (
            <div className="card__empty">
              <TeamError error={list.error} onRetry={list.reload} team={teamName} />
            </div>
          ) : (
            <LoadingRows label="Loading people" rows={5} />
          )
        ) : people.length === 0 ? (
          <div className="card__empty">
            {debounced ? `Nobody matches “${debounced}”.` : "Nobody here yet."}
          </div>
        ) : (
          people.map((person) => (
            <Link
              className="card__row team-person-row"
              key={person.id}
              to={`/settings/team/people/${encodeURIComponent(person.id)}`}
            >
              <TeamAvatar name={person.name} />
              <span className="card__row-body">
                <span className="card__row-title">
                  {person.name}
                  <MemberChips member={person} />
                </span>
                <span className="card__row-detail">
                  {person.email}
                  {person.groupsPreview.length
                    ? ` · ${person.groupsPreview
                        .slice(0, 2)
                        .map(({ name }) => name)
                        .join(", ")}${person.groupCount > 2 ? ` +${person.groupCount - 2}` : ""}`
                    : ""}
                </span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          ))
        )}
        <ShowMore list={list} team={teamName} />
      </div>
      {summary?.can.invite.allowed ? (
        <Invitations onInvite={() => setInviting(true)} team={team} teamName={teamName} />
      ) : null}
      {inviting && summary ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          revision={summary.accessRevision}
          team={team}
          teamName={teamName}
        />
      ) : null}
    </>
  );
}

const invitationState: Record<
  "open" | "used" | "revoked" | "expired",
  { readonly label: string; readonly chip: string }
> = {
  open: { label: "Open", chip: "chip chip--ok" },
  used: { label: "Joined", chip: "chip" },
  revoked: { label: "Revoked", chip: "chip chip--muted" },
  expired: { label: "Expired", chip: "chip chip--warn" },
};

function Invitations({
  onInvite,
  team,
  teamName,
}: {
  readonly onInvite: () => void;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const { generation, identity, links, forgetLink } = useShellTeam();
  const paged = usePagedList(
    (cursor: string | null) => team.invitations({ limit: 30, ...(cursor ? { cursor } : {}) }),
    `team-invitations:${identity}:${generation}`,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const list = paged.first;
  const items = paged.items;
  return (
    <TeamSection
      hint="Open invitations, and those made, used or revoked in the last 30 days, from any device. A link can be copied only in the tab that made it; anywhere else, revoke it and invite again."
      id="team-invitations"
      title="Invitations"
    >
      <div className="card">
        {!list ? (
          paged.error ? (
            <div className="card__empty">
              <TeamError error={paged.error} onRetry={paged.reload} team={teamName} />
            </div>
          ) : (
            <LoadingRows label="Loading invitations" rows={2} />
          )
        ) : items.length === 0 ? (
          <div className="card__empty">No invitations in the last 30 days.</div>
        ) : (
          items.map((invitation) => {
            const state = invitationState[invitation.state];
            const link = invitation.state === "open" ? links.get(invitation.id) : undefined;
            return (
              <div className="card__row team-invitation" key={invitation.id}>
                <span className="card__row-glyph">
                  <Icon name="paper-plane" />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">
                    {invitation.emailMasked}
                    {invitation.memberKind === "guest" ? <span className="chip">Guest</span> : null}
                    <span className={state.chip}>{state.label}</span>
                  </span>
                  <span className="card__row-detail">
                    {`Made by ${invitation.createdBy.name}, ${formatDay(invitation.createdAt)} · `}
                    {invitation.state === "open"
                      ? link
                        ? `works until ${formatWhen(invitation.expiresAt)}`
                        : `works until ${formatWhen(invitation.expiresAt)}. Its link can’t be shown again here.`
                      : invitation.state === "expired"
                        ? `expired ${formatDay(invitation.expiresAt)}`
                        : invitation.state === "revoked"
                          ? "no longer works"
                          : "used to join"}
                  </span>
                </span>
                <span className="card__row-actions">
                  {link ? <CopyButton text={link} /> : null}
                  {invitation.can.revoke.allowed ? (
                    <button
                      className="btn btn--small btn--ghost"
                      disabled={pending !== null}
                      onClick={() => {
                        setPending(invitation.id);
                        setError(null);
                        void team
                          .revokeInvitation(list.accessRevision, invitation.id)
                          .then(() => forgetLink(invitation.id))
                          .catch(setError)
                          .finally(() => setPending(null));
                      }}
                      type="button"
                    >
                      {pending === invitation.id ? "Revoking…" : "Revoke"}
                    </button>
                  ) : invitation.state === "revoked" || invitation.state === "expired" ? (
                    <button className="btn btn--small btn--ghost" onClick={onInvite} type="button">
                      Invite again
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
        <ShowMore list={paged} team={teamName} />
      </div>
      <TeamError error={error} team={teamName} />
    </TeamSection>
  );
}

export function CopyButton({
  label = "Copy link",
  text,
}: {
  readonly label?: string;
  readonly text: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn--small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : label}
    </button>
  );
}

function InviteDialog({
  onClose,
  revision,
  team,
  teamName,
}: {
  readonly onClose: () => void;
  readonly revision: number;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const { snapshot } = useShell();
  const { holdLink } = useShellTeam();
  const [email, setEmail] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [validFor, setValidFor] = useState<"1d" | "7d">("7d");
  const [draft] = useState(() => createTeamInvitationDraft());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [made, setMade] = useState<{
    readonly email: string;
    readonly expiresAt: string;
    readonly url: string;
  } | null>(null);
  const origin = snapshot.identityConfig?.publicOrigin ?? window.location.origin;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());
  if (made)
    return (
      <Dialog
        labelledBy="team-invite"
        onClose={onClose}
        title={`Invite for ${made.email} is ready`}
      >
        <p>
          Send this link to them yourself. It works once, only for {made.email}, until{" "}
          {formatWhen(made.expiresAt)}.
        </p>
        <div className="team-invite-link">
          <input
            aria-label="Invite link"
            className="text-input"
            readOnly
            value={made.url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <CopyButton text={made.url} />
        </div>
        <p className="settings-footnote">
          Anyone with the link can see it’s from {teamName}, but only {made.email} can join with it.
          You can revoke it under Invitations, from any device.
        </p>
        <div className="form-actions">
          <button className="btn btn--primary" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      labelledBy="team-invite"
      onClose={() => !pending && onClose()}
      title={`Invite someone to ${teamName}`}
    >
      <form
        className="card__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !trusted || pending) return;
          setPending(true);
          setError(null);
          const intended = email.trim();
          void team
            .createInvitation(revision, draft, {
              email: intended,
              validFor,
              trustedComputerConfirmed: true,
            })
            .then((result) => {
              const url = teamInvitationUrl(origin, draft);
              holdLink(result.invitationId, url);
              setMade({ email: intended, expiresAt: result.expiresAt, url });
            })
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span className="field__label">Email</span>
          <input
            autoFocus
            className="text-input"
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="name@company.com"
            type="email"
            value={email}
          />
          <span className="field__hint">Only someone signed in with this email can join.</span>
        </label>
        <div className="field">
          <span className="field__label">Link works for</span>
          <SettingsSegmented
            label="Link works for"
            onChange={setValidFor}
            options={[
              { value: "1d", label: "1 day" },
              { value: "7d", label: "7 days" },
            ]}
            value={validFor}
          />
        </div>
        <div className="team-trust">
          <p>{invitationTrustNote(teamName)}</p>
          <label className="team-trust__confirm">
            <input
              checked={trusted}
              className="team-check"
              onChange={(event) => setTrusted(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{invitationTrustConfirmation(email, teamName)}</span>
          </label>
        </div>
        <TeamError error={error} team={teamName} />
        <div className="form-actions">
          <button className="btn" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || !trusted || pending}
            type="submit"
          >
            {pending ? "Making link…" : "Make invite link"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function TeamPersonPage() {
  const { userId = "" } = useParams();
  const { team, summary, generation, identity } = useShellTeam();
  const { snapshot } = useShell();
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.member({ userId }) : null,
    `team-member:${identity}:${userId}:${generation}`,
  );
  const [change, setChange] = useState<MemberChange | null>(null);
  const [disconnecting, setDisconnecting] = useState<
    MemberDetailView["connections"]["items"][number] | null
  >(null);
  const person = read.data;
  // The person's own read is the first page of each list; "Show more" reads on from it.
  const loaded = `${identity}:${userId}:${generation}:${person ? "read" : "waiting"}`;
  const groups = usePagedList(
    team && person
      ? (cursor: string | null) =>
          cursor
            ? team.member({ userId, groupPage: { cursor } }).then((next) => next.groups)
            : Promise.resolve(person.groups)
      : null,
    `team-member-groups:${loaded}`,
  );
  const connections = usePagedList(
    team && person
      ? (cursor: string | null) =>
          cursor
            ? team.member({ userId, connectionPage: { cursor } }).then((next) => next.connections)
            : Promise.resolve(person.connections)
      : null,
    `team-member-connections:${loaded}`,
  );
  if (!team) return null;
  return (
    <>
      <Link className="page__back" to="/settings/team/people">
        <Icon name="arrow-left" /> People
      </Link>
      {!person ? (
        read.error ? (
          <TeamError error={read.error} onRetry={read.reload} team={teamName} />
        ) : (
          <div className="card">
            <LoadingRows label="Loading person" rows={3} />
          </div>
        )
      ) : (
        <>
          <header className="team-person-head">
            <TeamAvatar name={person.name} />
            <div>
              <h1 className="settings-section__title">
                {person.name}
                {person.id === snapshot.user?.id ? <span className="chip">You</span> : null}
              </h1>
              <p className="settings-section__lead">
                {person.email} · {memberKindLabel(person.kind, person.administrator)} · Joined{" "}
                {formatDay(person.joinedAt)}
                {person.invitedBy ? ` · Invited by ${person.invitedBy.name}` : ""}
              </p>
              <div className="team-person-head__chips">
                <MemberChips member={person} />
              </div>
            </div>
          </header>
          {person.state === "suspended" ? (
            <div className="notice notice--warn team-banner" role="status">
              <Icon name="alert-circle" />
              <div>
                <strong>{person.name} is suspended.</strong>
                <p>
                  They can’t sign in to {teamName} or use its projects until you turn them back on.
                </p>
              </div>
              {person.can.setState.allowed ? (
                <button
                  className="btn btn--small"
                  onClick={() => setChange({ kind: "set-state", value: "active" })}
                  type="button"
                >
                  Turn back on
                </button>
              ) : null}
            </div>
          ) : person.state === "removed" ? (
            <div className="notice team-banner" role="status">
              <Icon name="alert-circle" />
              <div>
                <strong>
                  {person.name} was removed from {teamName}.
                </strong>
                <p>Their history stays in the audit log. To come back, they need a new invite.</p>
              </div>
            </div>
          ) : null}

          <TeamSection id="team-person-projects" title="Projects">
            <div className="card">
              {person.effectiveProjects.length === 0 ? (
                <div className="card__empty">{person.name} can’t use any projects yet.</div>
              ) : (
                person.effectiveProjects.map((project) => (
                  <Link
                    className="card__row"
                    key={project.id}
                    to={`/workspaces/${encodeURIComponent(project.id)}/settings`}
                  >
                    <span className="card__row-glyph">
                      <Icon name="folder" />
                    </span>
                    <span className="card__row-body">
                      <span className="card__row-title">{project.name}</span>
                      <span className="card__row-detail">{levelLabel(project.level)}</span>
                    </span>
                    <Icon name="chevron-right" />
                  </Link>
                ))
              )}
            </div>
          </TeamSection>

          <TeamSection id="team-person-groups" title="Groups">
            {groups.items.length ? (
              <ul className="team-chips">
                {groups.items.map((group) => (
                  <li key={group.id}>
                    <Link
                      className="chip"
                      to={`/settings/team/groups/${encodeURIComponent(group.id)}`}
                    >
                      <Icon name="users" /> {group.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : groups.first ? (
              <p className="settings-footnote">Not in any group.</p>
            ) : null}
            <ShowMore list={groups} team={teamName} />
          </TeamSection>

          <TeamSection
            hint={`Agents ${person.name} connected to ${teamName}. Disconnecting one stops it acting for them; ${person.name} stays a member.`}
            id="team-person-connections"
            title="Connected agents"
          >
            <div className="card">
              {connections.first && connections.items.length === 0 ? (
                <div className="card__empty">None.</div>
              ) : (
                connections.items.map((connection) => (
                  <div className="card__row" key={connection.id}>
                    <span className="card__row-glyph">
                      <Icon name="plug" />
                    </span>
                    <span className="card__row-body">
                      <span className="card__row-title">
                        {connection.label}
                        {connection.revoked ? (
                          <span className="chip chip--muted">Disconnected</span>
                        ) : null}
                      </span>
                      <span className="card__row-detail">
                        {connection.lastUsedAt
                          ? `Last used ${formatRelativeTime(connection.lastUsedAt, new Date())}`
                          : "Never used"}{" "}
                        · added {formatDay(connection.createdAt)}
                      </span>
                    </span>
                    {connection.canRevoke.allowed ? (
                      <button
                        className="btn btn--small btn--ghost"
                        onClick={() => setDisconnecting(connection)}
                        type="button"
                      >
                        Disconnect
                      </button>
                    ) : null}
                    <ShowMore list={connections} team={teamName} />
                  </div>
                ))
              )}
            </div>
          </TeamSection>

          <TeamSection id="team-person-role" title="Role and access">
            <div className="card">
              <RoleRow
                can={person.can.setAdministrator}
                detail={
                  person.administrator
                    ? `Can manage people, groups and every project’s list.`
                    : `Admins manage people, groups and every project’s list.`
                }
                label={person.administrator ? "Remove as admin" : "Make admin"}
                onSelect={() =>
                  setChange({ kind: "set-administrator", value: !person.administrator })
                }
                teamName={teamName}
                title={person.administrator ? "Admin" : "Not an admin"}
              />
              {/* The trusted-members pilot admits no guests: someone the Host
                  still reports as one can only be made a member. */}
              {person.kind === "guest" ? (
                <RoleRow
                  can={person.can.setKind}
                  detail="Sees only the projects they’re added to."
                  label="Make member"
                  onSelect={() => setChange({ kind: "set-kind", value: "full" })}
                  teamName={teamName}
                  title={memberKindLabel(person.kind)}
                />
              ) : null}
              {person.state === "active" ? (
                <RoleRow
                  can={person.can.setState}
                  danger
                  detail={`Ends their sign-ins and running work in ${teamName} now. You can turn them back on.`}
                  label="Suspend…"
                  onSelect={() => setChange({ kind: "set-state", value: "suspended" })}
                  teamName={teamName}
                  title="Switch off"
                />
              ) : null}
              {person.state !== "removed" ? (
                <RoleRow
                  can={person.can.setState}
                  danger
                  detail={`Takes them out of every group and project. They need a new invite to return.`}
                  label="Remove…"
                  onSelect={() => setChange({ kind: "set-state", value: "removed" })}
                  teamName={teamName}
                  title={`Remove from ${teamName}`}
                />
              ) : null}
            </div>
          </TeamSection>
          {change ? (
            <MemberChangeDialog
              change={change}
              member={person}
              onClose={() => setChange(null)}
              team={team}
              teamName={teamName}
            />
          ) : null}
          {disconnecting ? (
            <DisconnectDialog
              connection={disconnecting}
              onClose={() => setDisconnecting(null)}
              person={person}
              team={team}
              teamName={teamName}
            />
          ) : null}
        </>
      )}
    </>
  );
}

function RoleRow({
  can,
  danger = false,
  detail,
  label,
  onSelect,
  teamName,
  title,
}: {
  readonly can: MemberSummary["can"]["setKind"];
  readonly danger?: boolean;
  readonly detail: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly teamName: string;
  readonly title: string;
}) {
  return (
    <div className="card__row team-role-row">
      <span className="card__row-body">
        <span className="card__row-title">{title}</span>
        <span className="card__row-detail">{detail}</span>
        <CanNote can={can} team={teamName} />
      </span>
      {can.allowed ? (
        <button
          className={`btn btn--small${danger ? " btn--danger-ghost" : ""}`}
          onClick={onSelect}
          type="button"
        >
          {label}
        </button>
      ) : null}
    </div>
  );
}

function MemberChangeDialog({
  change,
  member,
  onClose,
  team,
  teamName,
}: {
  readonly change: MemberChange;
  readonly member: MemberDetailView;
  readonly onClose: () => void;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const preview = useHostRead(
    () => team.previewMember(member.id, change),
    `team-member-preview:${member.id}:${change.kind}:${String(change.value)}`,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const data = preview.data;
  const copy = data ? memberPreviewCopy(member.name, change, data, teamName) : null;
  const danger = change.kind === "set-state" && change.value !== "active";
  return (
    <Dialog
      labelledBy="team-member-change"
      onClose={() => !pending && onClose()}
      title={copy?.title ?? "Checking…"}
    >
      {!data || !copy ? (
        preview.error ? (
          <TeamError error={preview.error} team={teamName} />
        ) : (
          <p className="team-preview team-preview--loading">Checking what this changes…</p>
        )
      ) : (
        <>
          {copy.ends.length ? (
            <div className="team-consequence">
              <h3>What ends now</h3>
              <ul>
                {copy.ends.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {copy.carriesOn.length ? (
            <div className="team-consequence team-consequence--keep">
              <h3>What carries on</h3>
              <ul>
                {copy.carriesOn.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>{copy.after}</p>
          {!data.allowed ? (
            <p className="notice notice--warn" role="status">
              <Icon name="alert-circle" />
              <span>
                {data.reason ? teamReasonText(data.reason, teamName) : "This can’t be changed."}
              </span>
            </p>
          ) : null}
        </>
      )}
      <TeamError error={error} team={teamName} />
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={onClose} type="button">
          Cancel
        </button>
        {copy && data?.allowed ? (
          <button
            className={danger ? "btn btn--danger" : "btn btn--primary"}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void team
                .changeMember(data.accessRevision, member.id, change)
                .then(onClose)
                .catch(setError)
                .finally(() => setPending(false));
            }}
            type="button"
          >
            {pending ? "Saving…" : copy.confirm}
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}

function DisconnectDialog({
  connection,
  onClose,
  person,
  team,
  teamName,
}: {
  readonly connection: MemberDetailView["connections"]["items"][number];
  readonly onClose: () => void;
  readonly person: MemberDetailView;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      labelledBy="team-disconnect"
      onClose={() => !pending && onClose()}
      title={`Disconnect ${connection.label}?`}
    >
      <p>
        It stops acting for {person.name} in {teamName} now, and work it started there stops.{" "}
        {person.name} stays a member and can connect an agent again.
      </p>
      <TeamError error={error} team={teamName} />
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="btn btn--danger"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void team
              .revokeConnection(person.accessRevision, connection.id)
              .then(onClose)
              .catch(setError)
              .finally(() => setPending(false));
          }}
          type="button"
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </Dialog>
  );
}
