import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  KnowledgeTopicIdSchema,
  TeamAgentRequestIdSchema,
  UserIdSchema,
  type TeamChannelId,
} from "@opensteer/core";
import { teamPageUrl } from "@opensteer/core";
import type { TeamChannel, TeamFileSchema } from "@opensteer/protocol";
import { readTeamReply, unwrapRpcResult } from "@opensteer/client/host";
import type { TeamTimeline } from "@opensteer/client/team";
import type { z } from "zod";
import { useOptionalShell } from "../components/app-shell.js";
import { ChannelDetails, MembersPane } from "../components/team/channel-details.js";
import { FilesTab, PinnedTab } from "../components/team/channel-tabs.js";
import {
  ChannelIntro,
  ChannelMessages,
  ChannelScreen,
  ThreadPane,
} from "../components/team/channel-view.js";
import { KnowledgeTab } from "../components/team/knowledge-tab.js";
import { MessageList } from "../components/team/message-list.js";
import { AgentUnavailable, TeamComposer } from "../components/team/team-composer.js";
import type {
  ChannelTab,
  ChannelView,
  FileView,
  MessageView,
  MyAgentHere,
  NotifyLevel,
  StagedFileView,
  TeamSend,
} from "../components/team/team-models.js";
import { ConnectionBanner } from "../components/team/team-status.js";
import { useToast } from "../components/toast.js";
import { useWorkspace } from "../components/workspace/workspace-context.js";
import { DrawerButton } from "../components/workspace/place-stage.js";
import { SidebarRestoreButton } from "../components/sidebar-chrome.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeams } from "./team-attachments.js";
import { useKnowledge } from "./team-knowledge.js";
import { channelPath } from "./team-paths.js";
import { teamMessage } from "./team-send.js";
import { prepareTeamUpload } from "./team-upload.js";
import { useTeamRead, useTeamView, type TeamView } from "./team-view.js";
import {
  channelKind,
  compareIds,
  messageView,
  pendingView,
  person,
  timelineItems,
} from "./team-view-models.js";

type TeamFile = z.infer<typeof TeamFileSchema>;

/** Where in a channel the address points. */
interface ChannelPlace {
  readonly tab: ChannelTab;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly topicId: string | null;
}

function placeOf(rest: readonly string[]): ChannelPlace {
  const [first, second, third, fourth] = rest;
  if (first === "t" && second)
    return {
      tab: "messages",
      threadId: second,
      messageId: third === "m" ? (fourth ?? null) : null,
      topicId: null,
    };
  if (first === "m" && second)
    return { tab: "messages", threadId: null, messageId: second, topicId: null };
  if (first === "files" || first === "pinned")
    return { tab: first, threadId: null, messageId: null, topicId: null };
  if (first === "knowledge")
    return { tab: "knowledge", threadId: null, messageId: null, topicId: second ?? null };
  return { tab: "messages", threadId: null, messageId: null, topicId: null };
}

/** Object URLs for the small previews this screen has read, revoked when it closes. */
function usePreviews() {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
    },
    [],
  );
  const want = useCallback((view: TeamView | null, files: readonly TeamFile[]) => {
    if (!view) return;
    for (const file of files) {
      if (!file.preview || asked.current.has(file.id)) continue;
      asked.current.add(file.id);
      void view.client
        .file(file)
        .then((blob) => {
          if (blob)
            setPreviews((current) => new Map([...current, [file.id, URL.createObjectURL(blob)]]));
        })
        .catch(() => undefined);
    }
  }, []);
  return { previews, want };
}

