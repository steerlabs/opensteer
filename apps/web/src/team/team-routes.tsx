import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { TeamChannelIdSchema, UserIdSchema } from "@opensteer/core";
import type { TeamChannelSummary } from "@opensteer/protocol";
import { browsableChannels, channelNameFromInput } from "@opensteer/client/team";
import { useChannelDirectory, usePagedList } from "@opensteer/client/react";
import { useWindowedRows } from "../components/workspace/windowed-rows.js";
import { unwrapRpcResult } from "@opensteer/client/host";
import { AreaHeader } from "../components/workspace/conversation-header.js";
import { useOptionalShell } from "../components/app-shell.js";
import { Icon } from "../components/icon.js";
import { LoadingRows } from "../components/loading-rows.js";
import { ChannelGlyph, PeopleOnlyBadge } from "../components/team/team-marks.js";
import { TeamSearch, noSearchFilters } from "../components/team/team-search.js";
import type { SearchFilters } from "../components/team/team-models.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { ChannelRoute, TeamUnavailable } from "./channel-route.js";
import { useTeamAttachment, useTeamSession } from "./team-attachments.js";
import { TeamKnowledge } from "./team-knowledge.js";
import { channelPath, teamPath } from "./team-paths.js";
import { useTeamView, type TeamView } from "./team-view.js";
import { useTeamDialogs } from "./hosted-teams.js";
import { channelKind, messageView, person } from "./team-view-models.js";

const noPreviews: ReadonlyMap<string, string> = new Map();

/** Everything under `/teams/:teamId/…` (D3 §A3). */
export function TeamRoutes() {
  const { teamId = "", "*": splat = "" } = useParams();
  const [section, ...rest] = splat.split("/").filter(Boolean);
  if (section === "c") return <ChannelRoute rest={rest} teamId={teamId} />;
  if (!section) return <TeamLanding teamId={teamId} />;
  return <TeamPage rest={rest} section={section ?? ""} teamId={teamId} />;
}

