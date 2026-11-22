// @vitest-environment happy-dom
import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn(async () => true) },
}));
vi.mock("@react-navigation/native", () => ({
  CommonActions: {},
  StackActions: {},
  useIsFocused: () => true,
}));
vi.mock("../threads/deployment-identity.js", () => ({
  deploymentMark: () => ({ initial: "M", tone: "amber" }),
}));
vi.mock("./connection-gate.js", () => {
  type Button = { label: string; onPress: () => void; busy?: boolean } | null | undefined;
  return {
    ConnectionGate: (props: {
      title: string | null;
      detail: string;
      primary?: Button;
      secondary?: Button;
    }) => (
      <section>
        <h1>{props.title}</h1>
        <p>{props.detail}</p>
        {[props.primary, props.secondary].map((button) =>
          button ? (
            <button
              data-busy={button.busy ? "true" : undefined}
              key={button.label}
              onClick={button.onPress}
            >
              {button.label}
            </button>
          ) : null,
        )}
      </section>
    ),
  };
});
vi.mock("./connection-pill.js", () => ({ ConnectionPillView: () => null }));
vi.mock("../navigation-ref.js", () => ({
  navigationRef: {
    addListener: () => () => undefined,
    getCurrentRoute: () => undefined,
    isReady: () => false,
    navigate: vi.fn(),
  },
}));
vi.mock("../screens/deployment-recovery.js", () => ({ runDeploymentRecovery: vi.fn() }));
vi.mock("./mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({ selection: { row: null, session: null } }),
}));

const { ConnectionRouteGate } = await import("./route-gate.js");
const { shellAction } = await import("./connection-shell.js");

const baseState: ClientConnectionState = {
  epoch: 1,
  issue: null,
  lastConnectedAt: null,
  name: "Mac mini",
  network: "online",
  pathRevision: 0,
  phase: "connecting",
  readyRevision: 0,
  route: "connect",
  scope: null,
  showInterruption: true,
  target: "computer",
  trying: true,
  visibility: "foreground",
};

function fakeConnection(state: ClientConnectionState, retry = vi.fn()): ClientConnection {
  return {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    retry,
  } as unknown as ClientConnection;
}

it("respects presenter retry authority on the mobile route gate and connection sheet actions", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const retry = vi.fn();
  const session = {
    key: "tasks" as const,
    name: "Mac mini",
    mark: { initial: "M", tone: "amber" as const },
    connection: fakeConnection(baseState, retry),
    signIn: vi.fn(async () => undefined),
  };
  try {
    // Slow initial connect and offline do not force Try again on the route gate or sheet.
    const slowConn = fakeConnection({
      ...baseState,
      issue: { code: "connection", reason: "reconnecting", route: "connect" },
    });
    act(() => root.render(<ConnectionRouteGate connection={slowConn} />));
    expect(host.textContent).toContain("Connecting to Mac mini…");
    expect(host.textContent).toContain("taking longer than usual");
    expect(host.querySelectorAll("button").length).toBe(0);
    expect(shellAction({ code: "connection", reason: "reconnecting" }, session)).toBeNull();

    const offlineConn = fakeConnection({
      ...baseState,
      phase: "recovering",
      network: "offline",
      trying: false,
      issue: { code: "connection", reason: "offline" },
    });
    act(() => root.render(<ConnectionRouteGate connection={offlineConn} />));
    expect(host.textContent).toContain("You're offline");
    expect(host.querySelectorAll("button").length).toBe(0);
    expect(shellAction({ code: "connection", reason: "offline" }, session)).toBeNull();

    // Unreachable and update-server keep Try again on the route gate; unreachable keeps retry in shellAction.
    const unreachableConn = fakeConnection(
      {
        ...baseState,
        phase: "recovering",
        trying: false,
        issue: { code: "connection", reason: "unreachable", route: "connect" },
      },
      retry,
    );
    act(() => root.render(<ConnectionRouteGate connection={unreachableConn} />));
    expect(host.textContent).toContain("Can't reach Mac mini");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Try again"]);
    expect(shellAction({ code: "connection", reason: "unreachable" }, session)?.kind).toBe("retry");

    act(() =>
      root.render(
        <ConnectionRouteGate connection={unreachableConn} issue={{ code: "update-server" }} />,
      ),
    );
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Try again"]);
  } finally {
    act(() => root.unmount());
  }
});
