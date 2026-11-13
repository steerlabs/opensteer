import { unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import {
  SequenceSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import type { HostApiCommandInput, TeamMessage } from "@opensteer/protocol";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, space } from "../theme.js";
import type { NativeMenuOption } from "../thread/composer-menu.js";
import { AppText, Notice, RowGroup } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import {
  ChannelDetailsBody,
  InstructionsBody,
  MembersBody,
  type NotifyLevel,
} from "./channel-details.js";
import { FilesBody, PinnedBody, type FileKindFilter } from "./channel-shelves.js";
import { LinkRow } from "./settings-rows.js";
import { useTeamMembers, useTeamPreviews, useTeamSession } from "./team-context.js";
import { noteWhen } from "./knowledge-model.js";
import type { FileRowView, MemberRowView, MessageView } from "./team-models.js";
import { SearchBody, type SearchFilters } from "./team-search.js";
import {
  attachmentView,
  channelHeader,
  messageView,
  personView,
  type MemberDirectory,
} from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type ChannelParams = StaticScreenProps<{ readonly teamId: string; readonly channelId: string }>;

/** Reads one page from the team, again whenever `key` changes. */
function useTeamRead<Value>(
  session: TeamSessionClient | null,
  read: (session: TeamSessionClient) => Promise<Value>,
  key: string,
): { readonly value: Value | null; readonly failure: string | null; readonly reload: () => void } {
  const [value, setValue] = useState<Value | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((next) => next + 1), []);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void read(session).then(
      (next) => {
        if (!current) return;
        setValue(next);
        setFailure(null);
      },
      (error: unknown) =>
        current && setFailure(error instanceof Error ? error.message : "The team didn't answer."),
    );
    return () => {
      current = false;
    };
    // `read` is rebuilt every render; `key` says when its answer can differ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, key, generation]);
  return { value, failure, reload };
}

async function command(session: TeamSessionClient, input: HostApiCommandInput): Promise<void> {
  unwrapRpcResult(await session.rpc["commands.dispatch"](input));
}

function Loading(props: { readonly failure: string | null }): ReactNode {
  return (
    <View style={styles.center}>
      {props.failure === null ? (
        <ActivityIndicator color={color.muted} />
      ) : (
        <Notice detail={props.failure} title="This didn't load" tone="neutral" />
      )}
    </View>
  );
}

function useBottomPadding(): number {
  return useSafeAreaInsets().bottom + space[24];
}

