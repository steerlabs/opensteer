import { unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import {
  KnowledgeTopicIdSchema,
  SequenceSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import type { HostApiCommandInput, TeamFact, TeamMessage, TeamTopic } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, space } from "../theme.js";
import type { NativeMenuOption } from "../thread/composer-menu.js";
import {
  AppText,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
} from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import {
  ChannelDetailsBody,
  InstructionsBody,
  MembersBody,
  type NotifyLevel,
} from "./channel-details.js";
import {
  FilesBody,
  KnowledgeTopicBody,
  KnowledgeTopicsBody,
  PinnedBody,
  type FileKindFilter,
} from "./channel-shelves.js";
import { LinkRow } from "./settings-rows.js";
import { useTeamMembers, useTeamPreviews, useTeamSession } from "./team-context.js";
import type { FileRowView, MemberRowView, ThingView, TopicSummaryView } from "./team-models.js";
import { SearchBody, type SearchFilters } from "./team-search.js";
import {
  attachmentView,
  channelHeader,
  clockTime,
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
  return { value, failure, reload: () => setGeneration((next) => next + 1) };
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
      const [files, pins] = await Promise.all([
        team.rpc["team.files.page"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.pins.page"]({ channelId: channelKey }).then(unwrapRpcResult),
      ]);
      return { files: files.files.length, pinned: pins.messages.length };
    },
    channelId,
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
          onKnowledge: () => navigation.navigate("TeamKnowledge", { teamId, channelId }),
          onInstructions: () => navigation.navigate("TeamInstructions", { teamId, channelId }),
          onNotify: () =>
            Alert.alert("Notify me", undefined, [
              { text: "Everything", onPress: () => setNotify("all") },
              { text: "Mentions", onPress: () => setNotify("mentions") },
              { text: "Nothing", onPress: () => setNotify("muted") },
            ]),
          onEditAbout: () =>
            Alert.prompt?.(
              "Rename channel",
              undefined,
              (name) =>
                name.trim() !== "" &&
                run({
                  type: "team.channel.update",
                  channelId: channelKey,
                  name: name.trim(),
                  peopleOnly: value.peopleOnly,
                }),
              "plain-text",
              value.name,
            ),
          onSetPeopleOnly: (on) =>
            run({
              type: "team.channel.update",
              channelId: channelKey,
              name: value.name,
              peopleOnly: on,
            }),
          onAddPeople: () => navigation.navigate("TeamMembers", { teamId, channelId }),
          onLeave: () =>
            Alert.alert(`Leave #${value.name}?`, "You can join again if it's public.", [
              { style: "cancel", text: "Cancel" },
              {
                style: "destructive",
                text: "Leave",
                onPress: () =>
                  run({ type: "team.channel.leave", channelId: channelKey }, () =>
                    navigation.popToTop(),
                  ),
              },
            ]),
          onArchive: () =>
            run({ type: "team.channel.archive", channelId: channelKey }, () =>
              navigation.popToTop(),
            ),
        }}
        canManage={value.can.manage}
        channel={channelHeader({ channel: value, memberCount: 0, people: [] })}
        counts={counts.value ?? { files: 0, pinned: 0 }}
        notify={notify}
        paddingBottom={padding}
        workingAgents={working}
      />
    </Screen>
  );
}

