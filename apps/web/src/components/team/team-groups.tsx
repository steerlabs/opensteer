import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  peopleCount,
  subjectKey,
  subjectRef,
  type GroupDetail,
  type TeamAccess,
} from "@opensteer/client/host";
import { useHostRead, usePagedList } from "@opensteer/client/react";
import type { AccessChange, Subject, SubjectView } from "@opensteer/protocol";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader } from "../settings/primitives.js";
import { AccessChangeDialog } from "./access-change-dialog.js";
import { TeamTabs } from "./team-people.js";
import { CanNote, ShowMore, TeamAvatar, TeamError, TeamSection, useShellTeam } from "./team-ui.js";

export function TeamGroupsPage() {
  const { team, summary, generation, identity } = useShellTeam();
  const navigate = useNavigate();
  const teamName = summary?.team.name ?? "the team";
  const read = usePagedList(
    team
      ? (cursor: string | null) => team.groups({ limit: 100, ...(cursor ? { cursor } : {}) })
      : null,
    `team-groups:${identity}:${generation}`,
  );
  const [creating, setCreating] = useState(false);
  if (!team) return null;
  const list = read.first;
  return (
    <>
      <SectionHeader
        action={
          list?.can.create.allowed ? (
            <button
              className="btn btn--primary btn--small"
              onClick={() => setCreating(true)}
              type="button"
            >
              <Icon name="plus" /> New group
            </button>
          ) : null
        }
        lead="Give a group access to a project once, and everyone in it can use that project. Groups can hold other groups."
        title="Groups"
      />
      <TeamTabs />
      <div className="card">
        {!list ? (
          read.error ? (
            <div className="card__empty">
              <TeamError error={read.error} onRetry={read.reload} team={teamName} />
            </div>
          ) : (
            <LoadingRows label="Loading groups" rows={3} />
          )
        ) : read.items.length === 0 ? (
          <div className="card__empty">No groups yet.</div>
        ) : (
          read.items.map((group) => (
            <Link
              className="card__row"
              key={group.id}
              to={`/settings/team/groups/${encodeURIComponent(group.id)}`}
            >
              <TeamAvatar group name={group.name} />
              <span className="card__row-body">
                <span className="card__row-title">
                  {group.name}
                  {group.builtin ? <span className="chip chip--muted">Built in</span> : null}
                </span>
                <span className="card__row-detail">
                  {group.builtin
                    ? `Every member of ${teamName} · ${peopleCount(group.effectivePeopleCount)}`
                    : `${peopleCount(group.effectivePeopleCount)}${
                        group.parentCount
                          ? ` · in ${group.parentCount === 1 ? "1 group" : `${group.parentCount} groups`}`
                          : ""
                      }`}
                </span>
              </span>
              <Icon name="chevron-right" />
            </Link>
          ))
        )}
        <ShowMore list={read} team={teamName} />
      </div>
      {creating && list ? (
        <NameDialog
          confirm="Create group"
          initial=""
          onClose={() => setCreating(false)}
          onSubmit={(name) => {
            const id = globalThis.crypto.randomUUID();
            return team
              .applyAccess(list.accessRevision, [{ kind: "create-group", id, name }])
              .then(() => navigate(`/settings/team/groups/${id}`));
          }}
          teamName={teamName}
          title="New group"
        />
      ) : null}
    </>
  );
}

