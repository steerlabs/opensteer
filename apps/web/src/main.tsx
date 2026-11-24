import { initializeBrowserMessageOutbox } from "./host/message-outbox.js";
import { AppErrorBoundary } from "./components/app-error-boundary.js";
import { DictationContext } from "./components/dictation.js";
import { StrictMode } from "react";
import { StartupFailure } from "./components/onboarding-card.js";
import { installDictation } from "./desktop/dictation-runtime.js";

import { createRoot } from "react-dom/client";
import { removeRetiredStorage } from "./host/retired-storage.js";
import { desktopBridge } from "./desktop/desktop-bridge.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { initializeDesktopWindowChrome } from "./desktop/window-controls-overlay.js";

import { AuthSessionIdSchema } from "@opensteer/core";
import { personalWebBuildId } from "@opensteer/protocol";
import {
  chromeConnectPagePath,
  realtimeIdleProbeDeadlineMs,
  realtimeIdleProbeMs,
} from "@opensteer/client/host";

document.documentElement.dataset.opensteerWebBuild = personalWebBuildId;

const root = document.getElementById("root");

if (!root) {
  throw new Error("Opensteer web root was not found.");
}

// What earlier builds wrote and nothing reads goes first, private text included.
removeRetiredStorage(safeLocalStorage());
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
        ]).then(
          ([
            {
              MockHostClient,
              createMockIphoneSetupPort,
              MockCloudComputerAccount,
              mockCloudComputerScenes,
              mockConnectedAgentScenes,
              mockConnectedAgents,
              mockIphoneSetupScenes,
              mockSubagentScenes,
            },
            { browserPreferencesStorage },
            { browserClientLifecycle },
          ]) => {
            const search = new URLSearchParams(window.location.search);
            const world = search.get("mock-world");
            return mockClient();
            function mockClient() {
              const subagents = mockSubagentScenes.find(
                (scene) => scene === search.get("mock-subagents"),
              );
              // `?mock-desktop=new-mac|blocked|this-mac|home` opens the mock as the
              // desktop app would on a Mac that is new to it, can't finish setting
              // up, is one of its devices, or hosts it.
              const desktopScenario = search.get("mock-desktop");
              // `?mock-agents` seeds connected agents in each state and a consent from Grok
              // at `/mcp-authorization?request=` its id; `=expired` leaves that consent expired.
              const agents = search.has("mock-agents")
                ? (mockConnectedAgentScenes.find((scene) => scene === search.get("mock-agents")) ??
                  "seeded")
                : null;
              // `?mock-cloud=<scene>` puts an Opensteer Account with a Cloud Computer in
              // that state behind the mock desktop (`?mock-desktop=home`).
              const cloudScene =
                mockCloudComputerScenes.find((scene) => scene === search.get("mock-cloud")) ?? null;
              // `?mock-home=server|cloud`: the Home is reached at its own address, a server or
              // (with `?mock-desktop=home&mock-cloud=ready`) the person's Cloud Computer.
              const mockHome = search.get("mock-home");
              const client = new MockHostClient({
                ...(cloudScene ? { portalOrigin: "https://app.opensteer.example" } : {}),
                ...(mockHome === "server" || mockHome === "cloud"
                  ? { exposure: "networked" as const }
                  : {}),
                ...(agents ? mockConnectedAgents(agents) : {}),
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
              // `?mock-asleep-step`: the computer-use task's last call was refused, a Mac asleep.
              if (search.has("mock-asleep-step")) client.mockAsleepStep();
              // `?mock-device-states`: a Device asleep and one waiting for an update.
              if (search.has("mock-device-states")) client.mockDeviceStates();
              // `?mock-agent-work`: connected agents working tasks themselves (with `?mock-agents`).
              if (search.has("mock-agent-work"))
                client.mockAgentWork({ long: search.get("mock-agent-work") === "long" });
              // `?mock-iphone-setup` lets this window set up iPhones as Opensteer on a Mac does,
              // playing a whole setup; `?mock-iphone-setup=<state>` holds it at one state.
              const iphoneScene = search.get("mock-iphone-setup");
              if (iphoneScene !== null)
                Object.assign(client, {
                  iphoneSetup: createMockIphoneSetupPort({
                    autoplay: !(iphoneScene in mockIphoneSetupScenes),
                    dispatch: (command) => client.dispatch(command),
                    ...(iphoneScene in mockIphoneSetupScenes
                      ? { start: iphoneScene as keyof typeof mockIphoneSetupScenes }
                      : {}),
                  }),
                });
              initializeBrowserMessageOutbox(client);
              // The preview's own client, for journeys that count what the page sends.
              Object.assign(window, { opensteerMock: client });
              if (desktopScenario)
                return attachMockDesktop(
                  client,
                  desktopScenario,
                  cloudScene
                    ? new MockCloudComputerAccount(
                        cloudScene,
                        mockHome === "cloud" ? client.getSnapshot().deploymentId : null,
                      )
                    : null,
                );
              const downloadsScript = new URLSearchParams(window.location.search).get(
                "mock-downloads",
              );
              if (downloadsScript !== null) {
                return Promise.all([
                  import("./desktop/desktop-preview-bridge.js"),
                  import("@opensteer/protocol/desktop"),
                ]).then(
                  ([
                    {
                      desktopPreviewBridge,
                      desktopPreviewDownloads,
                      installDesktopPreviewHostRoute,
                    },
                    { DesktopDownloadsSnapshotSchema },
                  ]) => {
                    const initial = DesktopDownloadsSnapshotSchema.parse({
                      downloads: JSON.parse(downloadsScript),
                    });
                    const downloads = desktopPreviewDownloads(initial.downloads);
                    const bridge = desktopPreviewBridge("?desktop-preview=first-run", true);
                    if (bridge) installDesktopPreviewHostRoute(bridge);
                    Object.assign(window, {
                      opensteerDesktop: { ...bridge, downloads },
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
              cloud: InstanceType<typeof MockCloudComputerAccount> | null,
            ) {
              const [
                { desktopPreviewBridge, installDesktopPreviewHostRoute },
                { desktopSummaryFromAccess },
              ] = await Promise.all([
                import("./desktop/desktop-preview-bridge.js"),
                import("./desktop/desktop-deployment-selection.js"),
              ]);
              // Remote access on through Connect, as a Home that has it reports it.
              if (scenario !== "blocked")
                client.connectRemoteAccess("https://alex.connect.opensteer.invalid");
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
                host: client.rpc,
              });
              if (!bridge) return client;
              if (cloud)
                Object.assign(bridge, {
                  cloudComputerRead: () => cloud.read(),
                  cloudComputerAct: (input: Parameters<typeof cloud.act>[0]) => cloud.act(input),
                });
              installDesktopPreviewHostRoute(bridge);
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
            // The same quiet-socket probe as Desktop and the phone; a hidden tab pauses it.
            realtimeLiveness: {
              idleMs: realtimeIdleProbeMs,
              deadlineMs: realtimeIdleProbeDeadlineMs,
            },
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
      <App hostClient={hostClient} {...previewDesktop} />
    </StrictMode>,
  );
}

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

async function resolveDesktopPreviewBridge() {
  if (
    !import.meta.env.DEV ||
    new URLSearchParams(window.location.search).get("desktop-preview") !== "first-run"
  ) {
    return null;
  }
  const { desktopPreviewBridge, installDesktopPreviewHostRoute } =
    await import("./desktop/desktop-preview-bridge.js");
  const bridge = desktopPreviewBridge();
  if (bridge) installDesktopPreviewHostRoute(bridge);
  return bridge;
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

/** The page's local storage, or undefined where reaching it throws (blocked site data). */
function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
