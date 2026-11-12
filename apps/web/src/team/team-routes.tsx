import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  createId,
  KnowledgeTopicIdSchema,
  TeamChannelIdSchema,
  TeamGroupIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import { usePagedList } from "@opensteer/client/react";
import { useWindowedRows } from "../components/workspace/windowed-rows.js";
import { unwrapRpcResult } from "@opensteer/client/host";
import { AreaHeader } from "../components/workspace/conversation-header.js";
import { useOptionalShell } from "../components/app-shell.js";
import { KnowledgeTab } from "../components/team/knowledge-tab.js";
import { PeopleOnlyBadge, PersonAvatar } from "../components/team/team-marks.js";
import { TeamSearch, noSearchFilters } from "../components/team/team-search.js";
import type { SearchFilters } from "../components/team/team-models.js";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
} from "../components/settings/primitives.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { ChannelRoute, TeamUnavailable } from "./channel-route.js";
import { useKnowledge } from "./team-knowledge.js";
import { channelPath, teamPath } from "./team-paths.js";
import { useTeamRead, useTeamView, type TeamView } from "./team-view.js";
import { channelKind, messageView, person } from "./team-view-models.js";

const noPreviews: ReadonlyMap<string, string> = new Map();

/** Everything under `/teams/:teamId/…` (D3 §A3). */
export function TeamRoutes() {
  const { teamId = "", "*": splat = "" } = useParams();
  const [section, ...rest] = splat.split("/").filter(Boolean);
  if (section === "c") return <ChannelRoute rest={rest} teamId={teamId} />;
  return <TeamPage rest={rest} section={section ?? ""} teamId={teamId} />;
}

function TeamPage({
  rest,
  section,
  teamId,
}: {
  readonly rest: readonly string[];
  readonly section: string;
  readonly teamId: string;
}) {
  const view = useTeamView(teamId, noPreviews);
  const hostClient = useOptionalShell()?.hostClient ?? null;
  if (!view) return <TeamUnavailable teamId={teamId} />;
  const title = (name: string) =>
    `${name} · ${view.snapshot.bootstrap?.teamName ?? view.team.name}`;
  const body =
    section === "knowledge" ? (
      <TeamKnowledge topicId={rest[0] ?? null} view={view} />
    ) : section === "search" ? (
      <TeamSearchPage view={view} />
    ) : section === "browse" ? (
      <BrowseChannels view={view} />
    ) : section === "people" ? (
      <NewMessage view={view} />
    ) : (
      <p className="team-empty">Nothing here.</p>
    );
  const names: Readonly<Record<string, string>> = {
    knowledge: "Knowledge",
    search: "Search",
    browse: "Channels",
    people: "New message",
  };
  return (
    <div className="thread team-page">
      <AreaHeader hostClient={hostClient} title={title(names[section] ?? "Team")} />
      <div className="team-page__body">{body}</div>
    </div>
  );
}

/** Every topic the reader can read: channel topics and shared ones, with managers' settings. */
function TeamKnowledge({
  topicId,
  view,
}: {
  readonly topicId: string | null;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const knowledge = useKnowledge(view, null, topicId);
  return (
    <div className="team-knowledge">
      <KnowledgeTab
        actions={{
          ...knowledge.actions,
          onSelectTopic: (next) => void navigate(teamPath(view.team.teamId, `knowledge/${next}`)),
        }}
        history={knowledge.history}
        selectedTopicId={knowledge.selectedTopicId}
        things={knowledge.things}
        topics={knowledge.topics}
      />
      {knowledge.current?.can.manage ? (
        <TopicSettings onChanged={knowledge.reloadTopics} topic={knowledge.current} view={view} />
      ) : null}
      {view.snapshot.bootstrap?.can.manageGroups ? (
        <NewTopic onCreated={knowledge.reloadTopics} view={view} />
      ) : null}
    </div>
  );
}

type Topic = NonNullable<ReturnType<typeof useKnowledge>["current"]>;
const topicLevels = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "manage", label: "Manage" },
] as const;

