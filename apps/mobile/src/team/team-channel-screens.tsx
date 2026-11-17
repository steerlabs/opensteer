import { useTeamShareParticipants } from "@opensteer/client/react";
import { teamMentions, teamMessage } from "@opensteer/shared/teamMentions";
import { TeamImageSources } from "./team-image-hold.js";
import { teamImageSource, shareTeamFile } from "./team-file-export.js";
import { MenuView, type MenuComponentRef } from "@expo/ui/community/menu";
import { PersonalTeamLinks, watchTeamReplyRead, unwrapRpcResult } from "@opensteer/client/host";
import {
  channelShareView,
  teamAskRefusalNotice,
  teamScopeKey,
  type TeamSessionClient,
  type TeamTimeline,
} from "@opensteer/client/team";
import {
  TeamAgentRequestIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  teamAgentHandle,
  teamPageUrl,
  type TeamMessageId,
} from "@opensteer/core";
import {
  teamUploadMaxBytes,
  type HostApiCommandInput,
  type TeamMember,
  type TeamMessage,
} from "@opensteer/protocol";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
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
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, View } from "react-native";
import { clientIssueActions } from "@opensteer/client/feedback";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { enterSide } from "../navigation-ref.js";
import type { RootParamList } from "../navigation.js";
import * as Haptics from "expo-haptics";
import { color, space } from "../theme.js";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { BarControl } from "../ui/bar-control.js";
import { useCopy } from "../ui/copy-mark.js";
import { useMobileClient, useSelectedHostClient } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  ChannelScreenBody,
  ChannelTitle,
  ThreadScreenBody,
  ThreadTitle,
} from "./channel-screen.js";
import { sendFromComposer } from "./composer-send.js";
import { TeamWaiting } from "./team-feedback.js";
import { actOnce, outcomeLine } from "../ui/client-feedback.js";
import { messageActions, type MessageActionId } from "./message-row.js";
import type { MobileTeam } from "./mobile-teams.js";
import { useTeamMembers, useTeamPreviews, useTeamSession } from "./team-context.js";
import { GeneralWelcome } from "./team-entry-screens.js";
import type {
  AgentReach,
  JumpView,
  MentionOption,
  MessageView,
  StagedAttachmentView,
} from "./team-models.js";
import type { TeamComposerProps } from "./team-composer.js";
import type { ComposerEditorHandle } from "@opensteer/client/references";
import {
  insertReference,
  startReference,
  useTeamReferenceSections,
} from "../ui/composer-reference-picker.js";
import { discardPastedImage } from "../../modules/composer-editor/files.js";
import type { PastedImages } from "../../modules/composer-editor/index.js";
import {
  pastedTeamSource,
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
  type AskOwnerFacts,
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
  const people = useTeamMembers(teamId, channelId);
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
          <BarControl>
            <Pressable
              accessibilityHint="Opens members, files, pinned messages and settings"
              accessibilityRole="button"
              onPress={() => navigation.navigate("TeamDetails", { teamId, channelId })}
            >
              <ChannelTitle channel={header} />
            </Pressable>
          </BarControl>
        ),
      headerRight: () => (
        <BarControl>
          <Pressable
            accessibilityLabel="Search this channel"
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => navigation.navigate("TeamSearch", { teamId, channelId })}
          >
            <Symbol name="magnifyingglass" size={18} tint={color.ember} />
          </Pressable>
        </BarControl>
      ),
    });
  }, [channelId, header, navigation, teamId]);

  if (session === null || view === null || view.channel === null || header === null)
    return <TeamWaiting />;
  const bootstrap = snapshot.bootstrap;
  const channelName = view.channel.name;
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
            welcome={
              bootstrap !== null &&
              (bootstrap.generalChannelId
                ? bootstrap.generalChannelId === channelId
                : channelName === "general") ? (
                <GeneralWelcome
                  bootstrap={bootstrap}
                  teamId={teamId}
                  teamName={team?.name ?? bootstrap.teamName}
                />
              ) : null
            }
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
  const people = useTeamMembers(teamId, channelId);
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
    return (
      <TeamWaiting
        line={
          view !== null && snapshot.error !== null
            ? {
                key: "thread-failed",
                text: "Couldn't load this thread.",
                tone: "muted",
                link: {
                  label: clientIssueActions.tryAgain,
                  onPress: () =>
                    session?.selectThread(
                      TeamChannelIdSchema.parse(channelId),
                      TeamMessageIdSchema.parse(rootId),
                    ),
                },
              }
            : null
        }
      />
    );
  return (
    <Screen edgeToEdge>
      <Place
        directory={people.directory}
        members={people.members}
        rootId={rootId}
        session={session}
        team={team}
        teamId={teamId}
        view={view}
      >
        {(place) => (
          <ThreadScreenBody
            {...place}
            anchorId={landing.anchorId}
            replyCount={root.replySummary.count}
            root={rootView(root, place.viewerId, people.directory, place.asks)}
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

function rootView(
  root: TeamMessage,
  viewerId: string,
  directory: MemberDirectory,
  asks: AskOwnerFacts,
): MessageView {
  return messageView(root, {
    viewerId,
    members: directory,
    previews: new Map(),
    previous: null,
    requests: root.requests,
    inThread: true,
    asks,
  });
}

/** How many people and groups the channel's list holds, read once it is open; null until known. */
function useChannelMemberCount(
  session: TeamSessionClient | null,
  channelId: string,
): number | null {
  const [count, setCount] = useState<number | null>(null);
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
  readonly asks: AskOwnerFacts;
  readonly channelFact: string | null;
  readonly composer: TeamComposerProps;
  /** Why the reader can't post here, in the composer's place; null when they can. */
  readonly closed: string | null;
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
  readonly children: (place: PlaceProps) => ReactNode;
}): ReactNode {
  const { session, view, directory, teamId } = props;
  const navigation = useNavigation<Navigation>();
  const mobile = useMobileClient();
  const personal = useSelectedHostClient();
  const aiSharing = useAiSharing();
  // The reader's own Needs you knows which asks of their agent wait in a task, and at
  // which version, which is what answering one from here approves.
  const needsYou = useSyncExternalStore(
    useCallback((notify: () => void) => personal?.subscribe(notify) ?? (() => {}), [personal]),
    useCallback(() => personal?.getSnapshot().needsYou ?? null, [personal]),
  );
  const asks = useMemo(() => ({ needsYou, teamId }), [needsYou, teamId]);
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
        sendErrors: snapshot.sendErrors,
        connected: snapshot.connection === "connected",
        now: new Date(),
        ...(rootId === null ? {} : { skipId: rootId }),
        asks,
      }),
    [
      asks,
      directory,
      newLineAt,
      previews,
      rootId,
      snapshot.unreachable,
      snapshot.pending,
      snapshot.sendErrors,
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
  useFocusEffect(
    useCallback(() => {
      if (replyInView === null || rootId === null || personal === null) return;
      let stop: (() => void) | undefined;
      const changed = () => {
        stop?.();
        stop =
          AppState.currentState === "active"
            ? watchTeamReplyRead(personal, {
                teamId,
                channelId,
                threadRootId: rootId,
                replyMessageId: replyInView,
              })
            : undefined;
      };
      const subscription = AppState.addEventListener("change", changed);
      changed();
      return () => {
        subscription.remove();
        stop?.();
      };
    }, [channelId, personal, replyInView, rootId, teamId]),
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
  const editor = useRef<ComposerEditorHandle>(null);
  /** Puts other words in the field outright; a keystroke still on its way cannot undo it. */
  const replaceText = (next: string): void => {
    setText(next);
    const field = editor.current;
    field?.restore({
      composing: false,
      generation: field.readSnapshot().generation + 1,
      selection: { start: next.length, end: next.length },
      text: next,
    });
  };
  // Editing one of the reader's messages sets their unsent words aside until it ends.
  const [editing, setEditing] = useState<{
    readonly id: TeamMessageId;
    readonly draft: string;
  } | null>(null);
  // The edit open now. A save that ends after it was cancelled, or another began, leaves
  // the composer as the reader has it since.
  const openEdit = useRef(editing);
  openEdit.current = editing;
  const [savingEdit, setSavingEdit] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [localToMyAgent, setLocalToMyAgent] = useState(false);
  const toMyAgent =
    rootId === null
      ? localToMyAgent
      : (snapshot.agentRecipients.find(
          (row) => row.channelId === channelId && row.rootId === rootId,
        )?.enabled ?? false);
  const setToMyAgent = (enabled: boolean) => {
    if (rootId === null) setLocalToMyAgent(enabled);
    else
      void session
        .setAgentRecipient(channelId, rootId, enabled)
        .catch(() => setFailure(localLine("Couldn't change who this goes to.")));
  };
  const [staged, setStaged] = useState<readonly Staged[]>([]);
  const [failure, setFailure] = useState<ActionLineValue | null>(null);
  /** A tap's team work: its outcome is the line above the composer until the next one. */
  const attempt = (
    on: TeamSessionClient | NonNullable<typeof personal>,
    spec: { readonly label: string; readonly done: string; readonly happened?: string },
    work: () => Promise<unknown>,
  ): Promise<boolean> =>
    actOnce(on, spec, work).then((outcome) => {
      setFailure(outcomeLine(outcome));
      return outcome.kind === "confirmed";
    });
  // Pasted images are this screen's own temporary copies: each goes once its
  // row leaves the strip (removed or sent), and all go with the screen.
  const pastedFiles = useRef(new Map<string, string>());
  useEffect(() => {
    const held = new Set(staged.map((row) => row.source.localId));
    for (const [localId, uri] of pastedFiles.current)
      if (!held.has(localId)) {
        pastedFiles.current.delete(localId);
        discardPastedImage(uri);
      }
  }, [staged]);
  useEffect(() => {
    const files = pastedFiles.current;
    return () => {
      for (const uri of files.values()) discardPastedImage(uri);
      files.clear();
    };
  }, []);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeText = (next: string): void => {
    setText(next);
    session.typing(channelId, rootId, next !== "");
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (editing === null)
        void session.setDraft(view.scope, next).catch(() => {
          if (!session.owner?.signal.aborted)
            setFailure(localLine("Couldn't save your draft on this phone."));
        });
    }, 400);
  };
  const mentionQuery = activeMention(text, selection.start);
  const participants = useTeamShareParticipants(
    session,
    channelId,
    channel.share ? mentionQuery : null,
  );
  const mentions: readonly MentionOption[] | null =
    mentionQuery === null
      ? null
      : mentionOptions({
          query: mentionQuery,
          viewerId,
          members: props.members,
          reach,
          people: [...directory.values()]
            .filter((p) =>
              p.externalTeam
                ? participants.items.some(
                    (row) => row.userId === p.userId && row.state === "active",
                  )
                : props.members.some((row) => row.userId === p.userId && row.state === "active"),
            )
            .map((p) => ({
              ...p,
              handle: participants.items.find((row) => row.userId === p.userId)?.handle ?? p.handle,
            })),
        });
  const me = directory.get(viewerId) ?? null;
  const references = useTeamReferenceSections(
    session,
    props.team?.origin ?? null,
    snapshot.sidebar,
    mentionQuery,
  );

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
    if (source !== null) await stage(source);
  };

  const pasteImages = (pasted: PastedImages): void => {
    // An edit changes only the words; an image pasted into it belongs to no message.
    if (editing !== null) {
      for (const image of pasted.images) discardPastedImage(image.uri);
      return;
    }
    if (pasted.tooLarge > 0)
      setFailure(localLine(`A pasted image is over ${teamUploadMaxBytes / 1_048_576} MB.`));
    else if (pasted.failed > 0) setFailure(localLine("A pasted image could not be read."));
    for (const image of pasted.images) {
      const source = pastedTeamSource(image);
      pastedFiles.current.set(source.localId, source.uri);
      void stage(source);
    }
  };

  const stage = async (source: TeamUploadSource): Promise<void> => {
    if (session.owner?.signal.aborted) return;
    const refused = uploadRefusal(source);
    const entry: Staged = { source, fileId: null, refused, failed: null };
    setStaged((held) => [...held, entry]);
    if (refused !== null) return;
    try {
      const fileId = await uploadToTeam({ session, channelId, source });
      setStaged((held) =>
        held.map((row) => (row.source.localId === source.localId ? { ...row, fileId } : row)),
      );
    } catch {
      setStaged((held) =>
        held.map((row) =>
          row.source.localId === source.localId ? { ...row, failed: "Not uploaded" } : row,
        ),
      );
    }
  };

  const send = async (): Promise<void> => {
    // The field's last keystroke can still be on its way to React: read what it holds now.
    const field = editor.current;
    let current = text;
    if (field !== null) {
      const flushed = await field
        .flushPendingInput(field.readSnapshot().generation)
        .catch(() => null);
      if (flushed === null || flushed.composing || openEdit.current !== editing) return;
      current = flushed.text;
    }
    const words = current.trim();
    setFailure(null);
    if (editing !== null) {
      if (words === "" || savingEdit) return;
      const saving = editing;
      setSavingEdit(true);
      const outcome = await actOnce(session, { label: "save this edit", done: "saved" }, () =>
        command(session, {
          type: "team.message.edit",
          channelId,
          messageId: saving.id,
          bodyMarkdown: words,
          mentions: [...teamMentions(words, directory.values())],
        }),
      );
      setSavingEdit(false);
      if (openEdit.current !== saving) return;
      if (outcome.kind === "confirmed") {
        replaceText(saving.draft);
        setEditing(null);
      } else setFailure(outcomeLine(outcome));
      return;
    }
    const files = staged.filter((row) => row.fileId !== null).map((row) => row.fileId!);
    if (words === "" && files.length === 0) return;
    if (staged.some((row) => row.fileId === null)) return;
    const asking = rootId === null && toMyAgent && reach === "available" && me !== null;
    const message = me
      ? teamMessage({ body: words, toMyAgent: asking }, me, directory)
      : { bodyMarkdown: words, mentions: teamMentions(words, directory.values()) };
    try {
      session.typing(channelId, rootId, false);
      await sendFromComposer(
        session,
        view.scope,
        {
          channelId,
          threadRootId: rootId,
          bodyMarkdown: message.bodyMarkdown,
          mentions: [...message.mentions],
          attachmentIds: files as never,
        },
        () => {
          // A pending draft save would put the sent words back.
          if (draftTimer.current !== null) clearTimeout(draftTimer.current);
          setStaged([]);
        },
      );
      replaceText("");
      // After sending it stays as the reader left it, in a thread; a channel's
      // ask opens its own thread, so the channel's composer starts off again.
      if (rootId === null) setToMyAgent(false);
    } catch {
      // The team's own delivery owner queues while it is away; only this phone's storage fails here.
      setFailure(localLine("Couldn't save this message on your phone. Try again."));
    }
  };

  const cancelEdit = (): void => {
    if (editing === null) return;
    replaceText(editing.draft);
    setEditing(null);
  };
  const { copy } = useCopy();

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
          canPost: channel.can.post,
          inThread: rootId !== null,
          message: heldView,
        }).filter(
          (action) => channel.can.post || action.id === "reply" || action.id === "copy-link",
        );
  const act = async (message: TeamMessage, id: MessageActionId): Promise<void> => {
    switch (id) {
      case "reply":
        navigation.navigate("TeamThread", { teamId, channelId, rootId: message.id });
        return;
      case "ask":
        await session
          .setAgentRecipient(channelId, message.threadRootId ?? message.id, true)
          .catch(() => setFailure(localLine("Couldn't change who this goes to.")));
        navigation.navigate("TeamThread", {
          teamId,
          channelId,
          rootId: message.threadRootId ?? message.id,
        });
        return;
      case "pin":
      case "unpin":
        await attempt(
          session,
          {
            label: id === "pin" ? "pin this message" : "unpin this message",
            done: id === "pin" ? "pinned" : "unpinned",
          },
          () =>
            command(session, {
              type: id === "pin" ? "team.message.pin" : "team.message.unpin",
              channelId,
              messageId: message.id,
            }),
        );
        return;
      case "copy-link": {
        const origin = props.team?.origin;
        if (origin !== undefined)
          await copy(
            teamPageUrl({
              origin,
              target: { kind: "message", channelId, messageId: message.id },
            }),
          );
        return;
      }
      case "edit":
        setEditing((held) => ({ id: message.id, draft: held?.draft ?? text }));
        replaceText(message.bodyMarkdown);
        return;
      case "delete":
        Alert.alert("Delete this message?", "It's removed for everyone here.", [
          { style: "cancel", text: "Cancel" },
          {
            style: "destructive",
            text: "Delete",
            onPress: () =>
              void attempt(
                session,
                {
                  label: "delete this message",
                  done: "deleted",
                  happened: "this message was deleted",
                },
                () =>
                  command(session, {
                    type: "team.message.delete",
                    channelId,
                    messageId: message.id,
                  }),
              ),
          },
        ]);
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
    let taskId: string | null = null;
    const found = await attempt(
      personal,
      { label: "open that task", done: "opened", happened: "that task opened" },
      async () => {
        taskId = await new PersonalTeamLinks(personal.rpc).task(teamId, channelId, threadRoot);
      },
    );
    if (!found) return;
    if (taskId !== null) enterSide({ name: "Thread", params: { deploymentId, threadId: taskId } });
    else setFailure(localLine("That task isn't on your computer.", "muted"));
  };

  // One file opens at a time, named over the composer until its sheet is closed.
  const [opening, setOpening] = useState<string | null>(null);
  const openFile = async (messageId: string, fileId: string): Promise<void> => {
    const file = view.messages
      .find((message) => message.id === messageId)
      ?.attachments.find((row) => row.id === fileId);
    if (file === undefined || opening !== null) return;
    setFailure(null);
    setOpening(file.filename);
    await attempt(
      session,
      { label: "open this file", done: "opened", happened: "this file opened" },
      () => shareFile(file),
    );
    setOpening(null);
  };
  const shareFile = async (file: TeamMessage["attachments"][number]): Promise<void> => {
    await shareTeamFile(session, file);
  };

  const shareView = channelShareView(channel.share);
  const channelFact =
    shareView && (channel.share?.state === "disconnected" || channel.share?.updateRequired)
      ? `${shareView.label}. ${shareView.detail}`
      : null;
  const closed = channel.can.post
    ? null
    : channel.share?.state === "disconnected"
      ? `No longer shared with ${channel.share.teamName}. This is a read-only archive.`
      : channel.archivedAt !== null
        ? "This channel is archived."
        : "You can read this channel but not post here.";
  const typingKey = JSON.stringify([channelId, rootId]);
  const refusalNotice = teamAskRefusalNotice(
    snapshot.sendNotices[teamScopeKey(view.scope)] ?? [],
    (id) => props.members.find((member) => member.userId === id)?.displayName ?? "That person",
  );
  const composer: TeamComposerProps = {
    editor,
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
    references,
    onPickReference: (row) => {
      if (mentionQuery === null) return;
      insertReference(
        editor.current,
        { start: selection.start - mentionQuery.length - 1 },
        selection.start,
        row.markdown,
      );
    },
    onMention: () => startReference(editor.current),
    attachments: staged.map(stagedView),
    onAttach: () => void attach(),
    onPasteImages: pasteImages,
    onRemoveAttachment: (id) =>
      setStaged((held) => held.filter((row) => row.source.localId !== id)),
    onSend: () => void send(),
    editing: editing === null ? null : { onCancel: cancelEdit, saving: savingEdit },
    ...(failure !== null
      ? {
          hint: (
            <View style={styles.line}>
              <ActionLine line={failure} numberOfLines={2} onDismiss={() => setFailure(null)} />
            </View>
          ),
        }
      : opening !== null
        ? {
            hint: (
              <View style={[styles.line, styles.opening]}>
                <ActivityIndicator color={color.muted} size="small" />
                <AppText numberOfLines={1} role="caption" style={styles.grow} tone="muted">
                  Opening {opening}…
                </AppText>
              </View>
            ),
          }
        : refusalNotice !== null
          ? {
              hint: (
                <AppText role="caption" style={styles.line} tone="muted">
                  {refusalNotice}
                </AppText>
              ),
            }
          : {}),
  };
  const byId = (id: string) => view.messages.find((message) => message.id === id) ?? null;
  return (
    <View style={styles.fill}>
      <TeamImageSources
        value={(id) => {
          const file = view.messages
            .flatMap((message) => message.attachments)
            .find((file) => file.id === id);
          if (!file)
            return {
              name: "Image",
              read: async () => {
                throw new Error("Image unavailable");
              },
            };
          return teamImageSource(session, file);
        }}
      >
        {props.children({
          actions: {
            onHold: (id) => setHeld(byId(id)),
            onOpenAttachment: (messageId, fileId) => void openFile(messageId, fileId),
            onOpenThread: (id) =>
              navigation.navigate("TeamThread", { teamId, channelId, rootId: id }),
            onOpenTask: (messageId) => void openTask(null, messageId),
            onDecideAsk: async (control, decision) => {
              if (personal === null) return;
              // Answering starts the reader's agent on the ask, with their AI companies.
              if (decision === "approve" && !(await authorizeAiSharing(aiSharing, personal)))
                return;
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              await attempt(
                personal,
                {
                  label: decision === "approve" ? "approve this ask" : "decline this ask",
                  done: decision === "approve" ? "approved" : "declined",
                },
                () =>
                  personal.decideTeamAsk(
                    decision === "approve"
                      ? {
                          decision,
                          expectedRevision: control.expectedRevision,
                          requestId: control.requestId,
                          teamId: control.teamId,
                        }
                      : { decision, requestId: control.requestId, teamId: control.teamId },
                  ),
              );
            },
            onOpenAskTask: (threadId) => {
              const deploymentId = mobile.getSnapshot().selection.deploymentId;
              if (deploymentId !== null) navigation.navigate("Thread", { deploymentId, threadId });
            },
            onUnsent: (messageId, choice) => {
              const clientMessageId = messageId.replace(/^pending:/, "");
              const pending = snapshot.pending.find(
                (row) => row.command.clientMessageId === clientMessageId,
              );
              if (pending === undefined) return;
              if (choice === "retry")
                void attempt(
                  session,
                  { label: "send this message", done: "sent", happened: "this message was sent" },
                  () => session.reconcilePending(),
                );
              else
                void (
                  choice === "edit"
                    ? session
                        .editPending(clientMessageId, pending.command.bodyMarkdown)
                        .then(() => replaceText(pending.command.bodyMarkdown))
                    : session.discardPending(clientMessageId)
                ).catch(() => setFailure(localLine("Couldn't change this message on your phone.")));
            },
            onCardAction: (requestId, action) => {
              if (action === "cancel" || action === "stop")
                void attempt(
                  session,
                  { label: "stop this", done: "stopped", happened: "it stopped" },
                  () =>
                    command(session, {
                      type: "team.agent.request.cancel",
                      requestId: TeamAgentRequestIdSchema.parse(requestId),
                    }),
                );
              else void openTask(requestId, null);
            },
            onOpenCardTask: (requestId) => void openTask(requestId, null),
            onLoadOlder: () =>
              void session
                .loadPage(rootId === null ? "channel" : "thread", "before")
                .catch(() => undefined),
            onFollowingChange: setFollowing,
            onVisibleMessages: setVisible,
          },
          asks,
          channelFact,
          closed,
          composer,
          items,
          jump,
          typing: typingLine(snapshot.typing[typingKey] ?? [], viewerId, directory),
          viewerId,
        })}
      </TeamImageSources>
      {held === null ? null : (
        <MenuView
          actions={heldActions.map(({ destructive, id, title }) => ({
            id,
            title,
            ...(destructive === true ? { attributes: { destructive: true } } : {}),
          }))}
          colorScheme="dark"
          onCloseMenu={() => setHeld(null)}
          onPressAction={({ nativeEvent }) => void act(held, nativeEvent.event as MessageActionId)}
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

/** A fact about this phone's own work, said where the composer's line goes. */
function localLine(text: string, tone: "muted" | "danger" = "danger"): ActionLineValue {
  return { key: `${text}:${Date.now()}`, text, tone, haptic: tone === "danger" ? "error" : null };
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

const styles = StyleSheet.create({
  anchor: { bottom: 0, left: 0, position: "absolute" },
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  line: { paddingHorizontal: space[14] },
  opening: { alignItems: "center", flexDirection: "row", gap: space[8] },
});