/** A channel's Details: on a phone it holds the desktop's tabs as rows. */
export function TeamDetailsScreen(props: ChannelParams): ReactNode {
  const { teamId, channelId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const channelKey = TeamChannelIdSchema.parse(channelId);
  const channel = useTeamRead(
    session,
    async (team) => unwrapRpcResult(await team.rpc["team.channel.get"]({ channelId: channelKey })),
    `${channelId}:${snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const counts = useTeamRead(
    session,
    async (team) => {
      const [files, pins, access] = await Promise.all([
        team.rpc["team.files.page"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.pins.page"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.channel.access.get"]({ channelId: channelKey }).then(unwrapRpcResult),
      ]);
      return {
        files: files.files.length,
        pinned: pins.messages.length,
        members: access.entries.length,
      };
    },
    channelId,
  );
  // Rename, Members, Files and Pinned are screens of their own: coming back reads again.
  const { reload: reloadChannel } = channel;
  const { reload: reloadCounts } = counts;
  const returned = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (returned.current) {
        reloadChannel();
        reloadCounts();
      }
      returned.current = true;
    }, [reloadChannel, reloadCounts]),
  );
  const entry = snapshot.sidebar?.channels.find((row) => row.channel.id === channelId);
  const notify: NotifyLevel =
    entry?.notificationLevel === "all"
      ? "everything"
      : entry?.notificationLevel === "muted"
        ? "nothing"
        : "mentions";
  const working =
    snapshot.channel?.scope.channelId === channelId
      ? snapshot.channel.messages
          .flatMap((message) => message.requests)
          .filter((request) => ["queued", "working", "needs_you"].includes(request.state)).length
      : 0;
  if (session === null || channel.value === null)
    return (
      <Screen>
        <Loading failure={channel.failure} />
      </Screen>
    );
  const value = channel.value;
  const run = (input: HostApiCommandInput, after?: () => void): void => {
    void command(session, input).then(
      () => {
        channel.reload();
        after?.();
      },
      (error: unknown) =>
        Alert.alert("That didn't work", error instanceof Error ? error.message : undefined),
    );
  };
  const setNotify = (level: "all" | "mentions" | "muted"): void =>
    run(
      { type: "team.channel.preferences.set", channelId: channelKey, notificationLevel: level },
      () => void session.refreshSidebar().catch(() => undefined),
    );
  return (
    <Screen edgeToEdge>
      <ChannelDetailsBody
        actions={{
          onMembers: () => navigation.navigate("TeamMembers", { teamId, channelId }),
          onFiles: () => navigation.navigate("TeamFiles", { teamId, channelId }),
          onPinned: () => navigation.navigate("TeamPinned", { teamId, channelId }),
          onInstructions: () => navigation.navigate("TeamInstructions", { teamId, channelId }),
          onNotify: () =>
            Alert.alert("Notify me", undefined, [
              { text: "Everything", onPress: () => setNotify("all") },
              { text: "Mentions", onPress: () => setNotify("mentions") },
              { text: "Nothing", onPress: () => setNotify("muted") },
            ]),
          onRename: () => navigation.navigate("TeamRenameChannel", { teamId, channelId }),
          onSetPeopleOnly: (on) =>
            run({
              type: "team.channel.update",
              channelId: channelKey,
              name: value.name,
              peopleOnly: on,
            }),
          onAddPeople: () => navigation.navigate("TeamMembers", { teamId, channelId }),
          onLeave: () =>
            Alert.alert(
              `Leave #${value.name}?`,
              value.kind === "public"
                ? "You can join it again from Browse channels."
                : "Someone who manages it will have to add you back.",
              [
                { style: "cancel", text: "Cancel" },
                {
                  style: "destructive",
                  text: "Leave",
                  onPress: () =>
                    run({ type: "team.channel.leave", channelId: channelKey }, () =>
                      navigation.popToTop(),
                    ),
                },
              ],
            ),
          onArchive: () =>
            Alert.alert(
              `Archive #${value.name}?`,
              "Nobody can post in it and it leaves everyone's list. Its messages stay, and it can be restored from these details.",
              [
                { style: "cancel", text: "Cancel" },
                {
                  style: "destructive",
                  text: "Archive",
                  onPress: () => run({ type: "team.channel.archive", channelId: channelKey }),
                },
              ],
            ),
          onRestore: () => run({ type: "team.channel.restore", channelId: channelKey }),
        }}
        archived={value.archivedAt !== null}
        canLeave={value.can.leave}
        canManage={value.can.manage}
        channel={channelHeader({
          channel: value,
          memberCount: counts.value?.members ?? null,
          people: [],
        })}
        counts={counts.value}
        notify={notify}
        paddingBottom={padding}
        workingAgents={working}
      />
    </Screen>
  );
}

/**
 * The people and groups on a channel's list; managers add and remove them. A
 * group DM lists its people, and anyone in it adds more, who then read its history.
 */
