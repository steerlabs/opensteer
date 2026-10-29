// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import type { ComputerUseView } from "@opensteer/client/integrations";
import type { MachineSummary } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  ActivityIndicator: () => <span>Working…</span>,
  Pressable: ({
    accessibilityHint,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityHint?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-checked={accessibilityState?.checked}
      aria-description={accessibilityHint}
      aria-label={accessibilityLabel}
      data-role={accessibilityRole}
      disabled={disabled}
      onClick={onPress}
    >
      {typeof children === "function" ? children({ pressed: false }) : children}
    </button>
  ),
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({
    accessibilityLabel,
    children,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/symbol.js", () => ({
  Symbol: ({ name }: { name: string }) => <i data-symbol={name} />,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail, title }: { detail: string; title: string }) => (
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SectionLabel: ({ children }: { children: string }) => <h3>{children}</h3>,
  SecondaryButton: ({
    accessibilityLabel,
    busy,
    disabled,
    label,
    onPress,
  }: {
    accessibilityLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button
      aria-busy={busy}
      aria-label={accessibilityLabel ?? label}
      disabled={disabled === true || busy === true}
      onClick={onPress}
    >
      {label}
    </button>
  ),
  StatusDot: ({ live, tone }: { live?: boolean; tone: string }) => (
    <i data-live={live === true} data-tone={tone} />
  ),
}));

