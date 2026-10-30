// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";

const state = vi.hoisted(() => ({
  alert: null as null | { buttons: { onPress?: () => void; text: string }[]; title: string },
  begin: null as unknown,
  hostClient: null as unknown,
}));

vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (client: { getSnapshot: () => unknown }, select: (value: unknown) => unknown) =>
    select(client.getSnapshot()),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: {
    alert: (title: string, _message: string, buttons: { onPress?: () => void; text: string }[]) => {
      state.alert = { buttons, title };
    },
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Linking: { openURL: vi.fn(async () => undefined) },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <div aria-label={accessibilityLabel} onClick={onPress} role="button">
      {children}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../theme.js", () => ({ color: {}, space: {}, touchTarget: 44 }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/integration-icon.js", () => ({ IntegrationIcon: () => null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ beginIntegrationAuthorization: state.begin }),
  useMobileState: () => ({
    rows: [{ deploymentId: "deployment-a", name: "Tim’s MacBook Pro", signIn: null }],
    selection: { deploymentId: "deployment-a", hostClient: state.hostClient },
  }),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail, title }: { detail: string; title: string }) => (
    <div role="note">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  // A phone's inner button takes the touch from the row around it.
  SecondaryButton: ({
    busy,
    disabled,
    label,
    onPress,
  }: {
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button
      disabled={disabled || busy}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      {label}
    </button>
  ),
  StatusDot: () => null,
}));

const { ConnectedAppsScreen } = await import("./connected-apps.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.alert = null;
});

describe("Connected apps on the phone", () => {
  // The ways it could fail: Reconnect on a phone that never starts a sign-in,
  // or starts one through an app the Host did not select; the list not showing
  // the account the provider returned as connected afterwards.
  it("reconnects an account through the sign-in app the Host selected", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    await client.load();
    state.hostClient = client;
    const dashboard = unwrapRpcResult(await client.rpc["integrations.get"]({}));
    const broken = dashboard.connections.find(
      ({ accountIdentifier, definitionId }) =>
        definitionId === "google-calendar" && accountIdentifier === "alex@example.com",
    );
    if (!broken) throw new Error("The mock seeds a Google Calendar account needing sign-in.");
    // The phone's own sign-in, against the mock Host: begin, then read the attempt.
    state.begin = vi.fn(async (input: { applicationSource: unknown; definitionId: string }) => {
      const started = await client.dispatch({
        idempotencyKey: "connected-apps-test",
        input: {
          definitionId: input.definitionId,
          exactApplicationSource: input.applicationSource as never,
          returnPath: "/",
          surface: "native",
        },
        type: "integration.authorization.begin",
      });
      if (started.type !== "integration.authorization.begin") throw new Error("begin");
      return unwrapRpcResult(
        await client.rpc["integration.authorization.get"]({ attemptId: started.attemptId }),
      );
    });
    const container = await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Google Calendar"));
    const row = [...container.querySelectorAll<HTMLElement>("[role=button]")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("alex@example.com,"),
    );
    expect(row?.getAttribute("aria-label")).toBe(
      "alex@example.com, Sign in again to keep using it",
    );

    await act(async () =>
      [...(row?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "Reconnect")
        ?.click(),
    );

    expect(state.begin).toHaveBeenCalledWith({
      applicationSource: dashboard.providerAuthorizations.google?.selectedSource,
      definitionId: "google-calendar",
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("alex@example.com is connected."),
    );
  });

  it("disconnects an account only once the person confirms", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    await client.load();
    state.hostClient = client;
    const dispatch = vi.spyOn(client, "dispatch");
    const container = await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Google Calendar"));
    const row = [...container.querySelectorAll<HTMLElement>("[role=button]")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("alex@example.com,"),
    );

    await act(async () => row?.click());
    expect(state.alert?.title).toBe("alex@example.com");
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () =>
      state.alert?.buttons.find(({ text }) => text === "Disconnect")?.onPress?.(),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "integration.disconnect" }),
    );
  });
});

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ConnectedAppsScreen route={{ params: { deploymentId: "deployment-a" } } as never} />,
    ),
  );
  return container;
}
