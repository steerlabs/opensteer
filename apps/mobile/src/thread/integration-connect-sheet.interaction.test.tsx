import { controlledClientSession } from "@opensteer/client/test-support";
vi.mock("../ui/placeholder.js", () => ({
  PlaceholderRows: () => <div aria-label="Not loaded yet" />,
}));
vi.mock("../ui/action-line.js", () => ({
  ActionLine: (props: {
    line: { text: string; link?: { label: string; onPress: () => void } | null };
  }) => (
    <p>
      {props.line.text}
      {props.line.link ? (
        <button onClick={props.line.link.onPress}>{props.line.link.label}</button>
      ) : null}
    </p>
  ),
}));
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light" },
  selectionAsync: vi.fn(async () => {}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
const cardRenders = vi.hoisted(() => vi.fn());
const openURL = vi.hoisted(() => vi.fn(async () => undefined));

// The native renderer's state and hierarchy, with DOM hosts. Platform controls
// are outside this regression; what it pins is the flow: which app is sent to
// the Host, and what the sheet is willing to call a connection.
vi.mock("react-native", () => ({
  ActivityIndicator: () => <span aria-hidden />,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Linking: { openURL },
  Pressable: ({
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityRole: "link" | "button" | "radio";
    accessibilityState?: { checked?: boolean; expanded?: boolean };
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-checked={accessibilityState?.checked}
      aria-expanded={accessibilityState?.expanded}
      disabled={disabled}
      role={accessibilityRole}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("../theme.js", () => ({
  color: {},
  material: { plate: {}, quiet: {} },
  radius: {},
  space: {},
  touchTarget: 44,
  controlFontScaleLimit: 1.5,
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({
    children,
    footer,
    onClose,
    open,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div>
        <h1>{title}</h1>
        <button onClick={onClose}>Dismiss sheet</button>
        {children}
        {footer}
      </div>
    ) : null,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ChoiceRow: ({
    description,
    disabled,
    onPress,
    title,
  }: {
    description: string;
    disabled?: boolean;
    onPress: () => void;
    title: string;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {title} — {description}
    </button>
  ),
  CodeBlock: ({ label, text }: { label?: string; text: string }) => (
    <code>
      {label}: {text}
    </code>
  ),
  Field: ({
    input,
    label,
  }: {
    input: { onChangeText?: (value: string) => void; value?: string };
    label: string;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        onChange={(event) => input.onChangeText?.(event.target.value)}
        value={input.value ?? ""}
      />
    </label>
  ),
  Notice: ({
    action,
    detail,
    title,
  }: {
    action?: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action ? <button onClick={action.onPress}>{action.label}</button> : null}
    </div>
  ),
  PrimaryButton: ({
    disabled,
    label,
    onPress,
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  SwitchRow: ({
    label,
    onChange,
    value,
  }: {
    label: string;
    onChange: (value: boolean) => void;
    value: boolean;
  }) => <button onClick={() => onChange(!value)}>{label}</button>,
}));
vi.mock("../ui/integration-icon.js", () => ({
  IntegrationIcon: ({ name }: { name: string }) => {
    cardRenders();
    return <span aria-hidden>{name} icon</span>;
  },
}));

const { IntegrationConnectCard } = await import("./integration-connect-sheet.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  openURL.mockClear();
  vi.restoreAllMocks();
});

describe("IntegrationConnectCard", () => {
  it("does not render for streaming updates in an unrelated thread", async () => {
    const client = fakeClient({});
    await render(client);
    const before = cardRenders.mock.calls.length;
    await act(async () => client.streamUnrelatedThread());
    expect(cardRenders.mock.calls.length).toBe(before);
  });

  it("installs from the access sheet without resolving the request", async () => {
    const client = fakeClient({ isAdministrator: true });
    await render(client, preinstallRequest());

    expect(text()).toContain("Test Calendar");
    expect(text()).toContain("Scheduling for the test suite.");
    expect(buttons()).toContain("Continue");
    await press("Continue");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "choice", optionId: "installed" },
        type: "request.respond",
      }),
    );
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ kind: "external" }) }),
    );
  });

  it("pins a singleton server before showing account or access controls", async () => {
    const client = fakeClient({});
    await render(client, unpinnedRequest());

    expect(text()).toContain("Choose server");
    await click("Choose server");
    expect(buttons()).not.toContain("Connect");
    await click("Continue with live");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          kind: "choice",
          optionId: "server:isv_00000000-0000-4000-8000-000000000001",
        },
        type: "request.respond",
      }),
    );
  });

  /**
   * The phone is not the Mac, and it does not have to be: turning an app on is
   * a write about a computer, so the request it answers can be finished here.
   */
  it("requests local approval without granting access or finishing the agent request", async () => {
    const client = fakeClient({ machines: [mac()], requirementKind: "computer" });
    await render(client);

    expect(text()).toContain("Choose a computer");
    await click("Choose a computer");
    await click("Mac mini");
    await click("Request setup on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        // The safe level, never the one that acts on somebody's behalf.
        input: expect.objectContaining({
          access: "read",
          definitionId: "apple-messages",
          runnerId: macMiniId,
        }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("explains a selected Mac permission without blocking connection", async () => {
    const client = fakeClient({
      machines: [mac({ apps: [messagesNeedsFullDiskAccess()] })],
      requirementKind: "computer",
    });
    await render(client);

    await click("Choose a computer");

    expect(text()).toContain("Agent access");
    expect(text()).toContain("Reading Apple Messages needs macOS Full Disk Access");
    expect(text()).toContain(
      "Reading Apple Messages requires macOS permission. Switching on Opensteer Computer Use in Full Disk Access lets it read Apple Messages on Mac mini for the agents you approve. It does not change the agent access selected for this app. Complete setup on Mac mini.",
    );
    expect(text()).not.toContain("the app that runs Opensteer");
    expect(text()).not.toContain("Open System Settings");

    await click("Request setup on Mac mini");
    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("explains a selected iPhone's Settings without macOS directions", async () => {
    const detail = "Calendar needs full access for Opensteer in iPhone Settings.";
    const client = fakeClient({
      installedPlatform: calendarPlatform(),
      machines: [
        mac({
          apps: [
            {
              definitionId: "apple-calendar",
              operations: [
                {
                  operation: "list_events",
                  detail,
                  remedy: "calendars",
                  state: "permission-required",
                },
              ],
            },
          ],
          device: { form: "phone", platform: "ios" },
          name: "Alex's iPhone",
        }),
      ],
      requirementKind: "computer",
    });
    await render(client);

    await click("Choose a computer");

    expect(text()).toContain("Calendar needs access on Alex's iPhone");
    expect(text()).toContain(
      `${detail} Allow it in iPhone Settings on Alex's iPhone. It does not change the agent access selected for this app.`,
    );
    expect(text()).not.toContain("macOS Calendars access");
    expect(text()).not.toContain("Opensteer Computer Use");
    // The computer's row names the iPhone's own setting, never a macOS one.
    expect(text()).not.toContain("macOS");
    expect(text()).toContain(`${detail} · chosen`);
  });

  /*
   * Failure: once no computer offers an app a Mac or an iPhone can run, the
   * computer step tells the phone to open "the desktop app" and "Add
   * computer", which an iPhone has neither of. A Mac-only app keeps its
   * desktop-app steps.
   */
  it("says where a Mac or an iPhone adds itself once none offers the app", async () => {
    const client = fakeClient({
      installedPlatform: calendarPlatform(),
      machines: [
        mac({
          apps: [
            {
              definitionId: "apple-calendar",
              operations: [
                { detail: null, operation: "list_events", remedy: null, state: "ready" },
              ],
            },
          ],
          device: { form: "phone", platform: "ios" },
          name: "Alex's iPhone",
        }),
      ],
      requirementKind: "computer",
    });
    await render(client);

    await click("Choose a computer");
    await act(async () => client.setMachines([]));

    expect(text()).toContain("No computer is offering Calendar yet");
    expect(text()).toContain(
      "Open Opensteer on a Mac or an iPhone, open this deployment, then add it in Settings → Computers. Return here when it appears.",
    );
    expect(text()).not.toContain("desktop app");
    expect(text()).not.toContain("Add computer");
  });

  it("keeps a Mac-only app's desktop-app steps once no Mac offers it", async () => {
    const client = fakeClient({ machines: [mac()], requirementKind: "computer" });
    await render(client);

    await click("Choose a computer");
    await act(async () => client.setMachines([]));

    expect(text()).toContain(
      "Open Opensteer on a Mac in the desktop app. Open this deployment, then Settings → Computers → Add computer and follow the steps. Return here when it appears.",
    );
  });

  it("requires an explicit choice before turning on read-write computer access", async () => {
    const client = fakeClient({
      machines: [mac()],
      requirementKind: "computer",
    });
    await render(client);

    await click("Choose a computer");
    await click("Read and send");
    await click("Request setup on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("widens a read-only computer before a read request opts into changes", async () => {
    const client = fakeClient({
      connections: [computerConnection("read")],
      machines: [mac()],
      requirementKind: "computer",
    });
    await render(client, request("read"));

    await click("Allow changes (Read and send)");

    expect(text()).toContain("Request sending access on Mac mini");
    expect(buttons()).not.toContain("Allow");
    await click("Request sending access on Mac mini");
    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("does not fulfill a request just by requesting setup", async () => {
    const onClose = vi.fn();
    const onResponded = vi.fn();
    const client = fakeClient({
      machines: [mac()],
      requestPendingAfterComputerSet: false,
      requirementKind: "computer",
    });
    await render(client, request("read"), { onClose, onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");

    expect(onResponded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond" }),
    );
  });

  it("keeps an insufficient request pending after choosing its computer", async () => {
    const onResponded = vi.fn();
    const client = fakeClient({
      machines: [mac()],
      requestPendingAfterComputerSet: true,
      requirementKind: "computer",
    });
    await render(client, request("read-write"), { onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");

    expect(onResponded).not.toHaveBeenCalled();
    expect(text()).toContain("Setup requested");
  });

  it("keeps the chosen computer visible while its setup request awaits approval", async () => {
    const macBookId = "rnr_00000000-0000-4000-8000-0000000000a2";
    const client = fakeClient({
      computerSetVisible: false,
      connections: [computerConnection("read")],
      machines: [mac(), mac({ id: macBookId, name: "MacBook" })],
      requirementKind: "computer",
    });
    await render(client);

    await click("Use another computer");
    await click("Request setup on MacBook");

    expect(text()).toContain("Setup requested. On MacBook");
  });

  it("requires reselection when the explicitly chosen computer disappears", async () => {
    const macBookId = "rnr_00000000-0000-4000-8000-0000000000a2";
    const client = fakeClient({
      machines: [mac(), mac({ id: macBookId, name: "MacBook" })],
      requirementKind: "computer",
    });
    await render(client);

    await click("Choose a computer");
    await click("MacBook");
    await act(async () => client.setMachines([mac()]));

    expect(text()).not.toContain("Request setup on Mac mini");
    expect(text()).not.toContain("Request setup on MacBook");
  });

  it("ignores a computer write that finishes after the sheet is dismissed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onClose = vi.fn();
    const onResponded = vi.fn();
    const client = fakeClient({
      computerSetGate: gate,
      machines: [mac()],
      requirementKind: "computer",
    });
    await render(client, request(), { onClose, onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");
    await click("Dismiss sheet");
    await act(async () => {
      release();
      await gate;
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onResponded).not.toHaveBeenCalled();
  });

  /**
   * A read-only computer has no send tool for any grant to reach, so approving
   * the request would promise an access it cannot carry. Raising the ceiling is
   * its own deliberate act, and it leaves the request exactly as it was pinned.
   */
  it("requires the computer's ceiling to be raised before a send request is allowed", async () => {
    const client = fakeClient({
      connections: [computerConnection("read")],
      machines: [mac()],
      requirementKind: "computer",
    });
    await render(client, request("read-write"));

    expect(text()).toContain("Allow changes on this computer");
    expect(buttons()).not.toContain("Allow");
    await click("Request sending access on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond" }),
    );
  });

  it("allows a no-account integration without claiming an account is missing", async () => {
    const client = fakeClient({ requirementKind: "none" });
    await render(client);

    expect(text()).not.toContain("No account is connected yet");
    await press("Allow");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          kind: "external",
          value: expect.objectContaining({ connectionId: null, decision: "fulfilled" }),
        },
        type: "request.respond",
      }),
    );
  });

  // The ways it could fail: the person closes the sheet while an install, a
  // server choice is still out, and opens it again;
  // the old operation's failure, arriving now, lands on the fresh sheet.
  it.each<{
    readonly client: () => ReturnType<typeof fakeClient>;
    readonly operation: string;
    readonly request: () => ReturnType<typeof request>;
    readonly start: (client: ReturnType<typeof fakeClient>, held: Promise<never>) => Promise<void>;
  }>([
    {
      client: () => fakeClient({ isAdministrator: true }),
      operation: "an install",
      request: preinstallRequest,
      start: async (client, held) => {
        client.dispatch.mockReturnValueOnce(held);
        await press("Continue");
      },
    },
    {
      client: () => fakeClient({}),
      operation: "a server choice",
      request: unpinnedRequest,
      start: async (client, held) => {
        client.dispatch.mockReturnValueOnce(held);
        await click("Choose server");
        await click("Continue with live");
      },
    },
  ])("leaves a reopened sheet alone when $operation fails late", async (input) => {
    const client = input.client();
    const currentRequest = input.request();
    let fail!: (reason: Error) => void;
    const held = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await render(client, currentRequest);
    await input.start(client, held);
    await act(async () => roots.at(-1)!.render(null));
    await reopen(client, currentRequest);

    await act(async () => fail(new Error("The closed sheet's operation failed")));

    expect(text()).not.toContain("The closed sheet's operation failed");
  });
});

async function render(
  client: ReturnType<typeof fakeClient>,
  currentRequest = request(),
  callbacks: { readonly onClose?: () => void; readonly onResponded?: () => void } = {},
  disclose = true,
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <IntegrationConnectCard
        hostClient={client as never}
        onClose={callbacks.onClose ?? vi.fn()}
        onResponded={callbacks.onResponded ?? vi.fn()}
        request={currentRequest}
      />,
    );
  });
  if (disclose) await openDetails();
}

/** Opens what the card's foot line stands for, where the card has anything behind it. */
async function openDetails(): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  if (toggle) await act(async () => toggle.click());
}

/** Closes the sheet and opens it again on the same request, as its card does. */
async function reopen(
  client: ReturnType<typeof fakeClient>,
  currentRequest: ReturnType<typeof request>,
): Promise<void> {
  const root = roots.at(-1)!;
  for (const open of [false, true]) {
    await act(async () => {
      root.render(
        open ? (
          <IntegrationConnectCard
            hostClient={client as never}
            onClose={vi.fn()}
            onResponded={vi.fn()}
            request={currentRequest}
          />
        ) : null,
      );
    });
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function buttons(): readonly string[] {
  return [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

/** Presses the control whose whole label is this, where a longer one would also match. */
async function press(label: string): Promise<void> {
  const target = [...document.querySelectorAll("button")]
    .reverse()
    .find((element) => element.textContent === label);
  if (!target) throw new Error(`No control labelled exactly ${label} in: ${text()}`);
  await act(async () => {
    target.click();
  });
}

async function click(label: string): Promise<void> {
  const target = [...document.querySelectorAll("button")]
    .reverse()
    .find((element) => element.textContent?.includes(label));
  if (!target) throw new Error(`No control labelled ${label} in: ${text()}`);
  await act(async () => {
    target.click();
  });
}

const threadId = "thr_00000000-0000-4000-8000-000000000001";
const requestId = "req_00000000-0000-4000-8000-000000000001";

function request(
  access: "read" | "read-write" = "read",
  requestedConnectionId: string | null = null,
) {
  return {
    createdAt: "2026-09-17T00:00:00.000Z",
    id: requestId,
    kind: "integration.access",
    mode: "live",
    originatingThreadId: threadId,
    payload: {
      access,
      installationId: "iin_00000000-0000-4000-8000-000000000001",
      kind: "integration.access",
      reason: "Read the calendar.",
      requestedConnectionId,
      requestedServerId: "isv_00000000-0000-4000-8000-000000000001",
    },
    presentation: { kind: "external", title: "Allow Calendar" },
    status: "pending",
  } as never;
}

/** A request for an installation with more than one server, naming none. */
function unpinnedRequest() {
  return {
    ...(request() as unknown as object),
    payload: {
      access: "read",
      installationId: "iin_00000000-0000-4000-8000-000000000001",
      kind: "integration.access",
      manifest: null,
      reason: "Use one server",
      requestedConnectionId: null,
      requestedServerId: null,
    },
  } as never;
}

function preinstallRequest() {
  return {
    ...(request() as unknown as object),
    payload: {
      access: "read",
      installationId: null,
      kind: "integration.access",
      manifest: {
        definition: {
          ...calendarPlatform().installations[0]!.installation.manifest.definition,
          description: "Scheduling for the test suite.",
          id: "test-calendar",
          name: "Test Calendar",
          provider: "apple-calendar",
        },
        digest: "c".repeat(43),
        kind: "catalog",
      },
      requestedConnectionId: null,
      requestedServerId: null,
      reason: "Read the calendar",
    },
  } as never;
}

function fakeClient(input: {
  readonly connections?: readonly ReturnType<typeof computerConnection>[];
  readonly machines?: readonly ReturnType<typeof mac>[];
  readonly computerSetGate?: Promise<void>;
  /** The installed apps the Host lists, when not one of `platform`'s fixtures. */
  readonly installedPlatform?: ReturnType<typeof calendarPlatform>;
  readonly computerSetVisible?: boolean;
  readonly requestPendingAfterComputerSet?: boolean;
  readonly requirementKind?: "computer" | "none";
  readonly isAdministrator?: boolean;
  readonly multipleServers?: boolean;
  /** Attached from another device, as a phone always is to a Personal Opensteer. */
  readonly remote?: boolean;
}) {
  const connections = [...(input.connections ?? [])];
  let requestPending = true;
  const listeners = new Set<() => void>();
  let snapshot = {
    identityConfig: { deployment: { name: "Alex’s Opensteer" } },
    threadActivities: { unrelated: 0 },
    machines: [...(input.machines ?? [])],
  };
  const dispatch = vi.fn(
    async (command: {
      readonly input?: { readonly access?: "read" | "read-write"; readonly runnerId?: string };
      readonly type: string;
      readonly response?: { kind: string };
    }) => {
      if (command.type === "request.respond" && command.response?.kind === "external")
        requestPending = false;
      if (command.type === "integration.computer.setup.request") {
        await input.computerSetGate;
        return { type: command.type, request: { id: "test-setup-request" } };
      }
      return { type: command.type };
    },
  );
  return {
    connection: controlledClientSession().connection,
    dispatch,
    streamUnrelatedThread() {
      snapshot = {
        ...snapshot,
        threadActivities: { unrelated: snapshot.threadActivities.unrelated + 1 },
      };
      for (const listener of listeners) listener();
    },
    setConnections(next: typeof connections) {
      connections.splice(0, connections.length, ...next);
    },
    settleRequest() {
      requestPending = false;
    },
    getSnapshot: () => snapshot,
    rpc: {
      "integration.platform.get": async () => {
        const data =
          input.installedPlatform ??
          platform(input.requirementKind ?? "none", input.multipleServers ?? false);
        return {
          ok: true,
          data: input.remote ? { ...data, authorizationSurface: "personal-remote" } : data,
        };
      },
      "integrations.get": async () => ({
        ok: true,
        data: {
          authorizationSurface: "canonical",
          connections,
          isAdministrator: input.isAdministrator ?? false,
        },
      }),
      "thread.requests.list": async () => ({
        ok: true,
        data: {
          requests: requestPending ? [{ id: requestId, status: "pending" }] : [],
          threadId,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: requestPending ? 1 : 0,
            nextBefore: null,
            threadId,
            totalItems: requestPending ? 1 : 0,
          },
        },
      }),
    },
    setMachines(machines: readonly ReturnType<typeof mac>[]) {
      snapshot = { ...snapshot, machines: [...machines] };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function platform(requirementKind: "computer" | "none", multipleServers = false) {
  if (requirementKind === "computer") return computerPlatform();
  return {
    authorizationSurface: "canonical",
    catalog: [],
    connections: [],
    installations: [
      {
        installation: {
          id: "iin_00000000-0000-4000-8000-000000000001",
          manifest: { name: "calendar-server" },
          status: "active",
          title: "Calendar server",
        },
        servers: ["live", ...(multipleServers ? ["archive"] : [])].map((name, index) => ({
          connectionRequirement: { kind: "none" },
          id: `isv_00000000-0000-4000-8000-00000000000${index + 1}`,
          name,
          status: "active",
        })),
        skills: [],
        tools: [],
      },
    ],
  };
}

const macMiniId = "rnr_00000000-0000-4000-8000-0000000000a1";
const messagesConnectionId = "con_00000000-0000-4000-8000-0000000000c1";

function messagesNeedsFullDiskAccess() {
  return {
    definitionId: "apple-messages",
    operations: [
      {
        operation: "query_messages",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      {
        operation: "export_attachment",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      {
        operation: "send_message",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
    ],
  };
}

/** A Mac that is here and reporting the app, as the Host projects it. */
function mac(
  overrides: {
    readonly apps?: readonly object[];
    readonly device?: object;
    readonly id?: string;
    readonly name?: string;
    readonly status?: string;
  } = {},
) {
  return {
    ...(overrides.device === undefined ? {} : { device: overrides.device }),
    apps: overrides.apps ?? [
      {
        definitionId: "apple-messages",
        operations: [
          { operation: "query_messages", detail: null, remedy: null, state: "ready" },
          { operation: "export_attachment", detail: null, remedy: null, state: "ready" },
          { operation: "send_message", detail: null, remedy: null, state: "ready" },
        ],
      },
    ],
    id: overrides.id ?? macMiniId,
    // The module the computer advertises is what makes silence mean "checking"
    // rather than "not available", so the fixture states it.
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: overrides.name ?? "Mac mini",
    status: overrides.status ?? "online",
  };
}

function computerConnection(
  access: "read" | "read-write",
  overrides: {
    readonly displayName?: string;
    readonly id?: string;
    readonly runnerId?: string;
  } = {},
) {
  return {
    accountIdentifier: null,
    authMethodId: "computer",
    computer: { access, runnerId: overrides.runnerId ?? macMiniId },
    connectionMethod: "computer",
    createdAt: "2026-09-17T00:00:00.000Z",
    definitionId: "apple-messages",
    displayName: overrides.displayName ?? "Mac mini",
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: overrides.id ?? messagesConnectionId,
    provider: "apple-messages",
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

/**
 * A newer Host's installed Calendar, which also lists an iPhone and a platform
 * this client has never heard of.
 */
function calendarPlatform() {
  const base = computerPlatform();
  const [entry] = base.installations;
  return {
    ...base,
    installations: [
      {
        ...entry!,
        installation: {
          ...entry!.installation,
          manifest: {
            definition: {
              adapter: "computer",
              authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
              computerApp: {
                accessLabels: { read: "Can read", readWrite: "Can read and change" },
                accessLevels: ["read", "read-write"],
                operations: [
                  { name: "list_events", effect: "read" },
                  { name: "create_event", effect: "write" },
                ],
                accessSummaries: {
                  read: "Allows reading calendars and events.",
                  readWrite: "Allows reading calendars and events, and changing events.",
                },
                platforms: ["darwin", "ios", "future-phone-os"],
              },
              description: "Read and change Calendar.",
              id: "apple-calendar",
              name: "Calendar",
              provider: "apple-calendar",
            },
          },
          title: "Calendar",
        },
        servers: entry!.servers.map((server) => ({
          ...server,
          connectionRequirement: { definitionId: "apple-calendar", kind: "computer" },
        })),
      },
    ],
  };
}

/** The installed Messages app, exactly as the catalog describes it. */
function computerPlatform() {
  return {
    authorizationSurface: "canonical",
    catalog: [],
    connections: [],
    installations: [
      {
        installation: {
          id: "iin_00000000-0000-4000-8000-000000000001",
          manifest: {
            definition: {
              adapter: "computer",
              authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
              computerApp: {
                accessLabels: { read: "Read only", readWrite: "Read and send" },
                accessLevels: ["read", "read-write"],
                operations: [
                  { name: "query_messages", effect: "read" },
                  { name: "export_attachment", effect: "read" },
                  { name: "send_message", effect: "write" },
                ],
                accessSummaries: {
                  read: "Agents can search and read your conversations.",
                  readWrite:
                    "Agents can search and read your conversations, and send messages as you. Sending may ask for permission on this Mac.",
                },
                platforms: ["darwin"],
              },
              description: "Search, read, and send Apple Messages through an enrolled Mac.",
              id: "apple-messages",
              name: "Apple Messages",
              provider: "apple-messages",
            },
          },
          status: "active",
          title: "Apple Messages",
        },
        servers: [
          {
            connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
            id: "isv_00000000-0000-4000-8000-000000000001",
            name: "live",
            status: "active",
          },
        ],
        skills: [],
        tools: [
          {
            annotations: { readOnlyHint: true },
            connectionId: messagesConnectionId,
            description: "Read messages",
            id: "itl_00000000-0000-4000-8000-000000000001",
            name: "export_attachment",
            schemaDigest: "d".repeat(43),
            serverId: "isv_00000000-0000-4000-8000-000000000001",
            status: "active",
            title: "Read messages",
          },
        ],
      },
    ],
  };
}

vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
