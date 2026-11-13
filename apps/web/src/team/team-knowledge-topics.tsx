import { useEffect, useState } from "react";
import { createId, KnowledgeTopicIdSchema, type KnowledgeTopicId } from "@opensteer/core";
import type {
  TeamGroupSchema,
  TeamTopic,
  TeamTopicAccessEntry,
  TeamTopicLevel,
  TeamTopicSubject,
} from "@opensteer/protocol";
import { teamKnowledgeLimits } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import {
  isTopicAccessConflict,
  sameTopicAccess,
  topicEveryoneLevel,
  topicSubjectKey,
  withoutTopicSubject,
  withTopicEveryone,
  withTopicSubject,
  type TopicEveryoneLevel,
} from "@opensteer/client/team";
import type { z } from "zod";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icon.js";
import { LoadingRows } from "../components/loading-rows.js";
import { SegmentedControl } from "../components/segmented-control.js";
import { PersonAvatar } from "../components/team/team-marks.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeamRead, type TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

type Named = Exclude<TeamTopicSubject, { kind: "everyone" }>;
type TeamGroup = z.infer<typeof TeamGroupSchema>;
const levelWords: Readonly<Record<TeamTopicLevel, string>> = {
  read: "Read",
  write: "Write",
  manage: "Manage",
};
const levels = (["read", "write", "manage"] as const).map((value) => ({
  value,
  label: levelWords[value],
}));
const everyoneLevels = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
] as const satisfies readonly { value: TopicEveryoneLevel; label: string }[];

function useGroups(view: TeamView) {
  return useTeamRead(
    () => view.client.rpc["team.groups.list"]({}).then(unwrapRpcResult),
    `groups:${view.team.teamId}`,
  );
}

function teamName(view: TeamView): string {
  return view.snapshot.bootstrap?.teamName ?? view.team.name;
}

/** A new topic: any member makes one, and the team Host makes them its manager. */
export function NewTopicDialog({
  onClose,
  onCreated,
  view,
}: {
  readonly onClose: () => void;
  readonly onCreated: (topicId: KnowledgeTopicId) => void;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const [id] = useState(() => KnowledgeTopicIdSchema.parse(createId("knowledgeTopic")));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [who, setWho] = useState<"everyone" | "chosen">("everyone");
  const [chosen, setChosen] = useState<TeamTopicAccessEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const groups = useGroups(view);
  const ready = name.trim().length > 0 && !saving;
  const create = () => {
    if (!ready) return;
    setSaving(true);
    void view.client.rpc["commands.dispatch"]({
      type: "team.knowledge.topic.create",
      id,
      name: name.trim(),
      description: description.trim(),
      access: who === "everyone" ? [{ subject: { kind: "everyone" }, level: "write" }] : chosen,
    })
      .then(unwrapRpcResult)
      .then(() => {
        onClose();
        onCreated(id);
      })
      .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!ready} onClick={create} type="button">
            {saving ? "Creating…" : "Create topic"}
          </button>
        </>
      }
      labelledBy="knowledge-new-topic"
      onClose={onClose}
      title="New topic"
    >
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <TopicFields
          description={description}
          name={name}
          onDescription={setDescription}
          onName={setName}
        />
        <div className="field">
          <span className="field__label" id="knowledge-new-topic-who">
            Who can read it
          </span>
          <SegmentedControl
            ariaLabel="Who can read it"
            onChange={setWho}
            options={[
              { value: "everyone", label: "Everyone" },
              { value: "chosen", label: "Only people I choose" },
            ]}
            value={who}
          />
          <span className="field__hint">
            {who === "everyone"
              ? `Everyone in ${teamName(view)} can read and write it, and their agents can for them.`
              : "You manage it. Add the people and groups who should read or write it."}
          </span>
        </div>
        {who === "chosen" ? (
          <AccessEditor
            creator
            defaultLevel="write"
            entries={chosen}
            groups={groups.value?.groups ?? []}
            onChange={setChosen}
            view={view}
          />
        ) : null}
        <button hidden type="submit" />
      </form>
    </Dialog>
  );
}

/** A topic's name and what belongs in it, for its managers. */
export function EditTopicDialog({
  onClose,
  onSaved,
  topic,
  view,
}: {
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly topic: TeamTopic;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const [name, setName] = useState(topic.name);
  const [description, setDescription] = useState(topic.description);
  const [saving, setSaving] = useState(false);
  const ready =
    name.trim().length > 0 &&
    !saving &&
    (name.trim() !== topic.name || description.trim() !== topic.description);
  const save = () => {
    if (!ready) return;
    setSaving(true);
    void view.client.rpc["commands.dispatch"]({
      type: "team.knowledge.topic.update",
      topicId: topic.id,
      name: name.trim(),
      description: description.trim(),
    })
      .then(unwrapRpcResult)
      .then(onSaved)
      .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!ready} onClick={save} type="button">
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
      labelledBy="knowledge-edit-topic"
      onClose={onClose}
      title="Edit topic"
    >
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <TopicFields
          description={description}
          name={name}
          onDescription={setDescription}
          onName={setName}
        />
        <button hidden type="submit" />
      </form>
    </Dialog>
  );
}