export function ChannelRoute({
  teamId,
  rest,
}: {
  readonly teamId: string;
  readonly rest: readonly string[];
}) {
  const channelId = TeamChannelIdSchema.safeParse(rest[0]).data ?? null;
  const place = placeOf(rest.slice(1));
  const { previews, want } = usePreviews();
  const view = useTeamView(teamId, previews);
  const client = view?.client ?? null;
  useEffect(() => {
    if (!client || !channelId) return;
    client.selectChannel(channelId);
    return () => client.selectChannel(null);
  }, [channelId, client]);
  const threadRoot = place.threadId
    ? (TeamMessageIdSchema.safeParse(place.threadId).data ?? null)
    : null;
  useEffect(() => {
    if (client && channelId) client.selectThread(channelId, threadRoot);
  }, [channelId, client, threadRoot]);
  const channelTimeline = view?.snapshot.channel ?? null;
  const threadTimeline = view?.snapshot.thread ?? null;
  useEffect(() => {
    want(
      view,
      [...(channelTimeline?.messages ?? []), ...(threadTimeline?.messages ?? [])].flatMap(
        (message) => message.attachments,
      ),
    );
  }, [channelTimeline, threadTimeline, view, want]);
  if (!channelId) return <p className="team-empty">This channel link isn’t valid.</p>;
  if (!view) return <TeamUnavailable teamId={teamId} />;
  return (
    <ChannelScreenFor
      channelId={channelId}
      place={place}
      timeline={channelTimeline}
      thread={threadTimeline}
      view={view}
    />
  );
}

export function TeamUnavailable({ teamId }: { readonly teamId: string }) {
  const { teams } = useTeams();
  const team = teams.find((candidate) => candidate.teamId === teamId);
  if (!team) return <p className="team-empty">You aren’t in this team on this computer.</p>;
  return (
    <div className="team-empty">
      <p>{team.name} opens at its own address here.</p>
      <a className="btn" href={team.origin} rel="noreferrer" target="_blank">
        Open {team.name}
      </a>
    </div>
  );
}

function channelView(view: TeamView, channel: TeamChannel | null, channelId: string): ChannelView {
  const entry = view.snapshot.sidebar?.channels.find(
    (row) => row.channel.id === channelId,
  )?.channel;
  const summary = channel ?? entry;
  return {
    id: channelId,
    kind: channelKind(summary?.kind ?? "public"),
    name: summary?.name ?? "channel",
    description: "",
    peopleOnly: summary?.peopleOnly ?? false,
    memberCount: null,
    faces: [],
    instructions: channel?.instructionsMarkdown
      ? { text: channel.instructionsMarkdown, changedBy: "", changedAt: "" }
      : null,
    createdBy: "",
    createdAt: "",
    fileCount: 0,
    pinCount: 0,
    canManage: summary?.can.manage ?? false,
  };
}

