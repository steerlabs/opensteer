import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import {
  AuthSessionIdSchema,
  createId,
  emptyExecutionPreferences,
  type AuthSessionSummary,
} from "@opensteer/core";
import { threadPlacementOptions, type ThreadPlacementOption } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  DesktopPersonalDeploymentStatusSchema,
  type DeploymentAccessSnapshot,
  type DesktopPersonalDeploymentStatus,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { ShellContext } from "./components/app-shell.js";
import { DesktopPersonalSetup } from "./components/desktop-onboarding.js";
import { SetupOpening } from "./components/first-run/setup-opening.js";
import { SetupPage } from "./components/first-run/setup-page.js";
import { ToastProvider } from "./components/toast.js";

/**
 * Visual QA for first-run setup: every state a person meets between opening
 * the app and Chat, rendered from fixtures so each can be looked at and
 * screenshotted the same way every time. `?scenario=` picks one.
 */
type Scenario =
  | { readonly kind: "booting" | "failed" | "opening" }
  | {
      readonly kind: "setup";
      readonly link: "linked" | "unlinked";
      readonly phones?: readonly AuthSessionSummary[];
      /** Not signed in to the Opensteer account on this Mac, as on a fresh install. */
      readonly signedOut?: boolean;
      readonly pick: (placements: readonly ThreadPlacementOption[]) => ThreadPlacementOption[];
      readonly step?: "ai" | "permissions" | "phone";
    };

const mobileSession = (label: string): AuthSessionSummary => ({
  absoluteExpiresAt: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-11-03T10:05:00.000Z",
  current: false,
  deviceLabel: label,
  expiresAt: "2026-12-01T00:00:00.000Z",
  form: "mobile",
  id: AuthSessionIdSchema.parse(createId("authSession")),
  lastSeenAt: "2026-11-03T10:05:00.000Z",
});

const firstOf = (driverKind: string, placements: readonly ThreadPlacementOption[]) =>
  placements.filter((placement) => placement.driverKind === driverKind).slice(0, 1);

const scenarios: Readonly<Record<string, Scenario>> = {
  booting: { kind: "booting" },
  failed: { kind: "failed" },
  opening: { kind: "opening" },
  ready: { kind: "setup", link: "unlinked", pick: (all) => firstOf("claude", all) },
  choose: {
    kind: "setup",
    link: "unlinked",
    pick: (all) => [
      ...firstOf("claude", all).map((placement): ThreadPlacementOption => ({
        ...placement,
        available: false,
        availability: "authentication-required",
      })),
      ...firstOf("codex", all).map((placement): ThreadPlacementOption => ({
        ...placement,
        available: false,
        availability: "preparing",
      })),
    ],
  },
  permissions: {
    kind: "setup",
    link: "unlinked",
    pick: (all) => firstOf("claude", all),
    step: "permissions",
  },
  phone: { kind: "setup", link: "linked", pick: (all) => firstOf("claude", all), step: "phone" },
  "phone-off": {
    kind: "setup",
    link: "unlinked",
    pick: (all) => firstOf("claude", all),
    step: "phone",
  },
  "phone-signed-out": {
    kind: "setup",
    link: "unlinked",
    pick: (all) => firstOf("claude", all),
    signedOut: true,
    step: "phone",
  },
  "phone-signed-in": {
    kind: "setup",
    link: "linked",
    phones: [mobileSession("Opensteer on iPhone")],
    pick: (all) => firstOf("claude", all),
    step: "phone",
  },
};

const search = new URLSearchParams(location.search);
const scenario = scenarios[search.get("scenario") ?? "ready"] ?? scenarios["ready"]!;
const noOp = () => undefined;

function personal(overrides: Partial<DesktopPersonalDeploymentStatus>) {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: true,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "starting", version: null },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "ready", version: "18" },
      runner: { state: "stopped", version: null },
    },
    deploymentId: null,
    environmentId: null,
    issue: null,
    schemaVersion: 1,
    state: "starting",
    step: "preparing-database",
    ...overrides,
  });
}

function render(node: React.ReactNode) {
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing root");
  createRoot(container).render(<ToastProvider>{node}</ToastProvider>);
}

