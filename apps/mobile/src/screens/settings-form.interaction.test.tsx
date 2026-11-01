// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsFormProps } from "./settings-form.types.js";

/*
 * How the phone's Browser settings could hide or misdirect Passwords:
 * - the Passwords row is missing beside Chrome, or shows with no Deployment open;
 * - its line does not say where passwords are kept;
 * - tapping it does nothing, or opens Chrome.
 */

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("../threads/deployment-mark.js", () => ({ DeploymentMarkView: () => null }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  RowGroup: ({ children }: { children: readonly ReactNode[] }) => <div>{children}</div>,
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  SwitchRow: () => null,
}));

const { SettingsForm } = await import("./settings-form.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Settings → Browser on a phone", () => {
  it("lists Passwords beside Chrome, says where they are kept, and opens it", async () => {
    const onChromeAction = vi.fn();
    const onPasswordsAction = vi.fn();
    const onBrowserProfilesAction = vi.fn();
    await render({ onChromeAction, onPasswordsAction, onBrowserProfilesAction });
    const rows = [...document.querySelectorAll("button[aria-label]")].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(rows).toEqual([
      "Chrome, Your Chrome and the sites agents can sign in to",
      "Browser profiles, Separate browsers with their own sign-ins",
      "Passwords, Kept on Mac mini",
    ]);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Passwords, Kept on Mac mini"]')
        ?.click();
    });
    expect(onPasswordsAction).toHaveBeenCalledOnce();
    expect(onChromeAction).not.toHaveBeenCalled();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Browser profiles, Separate browsers with their own sign-ins"]',
        )
        ?.click(),
    );
    expect(onBrowserProfilesAction).toHaveBeenCalledOnce();
  });

  it("shows no Browser settings while no Deployment is open", async () => {
    await render({ onChromeAction: undefined, passwords: null });
    expect(document.body.textContent).not.toContain("Browser");
    expect(document.body.textContent).not.toContain("Passwords");
  });
});

describe("Settings → AI services on a phone", () => {
  it("shows update state and invokes the engine update", async () => {
    const onEngineUpdate = vi.fn();
    await render({
      engineUpdates: [
        {
          detail: "Update available · 0.166.0",
          driverKind: "codex",
          environmentId: "env_1",
          key: "env_1:codex",
          name: "Codex",
          updateEnabled: true,
          updating: false,
        },
      ],
      onEngineUpdate,
    });
    expect(document.body.textContent).toContain("AI services");
    expect(document.body.textContent).toContain("Update available · 0.166.0");
    const update = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Update",
    );
    await act(async () => update?.click());
    expect(onEngineUpdate).toHaveBeenCalledWith("env_1", "codex");
  });
});

async function render(overrides: Partial<SettingsFormProps>): Promise<void> {
  const props: SettingsFormProps = {
    account: { action: null, detail: null, initial: null, subtitle: null, title: "Signed out" },
    accountError: null,
    agents: [],
    computers: [],
    computersFooter: "",
    deployment: {
      action: { disabled: false, kind: "switch-deployment", label: "Switch deployment" },
      mark: null,
      status: "Ready",
      title: "Mac mini",
    },
    notificationError: null,
    notifications: {
      action: null,
      detail: "Notifications are on.",
      disabled: false,
      footer: "",
      preferences: null,
    },
    onAccountAction: vi.fn(),
    onAgentMuteChange: vi.fn(),
    onChromeAction: vi.fn(),
    onComputerAction: vi.fn(),
    onDeploymentAction: vi.fn(),
    onNotificationAction: vi.fn(),
    onPasswordsAction: vi.fn(),
    onPreferenceChange: vi.fn(),
    passwords: {
      body: "Passwords are kept in the Opensteer app on Mac mini. Set them up and manage them there.",
      detail: "Kept on Mac mini",
      facts: [],
      title: "Passwords",
    },
    storageError: null,
    version: "1.0.0",
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SettingsForm {...props} />));
}
