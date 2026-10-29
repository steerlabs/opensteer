import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import type { HostClient, TranscriptEntry, WorkspaceSummary } from "@opensteer/client/host";
import { mockComputerUseSlack, mockComputerUseTurn } from "@opensteer/client/mock";
import { RunIdSchema, ThreadIdSchema, UserIdSchema, WorkspaceIdSchema } from "@opensteer/core";
import type {
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import type {
  DesktopComputerAppSetup,
  DesktopComputerAppSetupStep,
  DesktopComputerUseApprovalPresentation,
} from "@opensteer/protocol/desktop";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AgentTranscript } from "./components/agent-activity.js";
import { ComputerAppsSection } from "./components/computer-apps/computer-apps-section.js";
import { ComputerUseApprovalPanel } from "./desktop/computer-use-approval-panel.js";
import { ComputerAppSetupPanel } from "./desktop/computer-app-setup-panel.js";
import { ComputerUsePermissionsPanel } from "./desktop/computer-use-permissions-panel.js";

/**
 * Scenarios, by `?scenario=`:
 *   setup     — helper installed, neither grant given (first run)
 *   half      — Screen Recording on, Accessibility still off
 *   empty     — ready, nothing approved yet: the "Which apps can agents use?" step
 *   ready     — Ask for each app, two apps approved, one waiting for this Mac
 *   automatic — Allow any app automatically, with one app blocked
 *   session   — two tasks are using apps right now
 *   headless  — a Mac without the desktop app
 *   unregistered — desktop approval key has not been registered with the Host
 *   offline   — the Mac is away
 * and `?view=local|remote` for where the page is being looked at from, plus
 * `?slow` and `?fail` for the busy and refused states of every action, or
 * `?key-error` on unregistered to show a failed desktop-key registration.
 *
 * `?panel=approve|task|long|messages|policy|permissions|setup` renders one of the desktop's
 * native panels instead, at the size its window has, and `?panel=transcript`
 * a Thread's turn while it uses Slack on this Mac: a look, a few batches of
 * actions, one that stopped partway, and a call still waiting for its answer,
 * under the line that says so with its Stop. Add `&conversation` to read it as a
 * conversation does, `&viewer=member` to read it as someone who does not own
 * the Mac, and `&state=settled` for the turn once it has replied.
 */
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "ready";
const view = params.get("view") ?? "local";
const panel = params.get("panel");
const runnerId = "rnr_11111111-1111-4111-8111-111111111111";
const online = scenario !== "offline";

const definition = {
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
  computerApp: {
    accessLabels: { read: "Can see", readWrite: "Can see and control" },
    accessLevels: ["read", "read-write"],
    accessSummaries: {
      read: "Agents can see the app.",
      readWrite: "Agents can see and control the app.",
    },
    kind: "gui",
    operations: [
      { effect: "read", name: "observe" },
      { effect: "write", name: "act" },
    ],
    platforms: ["darwin"],
  },
  description: "Agents see and operate approved apps on a Mac.",
  id: "macos-app",
  name: "Computer use",
  provider: "macos-app",
} as unknown as IntegrationDefinitionSummary;

const permissions =
  scenario === "setup"
    ? { accessibility: "denied", screenRecording: "denied" }
    : scenario === "half"
      ? { accessibility: "denied", screenRecording: "granted" }
      : { accessibility: "granted", screenRecording: "granted" };
const state =
  scenario === "headless"
    ? "unavailable"
    : scenario === "setup" || scenario === "half"
      ? "permission-required"
      : "ready";

const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLE" };
const calendar = { bundleId: "com.apple.iCal", displayName: "Calendar", teamId: "APPLE" };
const safari = { bundleId: "com.apple.Safari", displayName: "Safari", teamId: "APPLE" };
const preview = { bundleId: "com.apple.Preview", displayName: "Preview", teamId: "APPLE" };
const sessions =
  scenario === "session"
    ? [
        {
          actionCount: 14,
          apps: [notes, calendar],
          openedAt: "2026-09-21T17:00:00.000Z",
          runId: "run_00000000-0000-4000-8000-000000000001",
          sessionId: "cus_00000000-0000-4000-8000-000000000001",
          threadId: "thr_00000000-0000-4000-8000-000000000001",
          threadTitle: "Move the Q4 plan into Calendar",
        },
        {
          actionCount: 3,
          apps: [preview],
          openedAt: "2026-09-21T17:04:00.000Z",
          runId: "run_00000000-0000-4000-8000-000000000002",
          sessionId: "cus_00000000-0000-4000-8000-000000000002",
          threadId: "thr_00000000-0000-4000-8000-000000000002",
          threadTitle: "Compare the two contract drafts",
        },
      ]
    : [];

