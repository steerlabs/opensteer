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
import type { ShellContext } from "./components/app-shell.js";
import { ComputerDetailPage, ComputersPage } from "./components/computers-page.js";
import { SettingsShell, SettingsSectionRoute } from "./components/settings/settings-shell.js";
import { ToastProvider } from "./components/toast.js";

/**
 * Visual QA for Computers, Remote access (or Signed-in devices) and the page
 * about this Opensteer: every way a person meets these
 * pages — on the Mac a Personal Opensteer runs on, from another Mac, on
 * Opensteer Cloud, on a team's own server as an administrator or a member,
 * in a browser — rendered from fixtures so each can be looked at, and
 * screenshotted, the same way every time.
 *
 * `?scenario=` picks the situation and `?path=` the page within it. The
 * phone scenarios show an agent phone in use, one whose access was declined
 * (`/settings/computers/rnr_dddddddd-dddd-4ddd-8ddd-dddddddddddd`) and one
 * paused on the phone; `personal-phone` opens Add a phone from the list.
 * `personal-messages-unfinished` and its `-browser` twin show Messages waiting
 * for Full Disk Access on the Mac mini
 * (`/settings/computers/rnr_11111111-1111-4111-8111-111111111111`): finished
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
const browserService: MachineSummary = {
  ...byId(slackId),
  allowedModules: ["browser", "shell"],
  id: "rnr_55555555-5555-4555-8555-555555555555",
  modules: { browser: { checkedAt: null, detail: null, readiness: "ready" } },
  name: "Browser service",
  status: "online",
};
const agentsModule = { agents: { checkedAt: null, detail: null, readiness: "ready" as const } };
const serverComputer = (input: {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
}): MachineSummary => ({
  ...macMini,
  access: null,
  apps: null,
  computerUse: null,
  detail: null,
  device: { form: "server", platform: "linux" },
  fullDiskAccess: null,
  id: input.id,
  lastSeenAt: input.online ? null : minutesAgo(130),
  localWorkspaces: 0,
  modules: agentsModule,
  name: input.name,
  ownership: "deployment",
  pinnedThreads: 0,
  revocable: true,
  status: input.online ? "online" : "offline",
});
// The approval key the fake bridge reports is already registered, so the page
// shows the settled state rather than trying to register one.
const approvalKeyId = `sha256:${"A".repeat(43)}`;
const macbookWorking: MachineSummary = {
  ...macbook,
  computerUse: macbook.computerUse && { ...macbook.computerUse, approvalKeyId },
  allowedModules: ["agents", "browser", "integrations", "shell"],
  modules: { ...macbook.modules, ...agentsModule },
};
const officeMini: MachineSummary = {
  ...studio,
  device: { form: "compact", platform: "macos" },
  lastSeenAt: minutesAgo(125),
  name: "Office Mac mini",
};

interface Scenario {
  readonly admin: boolean;
  readonly bridge: boolean;
  readonly cloud: boolean;
  readonly deployment: {
    readonly access: "connect" | "native" | "owner";
    readonly kind: "personal" | "self-hosted";
    readonly name: string;
    readonly onThisComputer: boolean;
  } | null;
  readonly kind: "personal" | "server";
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
  readonly machineLocal?: boolean;
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
    machineLocal: input.machineLocal ?? false,
  };
}

/** The Mac mini's own app, signed in once per launch; it is that Mac, not a device. */
const macMiniApp = [
  session({ form: "computer", label: "Opensteer app on Mac", machineLocal: true, seen: 0 }),
  session({ form: "computer", label: "Opensteer app on Mac", machineLocal: true, seen: 4_000 }),
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
const serverSessions = [
  session({ current: true, form: "computer", label: "Chrome on Mac", seen: 0 }),
  phoneApp,
  session({ form: "mobile", label: "Safari on iPad", seen: 9 * 24 * 60 }),
];

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
    portableFs: {
      binaryPath: null,
      detail: "Not installed",
      installAvailable: true,
      issue: null,
      state: "missing",
      version: null,
    },
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
  cloud: false,
  kind: "personal",
  name: "Mac mini",
  origin: "http://127.0.0.1:43100",
} as const;
const cloudBase = {
  admin: true,
  cloud: true,
  kind: "server",
  name: "Acme Research",
  origin: "https://acme-research.opensteer.cloud",
  remoteAccess: "ready",
} as const;
const cloudMachines = [
  serverComputer({
    id: "rnr_66666666-6666-4666-8666-666666666666",
    name: "Main computer",
    online: true,
  }),
  browserService,
  messagingService,
];
const teamBase = {
  cloud: false,
  kind: "server",
  name: "Acme",
  origin: "https://acme.example.com",
  remoteAccess: "ready",
} as const;
const teamMachines: readonly MachineSummary[] = [
  serverComputer({
    id: "rnr_77777777-7777-4777-8777-777777777777",
    name: "build-01",
    online: true,
  }),
  serverComputer({
    id: "rnr_88888888-8888-4888-8888-888888888888",
    name: "gpu-box",
    online: false,
  }),
  { ...macbookWorking, access: null, computerUse: null },
  {
    ...studio,
    access: null,
    apps: null,
    computerUse: null,
    id: "rnr_99999999-9999-4999-8999-999999999999",
    lastSeenAt: null,
    modules: {
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "Sam’s iMac",
    ownerName: "Sam Kim",
    ownership: "other",
    status: "online",
  },
  {
    ...macbookWorking,
    access: null,
    apps: null,
    computerUse: null,
    device: { form: "laptop", platform: "macos" },
    id: "rnr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Priya’s MacBook Air",
    ownerName: "Priya Rao",
    ownership: "other",
  },
  {
    ...macMini,
    access: null,
    allowedModules: ["agents", "shell"],
    apps: null,
    computerUse: null,
    device: null,
    enrollmentId: "ren_pending",
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    fullDiskAccess: null,
    id: "ren_pending",
    modules: { agents: { checkedAt: null, detail: null, readiness: "unavailable" } },
    name: "Lab server",
    ownership: "mine",
    revocable: false,
    status: "pending",
  },
  browserService,
  messagingService,
];

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
  "cloud-desktop-offer": {
    ...cloudBase,
    sessions: serverSessions,
    bridge: true,
    deployment: {
      access: "native",
      kind: "self-hosted",
      name: "Acme Research",
      onThisComputer: false,
    },
    local: localStatus({ enrolled: false, mayRunAgents: true }),
    machines: cloudMachines,
  },
  "cloud-desktop-added": {
    ...cloudBase,
    sessions: serverSessions,
    bridge: true,
    deployment: {
      access: "native",
      kind: "self-hosted",
      name: "Acme Research",
      onThisComputer: false,
    },
    local: localStatus({ enrolled: true, mayRunAgents: true, runAgents: true }),
    machines: [...cloudMachines, macbookWorking, officeMini],
  },
  "cloud-browser": {
    ...cloudBase,
    sessions: serverSessions,
    bridge: false,
    deployment: null,
    local: null,
    machines: [...cloudMachines, macbookWorking, officeMini],
  },
  "team-admin": {
    ...teamBase,
    sessions: serverSessions,
    admin: true,
    bridge: false,
    deployment: null,
    local: null,
    machines: teamMachines,
  },
  "team-member": {
    ...teamBase,
    sessions: serverSessions.slice(0, 1),
    admin: false,
    bridge: false,
    deployment: null,
    local: null,
    machines: [],
  },
};