/** A topic's access list and its people-only switch, for those who manage it. */
function TopicSettings({
  onChanged,
  topic,
  view,
}: {
  readonly onChanged: () => void;
  readonly topic: Topic;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const report = (error: unknown) => toast.error(actionErrorMessage(error));
  const access = useTeamRead(
    () =>
      view.client.rpc["team.knowledge.topic.access.get"]({ topicId: topic.id }).then(
        unwrapRpcResult,
      ),
    `topic-access:${topic.id}`,
  );
  const groups = useTeamRead(
    () => view.client.rpc["team.groups.list"]({}).then(unwrapRpcResult),
    `groups:${view.team.teamId}`,
  );
  const [adding, setAdding] = useState("");
  const entries = access.value?.entries ?? [];
  const setEntries = (next: typeof entries) =>
    access.value &&
    void view.client.rpc["commands.dispatch"]({
      type: "team.knowledge.topic.access.set",
      topicId: topic.id,
      expectedRevision: access.value.revision,
      access: [...next],
    })
      .then(unwrapRpcResult)
      .then(access.reload)
      .catch(report);
  const subjectName = (entry: (typeof entries)[number]) =>
    entry.subject.kind === "person"
      ? person(view.words, entry.subject.userId).name
      : (groups.value?.groups.find(
          (group) => group.id === (entry.subject.kind === "group" ? entry.subject.groupId : ""),
        )?.name ?? "Group");
  return (
    <SettingsGroup heading={`${topic.name}: access`} headingId={`topic-${topic.id}`}>
      <SettingsRow
        action={
          <SettingsSwitch
            checked={topic.peopleOnly}
            label="People only"
            onChange={(peopleOnly) =>
              void view.client.rpc["commands.dispatch"]({
                type: "team.knowledge.topic.peopleOnly.set",
                topicId: topic.id,
                peopleOnly,
              })
                .then(unwrapRpcResult)
                .then(onChanged)
                .catch(report)
            }
          />
        }
        detail="Your agent can do whatever you can, unless the thing is marked people only."
        icon="user"
        title="People only"
      />
      {entries.map((entry, index) => (
        <SettingsRow
          action={
            <SettingsSegmented
              label={`Access for ${subjectName(entry)}`}
              onChange={(level) =>
                setEntries(entries.map((row, at) => (at === index ? { ...row, level } : row)))
              }
              options={topicLevels}
              value={entry.level}
            />
          }
          icon={entry.subject.kind === "person" ? "user" : "users"}
          key={JSON.stringify(entry.subject)}
          title={subjectName(entry)}
        />
      ))}
      <SettingsRow
        action={
          <select
            aria-label="Add a person or group"
            onChange={(event) => {
              const [kind, id] = event.currentTarget.value.split(":");
              setAdding("");
              if (!kind || !id) return;
              setEntries([
                ...entries,
                {
                  subject:
                    kind === "person"
                      ? { kind: "person", userId: UserIdSchema.parse(id) }
                      : { kind: "group", groupId: TeamGroupIdSchema.parse(id) },
                  level: "read",
                },
              ]);
            }}
            value={adding}
          >
            <option value="">Add…</option>
            {[...view.members.values()].map((member) => (
              <option key={member.userId} value={`person:${member.userId}`}>
                {member.displayName}
              </option>
            ))}
            {(groups.value?.groups ?? []).map((group) => (
              <option key={group.id} value={`group:${group.id}`}>
                {group.name}
              </option>
            ))}
          </select>
        }
        icon="plus"
        title="Add people or groups"
      />
    </SettingsGroup>
  );
}

function NewTopic({
  onCreated,
  view,
}: {
  readonly onCreated: () => void;
  readonly view: TeamView;
}) {
  const [name, setName] = useState("");
  const toast = useToast();
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !view.me) return;
    void view.client.rpc["commands.dispatch"]({
      type: "team.knowledge.topic.create",
      id: KnowledgeTopicIdSchema.parse(createId("knowledgeTopic")),
      name: name.trim(),
      peopleOnly: false,
      access: [{ subject: { kind: "person", userId: view.me.userId }, level: "manage" }],
    })
      .then(unwrapRpcResult)
      .then(() => {
        setName("");
        onCreated();
      })
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
  };
  return (
    <form className="team-inline-form" onSubmit={create}>
      <input
        aria-label="New shared topic"
        className="text-input"
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="New shared topic"
        value={name}
      />
      <button className="btn" disabled={!name.trim()} type="submit">
        Create topic
      </button>
    </form>
  );
}

