// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";

const state = vi.hoisted(() => ({
  alert: null as null | { buttons: { onPress?: () => void; text: string }[]; title: string },
  appState: (_next: string) => undefined as void,
  begin: null as unknown,
  hostClient: null as MockHostClient | null,
  openURL: null as unknown,
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
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.appState = listener;
      return { remove: () => undefined };
    },
    currentState: "active",
  },
  Linking: { openURL: (url: string) => (state.openURL as (url: string) => Promise<void>)(url) },
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
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({
    children,
    open,
    onClose,
  }: {
    children?: ReactNode;
    open: boolean;
    onClose: () => void;
  }) =>
    open ? (
      <section>
        <button onClick={onClose}>Close editor</button>
        {children}
      </section>
    ) : null,
}));
vi.mock("../ui/primitives.js", () => ({
  CodeBlock: ({ label, text }: { label: string; text: string }) => (
    <code>
      {label}: {text}
    </code>
  ),
  Field: ({
    input,
    label,
  }: {
    input: { value: string; onChangeText: (text: string) => void };
    label: string;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={input.value}
        onChange={(event) => input.onChangeText(event.target.value)}
      />
    </label>
  ),
  PrimaryButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
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

const { PluginAccounts } = await import("./settings-plugin-accounts.js");
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
    state.begin = vi.fn(phoneSignIn(client));
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

  // The ways it could fail: a GitHub sign-in announced as connected while the
  // Host still waits for a repository it can reach; or the person chooses
  // repositories in GitHub and comes back to the same unfinished account.
  it("finishes a GitHub sign-in in GitHub's repository step, and checks again on return", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    await client.load();
    state.hostClient = client;
    state.begin = vi.fn(phoneSignIn(client));
    state.openURL = vi.fn(async () => undefined);
    const installationUrl = "https://github.com/apps/opensteer/installations/new";
    const check = vi
      .fn()
      .mockResolvedValueOnce({
        data: { installationUrl, installations: [], ready: false },
        ok: true,
      })
      .mockResolvedValue({ data: { installationUrl, installations: [], ready: true }, ok: true });
    const rpc = client.rpc;
    Object.defineProperty(client, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key) =>
          key === "integration.repositoryAccess.check" ? check : Reflect.get(target, key),
      }),
    });
    const container = await render();
    await vi.waitFor(() => expect(container.textContent).toContain("GitHub REST"));

    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="Add a GitHub REST account"]')?.click(),
    );

    await vi.waitFor(() => expect(state.openURL).toHaveBeenCalledWith(installationUrl));
    expect(check).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("is connected.");

    await act(async () => state.appState("active"));

    await vi.waitFor(() => expect(container.textContent).toContain("is connected."));
    expect(check).toHaveBeenCalledTimes(2);
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
    root.render(<PluginAccounts hostClient={state.hostClient!} hostName="Tim’s MacBook Pro" />),
  );
  return container;
}

