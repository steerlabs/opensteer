import {
  connectionNotice,
  showsClientLive,
  type ClientConnection,
  type ClientConnectionState,
} from "@opensteer/client/connections";
import {
  clientDisplayName,
  clientIssueActions,
  presentClientIssue,
  presentConnectionDetail,
  presentConnectionGate,
  presentConnectionStarting,
  type ClientIssue,
} from "@opensteer/client/feedback";
import { useClientConnection } from "@opensteer/client/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ConnectionGate, type ConnectionGateButton } from "./connection-gate.js";
import {
  ConnectionPill,
  type ConnectionDetailsProps,
  type ConnectionPillNotice,
} from "./connection-pill.js";
import { Icon } from "./icon.js";

/**
 * The shell's adapters between a session's connection and the one place that
 * speaks about it: the pill over the main column, or a gate while there is
 * nothing to show. Screens never read connection notices themselves.
 */

/** One connection the person is using, with what its words act on. */
export interface ShellConnectionSource {
  readonly key: string;
  readonly connection: ClientConnection;
  readonly mark: "desktop" | "server" | "users";
  readonly onSignIn?: (() => void) | undefined;
  readonly onUpdate?: (() => void) | undefined;
}

const amberCodes = new Set<ClientIssue["code"]>([
  "sign-in",
  "update-app",
  "update-server",
  "web-outdated",
  "access-lost",
]);

/** What the pill says about one connection, or null while there is nothing to say. */
function pillNotice(
  state: ClientConnectionState,
  source: ShellConnectionSource,
): ConnectionPillNotice | null {
  const issue = connectionNotice(state);
  if (issue === null) return null;
  const said = presentClientIssue(issue);
  return {
    key: `${source.key}:${issue.code}:${issue.reason ?? ""}`,
    label: said.title,
    tone: amberCodes.has(issue.code) ? "amber" : "muted",
    trying: state.trying,
    action: pillAction(said.action, source, "pill"),
  };
}

function pillAction(
  action: ReturnType<typeof presentClientIssue>["action"],
  source: ShellConnectionSource,
  where: "pill" | "details",
): ConnectionPillNotice["action"] {
  switch (action) {
    case "retry":
      return where === "pill"
        ? {
            label: clientIssueActions.retry,
            accessibilityLabel: "Try connecting now",
            onPress: () => source.connection.retry(),
          }
        : { label: clientIssueActions.tryNow, onPress: () => source.connection.retry() };
    case "sign-in":
      return source.onSignIn
        ? { label: clientIssueActions.signIn, onPress: source.onSignIn }
        : null;
    case "update":
      return source.onUpdate
        ? { label: clientIssueActions.update, onPress: source.onUpdate }
        : null;
    case "reload":
      return { label: clientIssueActions.reload, onPress: () => window.location.reload() };
    default:
      return null;
  }
}

function lastConnected(at: number | null, now: Date): string | null {
  if (at === null) return null;
  const then = new Date(at);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((day(now).getTime() - day(then).getTime()) / 86_400_000);
  const when =
    days === 0
      ? then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : days === 1
        ? "yesterday"
        : then.toLocaleDateString(undefined, { weekday: "long" });
  return `Last connected ${when}`;
}

const routeWords = {
  "same-computer": "on this computer",
  "private-network": "via your network",
  connect: "via Connect",
} as const;

function details(
  state: ClientConnectionState,
  source: ShellConnectionSource,
  others: ConnectionDetailsProps["others"],
): ConnectionDetailsProps | null {
  const issue = connectionNotice(state);
  if (issue === null) return null;
  const said = presentConnectionDetail(issue, "device");
  // Every connection trouble offers Try now: the presenter leaves it out only
  // where the pill itself has no button.
  const action =
    issue.code === "connection"
      ? pillAction("retry", source, "details")
      : pillAction(said.action, source, "details");
  const meta = [
    lastConnected(state.lastConnectedAt, new Date()),
    state.route ? routeWords[state.route] : null,
  ].filter((part): part is string => part !== null);
  return {
    mark: (
      <span className="connection-details__mark">
        <Icon name={source.mark} />
      </span>
    ),
    name: clientDisplayName(state.name, state.target),
    state: said.title,
    explanation: said.detail ?? "",
    action: action === null ? null : { ...action, busy: state.trying },
    meta: meta.length === 0 ? null : meta.join(" · "),
    others,
  };
}

