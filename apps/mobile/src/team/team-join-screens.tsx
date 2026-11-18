import { HostVersionMismatchError } from "@opensteer/client/connections";
import { unwrapRpcResult, type HostSnapshot } from "@opensteer/client/host";
import { DeploymentIdSchema } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useEffect, useState, type ReactNode } from "react";
import { AppState, StyleSheet, TextInput, View } from "react-native";
import { teamPlaceTarget } from "../links.js";
import { useAppLinks } from "../ui/app-links-context.js";
import { enterSide } from "../navigation-ref.js";
import type { RootParamList } from "../navigation.js";
import { color, radius, space, type } from "../theme.js";
import {
  useHostValue,
  useMobileClient,
  useMobileState,
  useSelectedHostClient,
} from "../ui/mobile-client-context.js";
import { AppText, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { ConnectOpensteerBody, JoinSheetBody, type ConnectView, type InviteView } from "./join.js";
import type { TeamTileView } from "./team-models.js";
import {
  readTeamLinkIntent,
  TeamAccessError,
  teamFailure,
  type TeamLinkIntent,
} from "./mobile-teams.js";
import { classifyClientFailure, clientEndpointUnavailable } from "@opensteer/client/connections";
import {
  clientIssueActions,
  clientIssueFromFailure,
  presentClientIssue,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { ConnectionGate } from "../ui/connection-gate.js";
import { useShellGate } from "../ui/shell-gate.js";
import { UnavailableState } from "../ui/unavailable-state.js";
import { teamFailureWords } from "./team-feedback.js";
import { useCoordinatorSnapshot, useMobileTeams, useTeam, useTeamEntry } from "./team-context.js";
import { openTeamGeneral } from "./mobile-team-entry.js";

type Navigation = NativeStackNavigationProp<RootParamList>;
type InviteState = InviteView | { readonly kind: "unreachable" };
const selectNetwork = (snapshot: HostSnapshot) => snapshot.network;

/** Where getting Opensteer for a computer starts. */
const downloadPage = "https://opensteer.com/download";

/**
 * A team link the person opened, pasted or tapped in a notification: an
 * invite, a channel or message, or a one-time code that connects their own
 * Opensteer. Without a link it is the paste field Settings and Welcome open.
 */
export function JoinTeamScreen(
  props: StaticScreenProps<
    { readonly link?: string | undefined; readonly externalIntent?: number | undefined } | undefined
  >,
): ReactNode {
  const [link, setLink] = useState<string | null>(props.route.params?.link ?? null);
  const externalIntent =
    link === props.route.params?.link ? props.route.params?.externalIntent : undefined;
  if (link === null) return <PasteLink onLink={setLink} />;
  const intent = readTeamLinkIntent(link);
  if (intent === null)
    return (
      <PasteLink
        failure="That isn't a team link. Copy the whole link and try again."
        onLink={setLink}
      />
    );
  return <FollowLink externalIntent={externalIntent} intent={intent} key={link} link={link} />;
}

function PasteLink(props: {
  readonly failure?: string;
  readonly onLink: (link: string) => void;
}): ReactNode {
  const navigation = useNavigation<Navigation>();
  const [text, setText] = useState("");
  return (
    <View style={styles.sheet}>
      <AppText role="displaySmall">Join a team</AppText>
      <AppText role="secondary" tone="muted">
        Paste the invite link someone sent you.
      </AppText>
      <TextInput
        accessibilityLabel="Invite link"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        inputMode="url"
        onChangeText={setText}
        onSubmitEditing={() => text.trim() !== "" && props.onLink(text.trim())}
        placeholder="https://acme.teams.opensteer.com/invite/…"
        placeholderTextColor={color.muted}
        returnKeyType="go"
        selectionColor={color.ember}
        style={styles.field}
        value={text}
      />
      {props.failure === undefined ? null : (
        <AppText role="secondary" tone="danger">
          {props.failure}
        </AppText>
      )}
      <PrimaryButton
        disabled={text.trim() === ""}
        label="Join"
        onPress={() => props.onLink(text.trim())}
        prominent
      />
      <SecondaryButton
        label="Create a team instead"
        onPress={() => navigation.replace("CreateTeam")}
      />
    </View>
  );
}

function FollowLink(props: {
  readonly externalIntent: number | undefined;
  readonly intent: TeamLinkIntent;
  readonly link: string;
}): ReactNode {
  const { intent } = props;
  if (intent.kind === "invite") return <Invite intent={intent} link={props.link} />;
  if (intent.kind === "agent-link") return <AgentLink intent={intent} />;
  return <OpenPlace externalIntent={props.externalIntent} intent={intent} />;
}

/**
 * One confirmation, then the team: the coordinator gets a session, admits the
 * reader with the invite, connects their agent (or waits for their computer)
 * and opens #general.
 */
function Invite(props: {
  readonly intent: Extract<TeamLinkIntent, { kind: "invite" }>;
  readonly link: string;
}): ReactNode {
  const { intent } = props;
  const navigation = useNavigation<Navigation>();
  const client = useMobileClient();
  const { coordinator } = useTeamEntry();
  const teams = useMobileTeams();
  const state = useMobileState();
  const host = new URL(intent.origin).host;
  // The computer in front joins unless the person picks another; its agent is the one asked.
  const shown = state.selection.deploymentId;
  const [computerId, setComputerId] = useState<string | null>(shown);
  const computers = state.rows.map((row) => ({ id: row.deploymentId, name: row.name }));
  const joinAs = state.account.account.identity?.email ?? "your Opensteer Account";
  const [invite, setInvite] = useState<InviteState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const tile = (name: string) => ({ id: intent.origin, name, imageUri: null });
  const network = useHostValue(state.selection.hostClient, selectNetwork, "unknown");
  useShellGate(invite.kind === "unreachable");

  useEffect(() => {
    let current = true;
    setInvite({ kind: "checking" });
    const held = teams.teamAt(intent.origin);
    if (held !== null && held.state === "live") {
      setInvite({ kind: "already-member", team: tile(held.name) });
      return;
    }
    void coordinator.previewInvite(props.link).then(
      (preview) =>
        current &&
        setInvite({
          kind: "ready",
          team: tile(preview.teamName ?? host),
          host,
          inviter: null,
          joinAs,
          joining: false,
          computers: [],
          computerId: null,
        }),
      (error: unknown) => current && setInvite(inviteFailure(error, tile(host))),
    );
    return () => {
      current = false;
    };
    // `tile` and `joinAs` are words; the lookup depends on the link and a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, coordinator, intent.origin, props.link, teams]);

  // An older team has the person join in the browser; coming back to the app continues.
  const inBrowser = useCoordinatorSnapshot().joiningInBrowser === intent.origin;
  useEffect(() => {
    if (!inBrowser) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") coordinator.continueJoinInBrowser();
    });
    return () => subscription.remove();
  }, [coordinator, inBrowser]);

  const retry = () => setAttempt((count) => count + 1);
  if (invite.kind === "unreachable")
    return (
      <OpenPlaceGate
        failure={{ code: "connection", target: "team", reason: "unreachable" }}
        network={network}
        onBack={() => navigation.goBack()}
        onRetry={retry}
      />
    );

  const shownInvite: InviteView =
    invite.kind === "ready"
      ? inBrowser
        ? { kind: "in-browser", team: invite.team }
        : { ...invite, computers, computerId }
      : invite;

  return (
    <JoinSheetBody
      invite={shownInvite}
      onChooseComputer={setComputerId}
      onClose={() => {
        if (inBrowser) coordinator.cancelJoinInBrowser();
        navigation.goBack();
      }}
      onContinue={() => coordinator.continueJoinInBrowser()}
      onJoin={() => {
        if (invite.kind !== "ready") return;
        setInvite({ ...invite, joining: true });
        const movedTo = computerId !== null && computerId !== shown ? computerId : null;
        void (movedTo === null ? Promise.resolve() : client.select(movedTo))
          .then(() =>
            coordinator.joinWithInvite({
              inviteUrl: props.link,
              // A person with no computer joins to chat; no agent connects.
              personalDeploymentId:
                computerId === null ? null : DeploymentIdSchema.parse(computerId),
            }),
          )
          .catch((error: unknown) => setInvite(inviteFailure(error, invite.team)));
      }}
      onOpenTeam={() => {
        const team = teams.teamAt(intent.origin);
        if (team !== null)
          void openTeamGeneral(client, teams, DeploymentIdSchema.parse(team.teamId));
      }}
      onRetry={retry}
      onUpdate={() => void Linking.openURL(downloadPage)}
    />
  );
}

function inviteFailure(error: unknown, team: TeamTileView): InviteState {
  if (error instanceof HostVersionMismatchError)
    return { kind: error.code === "client-too-old" ? "update-app" : "update-server", team };
  const failure = classifyClientFailure(error);
  const { reason } = failure;
  if (
    reason === "invite-invalid" ||
    reason === "invite-expired" ||
    reason === "invite-used-up" ||
    (failure.kind === "rejection" && ["not_found", "forbidden", "conflict"].includes(failure.code))
  )
    return { kind: "no-longer-works", team, inviter: null };
  if (clientEndpointUnavailable(failure)) return { kind: "unreachable" };
  const state = teamFailure(error);
  if (state === "update-app" || state === "update-server") return { kind: state, team };
  return { kind: "failed", detail: teamFailureWords(error, "Joining didn't finish.") };
}

/** A team page, opened once the team says the reader may see it. */
function OpenPlace(props: {
  readonly externalIntent: number | undefined;
  readonly intent: Exclude<TeamLinkIntent, { kind: "invite" | "agent-link" }>;
}): ReactNode {
  const { externalIntent, intent } = props;
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const { captureNavigationIntent } = useAppLinks();
  const [failure, setFailure] = useState<ClientIssue | null>(null);
  useShellGate(true);
  const network = useHostValue(useSelectedHostClient(), selectNetwork, "unknown");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    const intentCurrent = captureNavigationIntent(externalIntent);
    // A newer link that doesn't replace the stack (a Connect code) must not leave this sheet spinning.
    const current = (): boolean => {
      if (!mounted) return false;
      if (intentCurrent()) return true;
      mounted = false;
      navigation.goBack();
      return false;
    };
    setFailure(null);
    const open = async () => {
      const located = await teams.locate(intent.origin);
      if (!current()) return;
      let teamId: string;
      if (located.kind === "held") {
        teamId = located.team.teamId;
        if (located.team.state === "signed-out")
          await teams.signIn(await teams.verifyTeam(intent.origin), null);
      } else {
        await teams.signIn(located.verified, null);
        teamId = located.verified.discovery.deploymentId;
      }
      if (!current()) return;
      enterSide(teamPlaceTarget(teamId, intent));
    };
    void open().catch((error: unknown) => {
      if (!current()) return;
      const failure = classifyClientFailure(error);
      const issue = clientIssueFromFailure(failure, { operation: "read", label: "this page" });
      if (error instanceof TeamAccessError || issue?.code === "access-lost")
        setFailure({ code: "access-lost" });
      else if (clientEndpointUnavailable(failure))
        setFailure({ code: "connection", target: "team", reason: "unreachable" });
      else
        setFailure(
          issue?.code === "read-failed" || issue === null
            ? { code: "open-failed", resource: "this page" }
            : { ...issue, target: "team" },
        );
    });
    return () => {
      mounted = false;
    };
  }, [attempt, captureNavigationIntent, externalIntent, intent, navigation, teams]);
  return failure === null ? (
    <View style={styles.sheet}>
      <AppText role="secondary" tone="muted">
        Opening…
      </AppText>
    </View>
  ) : (
    <OpenPlaceGate
      failure={failure}
      network={network}
      onBack={() => navigation.goBack()}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
}

function OpenPlaceGate(props: {
  readonly failure: ClientIssue;
  readonly network: HostSnapshot["network"];
  readonly onBack: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  const back = { label: "Back", onPress: props.onBack };
  if (props.failure.code === "access-lost") return <UnavailableState onBack={props.onBack} />;
  const issue =
    props.failure.code === "connection" && props.network === "offline"
      ? { ...props.failure, reason: "offline" }
      : props.failure;
  const copy = presentClientIssue(issue);
  const primary =
    copy.action === "update"
      ? { label: clientIssueActions.update, onPress: () => void Linking.openURL(downloadPage) }
      : copy.action === "sign-in"
        ? { label: clientIssueActions.signIn, onPress: props.onRetry }
        : issue.code === "connection" || copy.action === "retry"
          ? { label: clientIssueActions.tryAgain, onPress: props.onRetry }
          : null;
  return (
    <ConnectionGate
      detail={copy.detail ?? ""}
      primary={primary ?? back}
      secondary={primary ? back : null}
      stateKey={`${issue.code}:${issue.reason ?? ""}`}
      symbol={issue.reason === "offline" ? "offline" : "computer"}
      title={copy.title}
    />
  );
}

/** A code a team's web page made, carried to the reader's own Opensteer. */
function AgentLink(props: {
  readonly intent: Extract<TeamLinkIntent, { kind: "agent-link" }>;
}): ReactNode {
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const personal = useMobileState().selection.hostClient;
  const [state, setState] = useState<
    | { readonly kind: "ready" }
    | { readonly kind: "linking" }
    | { readonly kind: "linked"; readonly team: string }
    | { readonly kind: "failed"; readonly detail: string }
  >({ kind: "ready" });
  if (personal === null)
    return (
      <ConnectOpensteerBody
        connect={{
          kind: "no-computer",
          team: {
            id: props.intent.origin,
            name: new URL(props.intent.origin).host,
            imageUri: null,
          },
        }}
        onClose={() => navigation.goBack()}
        onConnect={() => undefined}
        onGetOpensteer={() => void Linking.openURL(downloadPage)}
      />
    );
  return (
    <View style={styles.sheet}>
      <AppText role="displaySmall">Connect your Opensteer</AppText>
      <AppText role="secondary" tone="muted">
        {state.kind === "linked"
          ? `Your agent is connected to ${state.team}. Ask it there with Ask my agent.`
          : `This connects the Opensteer this phone is using to ${new URL(props.intent.origin).host}, so you can ask your agent there. Its tasks stay on your computer.`}
      </AppText>
      {state.kind === "failed" ? (
        <AppText role="secondary" tone="danger">
          {state.detail}
        </AppText>
      ) : null}
      {state.kind === "linked" ? (
        <PrimaryButton label="Done" onPress={() => navigation.goBack()} prominent />
      ) : (
        <PrimaryButton
          busy={state.kind === "linking"}
          label="Connect"
          onPress={() => {
            setState({ kind: "linking" });
            void teams.redeem(props.intent.text, personal).then(
              (team) => setState({ kind: "linked", team }),
              (error: unknown) =>
                setState({
                  kind: "failed",
                  detail: teamFailureWords(error, "Your Opensteer couldn't connect."),
                }),
            );
          }}
          prominent
        />
      )}
      <SecondaryButton label="Not now" onPress={() => navigation.goBack()} />
    </View>
  );
}

/**
 * "Connect your Opensteer": what asking your agent in a team needs. A person
 * with no computer of their own can still chat; their agent has nowhere to run.
 */
export function ConnectOpensteerScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const teams = useMobileTeams();
  const { coordinator } = useTeamEntry();
  const team = useTeam(teamId);
  const client = useMobileClient();
  const state = useMobileState();
  const personal = state.selection.hostClient;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void teams
      .session(teamId)
      .then(async (session) => {
        const links = unwrapRpcResult(await session.rpc["team.links.list"]({})).links;
        const me = session.getSnapshot().bootstrap?.member.userId;
        const active = links.find(
          (link) =>
            link.ownerUserId === me &&
            link.state === "active" &&
            link.personalDeploymentId !== client.getSnapshot().selection.deploymentId,
        );
        if (current) setElsewhere(active?.installationLabel ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, teamId, teams]);
  const tile = { id: teamId, name: team?.name ?? "this team", imageUri: null };
  const row = state.selection.row;
  const connect: ConnectView =
    personal === null || row === null
      ? { kind: "no-computer", team: tile }
      : {
          kind: "choose",
          team: tile,
          computers: [{ id: row.deploymentId, name: row.name }],
          connectedElsewhere: elsewhere,
          connecting,
          failure,
        };
  return (
    <ConnectOpensteerBody
      connect={connect}
      onClose={() => navigation.goBack()}
      onConnect={(computerId) => {
        if (personal === null || team === null) return;
        setConnecting(computerId);
        setFailure(null);
        void coordinator
          .connectAgent({
            teamDeploymentId: DeploymentIdSchema.parse(teamId),
            origin: team.origin,
            personalDeploymentId: DeploymentIdSchema.parse(computerId),
          })
          .then(
            (intent) => {
              if (intent.state === "connected") navigation.goBack();
              else {
                setConnecting(null);
                setFailure(
                  intent.state === "pending-offline"
                    ? "Your agent will connect when your computer is online."
                    : (intent.failure ?? "Your Opensteer couldn't connect."),
                );
              }
            },
            (error: unknown) => {
              setConnecting(null);
              setFailure(teamFailureWords(error, "Your Opensteer couldn't connect."));
            },
          );
      }}
      onGetOpensteer={() => void Linking.openURL(downloadPage)}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    ...type.body,
    backgroundColor: color.surfaceElevated,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    color: color.text,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  sheet: { gap: space[14], padding: space[20] },
});
