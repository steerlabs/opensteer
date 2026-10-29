import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import {
  browserSiteForUrl,
  browserSiteLabel,
  mutationIdempotencyKey,
  unwrapRpcResult,
} from "@opensteer/client/host";
import { MockHostClient, mockBrowserSignInRequest } from "@opensteer/client/mock";
import { emptyExecutionPreferences } from "@opensteer/core";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol/browser";
import { AgentTranscript } from "./components/agent-activity.js";
import type { ShellContext } from "./components/app-shell.js";
import { BrowserToolbar } from "./components/browser/browser-chrome.js";
import {
  BrowserSignInPopover,
  browserSignInLabel,
  signedInMessage,
} from "./components/browser/browser-sign-in.js";
import {
  ChromeConnectEnvironmentContext,
  type ChromeConnectEnvironment,
  type ChromeConnectPlace,
} from "./components/chrome/chrome-environment.js";
import { ChromeConnectCard } from "./components/chrome/chrome-connect-page.js";
import { ConnectChrome } from "./components/chrome/connect-chrome.js";
import { InputSurface } from "./components/input-surface.js";
import { SurfaceMenu } from "./components/surface-menu.js";
import { SettingsShell, SettingsSectionRoute } from "./components/settings/settings-shell.js";
import { ToastProvider, useToast } from "./components/toast.js";

/**
 * Visual QA for Chrome sign-ins, on the preview's own mock so every answer is
 * the one a Host would give. `?view=` picks the surface:
 *
 *   settings  Settings → Chrome                          (default)
 *   card      the sign-in card in a conversation         `&site=github.com`
 *   toolbar   Sign in with Chrome… in the page's menu   `&site=github.com&open`
 *   connect   Connect Chrome on its own                  `&compact`
 *   page      the public /connect/chrome page            `&error`
 *
 * The mock's sites cover each state: github.com (one Chrome), linear.app (two
 * — choose), notion.so (stopped), figma.com (blocked), x.com (daily limit),
 * stripe.com (only the offline Chrome); anything else is signed out.
 * `&chrome=none` disconnects every Chrome first; `&chrome=online` only the offline one. `&place=chromium|desktop|
 * other-browser|phone` says where the page runs, and `&extension=installed|
 * missing|later` whether the extension answers (later: after six seconds).
 */
const search = new URLSearchParams(location.search);
const view = search.get("view") ?? "settings";
const site = `https://${search.get("site") ?? "github.com"}`;
const place = (search.get("place") ?? "chromium") as ChromeConnectPlace;
const extension = search.get("extension") ?? "installed";
const loadedAt = Date.now();

const client = new MockHostClient({
  latencyMs: 0,
  pendingRequests: view === "card" ? [mockBrowserSignInRequest(site, 1)] : [],
});
const keepChrome = search.get("chrome");
if (keepChrome === "none" || keepChrome === "online") {
  const { sources } = unwrapRpcResult(await client.rpc["browser.sources.get"]({}));
  for (const source of sources) {
    if (keepChrome === "online" && source.connected) continue;
    await client.dispatch({
      idempotencyKey: mutationIdempotencyKey("visual-revoke"),
      sourceId: source.id,
      type: "browser.source.revoke",
    });
  }
}

const environment: ChromeConnectEnvironment = {
  copy: async () => true,
  hostHere: true,
  openExtensionConnect: () => true,
  openInDefaultBrowser: async () => undefined,
  place,
  probeExtension: async () =>
    extension === "installed" || (extension === "later" && Date.now() - loadedAt > 6_000),
};

const signInThreadId = "thr_00000000-0000-4000-8000-000000000004";
const noOp = () => undefined;

function useShellContext(): ShellContext {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return {
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
    desktopBridge: null,
    desktopDeployment: null,
    executionPreferences: emptyExecutionPreferences,
    hostClient: client,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: null,
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
    snapshot: { ...snapshot, connection: "connected" },
  };
}

function Shell() {
  return <Outlet context={useShellContext()} />;
}