export function TeamMembersScreen(props: ChannelParams): ReactNode {
  const { teamId, channelId } = props.route.params;
  const { session } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const padding = useBottomPadding();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const channelKey = TeamChannelIdSchema.parse(channelId);
  const access = useTeamRead(
    session,
    async (team) => {
      const [list, groups, channel] = await Promise.all([
        team.rpc["team.channel.access.get"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.groups.list"]({}).then(unwrapRpcResult),
        team.rpc["team.channel.get"]({ channelId: channelKey }).then(unwrapRpcResult),
      ]);
      return { list, groups: groups.groups, channel };
    },
    channelId,
  );
  if (session === null || access.value === null)
    return (
      <Screen>
        <Loading failure={access.failure} />
      </Screen>
    );
  const { list, groups, channel } = access.value;
  // A group DM's people are added with the DM's own command and never replaced.
  const groupDm = channel.kind === "group_dm";
  const canAdd = groupDm ? channel.can.post : list.can.manage;
  const canRemove = !groupDm && list.can.manage;
  const lower = query.trim().toLowerCase();
  const rows: MemberRowView[] = list.entries
    .map((entry): MemberRowView => {
      if (entry.subject.kind === "person") {
        const person = personView(entry.subject.userId, directory);
        return {
          id: entry.subject.userId,
          kind: "person",
          name: person.name,
          detail: `@${person.handle}`,
          person,
          role: entry.manage && !groupDm ? "manager" : "member",
          canRemove,
        };
      }
      const groupId = entry.subject.groupId;
      const group = groups.find((row) => row.id === groupId);
      return {
        id: groupId,
        kind: "group",
        name: group?.name ?? "Group",
        detail: `${group?.people.length ?? 0} people`,
        person: null,
        role: entry.manage ? "manager" : "member",
        canRemove,
      };
    })
    .filter((row) => lower === "" || row.name.toLowerCase().includes(lower));
  const listed = new Set(
    list.entries.map((entry) =>
      entry.subject.kind === "person" ? entry.subject.userId : entry.subject.groupId,
    ),
  );
  const candidates: MemberRowView[] = adding
    ? members
        .filter((member) => member.state === "active" && !listed.has(member.userId))
        .filter((member) => lower === "" || member.displayName.toLowerCase().includes(lower))
        .slice(0, 50)
        .map((member) => {
          const person = personView(member.userId, directory);
          return {
            id: member.userId,
            kind: "person",
            name: person.name,
            detail: `@${person.handle}`,
            person,
            role: "member",
            canRemove: false,
          };
        })
    : [];
  const replace = (entries: typeof list.entries): void => {
    void command(session, {
      type: "team.channel.access.set",
      channelId: channelKey,
      expectedRevision: list.revision,
      access: [...entries],
    }).then(access.reload, (error: unknown) =>
      Alert.alert("That didn't work", error instanceof Error ? error.message : undefined),
    );
  };
  const addToDm = (userId: string): void => {
    const name = personView(userId, directory).name;
    Alert.alert(`Add ${name}?`, `${name} will see this conversation's earlier messages.`, [
      { style: "cancel", text: "Cancel" },
      {
        text: "Add",
        onPress: () =>
          void command(session, {
            type: "team.dm.people.add",
            channelId: channelKey,
            userIds: [UserIdSchema.parse(userId)],
            historyVisibleConfirmed: true,
          }).then(access.reload, (error: unknown) =>
            Alert.alert("That didn't work", error instanceof Error ? error.message : undefined),
          ),
      },
    ]);
  };
  return (
    <Screen edgeToEdge>
      <MembersBody
        canAdd={canAdd}
        candidates={candidates}
        members={rows}
        onAdd={() => setAdding((now) => !now)}
        onAddMember={(userId) =>
          groupDm
            ? addToDm(userId)
            : replace([
                ...list.entries,
                {
                  subject: { kind: "person", userId: UserIdSchema.parse(userId) },
                  level: "post",
                  manage: false,
                },
              ])
        }
        onQuery={setQuery}
        onRemove={(id) =>
          replace(
            list.entries.filter((entry) =>
              entry.subject.kind === "person"
                ? entry.subject.userId !== id
                : entry.subject.groupId !== id,
            ),
          )
        }
        paddingBottom={padding}
        query={query}
      />
    </Screen>
  );
}

/** The instructions every agent run started in a channel is given. */
export function TeamInstructionsScreen(props: ChannelParams): ReactNode {
  const { teamId, channelId } = props.route.params;
  const { session } = useTeamSession(teamId);
  const channelKey = TeamChannelIdSchema.parse(channelId);
  const [failure, setFailure] = useState<string | null>(null);
  const read = useTeamRead(
    session,
    async (team) => {
      const [channel, instructions] = await Promise.all([
        team.rpc["team.channel.get"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.channel.instructions.get"]({ channelId: channelKey }).then(unwrapRpcResult),
      ]);
      return { channel, instructions };
    },
    channelId,
  );
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const { channel, instructions } = read.value;
  return (
    <Screen edgeToEdge>
      <InstructionsBody
        canEdit={channel.can.manage}
        channelName={channel.name}
        failure={failure}
        instructions={
          instructions.instructionsMarkdown.trim() === "" ? null : instructions.instructionsMarkdown
        }
        lastChanged={null}
        onSave={async (text) => {
          setFailure(null);
          try {
            await command(session, {
              type: "team.channel.instructions.set",
              channelId: channelKey,
              expectedRevision: SequenceSchema.parse(instructions.revision),
              instructionsMarkdown: text,
            });
            read.reload();
          } catch (error) {
            setFailure(error instanceof Error ? error.message : "They weren't saved.");
            throw error;
          }
        }}
      />
    </Screen>
  );
}

/** Every file the channel's messages carry, newest first; nothing downloads until opened. */
export function TeamFilesScreen(props: ChannelParams): ReactNode {
  const { teamId, channelId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FileKindFilter>("all");
  const read = useTeamRead(
    session,
    async (team) =>
      unwrapRpcResult(
        await team.rpc["team.files.page"]({ channelId: TeamChannelIdSchema.parse(channelId) }),
      ).files,
    channelId,
  );
  const carriers = useMemo(
    () =>
      (read.value ?? []).map(
        (row) => ({ id: row.messageId, attachments: [row.file] }) as unknown as TeamMessage,
      ),
    [read.value],
  );
  const previews = useTeamPreviews(session, carriers);
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const lower = query.trim().toLowerCase();
  const files: FileRowView[] = read.value
    .map((row) => ({
      id: row.file.id,
      messageId: row.messageId,
      attachment: attachmentView(row.file, previews),
      pinned: false,
      mediaType: row.file.mediaType,
    }))
    .filter((row) => lower === "" || row.attachment.name.toLowerCase().includes(lower))
    .filter((row) =>
      filter === "all"
        ? true
        : filter === "images"
          ? row.mediaType.startsWith("image/")
          : filter === "documents"
            ? /pdf|text|document|sheet|presentation/.test(row.mediaType)
            : !row.mediaType.startsWith("image/") &&
              !/pdf|text|document|sheet|presentation/.test(row.mediaType),
    );
  return (
    <Screen edgeToEdge>
      <FilesBody
        files={files}
        filter={filter}
        onFilter={setFilter}
        onOpen={(file) =>
          navigation.navigate("TeamChannel", { teamId, channelId, messageId: file.messageId })
        }
        onQuery={setQuery}
        onShowMessage={(messageId) =>
          navigation.navigate("TeamChannel", { teamId, channelId, messageId })
        }
        paddingBottom={padding}
        query={query}
      />
    </Screen>
  );
}

/** Pinned messages, newest pin first. */
export function TeamPinnedScreen(props: ChannelParams): ReactNode {
  const { teamId, channelId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot } = useTeamSession(teamId);
  const { directory } = useTeamMembers(teamId);
  const padding = useBottomPadding();
  const channelKey = TeamChannelIdSchema.parse(channelId);
  const read = useTeamRead(
    session,
    async (team) =>
      unwrapRpcResult(await team.rpc["team.pins.page"]({ channelId: channelKey })).messages,
    channelId,
  );
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const viewerId = snapshot.bootstrap?.member.userId ?? "";
  const now = new Date();
  return (
    <Screen edgeToEdge>
      <PinnedBody
        onShow={(messageId) => navigation.navigate("TeamChannel", { teamId, channelId, messageId })}
        onUnpin={(messageId) =>
          void command(session, {
            type: "team.message.unpin",
            channelId: channelKey,
            messageId: TeamMessageIdSchema.parse(messageId),
          }).then(read.reload, () => undefined)
        }
        paddingBottom={padding}
        pins={[...read.value]
          .reverse()
          .map((message) => outOfTimeline(message, viewerId, directory, now))}
      />
    </Screen>
  );
}

/** A message shown away from its timeline, where no day line says when it was: its time says the day too. */
function outOfTimeline(
  message: TeamMessage,
  viewerId: string,
  directory: MemberDirectory,
  now: Date,
): MessageView {
  return {
    ...messageView(message, {
      viewerId,
      members: directory,
      previews: new Map(),
      previous: null,
      requests: [],
      inThread: true,
    }),
    time: noteWhen(message.createdAt, now),
  };
}

/** One team's messages, narrowed by the four filters the team answers. */
export function TeamSearchScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly channelId?: string | undefined }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot, team } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const padding = useBottomPadding();
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState<string | null>(props.route.params.channelId ?? null);
  const [authorId, setAuthorId] = useState<string | null>(null);
  const [inThreads, setInThreads] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (session === null || query.trim() === "") return;
    const timer = setTimeout(() => {
      setFailure(null);
      setSearching(true);
      void session
        .search({
          query: query.trim(),
          ...(channelId === null ? {} : { channelId: TeamChannelIdSchema.parse(channelId) }),
          ...(authorId === null ? {} : { authorUserId: UserIdSchema.parse(authorId) }),
          ...(hasFile ? { hasFile: true } : {}),
          ...(inThreads ? { threadsOnly: true } : {}),
        })
        .catch((error: unknown) =>
          setFailure(error instanceof Error ? error.message : "The team didn't answer."),
        )
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [attempt, authorId, channelId, hasFile, inThreads, query, session]);
  const viewerId = snapshot.bootstrap?.member.userId ?? "";
  const channelName =
    snapshot.sidebar?.channels.find((row) => row.channel.id === channelId)?.channel.name ?? null;
  const filters: SearchFilters = {
    channel: channelName === null ? null : `#${channelName}`,
    author: authorId === null ? null : personView(authorId, directory).name,
    thread: inThreads,
    file: hasFile,
  };
  const now = new Date();
  const results = (
    query.trim() === "" || failure !== null ? [] : (snapshot.search?.results ?? [])
  ).map((row) => ({
    message: outOfTimeline(row.message, viewerId, directory, now),
    where:
      row.message.threadRootId === null
        ? `#${row.source.audience.channelName}`
        : `#${row.source.audience.channelName} thread`,
    match: query.trim(),
    raw: row.message,
  }));
  const onFilter = (filter: "thread" | "file"): void => {
    if (filter === "thread") setInThreads((on) => !on);
    else setHasFile((on) => !on);
  };
  const channelChoices = useMemo(
    (): readonly NativeMenuOption[] => [
      {
        id: "any",
        label: "Every channel",
        selected: channelId === null,
        onPress: () => setChannelId(null),
      },
      ...(snapshot.sidebar?.channels ?? [])
        .filter((row) => row.channel.archivedAt === null)
        .map((row) => ({
          id: row.channel.id,
          label:
            row.channel.kind === "dm" || row.channel.kind === "group_dm"
              ? row.channel.name
              : `#${row.channel.name}`,
          selected: row.channel.id === channelId,
          onPress: () => setChannelId(row.channel.id),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    ],
    [channelId, snapshot.sidebar?.channels],
  );
  const authorChoices = useMemo(
    (): readonly NativeMenuOption[] => [
      { id: "any", label: "Anyone", selected: authorId === null, onPress: () => setAuthorId(null) },
      ...members
        .filter((member) => member.state === "active")
        .map((member) => ({
          id: member.userId,
          label: member.userId === viewerId ? "Me" : member.displayName,
          selected: member.userId === authorId,
          onPress: () => setAuthorId(member.userId),
        }))
        .sort(
          (left, right) =>
            Number(right.label === "Me") - Number(left.label === "Me") ||
            left.label.localeCompare(right.label),
        ),
    ],
    [authorId, members, viewerId],
  );
  return (
    <Screen edgeToEdge>
      <SearchBody
        authorChoices={authorChoices}
        channelChoices={channelChoices}
        filters={filters}
        groups={[
          {
            team: { id: teamId, name: team?.name ?? "Team", imageUri: null },
            results,
            more: snapshot.search?.hasMore ?? false,
          },
        ]}
        onFilter={onFilter}
        onMore={() =>
          void session
            ?.loadMoreSearch()
            .catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : "The team didn't answer."),
            )
        }
        onOpenMessage={(_team, result) => {
          const raw = results.find((row) => row.message.id === result.message.id)?.raw;
          if (raw === undefined) return;
          if (raw.threadRootId === null)
            navigation.navigate("TeamChannel", {
              teamId,
              channelId: raw.channelId,
              messageId: raw.id,
            });
          else
            navigation.navigate("TeamThread", {
              teamId,
              channelId: raw.channelId,
              rootId: raw.threadRootId,
              replyId: raw.id,
            });
        }}
        failure={query.trim() === "" ? null : failure}
        onQuery={setQuery}
        onRetry={() => setAttempt((next) => next + 1)}
        paddingBottom={padding}
        query={query}
        searching={searching}
      />
    </Screen>
  );
}

/**
 * What the team told the reader: when an admin added themselves to something
 * the reader manages. Opening one marks it read.
 */
export function TeamNoticesScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const read = useTeamRead(
    session,
    async (team) => unwrapRpcResult(await team.rpc["team.notices.page"]({})).notices,
    teamId,
  );
  const markRead = useCallback(
    (noticeId: string) => {
      if (session === null) return;
      void command(session, {
        type: "team.notice.read",
        noticeId: TeamNoticeIdSchema.parse(noticeId),
      }).then(read.reload, () => undefined);
    },
    [read.reload, session],
  );
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const now = new Date();
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[styles.form, { paddingBottom: padding }]}>
        {read.value.length === 0 ? (
          <AppText role="secondary" tone="muted">
            Nothing from the team.
          </AppText>
        ) : (
          <RowGroup>
            {read.value.map((notice) => (
              <LinkRow
                detail={noteWhen(notice.createdAt, now)}
                key={notice.id}
                label={`An admin added themselves to this ${notice.resourceKind}. It's in the audit log.`}
                onPress={() => markRead(notice.id)}
                {...(notice.readAt === null ? { tone: "ember" as const } : {})}
              />
            ))}
          </RowGroup>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
  form: { gap: space[16], padding: space[16] },
});
