import { unwrapRpcResult } from "@opensteer/client/host";
import {
  isNoteChangedConflict,
  noteByline,
  noteWriterName,
  topicAudienceLabel,
} from "@opensteer/client/team";
import type { TeamSessionClient } from "@opensteer/client/team";
import { KnowledgeNoteIdSchema, KnowledgeTopicIdSchema } from "@opensteer/core";
import { TeamNoteVersionSchema, type TeamNote, type TeamTopic } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Markdown } from "../markdown/markdown.js";
import type { RootParamList } from "../navigation.js";
import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import {
  AppText,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
} from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { failureWords, noteCountWords, noteWhen } from "./knowledge-model.js";
import {
  Empty,
  knowledgeStyles,
  Loading,
  NoteList,
  teamCommand,
  TextButton,
  useBottomPadding,
  useFocusedRead,
  useNotePages,
  viewerOf,
} from "./knowledge-parts.js";
import { LinkRow } from "./settings-rows.js";
import { useTeamSession } from "./team-context.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type TopicParams = StaticScreenProps<{ readonly teamId: string; readonly topicId: string }>;
type NoteParams = StaticScreenProps<{
  readonly teamId: string;
  readonly topicId: string;
  readonly noteId: string;
}>;

const emptyTopic = "No notes yet. Notes people and their agents save here will show up here.";

/** Every topic the reader can see, a page at a time from the team, sorted by name. */
async function allTopics(session: TeamSessionClient): Promise<readonly TeamTopic[]> {
  const topics: TeamTopic[] = [];
  for (let page = 0; page < 10; page++) {
    const last = topics.at(-1);
    const result = unwrapRpcResult(
      await session.rpc["team.knowledge.topics.list"](last === undefined ? {} : { after: last.id }),
    );
    topics.push(...result.topics);
    if (!result.hasMore || result.topics.length === 0) break;
  }
  return topics;
}

/**
 * Knowledge: the team's topics, and a search across the notes in every topic
 * the reader can read. Any member can start a topic.
 */
export function TeamKnowledgeScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const topics = useFocusedRead(session, allTopics, teamId);
  const searching = query.trim() !== "";
  const results = useNotePages(session, { query, enabled: searching });
  const names = useMemo(
    () => new Map((topics.value ?? []).map((topic) => [topic.id as string, topic.name])),
    [topics.value],
  );
  if (session === null || topics.value === null)
    return (
      <Screen>
        <Loading failure={topics.failure} />
      </Screen>
    );
  const open = topics.value.filter((topic) => topic.archivedAt === null);
  const archived = topics.value.filter((topic) => topic.archivedAt !== null);
  const row = (topic: TeamTopic) => (
    <TopicRow
      key={topic.id}
      onPress={() => navigation.push("TeamTopic", { teamId, topicId: topic.id })}
      topic={topic}
    />
  );
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <SearchField onChange={setQuery} placeholder="Search notes" value={query} />
        {searching ? (
          <NoteList
            emptyText=""
            failure={results.failure}
            more={results.more}
            notes={results.notes}
            onMore={results.loadMore}
            onOpen={(note) =>
              navigation.push("TeamNote", { teamId, topicId: note.topicId, noteId: note.id })
            }
            query={results.answered}
            topicName={(topicId) => names.get(topicId) ?? null}
            viewerId={viewerOf(session)}
          />
        ) : (
          <>
            <RowGroup>
              {[
                ...open.map(row),
                <LinkRow
                  action
                  icon="plus"
                  key="new"
                  label="New topic"
                  onPress={() => navigation.push("TeamTopicForm", { teamId })}
                  tone="ember"
                />,
              ]}
            </RowGroup>
            {archived.length === 0 ? null : (
              <View style={knowledgeStyles.group}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showArchived }}
                  onPress={() => setShowArchived((now) => !now)}
                  style={styles.fold}
                >
                  <SectionLabel>{`Archived (${archived.length})`}</SectionLabel>
                  <Symbol
                    name={showArchived ? "chevron.up" : "chevron.down"}
                    size={11}
                    tint={color.muted}
                    weight="semibold"
                  />
                </Pressable>
                {showArchived ? <RowGroup>{archived.map(row)}</RowGroup> : null}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function TopicRow(props: { readonly topic: TeamTopic; readonly onPress: () => void }): ReactNode {
  const { topic } = props;
  const facts = `${topicAudienceLabel(topic.audience)} · ${noteCountWords(topic.noteCount)}`;
  const description = topic.description.trim();
  return (
    <Pressable
      accessibilityLabel={[topic.name, description, facts].filter((part) => part !== "").join(". ")}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.topic, pressed && knowledgeStyles.pressed]}
    >
      <Symbol name="folder" size={17} tint={color.muted} />
      <View style={knowledgeStyles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
          {topic.name}
        </AppText>
        {description === "" ? null : (
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondary"
            tone="soft"
          >
            {description}
          </AppText>
        )}
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          {facts}
        </AppText>
      </View>
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} weight="semibold" />
    </Pressable>
  );
}

