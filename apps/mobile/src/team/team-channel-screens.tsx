import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { PersonalTeamLinks, readTeamReply, unwrapRpcResult } from "@opensteer/client/host";
import { teamScopeKey, type TeamSessionClient, type TeamTimeline } from "@opensteer/client/team";
import {
  TeamAgentRequestIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  teamAgentHandle,
  teamPageUrl,
  type TeamMessageId,
} from "@opensteer/core";
import type { HostApiCommandInput, TeamMember, TeamMessage } from "@opensteer/protocol";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from "react-native";
import type { RootParamList } from "../navigation.js";
import { color, space } from "../theme.js";
import { useMobileClient, useSelectedHostClient } from "../ui/mobile-client-context.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  ChannelScreenBody,
  ChannelTitle,
  ThreadScreenBody,
  ThreadTitle,
} from "./channel-screen.js";
import { sendFromComposer } from "./composer-send.js";
import { messageActions, type MessageActionId } from "./message-row.js";
import type { MobileTeam } from "./mobile-teams.js";
import { dataUri, useTeamMembers, useTeamPreviews, useTeamSession } from "./team-context.js";
import type {
  AgentReach,
  ConnectionBannerView,
  JumpView,
  MentionOption,
  MessageView,
  StagedAttachmentView,
} from "./team-models.js";
import type { TeamComposerProps } from "./team-composer.js";
import {
  pickTeamPhoto,
  uploadRefusal,
  uploadToTeam,
  type TeamUploadSource,
} from "./team-upload.js";
import {
  agentReach,
  channelHeader,
  mentionOptions,
  messageView,
  ownReplyInView,
  timelineItems,
  typingLine,
  type MemberDirectory,
} from "./team-views.js";

export type TeamChannelRoute = {
  readonly teamId: string;
  readonly channelId: string;
  /** A message to open at, from a link, a notification or search. */
  readonly messageId?: string | undefined;
};

export type TeamThreadRoute = {
  readonly teamId: string;
  readonly channelId: string;
  readonly rootId: string;
  /** The reply a link named. */
  readonly replyId?: string | undefined;
  /** Opened from "Ask my agent" on a message: the composer starts "to my agent". */
  readonly toAgent?: boolean | undefined;
};

type Navigation = NativeStackNavigationProp<RootParamList>;

/** A channel or DM. Its tabs are rows in Details on a phone. */
export function TeamChannelScreen(props: StaticScreenProps<TeamChannelRoute>): ReactNode {
  const { teamId, channelId, messageId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const place = useTeamSession(teamId);
  const { session, snapshot, team } = place;
  const view = snapshot.channel?.scope.channelId === channelId ? snapshot.channel : null;
  const landing = useLanding(session, channelId, messageId ?? null, (reply) =>
    navigation.replace("TeamThread", {
      teamId,
      channelId,
      rootId: reply.threadRootId!,
      replyId: reply.id,
    }),
  );
  useFocusEffect(
    useCallback(() => {
      // A link's message selects its own place; after that this is any other visit.
      if (session === null || !landing.settled) return;
      if (session.getSnapshot().channel?.scope.channelId !== channelId)
        session.selectChannel(TeamChannelIdSchema.parse(channelId));
      else if (session.getSnapshot().thread !== null)
        session.selectThread(TeamChannelIdSchema.parse(channelId), null);
    }, [channelId, landing.settled, session]),
  );
  const people = useTeamMembers(teamId);
  const memberCount = useChannelMemberCount(session, channelId);
  const header = useMemo(
    () =>
      view?.channel ? channelHeader({ channel: view.channel, memberCount, people: [] }) : null,
    [memberCount, view?.channel],
  );
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () =>
        header === null ? null : (
          <Pressable
            accessibilityHint="Opens members, files, pinned messages and settings"
            accessibilityRole="button"
            onPress={() => navigation.navigate("TeamDetails", { teamId, channelId })}
          >
            <ChannelTitle channel={header} />
          </Pressable>
        ),
      headerRight: () => (
        <Pressable
          accessibilityLabel="Search this channel"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => navigation.navigate("TeamSearch", { teamId, channelId })}
        >
          <Symbol name="magnifyingglass" size={18} tint={color.ember} />
        </Pressable>
      ),
    });
  }, [channelId, header, navigation, teamId]);

  if (session === null || view === null || view.channel === null || header === null)
    return <PlaceWaiting failure={place.failure} />;
  return (
    <Screen edgeToEdge>
      <Place
        directory={people.directory}
        members={people.members}
        session={session}
        team={team}
        teamId={teamId}
        view={view}
      >
        {(place) => (
          <ChannelScreenBody
            {...place}
            anchorId={landing.anchorId}
            atStart={!view.hasMore}
            channel={header}
          />
        )}
      </Place>
    </Screen>
  );
}