function CardView() {
  const { snapshot } = useShellContext();
  const requests = snapshot.requests[signInThreadId] ?? [];
  const receipts = (snapshot.transcripts[signInThreadId] ?? []).filter(
    (entry) => entry.kind === "request" && entry.requestKind === "browser.sign-in",
  );
  return (
    <main style={{ margin: "48px auto", padding: 16, width: "min(760px, 100%)" }}>
      {receipts.length > 0 ? <AgentTranscript entries={receipts} /> : null}
      <InputSurface
        disabled={false}
        placeholder="Ask Opensteer…"
        requests={requests}
        running={false}
        threadId={signInThreadId}
      />
    </main>
  );
}

function ToolbarView() {
  const toast = useToast();
  const url = `${site}/opensteer/opensteer/pulls`;
  const pageSite = browserSiteForUrl(url);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const [signingIn, setSigningIn] = useState(search.has("open"));
  return (
    <main style={{ height: "100dvh", padding: 16 }}>
      <div className="browser-view" style={{ border: "1px solid var(--line)", borderRadius: 12 }}>
        <BrowserToolbar
          omnibox={{ hostClient: client, choice: { kind: "guest" } }}
          activeTab={{
            active: true,
            id: BrowserSurfaceIdSchema.parse("tab-1"),
            title: "Pull requests",
            url,
          }}
          disabled={false}
          onBack={noOp}
          onForward={noOp}
          onNavigate={noOp}
          onReload={noOp}
          trailing={
            <SurfaceMenu
              buttonRef={setMenuButton}
              items={[
                {
                  detail: pageSite ? browserSiteLabel(pageSite) : "Open a website first",
                  disabled: pageSite === null,
                  icon: "unlock",
                  label: browserSignInLabel,
                  onSelect: () => setSigningIn(true),
                },
              ]}
              label="Browser options"
              onOpen={() => setSigningIn(false)}
            />
          }
        />
        <div style={{ background: "#f4f4f2", flex: 1, minHeight: 420 }} />
      </div>
      {signingIn && menuButton && pageSite ? (
        <BrowserSignInPopover
          anchor={menuButton}
          client={client}
          environment={environment}
          onClose={() => setSigningIn(false)}
          onSignedIn={(outcome) => toast.success(signedInMessage(outcome))}
          sessionId="bss_preview"
          site={pageSite}
          url={url}
          workspaceId="wsp_00000000-0000-4000-8000-000000000001"
          workspaceName="Main"
        />
      ) : null}
    </main>
  );
}

function App() {
  if (view === "page") {
    return (
      <ChromeConnectCard
        state={
          search.has("error")
            ? {
                error:
                  "This connection link expired. Go back to Opensteer and choose Connect Chrome again.",
                link: null,
              }
            : {
                error: null,
                link: {
                  deploymentName: "Mac mini",
                  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                  invitation: "opensteer-browser-source:preview",
                },
              }
        }
      />
    );
  }
  if (view === "connect") {
    return (
      <main style={{ margin: "48px auto", maxWidth: 560, padding: 16 }}>
        <div className="card card__form">
          <ConnectChrome
            client={client}
            compact={search.has("compact")}
            environment={environment}
          />
        </div>
      </main>
    );
  }
  return (
    <MemoryRouter initialEntries={[view === "settings" ? "/settings/chrome" : "/visual"]}>
      <div className="app-shell">
        <main className="app-shell__main">
          <Routes>
            <Route element={<Shell />}>
              <Route element={<SettingsShell />} path="settings">
                <Route element={<SettingsSectionRoute section="chrome" />} path="chrome" />
              </Route>
              <Route element={view === "card" ? <CardView /> : <ToolbarView />} path="*" />
            </Route>
          </Routes>
        </main>
      </div>
    </MemoryRouter>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
createRoot(container).render(
  <ChromeConnectEnvironmentContext.Provider value={environment}>
    <ToastProvider>
      <App />
    </ToastProvider>
  </ChromeConnectEnvironmentContext.Provider>,
);
