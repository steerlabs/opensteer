// @vitest-environment happy-dom

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
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (client: { getSnapshot: () => unknown }, select: (value: unknown) => unknown) =>
    select(client.getSnapshot()),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: {
    alert: (_title: string, message: string, buttons: { onPress?: () => void; text: string }[]) => {
      state.alert = { buttons, message, title: _title };
    },
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
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
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../theme.js", () => ({
  color: {},
  material: { mark: {} },
  radius: {},
  space: {},
  touchTarget: 44,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/workspace-mark.js", () => ({ WorkspaceDot: () => null }));
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

async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<BrowserProfilesScreen route={{ params: { deploymentId: "deployment-a" } }} />),
  );
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
  const snapshot = {
    connection: "connected",
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
    browserProfileGrants: [
      { id: "grant-research", profileId: "bpr_work", workspaceId: "wsp_research" },
    ],
    workspaces: [
      { id: "wsp_research", name: "Research", kind: "specialized" },
      { id: "wsp_buyer", name: "Buyer", kind: "specialized" },
    ],
    browserTabGroups: [],
    workspaceTabs: [],
    workspaceTabRestoreVersion: 1,
    activatingWorkspaceTabs: [],
    browserSessions: [],
    browserPlacements: [],
    machines: [],
  };
  const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
  state.hostClient = { dispatch, getSnapshot: () => snapshot };
  return { dispatch, snapshot };
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
    expect(text()).toContain("Opensteer can use every profile.");
    expect(text().indexOf("Personal")).toBeLessThan(text().indexOf("Work"));
    await press("Work, Opensteer and Research");
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
      "Its sign-ins and site data are erased from this Opensteer. Research loses access. This can’t be undone.",
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

  it("hides Rename and Delete on older Hosts and still manages specialists", async () => {
    const { dispatch } = host(false);
    await render();
    await press("Work, Opensteer and Research");
    expect(text()).not.toContain("Rename");
    expect(text()).not.toContain("Delete");
    await press("Specialists");
    await press("Research");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "browser.profileGrant.revoke", grantId: "grant-research" }),
    );
    await press("Buyer");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "browser.profile.grant",
        profileId: "bpr_work",
        workspaceId: "wsp_buyer",
      }),
    );
  });

  it("creates from the empty state and shows mutation failures inline", async () => {
    const { dispatch } = host(true, true);
    await render();
    expect(text()).toContain("No profiles yet.");
    await press("New profile");
    await typeName("Travel");
    dispatch.mockRejectedValueOnce(new Error("Try again later"));
    await press("Create profile");
    expect(text()).toContain("Try again later");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "browser.profile.create",
        input: { name: "Travel" },
        idempotencyKey: expect.stringContaining("browser-profile"),
      }),
    );
  });
});