/** The people and groups on a channel's list. Managers add and remove them. */
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
      const [list, groups] = await Promise.all([
        team.rpc["team.channel.access.get"]({ channelId: channelKey }).then(unwrapRpcResult),
        team.rpc["team.groups.list"]({}).then(unwrapRpcResult),
      ]);
      return { list, groups: groups.groups };
    },
    channelId,
  );
  if (session === null || access.value === null)
    return (
      <Screen>
        <Loading failure={access.failure} />
      </Screen>
    );
  const { list, groups } = access.value;
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
          role: entry.manage ? "manager" : "member",
          canRemove: list.can.manage,
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
        canRemove: list.can.manage,
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
  return (
    <Screen edgeToEdge>
      <MembersBody
        canManage={list.can.manage}
        candidates={candidates}
        members={rows}
        onAdd={() => setAdding((now) => !now)}
        onAddMember={(userId) =>
          replace([
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
  const { directory } = useTeamMembers(teamId);
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
      sharedBy: "",
      when: "",
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
  void directory;
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
        pins={[...read.value].reverse().map((message) => ({
          message: pinnedView(message, viewerId, directory),
          pinnedBy: "Pinned",
        }))}
      />
    </Screen>
  );
}

function pinnedView(message: TeamMessage, viewerId: string, directory: MemberDirectory) {
  return messageView(message, {
    viewerId,
    members: directory,
    previews: new Map(),
    previous: null,
    requests: [],
    inThread: true,
  });
}

/**
 * Knowledge: a channel's topics (its own and any attached), the team's when
 * no channel is named, or one topic's things and facts.
 */
export function TeamKnowledgeScreen(
  props: StaticScreenProps<{
    readonly teamId: string;
    readonly channelId?: string | undefined;
    readonly topicId?: string | undefined;
  }>,
): ReactNode {
  const { teamId, channelId, topicId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const topics = useTeamRead(
    session,
    async (team) =>
      unwrapRpcResult(
        await team.rpc["team.knowledge.topics.list"](
          channelId === undefined ? {} : { channelId: TeamChannelIdSchema.parse(channelId) },
        ),
      ).topics,
    channelId ?? "team",
  );
  if (session === null || topics.value === null)
    return (
      <Screen>
        <Loading failure={topics.failure} />
      </Screen>
    );
  const summaries = topics.value.map((topic) => topicSummary(topic, channelId ?? null));
  if (topicId === undefined)
    return (
      <Screen edgeToEdge>
        {summaries.length === 0 ? (
          <View style={styles.center}>
            <AppText role="secondary" tone="muted">
              Nothing is known here yet. Facts people and agents write appear here.
            </AppText>
          </View>
        ) : (
          <KnowledgeTopicsBody
            onOpen={(id) => navigation.push("TeamKnowledge", { teamId, channelId, topicId: id })}
            paddingBottom={padding}
            topics={summaries}
          />
        )}
      </Screen>
    );
  const topic = topics.value.find((row) => row.id === topicId);
  if (topic === undefined)
    return (
      <Screen>
        <Loading failure="This topic is no longer here." />
      </Screen>
    );
  return (
    <Screen edgeToEdge>
      <TopicFacts
        channelId={channelId ?? null}
        padding={padding}
        session={session}
        summary={topicSummary(topic, channelId ?? null)}
        teamId={teamId}
        topic={topic}
      />
    </Screen>
  );
}

function topicSummary(topic: TeamTopic, channelId: string | null): TopicSummaryView {
  return {
    id: topic.id,
    name: topic.name,
    kind:
      topic.originChannelId !== null && topic.originChannelId === channelId ? "channel" : "shared",
    access: topic.originChannelId === null ? "Its own list" : "Same as its channel",
    factCount: 0,
    peopleOnly: topic.peopleOnly,
  };
}

function TopicFacts(props: {
  readonly teamId: string;
  readonly channelId: string | null;
  readonly session: TeamSessionClient;
  readonly topic: TeamTopic;
  readonly summary: TopicSummaryView;
  readonly padding: number;
}): ReactNode {
  const navigation = useNavigation<Navigation>();
  const { directory } = useTeamMembers(props.teamId);
  const viewerId = props.session.getSnapshot().bootstrap?.member.userId ?? "";
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
  const topicKey = KnowledgeTopicIdSchema.parse(props.topic.id);
  const facts = useTeamRead(
    props.session,
    async (team) =>
      unwrapRpcResult(
        await team.rpc[
          history === null ? "team.knowledge.facts.page" : "team.knowledge.history.page"
        ]({
          topicId: topicKey,
        }),
      ).facts,
    `${props.topic.id}:${history ?? ""}`,
  );
  const writer = (fact: TeamFact): string => {
    const person = personView(fact.writerUserId, directory);
    if (fact.writerKind === "agent")
      return fact.writerUserId === viewerId ? "Your agent" : `${person.name}'s agent`;
    return fact.writerUserId === viewerId ? "You" : person.name;
  };
  const lower = query.trim().toLowerCase();
  const things = groupThings(facts.value ?? [], writer)
    .filter((thing) => history === null || thing.id === history)
    .filter((thing) => lower === "" || thing.name.toLowerCase().includes(lower));
  if (adding)
    return (
      <AddFact
        onCancel={() => setAdding(false)}
        onSave={async (fact) => {
          await command(props.session, {
            type: "team.knowledge.fact.append",
            operationId: globalThis.crypto.randomUUID(),
            facts: [{ topicId: topicKey, ...fact, replacesId: null }],
          });
          setAdding(false);
          facts.reload();
        }}
      />
    );
  return (
    <KnowledgeTopicBody
      canWrite={props.topic.can.write}
      onAddFact={() => setAdding(true)}
      onHistory={(thingId) => setHistory((held) => (held === thingId ? null : thingId))}
      onQuery={setQuery}
      onSource={(messageId) => {
        const fact = facts.value?.find((row) => row.source?.messageId === messageId);
        if (fact?.source)
          navigation.navigate("TeamChannel", {
            teamId: props.teamId,
            channelId: fact.source.channelId,
            messageId,
          });
      }}
      paddingBottom={props.padding}
      query={query}
      things={things}
      topic={{ ...props.summary, factCount: facts.value?.length ?? 0 }}
    />
  );
}

function groupThings(facts: readonly TeamFact[], writer: (fact: TeamFact) => string): ThingView[] {
  const things = new Map<string, ThingView>();
  for (const fact of facts) {
    const held = things.get(fact.thing) ?? {
      id: fact.thing,
      name: fact.thing,
      key: fact.thing,
      facts: [],
    };
    things.set(fact.thing, {
      ...held,
      facts: [
        ...held.facts,
        {
          id: fact.id,
          property: fact.property,
          value: typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value),
          writer: writer(fact),
          when: clockTime(fact.writtenAt),
          sourceMessageId: fact.source?.messageId ?? null,
        },
      ],
    });
  }
  return [...things.values()];
}

function AddFact(props: {
  readonly onSave: (fact: { thing: string; property: string; value: string }) => Promise<void>;
  readonly onCancel: () => void;
}): ReactNode {
  const [thing, setThing] = useState("");
  const [property, setProperty] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      <Field
        input={{ onChangeText: setThing, value: thing, placeholder: "Acme Corp" }}
        label="Thing"
      />
      <Field
        input={{ onChangeText: setProperty, value: property, placeholder: "renewal date" }}
        label="Property"
      />
      <Field input={{ onChangeText: setValue, value, placeholder: "March 3" }} label="Value" />
      {failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {failure}
        </AppText>
      )}
      <PrimaryButton
        busy={saving}
        disabled={thing.trim() === "" || property.trim() === "" || value.trim() === ""}
        label="Add fact"
        onPress={() => {
          setSaving(true);
          setFailure(null);
          void props
            .onSave({ thing: thing.trim(), property: property.trim(), value: value.trim() })
            .catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : "It wasn't saved."),
            )
            .finally(() => setSaving(false));
        }}
      />
      <SecondaryButton label="Cancel" onPress={props.onCancel} />
    </ScrollView>
  );
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
  useEffect(() => {
    if (session === null || query.trim() === "") return;
    const timer = setTimeout(() => {
      setSearching(true);
      void session
        .search({
          query: query.trim(),
          ...(channelId === null ? {} : { channelId: TeamChannelIdSchema.parse(channelId) }),
          ...(authorId === null ? {} : { authorUserId: UserIdSchema.parse(authorId) }),
          ...(hasFile ? { hasFile: true } : {}),
          ...(inThreads ? { threadsOnly: true } : {}),
        })
        .catch(() => undefined)
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [authorId, channelId, hasFile, inThreads, query, session]);
  const viewerId = snapshot.bootstrap?.member.userId ?? "";
  const channelName =
    snapshot.sidebar?.channels.find((row) => row.channel.id === channelId)?.channel.name ?? null;
  const filters: SearchFilters = {
    channel: channelName === null ? null : `#${channelName}`,
    author: authorId === null ? null : personView(authorId, directory).name,
    thread: inThreads,
    file: hasFile,
  };
  const results = (query.trim() === "" ? [] : (snapshot.search?.results ?? [])).map((row) => ({
    message: messageView(row.message, {
      viewerId,
      members: directory,
      previews: new Map(),
      previous: null,
      requests: [],
      inThread: true,
    }),
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
        onMore={() => void session?.loadMoreSearch().catch(() => undefined)}
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
        onOpenTask={() => undefined}
        onQuery={setQuery}
        paddingBottom={padding}
        query={query}
        searching={searching}
        tasks={[]}
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
                detail={clockTime(notice.createdAt)}
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
