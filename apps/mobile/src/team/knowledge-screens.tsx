import { enterSide } from "../navigation-ref.js";
import {
  useKnowledgeNote,
  useKnowledgeNotes,
  useKnowledgeTopics,
  useSettledText,
} from "@opensteer/client/react";
import {
  isNoteChangedConflict,
  noteByline,
  noteSourceWords,
  noteWriterName,
  topicAudienceLabel,
  type TeamSessionClient,
} from "@opensteer/client/team";
import {
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  type KnowledgeTopicId,
  type TeamChannelId,
} from "@opensteer/core";
import type { TeamNote, TeamNotePreview, TeamNoteWriter, TeamTopic } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Markdown } from "../markdown/markdown.js";
import type { RootParamList } from "../navigation.js";
import { color, controlFontScaleLimit, radius, space } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText, Notice, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { failureWords, noteCountWords, noteWhen } from "./knowledge-model.js";
import {
  Empty,
  Loading,
  teamCommand,
  TextButton,
  useBottomPadding,
  useReloadOnReturn,
  viewerOf,
} from "./knowledge-parts.js";
import { useTeamSession } from "./team-context.js";
import { Avatar } from "./team-marks.js";

type Navigation = NativeStackNavigationProp<RootParamList>;

function topicSymbol(topic: TeamTopic): SFSymbolName {
  if (topic.archivedAt !== null) return "archivebox";
  if (!topic.can.read) return "lock";
  return topic.audience.everyone ? "globe" : "person.2";
}

function failure(error: unknown): string {
  return isNoteChangedConflict(error)
    ? "Someone changed this note. You're seeing the newest version now."
    : failureWords(error, "The team didn't answer.");
}

/**
 * Knowledge as records: search, the topics as chips, and the notes in the
 * chosen one (or all of them) as rows. Agents write notes; people read them,
 * decide who may, and delete or restore.
 */
export function TeamKnowledgeScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly topicId?: string | undefined }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const asked = props.route.params.topicId;
  const [chosen, setChosen] = useState<KnowledgeTopicId | null>(null);
  // A topic named on the way in (a new one, just made) is chosen; tapping chips chooses after.
  useEffect(() => {
    const parsed = KnowledgeTopicIdSchema.safeParse(asked);
    if (parsed.success) setChosen(parsed.data);
  }, [asked]);
  const [text, setText] = useState("");
  const query = useSettledText(text);
  const topics = useKnowledgeTopics(session);
  const notes = useKnowledgeNotes(session, { topicId: chosen, query });
  useReloadOnReturn(() => {
    topics.reload();
    notes.reload();
  });
  const all = topics.topics ?? [];
  const topic = chosen === null ? null : (all.find((row) => row.id === chosen) ?? null);
  const viewer = viewerOf(session);
  const open = useCallback(
    (note: TeamNotePreview) =>
      navigation.push("TeamNote", { teamId, topicId: note.topicId, noteId: note.id }),
    [navigation, teamId],
  );
  const names = new Map(all.map((row) => [row.id as string, row.name]));
  const now = new Date();
  const renderItem = ({ item }: ListRenderItemInfo<TeamNotePreview>) => (
    <NoteRow
      note={item}
      now={now}
      onOpen={open}
      session={session}
      topicName={chosen === null ? (names.get(item.topicId) ?? null) : null}
      viewer={viewer}
    />
  );
  if (session === null || topics.topics === null)
    return (
      <Screen>
        <Loading failure={topics.error === null ? null : failure(topics.error)} />
      </Screen>
    );
  const readable = chosen === null || topic?.can.read === true;
  const count =
    chosen === null
      ? all.reduce((sum, row) => sum + (row.can.read ? row.noteCount : 0), 0)
      : (topic?.noteCount ?? 0);
  const rows = readable ? (notes.notes ?? []) : [];
  const head = (
    <View>
      <View style={styles.search}>
        <SearchField onChange={setText} placeholder="Search notes" value={text} />
      </View>
      <ScrollView
        contentContainerStyle={styles.chips}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        <Chip label="All" count={count} on={chosen === null} onPress={() => setChosen(null)} />
        {all.map((row) => (
          <Chip
            count={row.can.read ? row.noteCount : null}
            dim={row.archivedAt !== null}
            key={row.id}
            label={row.name}
            on={row.id === chosen}
            onPress={() => setChosen(row.id)}
            symbol={row.archivedAt !== null ? "archivebox" : null}
          />
        ))}
        <Chip
          label="New topic"
          on={false}
          onPress={() => navigation.push("TeamTopicForm", { teamId })}
          symbol="plus"
        />
      </ScrollView>
      <TopicBar
        count={count}
        query={query}
        onAccess={() => topic && navigation.push("TeamTopicAccess", { teamId, topicId: topic.id })}
        onChanged={() => topics.reload()}
        onEdit={() => topic && navigation.push("TeamTopicForm", { teamId, topicId: topic.id })}
        session={session}
        topic={topic}
      />
    </View>
  );
  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={{ paddingBottom: padding }}
        data={rows}
        keyExtractor={(note) => note.id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          !readable ? (
            <Empty text="You manage this topic but can't read its notes." />
          ) : notes.notes === null ? (
            notes.error === null ? (
              <View style={styles.loading}>
                <ActivityIndicator accessibilityLabel="Loading notes" color={color.muted} />
              </View>
            ) : (
              <Notice detail={failure(notes.error)} title="Notes didn't load" tone="neutral" />
            )
          ) : notes.stale ? undefined : (
            <Empty
              text={
                query
                  ? `No notes match “${query}”.`
                  : chosen
                    ? "No notes yet. Agents save what the team should know here."
                    : "No notes yet. Ask your agent to save what the team should know."
              }
            />
          )
        }
        ListFooterComponent={
          notes.loadingMore ? (
            <View style={styles.loading}>
              <ActivityIndicator color={color.muted} />
            </View>
          ) : undefined
        }
        ListHeaderComponent={head}
        onEndReached={() => notes.hasMore && notes.more()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              topics.reload();
              notes.reload();
            }}
            // The rows stay on screen while they read again, so no spinner holds the list down.
            refreshing={false}
            tintColor={color.muted}
          />
        }
        renderItem={renderItem}
        style={notes.stale ? styles.stale : undefined}
      />
    </Screen>
  );
}