const machine = {
  access: null,
  allowedModules: ["integrations", "shell"],
  apps: null,
  computerUse: {
    approvalKeyId: scenario === "unregistered" ? null : `sha256:${"a".repeat(43)}`,
    appApproval: scenario === "automatic" ? "automatic" : "ask",
    detail:
      state === "unavailable" ? "Computer use needs the Opensteer desktop app on this Mac." : null,
    permissions: state === "unavailable" ? null : permissions,
    sessions,
    state,
  },
  detail: null,
  enrollmentId: null,
  expiresAt: null,
  fullDiskAccess: true,
  id: runnerId,
  lastSeenAt: null,
  localWorkspaces: 0,
  modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
  name: "Alex’s MacBook Pro",
  ownership: "mine",
  pinnedThreads: 0,
  revocable: true,
  status: online ? "online" : "offline",
  unlinkedLocalFolders: 0,
} as unknown as MachineSummary;

const connection = (
  id: string,
  app: typeof notes,
  access: "read" | "read-write",
  blockedAt: string | null = null,
) =>
  ({
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: { access, app, blockedAt, policyRevision: null, runnerId },
    connectionMethod: "computer",
    createdAt: "2026-09-19T00:00:00.000Z",
    definitionId: "macos-app",
    displayName: `${app.displayName} on Alex’s MacBook Pro`,
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id,
    provider: "macos-app",
    providerApplicationId: null,
    status: blockedAt === null ? "connected" : "paused",
    statusDetail: null,
    updatedAt: "2026-09-19T00:00:00.000Z",
  }) as unknown as IntegrationConnectionSummary;

const connections = ["ready", "session", "offline", "automatic"].includes(scenario)
  ? [
      connection("con_00000000-0000-4000-8000-000000000001", notes, "read-write"),
      connection("con_00000000-0000-4000-8000-000000000002", calendar, "read"),
      ...(scenario === "automatic"
        ? [
            connection(
              "con_00000000-0000-4000-8000-000000000003",
              safari,
              "read-write",
              "2026-09-20T00:00:00.000Z",
            ),
          ]
        : []),
    ]
  : [];

const setupRequests =
  scenario === "ready"
    ? [
        {
          access: "read-write",
          app: preview,
          createdAt: "2026-09-19T00:00:00.000Z",
          definitionDigest: "d".repeat(43),
          definitionId: "macos-app",
          deploymentId: "dep_00000000-0000-4000-8000-000000000001",
          expiresAt: "2026-09-30T00:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000004",
          kind: "app",
          ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
          policyAppApproval: null,
          reason: "Compare the two contract drafts.",
          runnerId,
          threadId: "thr_00000000-0000-4000-8000-000000000002",
          threadTitle: "Compare the two contract drafts",
          workspaceId: null,
        } as unknown as ComputerAppSetupRequest,
      ]
    : [];

// Enough apps that the picker pages (50 at a time), and two that share a name.
const installed = [
  ...[
    "Notes",
    "Calendar",
    "Preview",
    "Numbers",
    "Pages",
    "Music",
    "Reminders",
    "Safari",
    "Mail",
    "Finder",
    "Keynote",
    "Photos",
    "Maps",
    "Messages",
    "FaceTime",
    "Contacts",
    "Books",
    "News",
    "Podcasts",
    "TV",
    "Stocks",
    "Weather",
    "Clock",
    "Freeform",
    "Shortcuts",
    "Home",
    "Journal",
    "Xcode",
    "TextEdit",
    "Font Book",
    "Image Playground",
    "iMovie",
    "GarageBand",
    "Pixelmator Pro",
    "Final Cut Pro",
    "Logic Pro",
    "Figma",
    "Slack",
    "Zoom",
    "Notion",
    "Linear",
    "Things 3",
    "Fantastical",
    "Raycast",
    "Arc",
    "Firefox",
    "Microsoft Word",
    "Microsoft Excel",
    "Microsoft PowerPoint",
    "Microsoft Outlook",
    "Spotify",
    "VLC",
    "Transmit",
    "Tower",
    "Sketch",
    "Obsidian",
    "Bear",
    "Craft",
  ].map((name) => ({
    identity: {
      bundleId: `com.apple.${name.replaceAll(" ", "")}`,
      displayName: name,
      teamId: "APPLE",
    },
    running: false,
  })),
  {
    identity: { bundleId: "com.google.Chrome", displayName: "Google Chrome", teamId: "EQHXZ8M8AV" },
    running: false,
  },
  {
    identity: {
      bundleId: "com.google.Chrome.beta",
      displayName: "Google Chrome",
      teamId: "EQHXZ8M8AV",
    },
    running: false,
  },
];

