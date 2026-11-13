import { AppErrorBoundary } from "./components/app-error-boundary.js";
import { DictationContext } from "./components/dictation.js";
import { StrictMode } from "react";
import { StartupFailure } from "./components/onboarding-card.js";
import { installDictation } from "./desktop/dictation-runtime.js";

import { createRoot } from "react-dom/client";
import { desktopBridge } from "./desktop/desktop-bridge.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { initializeDesktopWindowChrome } from "./desktop/window-controls-overlay.js";

import { AuthSessionIdSchema, DeploymentKindSchema } from "@opensteer/core";
import { personalWebBuildId } from "@opensteer/protocol";
import { chromeConnectPagePath } from "@opensteer/client/host";

document.documentElement.dataset.opensteerWebBuild = personalWebBuildId;

const root = document.getElementById("root");

if (!root) {
  throw new Error("Opensteer web root was not found.");
}

const appRoot = createRoot(root);
const dictation = installDictation(desktopBridge()?.dictation);
const reactRoot = {
  render: (children: React.ReactNode) =>
    appRoot.render(
      <DictationContext value={dictation}>
        <AppErrorBoundary>{children}</AppErrorBoundary>
      </DictationContext>,
    ),
};

/** The path the desktop's floating Full access panel loads. */
const fullAccessPanelPath = "/full-access";
/** The desktop's two computer-use windows: over System Settings, and the approval. */
const computerUsePermissionsPanelPath = "/computer-use/permissions";
/** The desktop's setup panel for an app the helper serves, beside System Settings. */
const computerAppSetupPanelPath = "/computer-app/setup";

