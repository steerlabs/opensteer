// @vitest-environment happy-dom

import { createId, emptyExecutionPreferences } from "@opensteer/core";
import type { HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  DeploymentAccessSnapshotSchema,
  DesktopDeploymentSummarySchema,
  type DeploymentAccessSnapshot,
  type DesktopDeploymentSummary,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { ShellContext } from "../app-shell.js";
import { defaultSettingsSection, settingsSectionForPath } from "./copy.js";
import {
  SettingsNotFound,
  SettingsSectionRoute,
  SettingsShell,
  settingsStatus,
} from "./settings-shell.js";

const noOp = () => undefined;

/** The address a seeded Personal Host uses internally. It is never a person. */
const placeholderEmail = "owner@personal.opensteer.invalid";

describe("Settings navigation", () => {
  it("defaults to General and treats an unknown child as a real missing setting", () => {
    expect(defaultSettingsSection).toBe("general");
    expect(settingsSectionForPath("/settings")).toBe("general");
    expect(settingsSectionForPath("/settings/apps/tools")).toBe("apps");
    expect(settingsSectionForPath("/settings/not-a-setting")).toBeNull();

    const html = renderSettings(placementFixtures().browser, "/settings/not-a-setting");
    expect(html).toContain("Setting not found");
    expect(html).toContain('href="/settings/ai"');
    expect(html).not.toContain("AI service accounts");
  });
});

describe("Device settings placement", () => {
  it("names where you open Opensteer apart from the computers agents use", () => {
    const personal = renderSettings(placementFixtures()["personal-remote"], "/settings/devices");
    const server = renderSettings(placementFixtures()["self-hosted"], "/settings/devices");

    expect(personal).toContain(">Devices<");
    expect(server).toContain(">Devices<");
    for (const html of [personal, server]) {
      expect(html).toContain("For your agents");
      expect(html).not.toContain("Your devices");
      expect(html).toContain('href="/settings/devices"');
    }
  });

  it("opens remote access and session children without the Account landing page", () => {
    const context = placementFixtures()["personal-remote"];
    const remote = renderSettings(context, "/settings/account/remote-access");
    expect(remote).toContain("Connection options");
    expect(remote).not.toContain("Where you’re signed in");
    expect(remote).not.toContain("Your account");
    expect(remote).not.toContain("connected agents");
    const session = renderSettings(context, "/settings/account/sessions/session-id");
    expect(session).toContain("Where you’re signed in");
    expect(session).not.toContain("Your account");
    expect(session).not.toContain("Connection options");
    expect(session).not.toContain("connected agents");
    const landing = renderSettings(context, "/settings/account");
    expect(landing).not.toContain("Connection options");
    // Connected agents load with the Account page, after Where you’re signed in.
    expect(landing).toContain("Loading connected agents…");
  });
  it("shows remote access administration on a remote Personal device", () => {
    const html = renderSettings(placementFixtures()["personal-remote"], "/settings/account");

    expect(html).toContain('href="/settings/account/remote-access"');
    expect(html).toContain("Loading devices");
    expect(
      renderSettings(placementFixtures()["personal-remote"], "/settings/account/remote-access"),
    ).toContain("Connection options");
    expect(html).toContain("Where you’re signed in");
  });

  it("gives a signed-in machine-owner browser the same remote access controls", () => {
    const context = { ...placementFixtures().browser, snapshot: machineOwnerSnapshot() };
    const html = renderSettings(context, "/settings/account/remote-access");

    expect(html).toContain('aria-label="Open Opensteer from anywhere"');
    expect(html).toContain("Connection options");
    expect(html).toContain("Connection options");
  });

  it("shows administration to a Personal remote browser", () => {
    const context = {
      ...placementFixtures().browser,
      snapshot: { ...machineOwnerSnapshot(), sessionSurface: "personal-remote" as const },
    };
    const html = renderSettings(context, "/settings/account");

    expect(html).toContain('href="/settings/account/remote-access"');
    expect(html).toContain("Where you’re signed in");
    expect(html).not.toContain("turn on remote access in the Opensteer app");
  });
});

describe("Settings identity honesty", () => {
  it("keeps the private access choice and hides unavailable Account actions", () => {
    const context = placementFixtures()["personal-this-computer"];
    const deploymentAccess = {
      ...context.deploymentAccess!,
      account: { available: false, status: "signed-out" as const },
    };
    const account = renderSettings({ ...context, deploymentAccess }, "/settings/account");
    expect(account).toContain("isn’t available yet");
    expect(account).not.toContain(">Sign in<");
    expect(renderSettings({ ...context, deploymentAccess }, "/settings/general")).not.toContain(
      "Add to your Account",
    );
    const html = renderSettings(
      { ...context, deploymentAccess },
      "/settings/account/remote-access",
    );
    expect(html).toContain("Loading remote access");
    expect(html).not.toContain('value="connect"');
    expect(html).toContain("Connection options");
  });

  it("never renders the seeded machine-owner address in any placement", () => {
    for (const [placement, context] of Object.entries(placementFixtures())) {
      for (const path of [
        "/settings/general",
        "/settings/account",
        "/settings/ai-engines",
        "/settings/devices",
      ]) {
        const html = renderSettings(context, path);
        expect(html, `${placement}${path} keeps the placeholder out`).not.toContain(
          placeholderEmail,
        );
      }
    }
  });

  it("renders no person identity or destructive Account action for a machine owner", () => {
    const context = placementFixtures()["personal-this-computer"];
    const html = ["general", "devices", "account"]
      .map((section) => renderSettings(context, `/settings/${section}`))
      .join("\n");

    expect(html).not.toContain(placeholderEmail);
    expect(html).not.toContain("Signed in to this deployment");
    expect(html).not.toContain("Remove from Account list");
    expect(renderSettings(context, "/settings/general")).toContain("Running here");
  });
});

describe("Settings status", () => {
  it("reads the supervisor status on Desktop and the socket status in a browser", () => {
    expect(
      settingsStatus({
        connection: "offline",
        desktopStatus: { reason: null, status: "ready" },
      }).status,
    ).toBe("ready");
    expect(settingsStatus({ connection: "connected" }).status).toBe("ready");
    expect(settingsStatus({ connection: "connecting" }).status).toBe("starting");
    expect(settingsStatus({ connection: "offline" }).status).toBe("offline");
  });
});

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

type SettingsScenario = "browser" | "self-hosted" | "personal-remote" | "personal-this-computer";

function renderSettings(overrides: Partial<ShellContext>, path: string): string {
  const hostClient = new MockHostClient({ latencyMs: 0 });
  const base = hostClient.getSnapshot();
  const snapshot: HostSnapshot = {
    ...base,
    identityConfig: {
      ...base.identityConfig,
      deployment: { kind: "self-hosted", name: null },
      machineOwner: false,
      publicOrigin: "https://steer.example.test",
    } as HostSnapshot["identityConfig"],
    user: base.user ? { ...base.user, email: placeholderEmail } : null,
  };
  const context: ShellContext = {
    actionError: null,
    clearActionError: noOp,
    askOpensteerAbout: noOp,
    clearHomeHandoff: noOp,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
    voiceThreadId: null,
    setHomeDraft: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: null,
    desktopDeployment: null,
    executionPreferences: emptyExecutionPreferences,
    hostClient,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    placements: [],
    performLocalExecutionAction: async () => undefined,
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    writeInChat: noOp,
    snapshot,
    ...overrides,
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route element={<SettingsShell />} path="settings">
            <Route index element={<SettingsSectionRoute section="ai-engines" />} />
            <Route element={<SettingsSectionRoute section="ai-engines" />} path="ai-engines" />
            <Route element={<SettingsSectionRoute section="account" />} path="account/*" />
            <Route element={<SettingsSectionRoute section="devices" />} path="devices" />
            <Route element={<SettingsSectionRoute section="general" />} path="general" />
            <Route element={<p>Connected apps route</p>} path="apps/*" />
            <Route element={<p>Computers route</p>} path="computers/*" />
            <Route element={<SettingsNotFound />} path="*" />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function placementFixtures(): Readonly<Record<SettingsScenario, Partial<ShellContext>>> {
  const personal = personalDeployment();
  const server = { ...serverDeployment(), kind: "self-hosted" as const, name: "home-server" };
  return {
    browser: {},
    "personal-remote": {
      deploymentAccess: accessSnapshot({ ...personal, access: "connect", onThisComputer: false }),
      desktopBridge: personalBridge(),
      desktopDeployment: { ...personal, access: "connect", onThisComputer: false },
      snapshot: personalRemoteSnapshot(),
    },
    "personal-this-computer": {
      deploymentAccess: accessSnapshot(personal),
      desktopBridge: personalBridge(),
      desktopDeployment: personal,
      snapshot: machineOwnerSnapshot(),
    },
    "self-hosted": {
      deploymentAccess: accessSnapshot(server),
      desktopBridge: personalBridge(),
      desktopDeployment: server,
    },
  };
}

function machineOwnerSnapshot(): HostSnapshot {
  return personalSnapshot(true);
}

function personalRemoteSnapshot(): HostSnapshot {
  // `machineOwner` describes the passwordless Personal deployment, not this
  // request's location. Desktop route facts must still win for a remote app.
  return personalSnapshot(true);
}

function personalSnapshot(machineOwner: boolean): HostSnapshot {
  const client = new MockHostClient({ latencyMs: 0 });
  const base = client.getSnapshot();
  return {
    ...base,
    identityConfig: {
      ...base.identityConfig,
      deployment: { kind: "personal" as const, name: "Mac mini" },
      machineOwner,
    } as HostSnapshot["identityConfig"],
    user: base.user ? { ...base.user, email: placeholderEmail } : null,
  };
}

function personalDeployment(): DesktopDeploymentSummary {
  return DesktopDeploymentSummarySchema.parse({
    activeOrigin: "http://127.0.0.1:43110",
    canonicalOrigin: "http://127.0.0.1:43110",
    id: createId("deployment"),
    kind: "personal" as const,
    lastUsedAt: "2026-08-12T22:00:00.000Z",
    name: "Mac mini",
    access: "owner",
    onThisComputer: true,
    routes: [{ kind: "canonical", origin: "http://127.0.0.1:43110", selected: true }],
  });
}

function serverDeployment(): DesktopDeploymentSummary {
  return DesktopDeploymentSummarySchema.parse({
    activeOrigin: "https://server.example.test",
    canonicalOrigin: "https://server.example.test",
    id: createId("deployment"),
    kind: "self-hosted",
    lastUsedAt: "2026-08-12T22:00:00.000Z",
    name: "Design server",
    access: "native",
    onThisComputer: false,
    routes: [{ kind: "canonical", origin: "https://server.example.test", selected: true }],
  });
}

function accessSnapshot(
  deployment: DesktopDeploymentSummary,
  overrides: Partial<DeploymentAccessSnapshot["deployments"][number]> = {},
): DeploymentAccessSnapshot {
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, email: "person@example.test", status: "signed-in" },
    deployments: [
      {
        ...deployment,
        accountAccess: "member",
        availableActions: [],
        failure: null,
        source: "account",
        status: "connected",
        statusInfo: { reason: null, status: "ready" },
        ...overrides,
      },
    ],
    directoryFailure: null,
    personalAccountLink: {
      account: null,
      deploymentId: deployment.kind === "personal" ? deployment.id : null,
      displayName: deployment.kind === "personal" ? deployment.name : null,
      status: deployment.kind === "personal" ? "unlinked" : "unavailable",
      unlinkStep: null,
    },
    personalSetup: null,
    revision: 4,
    selectedDeploymentId: deployment.id,
    unavailable: [],
  });
}

function personalBridge(): OpensteerDesktopBridge {
  return {
    cancel: noOp,
    getDeploymentAccessSnapshot: noOp,
    linkPersonal: noOp,
    onDeploymentAccessSnapshotChanged: () => noOp,
    signIn: noOp,
    signOut: noOp,
    unlinkPersonal: noOp,
  } as unknown as OpensteerDesktopBridge;
}
