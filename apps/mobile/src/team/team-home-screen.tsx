import type { TeamSessionClient, TeamSidebar } from "@opensteer/client/team";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootParamList } from "../navigation.js";
import { color, headerFontScaleLimit, space } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText, Notice, PrimaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { ConnectionBanner, useConnectionBanner } from "./connection-banner.js";
import { TeamPageList } from "./team-page-list.js";
import { useMobileTeams, useTeamEntry, useTeamSession } from "./team-context.js";
import { DeploymentIdSchema } from "@opensteer/core";
import { drawerSection } from "./team-views.js";

type Navigation = NativeStackNavigationProp<RootParamList>;

/**
 * One team's page, from its row in the drawer: its channels, then its direct
 * messages. The team's menu is the page's title menu. Channels, threads and
 * DMs push over it like any screen.
 */
export function TeamHomeScreen(props: StaticScreenProps<{ readonly teamId: string }>): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const { coordinator } = useTeamEntry();
  const { team, session, snapshot, failure } = useTeamSession(teamId);
  const sidebar = useSidebar(session);
  const canInvite = snapshot.bootstrap?.can.manageInvites === true;
  const banner = useConnectionBanner(team, snapshot.connection, () => session?.connect());
  const padding = useSafeAreaInsets().bottom + space[24];
  const [signingIn, setSigningIn] = useState(false);
  const name = team?.name ?? "Team";

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <NativeMenu
          accessibilityHint={
            canInvite
              ? "Knowledge, invite people, team settings and leaving"
              : "Knowledge, team settings and leaving"
          }
          accessibilityLabel={`${name} menu`}
          options={[
            [
              {
                icon: "lightbulb",
                id: "knowledge",
                label: "Knowledge",
                onPress: () => navigation.navigate("TeamKnowledge", { teamId }),
              },
              ...(canInvite
                ? [
                    {
                      icon: "link" as const,
                      id: "invite",
                      label: "Invite people",
                      onPress: () => navigation.navigate("TeamInvites", { teamId }),
                    },
                  ]
                : []),
              {
                icon: "gearshape",
                id: "settings",
                label: "Team settings",
                onPress: () => navigation.navigate("TeamSettings", { teamId }),
              },
            ],
            [
              {
                destructive: true,
                id: "leave",
                label: `Leave ${name}`,
                onPress: () =>
                  Alert.alert(
                    `Leave ${name}?`,
                    `You'll lose access to its channels. Tasks your agent did for ${name} stay on your computer.`,
                    [
                      { style: "cancel", text: "Cancel" },
                      {
                        style: "destructive",
                        text: "Leave",
                        onPress: () =>
                          void coordinator.leaveTeam(DeploymentIdSchema.parse(teamId)).then(
                            () => navigation.popToTop(),
                            (error: unknown) =>
                              Alert.alert(
                                "You're still in the team",
                                error instanceof Error ? error.message : undefined,
                              ),
                          ),
                      },
                    ],
                  ),
              },
            ],
          ]}
          style={styles.title}
        >
          <View style={styles.titleLine}>
            <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
              {name}
            </AppText>
            <Symbol name="chevron.down" size={11} tint={color.muted} weight="semibold" />
          </View>
        </NativeMenu>
      ),
    });
  }, [canInvite, coordinator, name, navigation, teamId]);

  if (session === null && team?.state === "update-server")
    return (
      <Screen>
        <View style={styles.center}>
          <Notice
            title="Team server needs an update"
            detail={team.detail ?? "Ask the team administrator to update the server."}
            tone="neutral"
          />
        </View>
      </Screen>
    );
  if (session === null && team?.state === "offline")
    return (
      <Screen>
        <View style={styles.center}>
          <Notice
            title="Team couldn't be reached"
            detail={team.detail ?? "Try again when you're connected."}
            tone="neutral"
          />
          <PrimaryButton
            label="Retry"
            onPress={() => {
              void teams.select(teamId);
            }}
          />
        </View>
      </Screen>
    );
  if (team?.state === "join")
    return (
      <Screen>
        <View style={styles.center}>
          <Notice
            title="Join this team"
            detail={team.detail ?? "Ask a team member for an invite."}
            tone="neutral"
          />
        </View>
      </Screen>
    );
  if (team !== null && team.state === "signed-out")
    return (
      <Screen>
        <View style={styles.center}>
          <Notice
            detail={
              team.detail ??
              `${name} is one of your teams. Sign in with your Opensteer Account to read it here; it keeps working when your computer is off.`
            }
            title={`Sign in to ${name}`}
            tone="neutral"
          />
          <PrimaryButton
            busy={signingIn}
            label="Sign in"
            onPress={() => {
              setSigningIn(true);
              void teams
                .addToPhone(teamId)
                .then(() => teams.select(teamId))
                .catch((error: unknown) =>
                  Alert.alert("Not signed in", error instanceof Error ? error.message : undefined),
                )
                .finally(() => setSigningIn(false));
            }}
            prominent
          />
        </View>
      </Screen>
    );
  if (session === null || sidebar === null)
    return (
      <Screen>
        <View style={styles.center}>
          {failure === null ? (
            <ActivityIndicator color={color.muted} />
          ) : (
            <Notice detail={failure} title={`${name} didn't answer`} tone="neutral" />
          )}
        </View>
      </Screen>
    );
  return (
    <Screen edgeToEdge>
      {banner === null ? null : <ConnectionBanner banner={banner} />}
      <TeamPageList
        canCreateChannel={session.getSnapshot().bootstrap?.can.createChannel === true}
        onBrowseChannels={() => navigation.navigate("TeamChannels", { teamId })}
        onLoadMore={() => {
          if (sidebar.nextCursor !== null) void session.loadMoreSidebar().catch(() => undefined);
        }}
        onNewChannel={() => navigation.navigate("TeamNewChannel", { teamId })}
        onNewMessage={() => navigation.navigate("TeamNewMessage", { teamId })}
        onOpenChannel={(channelId) => navigation.navigate("TeamChannel", { teamId, channelId })}
        onRemoveTeam={() => void teams.forget(teamId).then(() => navigation.popToTop())}
        paddingBottom={padding}
        section={drawerSection({
          teamId,
          name,
          state: team?.state ?? "loading",
          folded: false,
          sidebar,
        })}
      />
    </Screen>
  );
}

function useSidebar(session: TeamSessionClient | null): TeamSidebar | null {
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  const read = useCallback(() => session?.getSnapshot().sidebar ?? null, [session]);
  return useSyncExternalStore(subscribe, read, read);
}

const styles = StyleSheet.create({
  center: { flex: 1, gap: space[16], justifyContent: "center", padding: space[16] },
  title: { maxWidth: 240 },
  titleLine: { alignItems: "center", flexDirection: "row", gap: space[4] },
});
