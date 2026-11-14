import { Fragment, useState, type ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { Notice, PrimaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useMobileTeams, useTeamSession, useTeamsSnapshot } from "./team-context.js";

/** The navigator applies this to every route with a team, including sheets and nested notes. */
export function TeamScreenLayout(props: {
  readonly children: ReactNode;
  readonly route: { readonly name?: string; readonly params?: unknown };
}): ReactNode {
  const params = props.route.params;
  const teamId = params && typeof params === "object" && "teamId" in params ? params.teamId : null;
  if (
    typeof teamId !== "string" &&
    /^(Team|CreateTeam|JoinTeam|DeleteTeam|TransferTeam|ConnectOpensteer)/.test(
      props.route.name ?? "",
    )
  )
    return <TeamEntryScreen>{props.children}</TeamEntryScreen>;
  return typeof teamId === "string" ? (
    <TeamScreenGate teamId={teamId}>{props.children}</TeamScreenGate>
  ) : (
    props.children
  );
}

function TeamEntryScreen({ children }: { readonly children: ReactNode }): ReactNode {
  const teams = useMobileTeams();
  useTeamsSnapshot();
  return <Fragment key={teams.owner.id}>{children}</Fragment>;
}

export function TeamScreenGate({
  teamId,
  children,
}: {
  readonly teamId: string;
  readonly children: ReactNode;
}): ReactNode {
  const teams = useMobileTeams();
  useTeamsSnapshot();
  return (
    <AccountTeamScreen key={teams.owner.id} teamId={teamId}>
      {children}
    </AccountTeamScreen>
  );
}

function AccountTeamScreen({
  teamId,
  children,
}: {
  readonly teamId: string;
  readonly children: ReactNode;
}): ReactNode {
  const teams = useMobileTeams();
  const navigation = useNavigation();
  const { team, snapshot, failure } = useTeamSession(teamId);
  const [busy, setBusy] = useState(false);
  const state = team?.state;
  if ((state === "live" || state === "offline" || state === "loading") && snapshot.bootstrap)
    return <Fragment>{children}</Fragment>;
  const name = team?.name ?? "this team";
  const signIn = state === "signed-out";
  const title =
    state === "removed"
      ? `You're no longer in ${name}`
      : state === "join"
        ? "Join this team"
        : state === "update-app"
          ? "Update Opensteer"
          : state === "update-server"
            ? "Team server needs an update"
            : signIn
              ? `Sign in to ${name}`
              : `${name} didn't answer`;
  const detail =
    failure ??
    (state === "removed" || state === "join"
      ? "Ask a team member for a new invite."
      : state === "update-app"
        ? "Install the latest Opensteer app to open this team."
        : state === "update-server"
          ? "Ask the team administrator to update the server."
          : "Try again when you're connected.");
  const attempt = () => {
    setBusy(true);
    void (signIn ? teams.addToPhone(teamId).then(() => teams.select(teamId)) : teams.select(teamId))
      .catch((error: unknown) =>
        Alert.alert("Team couldn't open", error instanceof Error ? error.message : undefined),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Screen>
      <View style={styles.center}>
        {state === "loading" && failure === null ? (
          <ActivityIndicator color={color.muted} />
        ) : (
          <>
            <Notice title={title} detail={detail} tone="neutral" />
            {signIn || state === "offline" || !state ? (
              <PrimaryButton busy={busy} label={signIn ? "Sign in" : "Retry"} onPress={attempt} />
            ) : null}
            <PrimaryButton
              label="Remove from this phone"
              onPress={() => void teams.forget(teamId).then(() => navigation.goBack())}
            />
          </>
        )}
      </View>
    </Screen>
  );
}
const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", padding: space[24], gap: space[16] },
});
