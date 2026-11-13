import { unwrapRpcResult } from "@opensteer/client/host";
import { useChannelDirectory, useMountedRef } from "@opensteer/client/react";
import {
  browsableChannels,
  channelNameFromInput,
  channelNamed,
  isChannelNameTaken,
  newChannelCommand,
  pickablePeople,
} from "@opensteer/client/team";
import { createId, TeamChannelIdSchema, type UserId } from "@opensteer/core";
import {
  teamDmMaxParticipants,
  type TeamChannelSummary,
  type TeamMember,
} from "@opensteer/protocol";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputInstance,
} from "react-native";
import type { SearchBarCommands, SearchBarTextEventData } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { headerActions } from "../navigation-header.js";
import { AnswerPill } from "../thread/answer-pill.js";
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
import { AppText, Notice, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { SheetBar } from "../ui/sheet-bar.js";
import { Symbol } from "../ui/symbol.js";
import { SwitchSettingRow } from "./settings-rows.js";
import { useTeamMembers, useTeamSession } from "./team-context.js";
import { Avatar, ChannelGlyph } from "./team-marks.js";
import { personView, type MemberDirectory } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type TeamParams = StaticScreenProps<{ readonly teamId: string }>;

/**
 * A sheet that made something leaves for it, so Back returns to where the sheet was opened.
 * An answer that arrives after the person closed the sheet moves nothing.
 */
function useSheetAnswer(teamId: string): {
  readonly shown: { readonly current: boolean };
  readonly openChannel: (channelId: string) => void;
} {
  const navigation = useNavigation<Navigation>();
  const shown = useMountedRef();
  const openChannel = useCallback(
    (channelId: string) => {
      if (!shown.current) return;
      navigation.dispatch(StackActions.pop());
      navigation.dispatch(StackActions.push("TeamChannel", { teamId, channelId }));
    },
    [navigation, shown, teamId],
  );
  return { shown, openChannel };
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "Try again in a moment.";
}

/* ---- Browse channels ---- */

/**
 * Every channel the reader may find, to open or to join. Search lives in the navigation bar,
 * where the platform keeps it; the whole directory is read so it can be searched by name.
 */
export function TeamChannelsScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot, failure } = useTeamSession(teamId);
  const [query, setQuery] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const searchBar = useRef<SearchBarCommands>(null);
  const canCreate = snapshot.bootstrap?.can.createChannel === true;
  const directory = useChannelDirectory(
    session,
    `channels:${teamId}:${snapshot.sidebar?.accessRevision ?? ""}`,
  );
  const channels = useMemo(
    () => browsableChannels(directory.items, query),
    [directory.items, query],
  );
  const words = channelNameFromInput(query);
  const newChannel = useCallback(
    (name?: string) => navigation.navigate("TeamNewChannel", { teamId, name }),
    [navigation, teamId],
  );
  const open = useCallback(
    (channel: TeamChannelSummary) => {
      const go = () => navigation.navigate("TeamChannel", { teamId, channelId: channel.id });
      if (channel.can.read) return go();
      if (!channel.can.join || session === null) return;
      setJoining(channel.id);
      void session.rpc["commands.dispatch"]({ type: "team.channel.join", channelId: channel.id })
        .then(unwrapRpcResult)
        .then(go, (error: unknown) => Alert.alert("Couldn't join", failureText(error)))
        .finally(() => setJoining(null));
    },
    [navigation, session, teamId],
  );
  // The search key's action opens the first match, or makes the channel no one has yet.
  const submit = useRef<() => void>(() => undefined);
  submit.current = () => {
    const first = channels[0];
    if (first) open(first);
    else if (canCreate && words !== "" && directory.complete) newChannel(words);
  };
  useLayoutEffect(() => {
    navigation.setOptions({
      ...(canCreate
        ? headerActions({
            right: { icon: "plus", label: "New channel", onPress: () => newChannel() },
          })
        : {}),
      headerSearchBarOptions: {
        // On iOS 26 an integrated field may move into a bottom toolbar beside nothing.
        allowToolbarIntegration: false,
        autoCapitalize: "none",
        barTintColor: color.surfaceElevated,
        headerIconColor: color.ember,
        hideWhenScrolling: false,
        hintTextColor: color.muted,
        onChangeText: (event: NativeSyntheticEvent<SearchBarTextEventData>) =>
          setQuery(event.nativeEvent.text),
        onSearchButtonPress: () => submit.current(),
        placeholder: "Find a channel",
        ref: searchBar,
        textColor: color.text,
        tintColor: color.ember,
      },
    });
  }, [canCreate, navigation, newChannel]);
  const empty =
    directory.loading || (!directory.complete && directory.error === null) ? (
      <View style={styles.state}>
        <ActivityIndicator color={color.muted} />
      </View>
    ) : directory.error !== null ? (
      <View style={styles.state}>
        <Notice
          detail={failureText(directory.error) || (failure ?? "")}
          title="Channels didn't load"
          tone="neutral"
        />
        <SecondaryButton label="Try again" onPress={directory.retry} />
      </View>
    ) : (
      <View style={styles.state}>
        <AppText role="secondary" style={styles.centered} tone="muted">
          {words === "" ? "No channels yet." : `No channel called “${words}”.`}
        </AppText>
        {canCreate ? (
          <SecondaryButton
            label={words === "" ? "New channel" : `Create #${words}`}
            onPress={() => newChannel(words)}
          />
        ) : null}
      </View>
    );
  return (
    <Screen edgeToEdge>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={channels}
        initialNumToRender={16}
        ItemSeparatorComponent={RowSeparator}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(channel) => channel.id}
        ListEmptyComponent={empty}
        ListFooterComponent={
          directory.error !== null && channels.length > 0 ? (
            <View style={styles.state}>
              <AppText role="caption" style={styles.centered} tone="muted">
                Some channels didn't load.
              </AppText>
              <SecondaryButton label="Try again" onPress={directory.retry} />
            </View>
          ) : !directory.complete && channels.length > 0 ? (
            <ActivityIndicator color={color.muted} style={styles.more} />
          ) : directory.capped ? (
            <AppText role="caption" style={styles.hint} tone="muted">
              Only the first 1,000 channels are listed here.
            </AppText>
          ) : words === "" && channels.length === 1 && canCreate ? (
            <AppText role="caption" style={styles.hint} tone="muted">
              {`It's just #${channels[0]!.name} so far. Start a channel for a project, a topic or a group of people.`}
            </AppText>
          ) : undefined
        }
        renderItem={({ item }) => (
          <ChannelChoice channel={item} joining={joining === item.id} onOpen={open} />
        )}
        windowSize={9}
      />
    </Screen>
  );
}

