import { unwrapRpcResult } from "@opensteer/client/host";
import { createId, TeamChannelIdSchema, type UserId } from "@opensteer/core";
import type { TeamMember } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { memo, useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { AppText, PrimaryButton, RowGroup } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { GroupNote, SwitchSettingRow } from "./settings-rows.js";
import { useTeamMembers, useTeamSession } from "./team-context.js";
import { Avatar, peopleOnlySentence } from "./team-marks.js";
import { personView, type MemberDirectory } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type TeamParams = StaticScreenProps<{ readonly teamId: string }>;

/** A new channel: any member the team lets create one. The team decides; this only asks. */
export function TeamNewChannelScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot } = useTeamSession(teamId);
  const padding = useSafeAreaInsets().bottom + space[24];
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const me = snapshot.bootstrap?.member.userId ?? null;
  const words = name.trim().replace(/^#/u, "");
  const create = (): void => {
    if (session === null || me === null || words === "") return;
    const id = TeamChannelIdSchema.parse(createId("teamChannel"));
    setBusy(true);
    setFailure(null);
    void session.rpc["commands.dispatch"]({
      type: "team.channel.create",
      id,
      kind: isPrivate ? "private" : "public",
      name: words,
      peopleOnly,
      // A private channel starts with its maker, who manages it.
      access: isPrivate
        ? [{ subject: { kind: "person", userId: me }, level: "post", manage: true }]
        : [],
    })
      .then(unwrapRpcResult)
      .then(
        () => navigation.replace("TeamChannel", { teamId, channelId: id }),
        (error: unknown) =>
          setFailure(error instanceof Error ? error.message : "The channel wasn't made."),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: padding }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <AppText role="secondary" tone="muted">
            #
          </AppText>
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
            placeholder="channel-name"
            placeholderTextColor={color.muted}
            returnKeyType="done"
            selectionColor={color.ember}
            style={styles.input}
            value={name}
          />
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
              detail={peopleOnlySentence}
              icon="person.2"
              key="people-only"
              label="People only"
              onChange={setPeopleOnly}
              value={peopleOnly}
            />,
          ]}
        </RowGroup>
        {failure === null ? null : <GroupNote>{failure}</GroupNote>}
        <PrimaryButton
          busy={busy}
          disabled={words === "" || session === null || me === null}
          label="Create channel"
          onPress={create}
          prominent
        />
      </ScrollView>
    </Screen>
  );
}

/** A direct message with one person, or a group message with a few. */
export function TeamNewMessageScreen(props: TeamParams): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session, snapshot } = useTeamSession(teamId);
  const { members, directory } = useTeamMembers(teamId);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<readonly UserId[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const me = snapshot.bootstrap?.member.userId ?? null;
  const people = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return members.filter(
      (member) =>
        member.state === "active" &&
        member.userId !== me &&
        (lower === "" ||
          member.displayName.toLowerCase().includes(lower) ||
          member.handle.includes(lower)),
    );
  }, [me, members, query]);
  const toggle = (userId: UserId): void =>
    setChosen((held) =>
      held.includes(userId)
        ? held.filter((id) => id !== userId)
        : held.length >= 31
          ? held
          : [...held, userId],
    );
  const open = (): void => {
    if (session === null || chosen.length === 0) return;
    setBusy(true);
    setFailure(null);
    void session.rpc["commands.dispatch"]({ type: "team.dm.open", participants: [...chosen] })
      .then(unwrapRpcResult)
      .then(
        (result) => {
          if (result.type === "team.dm.open")
            navigation.replace("TeamChannel", { teamId, channelId: result.channel.id });
        },
        (error: unknown) =>
          setFailure(error instanceof Error ? error.message : "That message couldn't start."),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + space[64] + space[16] },
        ]}
        data={people}
        initialNumToRender={16}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(member) => member.userId}
        ListHeaderComponent={
          <View style={styles.listHead}>
            <SearchField autoFocus onChange={setQuery} placeholder="Find people" value={query} />
            {failure === null ? null : <GroupNote>{failure}</GroupNote>}
          </View>
        }
        renderItem={({ item }) => (
          <PersonChoice
            chosen={chosen.includes(item.userId)}
            directory={directory}
            member={item}
            onToggle={toggle}
          />
        )}
        windowSize={9}
      />
      <View style={[styles.dock, { paddingBottom: insets.bottom + space[12] }]}>
        <PrimaryButton
          busy={busy}
          disabled={chosen.length === 0 || session === null}
          label={chosen.length <= 1 ? "Message" : `Message ${chosen.length} people`}
          onPress={open}
          prominent
        />
      </View>
    </Screen>
  );
}

const PersonChoice = memo(function PersonChoice(props: {
  readonly chosen: boolean;
  readonly directory: MemberDirectory;
  readonly member: TeamMember;
  readonly onToggle: (userId: UserId) => void;
}): ReactNode {
  const person = personView(props.member.userId, props.directory);
  return (
    <Pressable
      accessibilityLabel={`${person.name}, @${person.handle}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.chosen }}
      onPress={() => props.onToggle(props.member.userId)}
      style={({ pressed }) => [styles.person, pressed && styles.pressed]}
    >
      <Avatar ground={plateFill} person={person} presence size={28} />
      <View style={styles.personWords}>
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
        size={20}
        tint={props.chosen ? color.ember : color.mutedDim}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  dock: { left: 0, paddingHorizontal: space[16], position: "absolute", right: 0, bottom: 0 },
  field: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[6],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  input: { ...type.body, color: color.text, flex: 1, paddingVertical: space[8] },
  list: { paddingHorizontal: space[16] },
  listHead: { gap: space[12], paddingBottom: space[8], paddingTop: space[16] },
  page: { gap: space[20], padding: space[16] },
  person: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[10],
  },
  personWords: { flex: 1, minWidth: 0 },
  pressed: { ...material.quiet },
});