const { ComputerUseBlock } = await import("./computer-use-block.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mac = "rnr_11111111-1111-4111-8111-111111111111";
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLECOMP1" };
const safari = { bundleId: "com.apple.Safari", displayName: "Safari", teamId: "APPLECOMP1" };
const preview = { bundleId: "com.apple.Preview", displayName: "Preview", teamId: "APPLECOMP1" };
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("ComputerUseBlock on the phone", () => {
  it("turns automatic approval off from the phone and refreshes", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    const refresh = vi.fn(async () => undefined);
    const onChanged = vi.fn(async () => undefined);
    await mount({
      dispatch,
      onChanged,
      refresh,
      view: view({ appApproval: "automatic", apps: [row(notes)] }),
    });
    expect(radio("Allow any app automatically").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain(
      "Apps appear below as agents use them. Block one to keep agents out of it.",
    );

    await click(radio("Ask for each app"));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: { appApproval: "ask", runnerId: mac },
        type: "integration.computer.policy.set",
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("never turns automatic approval on from the phone, and says where it is turned on", async () => {
    const dispatch = vi.fn();
    await mount({ dispatch, view: view({ apps: [row(notes)] }) });
    const automatic = radio("Allow any app automatically");
    expect(automatic.disabled).toBe(true);
    expect(automatic.getAttribute("aria-description")).toBe("Turn this on from Studio.");
    expect(text()).toContain("Turn this on from Studio.");
    await click(automatic);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("removes under ask and blocks under automatic, each in one tap", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    await mount({ dispatch, view: view({ apps: [row(notes)] }) });
    await click(button("Remove Notes"));
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionId: "con_notes", type: "integration.disconnect" }),
    );

    document.body.replaceChildren();
    await mount({ dispatch, view: view({ appApproval: "automatic", apps: [row(notes)] }) });
    await click(button("Block Notes"));
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: "con_notes",
        type: "integration.computer.app.block",
      }),
    );
  });

  it("shows a blocked app as blocked with where it is unblocked, and nothing to press", async () => {
    await mount({ view: view({ apps: [{ ...row(safari), blocked: true }] }) });
    expect(text()).toContain("Blocked");
    expect(text()).toContain("Unblock on Studio");
    expect(maybeButton("Remove Safari")).toBeNull();
    expect(maybeButton("Block Safari")).toBeNull();
  });

  it("says in the row why a change did not happen", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Studio is offline.");
    });
    await mount({ dispatch, view: view({ apps: [row(notes)] }) });
    await click(button("Remove Notes"));
    expect(text()).toContain("Studio is offline.");
    expect(button("Remove Notes").disabled).toBe(false);
  });

  it("lists each live session in the agent's ember with its thread and Stop", async () => {
    const stop = vi.fn(async () => ({ data: {}, ok: true }));
    const onOpenThread = vi.fn();
    await mount({
      onOpenThread,
      rpc: { "integration.computer.session.stop": stop },
      view: view({ apps: [{ ...row(notes), inUse: true }], sessions: [session()] }),
    });
    expect(document.querySelector('[data-tone="ember"][data-live="true"]')).not.toBeNull();
    expect(text()).toContain("Using Notes now.");
    expect(text()).toContain("In use");

    await click(button("Using Notes, Plan the week"));
    expect(onOpenThread).toHaveBeenCalledWith("thr_00000000-0000-4000-8000-000000000001");

    await click(button("Stop Using Notes on Studio"));
    expect(stop).toHaveBeenCalledWith({ sessionId: "cus_1" }, { signal: expect.any(AbortSignal) });
    // The shared Stop: the Thread's line and Watch read the same receipt.
    expect(button("Stopping…").disabled).toBe(true);
  });

  it("names the Mac a pending app is approved on, and declines a task's ask", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    await mount({ dispatch, view: view({ pending: [pending("thr_1")] }) });
    expect(text()).toContain("Can see · Approve on Studio");
    expect(text()).toContain("Asked in Compare the drafts");
    await click(button("Decline Preview"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "00000000-0000-4000-8000-000000000004",
        type: "integration.computer.setup.cancel",
      }),
    );
  });

  it("holds every control while the Host is unreachable", async () => {
    const dispatch = vi.fn();
    await mount({
      canRespond: false,
      dispatch,
      view: view({ appApproval: "automatic", apps: [row(notes)] }),
    });
    expect(button("Block Notes").disabled).toBe(true);
    expect(radio("Ask for each app").disabled).toBe(true);
    await click(radio("Ask for each app"));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

interface MountInput {
  readonly canRespond?: boolean;
  readonly dispatch?: (command: { type: string }) => unknown;
  readonly onChanged?: () => Promise<void>;
  readonly onOpenThread?: (threadId: string) => void;
  readonly refresh?: () => Promise<void>;
  readonly rpc?: Record<string, (input: unknown) => Promise<unknown>>;
  readonly view: ComputerUseView;
}

async function mount(input: MountInput): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const hostClient = {
    dispatch: input.dispatch ?? (async (command: { type: string }) => ({ type: command.type })),
    getSnapshot: () => ({
      deploymentId: "dep_1",
      session: "authenticated",
      user: { id: "usr_1" },
    }),
    refresh: input.refresh ?? (async () => undefined),
    rpc: input.rpc ?? {},
    subscribe: () => () => undefined,
  } as unknown as HostClient;
  await act(async () =>
    root.render(
      <ComputerUseBlock
        canRespond={input.canRespond ?? true}
        hostClient={hostClient}
        machine={{ id: mac, name: "Studio", status: "online" } as MachineSummary}
        onChanged={input.onChanged ?? (async () => undefined)}
        onOpenThread={input.onOpenThread ?? (() => undefined)}
        view={input.view}
      />,
    ),
  );
}

function view(overrides: Partial<ComputerUseView>): ComputerUseView {
  return {
    appApproval: "ask",
    approvalKeyId: `sha256:${"A".repeat(43)}`,
    apps: [],
    definition: { id: "macos-app", name: "Computer use" } as ComputerUseView["definition"],
    pending: [],
    sessions: [],
    state: { kind: "ready" },
    ...overrides,
  };
}

function row(identity: typeof notes): ComputerUseView["apps"][number] {
  return {
    access: "read-write",
    blocked: false,
    connectionId: `con_${identity.displayName.toLowerCase()}`,
    identity,
    inUse: false,
  };
}

function session(): ComputerUseView["sessions"][number] {
  return {
    actionCount: 3,
    apps: [notes],
    openedAt: "2026-09-21T00:00:00.000Z",
    runId: "run_00000000-0000-4000-8000-000000000001",
    sessionId: "cus_1",
    threadId: "thr_00000000-0000-4000-8000-000000000001",
    threadTitle: "Plan the week",
  } as unknown as ComputerUseView["sessions"][number];
}

function pending(threadId: string | null): ComputerUseView["pending"][number] {
  return {
    access: "read",
    identity: preview,
    request: {
      access: "read",
      app: preview,
      id: "00000000-0000-4000-8000-000000000004",
      kind: "app",
      runnerId: mac,
      threadId,
      threadTitle: threadId === null ? null : "Compare the drafts",
    },
  } as unknown as ComputerUseView["pending"][number];
}

function text(): string {
  return document.body.textContent ?? "";
}

function maybeButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    ) ?? null
  );
}

function button(label: string): HTMLButtonElement {
  const found = maybeButton(label);
  if (found === null) throw new Error(`No button labelled ${label}: ${text()}`);
  return found;
}

function radio(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button[data-role="radio"]')].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No radio ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
