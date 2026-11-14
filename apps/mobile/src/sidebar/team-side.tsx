import type { TeamSessionSnapshot } from "@opensteer/client/team";
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import type { MobileTeam } from "../team/mobile-teams.js";
import { useMobileTeams } from "../team/team-context.js";
import { TeamPageList } from "../team/team-page-list.js";
import { drawerSection } from "../team/team-views.js";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** A team place the sidebar opens. The shell decides whether it is top-level or presented. */
export type TeamPlace =
  | { readonly name: "TeamChannel"; readonly params: { teamId: string; channelId: string } }
  | {
      readonly name:
        | "TeamChannels"
        | "TeamInvites"
        | "TeamKnowledge"
        | "TeamNewChannel"
        | "TeamNewMessage"
        | "TeamSearch"
        | "TeamSettings";
      readonly params: { teamId: string };
    };

/**
 * One team's side of the sidebar: its knowledge, channels and direct messages,
 * painted from the team's last answer. A team that can't be read says why, with
 * the one thing that helps, above whatever it last showed.
 */
export function TeamSide(props: {
  readonly team: MobileTeam;
  readonly onOpen: (place: TeamPlace) => void;
  /** The channel or DM in front, marked as the one open. */
  readonly openChannelId: string | null;
  readonly paddingBottom: number;
}): ReactNode {
  const { team, onOpen } = props;
  const teamId = team.teamId;
  const sidebar = useSessionValue(team, readSidebar);
  const canCreateChannel = useSessionValue(team, readCanCreateChannel);
  const section = useMemo(
    () => (sidebar === null ? null : drawerSection({ teamId, name: team.name, sidebar })),
    [sidebar, team.name, teamId],
  );
  const session = team.session;
  const go = useCallback(
    (name: Exclude<TeamPlace["name"], "TeamChannel">) => () => onOpen({ name, params: { teamId } }),
    [onOpen, teamId],
  );
  const openChannel = useCallback(
    (channelId: string) => onOpen({ name: "TeamChannel", params: { teamId, channelId } }),
    [onOpen, teamId],
  );
  const loadMore = useCallback(() => {
    if (session?.getSnapshot().sidebar?.nextCursor != null)
      void session.loadMoreSidebar().catch(() => undefined);
  }, [session]);

  return (
    <View style={styles.side}>
      <TeamNotice team={team} />
      {section === null ? (
        team.state === "loading" || team.state === "live" ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : null
      ) : (
        <TeamPageList
          canCreateChannel={canCreateChannel}
          onBrowseChannels={go("TeamChannels")}
          onKnowledge={go("TeamKnowledge")}
          onLoadMore={loadMore}
          onNewChannel={go("TeamNewChannel")}
          onNewMessage={go("TeamNewMessage")}
          onOpenChannel={openChannel}
          openChannelId={props.openChannelId}
          paddingBottom={props.paddingBottom}
          section={section}
        />
      )}
    </View>
  );
}

/** Why a team can't be read right now, and the one thing that helps. Nothing while it can. */
function TeamNotice(props: { readonly team: MobileTeam }): ReactNode {
  const { team } = props;
  const teams = useMobileTeams();
  const [busy, setBusy] = useState(false);
  const notice = noticeFor(team);
  if (notice === null) return null;
  const act = (): void => {
    setBusy(true);
    const work =
      notice.action === "sign-in"
        ? teams.addToPhone(team.teamId).then(() => teams.refresh(team.teamId, true))
        : notice.action === "retry"
          ? teams.refresh(team.teamId, true)
          : teams.forget(team.teamId);
    void work
      .catch((error: unknown) =>
        Alert.alert(
          notice.action === "sign-in" ? "Not signed in" : `${team.name} didn't answer`,
          error instanceof Error ? error.message : undefined,
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View accessibilityLiveRegion="polite" style={styles.notice}>
      <View style={styles.noticeWords}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium">
          {notice.title}
        </AppText>
        {notice.detail === null ? null : (
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
            {notice.detail}
          </AppText>
        )}
      </View>
      {notice.action === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy }}
          disabled={busy}
          onPress={act}
          style={({ pressed }) => [styles.noticeAction, pressed && styles.pressed]}
        >
          {busy ? (
            <ActivityIndicator color={color.muted} size="small" />
          ) : (
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="caption"
              style={styles.noticeActionLabel}
            >
              {notice.action === "sign-in"
                ? "Sign in"
                : notice.action === "retry"
                  ? "Try again"
                  : "Remove"}
            </AppText>
          )}
        </Pressable>
      )}
    </View>
  );
}

function noticeFor(team: MobileTeam): {
  readonly title: string;
  readonly detail: string | null;
  readonly action: "sign-in" | "retry" | "remove" | null;
} | null {
  switch (team.state) {
    case "live":
    case "loading":
      return null;
    case "offline":
      return { title: `Can't reach ${team.name}`, detail: null, action: "retry" };
    case "signed-out":
      return {
        title: `Sign in to ${team.name}`,
        detail: "It keeps working when your computer is off.",
        action: "sign-in",
      };
    case "update-app":
      return { title: "Update Opensteer", detail: `to keep using ${team.name}`, action: null };
    case "update-server":
      return {
        title: `${team.name} needs an update`,
        detail: "Ask its administrator to update the server.",
        action: null,
      };
    case "removed":
    case "join":
      return {
        title: `You're no longer in ${team.name}`,
        detail: "Tasks it started stay in your list.",
        action: "remove",
      };
  }
}

const readSidebar = (snapshot: TeamSessionSnapshot | null) => snapshot?.sidebar ?? null;
const readCanCreateChannel = (snapshot: TeamSessionSnapshot | null) =>
  snapshot?.bootstrap?.can.createChannel === true;

/**
 * One value of a team's session, redrawn only when that value changes: a typing
 * frame or a streamed message elsewhere in the team leaves the sidebar alone.
 */
function useSessionValue<T>(
  team: MobileTeam | null,
  select: (snapshot: TeamSessionSnapshot | null) => T,
): T {
  const session = team?.session ?? null;
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  const read = useCallback(() => select(session?.getSnapshot() ?? null), [select, session]);
  return useSyncExternalStore(subscribe, read, read);
}

const styles = StyleSheet.create({
  loading: { alignItems: "flex-start", paddingHorizontal: space[20], paddingVertical: space[12] },
  notice: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    marginBottom: space[4],
    marginHorizontal: space[8],
    paddingLeft: space[12],
    paddingVertical: space[8],
  },
  noticeAction: {
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space[12],
  },
  noticeActionLabel: { color: color.ember, fontWeight: "700" },
  noticeWords: { flex: 1, gap: space[2], minWidth: 0 },
  pressed: { ...material.quiet },
  side: { flex: 1 },
});