// `?slow` holds every action long enough to see its busy state, and `?fail`
// answers every action with an error, as a Host that refused it would.
const slow = params.has("slow");
const fail = params.has("fail");
async function settle<T>(value: T): Promise<T> {
  if (slow) await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (fail) throw new Error("Alex’s MacBook Pro is offline.");
  return value;
}

let rerenderScenario: () => void = () => undefined;
// Stop receipts are scoped to one signed-in person on one deployment.
const visualSnapshot = {
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  session: "authenticated",
  user: { id: "usr_00000000-0000-4000-8000-000000000001" },
};
const hostClient = {
  dispatch: async (command: { type: string }) =>
    settle({ type: command.type, request: { id: "00000000-0000-4000-8000-000000000009" } }),
  getSnapshot: () => visualSnapshot,
  refresh: async () => undefined,
  subscribe: () => () => undefined,
  rpc: {
    "integration.computer.apps.installed": async (input: {
      readonly limit: number;
      readonly offset: number;
      readonly query: string;
    }) => {
      const query = input.query.toLowerCase();
      const matches = installed.filter(
        ({ identity }) =>
          identity.displayName.toLowerCase().includes(query) ||
          identity.bundleId.toLowerCase().includes(query),
      );
      return {
        ok: true,
        data: {
          apps: matches.slice(input.offset, input.offset + input.limit),
          total: matches.length,
        },
      };
    },
    "integration.computer.session.stop": async ({ sessionId }: { sessionId: string }) => {
      const result = await settle({ ok: true, data: {} });
      const index = sessions.findIndex((session) => session.sessionId === sessionId);
      if (index >= 0) sessions.splice(index, 1);
      rerenderScenario();
      return result;
    },
    "integration.grants.list": async () => ({ ok: true, data: { grants: [] } }),
  },
} as unknown as HostClient;

const approvals: Record<string, DesktopComputerUseApprovalPresentation> = {
  approve: {
    access: "read-write",
    accessLabel: "Can see and control",
    accessSummary:
      "Agents can see the app and click, type, scroll, press keys, and open it in the background. What the app can do, agents can do through it.",
    app: {
      bundleId: "com.apple.Notes",
      displayName: "Notes",
      iconPng: null,
      path: "/System/Applications/Notes.app",
      reason: null,
      risk: "standard",
    },
    deploymentName: "Alex’s Deployment",
    kind: "app",
    machineName: "Alex’s MacBook Pro",
    reason: null,
    threadTitle: null,
    token: "visual",
    workspaceName: null,
  },
  policy: {
    appApproval: "automatic",
    deploymentName: "Alex’s Deployment",
    kind: "policy",
    machineName: "Alex’s MacBook Pro",
    token: "visual",
  },
  task: {
    access: "read-write",
    accessLabel: "Can see and control",
    accessSummary:
      "Agents can see the app and click, type, scroll, press keys, and open it in the background. What the app can do, agents can do through it.",
    app: {
      bundleId: "com.apple.finder",
      displayName: "Finder",
      iconPng: null,
      path: "/System/Library/CoreServices/Finder.app",
      reason: null,
      risk: "elevated",
    },
    deploymentName: "Alex’s Deployment",
    kind: "app",
    machineName: "Alex’s MacBook Pro",
    reason: "Collect the signed contracts from Downloads into the deal folder.",
    threadTitle: "Close the Q3 deals",
    token: "visual",
    workspaceName: "Sales",
  },
};