/** A thread under one message, pushed full screen; Back returns to its channel. */
export function TeamThreadScreen(props: StaticScreenProps<TeamThreadRoute>): ReactNode {
  const { teamId, channelId, rootId, replyId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const place = useTeamSession(teamId);
  const { session, snapshot, team } = place;
  const view =
    snapshot.thread?.scope.kind === "thread" && snapshot.thread.scope.rootId === rootId
      ? snapshot.thread
      : null;
  const landing = useLanding(session, channelId, replyId ?? null, null);
  useFocusEffect(
    useCallback(() => {
      if (session === null || !landing.settled) return;
      const held = session.getSnapshot().thread;
      if (held?.scope.kind !== "thread" || held.scope.rootId !== rootId)
        session.selectThread(
          TeamChannelIdSchema.parse(channelId),
          TeamMessageIdSchema.parse(rootId),
        );
    }, [channelId, landing.settled, rootId, session]),
  );
  const people = useTeamMembers(teamId);
  const channelName = view?.channel?.name ?? null;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () =>
        channelName === null ? null : (
          <ThreadTitle
            place={
              view?.channel?.kind === "dm" || view?.channel?.kind === "group_dm"
                ? channelName
                : `#${channelName}`
            }
          />
        ),
    });
  }, [channelName, navigation, view?.channel?.kind]);
  const root = view?.messages.find((message) => message.id === rootId) ?? null;

  if (session === null || view === null || view.channel === null || root === null)
    return <PlaceWaiting failure={place.failure} />;
  return (
    <Screen edgeToEdge>
      <Place
        directory={people.directory}
        members={people.members}
        rootId={rootId}
        session={session}
        startToAgent={props.route.params.toAgent === true}
        team={team}
        teamId={teamId}
        view={view}
      >
        {(place) => (
          <ThreadScreenBody
            {...place}
            anchorId={landing.anchorId}
            replyCount={root.replySummary.count}
            root={rootView(root, place.viewerId, people.directory)}
          />
        )}
      </Place>
    </Screen>
  );
}

/**
 * A link's message, asked of the team once per screen: it is loaded with the
 * pages around it, and its id comes back to be scrolled to once mounted. A
 * reply named from a channel moves to its thread instead.
 */
function useLanding(
  session: TeamSessionClient | null,
  channelId: string,
  messageId: string | null,
  /** From a channel: a reply opens its thread. A thread passes null and holds its replies. */
  onReply: ((reply: TeamMessage) => void) | null,
): { readonly anchorId: string | null; readonly settled: boolean } {
  const [landed, setLanded] = useState<{
    readonly messageId: string;
    readonly anchorId: string | null;
  } | null>(null);
  const asked = useRef<string | null>(null);
  const reply = useRef(onReply);
  reply.current = onReply;
  useEffect(() => {
    if (session === null || messageId === null || asked.current === messageId) return;
    asked.current = messageId;
    void session
      .landMessage(TeamChannelIdSchema.parse(channelId), TeamMessageIdSchema.parse(messageId))
      .then(
        (message) => {
          if (message?.threadRootId != null && reply.current !== null) reply.current(message);
          else setLanded({ messageId, anchorId: message?.id ?? null });
        },
        // Gone, or no longer the reader's to see: the place opens as it would without it.
        () => setLanded({ messageId, anchorId: null }),
      );
  }, [channelId, messageId, session]);
  if (messageId === null) return { anchorId: null, settled: true };
  return landed?.messageId === messageId
    ? { anchorId: landed.anchorId, settled: true }
    : { anchorId: null, settled: false };
}