function Chip(props: {
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
  readonly count?: number | null;
  readonly symbol?: SFSymbolName | null;
  readonly dim?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.count == null ? props.label : `${props.label}, ${props.count}`}
      accessibilityRole="button"
      accessibilityState={{ selected: props.on }}
      onPress={() => {
        void Haptics.selectionAsync();
        props.onPress();
      }}
      style={({ pressed }) => [styles.chip, props.on && styles.chipOn, pressed && styles.pressed]}
    >
      {props.symbol ? (
        <Symbol name={props.symbol} size={12} tint={color.muted} weight="semibold" />
      ) : null}
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondaryMedium"
        tone={props.on ? "default" : props.dim ? "muted" : "soft"}
      >
        {props.label}
      </AppText>
      {props.count == null ? null : (
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          {String(props.count)}
        </AppText>
      )}
    </Pressable>
  );
}

function TopicBar(props: {
  readonly topic: TeamTopic | null;
  readonly count: number;
  readonly query: string;
  readonly session: TeamSessionClient;
  readonly onAccess: () => void;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}): ReactNode {
  const { topic } = props;
  const setArchived = (archive: boolean): void => {
    if (!topic) return;
    void teamCommand(props.session, {
      type: archive ? "team.knowledge.topic.archive" : "team.knowledge.topic.restore",
      topicId: topic.id,
    }).then(props.onChanged, (error: unknown) => Alert.alert("That didn't work", failure(error)));
  };
  const facts = props.query
    ? "Best match first"
    : `${topic ? `${topicAudienceLabel(topic.audience)} · ` : ""}${noteCountWords(props.count)}`;
  return (
    <View style={styles.bar}>
      <View style={styles.barTop}>
        <View style={styles.facts}>
          {topic ? <Symbol name={topicSymbol(topic)} size={12} tint={color.muted} /> : null}
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            tone="muted"
          >
            {facts}
          </AppText>
        </View>
        {topic ? <TextButton label="Access" onPress={props.onAccess} /> : null}
        {topic?.can.manage ? (
          <NativeMenu
            accessibilityLabel="More for this topic"
            options={[
              {
                icon: "pencil",
                id: "edit",
                label: "Edit name and description",
                onPress: props.onEdit,
              },
              topic.archivedAt
                ? { id: "restore", label: "Restore", onPress: () => setArchived(false) }
                : {
                    id: "archive",
                    label: "Archive",
                    onPress: () =>
                      Alert.alert(
                        `Archive ${topic.name}?`,
                        "Agents can still read its notes but save nothing new there.",
                        [
                          { style: "cancel", text: "Cancel" },
                          { text: "Archive", onPress: () => setArchived(true) },
                        ],
                      ),
                  },
            ]}
            style={styles.more}
          >
            <Symbol name="ellipsis" size={16} tint={color.muted} weight="semibold" />
          </NativeMenu>
        ) : null}
      </View>
      {topic && topic.description.trim() !== "" ? (
        <AppText numberOfLines={2} role="secondary" tone="soft">
          {topic.description}
        </AppText>
      ) : null}
      {topic?.archivedAt ? (
        <AppText role="caption" tone="muted">
          Archived. Agents can read it but save nothing new here.
        </AppText>
      ) : null}
    </View>
  );
}

