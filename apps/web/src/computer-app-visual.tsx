import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";
import type { HostClient, WorkspaceSummary } from "@opensteer/client/host";
import type {
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
} from "@opensteer/integration-core";
import type { ComputerAppRemedy, MachineSummary } from "@opensteer/protocol";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ComputerAppsSection } from "./components/computer-apps/computer-apps-section.js";

const runnerId = "rnr_11111111-1111-4111-8111-111111111111";
const view = new URLSearchParams(location.search).get("view") ?? "remote";
const scenario = new URLSearchParams(location.search).get("scenario") ?? "partial";
const access = scenario === "off" ? null : scenario === "setup" ? "read" : "read-write";
const online = scenario !== "offline";
const request = new URLSearchParams(location.search).get("request") === "true";
const definition = {
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
  computerApp: {
    accessLabels: { read: "Read only", readWrite: "Read and send" },
    accessLevels: ["read", "read-write"],
    accessSummaries: {
      read: "Agents can search and read your conversations.",
      readWrite: "Agents can search, read, and send messages as you.",
    },
    operations: [
      { effect: "read", name: "list_conversations" },
      { effect: "write", name: "send_message" },
    ],
    platforms: ["darwin"],
  },
  description: "Messages through an enrolled Mac.",
  id: "apple-messages",
  name: "Apple Messages",
  provider: "apple-messages",
} as unknown as IntegrationDefinitionSummary;
const operation = (
  name: string,
  state: "ready" | "permission-required",
  remedy: ComputerAppRemedy | null,
  detail: string | null,
) => ({ operation: name, state, remedy, detail });
const apps = online
  ? [
      {
        definitionId: "apple-messages",
        operations: [
          operation(
            "list_conversations",
            scenario === "setup" ? "permission-required" : "ready",
            scenario === "setup" ? "full-disk-access" : null,
            scenario === "setup" ? "Messages needs Full Disk Access." : null,
          ),
          operation(
            "send_message",
            scenario === "partial" ? "permission-required" : "ready",
            scenario === "partial" ? "automation" : null,
            scenario === "partial" ? "Messages needs Automation permission." : null,
          ),
        ],
      },
    ]
  : null;
const machine = {
  access: null,
  allowedModules: ["integrations", "shell"],
  apps,
  detail: null,
  enrollmentId: null,
  expiresAt: null,
  fullDiskAccess: scenario === "setup" ? false : true,
  id: runnerId,
  lastSeenAt: null,
  localWorkspaces: 0,
  modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
  name: "Alex’s MacBook Pro",
  ownership: view === "admin" ? "other" : "mine",
  pinnedThreads: 0,
  revocable: true,
  status: online ? "online" : "offline",
  unlinkedLocalFolders: 0,
} as MachineSummary;
const connections = access
  ? [
      {
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: "computer",
        authorizationDigest: null,
        computer: { access, runnerId },
        connectionMethod: "computer",
        createdAt: "2026-09-19T00:00:00.000Z",
        definitionId: "apple-messages",
        displayName: machine.name,
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: [],
        id: "con_00000000-0000-4000-8000-000000000009",
        provider: "apple-messages",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        updatedAt: "2026-09-19T00:00:00.000Z",
      } as unknown as IntegrationConnectionSummary,
    ]
  : [];
const setupRequests = request
  ? [
      {
        access: access === "read" ? "read-write" : "read",
        createdAt: "2026-09-19T00:00:00.000Z",
        definitionDigest: "d".repeat(43),
        definitionId: definition.id,
        deploymentId: "dep_00000000-0000-4000-8000-000000000001",
        expiresAt: "2026-09-20T00:00:00.000Z",
        id: "00000000-0000-4000-8000-000000000004",
        ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
        runnerId,
      } as ComputerAppSetupRequest,
    ]
  : [];
const hostClient = {
  dispatch: async (command: { type: string }) => ({ type: command.type }),
  rpc: { "integration.grants.list": async () => ({ ok: true, data: { grants: [] } }) },
} as unknown as HostClient;
const workspaces = [
  {
    description: "",
    fileCount: 0,
    harnessLabel: "Codex",
    icon: null,
    id: "wsp_00000000-0000-4000-8000-000000000001",
    kind: "main",
    machineName: null,
    name: "Main",
    runnerLabel: machine.name,
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-09-19T00:00:00.000Z",
  },
  {
    description: "",
    fileCount: 0,
    harnessLabel: "Codex",
    icon: "mail",
    id: "wsp_00000000-0000-4000-8000-000000000002",
    kind: "specialized",
    machineName: null,
    name: "Morning Email Summarizer",
    runnerLabel: machine.name,
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-09-19T00:00:00.000Z",
  },
] as WorkspaceSummary[];

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <main className="page">
      <div className="page__content" style={{ maxWidth: 860, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 8 }}>Alex’s MacBook Pro</h1>
        <p style={{ color: "var(--muted)", marginBottom: 28 }}>
          {online ? "Online" : "Offline"} ·{" "}
          {view === "local" ? "This Mac" : view === "admin" ? "Member computer" : "Owned by you"}
        </p>
        <ComputerAppsSection
          hostConnected
          connections={connections}
          definitions={[definition]}
          hostClient={hostClient}
          localApproval={
            view === "local"
              ? { approveAccess: async () => true, reviewPermission: async () => undefined }
              : null
          }
          machine={machine}
          onCancelSetupRequest={async () => undefined}
          onChanged={async () => undefined}
          onRequestSetup={async () => undefined}
          owned={view !== "admin"}
          platform={null}
          setupRequests={setupRequests}
          workspaces={workspaces}
        />
      </div>
    </main>
  </MemoryRouter>,
);