function rootView(root: TeamMessage, viewerId: string, directory: MemberDirectory): MessageView {
  return messageView(root, {
    viewerId,
    members: directory,
    previews: new Map(),
    previous: null,
    requests: root.requests,
    inThread: true,
  });
}

function PlaceWaiting(props: { readonly failure: string | null }): ReactNode {
  return (
    <Screen>
      <View style={styles.waiting}>
        {props.failure === null ? (
          <ActivityIndicator color={color.muted} />
        ) : (
          <Notice detail={props.failure} title="This team didn't answer" tone="neutral" />
        )}
      </View>
    </Screen>
  );
}

/** How many people and groups the channel's list holds, read once it is open. */
function useChannelMemberCount(session: TeamSessionClient | null, channelId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.channel.access.get"]({ channelId: TeamChannelIdSchema.parse(channelId) })
      .then(unwrapRpcResult)
      .then(
        (access) => current && setCount(access.entries.length),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [channelId, session]);
  return count;
}

interface PlaceProps {
  readonly actions: Parameters<typeof ChannelScreenBody>[0]["actions"];
  readonly banner: ConnectionBannerView | null;
  readonly composer: TeamComposerProps;
  readonly items: Parameters<typeof ChannelScreenBody>[0]["items"];
  readonly jump: JumpView | null;
  readonly typing: string | null;
  readonly viewerId: string;
}

/**
 * Everything a channel and a thread share: their rows, the composer and what
 * each control does. The team's `can` facts decide what is offered; the team
 * itself decides what is allowed.
 */