function TopicFields({
  description,
  name,
  onDescription,
  onName,
}: {
  readonly description: string;
  readonly name: string;
  readonly onDescription: (value: string) => void;
  readonly onName: (value: string) => void;
}) {
  return (
    <>
      <label className="field">
        <span className="field__label">Name</span>
        <input
          autoFocus
          className="text-input"
          maxLength={teamKnowledgeLimits.topicNameChars}
          onChange={(event) => onName(event.currentTarget.value)}
          placeholder="Customers"
          value={name}
        />
      </label>
      <label className="field">
        <span className="field__label">Description</span>
        <textarea
          className="text-input knowledge-form__description"
          maxLength={teamKnowledgeLimits.descriptionChars}
          onChange={(event) => onDescription(event.currentTarget.value)}
          placeholder="What belongs here?"
          rows={2}
          value={description}
        />
        <span className="field__hint">
          People and agents read this to decide what to save here.
        </span>
      </label>
    </>
  );
}

/**
 * Who can use a topic. Managers change the whole list and save it on the revision they read;
 * everyone else sees it. A manager who isn't on the list still manages it, without reading.
 */
export function TopicAccessDialog({
  onClose,
  onSaved,
  topic,
  view,
}: {
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly topic: TeamTopic;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const access = useTeamRead(
    () =>
      view.client.rpc["team.knowledge.topic.access.get"]({ topicId: topic.id }).then(
        unwrapRpcResult,
      ),
    `topic-access:${view.team.teamId}:${topic.id}`,
  );
  const groups = useGroups(view);
  const [draft, setDraft] = useState<TeamTopicAccessEntry[] | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (access.value) setDraft([...access.value.entries]);
  }, [access.value]);
  const manage = access.value?.can.manage === true;
  const changed = !!draft && !!access.value && !sameTopicAccess(draft, access.value.entries);
  const save = () => {
    if (!draft || !access.value || !changed || saving) return;
    setSaving(true);
    void view.client.rpc["commands.dispatch"]({
      type: "team.knowledge.topic.access.set",
      topicId: topic.id,
      expectedRevision: access.value.revision,
      access: draft,
    })
      .then(unwrapRpcResult)
      .then(onSaved)
      .catch((error: unknown) => {
        if (isTopicAccessConflict(error)) setStale(true);
        else toast.error(actionErrorMessage(error));
      })
      .finally(() => setSaving(false));
  };
  return (
    <Dialog
      footer={
        manage ? (
          <>
            <span className="knowledge-access__foot">
              Agents can read and write what their person can.
            </span>
            <button className="btn btn--ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!changed || saving || stale}
              onClick={save}
              type="button"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose} type="button">
            Done
          </button>
        )
      }
      labelledBy="knowledge-access-title"
      onClose={onClose}
      title={`Who can use ${topic.name}`}
      wide
    >
      {!topic.can.read && topic.can.manage ? (
        <div className="notice knowledge__notice">
          <Icon name="lock" />
          <div>You manage this topic but can’t read its notes.</div>
        </div>
      ) : null}
      {stale ? (
        <div className="notice notice--warn knowledge__notice">
          <Icon name="alert-circle" />
          <div>This list changed; reload it.</div>
          <button
            className="btn btn--small"
            onClick={() => {
              setStale(false);
              access.reload();
            }}
            type="button"
          >
            Reload
          </button>
        </div>
      ) : null}
      {access.error ? (
        <p className="knowledge__empty">{access.error}</p>
      ) : !draft ? (
        <LoadingRows label="Loading access" />
      ) : (
        <>
          <div className="knowledge-access__everyone">
            <span className="knowledge-access__mark" aria-hidden>
              <Icon name="globe" />
            </span>
            <span className="knowledge-access__who">
              <span className="knowledge-access__name">Everyone in {teamName(view)}</span>
              <span className="knowledge-access__detail">Including people who join later</span>
            </span>
            {manage ? (
              <SegmentedControl
                ariaLabel="Everyone"
                onChange={(level) => setDraft(withTopicEveryone(draft, level))}
                options={everyoneLevels}
                value={topicEveryoneLevel(draft)}
              />
            ) : (
              <span className="knowledge-access__level">
                {everyoneLevels.find((option) => option.value === topicEveryoneLevel(draft))?.label}
              </span>
            )}
          </div>
          <AccessEditor
            defaultLevel="read"
            editable={manage}
            entries={draft}
            groups={groups.value?.groups ?? []}
            onChange={setDraft}
            view={view}
          />
        </>
      )}
    </Dialog>
  );
}

