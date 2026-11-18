import type { ClientConnectionState } from "@opensteer/client/connections";
import {
  clientIssueActions,
  presentClientIssue,
  presentConnectionGate,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useNavigation } from "@react-navigation/native";
import { Fragment, useState, useSyncExternalStore, type ReactNode } from "react";
import { Linking } from "react-native";
import { TeamReferenceProvider } from "../markdown/reference-navigation.js";
import { ConnectionGate } from "../ui/connection-gate.js";
import { downloadPage } from "../ui/connection-live.js";
import { useShellGate } from "../ui/shell-gate.js";
import type { MobileTeam } from "./mobile-teams.js";
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
  const { team, snapshot } = useTeamSession(teamId);
  const state = team?.state;
  if (
    (state === "live" || state === "offline" || state === "failed" || state === "loading") &&
    snapshot.bootstrap
  )
    return team ? (
      <TeamReferenceProvider client={team.session} origin={team.origin} teamId={teamId}>
        {children}
      </TeamReferenceProvider>
    ) : (
      <Fragment>{children}</Fragment>
    );
  return <TeamGate team={team} teamId={teamId} />;
}

const noSubscribe = () => () => {};
const noState = () => null;

/**
 * The one explanation while a team screen has nothing to show: connecting is a
 * muted line, then the team's own state in the shared presenter's words.
 */
function TeamGate(props: { readonly team: MobileTeam | null; readonly teamId: string }): ReactNode {
  const { team, teamId } = props;
  const teams = useMobileTeams();
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  // The gate explains this team's connection; the pill would only repeat it.
  useShellGate(true);
  const connection = team?.session?.connection ?? null;
  const live = useSyncExternalStore(
    connection?.subscribe ?? noSubscribe,
    connection?.getSnapshot ?? noState,
    connection?.getSnapshot ?? noState,
  );
  const name = team?.name ?? null;
  const back = navigation.canGoBack()
    ? { label: "Back", onPress: () => navigation.goBack() }
    : null;
  const remove = {
    label: "Remove from this phone",
    onPress: () => void teams.forget(teamId).catch(() => undefined),
  };
  const attempt = (work: () => Promise<unknown>) => () => {
    setBusy(true);
    // What happened shows as the team's state, which redraws this gate.
    void work()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const state = team?.state ?? "loading";
  if (state === "join")
    return (
      <ConnectionGate
        detail="Ask a team member for a new invite."
        primary={remove}
        secondary={back}
        stateKey="join"
        symbol="signed-out"
        title="Join this team"
      />
    );
  const issue: ClientIssue | null =
    state === "removed"
      ? { code: "access-lost" }
      : state === "update-app" || state === "update-server"
        ? { code: state }
        : state === "signed-out"
          ? { code: "sign-in" }
          : state === "failed"
            ? { code: "open-failed" }
            : live?.showInterruption
              ? live.issue
              : state === "offline" && connection === null
                ? { code: "connection", reason: "unreachable" }
                : null;
  const copy =
    state === "removed"
      ? presentClientIssue({ code: "access-lost", target: "team", ...(name ? { name } : {}) })
      : presentConnectionGate({
          ...(live ?? connectingState),
          issue,
          showInterruption: issue !== null,
          name,
          target: "team",
        });
  const key = issue === null ? "connecting" : `${issue.code}:${issue.reason ?? ""}`;
  if (issue === null)
    return <ConnectionGate detail={copy.title} stateKey="connecting" symbol={null} title={null} />;
  const primary =
    copy.action === "sign-in"
      ? {
          label: clientIssueActions.signIn,
          busy,
          onPress: attempt(() => teams.addToPhone(teamId).then(() => teams.select(teamId))),
        }
      : copy.action === "update"
        ? { label: clientIssueActions.update, onPress: () => void Linking.openURL(downloadPage) }
        : copy.action === "retry" || issue.code === "connection" || issue.code === "update-server"
          ? {
              label: clientIssueActions.tryAgain,
              busy,
              onPress:
                connection === null || state === "failed"
                  ? attempt(() => teams.select(teamId))
                  : () => connection.retry(),
            }
          : state === "removed"
            ? (back ?? remove)
            : null;
  return (
    <ConnectionGate
      detail={copy.detail ?? ""}
      primary={primary}
      secondary={state === "removed" ? (back === null ? null : remove) : back}
      stateKey={key}
      symbol={
        issue.code === "connection"
          ? issue.reason === "offline"
            ? "offline"
            : "computer"
          : issue.code === "open-failed"
            ? "computer"
            : issue.code === "update-app" || issue.code === "update-server"
              ? "update"
              : "signed-out"
      }
      title={copy.title}
    />
  );
}

const connectingState: ClientConnectionState = {
  phase: "connecting",
  network: "unknown",
  visibility: "foreground",
  scope: null,
  epoch: 0,
  readyRevision: 0,
  showInterruption: false,
  issue: null,
  trying: true,
  pathRevision: 0,
  lastConnectedAt: null,
  name: null,
  target: "team",
  route: null,
};