function Place(props: {
  readonly teamId: string;
  readonly team: MobileTeam | null;
  readonly session: TeamSessionClient;
  readonly view: TeamTimeline;
  readonly members: readonly TeamMember[];
  readonly directory: MemberDirectory;
  readonly rootId?: string;
  readonly startToAgent?: boolean;
  readonly children: (place: PlaceProps) => ReactNode;
}): ReactNode {
  const { session, view, directory, teamId } = props;
  const navigation = useNavigation<Navigation>();
  const mobile = useMobileClient();
  const personal = useSelectedHostClient();
  const snapshot = session.getSnapshot();
  const viewerId = snapshot.bootstrap?.member.userId ?? "";
  const channel = view.channel!;
  const channelId = channel.id;
  const rootId = props.rootId === undefined ? null : TeamMessageIdSchema.parse(props.rootId);
  const reach: AgentReach = agentReach(channel);
  const scopeKey = teamScopeKey(view.scope);
  const previews = useTeamPreviews(session, view.messages);
  const sidebarEntry = snapshot.sidebar?.channels.find((row) => row.channel.id === channelId);
  const [newLineAt] = useState(() => sidebarEntry?.lastReadMessageId ?? null);
  const items = useMemo(
    () =>
      timelineItems({
        timeline: view,
        viewerId,
        members: directory,
        presence: snapshot.presence,
        previews,
        lastReadMessageId: newLineAt,
        pending: snapshot.pending,
        connected: snapshot.connection === "connected",
        now: new Date(),
        ...(rootId === null ? {} : { skipId: rootId }),
      }),
    [
      directory,
      newLineAt,
      previews,
      rootId,
      snapshot.connection,
      snapshot.pending,
      snapshot.presence,
      view,
      viewerId,
    ],
  );

  // Read: the newest message has been on screen, in front, for a second.
  const newest = view.messages.at(-1)?.id ?? null;
  const [following, setFollowing] = useState(true);
  useFocusEffect(
    useCallback(() => {
      if (newest === null || !following) return;
      const timer = setTimeout(() => {
        void session.markRead(channelId, newest).catch(() => undefined);
      }, 1_000);
      return () => clearTimeout(timer);
    }, [channelId, following, newest, session]),
  );
  // Reading your agent's reply in its thread reads its task on your computer:
  // that reply, once it is on screen in front, through what it published only.
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const replyInView =
    rootId === null ? null : ownReplyInView(view.messages, viewerId, rootId, visible);
  const readStates = useSyncExternalStore(
    useCallback(
      (listener: () => void) => personal?.subscribe(listener) ?? (() => undefined),
      [personal],
    ),
    useCallback(() => personal?.getSnapshot().threadReadStates ?? null, [personal]),
  );
  const readReplies = useRef(new Set<string>());
  useFocusEffect(
    useCallback(() => {
      if (replyInView === null || rootId === null || personal === null) return;
      if (readReplies.current.has(replyInView) || AppState.currentState !== "active") return;
      // False until the publication and the task's read state have reached this
      // phone; the read state changing is what asks again.
      void readTeamReply(personal, {
        teamId,
        channelId,
        threadRootId: rootId,
        replyMessageId: replyInView,
      }).then(
        (read) => {
          if (read) readReplies.current.add(replyInView);
        },
        () => undefined,
      );
    }, [channelId, personal, readStates, replyInView, rootId, teamId]),
  );
  const arrivedWhileAway = useRef(0);
  const lastNewest = useRef(newest);
  if (lastNewest.current !== newest) {
    if (!following) arrivedWhileAway.current += 1;
    lastNewest.current = newest;
  }
  if (following) arrivedWhileAway.current = 0;
  const jump: JumpView | null =
    !following && arrivedWhileAway.current > 0
      ? { direction: "down", label: `${arrivedWhileAway.current} new` }
      : null;

  // The composer: words, mentions, files, and whether it asks the reader's agent.
  const [text, setText] = useState(() => snapshot.drafts[scopeKey] ?? "");
  const [editing, setEditing] = useState<TeamMessageId | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const ownActive = view.requests.some(
    (request) =>
      request.ownerUserId === viewerId &&
      (request.state === "queued" || request.state === "working" || request.state === "needs_you"),
  );
  const [toMyAgent, setToMyAgent] = useState(
    rootId !== null && (props.startToAgent === true || ownActive),
  );
  const [staged, setStaged] = useState<readonly Staged[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeText = (next: string): void => {
    setText(next);
    session.typing(channelId, rootId, next !== "");
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (editing === null) void session.setDraft(view.scope, next).catch(() => undefined);
    }, 400);
  };
  const mentionQuery = activeMention(text, selection.start);
  const mentions: readonly MentionOption[] | null =
    mentionQuery === null
      ? null
      : mentionOptions({ query: mentionQuery, viewerId, members: props.members, reach });
  const me = props.members.find((member) => member.userId === viewerId) ?? null;

  const pickMention = (option: MentionOption): void => {
    if (mentionQuery === null) return;
    const start = selection.start - mentionQuery.length - 1;
    if (option.kind === "my-agent") {
      if (option.disabled) {
        navigation.navigate("ConnectOpensteer", { teamId });
        return;
      }
      // @ My agent is the same state as the pill: the chip leads the words.
      setToMyAgent(true);
      changeText(text.slice(0, start) + text.slice(selection.start));
      return;
    }
    const handle =
      option.kind === "person" ? option.person.handle : teamAgentHandle(option.owner.handle);
    changeText(`${text.slice(0, start)}@${handle} ${text.slice(selection.start)}`);
  };

  const attach = async (): Promise<void> => {
    const source = await pickTeamPhoto().catch(() => null);
    if (source === null) return;
    const refused = uploadRefusal(source);
    const entry: Staged = { source, fileId: null, refused, failed: null };
    setStaged((held) => [...held, entry]);
    if (refused !== null) return;
    try {
      const fileId = await uploadToTeam({ session, channelId, source });
      setStaged((held) =>
        held.map((row) => (row.source.localId === source.localId ? { ...row, fileId } : row)),
      );
    } catch (error) {
      setStaged((held) =>
        held.map((row) =>
          row.source.localId === source.localId
            ? { ...row, failed: error instanceof Error ? error.message : "Upload failed" }
            : row,
        ),
      );
    }
  };

  const send = async (): Promise<void> => {
    const words = text.trim();
    const files = staged.filter((row) => row.fileId !== null).map((row) => row.fileId!);
    if (words === "" && files.length === 0) return;
    if (staged.some((row) => row.fileId === null)) return;
    const asking = toMyAgent && reach === "available" && me !== null;
    const body = asking ? `@${teamAgentHandle(me.handle)} ${words}` : words;
    const found = writtenMentions(body, props.members);
    const mentioned = asking
      ? [
          { userId: me.userId, kind: "agent" as const },
          ...found.filter((row) => row.userId !== me.userId || row.kind !== "agent"),
        ]
      : found;
    setFailure(null);
    try {
      if (editing !== null) {
        await command(session, {
          type: "team.message.edit",
          channelId,
          messageId: editing,
          bodyMarkdown: words,
          mentions: found,
        });
        setEditing(null);
      } else {
        session.typing(channelId, rootId, false);
        await sendFromComposer(
          session,
          view.scope,
          {
            channelId,
            threadRootId: rootId,
            bodyMarkdown: body,
            mentions: mentioned.slice(0, 20),
            attachmentIds: files as never,
          },
          () => {
            // A pending draft save would put the sent words back.
            if (draftTimer.current !== null) clearTimeout(draftTimer.current);
            setStaged([]);
          },
        );
      }
      setText("");
      // After sending it stays as the reader left it, in a thread; a channel's
      // ask opens its own thread, so the channel's composer starts off again.
      if (rootId === null) setToMyAgent(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That message wasn't sent.");
    }
  };

  // Long press: the platform's own menu, mounted only while it is open.
  const [held, setHeld] = useState<TeamMessage | null>(null);
  const menu = useRef<MenuComponentRef>(null);
  useEffect(() => {
    if (held !== null) menu.current?.show();
  }, [held]);
  const heldView =
    held === null
      ? null
      : messageView(held, {
          viewerId,
          members: directory,
          previews,
          previous: null,
          requests: [],
          inThread: rootId !== null,
        });
  const heldActions =
    heldView === null
      ? []
      : messageActions({
          canAskAgent: reach === "available" && rootId === null,
          canModerate: channel.can.manage,
          inThread: rootId !== null,
          message: heldView,
        });
  const act = async (message: TeamMessage, id: MessageActionId): Promise<void> => {
    switch (id) {
      case "reply":
        navigation.navigate("TeamThread", { teamId, channelId, rootId: message.id });
        return;
      case "ask":
        navigation.navigate("TeamThread", { teamId, channelId, rootId: message.id, toAgent: true });
        return;
      case "pin":
      case "unpin":
        await command(session, {
          type: id === "pin" ? "team.message.pin" : "team.message.unpin",
          channelId,
          messageId: message.id,
        });
        return;
      case "copy-link": {
        const origin = props.team?.origin;
        if (origin !== undefined)
          await Clipboard.setStringAsync(
            teamPageUrl({
              origin,
              target: { kind: "message", channelId, messageId: message.id },
            }),
          );
        return;
      }
      case "edit":
        setEditing(message.id);
        setText(message.bodyMarkdown);
        return;
      case "delete":
        await command(session, { type: "team.message.delete", channelId, messageId: message.id });
        return;
    }
  };

  const openTask = async (requestId: string | null, messageId: string | null): Promise<void> => {
    const request = view.requests
      .concat(view.messages.flatMap((message) => message.requests))
      .find((row) =>
        requestId !== null ? row.id === requestId : row.replyMessageId === messageId,
      );
    const threadRoot = request?.threadRootId ?? rootId;
    const deploymentId = mobile.getSnapshot().selection.deploymentId;
    if (personal === null || deploymentId === null || threadRoot === null) {
      navigation.navigate("ConnectOpensteer", { teamId });
      return;
    }
    const taskId = await new PersonalTeamLinks(personal.rpc).task(teamId, channelId, threadRoot);
    if (taskId !== null) navigation.navigate("Thread", { deploymentId, threadId: taskId });
  };

  const openFile = async (messageId: string, fileId: string): Promise<void> => {
    const file = view.messages
      .find((message) => message.id === messageId)
      ?.attachments.find((row) => row.id === fileId);
    if (file === undefined) return;
    const blob = await session.file(file, true);
    if (blob === null) return;
    const uri = await dataUri(blob);
    const target = new File(
      Paths.cache,
      `team-${file.id}-${file.filename.replace(/[^\w.-]+/g, "_")}`,
    );
    if (target.exists) target.delete();
    target.create();
    await target.write(base64Bytes(uri.slice(uri.indexOf(",") + 1)));
    await Sharing.shareAsync(target.uri, { mimeType: file.mediaType, dialogTitle: file.filename });
  };

  const banner = useConnectionBanner(props.team, snapshot.connection, () => session.connect());
  const typingKey = JSON.stringify([channelId, rootId]);
  const composer: TeamComposerProps = {
    placeholder:
      rootId !== null
        ? "Reply…"
        : channel.kind === "dm" || channel.kind === "group_dm"
          ? `Message ${channel.name}`
          : `Message #${channel.name}`,
    text,
    onChangeText: changeText,
    onSelectionChange: setSelection,
    agent: reach,
    toMyAgent,
    onToMyAgentChange: setToMyAgent,
    onAgentUnavailable: () => navigation.navigate("ConnectOpensteer", { teamId }),
    mentions,
    onPickMention: pickMention,
    onMention: () => changeText(`${text.slice(0, selection.start)}@${text.slice(selection.end)}`),
    attachments: staged.map(stagedView),
    onAttach: () => void attach(),
    onRemoveAttachment: (id) =>
      setStaged((held) => held.filter((row) => row.source.localId !== id)),
    onSend: () => void send(),
    ...(failure === null
      ? {}
      : {
          hint: (
            <AppText role="caption" style={styles.failure} tone="danger">
              {failure}
            </AppText>
          ),
        }),
  };
  const byId = (id: string) => view.messages.find((message) => message.id === id) ?? null;
  return (
    <View style={styles.fill}>
      {props.children({
        actions: {
          onHold: (id) => setHeld(byId(id)),
          onOpenAttachment: (messageId, fileId) =>
            void openFile(messageId, fileId).catch(() => undefined),
          onOpenThread: (id) =>
            navigation.navigate("TeamThread", { teamId, channelId, rootId: id }),
          onOpenTask: (messageId) => void openTask(null, messageId).catch(() => undefined),
          onUnsent: (messageId, choice) => {
            const clientMessageId = messageId.replace(/^pending:/, "");
            const pending = snapshot.pending.find(
              (row) => row.command.clientMessageId === clientMessageId,
            );
            if (pending === undefined) return;
            const done =
              choice === "edit"
                ? session
                    .editPending(clientMessageId, pending.command.bodyMarkdown)
                    .then(() => setText(pending.command.bodyMarkdown))
                : session.discardPending(clientMessageId);
            void done.catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : "That didn't work."),
            );
          },
          onCardAction: (requestId, action) => {
            if (action === "cancel" || action === "stop")
              void command(session, {
                type: "team.agent.request.cancel",
                requestId: TeamAgentRequestIdSchema.parse(requestId),
              }).catch(() => undefined);
            else void openTask(requestId, null).catch(() => undefined);
          },
          onOpenCardTask: (requestId) => void openTask(requestId, null).catch(() => undefined),
          onLoadOlder: () =>
            void session
              .loadPage(rootId === null ? "channel" : "thread", "before")
              .catch(() => undefined),
          onFollowingChange: setFollowing,
          onVisibleMessages: setVisible,
        },
        banner,
        composer,
        items,
        jump,
        typing: typingLine(snapshot.typing[typingKey] ?? [], viewerId, directory),
        viewerId,
      })}
      {held === null ? null : (
        <MenuView
          actions={heldActions.map(({ id, title }) => ({ id, title }))}
          colorScheme="dark"
          onCloseMenu={() => setHeld(null)}
          onPressAction={({ nativeEvent }) =>
            void act(held, nativeEvent.event as MessageActionId).catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : "That didn't work."),
            )
          }
          ref={menu}
          style={styles.anchor}
        >
          <View />
        </MenuView>
      )}
    </View>
  );
}

