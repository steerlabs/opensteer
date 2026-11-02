// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList } from "@opensteer/client/host";
import { PersonShowMessageSchema } from "@opensteer/protocol";
import { VoiceProvider } from "./context.js";

const state = vi.hoisted(() => ({
  host: null as MockHostClient | null,
  appState: "active",
  route: undefined as { key: string; name: string; params?: object } | undefined,
  dispatch: vi.fn(),
  unsubscribeNavigation: vi.fn(),
  removeAppState: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return state.appState;
    },
    addEventListener: () => ({ remove: state.removeAppState }),
  },
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    push: (name: string, params: object) => ({ type: "PUSH", payload: { name, params } }),
    popTo: (name: string, params: object) => ({ type: "POP_TO", payload: { name, params } }),
  },
}));
vi.mock("../navigation-ref.js", () => ({
  navigationRef: {
    isReady: () => true,
    getCurrentRoute: () => state.route,
    dispatch: state.dispatch,
    addListener: () => state.unsubscribeNavigation,
  },
}));
const mobile = {
  getSnapshot: () => ({ selection: { deploymentId: state.host?.getSnapshot().deploymentId } }),
};
const dictation = { getSnapshot: () => ({ owner: null }) };
vi.mock("../ui/mobile-client-context.js", () => ({
  useSelectedHostClient: () => state.host,
  useMobileClient: () => mobile,
}));
vi.mock("../dictation/context.js", () => ({ useDictation: () => dictation }));
vi.mock("../platform/voice.js", () => ({ voiceMediaPort: null }));
vi.mock("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock("../computers/phone-display-native.js", () => ({ macWindowVideoSupported: () => false }));
vi.mock("./controls.js", async () => {
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  return { VoiceContext: createContext(null) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  state.host?.dispose();
  state.host = null;
  state.route = undefined;
  state.appState = "active";
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function mount() {
  state.host = new MockHostClient({ latencyMs: 0 });
  const snapshot = state.host.getSnapshot();
  const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
  const target = snapshot.threads.find((thread) => thread.id !== source.id)!;
  state.route = { key: "home", name: "Home", params: { deploymentId: snapshot.deploymentId } };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <VoiceProvider>
        <span>App</span>
      </VoiceProvider>,
    ),
  );
  const message = PersonShowMessageSchema.parse({
    type: "host.show",
    workspaceId: source.workspaceId,
    threadId: source.id,
    target: { threadId: target.id },
  });
  return { host: state.host, snapshot, source, target, message };
}

it.each(["Home", "Thread"])(
  "opens the exact requested tab from the active %s conversation",
  async (name) => {
    const f = await mount();
    const source = name === "Home" ? f.source : f.target;
    state.route = {
      key: name,
      name,
      params: { deploymentId: f.snapshot.deploymentId, threadId: source.id },
    };
    const place = placeList(f.snapshot).find((place) => place.destination.kind === "browser")!;
    if (place.destination.kind !== "browser") throw new Error("Expected a browser tab");
    const { sessionId, tabId } = place.destination;
    await act(async () =>
      f.host.receivePersonShow(
        PersonShowMessageSchema.parse({
          ...f.message,
          threadId: source.id,
          workspaceId: source.workspaceId,
          target: { tabId },
        }),
      ),
    );
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "PUSH",
      payload: {
        name: "WorkspaceBrowser",
        params: {
          deploymentId: f.snapshot.deploymentId,
          scope: "workspace",
          sessionId,
          tabId,
        },
      },
    });
  },
);

it("ignores inactive apps, covered routes and different Threads or Deployments, without replaying Show", async () => {
  const f = await mount();
  const home = state.route!;
  const deliverIgnored = async () => {
    await act(async () => f.host.receivePersonShow(f.message));
    expect(state.dispatch).not.toHaveBeenCalled();
  };
  for (const appState of ["background", "inactive"]) {
    state.appState = appState;
    await deliverIgnored();
  }
  state.appState = "active";
  for (const name of ["WorkspaceBrowser", "Settings", "Tabs"]) {
    state.route = { ...home, name };
    await deliverIgnored();
  }
  state.route = {
    ...home,
    name: "Thread",
    params: { deploymentId: f.snapshot.deploymentId, threadId: f.target.id },
  };
  await deliverIgnored();
  state.route = { ...home, params: { deploymentId: "another-deployment" } };
  await deliverIgnored();
  state.route = undefined;
  await deliverIgnored();
  state.route = home;
  await act(async () => undefined);
  expect(state.dispatch).not.toHaveBeenCalled();
  await act(async () => f.host.receivePersonShow(f.message));
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "PUSH",
    payload: {
      name: "Thread",
      params: { deploymentId: f.snapshot.deploymentId, threadId: f.target.id },
    },
  });
  await act(async () => root!.unmount());
  root = null;
  expect(state.unsubscribeNavigation).toHaveBeenCalledOnce();
  expect(state.removeAppState).toHaveBeenCalledOnce();
  state.dispatch.mockClear();
  await act(async () => f.host.receivePersonShow(f.message));
  expect(state.dispatch).not.toHaveBeenCalled();
});