const noSubscribe = () => () => {};

/** Every source's connection state, as one stable list. */
function useConnectionStates(
  sources: readonly ShellConnectionSource[],
): readonly ClientConnectionState[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = sources.map((source) => source.connection.subscribe(listener));
      return () => releases.forEach((release) => release());
    },
    [sources],
  );
  const read = useMemo(() => {
    let last: readonly ClientConnectionState[] = [];
    return () => {
      const next = sources.map((source) => source.connection.getSnapshot());
      if (next.length === last.length && next.every((state, index) => state === last[index]))
        return last;
      last = next;
      return next;
    };
  }, [sources]);
  return useSyncExternalStore(sources.length ? subscribe : noSubscribe, read, read);
}

/**
 * The pill for the connection the screen is about, rendered once inside the
 * main column. Other connections with trouble are listed in its details, never
 * as a second pill.
 */
export function ShellConnectionPill({
  current,
  others = [],
}: {
  readonly current: ShellConnectionSource;
  readonly others?: readonly ShellConnectionSource[];
}) {
  const gated = useContext(GateContext).gated;
  const sources = useMemo(() => [current, ...others], [current, others]);
  const states = useConnectionStates(sources);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const notice = pillNotice(states[0]!, current);
  // The details follow a listed connection once picked, back to this one when it recovers.
  const focusedIndex = Math.max(
    0,
    sources.findIndex((source, index) => source.key === focusedKey && states[index]),
  );
  useEffect(() => {
    if (notice === null) setFocusedKey(null);
  }, [notice === null]);
  const shown = details(
    states[focusedIndex]!,
    sources[focusedIndex]!,
    sources.flatMap((source, index) => {
      const issue = index === focusedIndex ? null : connectionNotice(states[index]!);
      return issue === null
        ? []
        : [
            {
              key: source.key,
              name: clientDisplayName(states[index]!.name, states[index]!.target),
              state: presentConnectionDetail(issue, "device").title,
              onPress: () => setFocusedKey(source.key),
            },
          ];
    }),
  );
  return <ConnectionPill details={shown} gated={gated} notice={notice} source={current.key} />;
}

/** The sidebar footer's dot for its place, and the words a screen reader hears for it. */
export function useConnectionDot(connection: ClientConnection): {
  readonly tone: "green" | "muted" | "amber";
  readonly words: string | null;
} {
  // Only what the dot shows: the sidebar redraws when its meaning changes, not on every publish.
  const read = useCallback(() => {
    const state = connection.getSnapshot();
    const issue = connectionNotice(state);
    if (issue !== null)
      return `${amberCodes.has(issue.code) ? "amber" : "muted"}\u0000${presentClientIssue(issue).title}`;
    return state.phase === "ready" ? "green" : "muted";
  }, [connection]);
  const key = useSyncExternalStore(connection.subscribe, read, read);
  return useMemo(() => {
    const [tone, words] = key.split("\u0000") as ["green" | "muted" | "amber", string?];
    return { tone, words: words ?? null };
  }, [key]);
}

/** Whether this connection is past its quiet moment and still not ready. */
export function useConnectionInterrupted(connection: ClientConnection): boolean {
  const read = useCallback(() => {
    const state = connection.getSnapshot();
    return state.showInterruption && state.phase !== "ready";
  }, [connection]);
  return useSyncExternalStore(connection.subscribe, read, read);
}