const ChannelChoice = memo(function ChannelChoice(props: {
  readonly channel: TeamChannelSummary;
  readonly joining: boolean;
  readonly onOpen: (channel: TeamChannelSummary) => void;
}): ReactNode {
  const { channel } = props;
  const state = channel.archivedAt
    ? "Archived"
    : channel.can.read
      ? "Joined"
      : channel.can.join
        ? null
        : "Members only";
  const kind = channel.kind === "private" ? "private" : "public";
  return (
    <Pressable
      accessibilityHint={state === null ? "Joins it and opens it" : undefined}
      accessibilityLabel={[
        `${kind === "private" ? "Private channel" : "Channel"} ${channel.name}`,
        channel.peopleOnly ? "people only" : null,
        state ?? "not joined",
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      accessibilityState={{ busy: props.joining, disabled: !channel.can.read && !channel.can.join }}
      disabled={!channel.can.read && !channel.can.join}
      onPress={() => props.onOpen(channel)}
      style={({ pressed }) => [styles.channel, pressed && styles.pressed]}
    >
      <View style={styles.glyph}>
        <ChannelGlyph kind={kind} size={15} />
      </View>
      <View style={styles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
          {channel.name}
        </AppText>
        {channel.peopleOnly ? (
          <View style={styles.peopleOnly}>
            <Symbol name="person" size={11} tint={color.blue} weight="semibold" />
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="caption"
              style={styles.peopleOnlyText}
            >
              People only
            </AppText>
          </View>
        ) : null}
      </View>
      {state === null ? (
        <View style={styles.join}>
          {props.joining ? (
            <ActivityIndicator color={color.ember} size="small" />
          ) : (
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="secondaryMedium"
              tone="ember"
            >
              Join
            </AppText>
          )}
        </View>
      ) : (
        <View style={styles.status}>
          {state === "Joined" ? (
            <Symbol name="checkmark" size={12} tint={color.muted} weight="semibold" />
          ) : null}
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondary" tone="muted">
            {state}
          </AppText>
        </View>
      )}
    </Pressable>
  );
});

function RowSeparator(): ReactNode {
  return <View style={styles.separator} />;
}

/* ---- New channel ---- */

/**
 * A new channel: a name, who can find it, and whether agents are kept out. A private one
 * can start with people in it. The team decides who may make one; this only asks.
 */
export function TeamNewChannelScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly name?: string | undefined }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { shown, openChannel } = useSheetAnswer(teamId);
  const insets = useSafeAreaInsets();
  const { session, snapshot } = useTeamSession(teamId);
  const people = useTeamMembers(teamId);
  const [id] = useState(() => TeamChannelIdSchema.parse(createId("teamChannel")));
  const [name, setName] = useState(props.route.params.name ?? "");
  const [isPrivate, setPrivate] = useState(false);
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [chosen, setChosen] = useState<readonly UserId[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ name: string; message: string } | null>(null);
  const teamName = snapshot.bootstrap?.teamName ?? "the team";
  const offline = snapshot.connection !== "connected";
  const words = channelNameFromInput(name);
  const joined = channelNamed(snapshot.sidebar?.channels.map((row) => row.channel) ?? [], name);
  const refused = refusal?.name === words ? refusal.message : null;
  const ready = words !== "" && joined === null && refused === null && !offline && !busy;
  const create = (): void => {
    if (!ready || session === null) return;
    setBusy(true);
    void session.rpc["commands.dispatch"](
      newChannelCommand({ id, name, isPrivate, peopleOnly, people: chosen }),
    )
      .then(unwrapRpcResult)
      .then(
        () => openChannel(id),
        (error: unknown) => {
          if (!shown.current) return;
          setBusy(false);
          if (isChannelNameTaken(error)) setRefusal({ name: words, message: failureText(error) });
          else Alert.alert("The channel wasn't made", failureText(error));
        },
      );
  };
  const one = chosen[0] === undefined ? null : personView(chosen[0], people.directory).name;
  const note = offline
    ? `Can't reach ${teamName} right now.`
    : !isPrivate
      ? `Anyone in ${teamName} can find and join it.`
      : one === null
        ? "Just you for now. You can add people later."
        : `You and ${chosen.length === 1 ? (one.split(/\s+/u)[0] ?? one) : `${chosen.length} people`}. You'll manage it.`;
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={{ paddingBottom: insets.bottom + space[24] }}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={[0]}
      style={styles.sheet}
    >
      <SheetBar
        action={
          <AnswerPill
            busy={busy}
            disabled={!ready}
            label="Create"
            onPress={create}
            tone="primary"
          />
        }
        closeLabel="Cancel new channel"
        onClose={() => navigation.goBack()}
        title="New channel"
      />
      <View style={styles.form}>
        <View style={styles.section}>
          <AppText role="secondaryMedium" tone="soft">
            Name
          </AppText>
          <View style={[styles.field, (joined ?? refused) !== null && styles.fieldInvalid]}>
            <ChannelGlyph kind={isPrivate ? "private" : "public"} size={16} />
            <TextInput
              accessibilityLabel="Channel name"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              cursorColor={color.ember}
              maxFontSizeMultiplier={controlFontScaleLimit}
              maxLength={160}
              onChangeText={setName}
              onSubmitEditing={create}
              placeholder="launch-plans"
              placeholderTextColor={color.muted}
              returnKeyType="done"
              selectionColor={color.ember}
              style={styles.input}
              submitBehavior="submit"
              value={name}
            />
          </View>
          {joined ? (
            <AppText role="caption" tone="danger">
              {`You're already in #${joined.name}. `}
              <Text
                accessibilityRole="link"
                onPress={() => openChannel(joined.id)}
                style={styles.inlineLink}
              >
                Open it
              </Text>
            </AppText>
          ) : refused ? (
            <AppText role="caption" tone="danger">
              {refused}
            </AppText>
          ) : null}
        </View>
        <RowGroup>
          {[
            <SwitchSettingRow
              detail="Only people you add can find and read it."
              icon="lock"
              key="private"
              label="Private"
              onChange={setPrivate}
              value={isPrivate}
            />,
            <SwitchSettingRow
              detail="Agents can't read or post here, including yours."
              key="people-only"
              label="People only"
              mark={<Symbol name="person" size={17} tint={color.blue} />}
              onChange={setPeopleOnly}
              value={peopleOnly}
            />,
          ]}
        </RowGroup>
        {isPrivate ? (
          <View style={styles.section}>
            <View style={styles.labelRow}>
              <AppText role="secondaryMedium" tone="soft">
                Add people
              </AppText>
              <AppText role="caption" tone="muted">
                Optional
              </AppText>
            </View>
            <PeoplePicker
              chosen={chosen}
              onChange={setChosen}
              people={people}
              teamName={teamName}
              viewer={snapshot.bootstrap?.member.userId ?? null}
            />
          </View>
        ) : null}
        <AppText role="caption" style={styles.note} tone="muted">
          {note}
        </AppText>
      </View>
    </ScrollView>
  );
}

