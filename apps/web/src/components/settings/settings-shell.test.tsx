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
import { describe, expect, it, vi } from "vitest";
import { ShellContext, useShell } from "../app-shell.js";
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
let shellSeenBySettings: ShellContext | null = null;

function ShellProbe() {
  shellSeenBySettings = useShell();
  return null;
}

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

  it("gives pages under Settings its own way to open navigation, not the shell's", () => {
    const shellNavigation = vi.fn();
    renderSettings(
      { ...placementFixtures().browser, openMobileNavigation: shellNavigation },
      "/settings/shell-probe",
    );
    expect(shellSeenBySettings?.openMobileNavigation).toEqual(expect.any(Function));
    expect(shellSeenBySettings?.openMobileNavigation).not.toBe(shellNavigation);
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

  it("keeps Use from anywhere and signed-in devices on the Account page", () => {
    const context = placementFixtures()["personal-remote"];
    const landing = renderSettings(context, "/settings/account");
    expect(landing).toContain("Use from anywhere");
    expect(landing).toContain("Signed-in devices");
    expect(landing).toContain("Loading devices");
    expect(landing).not.toContain('href="/settings/account/');
    // External agents have their own page and load only when it opens.
    expect(landing).not.toContain("external agents");
    expect(renderSettings(context, "/settings/external-agents")).toContain(
      "Loading external agents…",
    );
  });

  it("gives a signed-in machine-owner browser the same Account page", () => {
    for (const sessionSurface of [undefined, "personal-remote" as const]) {
      const snapshot = sessionSurface
        ? { ...machineOwnerSnapshot(), sessionSurface }
        : machineOwnerSnapshot();
      const html = renderSettings(
        { ...placementFixtures().browser, snapshot },
        "/settings/account",
      );
      expect(html).toContain("Use from anywhere");
      expect(html).toContain("Signed-in devices");
      expect(html).not.toContain("turn on remote access in the Opensteer app");
    }
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
    expect(account).toContain("Checking…");
    expect(account).not.toContain('value="connect"');
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
      deployment: { kind: "team", name: null },
      machineOwner: false,
      publicOrigin: "https://steer.example.test",
    } as HostSnapshot["identityConfig"],
    user: base.user ? { ...base.user, email: placeholderEmail } : null,
  };
  const context: ShellContext = {
    actionError: null,
    clearActionError: noOp,
    createThreadAndSend: () => Promise.reject(new Error("Not in this test.")),
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: null,
    desktopDeployment: null,
    executionPreferences: emptyExecutionPreferences,
    hostClient,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: null,
    addHarnessAccount: null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    placements: [],
    performLocalExecutionAction: async () => undefined,
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    snapshot,
    ...overrides,
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          element={
            <ShellContext value={context}>
              <Outlet />
            </ShellContext>
          }
        >
          <Route element={<SettingsShell />} path="settings">
            <Route index element={<SettingsSectionRoute section="ai-engines" />} />
            <Route element={<SettingsSectionRoute section="ai-engines" />} path="ai-engines" />
            <Route element={<SettingsSectionRoute section="account" />} path="account/*" />
            <Route element={<SettingsSectionRoute section="devices" />} path="devices" />
            <Route element={<SettingsSectionRoute section="general" />} path="general" />
            <Route
              element={<SettingsSectionRoute section="external-agents" />}
              path="external-agents"
            />
            <Route element={<p>Connected apps route</p>} path="apps/*" />
            <Route element={<p>Computers route</p>} path="computers/*" />
            <Route element={<ShellProbe />} path="shell-probe" />
            <Route element={<SettingsNotFound />} path="*" />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function placementFixtures(): Readonly<Record<SettingsScenario, Partial<ShellContext>>> {
  const personal = personalDeployment();
  const server = { ...serverDeployment(), kind: "team" as const, name: "home-server" };
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
    kind: "team",
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