/**
 * One topic: who can read it, its notes newest-changed first, and what the
 * team lets the reader do here. `can` decides every action shown.
 */
export function TeamTopicScreen(props: TopicParams): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const [query, setQuery] = useState("");
  const topic = useFocusedRead(
    session,
    async (team) => unwrapRpcResult(await team.rpc["team.knowledge.topic.get"]({ topicId })),
    topicId,
  );
  const readable = topic.value?.can.read === true;
  const notes = useNotePages(session, { topicId, query, enabled: readable });
  const name = topic.value?.name ?? "";
  useLayoutEffect(() => navigation.setOptions({ title: name }), [name, navigation]);
  if (session === null || topic.value === null)
    return (
      <Screen>
        <Loading failure={topic.failure} />
      </Screen>
    );
  const value = topic.value;
  const archived = value.archivedAt !== null;
  const setArchived = (archive: boolean): void => {
    void teamCommand(session, {
      type: archive ? "team.knowledge.topic.archive" : "team.knowledge.topic.restore",
      topicId,
    }).then(topic.reload, (error: unknown) =>
      Alert.alert("That didn't work", failureWords(error, "The team didn't answer.")),
    );
  };
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          {value.description.trim() === "" ? null : (
            <AppText role="secondary" tone="soft">
              {value.description}
            </AppText>
          )}
          <View style={styles.audience}>
            <Symbol
              name={value.audience.everyone ? "person.3" : "lock"}
              size={12}
              tint={color.muted}
            />
            <AppText role="caption" tone="muted">
              {`${topicAudienceLabel(value.audience)} · ${noteCountWords(value.noteCount)}`}
            </AppText>
          </View>
        </View>
        {archived ? (
          <View style={styles.banner}>
            <Symbol name="archivebox" size={15} tint={color.amber} />
            <AppText role="secondary" style={styles.bannerText} tone="soft">
              Archived — nothing new can be saved here.
            </AppText>
          </View>
        ) : null}
        <View style={knowledgeStyles.actions}>
          {value.can.write ? (
            <PrimaryButton
              compact
              label="New note"
              onPress={() => navigation.push("TeamNoteEdit", { teamId, topicId })}
            />
          ) : null}
          <SecondaryButton
            compact
            label="Access"
            onPress={() => navigation.push("TeamTopicAccess", { teamId, topicId })}
          />
          {value.can.manage ? (
            <NativeMenu
              accessibilityLabel="More for this topic"
              options={[
                {
                  icon: "pencil",
                  id: "edit",
                  label: "Edit name and description",
                  onPress: () => navigation.push("TeamTopicForm", { teamId, topicId }),
                },
                archived
                  ? { id: "restore", label: "Restore", onPress: () => setArchived(false) }
                  : {
                      id: "archive",
                      label: "Archive",
                      onPress: () =>
                        Alert.alert(
                          `Archive ${value.name}?`,
                          "Its notes stay readable, but nothing new can be saved in it.",
                          [
                            { style: "cancel", text: "Cancel" },
                            { text: "Archive", onPress: () => setArchived(true) },
                          ],
                        ),
                    },
              ]}
              style={styles.more}
            >
              <Symbol name="ellipsis" size={17} tint={color.ember} weight="semibold" />
            </NativeMenu>
          ) : null}
        </View>
        {readable ? (
          <>
            <SearchField onChange={setQuery} placeholder="Search in this topic" value={query} />
            <NoteList
              emptyText={emptyTopic}
              failure={notes.failure}
              more={notes.more}
              notes={notes.notes}
              onMore={notes.loadMore}
              onOpen={(note) => navigation.push("TeamNote", { teamId, topicId, noteId: note.id })}
              query={notes.answered}
              viewerId={viewerOf(session)}
            />
          </>
        ) : (
          <Empty text="You manage this topic but can't read its notes." />
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * One note: its text as written, who last saved it and where an agent was
 * asked to. The body is read here and nowhere earlier.
 */
export function TeamNoteScreen(props: NoteParams): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const noteId = KnowledgeNoteIdSchema.parse(props.route.params.noteId);
  const navigation = useNavigation<Navigation>();
  const { session, snapshot } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const read = useFocusedRead(
    session,
    async (team) => {
      const [note, topic] = await Promise.all([
        team.rpc["team.knowledge.note.get"]({ noteId }).then(unwrapRpcResult),
        team.rpc["team.knowledge.topic.get"]({ topicId }).then(unwrapRpcResult),
      ]);
      return { note, topic };
    },
    noteId,
  );
  const topicName = read.value?.topic.name ?? "";
  useLayoutEffect(() => navigation.setOptions({ title: topicName }), [navigation, topicName]);
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const { note, topic } = read.value;
  const source = note.source;
  const channelName =
    source === null
      ? null
      : (snapshot.sidebar?.channels.find((row) => row.channel.id === source.channelId)?.channel
          .name ?? null);
  const remove = (): void =>
    Alert.alert("Delete this note?", "Its history is kept.", [
      { style: "cancel", text: "Cancel" },
      {
        style: "destructive",
        text: "Delete",
        onPress: () =>
          void teamCommand(session, {
            type: "team.knowledge.note.delete",
            noteId,
            expectedVersion: TeamNoteVersionSchema.parse(note.version),
          }).then(
            () => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              navigation.goBack();
            },
            (error: unknown) => {
              Alert.alert("It wasn't deleted", failureWords(error, "The team didn't answer."));
              if (isNoteChangedConflict(error)) read.reload();
            },
          ),
      },
    ]);
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}>
        <View style={styles.head}>
          <AppText role="displaySmall" selectable>
            {note.title}
          </AppText>
          <AppText role="caption" tone="muted">
            {`${noteByline(note, viewerOf(session))} · ${noteWhen(note.writtenAt, new Date())}`}
          </AppText>
          {source === null ? null : (
            <TextButton
              accessibilityHint="Opens the message that asked for this"
              label={
                channelName === null ? "From a team message" : `From a message in #${channelName}`
              }
              onPress={() =>
                navigation.navigate("TeamChannel", {
                  teamId,
                  channelId: source.channelId,
                  messageId: source.messageId,
                })
              }
            />
          )}
        </View>
        {note.deleted ? (
          <Notice
            detail="Its history is kept. Restore a version from History."
            title="This note was deleted"
            tone="neutral"
          />
        ) : null}
        <View style={knowledgeStyles.actions}>
          {topic.can.write && !note.deleted ? (
            <SecondaryButton
              compact
              label="Edit"
              onPress={() => navigation.push("TeamNoteEdit", { teamId, topicId, noteId })}
            />
          ) : null}
          <SecondaryButton
            compact
            label="History"
            onPress={() => navigation.push("TeamNoteHistory", { teamId, topicId, noteId })}
          />
          {topic.can.write && !note.deleted ? (
            <SecondaryButton compact label="Delete" onPress={remove} tone="danger" />
          ) : null}
        </View>
        {note.deleted || note.body.trim() === "" ? null : <Markdown text={note.body} />}
      </ScrollView>
    </Screen>
  );
}