if (scenario.kind !== "setup") {
  if (scenario.kind === "booting") {
    render(
      <DesktopPersonalSetup
        actionError={null}
        computerName="Studio Mac"
        firstRun
        onBack={noOp}
        onRetry={noOp}
        status={personal({})}
      />,
    );
  } else if (scenario.kind === "failed") {
    render(
      <DesktopPersonalSetup
        actionError={null}
        computerName="Studio Mac"
        onBack={noOp}
        onRetry={noOp}
        status={personal({
          issue: {
            code: "database-unavailable",
            component: "postgresql",
            detail: "Another app is using port 5432. Quit it, then try again.",
            repairAction: "restart-opensteer",
          },
          state: "repair-required",
          step: null,
        })}
      />,
    );
  } else if (scenario.kind === "opening") {
    render(<SetupOpening />);
  }
} else {
  const client = new MockHostClient({
    latencyMs: 0,
    sessions: scenario.phones ?? [],
    world: "first-run",
  });
  const base = client.getSnapshot();
  const all = threadPlacementOptions(base.environments, base.harnesses);
  const placements = scenario
    .pick(all)
    .map((placement) => ({ ...placement, environmentKind: "main" as const }));
  const linked = scenario.link === "linked";
  const remote = {
    access: {
      accountLink: linked ? { state: "active" } : null,
      generation: 1,
      mode: linked ? "connect" : "off",
      route: linked ? { document: { route: { origin: "https://studio.connect.test" } } } : null,
      schemaVersion: 2,
    },
    accountIssuer: "https://accounts.opensteer.com",
    executorConnected: true,
    operation: null,
    revision: 1,
  };
  // Connect is the Account service's; the fixture stands in for its status.
  Object.assign(client.rpc, {
    "personal.remoteAccess.get": async () => ({ data: remote, ok: true }),
  });
  // This Mac's own Opensteer, so Connect signs in and links the way the app does.
  let access = {
    account: { available: true, status: scenario.signedOut ? "signed-out" : "signed-in" },
    personalAccountLink: { status: scenario.link },
    personalSetup: { deploymentId: base.deploymentId },
  } as unknown as DeploymentAccessSnapshot;
  const accessListeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  const bridge = {
    computerUsePermissionsGet: async () => ({
      accessibility: "granted",
      screenRecording: "denied",
    }),
    getDeploymentAccessSnapshot: async () => access,
    linkPersonal: async () => undefined,
    onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
      accessListeners.add(listener);
      return () => accessListeners.delete(listener);
    },
    cancel: async () => {
      access = { ...access, account: { ...access.account, status: "signed-out" } };
      for (const listener of accessListeners) listener(access);
    },
    // The browser's sign-in stays open, so the step it waits on can be looked at.
    signIn: async () => {
      access = { ...access, account: { ...access.account, status: "authorizing" } };
      for (const listener of accessListeners) listener(access);
    },
    onPasswordsStatusChanged: () => noOp,
    openComputerUsePermissionsPanel: async () => ({ opened: true }),
    openExternalUrl: async () => ({ opened: true }),
    openNotificationSettings: async () => undefined,
    passwordsOpen: async () => undefined,
    passwordsStatus: async () => ({
      availability: "available",
      broker: { agentSignIns: "off", vault: "not-set-up" },
      development: false,
    }),
    recheckLocalEngines: async () => undefined,
    tailscaleShare: async () => ({ ok: true, origin: "https://studio.tail2f9.ts.net" }),
    tailscaleStatus: async () => ({
      dnsName: "studio.tail2f9.ts.net",
      sharedOrigin: null,
      state: "ready",
    }),
    testNotification: async () => ({ outcome: "sent" }),
    unlinkPersonal: async () => undefined,
  } as unknown as OpensteerDesktopBridge;
  if (scenario.step) {
    localStorage.setItem(`opensteer.setup.v1:${base.deploymentId}`, scenario.step);
  } else {
    localStorage.removeItem(`opensteer.setup.v1:${base.deploymentId}`);
  }
  const snapshot: ShellContext["snapshot"] = {
    ...base,
    connection: "connected",
    identityConfig: base.identityConfig && {
      ...base.identityConfig,
      deployment: { kind: "personal", name: "Studio Mac" },
      portalOrigin: "https://app.opensteer.com",
    },
  };
  const context = {
    deploymentAccess: access,
    desktopBridge: bridge,
    desktopDeployment: { kind: "personal", name: "Studio Mac", onThisComputer: true },
    executionPreferences: emptyExecutionPreferences,
    hostClient: client,
    addHarnessAccount: null,
    openHarnessAuthentication: noOp,
    placements,
    refreshHarnessCatalog: async () => undefined,
    snapshot,
  } as unknown as ShellContext;
  render(
    <MemoryRouter initialEntries={["/get-started"]}>
      <div className="app-shell app-shell--settings app-shell--setup">
        <main className="app-shell__main">
          <Routes>
            <Route
              element={
                <ShellContext value={context}>
                  <Outlet />
                </ShellContext>
              }
            >
              <Route element={<SetupPage />} path="get-started" />
              <Route element={<p>Chat</p>} path="/" />
            </Route>
          </Routes>
        </main>
      </div>
    </MemoryRouter>,
  );
}