function writerFace(writer: TeamNoteWriter) {
  return {
    id: writer.userId,
    name: writer.name,
    handle: "",
    avatarUri: null,
    presence: null,
  } as const;
}

function sourceOf(session: TeamSessionClient | null, channelId: TeamChannelId): string {
  return noteSourceWords(
    session?.getSnapshot().sidebar?.channels.find((row) => row.channel.id === channelId)?.channel,
  );
}

/** One note as a row: its title, then who saved it, when, and where they were asked. */
function NoteRow(props: {
  readonly note: TeamNotePreview;
  readonly topicName: string | null;
  readonly viewer: string;
  readonly now: Date;
  readonly session: TeamSessionClient | null;
  readonly onOpen: (note: TeamNotePreview) => void;
}): ReactNode {
  const { note } = props;
  const meta = [
    noteWriterName(note.writer, props.viewer),
    noteWhen(note.writtenAt, props.now),
    props.topicName,
    note.source ? sourceOf(props.session, note.source.channelId) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Pressable
      accessibilityHint="Opens the note"
      accessibilityLabel={`${note.title}. ${meta}`}
      accessibilityRole="button"
      onPress={() => props.onOpen(note)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
        {note.title}
      </AppText>
      <View style={styles.meta}>
        <Avatar agent={note.writer.kind === "agent"} person={writerFace(note.writer)} size={18} />
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          style={styles.metaText}
          tone="muted"
        >
          {meta}
        </AppText>
      </View>
    </Pressable>
  );
}

/**
 * One note: its text, who last saved it and where an agent was asked to, and
 * its versions when asked for. Restoring writes an old version again as the
 * newest; deleting keeps every version and can be undone right here.
 */
export function TeamNoteScreen(
  props: StaticScreenProps<{
    readonly teamId: string;
    readonly topicId: string;
    readonly noteId: string;
  }>,
): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const noteId = KnowledgeNoteIdSchema.parse(props.route.params.noteId);
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const read = useKnowledgeNote(session, noteId, topicId);
  const [viewing, setViewing] = useState<number | null>(null);
  useReloadOnReturn(read.reload);
  const topicName = read.topic?.name ?? "";
  useLayoutEffect(() => navigation.setOptions({ title: topicName }), [navigation, topicName]);
  const { note, topic, history } = read;
  if (session === null || note === null)
    return (
      <Screen>
        <Loading failure={read.error === null ? null : failure(read.error)} />
      </Screen>
    );
  const canWrite = topic?.can.write === true;
  const viewer = viewerOf(session);
  const older =
    viewing === null ? null : (history?.versions.find((v) => v.version === viewing) ?? null);
  const shown: TeamNote = older ?? note;
  const done = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setViewing(null);
  };
  const restore = (from: TeamNote) =>
    void read
      .restore(from)
      .then(done, (error: unknown) => Alert.alert("It wasn't restored", failure(error)));
  const remove = () =>
    void read
      .remove()
      .then(done, (error: unknown) => Alert.alert("It wasn't deleted", failure(error)));
  const source = shown.source;
  return (
    <Screen edgeToEdge>
      <ScrollView contentContainerStyle={[styles.page, { paddingBottom: padding }]}>
        {older ? (
          <View style={styles.viewing}>
            <Symbol name="clock" size={14} tint={color.muted} />
            <AppText role="secondaryMedium" style={styles.grow}>
              {`Version ${older.version}`}
            </AppText>
            <TextButton label="Current" onPress={() => setViewing(null)} />
            {canWrite && !older.deleted ? (
              <TextButton label="Restore" onPress={() => restore(older)} />
            ) : null}
          </View>
        ) : null}
        <View style={styles.head}>
          <AppText role="displaySmall" selectable>
            {shown.title}
          </AppText>
          <View style={styles.meta}>
            <Avatar
              agent={shown.writer.kind === "agent"}
              person={writerFace(shown.writer)}
              size={18}
            />
            <AppText role="caption" style={styles.metaText} tone="muted">
              {`${noteByline(shown, viewer)} · ${noteWhen(shown.writtenAt, new Date())}`}
            </AppText>
          </View>
          {source === null ? null : (
            <TextButton
              accessibilityHint="Opens the message that asked for this"
              label={`From ${sourceOf(session, source.channelId)}`}
              onPress={() =>
                enterSide(
                  {
                    name: "TeamChannel",
                    params: {
                      teamId,
                      channelId: source.channelId,
                      messageId: source.messageId,
                    },
                  },
                  true,
                )
              }
            />
          )}
        </View>
        {note.deleted && !older ? (
          <View style={styles.deleted}>
            <Notice detail="Its history is kept." title="This note was deleted" tone="neutral" />
            {canWrite ? (
              <SecondaryButton
                busy={read.busy === "restore"}
                compact
                label="Restore"
                onPress={() => restore(note)}
              />
            ) : null}
          </View>
        ) : shown.deleted ? (
          <AppText role="secondary" tone="muted">
            This version deleted the note.
          </AppText>
        ) : shown.body.trim() === "" ? (
          <AppText role="secondary" tone="muted">
            No text, just a title.
          </AppText>
        ) : (
          <View style={styles.body}>
            <Markdown text={shown.body} />
          </View>
        )}
        <View style={styles.versions}>
          <View style={styles.versionsHead}>
            <SectionLabel>Versions</SectionLabel>
            {history === null ? (
              <TextButton label={`Show ${note.version}`} onPress={read.showHistory} />
            ) : null}
          </View>
          {history === null
            ? null
            : history.versions.map((version) => (
                <Pressable
                  accessibilityLabel={`Version ${version.version}${version.deleted ? ", deleted" : ""}. ${noteWriterName(version.writer, viewer)}, ${noteWhen(version.writtenAt, new Date())}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: version.version === (viewing ?? note.version) }}
                  key={version.version}
                  onPress={() =>
                    setViewing(version.version === note.version ? null : version.version)
                  }
                  style={({ pressed }) => [
                    styles.version,
                    version.version === (viewing ?? note.version) && styles.versionOn,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppText role="caption" style={styles.versionN} tone="muted">
                    {`v${version.version}`}
                  </AppText>
                  <Avatar
                    agent={version.writer.kind === "agent"}
                    person={writerFace(version.writer)}
                    size={18}
                  />
                  <AppText numberOfLines={1} role="secondary" style={styles.grow} tone="soft">
                    {noteWriterName(version.writer, viewer)}
                  </AppText>
                  <AppText role="caption" tone={version.deleted ? "danger" : "muted"}>
                    {version.version === note.version
                      ? "Current"
                      : version.deleted
                        ? "Deleted"
                        : noteWhen(version.writtenAt, new Date())}
                  </AppText>
                </Pressable>
              ))}
          {history === null ? null : history.loading ? (
            <ActivityIndicator color={color.muted} />
          ) : history.error !== null ? (
            <View style={styles.versionsFailed}>
              <AppText role="caption" style={styles.grow} tone="danger">
                {failure(history.error)}
              </AppText>
              <TextButton label="Try again" onPress={() => void read.moreHistory()} />
            </View>
          ) : history.hasMore ? (
            <TextButton label="Older versions" onPress={() => void read.moreHistory()} />
          ) : null}
        </View>
        {canWrite && !note.deleted ? (
          <View style={styles.foot}>
            <AppText role="caption" style={styles.grow} tone="muted">
              Agents keep notes current. Ask yours to change one.
            </AppText>
            <SecondaryButton
              busy={read.busy === "delete"}
              compact
              label="Delete"
              onPress={remove}
              tone="danger"
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    gap: space[4],
    paddingBottom: space[10],
    paddingHorizontal: space[16],
  },
  barTop: { alignItems: "center", flexDirection: "row", gap: space[12], minHeight: 32 },
  body: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space[14],
  },
  chip: {
    alignItems: "center",
    borderColor: color.line,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[6],
    height: 32,
    paddingHorizontal: space[12],
  },
  chipOn: { backgroundColor: color.surfaceRaised, borderColor: color.lineStrong },
  chips: { gap: space[6], paddingBottom: space[10], paddingHorizontal: space[16] },
  deleted: { gap: space[10] },
  facts: { alignItems: "center", flex: 1, flexDirection: "row", gap: space[6] },
  foot: {
    alignItems: "center",
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[12],
    paddingTop: space[14],
  },
  grow: { flex: 1 },
  head: { gap: space[8] },
  loading: { alignItems: "center", padding: space[24] },
  meta: { alignItems: "center", flexDirection: "row", gap: space[8] },
  metaText: { flex: 1 },
  more: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  page: { gap: space[16], padding: space[16] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    gap: space[4],
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  search: { paddingBottom: space[10], paddingHorizontal: space[16], paddingTop: space[8] },
  stale: { opacity: 0.6 },
  version: {
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    flexDirection: "row",
    gap: space[10],
    minHeight: 46,
    paddingHorizontal: space[4],
  },
  versionN: { width: 26 },
  versionOn: { backgroundColor: color.surfaceRaised },
  versions: { gap: 0 },
  versionsFailed: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingTop: space[10],
  },
  versionsHead: {
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: space[6],
  },
  viewing: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    padding: space[10],
  },
});