// Messages asked for from the Mac's page or another device, with Full Disk
// Access still off: the panel says what Allow leads to on this Mac.
approvals["messages"] = {
  access: "read",
  accessLabel: "Read only",
  accessSummary: "Allows searching and reading conversations. Sending is off.",
  app: {
    bundleId: "apple-messages",
    displayName: "Apple Messages",
    iconPng: null,
    path: null,
    reason: null,
    risk: "standard",
  },
  deploymentName: "Alex’s MacBook Pro (3)",
  kind: "app",
  machineName: "Alex’s MacBook Pro",
  reason: null,
  threadTitle: null,
  token: "visual",
  workspaceName: null,
};

// The longest a task can make the panel: a long title, app name and reason.
approvals["long"] = {
  ...(approvals["task"] as Extract<DesktopComputerUseApprovalPresentation, { kind: "app" }>),
  app: {
    bundleId: "com.microsoft.Excel",
    displayName: "Microsoft Excel for Mac (Office 365 Business Premium Edition)",
    iconPng: null,
    path: "/Applications/Microsoft Office/Microsoft Excel for Mac (Office 365 Business Premium Edition).app",
    reason: null,
    risk: "elevated",
  },
  reason:
    "Open the quarterly revenue workbook, reconcile the regional tabs against the finance export in Downloads, fix the formulas that reference the old sheet names, and save a copy for the board pack before Thursday's review meeting.",
  threadTitle: "Reconcile the Q3 regional revenue workbook against the finance export",
};

const root = createRoot(document.getElementById("root")!);
const approval = panel ? approvals[panel] : undefined;