function NameDialog({
  confirm,
  initial,
  onClose,
  onSubmit,
  teamName,
  title,
}: {
  readonly confirm: string;
  readonly initial: string;
  readonly onClose: () => void;
  readonly onSubmit: (name: string) => Promise<unknown>;
  readonly teamName: string;
  readonly title: string;
}) {
  const [name, setName] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = name.trim();
  return (
    <Dialog labelledBy="team-group-name" onClose={() => !pending && onClose()} title={title}>
      <form
        className="card__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || trimmed === initial || pending) return;
          setPending(true);
          setError(null);
          void onSubmit(trimmed)
            .then(onClose)
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input
            autoFocus
            className="text-input"
            maxLength={120}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Support team"
            value={name}
          />
        </label>
        <TeamError error={error} team={teamName} />
        <div className="form-actions">
          <button className="btn" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!trimmed || trimmed === initial || pending}
            type="submit"
          >
            {pending ? "Saving…" : confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type GroupDialog =
  | { kind: "rename" }
  | { kind: "delete" }
  | { kind: "add" }
  | { kind: "remove"; member: SubjectView };

export function TeamGroupPage() {
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
  const { team, summary, generation, identity } = useShellTeam();
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.group({ groupId, limit: 100 }) : null,
    `team-group:${identity}:${groupId}:${generation}`,
  );
  const [dialog, setDialog] = useState<GroupDialog | null>(null);
  const group = read.data;
  // The group's own read is the first page of its members; "Show more" reads on from it.
  const members = usePagedList(
    team && group
      ? (cursor: string | null) =>
          cursor
            ? team.group({ groupId, limit: 100, cursor }).then((next) => next.directMembers)
            : Promise.resolve(group.directMembers)
      : null,
    `team-group-members:${identity}:${groupId}:${generation}:${group ? "read" : "waiting"}`,
  );
  if (!team) return null;
  return (
    <>
      <Link className="page__back" to="/settings/team/groups">
        <Icon name="arrow-left" /> Groups
      </Link>
      {!group ? (
        read.error ? (
          <TeamError error={read.error} onRetry={read.reload} team={teamName} />
        ) : (
          <div className="card">
            <LoadingRows label="Loading group" rows={3} />
          </div>
        )
      ) : (
        <>
          <SectionHeader
            action={
              group.can.rename.allowed ? (
                <button
                  className="btn btn--small"
                  onClick={() => setDialog({ kind: "rename" })}
                  type="button"
                >
                  <Icon name="pencil" /> Rename
                </button>
              ) : null
            }
            lead={
              group.builtin
                ? `Every member of ${teamName}, kept up to date by ${teamName}. Guests aren’t in it.`
                : `${peopleCount(group.effectivePeopleCount)}, counting everyone in the groups inside it.`
            }
            title={group.name}
          />
          {group.parents.length ? (
            <ul className="team-chips">
              {group.parents.map((parent) => (
                <li key={parent.id}>
                  <Link
                    className="chip"
                    to={`/settings/team/groups/${encodeURIComponent(parent.id)}`}
                  >
                    In {parent.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <TeamSection
            action={
              group.can.editMembers.allowed ? (
                <button
                  className="btn btn--small"
                  onClick={() => setDialog({ kind: "add" })}
                  type="button"
                >
                  <Icon name="plus" /> Add members
                </button>
              ) : null
            }
            id="team-group-members"
            title="Members"
          >
            <div className="card">
              {members.first === null ? (
                <LoadingRows label="Loading members" rows={2} />
              ) : members.items.length === 0 ? (
                <div className="card__empty">Nobody is in this group yet.</div>
              ) : (
                members.items.map((member) => (
                  <div className="card__row" key={subjectKey(member)}>
                    <TeamAvatar group={member.kind === "group"} name={member.name} />
                    <span className="card__row-body">
                      {member.kind === "group" ? (
                        <Link
                          className="card__row-title"
                          to={`/settings/team/groups/${encodeURIComponent(member.groupId)}`}
                        >
                          {member.name}
                        </Link>
                      ) : (
                        <Link
                          className="card__row-title"
                          to={`/settings/team/people/${encodeURIComponent(member.userId)}`}
                        >
                          {member.name}
                        </Link>
                      )}
                      <span className="card__row-detail">
                        {member.kind === "group"
                          ? `Group · ${peopleCount(member.memberCount ?? 0)}`
                          : "Person"}
                      </span>
                    </span>
                    {group.can.editMembers.allowed ? (
                      <button
                        className="btn btn--small btn--ghost"
                        onClick={() => setDialog({ kind: "remove", member })}
                        type="button"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))
              )}
              <ShowMore list={members} team={teamName} />
            </div>
            <CanNote can={group.can.editMembers} team={teamName} />
          </TeamSection>
          {group.can.delete.allowed ? (
            <TeamSection id="team-group-delete" title="Delete">
              <div className="card">
                <div className="card__row">
                  <span className="card__row-body">
                    <span className="card__row-title">Delete {group.name}</span>
                    <span className="card__row-detail">
                      Access through this group stops. People and their history stay.
                    </span>
                  </span>
                  <button
                    className="btn btn--small btn--danger-ghost"
                    onClick={() => setDialog({ kind: "delete" })}
                    type="button"
                  >
                    Delete…
                  </button>
                </div>
              </div>
            </TeamSection>
          ) : null}
          {dialog?.kind === "rename" ? (
            <NameDialog
              confirm="Rename"
              initial={group.name}
              onClose={() => setDialog(null)}
              onSubmit={(name) =>
                team.applyAccess(group.accessRevision, [
                  { kind: "rename-group", groupId: group.id, name },
                ])
              }
              teamName={teamName}
              title={`Rename ${group.name}`}
            />
          ) : dialog?.kind === "delete" ? (
            <AccessChangeDialog
              changes={[{ kind: "delete-group", groupId: group.id }]}
              confirm="Delete group"
              danger
              onClose={() => setDialog(null)}
              onDone={() => void navigate("/settings/team/groups")}
              onStale={read.reload}
              revision={group.accessRevision}
              team={team}
              teamName={teamName}
              title={`Delete ${group.name}?`}
            >
              <p>
                Projects shared with {group.name} stop including the people who had them only
                through it. Their history is kept.
              </p>
            </AccessChangeDialog>
          ) : dialog?.kind === "remove" ? (
            <AccessChangeDialog
              changes={[
                {
                  kind: "remove-group-member",
                  groupId: group.id,
                  member: subjectRef(dialog.member),
                },
              ]}
              confirm="Remove"
              danger
              onClose={() => setDialog(null)}
              onStale={read.reload}
              revision={group.accessRevision}
              team={team}
              teamName={teamName}
              title={`Remove ${dialog.member.name} from ${group.name}?`}
            />
          ) : dialog?.kind === "add" ? (
            <AddMembersDialog
              group={group}
              onClose={() => setDialog(null)}
              onStale={read.reload}
              team={team}
              teamName={teamName}
            />
          ) : null}
        </>
      )}
    </>
  );
}

function AddMembersDialog({
  group,
  onClose,
  onStale,
  team,
  teamName,
}: {
  readonly group: GroupDetail;
  readonly onClose: () => void;
  readonly onStale: () => void;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<{ subject: Subject; name: string }[]>([]);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useHostRead(
    debounced
      ? () =>
          Promise.all([
            team.people({ query: debounced, state: "active", limit: 10 }),
            team.groups({ query: debounced, limit: 10 }),
          ])
      : null,
    `team-group-search:${debounced}`,
  );
  const present = new Set(group.directMembers.items.map((member) => subjectKey(member)));
  const pickedKeys = new Set(picked.map(({ subject }) => subjectKey(subject)));
  const toggle = (subject: Subject, name: string) =>
    setPicked((current) =>
      pickedKeys.has(subjectKey(subject))
        ? current.filter((item) => subjectKey(item.subject) !== subjectKey(subject))
        : [...current, { subject, name }],
    );
  const changes: AccessChange[] = picked.map(({ subject }) => ({
    kind: "add-group-member",
    groupId: group.id,
    member: subject,
  }));
  if (reviewing)
    return (
      <AccessChangeDialog
        changes={changes}
        confirm={picked.length === 1 ? `Add ${picked[0]!.name}` : `Add ${picked.length}`}
        onClose={onClose}
        onStale={onStale}
        revision={group.accessRevision}
        team={team}
        teamName={teamName}
        title={`Add to ${group.name}?`}
      />
    );
  const [people, groups] = results.data ?? [null, null];
  return (
    <Dialog labelledBy="team-group-add" onClose={onClose} title={`Add to ${group.name}`} wide>
      <label className="field">
        <span className="field__label">Find people or groups</span>
        <input
          autoFocus
          className="text-input"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, email or group"
          type="search"
          value={query}
        />
      </label>
      {picked.length ? (
        <ul className="team-add__picked">
          {picked.map((item) => (
            <li className="chip chip--accent" key={subjectKey(item.subject)}>
              {item.name}
              <button
                aria-label={`Remove ${item.name}`}
                onClick={() => toggle(item.subject, item.name)}
                type="button"
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {debounced ? (
        <div className="card team-add__results">
          {!people || !groups ? (
            results.error ? (
              <div className="card__empty">
                <TeamError error={results.error} team={teamName} />
              </div>
            ) : (
              <LoadingRows label="Searching" rows={2} />
            )
          ) : (
            [
              ...groups.items
                .filter((candidate) => candidate.id !== group.id && !candidate.builtin)
                .map((candidate) => ({
                  subject: { kind: "group", groupId: candidate.id } as Subject,
                  name: candidate.name,
                  detail: `Group · ${peopleCount(candidate.effectivePeopleCount)}`,
                })),
              ...people.items.map((person) => ({
                subject: { kind: "person", userId: person.id } as Subject,
                name: person.name,
                detail: person.email,
              })),
            ]
              .filter(({ subject }) => !present.has(subjectKey(subject)))
              .map(({ subject, name, detail }) => (
                <label className="card__row team-result" key={subjectKey(subject)}>
                  <TeamAvatar group={subject.kind === "group"} name={name} />
                  <span className="card__row-body">
                    <span className="card__row-title">{name}</span>
                    <span className="card__row-detail">{detail}</span>
                  </span>
                  <input
                    checked={pickedKeys.has(subjectKey(subject))}
                    className="team-check"
                    onChange={() => toggle(subject, name)}
                    type="checkbox"
                  />
                </label>
              ))
          )}
        </div>
      ) : (
        <p className="settings-footnote">Search the people and groups in {teamName}.</p>
      )}
      <div className="form-actions">
        <button className="btn" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="btn btn--primary"
          disabled={!picked.length}
          onClick={() => setReviewing(true)}
          type="button"
        >
          Review
        </button>
      </div>
    </Dialog>
  );
}
