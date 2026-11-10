import { useEffect, useMemo, useState } from "react";
import {
  accessPathSentence,
  accessPaths,
  changeLevelChanges,
  grantChanges,
  levelLabel,
  peopleCount,
  subjectKey,
  subjectRef,
  teamErrorIsStale,
  teamReasonOf,
  type ProjectAccessView,
  type TeamAccess,
} from "@opensteer/client/host";
import { useHostRead, type HostRead } from "@opensteer/client/react";
import type {
  AccessChange,
  AccessExplanation,
  EntryView,
  Level,
  PersonRef,
  Subject,
} from "@opensteer/protocol";
import { Dialog } from "../dialog.js";
import { AccessChangeDialog, useAccessPreview } from "./access-change-dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { Popover } from "../popover.js";
import { SurfaceMenu } from "../surface-menu.js";
import {
  AccessPreviewPanel,
  LevelPicker,
  TeamAvatar,
  TeamError,
  TeamMark,
  TeamSection,
  formatDay,
  useShellTeam,
} from "./team-ui.js";

export type ProjectAccessRead = HostRead<ProjectAccessView>;

/** One read of a Project's access view, shared by its marker and its People section. */
export function useProjectAccess(workspaceId: string): ProjectAccessRead {
  const { team, generation } = useShellTeam();
  return useHostRead(
    team ? () => team.projectAccess({ workspaceId }) : null,
    `team-access:${workspaceId}:${generation}`,
  );
}