/* ---- New message ---- */

/** A message to one person, or a group of a few. Opens what those people already have. */
export function TeamNewMessageScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { shown, openChannel } = useSheetAnswer(teamId);
  const insets = useSafeAreaInsets();
  const { session, snapshot } = useTeamSession(teamId);
  const people = useTeamMembers(teamId);
  const [chosen, setChosen] = useState<readonly UserId[]>([]);
  const [busy, setBusy] = useState(false);
  const teamName = snapshot.bootstrap?.teamName ?? "the team";
  const offline = snapshot.connection !== "connected";
  const ready = chosen.length > 0 && !offline && !busy && session !== null;
  const open = (): void => {
    if (!ready || session === null) return;
    setBusy(true);
    void session.rpc["commands.dispatch"]({ type: "team.dm.open", participants: [...chosen] })
      .then(unwrapRpcResult)
      .then(
        (result) => {
          if (result.type === "team.dm.open") openChannel(result.channel.id);
        },
        (error: unknown) => {
          if (!shown.current) return;
          setBusy(false);
          Alert.alert("That message couldn't start", failureText(error));
        },
      );
  };
  return (
    <View style={styles.sheet}>
      <SheetBar
        action={
          <AnswerPill busy={busy} disabled={!ready} label="Message" onPress={open} tone="primary" />
        }
        closeLabel="Cancel new message"
        onClose={() => navigation.goBack()}
        title="New message"
      />
      <PeoplePicker
        autoFocus
        chosen={chosen}
        fill
        label="To"
        max={teamDmMaxParticipants}
        note={
          offline
            ? `Can't reach ${teamName} right now.`
            : chosen.length > 1
              ? `A group message. Up to ${teamDmMaxParticipants} people.`
              : null
        }
        onChange={setChosen}
        onSubmit={open}
        paddingBottom={insets.bottom + space[24]}
        people={people}
        teamName={teamName}
        viewer={snapshot.bootstrap?.member.userId ?? null}
      />
    </View>
  );
}