/** People and groups on a topic's list, each at a level, and a way to add more. */
function AccessEditor({
  creator = false,
  defaultLevel,
  editable = true,
  entries,
  groups,
  onChange,
  view,
}: {
  /** A new topic's list: its creator manages it already, so they're shown and not offered. */
  readonly creator?: boolean;
  readonly defaultLevel: TeamTopicLevel;
  readonly editable?: boolean;
  readonly entries: readonly TeamTopicAccessEntry[];
  readonly groups: readonly TeamGroup[];
  readonly onChange: (entries: TeamTopicAccessEntry[]) => void;
  readonly view: TeamView;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const named = entries.filter(
    (entry): entry is TeamTopicAccessEntry & { subject: Named } =>
      entry.subject.kind !== "everyone",
  );
  const listed = new Set(named.map((entry) => topicSubjectKey(entry.subject)));
  const words = query.trim().toLocaleLowerCase();
  const candidates: { subject: Named; name: string; detail: string }[] = [
    ...groups.map((group) => ({
      subject: { kind: "group" as const, groupId: group.id },
      name: group.name,
      detail: `Group · ${group.people.length} ${group.people.length === 1 ? "person" : "people"}`,
    })),
    ...[...view.members.values()]
      .filter(
        (member) =>
          member.state === "active" && !(creator && member.userId === view.words.viewerUserId),
      )
      .map((member) => ({
        subject: { kind: "person" as const, userId: member.userId },
        name: member.displayName,
        detail: `@${member.handle}`,
      })),
  ].filter(
    (candidate) =>
      !listed.has(topicSubjectKey(candidate.subject)) &&
      (!words ||
        candidate.name.toLocaleLowerCase().includes(words) ||
        candidate.detail.toLocaleLowerCase().includes(words)),
  );
  const describe = (subject: Named) => {
    if (subject.kind === "person") {
      const face = person(view.words, subject.userId);
      return {
        mark: <PersonAvatar person={face} size={28} />,
        name: face.you ? `${face.name} (you)` : face.name,
        detail: `@${face.handle}`,
      };
    }
    const group = groups.find((row) => row.id === subject.groupId);
    return {
      mark: (
        <span className="knowledge-access__mark" aria-hidden>
          <Icon name="users" />
        </span>
      ),
      name: group?.name ?? "Group",
      detail: group
        ? `Group · ${group.people.length} ${group.people.length === 1 ? "person" : "people"}`
        : "Group",
    };
  };
  return (
    <section className="knowledge-access" aria-label="People and groups">
      <h3 className="knowledge-access__heading">People and groups</h3>
      {creator ? (
        <div className="knowledge-access__row">
          <PersonAvatar person={person(view.words, view.words.viewerUserId)} size={28} />
          <span className="knowledge-access__who">
            <span className="knowledge-access__name">You</span>
            <span className="knowledge-access__detail">You made it</span>
          </span>
          <span className="knowledge-access__level">Manage</span>
        </div>
      ) : null}
      {creator && named.length === 0 ? null : named.length === 0 ? (
        <p className="knowledge-access__none">
          {editable ? "No one yet." : "No one is listed by name."}
        </p>
      ) : (
        <ul className="knowledge-access__list">
          {named.map((entry) => {
            const shown = describe(entry.subject);
            return (
              <li className="knowledge-access__row" key={topicSubjectKey(entry.subject)}>
                {shown.mark}
                <span className="knowledge-access__who">
                  <span className="knowledge-access__name">{shown.name}</span>
                  <span className="knowledge-access__detail">{shown.detail}</span>
                </span>
                {editable ? (
                  <>
                    <SegmentedControl
                      ariaLabel={`${shown.name} can`}
                      onChange={(level) =>
                        onChange(withTopicSubject(entries, entry.subject, level))
                      }
                      options={levels}
                      value={entry.level}
                    />
                    <button
                      aria-label={`Remove ${shown.name}`}
                      className="icon-btn icon-btn--small"
                      onClick={() => onChange(withoutTopicSubject(entries, entry.subject))}
                      type="button"
                    >
                      <Icon name="close" />
                    </button>
                  </>
                ) : (
                  <span className="knowledge-access__level">{levelWords[entry.level]}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        adding ? (
          <div className="knowledge-access__add">
            <label className="team-search-field">
              <Icon name="search" />
              <input
                aria-label="Find people or groups"
                autoFocus
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setAdding(false);
                    setQuery("");
                  }
                }}
                placeholder="Find people or groups"
                value={query}
              />
            </label>
            <ul className="knowledge-access__candidates">
              {candidates.slice(0, 8).map((candidate) => (
                <li key={topicSubjectKey(candidate.subject)}>
                  <button
                    className="picker__row"
                    onClick={() => {
                      onChange(withTopicSubject(entries, candidate.subject, defaultLevel));
                      setQuery("");
                    }}
                    type="button"
                  >
                    {describe(candidate.subject).mark}
                    <span className="knowledge-access__who">
                      <span className="knowledge-access__name">{candidate.name}</span>
                      <span className="knowledge-access__detail">{candidate.detail}</span>
                    </span>
                    <Icon name="plus" />
                  </button>
                </li>
              ))}
              {candidates.length === 0 ? (
                <li className="knowledge-access__none">
                  {words ? `No one matches “${query.trim()}”.` : "Everyone is already listed."}
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <button
            className="btn btn--small knowledge-access__open"
            onClick={() => setAdding(true)}
            type="button"
          >
            <Icon name="plus" />
            Add people or groups
          </button>
        )
      ) : null}
    </section>
  );
}
