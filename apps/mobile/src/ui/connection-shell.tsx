import type { ClientConnection } from "@opensteer/client/connections";
import {
  clientIssueActions,
  presentClientIssue,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useClientConnection } from "@opensteer/client/react";
import { useCallback, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Linking } from "react-native";
import type { MobileClient } from "../client/mobile-client.js";
import { navigationRef } from "../navigation-ref.js";
import { runDeploymentRecovery } from "../screens/deployment-recovery.js";
import { deploymentMark, type DeploymentMark } from "../threads/deployment-identity.js";
import { ConnectionPillView, type ConnectionPillNotice } from "./connection-pill.js";
import { useMobileClient, useMobileState } from "./mobile-client-context.js";
import {
  connectionIssueKey,
  downloadPage,
  retryConnection,
  shellIssue,
} from "./connection-live.js";
import { gated, subscribeGates } from "./shell-gate.js";

/**
 * The shell's one voice for each connection the person is using: the pill,
 * the details sheet and the app's gates read a session's connection here and
 * nowhere else, and only ask it to recover. Screens never do.
 */

/** The connection the shell speaks for: the open computer. */
export interface ShellSession {
  readonly key: "tasks";
  readonly name: string;
  readonly mark: DeploymentMark;
  readonly connection: ClientConnection;
  readonly signIn: () => Promise<void>;
}

/** The open computer's session, when there is one. */
export function useShellSessions(): readonly ShellSession[] {
  const client = useMobileClient();
  const { selection } = useMobileState();
  const personal = selection.session?.connection ?? null;
  const row = selection.row;
  return useMemo(() => {
    const sessions: ShellSession[] = [];
    if (personal !== null && row !== null)
      sessions.push({
        connection: personal,
        key: "tasks",
        mark: deploymentMark(row),
        name: row.name,
        signIn: () => signInPersonal(client, row.deploymentId),
      });
    return sessions;
  }, [client, personal, row]);
}

async function signInPersonal(client: MobileClient, deploymentId: string): Promise<void> {
  const row = client.getSnapshot().rows.find((each) => each.deploymentId === deploymentId);
  if (row === undefined) return;
  await runDeploymentRecovery(client, { navigate: (route) => navigateTo(route) }, row);
}

function navigateTo(route: "AddPersonal"): void {
  if (navigationRef.isReady()) navigationRef.navigate(route);
}

/** What the person can do from the pill or the sheet about one issue. */
export function shellAction(
  issue: ClientIssue,
  session: ShellSession,
): { readonly kind: "retry" | "sign-in" | "update"; readonly run: () => void } | null {
  const action = presentClientIssue(issue).action;
  if (action === "retry") return { kind: "retry", run: () => retryConnection(session.connection) };
  if (action === "sign-in")
    return { kind: "sign-in", run: () => void session.signIn().catch(() => undefined) };
  if (action === "update") return { kind: "update", run: () => void Linking.openURL(downloadPage) };
  return null;
}

const amberCodes = new Set<ClientIssue["code"]>([
  "sign-in",
  "update-app",
  "update-server",
  "web-outdated",
  "access-lost",
]);

/** The pill for the open computer's session. */
export function ConnectionPill(): ReactNode {
  const sessions = useShellSessions();
  const session = sessions[0] ?? null;
  const isGated = useSyncExternalStore(subscribeGates, gated, gated);
  if (session === null) return null;
  return <SessionPill gated={isGated} key={session.key} session={session} />;
}

function SessionPill(props: { readonly session: ShellSession; readonly gated: boolean }) {
  const { session } = props;
  const state = useClientConnection(session.connection);
  const issue = shellIssue(state, session.connection);
  const key = issue === null ? null : connectionIssueKey(issue);
  const words = issue === null ? null : presentClientIssue(issue);
  const label = words?.title ?? null;
  const actionKind =
    issue === null || words?.action === null ? null : (shellAction(issue, session)?.kind ?? null);
  const amber = issue !== null && amberCodes.has(issue.code);
  const trying = state.trying;
  const notice = useMemo<ConnectionPillNotice | null>(() => {
    if (key === null || label === null) return null;
    return {
      action: actionKind === null ? null : pillAction(actionKind, session),
      key,
      label,
      tone: amber ? "amber" : "muted",
      trying,
    };
  }, [actionKind, amber, key, label, session, trying]);
  const sessionKey = useRef(session.key);
  sessionKey.current = session.key;
  const openDetails = useCallback(() => {
    if (navigationRef.isReady())
      navigationRef.navigate("ConnectionDetails", { session: sessionKey.current });
  }, []);
  return <ConnectionPillView gated={props.gated} notice={notice} onOpenDetails={openDetails} />;
}

function pillAction(
  kind: "retry" | "sign-in" | "update",
  session: ShellSession,
): ConnectionPillNotice["action"] {
  if (kind === "retry")
    return {
      accessibilityLabel: "Try connecting now",
      label: clientIssueActions.retry,
      onPress: () => retryConnection(session.connection),
    };
  if (kind === "sign-in")
    return {
      label: clientIssueActions.signIn,
      onPress: () => void session.signIn().catch(() => undefined),
    };
  return { label: clientIssueActions.update, onPress: () => void Linking.openURL(downloadPage) };
}