/* ---- Choosing people ---- */

/** A short list inside a form shows this many matches; searching finds the rest. */
const formRows = 30;

/**
 * Who is chosen stays in the field as chips; the list toggles them. Return takes the first
 * match, or sends once the search is empty. As a whole sheet's body (`fill`), the list
 * scrolls under the field.
 */
function PeoplePicker(props: {
  readonly autoFocus?: boolean;
  readonly chosen: readonly UserId[];
  readonly fill?: boolean;
  /** A word before the chips: "To". */
  readonly label?: string;
  readonly max?: number;
  readonly note?: string | null;
  readonly onChange: (chosen: readonly UserId[]) => void;
  readonly onSubmit?: () => void;
  readonly paddingBottom?: number;
  readonly people: ReturnType<typeof useTeamMembers>;
  readonly teamName: string;
  readonly viewer: string | null;
}): ReactNode {
  const [query, setQuery] = useState("");
  const input = useRef<TextInputInstance>(null);
  const { chosen, onChange, people } = props;
  const others = useMemo(
    () => pickablePeople(people.members, props.viewer ?? "", ""),
    [people.members, props.viewer],
  );
  const shown = useMemo(
    () => (query.trim() === "" ? others : pickablePeople(others, "", query)),
    [others, query],
  );
  const full = props.max !== undefined && chosen.length >= props.max;
  const toggle = useCallback(
    (userId: UserId) => {
      void Haptics.selectionAsync();
      onChange(
        chosen.includes(userId)
          ? chosen.filter((id) => id !== userId)
          : full
            ? chosen
            : [...chosen, userId],
      );
      setQuery("");
    },
    [chosen, full, onChange],
  );
  if (others.length === 0)
    return (
      <View style={[styles.state, props.fill === true && styles.fill]}>
        {people.status === "reading" ? (
          <ActivityIndicator color={color.muted} />
        ) : (
          <>
            <View style={styles.emptyMark}>
              <Symbol name="person.2" size={20} tint={color.textSoft} />
            </View>
            <AppText role="bodyMedium" style={styles.centered}>
              {people.status === "failed"
                ? "Can't load people right now"
                : "No one else is here yet"}
            </AppText>
            <AppText role="secondary" style={styles.centered} tone="muted">
              {people.status === "failed"
                ? `Check your connection to ${props.teamName} and try again.`
                : `Invite people to ${props.teamName}, then you can pick them here.`}
            </AppText>
          </>
        )}
      </View>
    );
  const field = (
    <View style={styles.pickerHead}>
      <Pressable
        accessible={false}
        onPress={() => input.current?.focus()}
        style={[styles.field, styles.chips]}
      >
        {props.label ? (
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="body" tone="muted">
            {props.label}
          </AppText>
        ) : null}
        {chosen.map((userId) => (
          <PersonChip directory={people.directory} key={userId} onRemove={toggle} userId={userId} />
        ))}
        <TextInput
          accessibilityLabel={props.label ?? "Find people"}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={props.autoFocus}
          cursorColor={color.ember}
          maxFontSizeMultiplier={controlFontScaleLimit}
          onChangeText={setQuery}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Backspace" && query === "" && chosen.length > 0)
              onChange(chosen.slice(0, -1));
          }}
          onSubmitEditing={() => {
            const top = shown[0];
            if (query.trim() !== "" && top) toggle(top.userId);
            else if (query.trim() === "") props.onSubmit?.();
          }}
          placeholder={chosen.length === 0 ? "Name or @handle" : ""}
          placeholderTextColor={color.muted}
          ref={input}
          returnKeyType={query.trim() === "" && props.onSubmit ? "send" : "done"}
          selectionColor={color.ember}
          style={styles.chipsInput}
          submitBehavior="submit"
          value={query}
        />
      </Pressable>
      {props.note ? (
        <AppText role="caption" tone="muted">
          {props.note}
        </AppText>
      ) : null}
      {full ? (
        <AppText role="caption" tone="muted">
          {`A message holds up to ${props.max} people besides you.`}
        </AppText>
      ) : null}
      {shown.length === 0 ? (
        <AppText role="secondary" tone="muted">
          {`No one called “${query.trim()}” in ${props.teamName}.`}
        </AppText>
      ) : null}
    </View>
  );
  const row = (member: TeamMember, index: number) => (
    <PersonChoice
      active={index === 0 && query.trim() !== ""}
      chosen={chosen.includes(member.userId)}
      directory={people.directory}
      disabled={full && !chosen.includes(member.userId)}
      key={member.userId}
      member={member}
      onToggle={toggle}
    />
  );
  if (props.fill === true)
    return (
      <FlatList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.list, { paddingBottom: props.paddingBottom ?? 0 }]}
        data={shown}
        initialNumToRender={16}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(member) => member.userId}
        ListHeaderComponent={field}
        renderItem={({ item, index }) => row(item, index)}
        style={styles.fill}
        windowSize={9}
      />
    );
  return (
    <View style={styles.compact}>
      {field}
      {shown.slice(0, formRows).map(row)}
      {shown.length > formRows ? (
        <AppText role="caption" style={styles.more} tone="muted">
          {`${shown.length - formRows} more. Search to find them.`}
        </AppText>
      ) : null}
    </View>
  );
}

