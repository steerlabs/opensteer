import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import {
  clientIssueActions,
  presentConnectionGate,
  type ClientIssue,
  type ClientIssuePresentation,
} from "@opensteer/client/feedback";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { Linking } from "react-native";
import {
  ConnectionGate,
  type ConnectionGateButton,
  type ConnectionGateSymbol,
} from "./connection-gate.js";
import {
  connectionIssueKey,
  downloadPage,
  retryConnection,
  shellIssue,
} from "./connection-live.js";
import { useShellGate } from "./shell-gate.js";

/** Before a connection exists: connecting, quietly, to a computer not yet named. */
const unstarted: ClientConnectionState = {
  epoch: 0,
  issue: null,
  lastConnectedAt: null,
  name: null,
  network: "unknown",
  pathRevision: 0,
  phase: "idle",
  readyRevision: 0,
  route: null,
  scope: null,
  showInterruption: false,
  target: "computer",
  trying: false,
  visibility: "foreground",
};
const noSubscribe = () => () => undefined;

/**
 * The single explanation for a route with nothing usable to show: what the
 * connection is doing, in the gate's words, and the one way on. The pill
 * steps aside while it is up. `issue` is a fact the app already holds about
 * this computer (a sign-in owed, a version refused) and wins over the
 * connection's own state; `signIn` is the door that sign-in opens.
 */
export function ConnectionRouteGate(props: {
  readonly connection: ClientConnection | null;
  readonly name?: string | null;
  readonly issue?: ClientIssue | null;
  readonly signIn?: ConnectionGateButton | null;
  readonly secondary?: ConnectionGateButton | null;
  /** What the last tap on the gate's own button came to, in place of its detail. */
  readonly line?: string | null;
}): ReactNode {
  const { connection } = props;
  const read = useCallback(() => connection?.getSnapshot() ?? unstarted, [connection]);
  const state = useSyncExternalStore(connection?.subscribe ?? noSubscribe, read, read);
  useShellGate(true);
  const issue = props.issue ?? (connection === null ? null : shellIssue(state, connection)) ?? null;
  const name = state.name ?? props.name ?? null;
  const words = presentConnectionGate({ ...state, issue, name, showInterruption: issue !== null });
  if (issue === null)
    return <ConnectionGate detail={words.title} stateKey="connecting" symbol={null} title={null} />;
  return (
    <ConnectionGate
      detail={props.line ?? words.detail ?? ""}
      primary={primaryButton(issue, words.action, connection, state.trying, props.signIn ?? null)}
      secondary={props.secondary ?? null}
      stateKey={`${state.phase}:${connectionIssueKey(issue)}`}
      symbol={gateSymbol(issue)}
      title={words.title}
    />
  );
}

function gateSymbol(issue: ClientIssue): ConnectionGateSymbol {
  if (issue.code === "connection") return issue.reason === "offline" ? "offline" : "computer";
  if (issue.code === "sign-in") return "signed-out";
  if (issue.code === "update-app" || issue.code === "update-server") return "update";
  return "computer";
}

function primaryButton(
  issue: ClientIssue,
  action: ClientIssuePresentation["action"],
  connection: ClientConnection | null,
  trying: boolean,
  signIn: ConnectionGateButton | null,
): ConnectionGateButton | null {
  if (action === "sign-in") return signIn;
  if (action === "update")
    return { label: clientIssueActions.update, onPress: () => void Linking.openURL(downloadPage) };
  if ((action === "retry" || issue.code === "update-server") && connection !== null)
    return {
      busy: trying,
      label: clientIssueActions.tryAgain,
      onPress: () => retryConnection(connection),
    };
  return null;
}
