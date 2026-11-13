import { unwrapRpcResult } from "@opensteer/client/host";
import {
  isNoteChangedConflict,
  isTopicAccessConflict,
  noteDraftReady,
  noteWriteCommand,
  sameTopicAccess,
  topicEveryoneLevel,
  topicSubjectKey,
  withoutTopicSubject,
  withTopicEveryone,
  withTopicSubject,
  type TopicEveryoneLevel,
} from "@opensteer/client/team";
import {
  createId,
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  SequenceSchema,
  type TeamGroupId,
} from "@opensteer/core";
import {
  teamKnowledgeLimits,
  type TeamMember,
  type TeamNote,
  type TeamTopicAccessEntry,
  type TeamTopicLevel,
  type TeamTopicSubject,
} from "@opensteer/protocol";
import { usePreventRemove, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Markdown } from "../markdown/markdown.js";
import { headerActions } from "../navigation-header.js";
import type { RootParamList } from "../navigation.js";
import {
  color,
  controlFontScaleLimit,
  material,
  plateFill,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText, Field, Notice, PrimaryButton, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { failureWords, levelWords } from "./knowledge-model.js";
import {
  knowledgeStyles,
  Loading,
  teamCommand,
  TextButton,
  useBottomPadding,
  useFocusedRead,
} from "./knowledge-parts.js";
import { LinkRow } from "./settings-rows.js";
import { useTeamMembers, useTeamSession } from "./team-context.js";
import { Avatar } from "./team-marks.js";
import { personView, type MemberDirectory } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type PersonOrGroup = Exclude<TeamTopicSubject, { readonly kind: "everyone" }>;
type AccessList = readonly TeamTopicAccessEntry[];
interface AccessDraft {
  readonly entries: AccessList;
  readonly base: AccessList;
  readonly revision: string;
}

/** The people and groups on a list, without its Everyone entry. */
function listedPeople(
  entries: AccessList,
): { readonly subject: PersonOrGroup; readonly level: TeamTopicLevel }[] {
  return entries.flatMap((entry) =>
    entry.subject.kind === "everyone" ? [] : [{ subject: entry.subject, level: entry.level }],
  );
}

/** Asks before a back swipe or Back throws away words the person typed. */
function useKeepDraft(dirty: boolean): void {
  const navigation = useNavigation<Navigation>();
  usePreventRemove(dirty, ({ data }) =>
    Alert.alert("Discard your changes?", undefined, [
      { style: "cancel", text: "Keep editing" },
      {
        style: "destructive",
        text: "Discard",
        onPress: () => navigation.dispatch(data.action),
      },
    ]),
  );
}

/**
 * Writing a note: a title and Markdown text. Saving names the version it
 * started from; when someone saved in between, the draft stays here and the
 * person can read their version before saving on top of it.
 */
export function TeamNoteEditScreen(
  props: StaticScreenProps<{
    readonly teamId: string;
    readonly topicId: string;
    readonly noteId?: string | undefined;
  }>,
): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const editing = props.route.params.noteId;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const padding = useBottomPadding();
  // A new note's id is made once, so a retried save is still the same note.
  const [noteId] = useState(() =>
    editing === undefined ? createId("knowledgeNote") : KnowledgeNoteIdSchema.parse(editing),
  );
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(
    editing === undefined ? { title: "", body: "" } : null,
  );
  const [base, setBase] = useState<TeamNote | null>(null);
  const [theirs, setTheirs] = useState<{ note: TeamNote; shown: boolean } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);
  const read = useFocusedRead(
    session,
    async (team) => {
      if (editing === undefined || loaded.current) return null;
      const note = unwrapRpcResult(await team.rpc["team.knowledge.note.get"]({ noteId }));
      loaded.current = true;
      setBase(note);
      setDraft({ title: note.title, body: note.body });
      return note;
    },
    noteId,
  );
  const savable = draft !== null && noteDraftReady(base, draft);
  const dirty =
    draft !== null &&
    !saving &&
    (base === null
      ? draft.title.trim() !== "" || draft.body.trim() !== ""
      : draft.title.trim() !== base.title || draft.body !== base.body);
  useKeepDraft(dirty);

  const save = (): void => {
    if (session === null || draft === null || !savable) return;
    setSaving(true);
    setFailure(null);
    void teamCommand(session, noteWriteCommand({ noteId, topicId, base, draft }))
      .then(
        () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (editing === undefined) navigation.replace("TeamNote", { teamId, topicId, noteId });
          else navigation.goBack();
        },
        async (error: unknown) => {
          if (!isNoteChangedConflict(error)) {
            setFailure(failureWords(error, "It wasn't saved."));
            return;
          }
          setConflict(failureWords(error, "Someone changed this note while you were editing it."));
          // Their version becomes what the next save goes on top of.
          const current = await session.rpc["team.knowledge.note.get"]({ noteId })
            .then(unwrapRpcResult)
            .catch(() => null);
          if (current !== null) {
            setBase(current);
            setTheirs({ note: current, shown: false });
          }
        },
      )
      .finally(() => setSaving(false));
  };

  const saver = useRef(save);
  saver.current = save;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: editing === undefined ? "New note" : "Edit note",
      ...headerActions({
        left: { label: "Cancel", onPress: () => navigation.goBack() },
        right: {
          disabled: !savable || saving,
          label: "Save",
          onPress: () => saver.current(),
          variant: "done",
        },
      }),
    });
  }, [editing, navigation, savable, saving]);

  if (draft === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}
        keyboardShouldPersistTaps="handled"
      >
        {conflict === null ? null : (
          <View style={styles.conflict}>
            <AppText role="secondaryMedium">{conflict}</AppText>
            <AppText role="secondary" tone="soft">
              Your words are still here. Save again to put them on top of theirs.
            </AppText>
            {theirs === null ? null : (
              <TextButton
                label={theirs.shown ? "Hide their version" : "Show their version"}
                onPress={() => setTheirs({ ...theirs, shown: !theirs.shown })}
              />
            )}
            {theirs?.shown === true ? (
              <View style={styles.theirs}>
                <AppText role="title">{theirs.note.title}</AppText>
                {theirs.note.deleted ? (
                  <AppText role="secondary" tone="muted">
                    They deleted the note.
                  </AppText>
                ) : (
                  <Markdown text={theirs.note.body} />
                )}
              </View>
            ) : null}
          </View>
        )}
        <TextInput
          accessibilityLabel="Title"
          autoFocus={editing === undefined}
          cursorColor={color.ember}
          maxFontSizeMultiplier={controlFontScaleLimit}
          maxLength={teamKnowledgeLimits.titleChars}
          onChangeText={(title) => setDraft({ ...draft, title })}
          placeholder="Title"
          placeholderTextColor={color.muted}
          returnKeyType="next"
          selectionColor={color.ember}
          style={styles.title}
          value={draft.title}
        />
        <TextInput
          accessibilityHint="Markdown works here"
          accessibilityLabel="Note"
          cursorColor={color.ember}
          multiline
          onChangeText={(body) => setDraft({ ...draft, body })}
          placeholder="Write the note. Markdown works."
          placeholderTextColor={color.muted}
          scrollEnabled={false}
          selectionColor={color.ember}
          style={styles.body}
          textAlignVertical="top"
          value={draft.body}
        />
        {failure === null ? null : (
          <AppText role="secondary" tone="danger">
            {failure}
          </AppText>
        )}
      </ScrollView>
    </Screen>
  );
}