const PersonChip = memo(function PersonChip(props: {
  readonly directory: MemberDirectory;
  readonly onRemove: (userId: UserId) => void;
  readonly userId: UserId;
}): ReactNode {
  const person = personView(props.userId, props.directory);
  return (
    <Pressable
      accessibilityHint="Removes them"
      accessibilityLabel={person.name}
      accessibilityRole="button"
      hitSlop={4}
      onPress={() => props.onRemove(props.userId)}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Avatar ground={plateFill} person={person} size={18} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondaryMedium"
        style={styles.chipName}
      >
        {person.name}
      </AppText>
      <Symbol name="xmark" size={10} tint={color.muted} weight="bold" />
    </Pressable>
  );
});

const PersonChoice = memo(function PersonChoice(props: {
  readonly active: boolean;
  readonly chosen: boolean;
  readonly directory: MemberDirectory;
  readonly disabled: boolean;
  readonly member: TeamMember;
  readonly onToggle: (userId: UserId) => void;
}): ReactNode {
  const person = personView(props.member.userId, props.directory);
  return (
    <Pressable
      accessibilityLabel={`${person.name}, @${person.handle}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.chosen, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onToggle(props.member.userId)}
      style={({ pressed }) => [
        styles.person,
        (pressed || props.active) && styles.pressed,
        props.disabled && styles.disabled,
      ]}
    >
      <Avatar ground={plateFill} person={person} presence size={36} />
      <View style={styles.words}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
          {person.name}
        </AppText>
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          @{person.handle}
        </AppText>
      </View>
      <Symbol
        name={props.chosen ? "checkmark.circle.fill" : "circle"}
        size={22}
        tint={props.chosen ? color.ember : color.mutedDim}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  centered: { textAlign: "center" },
  channel: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
  },
  chip: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: "100%",
    minHeight: 30,
    paddingLeft: space[4],
    paddingRight: space[10],
  },
  chipName: { flexShrink: 1 },
  chipPressed: { ...material.selected },
  chips: { flexWrap: "wrap", gap: space[6], paddingVertical: space[6] },
  chipsInput: {
    ...type.body,
    color: color.text,
    flexGrow: 1,
    minWidth: 64,
    paddingVertical: space[6],
  },
  compact: { gap: space[2] },
  disabled: { opacity: 0.45 },
  emptyMark: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    height: 44,
    justifyContent: "center",
    marginBottom: space[4],
    width: 44,
  },
  field: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget + space[4],
    paddingHorizontal: space[12],
  },
  fieldInvalid: { borderColor: color.red },
  fill: { flex: 1 },
  form: { gap: space[20], paddingHorizontal: space[16], paddingTop: space[12] },
  glyph: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  hint: { paddingHorizontal: space[24], paddingVertical: space[16], textAlign: "center" },
  inlineLink: { color: color.ember, fontWeight: "600" },
  input: { ...type.body, color: color.text, flex: 1, paddingVertical: space[10] },
  join: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: 32,
    minWidth: 64,
    paddingHorizontal: space[14],
  },
  labelRow: { alignItems: "baseline", flexDirection: "row", justifyContent: "space-between" },
  list: { paddingHorizontal: space[16] },
  more: { paddingHorizontal: space[10], paddingTop: space[8] },
  note: { paddingHorizontal: space[4] },
  peopleOnly: { alignItems: "center", flexDirection: "row", gap: space[4] },
  peopleOnlyText: { color: color.blue },
  person: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[10],
  },
  pickerHead: { gap: space[10], paddingBottom: space[10], paddingTop: space[12] },
  pressed: { ...material.quiet },
  section: { gap: space[8] },
  separator: {
    backgroundColor: color.line,
    height: StyleSheet.hairlineWidth,
    marginLeft: space[16] + 32 + space[12],
  },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  state: {
    alignItems: "center",
    gap: space[10],
    justifyContent: "center",
    paddingHorizontal: space[24],
    paddingVertical: space[48],
  },
  status: { alignItems: "center", flexDirection: "row", gap: space[4] },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
