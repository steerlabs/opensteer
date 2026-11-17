import { act, Fragment, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { afterEach, beforeAll, vi } from "vitest";
import { MockHostClient, type MockHostClientOptions } from "@opensteer/client/mock";
import { type HostClient, placeList, type PlaceItem } from "@opensteer/client/host";

import { AppShell } from "../app-shell.js";
import { AutomationDetailPage } from "../automations/automation-detail.js";
import { AutomationsPage } from "../automations/automations-page.js";
import { DevicePage } from "../devices/device-page.js";
import { HomeRoute } from "../home/home-route.js";
import { SettingsRedirect } from "../settings/settings-redirect.js";
import { SettingsSectionRoute, SettingsShell } from "../settings/settings-shell.js";
import { ThreadRoute } from "../thread-view.js";
import { ToastProvider } from "../toast.js";
import { LiveRedirect } from "./live-redirect.js";
import { TeamRoutes } from "../../team/team-routes.js";
import { TeamsProvider, type TeamAttachment } from "../../team/team-attachments.js";
import {
  MockTeamHost,
  TeamSessionClient,
  busyTeamIds,
  createMemoryTeamPersistence,
  mockAccountEmail,
  mockAccountSubject,
  type MockTeamWorld,
} from "@opensteer/client/team";
import { TeamDialogsProvider } from "../../team/hosted-teams.js";
import { TeamsRoute } from "../../team/join-route.js";
import { SettingsTeamRoute } from "../settings/settings-shell.js";
import { composerField, rewrite } from "../composer-editor.test-support.js";

/**
 * The workspace contract over the moving mock world: each selection action
 * changes exactly its axis with one history entry; Host events never
 * navigate; the middle and the conversation stay mounted; focus never drops
 * to the body; the draft's places follow, freeze and stick.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let client: MockHostClient;
let sessionClient: HostClient | null = null;
let teamHost: MockTeamHost | null = null;
let teamSession: TeamSessionClient | null = null;
/** Teams past the first, for a mount with more than one. */
let moreTeams: { host: MockTeamHost; session: TeamSessionClient }[] = [];
interface Step {
  readonly type: string;
  readonly path: string;
  readonly search: string;
  readonly hash?: string;
}
let history: Step[] = [];
let historyState: unknown = null;
let historyKey = "";
/** The router's own navigate, for Back and Forward as a person's browser does them. */
let goTo: ReturnType<typeof useNavigate> | null = null;
/** The window's width as media queries read it, changeable mid-test like a resize. */
const viewport = { queries: new Set<EventTarget>(), width: 1440 };
async function resize(width: number) {
  viewport.width = width;
  await act(async () => {
    for (const query of viewport.queries) query.dispatchEvent(new Event("change"));
  });
  await settle();
}

// Prime React and the shell outside an individual case's deadline. Each shard
// still executes the real mount and disposes all fixture state before its cases.
beforeAll(async () => {
  try {
    await mount("/");
  } finally {
    cleanupWorkspace();
  }
});

afterEach(cleanupWorkspace);

function cleanupWorkspace() {
  act(() => root?.unmount());
  root = null;
  sessionClient?.dispose();
  sessionClient = null;
  teamSession?.dispose();
  teamSession = null;
  teamHost?.dispose();
  teamHost = null;
  for (const team of moreTeams) {
    team.session.dispose();
    team.host.dispose();
  }
  moreTeams = [];
  client?.dispose();
  history = [];
  goTo = null;
  viewport.queries.clear();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

function History() {
  const location = useLocation();
  historyState = location.state;
  historyKey = location.key;
  const type = useNavigationType();
  goTo = useNavigate();
  const last = history.at(-1);
  if (
    !last ||
    last.path !== location.pathname ||
    last.search !== location.search ||
    (last.hash ?? "") !== location.hash
  )
    history.push({
      path: location.pathname,
      search: location.search,
      ...(location.hash ? { hash: location.hash } : {}),
      type,
    });
  return null;
}

type Entry =
  string | { readonly pathname: string; readonly search?: string; readonly state?: unknown };

async function mount(
  path: Entry | ((client: MockHostClient) => Entry),
  options: {
    hostClient?: (source: MockHostClient) => HostClient;
    strict?: boolean;
    width?: number;
    /** A touch screen, where focusing a field brings up an on-screen keyboard. */
    touch?: boolean;
    now?: () => Date;
    /** The mock Host's pace, for a scripted run that must still be working when acted on. */
    latencyMs?: number;
    /** What else the mock Host starts with: plugins, say. */
    mock?: Omit<MockHostClientOptions, "latencyMs" | "now">;
    /** One live mock team beside the person's own tasks, as a joined desktop has; a second named here. */
    team?: boolean | { readonly second: string };
    /** Hosted teams this app can create and join, in memory. */
    world?: MockTeamWorld;
    /** The Host the last mount drew, as a page reload finds it. */
    sameHost?: boolean;
    shell?: Partial<
      Pick<
        Parameters<typeof AppShell>[0],
        "deploymentAccess" | "desktopBridge" | "desktopDeployment"
      >
    >;
  } = {},
) {
  stubLayout(options.width ?? 1440, options.touch);
  if (!options.sameHost) {
    client = new MockHostClient({
      ...options.mock,
      latencyMs: options.latencyMs ?? 0,
      ...(options.now ? { now: options.now } : {}),
    });
    await client.load();
  }
  const entry = typeof path === "function" ? path(client) : path;
  sessionClient = options.hostClient?.(client) ?? null;
  if (sessionClient) await sessionClient.load();
  let teams: readonly TeamAttachment[] = [];
  if (options.team && options.sameHost && teamHost && teamSession) {
    teams = [
      {
        teamId: teamHost.teamId,
        name: teamHost.bootstrap.teamName,
        origin: teamHost.origin,
        client: teamSession,
        link: null,
      },
      ...moreTeams.map(({ host, session }) => ({
        teamId: host.teamId,
        name: host.bootstrap.teamName,
        origin: "https://chat.second.example",
        client: session,
        link: null,
      })),
    ];
  } else if (options.team) {
    const host = new MockTeamHost();
    teamHost = host;
    const session = new TeamSessionClient({
      scope: { teamDeploymentId: host.teamId, userId: host.userId },
      persistence: createMemoryTeamPersistence(),
      rpc: host.rpc,
      connect: host.connect,
    });
    await session.load();
    teamSession = session;
    teams = [
      {
        teamId: host.teamId,
        name: host.bootstrap.teamName,
        origin: "https://chat.acme.example",
        client: session,
        link: null,
      },
    ];
    if (typeof options.team === "object") {
      const second = new MockTeamHost({
        teamId: busyTeamIds[1],
        teamName: options.team.second,
      });
      const secondSession = new TeamSessionClient({
        scope: { teamDeploymentId: second.teamId, userId: second.userId },
        persistence: createMemoryTeamPersistence(),
        rpc: second.rpc,
        connect: second.connect,
      });
      await secondSession.load();
      moreTeams.push({ host: second, session: secondSession });
      teams = [
        ...teams,
        {
          teamId: second.teamId,
          name: second.bootstrap.teamName,
          origin: "https://chat.second.example",
          client: secondSession,
          link: null,
        },
      ];
    }
  }
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const Wrapper = options.strict ? StrictMode : Fragment;
  await act(async () =>
    root?.render(
      <Wrapper>
        <ToastProvider>
          <TeamsProvider
            account={
              options.world ? { subject: mockAccountSubject, email: mockAccountEmail } : null
            }
            surface={{
              kind: "preview",
              hostClient: sessionClient ?? client,
              teams,
              world: options.world,
            }}
          >
            <MemoryRouter initialEntries={[entry]}>
              <History />
              <TeamDialogsProvider>
                <Routes>
                  <Route
                    element={
                      <AppShell
                        hostClient={sessionClient ?? client}
                       
                        {...options.shell}
                      />
                    }
                  >
                    <Route index element={<HomeRoute />} />
                    <Route path="tasks/:threadId" element={<ThreadRoute />} />
                    <Route path="teams" element={<TeamsRoute />} />
                    <Route path="teams/:teamId/*" element={<TeamRoutes />} />
                    <Route path="live" element={<LiveRedirect />} />
                    <Route path="automations" element={<AutomationsPage />} />
                    <Route path="automations/:triggerId" element={<AutomationDetailPage />} />
                    <Route
                      path="computers/*"
                      element={<SettingsRedirect from="/computers" to="/settings/devices" />}
                    />
                    <Route path="settings" element={<SettingsShell />}>
                      <Route
                        index
                        element={<SettingsRedirect from="/settings" to="/settings/general" />}
                      />
                      <Route path="general" element={<SettingsSectionRoute section="general" />} />
                      <Route
                        path="ai-engines"
                        element={<SettingsRedirect from="/settings/ai-engines" to="/settings/ai" />}
                      />
                      <Route path="ai" element={<SettingsSectionRoute section="ai" />} />
                      <Route path="account" element={<SettingsSectionRoute section="account" />} />
                      <Route
                        path="plugins/*"
                        element={<SettingsSectionRoute section="plugins" />}
                      />
                      <Route path="devices" element={<SettingsSectionRoute section="devices" />} />
                      <Route path="devices/:deviceId" element={<DevicePage />} />
                      <Route path="teams/:teamId/:page" element={<SettingsTeamRoute />} />
                    </Route>
                  </Route>
                </Routes>
              </TeamDialogsProvider>
            </MemoryRouter>
          </TeamsProvider>
        </ToastProvider>
      </Wrapper>,
    ),
  );
  await settle();
  return node;
}

/** Observers that never fire and media queries that answer to `viewport.width`. */
function stubLayout(width: number, touch = false) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  viewport.width = width;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const max = /max-width:\s*(\d+)px/u.exec(query);
    const media = Object.assign(new EventTarget(), {
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
    });
    Object.defineProperty(media, "matches", {
      get: () =>
        max ? viewport.width <= Number(max[1]) : touch && query.includes("(pointer: coarse)"),
    });
    viewport.queries.add(media);
    return media as unknown as MediaQueryList;
  });
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function element<T extends Element>(selector: string, scope: ParentNode = document): T {
  const match = scope.querySelector<T>(selector);
  if (!match) throw new Error(`Missing ${selector}`);
  return match;
}