/** The phone's own sign-in against the mock Host: begin, then read the attempt back. */
function phoneSignIn(client: MockHostClient) {
  return async (input: { applicationSource: unknown; definitionId: string }) => {
    const started = await client.dispatch({
      idempotencyKey: `connected-apps-test:${input.definitionId}`,
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
  };
}

it("continues a new API-key account and retries placement without connecting twice", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  state.hostClient = client;
  const platform = unwrapRpcResult(await client.rpc["integration.platform.get"]({}));
  const entry = platform.catalog.find(({ definition }) => definition.id === "resend")!;
  await client.dispatch({
    type: "integration.catalog.install",
    input: { definitionId: "resend", digest: entry.digest },
    idempotencyKey: "install-resend",
  });
  let sections: import("./native-settings-page.types.js").NativeSettingsSection[] = [];
  const connected = vi
    .fn()
    .mockRejectedValueOnce(new Error("Placement response lost"))
    .mockResolvedValue(undefined);
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  try {
    await act(async () =>
      root.render(
        <PluginAccounts
          hostClient={client}
          hostName="Acceptance"
          definitionId="resend"
          onConnected={connected}
          render={(value) => {
            sections = value;
            return null;
          }}
        />,
      ),
    );
    const all = () => sections.flatMap((section) => section.rows);
    await vi.waitFor(() => expect(all().some(({ label }) => label === "API key")).toBe(true));
    const field = all().find(({ label }) => label === "API key")!;
    if (field.kind !== "input") throw new Error("Missing key field");
    expect(field.secure).toBe(true);
    await act(async () => field.onChange("acceptance-key"));
    const dispatch = vi.spyOn(client, "dispatch");
    const press = async (label: string) => {
      const row = all().find((row) => row.label === label);
      if (row?.kind !== "button") throw new Error(`Missing ${label}`);
      await act(async () => row.onPress());
    };
    await press("Connect account");
    await vi.waitFor(() =>
      expect(all().some(({ label }) => label === "Retry placement")).toBe(true),
    );
    await press("Retry placement");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));
    expect(connected.mock.calls[1]).toEqual(connected.mock.calls[0]);
    expect(
      dispatch.mock.calls.filter(([command]) => command.type === "integration.apiKey.connect"),
    ).toHaveLength(1);
  } finally {
    client.dispose();
  }
});

it("sets up a custom OAuth app in Settings, then connects through the exact saved registration", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const begin = vi.fn(async () => ({ status: "denied", failureCode: null, connectionId: null }));
  state.begin = begin;
  state.hostClient = client;
  const draft = {
    availability: "personal" as const,
    provider: "slack" as const,
    clientId: "same-client",
    displayName: "My Google app",
    expectedRevision: null,
    secrets: { clientSecret: "test-only-secret" },
  };
  // Same label and client id: only the Host's saved id and revision identify it.
  await client.dispatch({
    type: "integration.providerApplication.save",
    idempotencyKey: "existing-app",
    input: draft,
  });
  const dispatch = vi.spyOn(client, "dispatch");
  let sections: import("./native-settings-page.types.js").NativeSettingsSection[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <PluginAccounts
        hostClient={client}
        hostName="Acceptance"
        definitionId="slack"
        render={(value) => {
          sections = value;
          return null;
        }}
      />,
    ),
  );
  const press = async (label: string) => {
    const row = sections.flatMap((section) => section.rows).find((row) => row.label === label);
    if (row?.kind !== "button") throw new Error(`Missing ${label}`);
    await act(async () => row.onPress());
  };
  await vi.waitFor(() => expect(sections.some((section) => section.key === "own-app")).toBe(true));
  await press("Use my own OAuth app");
  expect(container.textContent).toContain("Authorized callback URL");
  const type = (label: string, value: string) =>
    act(() => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  type("App name", "My Google app");
  type("Client ID", "same-client");
  type("Client Secret", "test-only-secret");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Save app")!
      .click(),
  );
  await vi.waitFor(() =>
    expect(
      sections
        .flatMap((section) => section.rows)
        .some((row) => row.label === "App saved. No account is connected yet."),
    ).toBe(true),
  );
  expect(begin).not.toHaveBeenCalled();
  const savedCommand = dispatch.mock.results.find(
    (_, i) => dispatch.mock.calls[i]?.[0].type === "integration.providerApplication.save",
  )!;
  const saved = await savedCommand.value;
  expect(saved.type).toBe("integration.providerApplication.save");
  const dashboard = unwrapRpcResult(await client.rpc["integrations.get"]({}));
  expect(dashboard.applications.filter((app) => app.displayName === "My Google app")).toHaveLength(
    2,
  );
  const add = sections.flatMap((section) => section.rows).find((row) => row.key === "add:slack");
  if (add?.kind !== "button") throw new Error("Missing Connect account");
  await act(async () => add.onPress());
  expect(begin).toHaveBeenCalledWith({
    definitionId: "slack",
    applicationSource: expect.objectContaining({
      providerApplicationId: saved.application.id,
      providerApplicationRevision: saved.application.revision,
    }),
  });
  client.dispose();
});
