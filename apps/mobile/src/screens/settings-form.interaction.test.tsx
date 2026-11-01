// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsFormProps } from "./settings-form.types.js";

/*
 * How the phone's Settings could misdirect or clutter:
 * - the current Deployment row doesn't open the switcher, or something else
 *   switches deployments;
 * - a sign-in page is missing while a Deployment is open, shows with none
 *   open, or opens the wrong page; Passwords doesn't say where they're kept;
 * - a build without an Account service shows Account or notification rows
 *   that can do nothing.
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
  View: ({
    accessibilityLabel,
    children,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
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

describe("Settings on a phone", () => {
  it("opens the deployment switcher from the current deployment's row", async () => {
    const onDeploymentAction = vi.fn();
    await render({ onDeploymentAction });
    await act(async () => buttonLabelled("Mac mini, Connected. Switch")?.click());
    expect(onDeploymentAction).toHaveBeenCalledOnce();
  });

  it("lists each sign-in page, says where Passwords are kept, and opens each", async () => {
    const signIns = { onBrowserProfiles: vi.fn(), onChrome: vi.fn(), onConnectedApps: vi.fn() };
    const onPasswordsAction = vi.fn();
    await render({ onPasswordsAction, signIns });
    expect(document.body.textContent).toContain("Sign-ins");
    expect(labels().slice(1)).toEqual([
      "Connected apps, Gmail, GitHub and the other accounts agents use",
      "Chrome, Your Chrome and the sites agents can sign in to",
      "Browser profiles, Separate browsers with their own sign-ins",
      "Passwords, Kept on Mac mini",
    ]);
    await act(async () => buttonLabelled("Passwords, Kept on Mac mini")?.click());
    expect(onPasswordsAction).toHaveBeenCalledOnce();
    expect(signIns.onChrome).not.toHaveBeenCalled();
    await act(async () =>
      buttonLabelled("Browser profiles, Separate browsers with their own sign-ins")?.click(),
    );
    expect(signIns.onBrowserProfiles).toHaveBeenCalledOnce();
    await act(async () =>
      buttonLabelled("Chrome, Your Chrome and the sites agents can sign in to")?.click(),
    );
    expect(signIns.onChrome).toHaveBeenCalledOnce();
  });

  it("shows no sign-ins while no Deployment is open", async () => {
    await render({ passwords: null, signIns: null });
    expect(document.body.textContent).not.toContain("Sign-ins");
    expect(document.body.textContent).not.toContain("Passwords");
  });

  it("shows no Account or notifications in a build without an Account service", async () => {
    await render({ account: null, notifications: null });
    expect(document.body.textContent).not.toContain("Opensteer Account");
    expect(document.body.textContent).not.toContain("Notifications");
    expect(document.body.textContent).toContain("Version");
  });
});

function labels(): readonly (string | null)[] {
  return [...document.querySelectorAll("[aria-label]")].map((row) =>
    row.getAttribute("aria-label"),
  );
}

function buttonLabelled(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`);
}

async function render(overrides: Partial<SettingsFormProps>): Promise<void> {
  const props: SettingsFormProps = {
    account: { action: null, detail: null, initial: null, subtitle: null, title: "Signed out" },
    accountError: null,
    agents: [],
    computers: [],
    deployment: {
      action: { disabled: false, kind: "switch-deployment", label: "Switch" },
      mark: null,
      status: "Connected",
      title: "Mac mini",
    },
    notificationError: null,
    notifications: {
      action: null,
      detail: null,
      disabled: false,
      footer: "",
      preferences: null,
    },
    onAccountAction: vi.fn(),
    onAgentMuteChange: vi.fn(),
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
    signIns: { onBrowserProfiles: vi.fn(), onChrome: vi.fn(), onConnectedApps: vi.fn() },
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
