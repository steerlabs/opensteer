import { installDictation } from "./desktop/dictation-runtime.js";
import { DictationContext } from "./components/dictation.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopBridge } from "./desktop/desktop-bridge.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { initializeDesktopWindowChrome } from "./desktop/window-controls-overlay.js";
import { StartupFailure } from "./components/onboarding-card.js";
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
    appRoot.render(<DictationContext value={dictation}>{children}</DictationContext>),
};

/** The path the desktop's floating Full access panel loads. */
const fullAccessPanelPath = "/full-access";
/** The desktop's two computer-use windows: over System Settings, and the approval. */
const computerUsePermissionsPanelPath = "/computer-use/permissions";
const computerUseApprovalPanelPath = "/computer-use/approve";
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
    // The desktop names itself the way the macOS list does ("Opensteer Beta"
    // on the beta channel); the preview has no channel and says Opensteer.
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
  if (bridge && window.location.pathname === computerUseApprovalPanelPath) {
    const { ComputerUseApprovalPanel } = await import("./desktop/computer-use-approval-panel.js");
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    reactRoot.render(
      <StrictMode>
        <ComputerUseApprovalPanel bridge={bridge} token={token} />
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

  const [{ App }, hostClient] = await Promise.all([
    import("./app.js"),
    import.meta.env.VITE_OPENSTEER_USE_MOCK === "true"
      ? Promise.all([
          import("@opensteer/client/mock"),
          import("./host/browser-host-client.js"),
          import("./host/browser-lifecycle.js"),
        ]).then(
          ([{ MockHostClient }, { browserPreferencesStorage }, { browserClientLifecycle }]) => {
            const world = new URLSearchParams(window.location.search).get("mock-world");
            const client = new MockHostClient({
              lifecycle: browserClientLifecycle(),
              browserPreferencesStorage,
              ...(world === "first-run" || world === "busy" || world === "stress" ? { world } : {}),
            });
            // The preview's own client, for journeys that count what the page sends.
            Object.assign(window, { opensteerMock: client });
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
      <App hostClient={hostClient} />
    </StrictMode>,
  );
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
