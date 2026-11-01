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
import { MockHostClient } from "@opensteer/client/mock";
import { type HostClient, placeList, type PlaceItem } from "@opensteer/client/host";

import { AppShell } from "../app-shell.js";
import { AutomationDetailPage } from "../automations/automation-detail.js";
import { AutomationsPage } from "../automations/automations-page.js";
import { ComputersPage } from "../computers-page.js";
import { HomeRoute, NewTaskRoute, WorkspaceHomeRoute } from "../home-view.js";
import { SettingsRedirect } from "../settings/settings-redirect.js";
import { SettingsSectionRoute, SettingsShell } from "../settings/settings-shell.js";
import { SpecialistsPage } from "../specialists-page.js";
import { ThreadRoute } from "../thread-view.js";
import { ToastProvider } from "../toast.js";
import { LiveRedirect } from "./live-redirect.js";

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
interface Step {
  readonly type: string;
  readonly path: string;
  readonly search: string;
}
let history: Step[] = [];
let historyState: unknown = null;
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
  client?.dispose();
  history = [];
  goTo = null;
  viewport.queries.clear();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

function History() {
  const location = useLocation();
  historyState = location.state;
  const type = useNavigationType();
  goTo = useNavigate();
  const last = history.at(-1);
  if (!last || last.path !== location.pathname || last.search !== location.search)
    history.push({ path: location.pathname, search: location.search, type });
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
    now?: () => Date;
    /** The mock Host's pace, for a scripted run that must still be working when acted on. */
    latencyMs?: number;
    shell?: Partial<
      Pick<
        Parameters<typeof AppShell>[0],
        "deploymentAccess" | "desktopBridge" | "desktopDeployment"
      >
    >;
  } = {},
) {
  stubLayout(options.width ?? 1440);
  client = new MockHostClient({
    latencyMs: options.latencyMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
  });
  await client.load();
  const entry = typeof path === "function" ? path(client) : path;
  sessionClient = options.hostClient?.(client) ?? null;
  if (sessionClient) await sessionClient.load();
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const Wrapper = options.strict ? StrictMode : Fragment;
  await act(async () =>
    root?.render(
      <Wrapper>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <History />
            <Routes>
              <Route
                element={
                  <AppShell
                    hostClient={sessionClient ?? client}
                    loadError={null}
                    {...options.shell}
                  />
                }
              >
                <Route index element={<HomeRoute />} />
                <Route path="new" element={<NewTaskRoute />} />
                <Route path="threads/:threadId" element={<ThreadRoute />} />
                <Route path="live" element={<LiveRedirect />} />
                <Route path="specialists" element={<SpecialistsPage />} />
                <Route path="workspaces/:workspaceId" element={<WorkspaceHomeRoute />} />
                <Route path="automations" element={<AutomationsPage />} />
                <Route path="automations/:triggerId" element={<AutomationDetailPage />} />
                <Route
                  path="computers/*"
                  element={<SettingsRedirect from="/computers" to="/settings/computers" />}
                />
                <Route path="settings" element={<SettingsShell />}>
                  <Route
                    index
                    element={<SettingsRedirect from="/settings" to="/settings/ai-engines" />}
                  />
                  <Route
                    path="ai-engines"
                    element={<SettingsSectionRoute section="ai-engines" />}
                  />
                  <Route path="account" element={<SettingsSectionRoute section="account" />} />
                  <Route path="computers" element={<ComputersPage />} />
                </Route>
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </Wrapper>,
    ),
  );
  await settle();
  return node;
}

/** Observers that never fire and media queries that answer to `viewport.width`. */
function stubLayout(width: number) {
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
      get: () => (max ? viewport.width <= Number(max[1]) : false),
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
  return ["panel", "browser", "browserTab", "computerSession", "app", "mac", "phone"]
    .map((name) => `${name}=${params.get(name) ?? ""}`)
    .join("&");
}

function isMockPage(item: PlaceItem, source: MockHostClient = client): boolean {
  if (item.destination.kind !== "browser") return false;
  const { sessionId, tabId } = item.destination;
  return (
    source
      .getSnapshot()
      .browserSessions.find((session) => session.id === sessionId)
      ?.tabCatalog?.tabs.some((tab) => tab.id === tabId) === true
  );
}

function pageTab(source: MockHostClient = client) {
  const place = placeList(source.getSnapshot()).find(
    (item) => item.kind === "browser" && isMockPage(item, source) && item.occupants.length > 0,
  );
  if (!place || place.destination.kind !== "browser") throw new Error("Missing page tab");
  return place;
}

function tabSearch(place: ReturnType<typeof pageTab>) {
  if (place.destination.kind !== "browser") throw new Error("Not a browser place");
  return `?panel=browser&browser=${place.destination.sessionId}&browserTab=${place.destination.tabId}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function write(field: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
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
  history,
  historyState,
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
