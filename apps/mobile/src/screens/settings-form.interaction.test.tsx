// @vitest-environment happy-dom

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
 * - a build without an Account service shows notification rows that can do
 *   nothing.
 */

vi.mock("react-native", () => ({ Linking: { openURL: vi.fn() } }));
vi.mock("../theme.js", () => ({ color: new Proxy({}, { get: () => "#000000" }) }));
vi.mock(
  "@expo/ui/jetpack-compose",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).compose,
);
vi.mock(
  "@expo/ui/jetpack-compose/modifiers",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).composeModifiers,
);

const { SettingsForm } = await import("../../test-support/settings-form-fixture.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Settings on a phone", () => {
  it("keeps General separate from Account and agent access", async () => {
    await render({ page: "general" });
    expect(document.body.textContent).toContain("About");
    expect(document.body.textContent).toContain("Notifications");
    expect(document.body.textContent).not.toContain("Chrome");
  });
  it("keeps Sign-ins distinct from Plugins and accounts agents use", async () => {
    await render({ page: "sign-ins" });
    expect(document.body.textContent).toContain("Chrome");
    expect(document.body.textContent).toContain("Passwords");
    expect(document.body.textContent).not.toContain("Plugins");
    expect(document.body.textContent).not.toContain("About");
  });

  it("opens the deployment switcher from the current deployment's row", async () => {
    const onDeploymentAction = vi.fn();
    await render({ onDeploymentAction });
    await act(async () => rowTitled("Mac mini")?.click());
    expect(onDeploymentAction).toHaveBeenCalledOnce();
  });

  it("lists each sign-in page, says where Passwords are kept, and opens each", async () => {
    const signIns = {
      onBrowserProfiles: vi.fn(),
      onChrome: vi.fn(),
      onConnectedApps: vi.fn(),
      onPlugins: vi.fn(),
    };
    const onPasswordsAction = vi.fn();
    await render({ onPasswordsAction, signIns });
    expect(document.body.textContent).toContain("For agents");
    const rows = [...document.querySelectorAll("button")].map((button) => button.textContent);
    expect(
      rows.slice(rows.indexOf("ConnectionsGmail, GitHub and the other accounts agents use")),
    ).toEqual([
      "ConnectionsGmail, GitHub and the other accounts agents use",
      "PluginsSkills, tools and specialists for your agents",
      "ChromeYour Chrome and the sites agents can sign in to",
      "Browser profilesSeparate browsers with their own sign-ins",
      "PasswordsKept on Mac mini",
    ]);
    await act(async () => rowTitled("Passwords")?.click());
    expect(onPasswordsAction).toHaveBeenCalledOnce();
    expect(signIns.onChrome).not.toHaveBeenCalled();
    await act(async () => rowTitled("Browser profiles")?.click());
    expect(signIns.onBrowserProfiles).toHaveBeenCalledOnce();
    await act(async () => rowTitled("Chrome")?.click());
    expect(signIns.onChrome).toHaveBeenCalledOnce();
    await act(async () => rowTitled("Plugins")?.click());
    expect(signIns.onPlugins).toHaveBeenCalledOnce();
  });

  it("shows no sign-ins while no Deployment is open", async () => {
    await render({ passwords: null, signIns: null });
    expect(document.body.textContent).not.toContain("For agents");
    expect(document.body.textContent).not.toContain("Passwords");
  });

  it("shows no notifications in a build without an Account service", async () => {
    await render({ notifications: null });
    expect(document.body.textContent).not.toContain("Notifications");
    expect(document.body.textContent).toContain("Version");
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
    expect(document.body.textContent).toContain("AI");
    expect(document.body.textContent).toContain("Update available · 0.166.0");
    const update = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Update",
    );
    await act(async () => update?.click());
    expect(onEngineUpdate).toHaveBeenCalledWith("env_1", "codex");
  });
});

/** The row whose first line is `title`: Android rows are a title over a detail. */
function rowTitled(title: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    ) ?? null
  );
}

async function render(overrides: Partial<SettingsFormProps>): Promise<void> {
  const props: SettingsFormProps = {
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
    signIns: {
      onBrowserProfiles: vi.fn(),
      onChrome: vi.fn(),
      onConnectedApps: vi.fn(),
      onPlugins: vi.fn(),
    },
    desktopUpdate: null,
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