function ChannelScreenFor({
  channelId,
  place,
  thread,
  timeline,
  view,
}: {
  readonly channelId: TeamChannelId;
  readonly place: ChannelPlace;
  readonly thread: TeamTimeline | null;
  readonly timeline: TeamTimeline | null;
  readonly view: TeamView;
}) {
  const { client, snapshot, team, words } = view;
  const navigate = useNavigate();
  const { search } = useLocation();
  const { drawer, selection, work } = useWorkspace();
  const hostClient = useOptionalShell()?.hostClient ?? null;
  const { links, surface } = useTeams();
  const toast = useToast();
  const report = (error: unknown) => toast.error(actionErrorMessage(error));
  const docked = selection.kind === "place";
  const channel = channelView(view, timeline?.channel ?? null, channelId);
  const entry = snapshot.sidebar?.channels.find((row) => row.channel.id === channelId);
  const can = timeline?.channel?.can ?? entry?.channel.can ?? null;
  const go = (path: string, keepPlace = true) =>
    void navigate({ pathname: path, search: keepPlace ? search : "" });
  const params = new URLSearchParams(search);
  const pane = params.get("details") ? "details" : params.get("members") ? "members" : null;
  const setPane = (next: "details" | "members" | null) => {
    const updated = new URLSearchParams(search);
    updated.delete("details");
    updated.delete("members");
    if (next) updated.set(next, "1");
    void navigate({ search: updated.toString() ? `?${updated}` : "" });
  };

  /* ---- Sending ---- */
  const [staged, setStaged] = useState<readonly (StagedFileView & { file: TeamFile | null })[]>([]);
  const uploads = useRef(new Map<string, Promise<TeamFile | null>>());
  const addFiles = (files: readonly File[]) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      setStaged((current) => [
        ...current,
        {
          id,
          name: file.name,
          mediaType: file.type,
          sizeBytes: file.size,
          status: "uploading",
          file: null,
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        },
      ]);
      const done = prepareTeamUpload(channelId, file)
        .then((upload) => client.upload(upload))
        .then((uploaded) => {
          setStaged((current) =>
            current.map((row) =>
              row.id === id ? { ...row, status: "ready", file: uploaded } : row,
            ),
          );
          return uploaded;
        })
        .catch((error: unknown) => {
          setStaged((current) =>
            current.map((row) =>
              row.id === id ? { ...row, status: "failed", error: actionErrorMessage(error) } : row,
            ),
          );
          return null;
        });
      uploads.current.set(id, done);
    }
  };
  const send = (threadRootId: string | null) => async (input: TeamSend) => {
    const me = view.me;
    if (!me) return;
    // A message never posts half its files: it waits for every upload.
    const files = await Promise.all(uploads.current.values());
    uploads.current.clear();
    setStaged([]);
    const message = teamMessage(input, me, view.members);
    try {
      await client.send({
        channelId,
        threadRootId: threadRootId ? TeamMessageIdSchema.parse(threadRootId) : null,
        bodyMarkdown: message.bodyMarkdown,
        mentions: message.mentions.map((mention) => ({
          ...mention,
          userId: UserIdSchema.parse(mention.userId),
        })),
        attachmentIds: files.flatMap((file) => (file ? [file.id] : [])),
      });
    } catch (error) {
      report(error);
    }
  };

  /* ---- Rows ---- */
  const pendingFor = (rootId: string | null): MessageView[] =>
    snapshot.pending
      .filter((row) => row.command.channelId === channelId && row.command.threadRootId === rootId)
      .filter(
        (row) =>
          !(rootId ? thread : timeline)?.messages.some(
            (message) => message.clientMessageId === row.command.clientMessageId,
          ),
      )
      .map((row) =>
        pendingView(
          words,
          { ...row.command, createdAt: row.createdAt },
          snapshot.connection === "connected" ? { kind: "sending" } : { kind: "queued" },
        ),
      );
  const items = useMemo(
    () => (timeline ? timelineItems(words, timeline, pendingFor(null), false) : []),
    [timeline, words, snapshot.pending, snapshot.connection],
  );
  const lastRead = entry?.lastReadMessageId ?? null;
  const firstUnread =
    timeline?.messages.find(
      (message) =>
        message.authorUserId !== words.viewerUserId && compareIds(message.id, lastRead) > 0,
    )?.id ?? null;

  /* ---- Actions on messages and cards ---- */
  const openTask = async (rootId: string) => {
    if (!links) return;
    const taskId = await links.task(team.teamId, channelId, rootId);
    if (taskId) go(`/tasks/${encodeURIComponent(taskId)}`);
    else toast.error("That task isn’t on this computer.");
  };
  const requestRoot = (requestId: string) =>
    [...(thread?.requests ?? []), ...(timeline?.requests ?? [])].find((row) => row.id === requestId)
      ?.threadRootId ?? null;
  const openFile = (file: FileView) => {
    const held = [...(timeline?.messages ?? []), ...(thread?.messages ?? [])]
      .flatMap((message) => message.attachments)
      .find((candidate) => candidate.id === file.id);
    if (!held) return;
    void client
      .file(held, true)
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(new Blob([blob], { type: held.mediaType }));
        const link = document.createElement("a");
        link.href = url;
        link.download = held.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(report);
  };
  const dispatch = (command: Parameters<(typeof client.rpc)["commands.dispatch"]>[0]) =>
    void client.rpc["commands.dispatch"](command).then(unwrapRpcResult).catch(report);
  const messageActions = {
    onOpenThread: (rootId: string) => go(channelPath(team.teamId, channelId, { threadId: rootId })),
    onAskAgent: (rootId: string) =>
      void navigate({
        pathname: channelPath(team.teamId, channelId, { threadId: rootId }),
        search: search ? `${search}&ask=1` : "?ask=1",
      }),
    onPin: (messageId: string, pinned: boolean) =>
      dispatch({
        type: pinned ? "team.message.pin" : "team.message.unpin",
        channelId,
        messageId: TeamMessageIdSchema.parse(messageId),
      }),
    onCopyLink: (messageId: string) =>
      void navigator.clipboard
        .writeText(
          teamPageUrl({
            origin: team.origin,
            target: { kind: "message", channelId, messageId: TeamMessageIdSchema.parse(messageId) },
          }),
        )
        .then(() => toast.success("Link copied"))
        .catch(report),
    onEdit: (messageId: string, body: string) => {
      if (!view.me) return;
      const message = teamMessage({ body, toMyAgent: false }, view.me, view.members);
      dispatch({
        type: "team.message.edit",
        channelId,
        messageId: TeamMessageIdSchema.parse(messageId),
        bodyMarkdown: message.bodyMarkdown,
        mentions: message.mentions.map((mention) => ({
          ...mention,
          userId: UserIdSchema.parse(mention.userId),
        })),
      });
    },
    onDelete: (messageId: string) =>
      dispatch({
        type: "team.message.delete",
        channelId,
        messageId: TeamMessageIdSchema.parse(messageId),
      }),
    onOpenFile: openFile,
    onOpenTask: links ? (messageId: string) => void openTask(threadRoot(messageId)) : undefined,
  };
  function threadRoot(messageId: string): string {
    const message = [...(timeline?.messages ?? []), ...(thread?.messages ?? [])].find(
      (candidate) => candidate.id === messageId,
    );
    return message?.threadRootId ?? messageId;
  }
  const cardActions = {
    onOpenTask: links
      ? (requestId: string) => {
          const root = requestRoot(requestId);
          if (root) void openTask(root);
        }
      : undefined,
    onStop: (requestId: string) =>
      dispatch({
        type: "team.agent.request.cancel",
        requestId: TeamAgentRequestIdSchema.parse(requestId),
      }),
    onCancel: (requestId: string) =>
      dispatch({
        type: "team.agent.request.cancel",
        requestId: TeamAgentRequestIdSchema.parse(requestId),
      }),
    onAnswer: links
      ? (requestId: string) => {
          const root = requestRoot(requestId);
          if (root) void openTask(root);
        }
      : undefined,
  };

  /* ---- Composer ---- */
  const agent: MyAgentHere = channel.peopleOnly
    ? { kind: "people-only" }
    : can?.wakeOwnAgent
      ? { kind: "ready" }
      : { kind: "not-linked" };
  const me = person(words, words.viewerUserId);
  const people = useMemo(
    () =>
      [...view.members.values()]
        .filter((member) => member.state === "active")
        .map((member) => person(words, member.userId)),
    [view.members, words],
  );
  const typingFor = (rootId: string | null) =>
    (snapshot.typing[JSON.stringify([channelId, rootId])] ?? [])
      .filter((userId) => userId !== words.viewerUserId)
      .map((userId) => person(words, userId));
  const composer = (rootId: string | null, startsOn: boolean) =>
    can?.post === false ? (
      <p className="team-composer__closed">You can read this channel but not post here.</p>
    ) : (
      <TeamComposer
        agent={agent}
        agentStartsOn={startsOn}
        autoFocus={rootId !== null}
        key={rootId ?? "channel"}
        me={me}
        onAddFiles={addFiles}
        onConnect={
          surface === "desktop"
            ? () => go(`/join?team=${encodeURIComponent(team.teamId)}`)
            : undefined
        }
        onRemoveFile={(id) => {
          uploads.current.delete(id);
          setStaged((current) => current.filter((row) => row.id !== id));
        }}
        onSend={(input) => void send(rootId)(input)}
        onTyping={() =>
          client.typing(channelId, rootId ? TeamMessageIdSchema.parse(rootId) : null, true)
        }
        people={people}
        placeholder={
          rootId
            ? "Reply…"
            : channel.kind === "dm" || channel.kind === "group-dm"
              ? `Message ${channel.name}`
              : `Message #${channel.name}`
        }
        staged={staged}
        typing={typingFor(rootId)}
      />
    );

  /* ---- Thread ---- */
  const threadRootMessage =
    thread?.messages.find((message) => message.id === place.threadId) ?? null;
  const replies = useMemo(
    () =>
      thread && place.threadId
        ? timelineItems(
            words,
            {
              ...thread,
              messages: thread.messages.filter((message) => message.id !== place.threadId),
            },
            pendingFor(place.threadId),
            true,
          )
        : [],
    [thread, words, place.threadId, snapshot.pending, snapshot.connection],
  );
  const myOpenAsk =
    thread?.requests.some(
      (request) =>
        request.ownerUserId === words.viewerUserId &&
        (request.state === "queued" ||
          request.state === "working" ||
          request.state === "needs_you"),
    ) ?? false;
  // Reading your agent's reply in the thread reads its task.
  const repliedToMe = thread?.messages.some(
    (message) => message.authorKind === "agent" && message.authorUserId === words.viewerUserId,
  );
  useEffect(() => {
    if (!repliedToMe || !place.threadId || !links || !hostClient) return;
    void readTeamReply(hostClient, {
      teamId: team.teamId,
      channelId,
      threadRootId: place.threadId,
    }).catch(() => undefined);
  }, [channelId, hostClient, links, place.threadId, repliedToMe, team.teamId]);
  const threadPane =
    place.threadId && threadRootMessage ? (
      <ThreadPane
        actions={messageActions}
        cardActions={cardActions}
        channel={channel}
        composer={composer(place.threadId, myOpenAsk || params.has("ask"))}
        onBack={docked ? () => go(channelPath(team.teamId, channelId)) : undefined}
        onClose={() => go(channelPath(team.teamId, channelId))}
        replies={replies}
        root={messageView(words, threadRootMessage, { requests: thread?.requests ?? [] })}
      />
    ) : null;

  /* ---- Tabs ---- */
  const tabBody =
    place.tab === "files" ? (
      <ChannelFiles channel={channel} channelId={channelId} onOpenFile={openFile} view={view} />
    ) : place.tab === "pinned" ? (
      <ChannelPins channelId={channelId} onOpenFile={openFile} view={view} />
    ) : place.tab === "knowledge" ? (
      <ChannelKnowledge channelId={channelId} topicId={place.topicId} view={view} />
    ) : (
      <ChannelMessages
        composer={
          agent.kind === "not-linked" && surface !== "desktop" ? (
            <>
              <AgentUnavailable kind="not-linked" />
              {composer(null, false)}
            </>
          ) : (
            composer(null, false)
          )
        }
        list={
          <MessageList
            actions={messageActions}
            firstUnreadId={firstUnread}
            flashId={place.messageId}
            hasOlder={timeline?.hasMore ?? false}
            intro={<ChannelIntro channel={channel} />}
            items={items}
            label={channel.name}
            onLoadOlder={() => void client.loadPage("channel", "before").catch(report)}
            onMarkRead={() => {
              const latest = timeline?.messages.at(-1)?.id;
              if (latest) void client.markRead(channelId, latest).catch(report);
            }}
            onReadThrough={(messageId) =>
              void client
                .markRead(channelId, TeamMessageIdSchema.parse(messageId))
                .catch(() => undefined)
            }
            openThreadId={place.threadId}
          />
        }
      />
    );

  // Docked beside a page, a thread takes the channel's place in the dock, with ‹ back.
  if (docked && threadPane) return threadPane;

  const sidePane =
    pane === "details" ? (
      <ChannelDetailsPane
        channel={channel}
        channelId={channelId}
        notify={entry?.notificationLevel ?? "mentions"}
        onClose={() => setPane(null)}
        onMembers={() => setPane("members")}
        timeline={timeline}
        view={view}
      />
    ) : pane === "members" ? (
      <ChannelMembersPane
        channel={channel}
        channelId={channelId}
        onClose={() => setPane(null)}
        view={view}
      />
    ) : (
      threadPane
    );
  const notice =
    snapshot.connection === "connected"
      ? null
      : snapshot.connection === "connecting"
        ? ({ kind: "reconnecting" } as const)
        : ({ kind: "unreachable" } as const);
  return (
    <ChannelScreen
      banner={
        <ConnectionBanner notice={notice} onRetry={() => client.connect()} team={team.name} />
      }
      channel={channel}
      lead={work ? null : drawer ? <DrawerButton /> : <SidebarRestoreButton />}
      menu={{
        onOpenDetails: () => setPane("details"),
        onOpenMembers: () => setPane("members"),
        onSearch: () =>
          go(`/teams/${encodeURIComponent(team.teamId)}/search?in=${channelId}`, false),
        onMarkRead: () => {
          const latest = timeline?.messages.at(-1)?.id;
          if (latest) void client.markRead(channelId, latest).catch(report);
        },
        onCopyLink: () =>
          void navigator.clipboard
            .writeText(teamPageUrl({ origin: team.origin, target: { kind: "channel", channelId } }))
            .then(() => toast.success("Link copied"))
            .catch(report),
        onLeave: can?.leave ? () => dispatch({ type: "team.channel.leave", channelId }) : undefined,
      }}
      onTab={(tab) =>
        go(channelPath(team.teamId, channelId, { tab: tab === "messages" ? null : tab }))
      }
      pane={sidePane}
      tab={place.tab}
    >
      {tabBody}
    </ChannelScreen>
  );
}

