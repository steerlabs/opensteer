import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./styles/index.css";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import {
  passwordSignInOutcome,
  passwordSignInReceipt,
  type RequestReceiptEntry,
  type ToolEntry,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { MockHostClient, mockPasswordSignInRequest } from "@opensteer/client/mock";
import { createId, emptyExecutionPreferences, type Request } from "@opensteer/core";
import type { PasswordSignInRequestResponse } from "@opensteer/protocol";
import type { AgentBrowserSignInResult } from "@opensteer/protocol/browser-sources";
import {
  DesktopDeploymentSummarySchema,
  type DesktopPasswordsSignInCardState,
  type DesktopPasswordsStatus,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { AgentTranscript } from "./components/agent-activity.js";
import type { ShellContext } from "./components/app-shell.js";
import { InputSurface } from "./components/input-surface.js";
import { SettingsSectionRoute, SettingsShell } from "./components/settings/settings-shell.js";
import {
  PasswordSignInRequestBody,
  type PasswordSignInCardBridge,
} from "./components/thread-password-sign-in-action.js";
import { ToastProvider } from "./components/toast.js";
import { previewPasswordsSignInCard } from "./desktop/desktop-preview-bridge.js";

/**
 * Visual QA for Opensteer Passwords, on the preview's own mock so a decline
 * settles as a Host would settle it. `?view=` picks the surface:
 *
 *   card      the sign-in card docked in a conversation the window's height (default)
 *             `&here` on the approving Mac, starting at `&card=` (see `previewPasswordsSignInCard`);
 *             `&cancel-auth` makes Allow come back as a cancelled Touch ID
 *   cards     every card stage side by side, here and elsewhere
 *   resolved  every way a sign-in ends: cards, Request receipts and `sign_in` steps
 *   settings  Settings → Passwords                            `&state=` below, `&waiting` adds two sign-ins
 *
 * Settings states: not-set-up, ready (default), ready-off, development,
 * needs-reset, unsupported (hardware), unsupported-platform, unsupported-os,
 * unavailable, broken (the read itself fails), elsewhere (a browser or another
 * computer), server.
 */
const search = new URLSearchParams(location.search);
const view = search.get("view") ?? "card";
const here = search.has("here");
const settingsState = search.get("state") ?? "ready";

const threadId = "thr_00000000-0000-4000-8000-000000000004";
const noOp = () => undefined;
const origin = "http://127.0.0.1:4315";

const cardState = previewPasswordsSignInCard(location.search);

const client = new MockHostClient({
  latencyMs: 0,
  pendingRequests:
    view === "card"
      ? [mockPasswordSignInRequest(cardState.stage === "approval" ? { site: cardState.site } : {})]
      : view === "settings" && search.has("waiting")
        ? [mockPasswordSignInRequest({ index: 1 }), mockPasswordSignInRequest({ index: 2 })]
        : [],
});

const bridge = view === "settings" || here ? passwordsBridge() : null;
const onThisMac = bridge !== null && settingsState !== "elsewhere" && settingsState !== "server";

function useShellContext(): ShellContext {
  const live = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const snapshot =
    settingsState === "server"
      ? {
          ...live,
          deploymentShape: {
            defaultWorkspaceBacking: "portablefs" as const,
            kind: "server" as const,
          },
          identityConfig: live.identityConfig && {
            ...live.identityConfig,
            deployment: { cloud: true, kind: "self-hosted" as const, name: "Design Cloud" },
            publicOrigin: "https://design.example.test",
          },
        }
      : live;
  return {
    actionError: null,
    askOpensteerAbout: noOp,
    clearActionError: noOp,
    clearHomeHandoff: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: onThisMac ? bridge : null,
    desktopDeployment: onThisMac
      ? DesktopDeploymentSummarySchema.parse({
          access: "owner",
          activeOrigin: origin,
          canonicalOrigin: origin,
          id: createId("deployment"),
          kind: "personal",
          lastUsedAt: null,
          name: "Mac mini",
          onThisComputer: true,
          routes: [{ kind: "canonical", origin, selected: true }],
        })
      : null,
    executionPreferences: emptyExecutionPreferences,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
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
    setHomeDraft: noOp,
    snapshot: { ...snapshot, connection: "connected" },
    writeInChat: noOp,
  };
}

function Shell() {
  return <Outlet context={useShellContext()} />;
}

function CardView() {
  const { snapshot } = useShellContext();
  const requests = snapshot.requests[threadId] ?? [];
  const receipts = (snapshot.transcripts[threadId] ?? []).filter(
    (entry) => entry.kind === "request" && entry.requestKind === "browser.password-sign-in",
  );
  // The thread's own frame, so the card meets the height a window gives it.
  return (
    <div className="thread">
      <header className="conv-header">
        <h1 className="conv-header__title">
          <span className="conv-header__name conv-header__name--static">Chat</span>
        </h1>
      </header>
      <div className="thread__conversation">
        <div className="transcript-scroll">
          <div className="transcript">
            <p className="sign-in-card__lead">Sign in to the site with my saved password.</p>
            {receipts.length > 0 ? <AgentTranscript entries={receipts} /> : null}
          </div>
        </div>
      </div>
      <div className="composer-dock">
        <InputSurface
          disabled={false}
          placeholder="Ask Opensteer…"
          requests={requests}
          running={false}
          threadId={threadId}
        />
      </div>
    </div>
  );
}

/** Every stage a card can be in, each on its own fake Mac. */
const stages: readonly (readonly [string, DesktopPasswordsSignInCardState | null])[] = [
  ["Approved account", previewPasswordsSignInCard("?card=authorized")],
  ["Elsewhere: a browser, a phone, another computer", null],
  ["On the Mac: two saved accounts", previewPasswordsSignInCard("?card=approval")],
  ["On the Mac: one saved account", previewPasswordsSignInCard("?card=approval-one")],
  ["On the Mac: nothing saved for the site", previewPasswordsSignInCard("?card=approval-none")],
  [
    "On the Mac: the same username saved three times",
    previewPasswordsSignInCard("?card=approval-duplicates"),
  ],
  ["On the Mac: usernames wider than the card", previewPasswordsSignInCard("?card=approval-long")],
  ["The Mac no longer runs it", previewPasswordsSignInCard("?card=gone")],
];

function CardsView() {
  return (
    <main style={pageStyle}>
      <div style={{ display: "grid", gap: 16 }}>
        {stages.map(([label, state], index) => (
          <section className="card card__form" key={label}>
            <span className="eyebrow eyebrow--micro">{label}</span>
            <PasswordSignInRequestBody
              client={client}
              computerName="Mac mini"
              disabled={false}
              mac={state === null ? null : cardBridge(state)}
              request={mockPasswordSignInRequest({ index: index + 1 })}
              workspaceName="Main"
            />
          </section>
        ))}
      </div>
    </main>
  );
}

/** One sign-in on a Mac that answers as Electron main would and never changes by itself. */
function cardBridge(initial: DesktopPasswordsSignInCardState): PasswordSignInCardBridge {
  let state = initial;
  const listeners = new Set<(next: DesktopPasswordsSignInCardState) => void>();
  const move = (next: DesktopPasswordsSignInCardState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    onPasswordsSignInChanged: (_input, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    passwordsSignInApprove: async ({ loginId }) => {
      const account =
        state.stage === "approval" ? state.accounts.find(({ id }) => id === loginId) : undefined;
      if (!account || search.has("cancel-auth")) {
        return { message: "Touch ID was cancelled. Choose Allow to try again.", ok: false };
      }
      move({ account: account.username, stage: "authorized" });
      return { ok: true };
    },
    passwordsSignInGet: async () => state,
  };
}

const endings: readonly (readonly [string, Request])[] = [
  ["Authorized", fulfilled({ outcome: "authorized", account: "t•••@example.com" }, 20)],
  [
    "Historical saved-password sign-in",
    fulfilled({ method: "saved-password", outcome: "signed-in" }, 1),
  ],
  ["The person signed in", fulfilled({ method: "person", outcome: "signed-in" }, 2)],
  ["Declined", mockPasswordSignInRequest({ index: 3, status: "declined" })],
  ["Expired", fulfilled({ outcome: "expired" }, 4)],
  ["Wrong password", fulfilled({ outcome: "failed", reason: "wrong-password" }, 5)],
  ["Unsupported page", fulfilled({ outcome: "failed", reason: "unsupported-page" }, 6)],
  ["Blocked destination", fulfilled({ outcome: "failed", reason: "blocked-destination" }, 7)],
  ["Cleanup failed", fulfilled({ outcome: "failed", reason: "cleanup-failed" }, 8)],
  ["Busy", fulfilled({ outcome: "failed", reason: "busy" }, 9)],
  ["Needs a fresh session", fulfilled({ outcome: "failed", reason: "needs-fresh-session" }, 10)],
  ["Passwords off", fulfilled({ outcome: "unavailable", reason: "passwords-off" }, 11)],
  ["Outcome unknown", fulfilled({ outcome: "outcome-unknown" }, 12)],
  ["Session closed", fulfilled({ outcome: "session-closed" }, 13)],
  ["Interrupted", fulfilled({ outcome: "interrupted" }, 14)],
];

/** What `sign_in` can return, as the transcript shows each call. */
const autonomous: readonly AgentBrowserSignInResult[] = [
  { method: "saved-password", site: "https://github.com", status: "signed-in" },
  { method: "person", site: "https://github.com", status: "signed-in" },
  { expiresAt: "2026-10-11T09:20:00.000Z", site: "https://github.com", status: "needs-code" },
  {
    replayed: false,
    requestId: createId("request"),
    status: "pending",
    waitingFor: "approval",
  },
  {
    replayed: false,
    requestId: createId("request"),
    status: "pending",
    waitingFor: "person",
  },
  { reason: "wrong-password", site: "https://github.com", status: "failed" },
  { reason: "unsupported-page", site: "https://github.com", status: "failed" },
  { reason: "needs-approval", site: "https://github.com", status: "unavailable" },
  { reason: "no-code-expected", site: "https://github.com", status: "unavailable" },
  { requestId: createId("request"), status: "declined" },
  { profileName: null, site: "https://github.com", sourceName: "Work", status: "applied" },
];

function signInStep(result: AgentBrowserSignInResult, index: number): ToolEntry {
  const createdAt = new Date(Date.UTC(2026, 9, 11, 9, 0, index * 2)).toISOString();
  return {
    arguments: {
      reason: "Download the October statement",
      sessionId: "bss_preview",
      site: "https://github.com",
    },
    callId: `preview-sign-in-${index}`,
    completedAt: createdAt,
    createdAt,
    id: `tool:preview:sign-in-${index}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: { text: JSON.stringify(result) },
    runId: "run_00000000-0000-4000-8000-000000000004",
    state: "done",
    streamText: "",
    tool: { name: "sign_in", namespace: "opensteer" },
  };
}

function fulfilled(response: PasswordSignInRequestResponse, index: number): Request {
  return mockPasswordSignInRequest({ index, response, status: "fulfilled" });
}

function ResolvedView() {
  const receipts: RequestReceiptEntry[] = endings.map(([, request]) => ({
    createdAt: request.resolvedAt ?? request.createdAt,
    id: `request:${request.id}`,
    kind: "request",
    outcome: passwordSignInReceipt(request),
    requestId: request.id,
    requestKind: request.kind,
    runId: request.originatingRunId,
    succeeded: passwordSignInOutcome(request)?.signedIn ?? false,
    title: request.presentation.title,
  }));
  return (
    <main style={pageStyle}>
      <div style={{ display: "grid", gap: 16 }}>
        {endings.map(([label, request]) => (
          <section className="card card__form" key={request.id}>
            <span className="eyebrow eyebrow--micro">{label}</span>
            <PasswordSignInRequestBody
              client={client}
              computerName="Mac mini"
              disabled={false}
              mac={null}
              request={request}
              workspaceName="Main"
            />
          </section>
        ))}
      </div>
      <h2 className="settings-group__title" style={{ marginTop: 32 }}>
        In the transcript
      </h2>
      <AgentTranscript entries={receipts} />
      <h2 className="settings-group__title" style={{ marginTop: 32 }}>
        Agent sign-ins in the transcript
      </h2>
      <AgentTranscript entries={autonomous.map(signInStep) satisfies TranscriptEntry[]} />
    </main>
  );
}

function App() {
  if (view === "resolved") return <ResolvedView />;
  if (view === "cards") return <CardsView />;
  return (
    <MemoryRouter initialEntries={[view === "settings" ? "/settings/passwords" : "/visual"]}>
      <div className="app-shell">
        <main className="app-shell__main">
          <Routes>
            <Route element={<Shell />}>
              <Route element={<SettingsShell />} path="settings">
                <Route element={<SettingsSectionRoute section="passwords" />} path="passwords" />
                <Route element={<SettingsSectionRoute section="chrome" />} path="chrome" />
              </Route>
              <Route element={<CardView />} path="*" />
            </Route>
          </Routes>
        </main>
      </div>
    </MemoryRouter>
  );
}

/** The Mac's side, as `&state=` and `&card=` describe it. */
function passwordsBridge(): OpensteerDesktopBridge {
  const status = previewStatus(settingsState);
  const fake: Pick<
    OpensteerDesktopBridge,
    "onPasswordsStatusChanged" | "passwordsOpen" | "passwordsStatus"
  > &
    PasswordSignInCardBridge = {
    ...cardBridge(cardState),
    onPasswordsStatusChanged: () => () => undefined,
    passwordsOpen: async () => {
      window.alert("The Passwords window opens.");
    },
    passwordsStatus: async () => {
      if (settingsState === "broken") {
        throw new Error("The Opensteer app couldn’t reach Opensteer Passwords.");
      }
      return status;
    },
  };
  // The page reaches only the Passwords members; nothing else on it asks the bridge.
  return fake as unknown as OpensteerDesktopBridge;
}

function previewStatus(state: string): DesktopPasswordsStatus {
  const available = (
    vault: "needs-reset" | "not-set-up" | "ready",
    agentSignIns: "off" | "on",
    development = false,
  ): DesktopPasswordsStatus => ({
    availability: "available",
    broker: { agentSignIns, vault },
    development,
  });
  switch (state) {
    case "not-set-up":
      return available("not-set-up", "off");
    case "needs-reset":
      return available("needs-reset", "off");
    case "ready-off":
      return available("ready", "off");
    case "development":
      return available("ready", "on", true);
    case "unsupported":
      return { availability: "unsupported", reason: "hardware" };
    case "unsupported-platform":
      return { availability: "unsupported", reason: "platform" };
    case "unsupported-os":
      return { availability: "unsupported", reason: "os" };
    case "unavailable":
      return {
        availability: "unavailable",
        message: "Opensteer Passwords isn’t responding. Quit and reopen Opensteer.",
      };
    default:
      return available("ready", "on");
  }
}

const pageStyle = { margin: "48px auto", padding: 16, width: "min(760px, 100%)" } as const;

const container = document.getElementById("root");
if (!container) throw new Error("Missing root");
createRoot(container).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