/** Whether this connection has ever been ready in this session. */
export function useConnectionEverReady(connection: ClientConnection | null): boolean {
  const read = useCallback(() => (connection?.getSnapshot().readyRevision ?? 0) > 0, [connection]);
  const subscribe = useCallback(
    (listener: () => void) => connection?.subscribe(listener) ?? (() => {}),
    [connection],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether live marks (breathing dots, typing) may keep moving for this connection. */
export function useConnectionLive(connection: ClientConnection): boolean {
  const read = useCallback(() => showsClientLive(connection.getSnapshot()), [connection]);
  return useSyncExternalStore(connection.subscribe, read, read);
}

/* ---- Gates ---- */

interface GateValue {
  readonly gated: boolean;
  readonly claim: () => () => void;
}
const GateContext = createContext<GateValue>({ gated: false, claim: () => () => {} });

/** Holds whether a route gate is explaining, so the pill steps aside meanwhile. */
export function ConnectionGateScope({ children }: { readonly children: ReactNode }) {
  const [claims, setClaims] = useState(0);
  const value = useMemo<GateValue>(
    () => ({
      gated: claims > 0,
      claim: () => {
        setClaims((count) => count + 1);
        return () => setClaims((count) => count - 1);
      },
    }),
    [claims > 0],
  );
  return <GateContext value={value}>{children}</GateContext>;
}

/**
 * The single explanation for a screen with nothing usable to show: its
 * connection's state, or, once connected, a quiet line while its first answer
 * is on the way. `ready` is the route's primary content having arrived.
 */
export function useConnectionGate(
  connection: ClientConnection,
  options: {
    readonly scope: "app" | "route";
    readonly ready: boolean;
    readonly onBack?: (() => void) | undefined;
    readonly onSignIn?: (() => void) | undefined;
    readonly onUpdate?: (() => void) | undefined;
    readonly secondary?: ConnectionGateButton | null | undefined;
    /**
     * The route's primary read gave up while the connection itself is fine:
     * a fact about that read, with its own way to try again.
     */
    readonly failed?: { readonly resource: string; readonly onRetry: () => void } | null;
  },
): ReactNode | null {
  const claim = useContext(GateContext).claim;
  const gating = !options.ready;
  useEffect(
    () => (gating && options.scope === "route" ? claim() : undefined),
    [claim, gating, options.scope],
  );
  // The caller doesn't redraw for the connection; only the gate it shows does.
  return gating ? <GateFor connection={connection} options={options} /> : null;
}

function GateFor({
  connection,
  options,
}: {
  readonly connection: ClientConnection;
  readonly options: Omit<Parameters<typeof useConnectionGate>[1], "ready">;
}) {
  const state = useClientConnection(connection);
  const said = presentConnectionGate(state);
  const trouble = state.showInterruption && state.issue !== null && state.phase !== "ready";
  const back = options.onBack === undefined ? null : { label: "Back", onPress: options.onBack };
  if (!trouble && options.failed && state.phase === "ready") {
    const failed = presentClientIssue({ code: "read-failed", resource: options.failed.resource });
    return (
      <ConnectionGate
        detail=""
        primary={{ label: clientIssueActions.tryAgain, onPress: options.failed.onRetry }}
        scope={options.scope}
        secondary={back}
        stateKey="read-failed"
        title={failed.title}
      />
    );
  }
  // Connected and waiting only on this route's own first answer: nothing to say yet.
  if (!trouble && state.phase === "ready")
    return <ConnectionGate detail="" scope={options.scope} stateKey="loading" title={null} />;
  if (!trouble)
    return (
      <ConnectionGate
        detail={presentConnectionStarting(state.name, state.target)}
        scope={options.scope}
        stateKey="connecting"
        title={null}
      />
    );
  const primary: ConnectionGateButton | null =
    state.issue?.code === "connection" || said.action === "retry"
      ? {
          label: clientIssueActions.tryAgain,
          onPress: () => connection.retry(),
          busy: state.trying,
        }
      : said.action === "sign-in" && options.onSignIn
        ? { label: clientIssueActions.signIn, onPress: options.onSignIn }
        : said.action === "update" && options.onUpdate
          ? { label: clientIssueActions.update, onPress: options.onUpdate }
          : null;
  return (
    <ConnectionGate
      detail={said.detail ?? ""}
      primary={primary ?? back}
      scope={options.scope}
      secondary={primary === null ? null : (options.secondary ?? back)}
      stateKey={`${state.issue?.code ?? ""}:${state.issue?.reason ?? ""}`}
      title={said.title}
    />
  );
}

/** A gate as an element, for a screen that decides to show one only some of the time. */
export function ConnectionGateView({
  connection,
  ...options
}: Omit<Parameters<typeof useConnectionGate>[1], "ready"> & {
  readonly connection: ClientConnection;
}) {
  return useConnectionGate(connection, { ...options, ready: false });
}
