import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { watchTeamReplyRead, unwrapRpcResult } from "@opensteer/client/host";
import { teamScopeKey, type TeamTimeline } from "@opensteer/client/team";
import { TeamPreviewUrls } from "./preview-urls.js";
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
import { actionErrorMessage, fromLivePage } from "../ui-utils.js";
import { useTeams, useTeamSession } from "./team-attachments.js";
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

function usePreviews(key: string, session: TeamView["client"] | null) {
  const store = useMemo(() => new TeamPreviewUrls(), [key, session]);
  const previews = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => () => store.clear(), [store]);
  const want = useCallback(
    (view: TeamView | null, files: readonly TeamFile[]) => {
      if (!view) return;
      for (const file of files)
        if (file.preview) void store.load(file.id, () => view.client.file(file));
    },
    [store],
  );
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
  const attachment = useTeams().teams.find((team) => team.teamId === teamId);
  const contentGeneration = useSyncExternalStore(
    attachment?.client?.subscribe ?? (() => () => undefined),
    () => attachment?.client?.getSnapshot().contentGeneration ?? 0,
  );
  const { previews, want } = usePreviews(
    `${teamId}:${channelId}:${contentGeneration}`,
    attachment?.client ?? null,
  );
  const view = useTeamView(teamId, previews);
  const navigate = useNavigate();
  const location = useLocation();
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
  useEffect(() => {
    if (!client || !channelId || !place.messageId) return;
    let live = true;
    void client
      .landMessage(channelId, TeamMessageIdSchema.parse(place.messageId))
      .then((message) => {
        if (!live || !message?.threadRootId || message.threadRootId === threadRoot) return;
        void navigate(
          {
            pathname: channelPath(teamId, channelId, {
              threadId: message.threadRootId,
              messageId: message.id,
            }),
            search: location.search,
          },
          { replace: true },
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, channelId, place.messageId, threadRoot, teamId, navigate]);
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
      key={`${teamId}:${channelId}:${contentGeneration}`}
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
  const snapshot = useTeamSession(team?.client ?? null);
  if (snapshot?.ended)
    return (
      <p className="team-empty">
        {snapshot.ended === "removed"
          ? `You’re no longer in ${team?.name ?? "this team"}.`
          : `Sign in to ${team?.name ?? "this team"} again.`}
      </p>
    );
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
  const location = useLocation();
  const { search } = location;
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
  const searchChannel = () =>
    void navigate({
      pathname: `/teams/${encodeURIComponent(team.teamId)}/search`,
      search: `?${new URLSearchParams({ in: channelId })}`,
    });
  // ⌘F / Ctrl+F searches the whole channel, not the messages the page happens to hold.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (fromLivePage(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchChannel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
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
  type Staged = StagedFileView & { file: TeamFile | null };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [stagedScopes, setStagedScopes] = useState<Readonly<Record<string, readonly Staged[]>>>({});
  const setStaged = (
    rootId: string | null,
    update: (rows: readonly Staged[]) => readonly Staged[],
  ) =>
    setStagedScopes((held) => ({
      ...held,
      [rootId ?? "channel"]: update(held[rootId ?? "channel"] ?? []),
    }));
  const uploads = useRef(
    new Map<string, { rootId: string | null; done: Promise<TeamFile | null> }>(),
  );
  const stagedUrls = useRef(new Map<string, string>());
  const uploadGeneration = useRef(0);
  useEffect(
    () => () => {
      uploadGeneration.current++;
      for (const url of stagedUrls.current.values()) URL.revokeObjectURL(url);
      stagedUrls.current.clear();
    },
    [],
  );
  const retireFile = (id: string) => {
    const url = stagedUrls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    stagedUrls.current.delete(id);
    uploads.current.delete(id);
  };
  const addFiles = (rootId: string | null) => (files: readonly File[]) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      const generation = uploadGeneration.current;
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (previewUrl) stagedUrls.current.set(id, previewUrl);
      setStaged(rootId, (current) => [
        ...current,
        {
          id,
          name: file.name,
          mediaType: file.type,
          sizeBytes: file.size,
          status: "uploading",
          file: null,
          previewUrl,
        },
      ]);
      const done = prepareTeamUpload(channelId, file)
        .then((upload) => client.upload(upload))
        .then((uploaded) => {
          if (generation !== uploadGeneration.current) return null;
          setStaged(rootId, (current) =>
            current.map((row) =>
              row.id === id ? { ...row, status: "ready", file: uploaded } : row,
            ),
          );
          return uploaded;
        })
        .catch((error: unknown) => {
          if (generation !== uploadGeneration.current) return null;
          setStaged(rootId, (current) =>
            current.map((row) =>
              row.id === id ? { ...row, status: "failed", error: actionErrorMessage(error) } : row,
            ),
          );
          return null;
        });
      uploads.current.set(id, { rootId, done });
    }
  };
  const send = (threadRootId: string | null) => async (input: TeamSend) => {
    const me = view.me;
    if (!me) return;
    // A message never posts half its files: it waits for every upload.
    const sending = [...uploads.current.entries()].filter(
      ([, upload]) => upload.rootId === threadRootId,
    );
    const files = await Promise.all(sending.map(([, upload]) => upload.done));
    if (files.some((file) => !file))
      throw new Error("Remove or retry the failed attachment before sending.");
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
      const ids = new Set(sending.map(([id]) => id));
      for (const id of ids) retireFile(id);
      setStaged(threadRootId, (rows) => rows.filter((row) => !ids.has(row.id)));
    } catch (error) {
      report(error);
      throw error;
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
          row.failure
            ? { kind: "failed", reason: row.failure }
            : snapshot.connection === "connected"
              ? { kind: "sending" }
              : { kind: "queued" },
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
    if (taskId)
      void navigate(
        { pathname: `/tasks/${encodeURIComponent(taskId)}`, search },
        { state: { teamReturn: { pathname: location.pathname, search } } },
      );
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
      if (messageId.startsWith("pending:")) {
        void client.editPending(messageId.slice(8), body).catch(report);
        return;
      }
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
      messageId.startsWith("pending:")
        ? void client.discardPending(messageId.slice(8)).catch(report)
        : dispatch({
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
    can?.post !== true ? (
      <p className="team-composer__closed">You can read this channel but not post here.</p>
    ) : (
      <TeamComposer
        agent={agent}
        agentStartsOn={startsOn}
        autoFocus={rootId !== null}
        key={`${team.teamId}:${channelId}:${rootId ?? "channel"}`}
        draft={
          snapshot.drafts[
            teamScopeKey(
              rootId
                ? { kind: "thread", channelId, rootId: TeamMessageIdSchema.parse(rootId) }
                : { kind: "channel", channelId },
            )
          ] ?? ""
        }
        onDraft={(text) =>
          void client
            .setDraft(
              rootId
                ? { kind: "thread", channelId, rootId: TeamMessageIdSchema.parse(rootId) }
                : { kind: "channel", channelId },
              text,
            )
            .catch(report)
        }
        me={me}
        onAddFiles={addFiles(rootId)}
        onConnect={
          surface === "desktop"
            ? () => go(`/join?team=${encodeURIComponent(team.teamId)}`)
            : undefined
        }
        onRemoveFile={(id) => {
          retireFile(id);
          setStaged(rootId, (current) => current.filter((row) => row.id !== id));
        }}
        onSend={send(rootId)}
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
        staged={stagedScopes[rootId ?? "channel"] ?? []}
        typing={typingFor(rootId)}
      />
    );

  /* ---- Thread ---- */
  const threadRootMessage =
    thread?.messages.find((message) => message.id === place.threadId) ?? null;
  const replies = useMemo(
    () =>
      thread && place.threadId
        ? timelineItems(words, thread, pendingFor(place.threadId), true).filter(
            (item) => item.kind !== "message" || item.message.id !== place.threadId,
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
  const readVisibleReply = useCallback(
    (messageId: string) => {
      if (!hostClient || !links || !place.threadId) return;
      const message = thread?.messages.find((row) => row.id === messageId);
      if (
        message?.authorKind !== "agent" ||
        message.authorUserId !== words.viewerUserId ||
        !message.agentRequestId
      )
        return;
      return watchTeamReplyRead(hostClient, {
        teamId: team.teamId,
        channelId,
        threadRootId: place.threadId,
        replyMessageId: messageId,
      });
    },
    [
      hostClient,
      links,
      place.threadId,
      thread?.messages,
      words.viewerUserId,
      team.teamId,
      channelId,
    ],
  );
  const threadPane =
    place.threadId && threadRootMessage ? (
      <ThreadPane
        actions={messageActions}
        cardActions={cardActions}
        channel={channel}
        composer={composer(place.threadId, myOpenAsk || params.has("ask"))}
        onBack={docked ? () => go(channelPath(team.teamId, channelId)) : undefined}
        onClose={() => go(channelPath(team.teamId, channelId))}
        editingId={editingId}
        onEditingChange={setEditingId}
        replies={replies}
        flashId={place.messageId}
        hasOlder={thread?.hasMore ?? false}
        onLoadOlder={() => void client.loadPage("thread", "before").catch(report)}
        onVisibleMessage={readVisibleReply}
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
            editingId={editingId}
            onEditingChange={setEditingId}
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
        onSearch: searchChannel,
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