/** Full message search in one team, with the four filters. */
function TeamSearchPage({ view }: { readonly view: TeamView }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get("q") ?? "";
  const filters = useMemo<SearchFilters>(
    () => ({
      ...noSearchFilters,
      channelId: params.get("in"),
      authorId: params.get("from"),
      hasFile: params.has("file"),
      inThreads: params.has("threads"),
    }),
    [params],
  );
  const run = (next: string, nextFilters: SearchFilters) =>
    setParams(
      {
        ...(next ? { q: next } : {}),
        ...(nextFilters.channelId ? { in: nextFilters.channelId } : {}),
        ...(nextFilters.authorId ? { from: nextFilters.authorId } : {}),
        ...(nextFilters.hasFile ? { file: "1" } : {}),
        ...(nextFilters.inThreads ? { threads: "1" } : {}),
      },
      { replace: true },
    );
  const toast = useToast();
  useEffect(() => {
    if (!query.trim()) return;
    const author = filters.authorId?.replace(/^agent:/u, "") ?? null;
    void view.client
      .search({
        query: query.trim(),
        ...(filters.channelId ? { channelId: TeamChannelIdSchema.parse(filters.channelId) } : {}),
        ...(author ? { authorUserId: UserIdSchema.parse(author) } : {}),
        ...(filters.hasFile ? { hasFile: true } : {}),
        ...(filters.inThreads ? { threadsOnly: true } : {}),
      })
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
  }, [view.client, query, filters, view.snapshot.sidebar?.accessRevision]);
  const channels = (view.snapshot.sidebar?.channels ?? []).map((row) => ({
    id: row.channel.id,
    name: row.channel.name,
    kind: channelKind(row.channel.kind),
  }));
  const results = view.snapshot.search?.results ?? null;
  const people = useMemo(
    () => [...view.members.values()].map((member) => person(view.words, member.userId)),
    [view.members, view.words],
  );
  return (
    <TeamSearch
      channels={channels}
      filters={filters}
      onFilters={(next) => {
        run(query, next);
      }}
      onOpenResult={(result) =>
        void navigate(
          channelPath(view.team.teamId, result.channel.id, { messageId: result.message.id }),
        )
      }
      onQuery={(next) => run(next, filters)}
      hasMore={view.snapshot.search?.hasMore ?? false}
      onMore={() =>
        void view.client
          .loadMoreSearch()
          .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      }
      people={people}
      query={query}
      results={
        results
          ? results.map((row) => ({
              message: messageView(view.words, row.message),
              channel: {
                id: row.message.channelId,
                name: row.source.audience.channelName,
                kind: channelKind(row.source.audience.channelKind),
              },
              threadOf: row.message.threadRootId ? "a thread" : null,
            }))
          : null
      }
    />
  );
}

