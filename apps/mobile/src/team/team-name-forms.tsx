import { unwrapRpcResult } from "@opensteer/client/host";
import { createId, TeamChannelIdSchema } from "@opensteer/core";
import type { TeamChannel } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, space } from "../theme.js";
import { AppText, Field, Notice, PrimaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useTeamSession } from "./team-context.js";

type Navigation = NativeStackNavigationProp<RootParamList>;

/** Channel and group names: the team's own limit. */
const nameLimit = 160;

/** A channel's new name, for the people who manage it. */
export function TeamRenameChannelScreen(
  props: StaticScreenProps<{ readonly teamId: string; readonly channelId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const channelId = TeamChannelIdSchema.parse(props.route.params.channelId);
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  const [channel, setChannel] = useState<TeamChannel | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (session === null) return;
    let current = true;
    void session.rpc["team.channel.get"]({ channelId })
      .then(unwrapRpcResult)
      .then(
        (value) => current && setChannel(value),
        (error: unknown) =>
          current && setFailure(error instanceof Error ? error.message : "The team didn't answer."),
      );
    return () => {
      current = false;
    };
  }, [channelId, session]);
  if (session === null || channel === null)
    return (
      <Screen>
        <View style={styles.center}>
          {failure === null ? (
            <ActivityIndicator color={color.muted} />
          ) : (
            <Notice detail={failure} title="This didn't load" tone="neutral" />
          )}
        </View>
      </Screen>
    );
  return (
    <NameForm
      initial={channel.name}
      label="Channel name"
      lowercase
      onSubmit={async (name) => {
        unwrapRpcResult(
          await session.rpc["commands.dispatch"]({
            type: "team.channel.update",
            channelId,
            name: name.replace(/^#/u, ""),
            peopleOnly: channel.peopleOnly,
          }),
        );
        navigation.goBack();
      }}
      placeholder="support"
      submitLabel="Rename"
    />
  );
}

/** A new, empty group; it opens next so people can be added to it. */
export function TeamNewGroupScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { session } = useTeamSession(teamId);
  return (
    <NameForm
      initial=""
      label="Group name"
      onSubmit={async (name) => {
        if (session === null) throw new Error("The team isn't connected yet.");
        const id = createId("teamGroup");
        unwrapRpcResult(
          await session.rpc["commands.dispatch"]({ type: "team.group.create", id, name }),
        );
        navigation.replace("TeamGroup", { teamId, groupId: id });
      }}
      placeholder="Support leads"
      submitLabel="Create group"
    />
  );
}

/**
 * One name and its button. Its own screen, not a system prompt: only iOS has
 * a text prompt, and this reads the same on both.
 */
function NameForm(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly initial: string;
  readonly submitLabel: string;
  /** Channel names are written in lower case. */
  readonly lowercase?: boolean;
  /** Leaves the screen once done; a rejection stays here and is shown. */
  readonly onSubmit: (name: string) => Promise<void>;
}): ReactNode {
  const padding = useSafeAreaInsets().bottom + space[24];
  const [name, setName] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const words = name.trim();
  const ready = words !== "" && words !== props.initial.trim() && !busy;
  const submit = (): void => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    props.onSubmit(words).then(
      () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : "That wasn't saved.");
      },
    );
  };
  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.page, { paddingBottom: padding }]}
        keyboardShouldPersistTaps="handled"
      >
        <Field
          input={{
            autoCapitalize: props.lowercase === true ? "none" : "sentences",
            autoCorrect: false,
            autoFocus: true,
            maxLength: nameLimit,
            onChangeText: setName,
            onSubmitEditing: submit,
            placeholder: props.placeholder,
            returnKeyType: "done",
            selectTextOnFocus: props.initial !== "",
            value: name,
          }}
          label={props.label}
        />
        {failure === null ? null : (
          <AppText role="secondary" tone="danger">
            {failure}
          </AppText>
        )}
        <PrimaryButton
          busy={busy}
          disabled={!ready && !busy}
          label={props.submitLabel}
          onPress={submit}
          prominent
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
  page: { gap: space[16], padding: space[16] },
});