interface Staged {
  readonly source: TeamUploadSource;
  readonly fileId: string | null;
  readonly refused: string | null;
  readonly failed: string | null;
}

function stagedView(row: Staged): StagedAttachmentView {
  return {
    id: row.source.localId,
    name: row.source.name,
    kind: row.source.mediaType.startsWith("image/") ? "image" : "file",
    previewUri: row.source.mediaType.startsWith("image/") ? row.source.uri : null,
    progress: row.fileId === null && row.refused === null && row.failed === null ? 0.5 : null,
    refused: row.refused ?? row.failed,
  };
}

async function command(session: TeamSessionClient, input: HostApiCommandInput): Promise<void> {
  unwrapRpcResult(await session.rpc["commands.dispatch"](input));
}

/** The handle being typed after an @ at the cursor, or null when no mention is open. */
export function activeMention(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
  return match === null ? null : match[2]!.toLowerCase();
}

/**
 * The structured mentions a message's words carry: `@maya` names a person and
 * `@maya-agent` their agent. A handle nobody here has stays plain text.
 */
export function writtenMentions(
  body: string,
  members: readonly Pick<TeamMember, "handle" | "userId">[],
): { readonly userId: TeamMember["userId"]; readonly kind: "person" | "agent" }[] {
  const byHandle = new Map(members.map((member) => [member.handle, member.userId]));
  const found = new Map<string, { userId: TeamMember["userId"]; kind: "person" | "agent" }>();
  for (const match of body.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const handle = match[1]!;
    const agent = handle.endsWith("-agent");
    const userId = byHandle.get(agent ? handle.slice(0, -"-agent".length) : handle);
    if (userId === undefined) continue;
    const kind = agent ? "agent" : "person";
    found.set(`${userId}:${kind}`, { userId, kind });
  }
  return [...found.values()];
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** One line per team, shown only once a reconnect has taken two seconds. Never a modal. */
function useConnectionBanner(
  team: MobileTeam | null,
  connection: "offline" | "connecting" | "connected",
  retry: () => void,
): ConnectionBannerView | null {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (connection === "connected") {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), 2_000);
    return () => clearTimeout(timer);
  }, [connection]);
  const name = team?.name ?? "the team";
  if (team?.state === "update-app")
    return { text: `Update Opensteer to keep using ${name}`, tone: "amber", action: null };
  if (team?.state === "update-server")
    return { text: `${name}'s server needs an update`, tone: "amber", action: null };
  if (!late || connection === "connected") return null;
  return connection === "connecting"
    ? { text: `Reconnecting to ${name}…`, tone: "muted", action: null }
    : {
        text: `Can't reach ${name}`,
        tone: "danger",
        action: { label: "Try again", onPress: retry },
      };
}

const styles = StyleSheet.create({
  anchor: { bottom: 0, left: 0, position: "absolute" },
  failure: { paddingHorizontal: space[14] },
  fill: { flex: 1 },
  waiting: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
});