/** A team's own address lands in #general once its sidebar has loaded. */
function TeamLanding({ teamId }: { readonly teamId: string }) {
  const team = useTeamAttachment(teamId);
  const snapshot = useTeamSession(team?.client ?? null);
  const channels = snapshot?.sidebar?.channels ?? null;
  if (!team) return <TeamUnavailable teamId={teamId} />;
  if (!channels) return null;
  const general =
    channels.find((row) => row.channel.id === snapshot?.bootstrap?.generalChannelId) ??
    channels.find((row) => row.channel.name === "general") ??
    channels.find((row) => row.channel.kind === "public");
  return (
    <Navigate
      replace
      to={general ? channelPath(teamId, general.channel.id) : teamPath(teamId, "browse")}
    />
  );
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
      <TeamKnowledge rest={rest} view={view} />
    ) : section === "search" ? (
      <TeamSearchPage view={view} />
    ) : section === "browse" ? (
      <BrowseChannels view={view} />
    ) : (
      <p className="team-empty">Nothing here.</p>
    );
  const names: Readonly<Record<string, string>> = {
    knowledge: "Knowledge",
    search: "Search",
    browse: "Channels",
  };
  return (
    <div className="thread team-page">
      <AreaHeader hostClient={hostClient} title={title(names[section] ?? "Team")} />
      <div className="team-page__body">{body}</div>
    </div>
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
  const directory = usePagedList(
    (cursor) =>
      view.client.rpc["team.channels.list"](
        cursor ? { after: TeamChannelIdSchema.parse(cursor) } : {},
      )
        .then(unwrapRpcResult)
        .then((page) => ({
          items: page.channels,
          nextCursor: page.hasMore ? (page.channels.at(-1)?.id ?? null) : null,
        })),
    `search-channels:${view.team.teamId}:${view.snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const channels = directory.items
    .filter((channel) => channel.can.read)
    .map((channel) => ({ id: channel.id, name: channel.name, kind: channelKind(channel.kind) }));
  const results = view.snapshot.search?.results ?? null;
  const people = useMemo(
    () => [...view.members.values()].map((member) => person(view.words, member.userId)),
    [view.members, view.words],
  );
  return (
    <TeamSearch
      channels={channels}
      onMoreChannels={directory.nextCursor ? directory.more : undefined}
      loadingChannels={directory.loadingMore}
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

/**
 * Every channel the reader may find, to open or to join, and a new one where the team lets
 * them make it. The whole directory is read so it can be searched and kept in name order.
 */
function BrowseChannels({ view }: { readonly view: TeamView }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { openNewChannel } = useTeamDialogs();
  const [query, setQuery] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const teamId = view.team.teamId;
  const teamName = view.snapshot.bootstrap?.teamName ?? view.team.name;
  const canCreate = view.snapshot.bootstrap?.can.createChannel === true;
  const directory = useChannelDirectory(
    view.client,
    `channels:${teamId}:${view.snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const channels = useMemo(
    () => browsableChannels(directory.items, query),
    [directory.items, query],
  );
  const words = channelNameFromInput(query);
  const scroll = useRef<HTMLElement | null>(null),
    rows = useRef<HTMLUListElement | null>(null);
  const plan = useWindowedRows({
    list: scroll,
    rows,
    keys: channels.map((channel) => channel.id),
    estimate: () => 48,
    pinned: [],
    all: false,
  });
  const open = (channel: TeamChannelSummary) => {
    if (channel.can.read) {
      void navigate(channelPath(teamId, channel.id));
      return;
    }
    if (!channel.can.join || joining) return;
    setJoining(channel.id);
    void view.client.rpc["commands.dispatch"]({ type: "team.channel.join", channelId: channel.id })
      .then(unwrapRpcResult)
      .then(() => void navigate(channelPath(teamId, channel.id)))
      .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      .finally(() => setJoining(null));
  };
  const first = channels[0];
  return (
    <div
      className="team-browse"
      ref={(node) => {
        scroll.current = node?.parentElement ?? null;
      }}
    >
      <header className="team-browse__head">
        <div className="team-browse__titles">
          <h1 className="team-browse__title">Channels</h1>
          <p className="team-browse__lead">
            {canCreate
              ? `Join a conversation in ${teamName}, or start one.`
              : `Join a conversation in ${teamName}.`}
          </p>
        </div>
        {canCreate ? (
          <button
            className="btn btn--small btn--primary"
            onClick={() => openNewChannel(teamId)}
            type="button"
          >
            <Icon name="plus" />
            New channel
          </button>
        ) : null}
      </header>
      <label className="team-search-field team-browse__search">
        <Icon name="search" />
        <input
          aria-label="Find a channel"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            } else if (event.key === "Enter") {
              if (first) open(first);
              else if (canCreate && words) openNewChannel(teamId, words);
            }
          }}
          placeholder="Find a channel"
          type="search"
          value={query}
        />
      </label>
      {directory.loading ? (
        <LoadingRows label="Loading channels" />
      ) : directory.error !== null && directory.items.length === 0 ? (
        <div className="team-browse__empty" role="alert">
          <p>{actionErrorMessage(directory.error)}</p>
          <button className="btn btn--small" onClick={directory.reload} type="button">
            Try again
          </button>
        </div>
      ) : channels.length === 0 ? (
        <div className="team-browse__empty">
          <p>{words ? `No channel called “${words}”.` : `${teamName} has no channels yet.`}</p>
          {canCreate ? (
            <button
              className="btn btn--small"
              onClick={() => openNewChannel(teamId, words)}
              type="button"
            >
              <Icon name="plus" />
              {words ? `Create #${words}` : "New channel"}
            </button>
          ) : null}
        </div>
      ) : (
        <ul aria-label={`${teamName} channels`} className="team-browse__list" ref={rows}>
          {plan.map((entry, index) => {
            if ("spacer" in entry)
              return <li aria-hidden key={`spacer:${index}`} style={{ height: entry.spacer }} />;
            const channel = channels[entry.index]!;
            return (
              <li data-motion-key={channel.id} key={channel.id}>
                <BrowseRow
                  channel={channel}
                  joining={joining === channel.id}
                  onOpen={open}
                  top={entry.index === 0 && words !== ""}
                />
              </li>
            );
          })}
        </ul>
      )}
      {!words && channels.length === 1 && canCreate ? (
        <p className="team-browse__hint">
          It’s just #{channels[0]!.name} so far. Start a channel for a project, a topic or a group
          of people.
        </p>
      ) : null}
    </div>
  );
}

function BrowseRow({
  channel,
  joining,
  onOpen,
  top,
}: {
  readonly channel: TeamChannelSummary;
  readonly joining: boolean;
  readonly onOpen: (channel: TeamChannelSummary) => void;
  /** The match Enter opens. */
  readonly top: boolean;
}) {
  const state = channel.archivedAt
    ? "Archived"
    : channel.can.read
      ? "Joined"
      : channel.can.join
        ? null
        : "Members only";
  return (
    <button
      aria-label={[
        `${channel.kind === "private" ? "Private channel" : "Channel"} ${channel.name}`,
        channel.peopleOnly ? "people only" : null,
        state ?? "join",
      ]
        .filter(Boolean)
        .join(", ")}
      className={top ? "team-browse__row is-top" : "team-browse__row"}
      disabled={!channel.can.read && !channel.can.join}
      onClick={() => onOpen(channel)}
      type="button"
    >
      <span aria-hidden className="team-browse__glyph">
        <ChannelGlyph kind={channelKind(channel.kind)} />
      </span>
      <span className="team-browse__name">{channel.name}</span>
      {channel.peopleOnly ? <PeopleOnlyBadge /> : null}
      {state ? (
        <span aria-hidden className="team-browse__state">
          {state === "Joined" ? <Icon name="check" /> : null}
          {state}
        </span>
      ) : (
        <span aria-hidden className="team-browse__join">
          {joining ? "Joining…" : "Join"}
        </span>
      )}
    </button>
  );
}