interface TeamGroup {
  readonly id: TeamGroupId;
  readonly name: string;
  readonly people: readonly unknown[];
}

interface Directory {
  readonly members: readonly TeamMember[];
  readonly people: MemberDirectory;
  readonly groups: readonly TeamGroup[];
}

function subjectName(subject: PersonOrGroup, directory: Directory): string {
  if (subject.kind === "person") return personView(subject.userId, directory.people).name;
  return directory.groups.find((group) => group.id === subject.groupId)?.name ?? "Group";
}

/** Someone on a topic's list: a face or a group mark, their name and their level. */
function SubjectRow(props: {
  readonly subject: PersonOrGroup;
  readonly directory: Directory;
  readonly level: TeamTopicLevel | null;
  /** The levels the person can choose between; absent when the list is read-only. */
  readonly levels?: readonly TeamTopicLevel[];
  readonly onLevel?: (level: TeamTopicLevel) => void;
  readonly onRemove?: () => void;
}): ReactNode {
  const { subject, directory } = props;
  const name = subjectName(subject, directory);
  const detail =
    subject.kind === "person"
      ? `@${personView(subject.userId, directory.people).handle}`
      : `${directory.groups.find((group) => group.id === subject.groupId)?.people.length ?? 0} people`;
  const level = props.level === null ? null : levelWords[props.level];
  return (
    <View style={styles.subject}>
      {subject.kind === "person" ? (
        <Avatar
          ground={plateFill}
          person={personView(subject.userId, directory.people)}
          size={28}
        />
      ) : (
        <View style={styles.groupMark}>
          <Symbol name="person.3" size={15} tint={color.textSoft} />
        </View>
      )}
      <View style={knowledgeStyles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
          {name}
        </AppText>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          {detail}
        </AppText>
      </View>
      {level === null ? null : props.levels === undefined || props.onLevel === undefined ? (
        <AppText role="secondary" tone="muted">
          {level}
        </AppText>
      ) : (
        <LevelMenu
          label={`${name} can`}
          levels={props.levels}
          onChange={props.onLevel}
          value={props.level!}
        />
      )}
      {props.onRemove === undefined ? null : (
        <Pressable
          accessibilityLabel={`Remove ${name}`}
          accessibilityRole="button"
          onPress={props.onRemove}
          style={styles.remove}
        >
          <Symbol name="xmark" size={13} tint={color.muted} weight="semibold" />
        </Pressable>
      )}
    </View>
  );
}

function LevelMenu<Level extends TeamTopicLevel | TopicEveryoneLevel>(props: {
  readonly label: string;
  readonly levels: readonly Level[];
  readonly value: Level;
  readonly onChange: (level: Level) => void;
}): ReactNode {
  return (
    <NativeMenu
      accessibilityHint="Changes what they can do"
      accessibilityLabel={`${props.label} ${levelWords[props.value]}`}
      options={props.levels.map((level) => ({
        id: level,
        label: levelWords[level],
        onPress: () => props.onChange(level),
        selected: level === props.value,
      }))}
      style={styles.level}
    >
      <View style={styles.levelInner}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium" tone="ember">
          {levelWords[props.value]}
        </AppText>
        <Symbol name="chevron.down" size={10} tint={color.ember} weight="semibold" />
      </View>
    </NativeMenu>
  );
}

/** The team's people and groups not on the list yet, narrowed by what is typed. */
function SubjectPicker(props: {
  readonly directory: Directory;
  readonly listed: ReadonlySet<string>;
  readonly onPick: (subject: PersonOrGroup) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const lower = query.trim().toLowerCase();
  const matches = (name: string) => lower === "" || name.toLowerCase().includes(lower);
  const groups = props.directory.groups
    .filter((group) => !props.listed.has(`group:${group.id}`) && matches(group.name))
    .map((group) => ({ kind: "group" as const, groupId: group.id }));
  const people = props.directory.members
    .filter(
      (member) =>
        member.state === "active" &&
        !props.listed.has(`person:${member.userId}`) &&
        (matches(member.displayName) || matches(member.handle)),
    )
    .map((member) => ({ kind: "person" as const, userId: member.userId }));
  const candidates: PersonOrGroup[] = [...groups, ...people].slice(0, 50);
  return (
    <View style={knowledgeStyles.group}>
      <SearchField
        autoFocus
        onChange={setQuery}
        placeholder="Find people and groups"
        value={query}
      />
      {candidates.length === 0 ? (
        <AppText role="secondary" tone="muted">
          {lower === "" ? "Everyone is already on the list." : "Nobody matches."}
        </AppText>
      ) : (
        <RowGroup>
          {candidates.map((subject) => (
            <Pressable
              accessibilityHint="Adds them to the list"
              accessibilityLabel={subjectName(subject, props.directory)}
              accessibilityRole="button"
              key={topicSubjectKey(subject)}
              onPress={() => {
                void Haptics.selectionAsync();
                props.onPick(subject);
              }}
              style={({ pressed }) => pressed && knowledgeStyles.pressed}
            >
              <SubjectRow directory={props.directory} level={null} subject={subject} />
            </Pressable>
          ))}
        </RowGroup>
      )}
    </View>
  );
}

/** The team's people and groups to add, read only once a list can be edited. */
function useDirectory(teamId: string, wanted: boolean): Directory | null {
  const { session } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const groups = useFocusedRead(
    wanted ? session : null,
    async (team) => unwrapRpcResult(await team.rpc["team.groups.list"]({})).groups,
    teamId,
  );
  // Without the groups a list still shows; a group is then named only "Group".
  if (groups.value === null && groups.failure === null) return null;
  return { members, people: directory, groups: groups.value ?? [] };
}

const personLevels: readonly TeamTopicLevel[] = ["read", "write", "manage"];
const everyoneLevels: readonly TopicEveryoneLevel[] = ["none", "read", "write"];

/**
 * Who can read a topic, write in it and manage it. Managers change the list
 * and save it whole; everyone else sees it as it is.
 */
export function TeamTopicAccessScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly topicId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const topicId = KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const navigation = useNavigation<Navigation>();
  const { session, team } = useTeamSession(teamId);
  const padding = useBottomPadding();
  /** Edits on top of the list as it was read, kept with that list's revision until saved or reloaded. */
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ text: string; stale: boolean } | null>(null);
  const read = useFocusedRead(
    session,
    async (session) =>
      unwrapRpcResult(await session.rpc["team.knowledge.topic.access.get"]({ topicId })),
    topicId,
  );
  const held = read.value?.entries ?? null;
  const shown = draft?.entries ?? held;
  const manage = read.value?.can.manage === true;
  const directory = useDirectory(teamId, true);
  const dirty = draft !== null && !sameTopicAccess(draft.base, draft.entries);
  useKeepDraft(dirty && !saving);

  const save = (): void => {
    if (session === null || read.value === null || draft === null || !dirty) return;
    setSaving(true);
    setFailure(null);
    void teamCommand(session, {
      type: "team.knowledge.topic.access.set",
      topicId,
      expectedRevision: SequenceSchema.parse(draft.revision),
      access: [...draft.entries],
    })
      .then(
        () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          navigation.goBack();
        },
        (error: unknown) =>
          setFailure(
            isTopicAccessConflict(error)
              ? { text: "This list changed; reload it.", stale: true }
              : { text: failureWords(error, "The list wasn't saved."), stale: false },
          ),
      )
      .finally(() => setSaving(false));
  };

  const saver = useRef(save);
  saver.current = save;
  useLayoutEffect(() => {
    if (!manage) return;
    navigation.setOptions(
      headerActions({
        right: {
          disabled: !dirty || saving,
          label: "Save",
          onPress: () => saver.current(),
          variant: "done",
        },
      }),
    );
  }, [dirty, manage, navigation, saving]);

  if (session === null || read.value === null || shown === null || directory === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const edit = (next: AccessList): void => {
    setFailure(null);
    setDraft((current) =>
      current
        ? { ...current, entries: next }
        : { entries: next, base: read.value!.entries, revision: read.value!.revision },
    );
  };
  const teamName = team?.name ?? "the team";
  const people = listedPeople(shown);
  const everyone = topicEveryoneLevel(shown);
  const listed = new Set(people.map((entry) => topicSubjectKey(entry.subject)));
  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {manage && !read.value.can.read ? (
          <Notice
            detail="You can change who reads it, and add yourself to read it too."
            title="You manage this topic but can't read its notes."
            tone="neutral"
          />
        ) : null}
        {failure === null ? null : (
          <Notice
            detail={
              failure.stale ? "Someone saved a change to it after you opened it." : failure.text
            }
            title={failure.stale ? failure.text : "That didn't work"}
            {...(failure.stale
              ? {
                  action: {
                    label: "Reload",
                    onPress: () => {
                      setDraft(null);
                      setFailure(null);
                      read.reload();
                    },
                  },
                }
              : {})}
          />
        )}
        <RowGroup>
          {[
            <View key="everyone" style={styles.subject}>
              <View style={styles.groupMark}>
                <Symbol name="person.3" size={15} tint={color.textSoft} />
              </View>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="body"
                style={knowledgeStyles.words}
              >
                {`Everyone in ${teamName}`}
              </AppText>
              {manage ? (
                <LevelMenu
                  label={`Everyone in ${teamName} can`}
                  levels={everyoneLevels}
                  onChange={(level) => edit(withTopicEveryone(shown, level))}
                  value={everyone}
                />
              ) : (
                <AppText role="secondary" tone="muted">
                  {levelWords[everyone]}
                </AppText>
              )}
            </View>,
          ]}
        </RowGroup>
        <View style={knowledgeStyles.group}>
          <SectionLabel>People and groups</SectionLabel>
          {people.length === 0 && !manage ? (
            <AppText role="secondary" tone="muted">
              Nobody else is listed.
            </AppText>
          ) : (
            <RowGroup>
              {[
                ...people.map((entry) => {
                  const key = topicSubjectKey(entry.subject);
                  return (
                    <SubjectRow
                      directory={directory}
                      key={key}
                      level={entry.level}
                      subject={entry.subject}
                      {...(manage
                        ? {
                            levels: personLevels,
                            onLevel: (level: TeamTopicLevel) =>
                              edit(withTopicSubject(shown, entry.subject, level)),
                            onRemove: () => edit(withoutTopicSubject(shown, entry.subject)),
                          }
                        : {})}
                    />
                  );
                }),
                manage ? (
                  <LinkRow
                    action
                    icon="person.badge.plus"
                    key="add"
                    label={adding ? "Done adding" : "Add people or groups"}
                    onPress={() => setAdding((now) => !now)}
                    tone="ember"
                  />
                ) : null,
              ]}
            </RowGroup>
          )}
        </View>
        {manage && adding ? (
          <SubjectPicker
            directory={directory}
            listed={listed}
            onPick={(subject) => edit(withTopicSubject(shown, subject, "write"))}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * A new topic, or a manager's change to its name and description. Whoever
 * makes a topic manages it; the team adds them.
 */
export function TeamTopicFormScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly topicId?: string | undefined }>,
): ReactNode {
  const { teamId } = props.route.params;
  const existing =
    props.route.params.topicId === undefined
      ? null
      : KnowledgeTopicIdSchema.parse(props.route.params.topicId);
  const navigation = useNavigation<Navigation>();
  const { session, team } = useTeamSession(teamId);
  const padding = useBottomPadding();
  const [name, setName] = useState<string | null>(existing === null ? "" : null);
  const [description, setDescription] = useState("");
  const [everyone, setEveryone] = useState(true);
  const directory = useDirectory(teamId, existing === null && !everyone);
  const [chosen, setChosen] = useState<AccessList>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loaded = useRef(false);
  const read = useFocusedRead(
    session,
    async (session) => {
      if (existing === null || loaded.current) return null;
      const topic = unwrapRpcResult(
        await session.rpc["team.knowledge.topic.get"]({ topicId: existing }),
      );
      loaded.current = true;
      setName(topic.name);
      setDescription(topic.description);
      return topic;
    },
    existing ?? "new",
  );
  useLayoutEffect(
    () => navigation.setOptions({ title: existing === null ? "New topic" : "Edit topic" }),
    [existing, navigation],
  );
  if (session === null || name === null)
    return (
      <Screen>
        <Loading failure={read.failure} />
      </Screen>
    );
  const words = name.trim();
  const submit = (): void => {
    if (words === "") return;
    setBusy(true);
    setFailure(null);
    const id = existing ?? createId("knowledgeTopic");
    const sent =
      existing === null
        ? teamCommand(session, {
            type: "team.knowledge.topic.create",
            id,
            name: words,
            description: description.trim(),
            access: everyone ? [{ subject: { kind: "everyone" }, level: "write" }] : [...chosen],
          })
        : teamCommand(session, {
            type: "team.knowledge.topic.update",
            topicId: id,
            name: words,
            description: description.trim(),
          });
    void sent
      .then(
        () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (existing === null) navigation.replace("TeamTopic", { teamId, topicId: id });
          else navigation.goBack();
        },
        (error: unknown) => setFailure(failureWords(error, "The topic wasn't saved.")),
      )
      .finally(() => setBusy(false));
  };
  const teamName = team?.name ?? "the team";
  const chosenPeople = listedPeople(chosen);
  const listed = new Set(chosenPeople.map((entry) => topicSubjectKey(entry.subject)));
  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[knowledgeStyles.page, { paddingBottom: padding }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <Field
          input={{
            autoFocus: existing === null,
            maxLength: teamKnowledgeLimits.topicNameChars,
            onChangeText: setName,
            placeholder: "Customers",
            returnKeyType: "next",
            value: name,
          }}
          label="Name"
        />
        <Field
          input={{
            maxLength: teamKnowledgeLimits.descriptionChars,
            multiline: true,
            onChangeText: setDescription,
            placeholder: "What belongs here?",
            value: description,
          }}
          label="Description"
        />
        {existing === null ? (
          <View style={knowledgeStyles.group}>
            <SectionLabel>Who can read it</SectionLabel>
            <RowGroup>
              {[
                <Choice
                  detail="Everyone can read and add notes."
                  key="everyone"
                  label={`Everyone in ${teamName}`}
                  onPress={() => setEveryone(true)}
                  selected={everyone}
                />,
                <Choice
                  detail="Only the people and groups you add. You manage it."
                  key="chosen"
                  label="Only people I choose"
                  onPress={() => setEveryone(false)}
                  selected={!everyone}
                />,
              ]}
            </RowGroup>
          </View>
        ) : null}
        {existing === null && !everyone && directory !== null ? (
          <>
            {chosenPeople.length === 0 ? null : (
              <RowGroup>
                {chosenPeople.map((entry) => {
                  const key = topicSubjectKey(entry.subject);
                  return (
                    <SubjectRow
                      directory={directory}
                      key={key}
                      level={entry.level}
                      levels={personLevels}
                      onLevel={(level) => setChosen(withTopicSubject(chosen, entry.subject, level))}
                      onRemove={() => setChosen(withoutTopicSubject(chosen, entry.subject))}
                      subject={entry.subject}
                    />
                  );
                })}
              </RowGroup>
            )}
            <SubjectPicker
              directory={directory}
              listed={listed}
              onPick={(subject) => setChosen(withTopicSubject(chosen, subject, "write"))}
            />
          </>
        ) : null}
        {failure === null ? null : (
          <AppText role="secondary" tone="danger">
            {failure}
          </AppText>
        )}
        <PrimaryButton
          busy={busy}
          disabled={words === ""}
          label={existing === null ? "Create topic" : "Save"}
          onPress={submit}
          prominent
        />
      </ScrollView>
    </Screen>
  );
}

function Choice(props: {
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.detail}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.choice, pressed && knowledgeStyles.pressed]}
    >
      <View style={knowledgeStyles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="body">
          {props.label}
        </AppText>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          {props.detail}
        </AppText>
      </View>
      {props.selected ? (
        <Symbol name="checkmark" size={15} tint={color.ember} weight="semibold" />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    ...material.control,
    ...type.body,
    borderRadius: radius.md,
    color: color.text,
    minHeight: 260,
    padding: space[12],
  },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  conflict: {
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[6],
    padding: space[12],
  },
  groupMark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  level: { minHeight: touchTarget, justifyContent: "center" },
  levelInner: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[4],
    paddingHorizontal: space[4],
  },
  remove: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  subject: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingLeft: space[14],
    paddingRight: space[6],
    paddingVertical: space[6],
  },
  theirs: {
    ...material.plate,
    borderRadius: radius.md,
    gap: space[8],
    marginTop: space[4],
    padding: space[12],
  },
  title: { ...type.displaySmall, color: color.text, paddingVertical: space[4] },
});