async function click(target: Element) {
  await act(async () => {
    (target as HTMLElement).click();
  });
  await settle();
}

function placeParams(search: string): string {
  const params = new URLSearchParams(search);
  return ["panel", "tab"].map((name) => `${name}=${params.get(name) ?? ""}`).join("&");
}

/** A page tab whose browser is running now, so it shows without waking. */
function isMockPage(item: PlaceItem): boolean {
  return item.kind === "page" && item.tab.state === "open";
}

function pageTab(source: MockHostClient = client) {
  const place = placeList(source.getSnapshot()).find(
    (item) => isMockPage(item) && item.occupants.length > 0,
  );
  if (!place) throw new Error("Missing page tab");
  return place;
}

function tabSearch(place: Pick<PlaceItem, "key">) {
  return `?panel=browser&tab=${place.key}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

/** Replaces what a field holds: a textarea's value, or a composer's words. */
async function write(field: HTMLElement | { readonly element: HTMLElement }, text: string) {
  const target = "element" in field ? field.element : field;
  await act(async () => {
    if (target instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        target,
        text,
      );
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    rewrite(target.closest(".composer-editor__field") ?? composerField(target), text);
  });
}

async function typeInto(field: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(target: Element) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
  });
  await settle();
}

function firstTaskId() {
  const row = document.querySelector<HTMLElement>(".side-task[data-thread-id]");
  if (!row?.dataset.threadId) throw new Error("Missing task row");
  return row.dataset.threadId;
}

export {
  root,
  client,
  sessionClient,
  teamHost,
  teamSession,
  history,
  historyState,
  historyKey,
  goTo,
  resize,
  type Entry,
  mount,
  stubLayout,
  settle,
  element,
  click,
  placeParams,
  isMockPage,
  pageTab,
  tabSearch,
  deferred,
  write,
  typeInto,
  pressEnter,
  firstTaskId,
};

export function setRoot(value: Root | null) {
  root = value;
}
export function resetHistory() {
  history = [];
}
export function setClient(value: MockHostClient) {
  client = value;
}
