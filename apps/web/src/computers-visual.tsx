import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import {
  createId,
  emptyExecutionPreferences,
  RunnerIdSchema,
  type AuthSessionSummary,
} from "@opensteer/core";
import { MockHostClient, mockAgentPhoneRunnerId } from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import {
  DesktopDeploymentSummarySchema,
  type DesktopLocalExecutionStatus,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { ShellContext } from "./components/app-shell.js";
import { ComputerDetailPage, ComputersPage } from "./components/computers-page.js";
import { SettingsShell, SettingsSectionRoute } from "./components/settings/settings-shell.js";
import { ToastProvider } from "./components/toast.js";

/**
 * Visual QA for Computers, Remote access (or Signed-in devices) and the page
 * about this Opensteer: every way a person meets these
 * pages — on the Mac a Personal Opensteer runs on, from another Mac,
 * on a team's own server as an administrator or a member,
 * in a browser — rendered from fixtures so each can be looked at, and
 * screenshotted, the same way every time.
 *
 * `?scenario=` picks the situation and `?path=` the page within it. The
 * phone scenarios show an agent phone in use, one whose access was declined
 * (`/settings/devices/computers/rnr_dddddddd-dddd-4ddd-8ddd-dddddddddddd`) and one
 * paused on the phone; `personal-phone` opens Add a phone from the list.
 * `personal-messages-unfinished` and its `-browser` twin show Messages waiting
 * for Full Disk Access on the Mac mini
 * (`/settings/devices/computers/rnr_11111111-1111-4111-8111-111111111111`): finished
 * there, and pointed to from anywhere else.
 */

const base = new MockHostClient({ latencyMs: 0 }).getSnapshot();
const macMiniId = "rnr_11111111-1111-4111-8111-111111111111";
const slackId = "rnr_22222222-2222-4222-8222-222222222222";
const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
const studioId = "rnr_44444444-4444-4444-8444-444444444444";
const byId = (id: string) => {
  const machine = base.machines.find((candidate) => candidate.id === id);
  if (!machine) throw new Error(`Missing mock machine ${id}`);
  return machine;
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const macMini = byId(macMiniId);
const macbook = byId(laptopId);
const studio = byId(studioId);
/**
 * The agent phone: in use by a Thread, approved to be seen and controlled. Its
 * paused twin has stopped lending its screen on the phone; its declined twin
 * joined, but its owner said no on the phone, so its page asks again.
 */
const agentPhone = byId(mockAgentPhoneRunnerId);
const pausedPhone: MachineSummary = {
  ...agentPhone,
  apps: [
    {
      definitionId: "android-phone",
      operations: ["observe", "act", "release"].map((operation) => ({
        detail: "Paused on the phone",
        operation,
        remedy: null,
        state: "unavailable" as const,
      })),
    },
  ],
  computerUse: agentPhone.computerUse && {
    ...agentPhone.computerUse,
    detail: "Paused on the phone",
    sessions: [],
    state: "unavailable",
  },
};
const declinedPhone: MachineSummary = {
  ...agentPhone,
  computerUse: agentPhone.computerUse && { ...agentPhone.computerUse, sessions: [] },
  id: "rnr_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Galaxy A15",
};
/**
 * The Mac a Personal Opensteer runs on, with Messages allowed to read but
 * macOS Full Disk Access not yet switched on for Opensteer Computer Use: the
 * one step left, which only that Mac can take.
 */
const macMiniMessagesUnfinished: MachineSummary = {
  ...macMini,
  apps: (macMini.apps ?? []).map((app) =>
    app.definitionId === "apple-messages"
      ? {
          ...app,
          operations: app.operations.map((status) => ({
            ...status,
            detail: "Reading Messages needs macOS Full Disk Access.",
            remedy: "full-disk-access" as const,
            state: "permission-required" as const,
          })),
        }
      : app,
  ),
};
const messagingService: MachineSummary = {
  ...byId(slackId),
  name: "Messaging service",
  status: "online",
};
// The approval key the fake bridge reports is already registered, so the page
// shows the settled state rather than trying to register one.
interface Scenario {
  readonly admin: boolean;
  readonly bridge: boolean;
  readonly deployment: {
    readonly access: "connect" | "native" | "owner";
    readonly kind: "personal" | "self-hosted";
    readonly name: string;
    readonly onThisComputer: boolean;
  } | null;
  readonly local: DesktopLocalExecutionStatus | null;
  readonly machines: readonly MachineSummary[];
  readonly name: string;
  readonly origin: string;
  readonly remoteAccess: "off" | "ready";
  /** What `sessions.list` answers: the devices signed in to this Opensteer. */
  readonly sessions: readonly AuthSessionSummary[];
}

function session(input: {
  readonly current?: boolean;
  readonly form: AuthSessionSummary["form"];
  readonly label: string;
  readonly seen: number;
}): AuthSessionSummary {
  return {
    absoluteExpiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    createdAt: minutesAgo(input.seen + 3 * 24 * 60),
    current: input.current ?? false,
    deviceLabel: input.label,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    form: input.form,
    id: createId("authSession"),
    lastSeenAt: minutesAgo(input.seen),
  };
}

/** The Mac mini's own app, signed in once per launch; it is that Mac, not a device. */
const macMiniApp = [
  session({ form: "computer", label: "Opensteer app on Mac", seen: 0 }),
  session({ form: "computer", label: "Opensteer app on Mac", seen: 4_000 }),
];
const phoneApp = session({ form: "mobile", label: "Opensteer app on iOS", seen: 95 });
const officeChrome = session({ form: "computer", label: "Chrome on Windows", seen: 3 * 24 * 60 });
const personalSessions = {
  host: [{ ...macMiniApp[0]!, current: true }, macMiniApp[1]!, phoneApp, officeChrome],
  remote: [
    ...macMiniApp,
    session({ current: true, form: "computer", label: "Opensteer app on Mac", seen: 0 }),
    phoneApp,
  ],
} as const;
function localStatus(input: {
  readonly enrolled: boolean;
  readonly mayRunAgents: boolean;
  readonly runAgents?: boolean;
}): DesktopLocalExecutionStatus {
  return {
    available: true,
    computerName: "Alex’s MacBook Pro",
    deploymentId: createId("deployment"),
    mayRunAgents: input.mayRunAgents,
    platform: "macos",
    runAgents: input.runAgents ?? false,
    runner: {
      detail: input.enrolled ? "Ready" : "Off",
      enrolled: input.enrolled,
      environmentId: input.enrolled ? createId("environment") : null,
      runnerId: input.enrolled ? RunnerIdSchema.parse(laptopId) : null,
      state: input.enrolled ? "running" : "disabled",
    },
    schemaVersion: 4,
  };
}

const personal = {
  admin: true,
  name: "Mac mini",
  origin: "http://127.0.0.1:43100",
} as const;

const scenarios: Readonly<Record<string, Scenario>> = {
  "personal-home": {
    ...personal,
    sessions: personalSessions.host,
    bridge: true,
    deployment: { access: "owner", kind: "personal", name: "Mac mini", onThisComputer: true },
    local: null,
    machines: [macMini, macbook, studio, messagingService],
    remoteAccess: "ready",
  },
  "personal-first-run": {
    ...personal,
    sessions: [{ ...macMiniApp[0]!, current: true }],
    bridge: true,
    deployment: { access: "owner", kind: "personal", name: "Mac mini", onThisComputer: true },
    local: null,
    machines: [{ ...macMini, apps: null, computerUse: null }, messagingService],
    remoteAccess: "off",
  },
  "personal-remote-offer": {
    ...personal,
    sessions: personalSessions.remote,
    bridge: true,
    deployment: { access: "connect", kind: "personal", name: "Mac mini", onThisComputer: false },
    local: localStatus({ enrolled: false, mayRunAgents: false }),
    machines: [macMini, studio, messagingService],
    remoteAccess: "ready",
  },
  "personal-remote-added": {
    ...personal,
    sessions: personalSessions.remote,
    bridge: true,
    deployment: { access: "connect", kind: "personal", name: "Mac mini", onThisComputer: false },
    local: localStatus({ enrolled: true, mayRunAgents: false }),
    machines: [
      macMini,
      {
        ...macbook,
        access: macbook.access && {
          ...macbook.access,
          policy: { ...macbook.access.policy, reach: "nobody", shares: [] },
        },
        apps: null,
        computerUse: null,
      },
      studio,
      messagingService,
    ],
    remoteAccess: "ready",
  },
  "personal-phone": {
    ...personal,
    sessions: personalSessions.host,
    bridge: true,
    deployment: { access: "owner", kind: "personal", name: "Mac mini", onThisComputer: true },
    local: null,
    machines: [macMini, macbook, agentPhone, declinedPhone, messagingService],
    remoteAccess: "ready",
  },
  "personal-phone-paused": {
    ...personal,
    sessions: personalSessions.host,
    bridge: false,
    deployment: null,
    local: null,
    machines: [macMini, pausedPhone, messagingService],
    remoteAccess: "ready",
  },
  "personal-browser": {
    ...personal,
    sessions: personalSessions.remote,
    bridge: false,
    deployment: null,
    local: null,
    machines: [macMini, macbook, studio, messagingService],
    remoteAccess: "ready",
  },
  // Messages' Full Disk Access is still off on the Mac mini, seen on it…
  "personal-messages-unfinished": {
    ...personal,
    sessions: personalSessions.host,
    bridge: true,
    deployment: { access: "owner", kind: "personal", name: "Mac mini", onThisComputer: true },
    local: null,
    machines: [macMiniMessagesUnfinished, macbook, studio, messagingService],
    remoteAccess: "ready",
  },
  // …and from a browser anywhere else.
  "personal-messages-unfinished-browser": {
    ...personal,
    sessions: personalSessions.remote,
    bridge: false,
    deployment: null,
    local: null,
    machines: [macMiniMessagesUnfinished, macbook, studio, messagingService],
    remoteAccess: "ready",
  },
};

function fakeBridge(_scenario: Scenario): OpensteerDesktopBridge {
  return {
    // The visual build carries no Agent Phone app, as a development build without it.
    readAgentPhoneArtifact: async () => null,
    onUsbDeviceChoice: () => () => undefined,
    chooseUsbDevice: async () => undefined,
    checkFullDiskAccess: async () => ({ granted: true }),
    // The setup panel is macOS's other window; the page only asks for it.
    openComputerAppSetup: async () => ({ opened: true }),
    onPasswordsStatusChanged: () => () => undefined,
    passwordsOpen: async () => undefined,
    passwordsStatus: async () => ({
      availability: "available",
      broker: { agentSignIns: "on", vault: "ready" },
      development: false,
    }),
  } as unknown as OpensteerDesktopBridge;
}

const search = new URLSearchParams(location.search);
const scenario =
  scenarios[search.get("scenario") ?? "personal-home"] ?? scenarios["personal-home"]!;
const path = search.get("path") ?? "/settings/devices/computers";
const client = new MockHostClient({ latencyMs: 0, sessions: scenario.sessions });
const snapshot: ShellContext["snapshot"] = {
  ...base,
  connection: "connected",
  identityConfig: base.identityConfig && {
    ...base.identityConfig,
    deployment: { kind: "personal", name: scenario.name },
    publicOrigin: scenario.origin,
  },
  machines: [...scenario.machines],
};
const desktopDeployment = scenario.deployment
  ? DesktopDeploymentSummarySchema.parse({
      access: scenario.deployment.access,
      activeOrigin: scenario.origin,
      canonicalOrigin: scenario.origin,
      id: scenario.local?.deploymentId ?? createId("deployment"),
      kind: scenario.deployment.kind,
      lastUsedAt: null,
      name: scenario.deployment.name,
      onThisComputer: scenario.deployment.onThisComputer,
      routes: [{ kind: "canonical", origin: scenario.origin, selected: true }],
    })
  : null;
const noOp = () => undefined;
const context: ShellContext = {
  actionError: null,
  clearActionError: noOp,
  createThreadAndSend: async () => {
    throw new Error("Tasks don’t start in this preview.");
  },
  defaultPlacement: undefined,
  deploymentAccess: null,
  desktopBridge: scenario.bridge ? fakeBridge(scenario) : null,
  desktopDeployment,
  executionPreferences: emptyExecutionPreferences,
  hostClient: client,
  localExecutionAction: null,
  localExecutionError: null,
  localExecutionStatus: scenario.local,
  addHarnessAccount: null,
  openHarnessAuthentication: null,
  refreshHarnessCatalog: async () => undefined,
  leaveSettings: noOp,
  openMobileNavigation: noOp,
  performLocalExecutionAction: async () => undefined,
  placements: [],
  rememberExecution: noOp,
  reportActionError: noOp,
  setTaskDone: noOp,
  snapshot,
};

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
createRoot(container).render(
  <ToastProvider>
    <MemoryRouter initialEntries={[path]}>
      <div className="app-shell">
        <main className="app-shell__main">
          <Routes>
            <Route
              element={
                <ShellContext value={context}>
                  <Outlet />
                </ShellContext>
              }
            >
              <Route element={<SettingsShell />} path="settings">
                <Route element={<ComputersPage />} path="computers" />
                <Route element={<ComputerDetailPage />} path="computers/:computerId" />
                <Route element={<SettingsSectionRoute section="devices" />} path="devices" />
                <Route element={<SettingsSectionRoute section="general" />} path="general" />
              </Route>
            </Route>
          </Routes>
        </main>
      </div>
    </MemoryRouter>
  </ToastProvider>,
);
