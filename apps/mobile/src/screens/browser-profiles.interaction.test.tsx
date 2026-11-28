import { testHostConnection } from "@opensteer/client/test-support";
// @vitest-environment happy-dom
import { RunnerIdSchema } from "@opensteer/core";
import type { HostSnapshot } from "@opensteer/client/host";
import { tabStoreFixture } from "@opensteer/client/test-support";

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  alert: null as null | {
    buttons: { onPress?: () => void; text: string }[];
    message: string;
    title: string;
  },
  hostClient: null as unknown,
  navigate: vi.fn(),
}));

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: {
    alert: (_title: string, message: string, buttons: { onPress?: () => void; text: string }[]) => {
      state.alert = { buttons, message, title: _title };
    },
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({
    accessibilityLabel,
    children,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("../theme.js", () => ({
  color: {},
  controlFontScaleLimit: 1.5,
  material: { mark: {} },
  radius: {},
  space: {},
  touchTarget: 44,
  type: {},
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../computers/here-device.js", () => ({ useHereDeviceId: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/icon-glyph.js", () => ({ IconGlyph: () => null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ openDeployment: vi.fn() }),
  useMobileState: () => ({
    rows: [{ deploymentId: "deployment-a", name: "Home", signIn: null }],
    selection: { deploymentId: "deployment-a", hostClient: state.hostClient },
  }),
}));
vi.mock("../ui/primitives.js", () => {
  const Button = ({
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
    <button aria-label={accessibilityLabel ?? label} disabled={disabled || busy} onClick={onPress}>
      {busy ? "Working…" : label}
    </button>
  );
  return {
    AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Field: ({
      input,
      label,
    }: {
      input: { value?: string; onChangeText?: (value: string) => void };
      label: string;
    }) => (
      <input
        aria-label={label}
        onChange={(event) => input.onChangeText?.(event.target.value)}
        value={input.value ?? ""}
      />
    ),
    Notice: ({ detail, title }: { detail: string; title: string }) => (
      <div role="note">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    ),
    RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SecondaryButton: Button,
    SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    StatusDot: () => null,
    SwitchRow: ({
      label,
      value,
      disabled,
      onChange,
    }: {
      label: string;
      value: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void;
    }) => (
      <button aria-label={label} disabled={disabled} onClick={() => onChange(!value)}>
        {value ? "Allowed" : "Not allowed"}
      </button>
    ),
  };
});

const { BrowserProfilesScreen } = await import("./browser-profiles.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.alert = null;
});

async function render(): Promise<() => Promise<void>> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const paint = () =>
    root.render(<BrowserProfilesScreen route={{ params: { deploymentId: "deployment-a" } }} />);
  await act(async () => paint());
  return async () => {
    await act(async () => paint());
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No button ${label}: ${text()}`);
  return found;
}

async function press(label: string): Promise<void> {
  await act(async () => button(label).click());
}

function text(): string {
  return document.body.textContent ?? "";
}

function host(manage = true, empty = false) {
  let snapshot = {
    connection: "connected",
    deploymentId: "deployment-a",
    network: "online",
    session: "authenticated",
    user: { id: "user-a" },
    browserProfileManageAvailable: manage,
    browserProfiles: empty
      ? []
      : [
          { id: "bpr_work", name: "Work", revision: 1 },
          { id: "bpr_personal", name: "Personal", revision: 1 },
        ],
    browserProfileDeletions: [] as {
      profileId: string;
      computerId: string;
      state: "pending-computer" | "pending-restart";
    }[],
    browserPools: undefined as HostSnapshot["browserPools"],
    browserSessions: [],
    browserPlacements: [],
    machines: [
      {
        id: "computer-delete",
        selfRunnerId: RunnerIdSchema.parse("rnr_88888888-8888-4888-8888-888888888888"),
        name: "Studio Mac",
        status: "offline",
      },
      {
        id: "restart-device",
        selfRunnerId: RunnerIdSchema.parse("rnr_99999999-9999-4999-8999-999999999999"),
        name: "Desk Mac",
        status: "online",
      },
    ],
    tabs: tabStoreFixture([]),
  };
  const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
  const listeners = new Set<() => void>();
  const client = {
    dispatch,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.assign(client, { connection: testHostConnection(client as never) });
  state.hostClient = client;
  return {
    dispatch,
    snapshot,
    async setBrowserPools(browserPools: HostSnapshot["browserPools"]) {
      await act(async () => {
        snapshot = { ...snapshot, browserPools };
        for (const listener of listeners) listener();
      });
    },
  };
}

async function typeName(name: string): Promise<void> {
  const field = document.querySelector('input[aria-label="Name"]');
  if (!(field instanceof HTMLInputElement)) throw new Error("Name field missing");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, name);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("mobile browser profiles", () => {
  it("lists names and access, renames, and confirms before deleting", async () => {
    const { dispatch } = host();
    await render();
    expect(text()).toContain("Your own agents can use every profile.");
    expect(text().indexOf("Personal")).toBeLessThan(text().indexOf("Work"));
    await press("Work");
    await press("Browsing history for Work");
    expect(state.navigate).toHaveBeenCalledWith("BrowserHistory", {
      deploymentId: "deployment-a",
      profileId: "bpr_work",
    });
    await press("Rename Work");
    await typeName("Studio");
    await press("Save");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "browser.profile.rename",
        profileId: "bpr_work",
        name: "Studio",
        idempotencyKey: expect.any(String),
      }),
    );
    await press("Delete Work");
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "browser.profile.delete" }),
    );
    expect(state.alert?.title).toBe("Delete “Work”?");
    expect(state.alert?.message).toBe(
      "Its sign-ins and site data are erased from this Opensteer. This can’t be undone.",
    );
    await act(async () =>
      state.alert?.buttons.find((entry) => entry.text === "Delete profile")?.onPress?.(),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "browser.profile.delete",
        profileId: "bpr_work",
        idempotencyKey: expect.any(String),
      }),
    );
  });

  it("shows pending disk erasure after profiles leave the list", async () => {
    const { snapshot } = host(true, true);
    snapshot.browserProfileDeletions = [
      {
        profileId: "bpr_deleted_offline",
        computerId: RunnerIdSchema.parse("rnr_88888888-8888-4888-8888-888888888888"),
        state: "pending-computer",
      },
      {
        profileId: "bpr_deleted_restart",
        computerId: RunnerIdSchema.parse("rnr_99999999-9999-4999-8999-999999999999"),
        state: "pending-restart",
      },
    ];
    const repaint = await render();
    expect(text()).toContain("Will be erased when Studio Mac is back online");
    expect(text()).toContain("Erased after Opensteer restarts on Desk Mac");
    expect(document.querySelectorAll('[aria-label^="Delete "]')).toHaveLength(0);
    snapshot.browserProfileDeletions = [];
    await repaint();
    expect(text()).not.toContain("Deleted profile");
  });

  it("updates the erasure row from a browser-pool-only snapshot", async () => {
    const { snapshot, setBrowserPools } = host();
    const machine = snapshot.machines[0]!;
    machine.status = "online";
    snapshot.browserProfileDeletions = [
      { profileId: "bpr_deleted", computerId: machine.selfRunnerId, state: "pending-computer" },
    ];
    const parked = {
      runnerId: machine.selfRunnerId,
      phase: "parked" as const,
      since: "2026-11-28T00:00:00Z",
    };
    snapshot.browserPools = [parked];
    await render();
    expect(text()).toContain("Will be erased when the browser next starts");
    await setBrowserPools([{ ...parked, phase: "running" }]);
    expect(text()).not.toContain("Will be erased when the browser next starts");
    expect(text()).toContain("Not erased yet");
  });

  it("hides Rename and Delete on older Hosts", async () => {
    host(false);
    await render();
    await press("Work");
    expect(text()).not.toContain("Rename");
    expect(text()).not.toContain("Delete");
  });

  it("creates from the empty state and shows mutation failures inline", async () => {
    const { dispatch } = host(true, true);
    await render();
    expect(text()).toContain("No profiles yet.");
    await press("New profile");
    await typeName("Travel");
    dispatch.mockRejectedValueOnce(new Error("Try again later"));
    await press("Create profile");
    expect(text()).toContain("Couldn't confirm the profile was created.");
    expect(text()).not.toContain("Try again later");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "browser.profile.create",
        input: { name: "Travel" },
        idempotencyKey: expect.stringContaining("browser-profile"),
      }),
    );
  });
});