function fakeBridge(scenario: Scenario): OpensteerDesktopBridge {
  const remote = {
    deploymentId: null,
    detail: null,
    generation: 1,
    mode: scenario.remoteAccess === "ready" ? "connect" : "off",
    phase: scenario.remoteAccess === "ready" ? "ready" : "off",
    retryable: false,
    routeOrigin:
      scenario.remoteAccess === "ready" ? "https://mac-mini.connect.opensteer.cloud" : null,
    schemaVersion: 1,
  };
  return {
    // The visual build carries no Agent Phone app, as a development build without it.
    readAgentPhoneArtifact: async () => null,
    onUsbDeviceChoice: () => () => undefined,
    chooseUsbDevice: async () => undefined,
    checkFullDiskAccess: async () => ({ granted: true }),
    computerUseApprovalKey: async () => ({ keyId: approvalKeyId, publicKey: "" }),
    // The setup panel is macOS's other window; the page only asks for it.
    openComputerAppSetup: async () => ({ opened: true }),
    configurePersonalRemoteAccess: async () => remote,
    getPersonalRemoteAccessStatus: async () => remote,
    issuePersonalPairingCode: async () => ({
      code: "K7QX-4MRA",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      generation: 1,
      routeOrigin: remote.routeOrigin,
    }),
    onPersonalRemoteAccessStatusChanged: () => () => undefined,
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
const path = search.get("path") ?? "/settings/computers";
const client = new MockHostClient({ latencyMs: 0, sessions: scenario.sessions });
const snapshot: ShellContext["snapshot"] = {
  ...base,
  connection: "connected",
  deploymentShape: {
    defaultWorkspaceBacking: scenario.kind === "personal" ? "local-directory" : "portablefs",
    kind: scenario.kind,
  },
  identityConfig: base.identityConfig && {
    ...base.identityConfig,
    deployment: {
      cloud: scenario.cloud,
      kind: scenario.kind === "personal" ? "personal" : "self-hosted",
      name: scenario.name,
    },
    publicOrigin: scenario.origin,
  },
  machines: [...scenario.machines],
  user: base.user && {
    ...base.user,
    instanceRole: scenario.admin ? "administrator" : "user",
  },
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
  askOpensteerAbout: noOp,
  clearHomeHandoff: noOp,
  homeDraft: "",
  homeHandoff: null,
  homeThreadId: null,
  setHomeDraft: noOp,
  createThreadAndSend: async () => null,
  defaultPlacement: undefined,
  deploymentAccess: null,
  desktopBridge: scenario.bridge ? fakeBridge(scenario) : null,
  desktopDeployment,
  executionPreferences: emptyExecutionPreferences,
  hostClient: client,
  localExecutionAction: null,
  localExecutionError: null,
  localExecutionStatus: scenario.local,
  openHarnessAuthentication: null,
  refreshHarnessCatalog: async () => undefined,
  leaveSettings: noOp,
  openMobileNavigation: noOp,
  openNewWorkspace: noOp,
  openSharing: noOp,
  performLocalExecutionAction: async () => undefined,
  placements: [],
  rememberExecution: noOp,
  reportActionError: noOp,
  setTaskDone: noOp,
  writeInChat: noOp,
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
            <Route element={<Outlet context={context} />}>
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