async function renderOpensteer(): Promise<void> {
  // Chrome lands here from a link. The fragment is a one-use code: read it once
  // and take it out of the address bar and history before anything renders.
  if (window.location.pathname === chromeConnectPagePath) {
    const fragment = window.location.hash;
    window.history.replaceState(null, "", window.location.pathname);
    const { ChromeConnectPage } = await import("./components/chrome/chrome-connect-page.js");
    reactRoot.render(
      <StrictMode>
        <ChromeConnectPage fragment={fragment} />
      </StrictMode>,
    );
    return;
  }
  const nativeBridge = desktopBridge();
  const bridge = nativeBridge ?? (await resolveDesktopPreviewBridge());
  // The panel is its own window with its own document: one card, the bridge it
  // drives, and no Host client — nothing about a Deployment belongs in it. The
  // dev preview bridge reaches it too, so the card can be looked at in a browser.
  if (bridge && window.location.pathname === fullAccessPanelPath) {
    const { FullAccessPanel } = await import("./desktop/full-access-panel.js");
    // Match the app name shown in the macOS permission list.
    const appName = new URLSearchParams(window.location.search).get("app") ?? "Opensteer";
    reactRoot.render(
      <StrictMode>
        <FullAccessPanel appName={appName} bridge={bridge} />
      </StrictMode>,
    );
    return;
  }
  if (bridge && window.location.pathname === computerUsePermissionsPanelPath) {
    const { ComputerUsePermissionsPanel } =
      await import("./desktop/computer-use-permissions-panel.js");
    reactRoot.render(
      <StrictMode>
        <ComputerUsePermissionsPanel bridge={bridge} />
      </StrictMode>,
    );
    return;
  }
  if (bridge && window.location.pathname === computerAppSetupPanelPath) {
    const { ComputerAppSetupPanel } = await import("./desktop/computer-app-setup-panel.js");
    reactRoot.render(
      <StrictMode>
        <ComputerAppSetupPanel bridge={bridge} />
      </StrictMode>,
    );
    return;
  }
  if (bridge) {
    if (nativeBridge) initializeDesktopWindowChrome();
    const { DesktopApp } = await import("./desktop/desktop-app.js");
    reactRoot.render(
      <StrictMode>
        <DesktopApp bridge={bridge} />
      </StrictMode>,
    );
    return;
  }

  if (import.meta.env.VITE_OPENSTEER_USE_MOCK !== "true" && (await servedByTeam())) {
    const { TeamWebApp } = await import("./team/team-web-app.js");
    reactRoot.render(
      <StrictMode>
        <TeamWebApp />
      </StrictMode>,
    );
    return;
  }

  let previewTeams: Parameters<typeof import("./app.js").App>[0]["previewTeams"] = null;
  let previewDesktop: Pick<
    Parameters<typeof import("./app.js").App>[0],
    "deploymentAccess" | "desktopBridge" | "desktopDeployment"
  > = {};
  const [{ App }, hostClient] = await Promise.all([
    import("./app.js"),
    import.meta.env.VITE_OPENSTEER_USE_MOCK === "true"
      ? Promise.all([
          import("@opensteer/client/mock"),
          import("./host/browser-host-client.js"),
          import("./host/browser-lifecycle.js"),
          import("@opensteer/client/team"),
        ]).then(
          ([
            { MockHostClient, mockSubagentScenes },
            { browserPreferencesStorage },
            { browserClientLifecycle },
            {
              MockTeamHost,
              TeamSessionClient,
              createMemoryTeamPersistence,
              busyTeamIds,
              seedBusyTeam,
            },
          ]) => {
            const search = new URLSearchParams(window.location.search);
            const world = search.get("mock-world");
            // `?mock-team` puts one live mock team beside the person's own tasks;
            // `?mock-team=busy` two teams full of people, threads, files and asks.
            const attach = (team: InstanceType<typeof MockTeamHost>, origin: string) => ({
              teamId: team.teamId,
              name: team.bootstrap.teamName,
              origin,
              client: new TeamSessionClient({
                scope: { teamDeploymentId: team.teamId, userId: team.userId },
                persistence: createMemoryTeamPersistence(),
                rpc: team.rpc,
                connect: team.connect,
                readFile: team.readFile,
                uploadFile: team.uploadFile,
              }),
              link: null,
            });
            if (search.get("mock-team") === "busy") {
              const acme = new MockTeamHost({ teamId: busyTeamIds[0] });
              const family = new MockTeamHost({ teamId: busyTeamIds[1] });
              seedBusyTeam(acme, { name: "Acme", index: 1 });
              seedBusyTeam(family, { name: "Family", index: 2 });
              previewTeams = [
                attach(acme, "https://chat.acme.example"),
                attach(family, "https://family.example"),
              ];
              // For journeys that play another member's change on the busy teams.
              Object.assign(window, { opensteerMockTeams: [acme, family] });
              return mockClient();
            }
            if (search.has("mock-team"))
              previewTeams = [attach(new MockTeamHost(), "https://chat.acme.example")];
            return mockClient();
            function mockClient() {
              const subagents = mockSubagentScenes.find(
                (scene) => scene === search.get("mock-subagents"),
              );
              // `?mock-desktop=new-mac|blocked|this-mac|home` opens the mock as the
              // desktop app would on a Mac that is new to it, can't finish setting
              // up, is one of its devices, or hosts it.
              const desktopScenario = search.get("mock-desktop");
              const client = new MockHostClient({
                // `?mock-sessions=browser`: this window is a web browser's session.
                ...(desktopScenario === "new-mac" || desktopScenario === "blocked"
                  ? { sessions: mockUnboundSessions("Opensteer for Mac") }
                  : search.get("mock-sessions") === "browser"
                    ? { sessions: mockUnboundSessions("Chrome on Mac") }
                    : {}),
                lifecycle: browserClientLifecycle(),
                browserPreferencesStorage,
                ...(search.has("mock-devices") ? { devices: "seeded" as const } : {}),
                ...(world === "first-run" || world === "busy" || world === "stress"
                  ? { world }
                  : {}),
                ...(subagents ? { subagents } : {}),
              });
              // The preview's own client, for journeys that count what the page sends.
              Object.assign(window, { opensteerMock: client });
              if (desktopScenario) return attachMockDesktop(client, desktopScenario);
              const downloadsScript = new URLSearchParams(window.location.search).get(
                "mock-downloads",
              );
              if (downloadsScript !== null) {
                return Promise.all([
                  import("./desktop/desktop-preview-bridge.js"),
                  import("@opensteer/protocol/desktop"),
                ]).then(
                  ([
                    { desktopPreviewBridge, desktopPreviewDownloads },
                    { DesktopDownloadsSnapshotSchema },
                  ]) => {
                    const initial = DesktopDownloadsSnapshotSchema.parse({
                      downloads: JSON.parse(downloadsScript),
                    });
                    const downloads = desktopPreviewDownloads(initial.downloads);
                    Object.assign(window, {
                      opensteerDesktop: {
                        ...desktopPreviewBridge("?desktop-preview=first-run", true),
                        downloads,
                      },
                      opensteerPreviewDownloads: downloads,
                    });
                    return client;
                  },
                );
              }
              return client;
            }
            async function attachMockDesktop(
              client: InstanceType<typeof MockHostClient>,
              scenario: string,
            ) {
              const [{ desktopPreviewBridge }, { desktopSummaryFromAccess }] = await Promise.all([
                import("./desktop/desktop-preview-bridge.js"),
                import("./desktop/desktop-deployment-selection.js"),
              ]);
              if (scenario !== "blocked")
                client.setPersonalRemoteAccessStatus({
                  accountLink: null,
                  generation: 1,
                  mode: "connect",
                  route: null,
                  schemaVersion: 2,
                });
              const bridge = desktopPreviewBridge("?desktop-preview=first-run", true, {
                attached: {
                  id:
                    client.getSnapshot().deploymentId ?? "dep_00000000-0000-4000-8000-000000000001",
                  name: "Alex’s Opensteer",
                  origin: "https://alex.connect.opensteer.invalid",
                  hosting:
                    scenario === "home"
                      ? { environmentId: "env_00000000-0000-4000-8000-000000000001" }
                      : null,
                  runnerId:
                    scenario === "this-mac" ? "rnr_33333333-3333-4333-8333-333333333333" : null,
                },
                connectRunner: (token) => client.connectLocalRunner(token),
              });
              if (!bridge) return client;
              const access = await bridge.getDeploymentAccessSnapshot();
              const selected = access.deployments.find(
                ({ id }) => id === access.selectedDeploymentId,
              );
              previewDesktop = {
                deploymentAccess: access,
                desktopBridge: bridge,
                desktopDeployment: selected ? desktopSummaryFromAccess(selected) : null,
              };
              return client;
            }
          },
        )
      : import("./host/browser-host-client.js").then(({ createBrowserHostClient }) =>
          createBrowserHostClient({
            capabilities: async () => {
              const { verifyAccessEndpoint } = await import("@opensteer/client/connections");
              const verified = await verifyAccessEndpoint({
                // A Personal remote page is served through an access route,
                // while its signed Host identity retains the loopback origin.
                kind: "direct",
                origin: window.location.origin,
              });
              return verified.capabilities;
            },
          }),
        ),
  ]);
  window.addEventListener("pagehide", () => hostClient.dispose(), { once: true });
  reactRoot.render(
    <StrictMode>
      <App hostClient={hostClient} previewTeams={previewTeams} {...previewDesktop} />
    </StrictMode>,
  );
}