function ChannelFiles({
  channel,
  channelId,
  onOpenFile,
  view,
}: {
  readonly channel: ChannelView;
  readonly channelId: TeamChannelId;
  readonly onOpenFile: (file: FileView) => void;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const files = useTeamRead(
    () => view.client.rpc["team.files.page"]({ channelId }).then(unwrapRpcResult),
    `files:${channelId}`,
  );
  return (
    <FilesTab
      channel={channel}
      files={(files.value?.files ?? []).map(({ file, messageId }) => ({
        file: {
          id: file.id,
          name: file.filename,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          previewUrl: view.words.previews.get(file.id) ?? null,
        },
        sharedBy: { kind: "person", person: person(view.words, view.words.viewerUserId) },
        at: "",
        excerpt: "",
        inThread: false,
        pinned: false,
        messageId,
      }))}
      onOpenFile={onOpenFile}
      onShowMessage={(fileId) => {
        const messageId = files.value?.files.find((row) => row.file.id === fileId)?.messageId;
        if (messageId) void navigate(channelPath(view.team.teamId, channelId, { messageId }));
      }}
    />
  );
}

function ChannelPins({
  channelId,
  onOpenFile,
  view,
}: {
  readonly channelId: TeamChannelId;
  readonly onOpenFile: (file: FileView) => void;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const pins = useTeamRead(
    () => view.client.rpc["team.pins.page"]({ channelId }).then(unwrapRpcResult),
    `pins:${channelId}:${view.snapshot.channel?.throughSeq ?? ""}`,
  );
  return (
    <PinnedTab
      onOpenFile={onOpenFile}
      onShowMessage={(messageId) =>
        void navigate(channelPath(view.team.teamId, channelId, { messageId }))
      }
      onUnpin={(messageId) =>
        void view.client.rpc["commands.dispatch"]({
          type: "team.message.unpin",
          channelId,
          messageId: TeamMessageIdSchema.parse(messageId),
        }).then(pins.reload)
      }
      pins={(pins.value?.messages ?? []).map((message) => ({
        message: messageView(view.words, message),
        pinnedBy: "",
        pinnedAt: message.createdAt,
        inThread: message.threadRootId !== null,
      }))}
    />
  );
}

function ChannelKnowledge({
  channelId,
  topicId,
  view,
}: {
  readonly channelId: TeamChannelId;
  readonly topicId: string | null;
  readonly view: TeamView;
}) {
  const navigate = useNavigate();
  const knowledge = useKnowledge(view, channelId, topicId);
  return (
    <KnowledgeTab
      actions={{
        ...knowledge.actions,
        onSelectTopic: (next) =>
          void navigate(
            `${channelPath(view.team.teamId, channelId, { tab: "knowledge" })}/${next}`,
          ),
      }}
      history={knowledge.history}
      selectedTopicId={knowledge.selectedTopicId}
      things={knowledge.things}
      topics={knowledge.topics}
    />
  );
}

function ChannelDetailsPane({
  channel,
  channelId,
  notify,
  onClose,
  onMembers,
  timeline,
  view,
}: {
  readonly channel: ChannelView;
  readonly channelId: TeamChannelId;
  readonly notify: "mentions" | "all" | "muted";
  readonly onClose: () => void;
  readonly onMembers: () => void;
  readonly timeline: TeamTimeline | null;
  readonly view: TeamView;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const report = (error: unknown) => toast.error(actionErrorMessage(error));
  const dispatch = (command: Parameters<(typeof view.client.rpc)["commands.dispatch"]>[0]) =>
    view.client.rpc["commands.dispatch"](command).then(unwrapRpcResult).catch(report);
  const topics = useTeamRead(
    () => view.client.rpc["team.knowledge.topics.list"]({ channelId }).then(unwrapRpcResult),
    `topics:${channelId}`,
  );
  const level: NotifyLevel =
    notify === "all" ? "everything" : notify === "muted" ? "nothing" : "mentions";
  const live = timeline?.channel ?? null;
  const manage = live?.can.manage === true;
  const workingAgents =
    timeline?.requests.filter(
      (request) => request.state === "working" || request.state === "queued",
    ).length ?? 0;
  return (
    <ChannelDetails
      actions={{
        onClose,
        onOpenMembers: onMembers,
        onNotify: (next) =>
          void dispatch({
            type: "team.channel.preferences.set",
            channelId,
            notificationLevel:
              next === "everything" ? "all" : next === "nothing" ? "muted" : "mentions",
          }),
        onOpenTopic: (topicId) =>
          void navigate(
            `${channelPath(view.team.teamId, channelId, { tab: "knowledge" })}/${topicId}`,
          ),
        onLeave: live?.can.leave
          ? () => void dispatch({ type: "team.channel.leave", channelId })
          : undefined,
        ...(manage && live
          ? {
              onSaveAbout: (about: { readonly name: string }) =>
                void dispatch({
                  type: "team.channel.update",
                  channelId,
                  name: about.name,
                  peopleOnly: live.peopleOnly,
                }),
              onSaveInstructions: (text: string) =>
                void dispatch({
                  type: "team.channel.instructions.set",
                  channelId,
                  expectedRevision: live.instructionsRevision,
                  instructionsMarkdown: text,
                }),
              onSetPeopleOnly: (peopleOnly: boolean) =>
                void dispatch({
                  type: "team.channel.update",
                  channelId,
                  name: live.name,
                  peopleOnly,
                }),
              onDetachTopic: (topicId: string) =>
                void dispatch({
                  type: "team.channel.topic.detach",
                  channelId,
                  topicId: KnowledgeTopicIdSchema.parse(topicId),
                }).then(topics.reload),
              onAttachTopic: () =>
                void navigate(`/teams/${encodeURIComponent(view.team.teamId)}/knowledge`),
              onArchive: () => void dispatch({ type: "team.channel.archive", channelId }),
            }
          : {}),
      }}
      channel={channel}
      folder={null}
      notify={level}
      topics={(topics.value?.topics ?? []).map((topic) => ({
        id: topic.id,
        name: topic.name,
        kind: topic.originChannelId === channelId ? "channel" : "shared",
        detail: topic.peopleOnly ? "People only" : "",
      }))}
      workingAgents={workingAgents}
    />
  );
}

function ChannelMembersPane({
  channel,
  channelId,
  onClose,
  view,
}: {
  readonly channel: ChannelView;
  readonly channelId: TeamChannelId;
  readonly onClose: () => void;
  readonly view: TeamView;
}) {
  const access = useTeamRead(
    () => view.client.rpc["team.channel.access.get"]({ channelId }).then(unwrapRpcResult),
    `access:${channelId}`,
  );
  const groups = useTeamRead(
    () => view.client.rpc["team.groups.list"]({}).then(unwrapRpcResult),
    `groups:${view.team.teamId}`,
  );
  const entries = access.value?.entries ?? [];
  return (
    <MembersPane
      actions={{ onClose }}
      canManage={access.value?.can.manage ?? false}
      channel={channel}
      members={entries.map((entry) => {
        if (entry.subject.kind === "person")
          return {
            kind: "person" as const,
            person: person(view.words, entry.subject.userId),
            manager: entry.manage,
          };
        const groupId = entry.subject.groupId;
        const group = groups.value?.groups.find((candidate) => candidate.id === groupId);
        return {
          kind: "group" as const,
          id: groupId,
          name: group?.name ?? "Group",
          peopleCount: group?.people.length ?? 0,
          manager: entry.manage,
        };
      })}
    />
  );
}