/**
 * Every version of a note, newest first. Opening one shows its text;
 * restoring writes it again as the newest version, so nothing is lost.
 */
export function TeamNoteHistoryScreen(props: NoteParams): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const noteId = KnowledgeNoteIdSchema.parse(props.route.params.noteId);
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const [open, setOpen] = useState<number | null>(null);
  const [older, setOlder] = useState<{ versions: readonly TeamNote[]; hasMore: boolean } | null>(
    null,
  );
  const [restoring, setRestoring] = useState<number | null>(null);
  const read = useFocusedRead(
    session,
    async (team) => {
      setOlder(null);
      const [history, topic] = await Promise.all([
        team.rpc["team.knowledge.note.history"]({ noteId }).then(unwrapRpcResult),
        team.rpc["team.knowledge.topic.get"]({ topicId }).then(unwrapRpcResult),
      ]);
      return { history, topic };
    },
    noteId,
  );
  if (session === null || read.value === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const { history, topic } = read.value;
  const versions = [...history.versions, ...(older?.versions ?? [])];
  const hasMore = older?.hasMore ?? history.hasMore;
  const newest = history.versions[0];
  const viewerId = viewerOf(session);
  const now = new Date();
  const loadOlder = (): void => {
    const last = versions.at(-1);
    if (last === undefined) return;
    void session.rpc["team.knowledge.note.history"]({
      noteId,
      before: TeamNoteVersionSchema.parse(last.version),
    })
      .then(unwrapRpcResult)
      .then(
        (page) =>
          setOlder((held) => ({
            versions: [...(held?.versions ?? []), ...page.versions],
            hasMore: page.hasMore,
          })),
        () => undefined,
      );
  };
  const restore = (version: TeamNote): void => {
    if (newest === undefined) return;
    setRestoring(version.version);
    void teamCommand(session, {
      type: "team.knowledge.note.write",
      noteId,
      topicId,
      expectedVersion: TeamNoteVersionSchema.parse(newest.version),
      title: version.title,
      body: version.body,
    })
      .then(
        () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          navigation.goBack();
        },
        (error: unknown) => {
          Alert.alert("It wasn't restored", failureWords(error, "The team didn't answer."));
          if (isNoteChangedConflict(error)) read.reload();
        },
      )
      .finally(() => setRestoring(null));
  };
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}>
        {versions.map((version) => {
          const expanded = open === version.version;
          const current = version.version === newest?.version;
          return (
            <View key={version.version} style={styles.version}>
              <Pressable
                accessibilityHint={expanded ? "Hides its text" : "Shows its text"}
                accessibilityLabel={`Version ${version.version}${version.deleted ? ", deleted" : ""}. ${version.title}. ${noteWriterName(version.writer, viewerId)}, ${noteWhen(version.writtenAt, now)}`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setOpen(expanded ? null : version.version)}
                style={({ pressed }) => [styles.versionHead, pressed && knowledgeStyles.pressed]}
              >
                <View style={knowledgeStyles.words}>
                  <View style={styles.versionLine}>
                    <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
                      {current
                        ? `Version ${version.version} · Current`
                        : `Version ${version.version}`}
                    </AppText>
                    {version.deleted ? (
                      <AppText role="caption" tone="danger">
                        Deleted
                      </AppText>
                    ) : null}
                  </View>
                  <AppText {...(expanded ? {} : { numberOfLines: 1 })} role="body">
                    {version.title}
                  </AppText>
                  <AppText role="caption" tone="muted">
                    {`${noteWriterName(version.writer, viewerId)} · ${noteWhen(version.writtenAt, now)}`}
                  </AppText>
                </View>
                <Symbol
                  name={expanded ? "chevron.up" : "chevron.down"}
                  size={12}
                  tint={color.mutedDim}
                  weight="semibold"
                />
              </Pressable>
              {expanded ? (
                <View style={styles.versionBody}>
                  {version.deleted ? (
                    <AppText role="secondary" tone="muted">
                      The note was deleted at this version.
                    </AppText>
                  ) : version.body.trim() === "" ? (
                    <AppText role="secondary" tone="muted">
                      No text.
                    </AppText>
                  ) : (
                    <Markdown text={version.body} />
                  )}
                  {topic.can.write && !current && !version.deleted ? (
                    <PrimaryButton
                      busy={restoring === version.version}
                      compact
                      label="Restore this version"
                      onPress={() => restore(version)}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
        {hasMore ? (
          <View style={styles.center}>
            <TextButton label="Show older versions" onPress={loadOlder} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    padding: space[12],
  },
  bannerText: { flex: 1 },
  audience: { alignItems: "center", flexDirection: "row", gap: space[6] },
  center: { alignItems: "center", paddingVertical: space[8] },
  fold: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: 32,
    paddingHorizontal: space[4],
  },
  head: { gap: space[6] },
  topic: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 56,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  more: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  version: { ...material.plate, borderRadius: radius.lg, overflow: "hidden" },
  versionBody: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[12],
    padding: space[14],
  },
  versionHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    padding: space[14],
  },
  versionLine: { alignItems: "center", flexDirection: "row", gap: space[8] },
});