const deploymentKindKey = "opensteer:deployment-kind";

function mockUnboundSessions(current: string) {
  const at = "2026-09-14T00:00:00.000Z";
  const labels = ["Opensteer for Mac", "Chrome on Mac", "Opensteer for iPhone"];
  return [current, ...labels.filter((label) => label !== current)].map((deviceLabel, index) => ({
    absoluteExpiresAt: "2026-10-14T00:00:00.000Z",
    createdAt: at,
    current: index === 0,
    deviceId: null,
    deviceLabel,
    expiresAt: "2026-09-21T00:00:00.000Z",
    form: "computer" as const,
    id: AuthSessionIdSchema.parse(`ses_00000000-0000-4000-8000-00000000000${index + 1}`),
    lastSeenAt: at,
  }));
}

/**
 * Whether a team server served this page. An origin's kind never changes, so
 * it is asked once and remembered; later loads check behind the first screen
 * and reload only if it differs.
 */
async function servedByTeam(): Promise<boolean> {
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(deploymentKindKey);
  } catch {
    // Storage refused: ask every time.
  }
  const asked = fetch("/.well-known/opensteer", {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "error",
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: unknown) => {
      const kind = DeploymentKindSchema.safeParse((body as { kind?: unknown } | null)?.kind);
      if (!kind.success) return null;
      try {
        localStorage.setItem(deploymentKindKey, kind.data);
      } catch {
        // Asked again next time.
      }
      return kind.data;
    })
    .catch(() => null);
  if (remembered !== "personal" && remembered !== "team") return (await asked) === "team";
  void asked.then((kind) => {
    if (kind !== null && kind !== remembered) window.location.reload();
  });
  return remembered === "team";
}

async function resolveDesktopPreviewBridge() {
  if (
    !import.meta.env.DEV ||
    new URLSearchParams(window.location.search).get("desktop-preview") !== "first-run"
  ) {
    return null;
  }
  const { desktopPreviewBridge } = await import("./desktop/desktop-preview-bridge.js");
  return desktopPreviewBridge();
}

void renderOpensteer().catch((error: unknown) => {
  const developmentDetail =
    import.meta.env.DEV && error instanceof Error && error.message
      ? (error.stack ?? error.message)
      : null;
  reactRoot.render(
    <StartupFailure
      description="Close and reopen the app. If this continues, check the installation."
      title="Opensteer couldn’t start"
    >
      {developmentDetail ? <pre className="onboarding__trace">{developmentDetail}</pre> : null}
    </StartupFailure>,
  );
});