/** Every channel the reader may see or join, and a new one. Any member creates channels. */
function BrowseChannels({ view }: { readonly view: TeamView }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const report = (error: unknown) => toast.error(actionErrorMessage(error));
  const list = usePagedList(
    (cursor) =>
      view.client.rpc["team.channels.list"](
        cursor ? { after: TeamChannelIdSchema.parse(cursor) } : {},
      )
        .then(unwrapRpcResult)
        .then((page) => ({
          items: page.channels,
          nextCursor: page.hasMore ? (page.channels.at(-1)?.id ?? null) : null,
        })),
    `channels:${view.team.teamId}:${view.snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const scroll = useRef<HTMLElement | null>(null),
    rowsRef = useRef<HTMLUListElement | null>(null);
  const channels = list.items.filter(
    (channel) => channel.kind === "public" || channel.kind === "private",
  );
  const plan = useWindowedRows({
    list: scroll,
    rows: rowsRef,
    keys: channels.map((channel) => channel.id),
    estimate: () => 44,
    pinned: [],
    all: false,
  });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const [peopleOnly, setPeopleOnly] = useState(false);
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !view.me) return;
    const id = TeamChannelIdSchema.parse(createId("teamChannel"));
    void view.client.rpc["commands.dispatch"]({
      type: "team.channel.create",
      id,
      kind,
      name: name.trim().replace(/^#/u, ""),
      peopleOnly,
      access:
        kind === "private"
          ? [{ subject: { kind: "person", userId: view.me.userId }, level: "post", manage: true }]
          : [],
    })
      .then(unwrapRpcResult)
      .then(() => void navigate(channelPath(view.team.teamId, id)))
      .catch(report);
  };
  return (
    <div
      className="team-browse"
      ref={(node) => {
        scroll.current = node?.parentElement ?? null;
      }}
    >
      {view.snapshot.bootstrap?.can.createChannel ? (
        <form className="team-inline-form" onSubmit={create}>
          <input
            aria-label="Channel name"
            autoFocus={params.has("new")}
            className="text-input"
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="New channel name"
            value={name}
          />
          <SettingsSegmented
            label="Who can find it"
            onChange={setKind}
            options={[
              { value: "public", label: "Public" },
              { value: "private", label: "Private" },
            ]}
            value={kind}
          />
          <SettingsSwitch checked={peopleOnly} label="People only" onChange={setPeopleOnly} />
          <button className="btn btn--primary" disabled={!name.trim()} type="submit">
            Create channel
          </button>
        </form>
      ) : null}
      <ul className="team-browse__list" ref={rowsRef}>
        {plan.map((entry, index) => {
          if ("spacer" in entry)
            return <li aria-hidden key={`spacer:${index}`} style={{ height: entry.spacer }} />;
          const channel = channels[entry.index]!;
          return (
            <li className="team-browse__row" data-motion-key={channel.id} key={channel.id}>
              <span className="team-browse__name">
                {channel.kind === "private" ? "🔒" : "#"} {channel.name}
              </span>
              {channel.peopleOnly ? <PeopleOnlyBadge compact /> : null}
              {channel.can.join ? (
                <button
                  className="btn btn--small"
                  onClick={() =>
                    void view.client.rpc["commands.dispatch"]({
                      type: "team.channel.join",
                      channelId: channel.id,
                    })
                      .then(unwrapRpcResult)
                      .then(() => void navigate(channelPath(view.team.teamId, channel.id)))
                      .catch(report)
                  }
                  type="button"
                >
                  Join
                </button>
              ) : (
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => void navigate(channelPath(view.team.teamId, channel.id))}
                  type="button"
                >
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {list.nextCursor ? (
        <button className="btn" disabled={list.loadingMore} onClick={list.more} type="button">
          {list.loadingMore ? "Loading…" : "More channels"}
        </button>
      ) : null}
      {list.error ? <p role="alert">{actionErrorMessage(list.error)}</p> : null}
    </div>
  );
}

/** A direct message with one person, or a few. */
function NewMessage({ view }: { readonly view: TeamView }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const words = query.trim().toLocaleLowerCase();
  const people = [...view.members.values()].filter(
    (member) =>
      member.state === "active" &&
      member.userId !== view.words.viewerUserId &&
      (!words ||
        member.displayName.toLocaleLowerCase().includes(words) ||
        member.handle.includes(words)),
  );
  return (
    <div className="team-browse">
      <input
        aria-label="Find a person"
        autoFocus
        className="text-input"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Find a person"
        value={query}
      />
      <ul className="team-browse__list">
        {people.map((member) => (
          <li className="team-browse__row" key={member.userId}>
            <PersonAvatar person={person(view.words, member.userId)} size={24} />
            <span className="team-browse__name">
              {member.displayName} <span className="team-browse__handle">@{member.handle}</span>
            </span>
            <button
              className="btn btn--small"
              onClick={() =>
                void view.client.rpc["commands.dispatch"]({
                  type: "team.dm.open",
                  participants: [member.userId],
                })
                  .then(unwrapRpcResult)
                  .then((result) => {
                    if (result.type === "team.dm.open")
                      void navigate(channelPath(view.team.teamId, result.channel.id));
                  })
                  .catch((error: unknown) => toast.error(actionErrorMessage(error)))
              }
              type="button"
            >
              Message
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
