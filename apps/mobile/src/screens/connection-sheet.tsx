import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import {
  clientIssueActions,
  presentClientIssue,
  presentConnectionDetail,
} from "@opensteer/client/feedback";
import { useClientConnection } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DeploymentMarkView } from "../threads/deployment-mark.js";
import { ConnectionDetails, type ConnectionDetailsSession } from "../ui/connection-details.js";
import { shellIssue, useShellGate } from "../ui/connection-live.js";
import { shellAction, useShellSessions, type ShellSession } from "../ui/connection-shell.js";

export type ConnectionSheetScreenProps = StaticScreenProps<{ readonly session: string }>;

/**
 * What the pill opens: which connection is in trouble, what is going on, and
 * the one thing to do. Its words change in place while it is open, and it
 * closes itself once that connection is back.
 */
export function ConnectionSheetScreen(props: ConnectionSheetScreenProps): ReactNode {
  const navigation = useNavigation();
  const sessions = useShellSessions();
  const session =
    sessions.find(({ key }) => key === props.route.params.session) ?? sessions[0] ?? null;
  useShellGate(true);
  useEffect(() => {
    if (session === null && navigation.canGoBack()) navigation.goBack();
  }, [navigation, session]);
  if (session === null) return null;
  return (
    <SessionDetails
      key={session.key}
      onSwitch={(key) => navigation.setParams({ session: key })}
      session={session}
      sessions={sessions}
    />
  );
}

function SessionDetails(props: {
  readonly session: ShellSession;
  readonly sessions: readonly ShellSession[];
  readonly onSwitch: (key: string) => void;
}): ReactNode {
  const { session } = props;
  const navigation = useNavigation();
  const state = useClientConnection(session.connection);
  const issue = shellIssue(state, session.connection);
  const recovered = issue === null;
  // Recovery closes the sheet: there is no "Connected" screen to read.
  useEffect(() => {
    if (recovered && navigation.canGoBack()) navigation.goBack();
  }, [navigation, recovered]);

  const others = useOtherTrouble(props.sessions, session.key, props.onSwitch);
  if (issue === null) return null;
  const words = presentConnectionDetail(issue, "phone");
  const action = shellAction(issue, session);
  return (
    <ConnectionDetails
      action={
        action === null
          ? null
          : {
              busy: action.kind === "retry" && state.trying,
              label:
                action.kind === "retry"
                  ? clientIssueActions.tryNow
                  : action.kind === "sign-in"
                    ? clientIssueActions.signIn
                    : clientIssueActions.update,
              onPress: action.run,
            }
      }
      explanation={words.detail ?? ""}
      mark={<DeploymentMarkView mark={session.mark} />}
      meta={connectionMeta(state)}
      name={session.name}
      others={others}
      state={words.title}
    />
  );
}

/** Each other session in trouble, as one row that switches the sheet to it. */
function useOtherTrouble(
  sessions: readonly ShellSession[],
  current: string,
  onSwitch: (key: string) => void,
): readonly ConnectionDetailsSession[] {
  const others = useMemo(() => sessions.filter(({ key }) => key !== current), [current, sessions]);
  const connections = useMemo(() => others.map(({ connection }) => connection), [others]);
  const states = useConnectionStates(connections);
  return others.flatMap((other, index) => {
    const state = states[index];
    const issue = state === undefined ? null : shellIssue(state, other.connection);
    return issue === null
      ? []
      : [
          {
            key: other.key,
            name: other.name,
            onPress: () => onSwitch(other.key),
            state: presentClientIssue(issue).title,
          },
        ];
  });
}

/** Several connections' states at once, re-rendering only when one of them changes. */
function useConnectionStates(
  connections: readonly ClientConnection[],
): readonly ClientConnectionState[] {
  const cache = useRef<readonly ClientConnectionState[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = connections.map((connection) => connection.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    [connections],
  );
  const read = useCallback(() => {
    const next = connections.map((connection) => connection.getSnapshot());
    const previous = cache.current;
    if (next.length === previous.length && next.every((state, index) => state === previous[index]))
      return previous;
    cache.current = next;
    return next;
  }, [connections]);
  return useSyncExternalStore(subscribe, read, read);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dayMs = 24 * 60 * 60 * 1000;

/** "Last connected 9:41 · via Connect": the time today, else the day; the route when known. */
export function connectionMeta(
  state: Pick<ClientConnectionState, "lastConnectedAt" | "route">,
  now = new Date(),
): string | null {
  const parts: string[] = [];
  if (state.lastConnectedAt !== null) {
    const at = new Date(state.lastConnectedAt);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    const when =
      day === today
        ? clock.format(at)
        : day === today - dayMs
          ? "yesterday"
          : today - day < 7 * dayMs
            ? weekday.format(at)
            : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    parts.push(`Last connected ${when}`);
  }
  if (state.route !== null)
    parts.push(
      state.route === "connect"
        ? "via Connect"
        : state.route === "private-network"
          ? "via your network"
          : "on this computer",
    );
  return parts.length === 0 ? null : parts.join(" · ");
}
