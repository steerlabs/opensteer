import { unwrapRpcResult } from "@opensteer/client/host";
import { createId, TeamChannelIdSchema } from "@opensteer/core";
import type { TeamChannel } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { space } from "../theme.js";
import { ActionLineSlot, type ActionLineValue } from "../ui/action-line.js";
import { readLine, useScreenRead, actOnce, outcomeLine } from "../ui/client-feedback.js";
import { Field, PrimaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useTeamSession } from "./team-context.js";
import { TeamWaiting } from "./team-feedback.js";

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
  const read = useScreenRead<TeamChannel>(session, {
    key: `team-channel:${channelId}`,
    label: "this channel",
    read:
      session === null
        ? null
        : () => session.rpc["team.channel.get"]({ channelId }).then(unwrapRpcResult),
  });
  const channel = read.data;
  if (session === null || channel === null)
    return <TeamWaiting line={readLine(read, read.refresh)} />;
  return (
    <NameForm
      initial={channel.name}
      label="Channel name"
      lowercase
      onSubmit={async (name) => {
        const outcome = await actOnce(
          session,
          { label: "rename this channel", done: "renamed" },
          async () =>
            unwrapRpcResult(
              await session.rpc["commands.dispatch"]({
                type: "team.channel.update",
                channelId,
                name: name.replace(/^#/u, ""),
                peopleOnly: channel.peopleOnly,
              }),
            ),
        );
        if (outcome.kind === "confirmed") navigation.goBack();
        return outcomeLine(outcome);
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
        if (session === null) return null;
        const id = createId("teamGroup");
        const outcome = await actOnce(
          session,
          { label: "make this group", done: "made" },
          async () =>
            unwrapRpcResult(
              await session.rpc["commands.dispatch"]({ type: "team.group.create", id, name }),
            ),
        );
        if (outcome.kind === "confirmed") navigation.replace("TeamGroup", { teamId, groupId: id });
        return outcomeLine(outcome);
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
  /** Leaves the screen once done; otherwise its outcome stays here and is shown. */
  readonly onSubmit: (name: string) => Promise<ActionLineValue | null>;
}): ReactNode {
  const padding = useSafeAreaInsets().bottom + space[24];
  const [name, setName] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionLineValue | null>(null);
  const words = name.trim();
  const ready = words !== "" && words !== props.initial.trim() && !busy;
  const submit = (): void => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    void props.onSubmit(words).then((line) => {
      if (line === null) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }
      setBusy(false);
      setFailure(line);
    });
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
        <ActionLineSlot line={failure} onDismiss={() => setFailure(null)} />
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
  page: { gap: space[16], padding: space[16] },
});