if (approval) {
  root.render(
    <div style={{ height: 400, margin: "40px auto", width: 480 }}>
      <ComputerUseApprovalPanel
        bridge={{
          computerUseApprovalGet: async () => approval,
          computerUseApprovalRespond: async () => undefined,
        }}
        token="visual"
      />
    </div>,
  );
} else if (panel === "transcript") {
  const runId = RunIdSchema.parse("run_00000000-0000-4000-8000-000000000001");
  const threadId = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001");
  const visualUserId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
  const turnState = params.get("state") === "settled" ? "settled" : "running";
  const slack = {
    bundleId: mockComputerUseSlack.bundleId,
    displayName: mockComputerUseSlack.app,
    teamId: "BQR82RBBHL",
  };
  // The Run holds Slack, and Notes from earlier in the task, on the Mac its steps name.
  if (turnState === "running") {
    sessions.push({
      actionCount: 11,
      apps: [notes, slack],
      openedAt: "2026-08-06T23:28:24.000Z",
      runId,
      sessionId: "cus_00000000-0000-4000-8000-000000000003",
      threadId,
      threadTitle: "Switch Slack to Opensteer",
    });
  }
  const turn = mockComputerUseTurn({
    agent: {
      displayName: "Opensteer",
      kind: "agent",
      runId,
      threadId,
      workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001"),
      workspaceName: "Main",
    },
    runId,
    state: turnState,
  });
  // A completed Run names its reply as the Host does: the last message it wrote.
  const reply = turn.findLast((entry) => entry.kind === "message");
  const entries: TranscriptEntry[] = [
    {
      author: {
        displayName: "Alex",
        kind: "human",
        principalId: visualUserId,
        userId: visualUserId,
      },
      body: "Ok can you click on the opensteer org in slack for me",
      createdAt: "2026-08-06T23:28:03.000Z",
      id: "msg_visual_1",
      kind: "message",
      messageKind: "input",
      runId: null,
    },
    {
      createdAt: "2026-08-06T23:28:03.500Z",
      error: null,
      id: `run:${runId}`,
      kind: "run",
      replyMessageId: turnState === "running" ? null : (reply?.id ?? null),
      runId,
      status: turnState === "running" ? "running" : "completed",
    },
    ...turn,
  ];
  rerenderScenario = () =>
    root.render(
      <MemoryRouter>
        <main className="page">
          <div className="page__content" style={{ maxWidth: 760, margin: "0 auto" }}>
            <AgentTranscript
              activity={turnState === "running" ? "working" : "idle"}
              conversation={params.has("conversation")}
              computers={
                params.get("viewer") === "member"
                  ? null
                  : {
                      hostClient,
                      machines: [{ ...machine, id: mockComputerUseSlack.runnerId }],
                    }
              }
              entries={entries}
              viewerUserId={visualUserId}
            />
          </div>
        </main>
      </MemoryRouter>,
    );
  rerenderScenario();
} else if (panel === "setup") {
  // `&state=offer|full-disk-access|wrong-app|not-listed|ask|away|done`, and
  // `&target=contacts` for an app whose one grant is a question.
  const state = params.get("state") ?? "full-disk-access";
  const contacts = params.get("target") === "contacts";
  const step = (
    grant: DesktopComputerAppSetupStep["grant"],
    kind: DesktopComputerAppSetupStep["kind"],
    stepState: DesktopComputerAppSetupStep["state"],
  ): DesktopComputerAppSetupStep => ({ grant, kind, state: stepState });
  const steps: DesktopComputerAppSetupStep[] = contacts
    ? [step("contacts", "ask", state === "done" ? "done" : "current")]
    : state === "ask"
      ? [step("full-disk-access", "settings", "done"), step("automation", "ask", "current")]
      : state === "done"
        ? [step("full-disk-access", "settings", "done"), step("automation", "ask", "done")]
        : [step("full-disk-access", "settings", "current"), step("automation", "ask", "waiting")];
  const setup: DesktopComputerAppSetup = {
    appIconPng: null,
    appName: "Opensteer Beta",
    definitionId: contacts ? "apple-contacts" : "apple-messages",
    helperReachable: state !== "away",
    phase: state === "offer" ? "offer" : state === "done" ? "done" : "steps",
    steps,
    targetName: contacts ? "Contacts" : "Messages",
    thisAppHasFullDiskAccess: state === "wrong-app",
  };
  root.render(
    <div style={{ height: 252, margin: "40px auto", position: "relative", width: 312 }}>
      <ComputerAppSetupPanel
        bridge={{
          closeComputerAppSetup: async () => undefined,
          computerAppSetupBegin: async () => undefined,
          computerAppSetupShowAgain: async () => undefined,
          computerAppSetupStartDrag: async () => undefined,
          computerAppSetupStatus: async () => ({ setup }),
        }}
      />
    </div>,
  );
} else if (panel === "permissions") {
  root.render(
    <div style={{ height: 380, margin: "40px auto", width: 500 }}>
      <ComputerUsePermissionsPanel
        bridge={{
          closeComputerUsePermissionsPanel: async () => undefined,
          computerUseOpenSystemSettings: async () => undefined,
          computerUsePermissionsGet: async () => ({
            accessibility: "denied",
            screenRecording: "granted",
          }),
          computerUsePermissionsRequest: async () => ({
            accessibility: "denied",
            screenRecording: "granted",
          }),
        }}
      />
    </div>,
  );
} else {
  rerenderScenario = () =>
    root.render(
      <MemoryRouter>
        <main className="page">
          <div className="page__content" style={{ maxWidth: 860, margin: "0 auto" }}>
            <h1 style={{ marginBottom: 8 }}>Alex’s MacBook Pro</h1>
            <p style={{ color: "var(--muted)", marginBottom: 28 }}>
              {online ? "Online" : "Offline"} · scenario {scenario} · viewed from {view}
            </p>
            <ComputerAppsSection
              hostConnected
              computerUseApprovalKeySetup={
                params.has("key-error")
                  ? {
                      error: "This Mac could not register its approval key.",
                      ready: false,
                      retry: () => {
                        params.delete("key-error");
                        location.search = params.toString();
                      },
                    }
                  : null
              }
              computerUseLocal={
                view === "local"
                  ? {
                      openPermissions: async () => ({ opened: true }),
                      reviewSetup: async () => settle(true),
                    }
                  : null
              }
              connections={connections}
              definitions={[definition]}
              hostClient={hostClient}
              machine={machine}
              onCancelSetupRequest={async () => undefined}
              onChanged={async () => undefined}
              onRequestSetup={async () => undefined}
              owned
              platform={null}
              setupRequests={setupRequests}
              workspaces={[] as WorkspaceSummary[]}
            />
          </div>
        </main>
      </MemoryRouter>,
    );
  rerenderScenario();
}