/** "Customer launch · 6 people": who can see this Project, always in words. */
export function WhoCanSeeChip({
  access,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly teamName: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { audience, project } = access;
  const shownPeople = audience.preview.length;
  const more = Math.max(0, audience.people - shownPeople);
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        className="team-marker"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        type="button"
      >
        <TeamMark name={teamName} />
        <span>
          {project.name} · {peopleCount(audience.people)}
        </span>
      </button>
      {anchor ? (
        <Popover
          anchor={anchor}
          below
          className="team-who"
          label="Who can see this"
          onClose={() => setAnchor(null)}
          role="dialog"
        >
          <h3 className="team-who__title">Who can see this</h3>
          <p className="team-who__lead">
            {peopleCount(audience.people)} at {teamName} can read {project.name}’s chat, tasks and
            files.
          </p>
          <ul className="team-who__list">
            {audience.groups.map((group) => (
              <li key={group.id}>
                <Icon name="users" />
                <span>{group.name}</span>
                <span className="team-who__meta">{peopleCount(group.count)}</span>
              </li>
            ))}
            {audience.preview.map((person) => (
              <li key={person.id}>
                <Icon name="user" />
                <span>{person.name}</span>
                {person.kind === "guest" ? (
                  <span className="chip team-who__chip">Guest</span>
                ) : null}
                {access.managerNames.some((manager) => manager.id === person.id) ? (
                  <span className="team-who__meta">Can manage</span>
                ) : null}
              </li>
            ))}
            {more ? <li className="team-who__more">and {peopleCount(more)} more</li> : null}
          </ul>
          {audience.myLevel ? (
            <p className="team-who__foot">
              You {levelLabel(audience.myLevel).toLocaleLowerCase()} it.
            </p>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/** Banners that belong at the top of a shared Project: no manager, or an admin not on it. */
export function ProjectAccessNotices({
  access,
  onAppoint,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly onAppoint: () => void;
  readonly teamName: string;
}) {
  const { team } = useShellTeam();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { project } = access;
  return (
    <>
      {access.audience.managerCount === 0 ? (
        <div className="notice notice--warn team-banner" role="status">
          <Icon name="alert-circle" />
          <div>
            <strong>{project.name} has no manager.</strong>
            <p>
              {access.can.appointManager.allowed
                ? "Nobody can add people or change its settings until someone can manage it."
                : `Ask an admin of ${teamName} to appoint one.`}
            </p>
          </div>
          {access.can.appointManager.allowed ? (
            <button className="btn btn--small" onClick={onAppoint} type="button">
              Appoint a manager
            </button>
          ) : null}
        </div>
      ) : null}
      {access.iAmAdminNotMember && access.can.selfGrant.allowed ? (
        <div className="notice notice--accent team-banner" role="status">
          <Icon name="shield" />
          <div>
            <strong>You’re not on {project.name}.</strong>
            <p>
              As an admin you can see who is on it, not its chats or files. You can add yourself at
              Can use.
            </p>
          </div>
          <button className="btn btn--small" onClick={() => setConfirming(true)} type="button">
            Add myself…
          </button>
        </div>
      ) : null}
      {confirming && team ? (
        <Dialog
          labelledBy="team-self-grant"
          onClose={() => !pending && setConfirming(false)}
          title={`Add yourself to ${project.name}?`}
        >
          <p>You’ll be able to read its chat, tasks and files, and start work in it, at Can use.</p>
          <p className="settings-footnote">
            {access.managerNames.length
              ? `Its managers (${access.managerNames.map(({ name }) => name).join(", ")}) are told, and it’s recorded in ${teamName}’s audit log.`
              : `It’s recorded in ${teamName}’s audit log.`}{" "}
            You can remove yourself from its people list at any time.
          </p>
          <TeamError error={error} team={teamName} />
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError(null);
                void team
                  .selfGrant(access.accessRevision, project.id)
                  .then(() => setConfirming(false))
                  .catch(setError)
                  .finally(() => setPending(false));
              }}
              type="button"
            >
              {pending ? "Adding…" : "Add myself"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** Who can use a shared Project, at what level, and how each person got there. */
export function ProjectAccessSection({
  access,
  appointing,
  onAppointDone,
  teamName,
  viewerId,
}: {
  readonly access: ProjectAccessRead;
  readonly appointing: boolean;
  readonly onAppointDone: () => void;
  readonly teamName: string;
  readonly viewerId: string | null;
}) {
  const { team } = useShellTeam();
  const view = access.data;
  const [more, setMore] = useState<EntryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ entry: EntryView; level: Level | null } | null>(null);
  useEffect(() => {
    setMore([]);
    setCursor(view?.entries?.nextCursor ?? null);
  }, [view]);
  if (!team) return null;
  if (!view)
    return (
      <TeamSection id="team-project-people" title="Who can use this">
        <div className="card">
          {access.error ? (
            <div className="card__empty" role="alert">
              <TeamError error={access.error} onRetry={access.reload} team={teamName} />
            </div>
          ) : (
            <LoadingRows label="Loading people" rows={3} />
          )}
        </div>
      </TeamSection>
    );
  const entries = [...(view.entries?.items ?? []), ...more];
  const { project, audience } = view;
  return (
    <TeamSection
      action={
        view.can.addPeople.allowed ? (
          <button className="btn btn--small" onClick={() => setAdding(true)} type="button">
            <Icon name="plus" /> Add people
          </button>
        ) : null
      }
      hint={`${peopleCount(audience.people)} can read ${project.name}’s chat, tasks and files, and start work in it. ${
        audience.managerCount ? `${peopleCount(audience.managerCount)} can manage who’s here.` : ""
      }`}
      id="team-project-people"
      title={`Who can use ${project.name}`}
    >
      <div className="card">
        {view.entries === null ? (
          <div className="card__empty">Only people who can manage {project.name} see its list.</div>
        ) : entries.length === 0 ? (
          <div className="card__empty">Nobody has been added yet.</div>
        ) : (
          entries.map((entry) => (
            <EntryRow
              entry={entry}
              key={entry.id}
              onChange={(level) => setEditing({ entry, level })}
              teamName={teamName}
              viewerId={viewerId}
              workspaceId={project.id}
            />
          ))
        )}
        {cursor ? (
          <button
            className="btn btn--ghost btn--small team-more"
            onClick={() =>
              void team
                .projectAccess({ workspaceId: project.id, cursor })
                .then((page) => {
                  setMore((current) => [...current, ...(page.entries?.items ?? [])]);
                  setCursor(page.entries?.nextCursor ?? null);
                })
                .catch(() => undefined)
            }
            type="button"
          >
            Show more
          </button>
        ) : null}
      </div>
      {adding || appointing ? (
        <AddPeopleDialog
          initialLevel={appointing ? "manage" : "use"}
          onClose={() => {
            setAdding(false);
            onAppointDone();
          }}
          onStale={access.reload}
          team={team}
          teamName={teamName}
          title={
            appointing ? `Appoint a manager for ${project.name}` : `Add people to ${project.name}`
          }
          view={view}
        />
      ) : null}
      {editing ? (
        <ChangeEntryDialog
          entry={editing.entry}
          level={editing.level}
          onClose={() => setEditing(null)}
          onStale={access.reload}
          projectName={project.name}
          revision={view.accessRevision}
          team={team}
          teamName={teamName}
        />
      ) : null}
    </TeamSection>
  );
}

function EntryRow({
  entry,
  onChange,
  teamName,
  viewerId,
  workspaceId,
}: {
  readonly entry: EntryView;
  readonly onChange: (level: Level | null) => void;
  readonly teamName: string;
  readonly viewerId: string | null;
  readonly workspaceId: string;
}) {
  const { subject } = entry;
  const mine = subject.kind === "person" && subject.userId === viewerId;
  const menu = [
    ...(entry.can.change.allowed
      ? (["use", "manage"] as const)
          .filter((level) => level !== entry.level)
          .map((level) => ({
            icon: level === "manage" ? ("key" as const) : ("user" as const),
            label: `Change to ${levelLabel(level)}`,
            onSelect: () => onChange(level),
          }))
      : []),
    ...(entry.can.revoke.allowed
      ? [
          {
            icon: "trash" as const,
            label: mine ? "Remove myself" : "Remove",
            danger: true,
            onSelect: () => onChange(null),
          },
        ]
      : []),
  ];
  return (
    <div className="card__row team-entry">
      <TeamAvatar group={subject.kind === "group"} name={subject.name} />
      <span className="card__row-body">
        <span className="card__row-title">
          {subject.name}
          {mine ? <span className="chip">You</span> : null}
          {subject.kind === "person" && subject.memberKind === "guest" ? (
            <span className="chip">Guest</span>
          ) : null}
          {subject.kind === "group" && subject.memberCount !== undefined ? (
            <span className="team-entry__count">{peopleCount(subject.memberCount)}</span>
          ) : null}
        </span>
        <span className="card__row-detail">
          {`Added by ${entry.grantedBy.name}, ${formatDay(entry.grantedAt)}`}
        </span>
      </span>
      <span className="card__row-actions team-entry__actions">
        <span className="team-entry__level">{levelLabel(entry.level)}</span>
        <WhyButton
          subject={subjectRef(subject)}
          name={subject.name}
          teamName={teamName}
          workspaceId={workspaceId}
        />
        {menu.length ? (
          <SurfaceMenu items={menu} label={`Change ${subject.name}’s access`} />
        ) : null}
      </span>
    </div>
  );
}

function WhyButton({
  name,
  subject,
  teamName,
  workspaceId,
}: {
  readonly name: string;
  readonly subject: Subject;
  readonly teamName: string;
  readonly workspaceId: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        className="link-btn team-why"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        type="button"
      >
        Why?
      </button>
      {anchor ? (
        <Popover
          anchor={anchor}
          align="end"
          below
          className="team-why-popover"
          label={`Why ${name} has access`}
          onClose={() => setAnchor(null)}
          role="dialog"
        >
          <WhyContent name={name} subject={subject} teamName={teamName} workspaceId={workspaceId} />
        </Popover>
      ) : null}
    </>
  );
}

export function WhyContent({
  name,
  subject,
  teamName,
  workspaceId,
}: {
  readonly name: string;
  readonly subject: Subject;
  readonly teamName: string;
  readonly workspaceId: string;
}) {
  const { team } = useShellTeam();
  const read = useHostRead<AccessExplanation>(
    team ? () => team.explain({ workspaceId, subject }) : null,
    `why:${workspaceId}:${subjectKey(subject)}`,
  );
  if (!read.data)
    return read.error ? (
      <TeamError error={read.error} team={teamName} />
    ) : (
      <p className="team-why__loading">Reading how {name} got access…</p>
    );
  const explanation = read.data;
  const paths = accessPaths(explanation);
  if (!explanation.effectiveLevel || paths.length === 0)
    return <p className="team-why__lead">{name} has no access to this project.</p>;
  return (
    <div className="team-why__body">
      <p className="team-why__lead">
        {name} {levelLabel(explanation.effectiveLevel).toLocaleLowerCase()} because:
      </p>
      <ul className="team-why__paths">
        {paths.map(({ entry, via }) => (
          <li key={`${entry.id}:${via.map((group) => group.id).join(">")}`}>
            {accessPathSentence(name, { entry, via })}
          </li>
        ))}
      </ul>
      {paths.length > 1 ? <p className="team-why__foot">The highest level counts.</p> : null}
      {explanation.truncated ? <p className="team-why__foot">Some paths aren’t shown.</p> : null}
    </div>
  );
}

function AddPeopleDialog({
  initialLevel,
  onClose,
  onStale,
  team,
  teamName,
  title,
  view,
}: {
  readonly initialLevel: Level;
  readonly onClose: () => void;
  readonly onStale: () => void;
  readonly team: TeamAccess;
  readonly teamName: string;
  readonly title: string;
  readonly view: ProjectAccessView;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [level, setLevel] = useState<Level>(initialLevel);
  const [picked, setPicked] = useState<{ subject: Subject; name: string; group: boolean }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useHostRead(
    debounced
      ? () => team.directory({ workspaceId: view.project.id, query: debounced, limit: 12 })
      : null,
    `directory:${view.project.id}:${debounced}`,
  );
  const changes = useMemo(
    () =>
      picked.length
        ? grantChanges(
            view.project.id,
            picked.map(({ subject }) => subject),
            level,
          )
        : null,
    [level, picked, view.project.id],
  );
  const { preview, error: previewError } = useAccessPreview(team, view.accessRevision, changes);
  const pickedKeys = new Set(picked.map(({ subject }) => (subject ? subjectKey(subject) : "")));
  const toggle = (subject: Subject, name: string, group: boolean) =>
    setPicked((current) =>
      pickedKeys.has(subjectKey(subject))
        ? current.filter((item) => subjectKey(item.subject) !== subjectKey(subject))
        : [...current, { subject, name, group }],
    );
  const people = results.data?.people ?? [];
  const groups = results.data?.groups ?? [];
  const count = picked.length;
  const stale = teamErrorIsStale(error) || teamErrorIsStale(previewError);
  return (
    <Dialog labelledBy="team-add-people" onClose={() => !pending && onClose()} title={title} wide>
      <div className="team-add">
        <label className="field">
          <span className="field__label">Find people or groups</span>
          <input
            autoFocus
            className="text-input"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name or group"
            type="search"
            value={query}
          />
        </label>
        {picked.length ? (
          <ul aria-label="Chosen" className="team-add__picked">
            {picked.map((item) => (
              <li className="chip chip--accent" key={subjectKey(item.subject)}>
                {item.name}
                <button
                  aria-label={`Remove ${item.name}`}
                  onClick={() => toggle(item.subject, item.name, item.group)}
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
            {results.data === null ? (
              results.error ? (
                <div className="card__empty">
                  <TeamError error={results.error} team={teamName} />
                </div>
              ) : (
                <LoadingRows label="Searching" rows={2} />
              )
            ) : people.length + groups.length === 0 ? (
              <div className="card__empty">
                Nobody in {teamName} matches “{debounced}”.
              </div>
            ) : (
              <>
                {groups.map((group) => (
                  <ResultRow
                    checked={pickedKeys.has(`group:${group.id}`)}
                    detail={group.builtin ? `Every member of ${teamName}` : "Group"}
                    group
                    key={group.id}
                    name={group.name}
                    onToggle={() => toggle({ kind: "group", groupId: group.id }, group.name, true)}
                  />
                ))}
                {people.map((person: PersonRef) => (
                  <ResultRow
                    checked={pickedKeys.has(`person:${person.id}`)}
                    detail="Person"
                    key={person.id}
                    name={person.name}
                    onToggle={() =>
                      toggle({ kind: "person", userId: person.id }, person.name, false)
                    }
                  />
                ))}
              </>
            )}
          </div>
        ) : (
          <p className="settings-footnote">Search the people and groups in {teamName}.</p>
        )}
        <div className="field">
          <span className="field__label">Level</span>
          <LevelPicker label="Level" onChange={setLevel} value={level} />
        </div>
        {count ? (
          <>
            <p className="team-add__consequence">
              {level === "manage"
                ? `They’ll read ${view.project.name}’s chat, tasks and files, work in it, and decide who else can.`
                : `They’ll read ${view.project.name}’s chat, tasks and files, and start work in it.`}
            </p>
            <AccessPreviewPanel preview={previewError ? null : preview} team={teamName} />
          </>
        ) : null}
        <TeamError
          error={error ?? previewError}
          onRetry={stale ? onStale : undefined}
          team={teamName}
        />
        <div className="form-actions">
          <button className="btn" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!changes || pending || !preview?.allowed}
            onClick={() => {
              if (!changes) return;
              setPending(true);
              setError(null);
              void team
                .applyAccess(view.accessRevision, changes)
                .then(onClose)
                .catch(setError)
                .finally(() => setPending(false));
            }}
            type="button"
          >
            {pending
              ? "Adding…"
              : count === 0
                ? "Add"
                : count === 1
                  ? `Add ${picked[0]!.name}`
                  : `Add ${count}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ResultRow({
  checked,
  detail,
  group = false,
  name,
  onToggle,
}: {
  readonly checked: boolean;
  readonly detail: string;
  readonly group?: boolean;
  readonly name: string;
  readonly onToggle: () => void;
}) {
  return (
    <label className="card__row team-result">
      <TeamAvatar group={group} name={name} />
      <span className="card__row-body">
        <span className="card__row-title">{name}</span>
        <span className="card__row-detail">{detail}</span>
      </span>
      <input checked={checked} className="team-check" onChange={onToggle} type="checkbox" />
    </label>
  );
}

function ChangeEntryDialog({
  entry,
  level,
  onClose,
  onStale,
  projectName,
  revision,
  team,
  teamName,
}: {
  readonly entry: EntryView;
  readonly level: Level | null;
  readonly onClose: () => void;
  readonly onStale: () => void;
  readonly projectName: string;
  readonly revision: number;
  readonly team: TeamAccess;
  readonly teamName: string;
}) {
  const changes = useMemo<AccessChange[]>(
    () => (level ? changeLevelChanges(entry, level) : [{ kind: "revoke", entryId: entry.id }]),
    [entry, level],
  );
  const name = entry.subject.name;
  return (
    <AccessChangeDialog
      changes={changes}
      confirm={level ? `Change to ${levelLabel(level)}` : "Remove"}
      danger={!level}
      onClose={onClose}
      onStale={onStale}
      revision={revision}
      team={team}
      teamName={teamName}
      title={
        level ? `Change ${name} to ${levelLabel(level)}?` : `Remove ${name} from ${projectName}?`
      }
    >
      {!level ? (
        <p className="settings-footnote">
          Removing this entry doesn’t take away access someone has another way, such as through a
          group.
        </p>
      ) : null}
    </AccessChangeDialog>
  );
}

export function projectUnavailable(error: unknown): boolean {
  const reason = teamReasonOf(error);
  return reason === "team-object-unavailable" || reason === "membership-lost";
}
