import { connectionNotice } from "@opensteer/client/connections";
import type { ClientConnectionState } from "@opensteer/client/connections";
import { clientIssueActions, presentClientIssue } from "@opensteer/client/feedback";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ConnectionPillNotice } from "../ui/connection-pill.js";
import type { MobileTeam, MobileTeams } from "./mobile-teams.js";

// The pill floats outside the navigator, so the teams owner is published here for it.
let published: MobileTeams | null = null;
const listeners = new Set<() => void>();
export function publishForegroundTeams(teams: MobileTeams | null): void {
  if (published === teams) return;
  published = teams;
  listeners.forEach((listener) => listener());
}
const subscribePublished = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const readPublished = () => published;
const noSubscribe = () => () => {};
const noState = () => null;

/**
 * What the pill says while a team screen is in front: that team's connection,
 * in the team's words. `undefined` when no team is in front, so the personal
 * pill speaks instead; null while the team is fine or its gate is explaining.
 */
export function useForegroundTeamNotice(): ConnectionPillNotice | null | undefined {
  const teams = useSyncExternalStore(subscribePublished, readPublished, readPublished);
  const subscribeTeams = useCallback(
    (listener: () => void) => teams?.subscribe(listener) ?? (() => {}),
    [teams],
  );
  const readTeam = useCallback(() => {
    const snapshot = teams?.getSnapshot();
    if (!snapshot || snapshot.selected === null) return null;
    return (
      snapshot.teams.find((team) => team.teamId === snapshot.selected) ??
      snapshot.unlinked.find((team) => team.teamId === snapshot.selected) ??
      null
    );
  }, [teams]);
  const team = useSyncExternalStore(subscribeTeams, readTeam, readTeam);
  const connection = team?.session?.connection ?? null;
  const state = useSyncExternalStore(
    connection?.subscribe ?? noSubscribe,
    connection?.getSnapshot ?? noState,
    connection?.getSnapshot ?? noState,
  );
  const bootstrapped = team?.session?.getSnapshot().bootstrap != null;
  return useMemo(() => {
    if (team === null || teams === null) return undefined;
    return teamPillNotice(team, state, bootstrapped, {
      retry: () => connection?.retry(),
      signIn: () =>
        void teams
          .addToPhone(team.teamId)
          .then(() => teams.select(team.teamId))
          .catch(() => undefined),
    });
  }, [bootstrapped, connection, state, team, teams]);
}

/**
 * The foreground team's pill. A team whose screen is gated (signed out,
 * removed, an update or nothing loaded) says nothing here: the gate explains.
 */
export function teamPillNotice(
  team: Pick<MobileTeam, "name" | "state">,
  state: ClientConnectionState | null,
  bootstrapped: boolean,
  actions: { readonly retry: () => void; readonly signIn: () => void },
): ConnectionPillNotice | null {
  const shown =
    bootstrapped && (team.state === "live" || team.state === "offline" || team.state === "loading");
  if (!shown || state === null) return null;
  const issue = connectionNotice(state);
  if (issue === null) return null;
  const copy = presentClientIssue({ ...issue, name: team.name, target: "team" });
  return {
    key: `${issue.code}:${issue.reason ?? ""}`,
    label: copy.title,
    tone: issue.code === "connection" ? "muted" : "amber",
    trying: state.trying,
    action:
      copy.action === "retry"
        ? {
            label: clientIssueActions.retry,
            accessibilityLabel: "Try connecting now",
            onPress: actions.retry,
          }
        : copy.action === "sign-in"
          ? { label: clientIssueActions.signIn, onPress: actions.signIn }
          : null,
  };
}
