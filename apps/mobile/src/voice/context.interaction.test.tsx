// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { placeList } from "@opensteer/client/host";
import { PersonShowMessageSchema, computerAppIdentityKey } from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { VoiceController } from "@opensteer/client/voice";
import { VoiceProvider } from "./context.js";

const state = vi.hoisted(() => ({
  host: null as MockHostClient | null,
  appState: "active",
  route: undefined as { key: string; name: string; params?: object } | undefined,
  routes: [] as { key: string; name: string; params?: object }[],
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
    getRootState: () => ({ routes: state.routes }),
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
  state.routes = [];
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
    runId: createId("run"),
    workspaceId: source.workspaceId,
    threadId: source.id,
    target: { threadId: target.id },
  });
  return { host: state.host, snapshot, source, target, message };
}

it.each(["app", "phone"] as const)(
  "opens the Run's current %s through shared navigation",
  async (kind) => {
    const f = await mount();
    const machine = f.snapshot.machines.find((machine) =>
      machine.computerUse?.sessions.some((session) => session.display === (kind === "phone")),
    )!;
    const session = machine.computerUse!.sessions.find(
      (session) => session.display === (kind === "phone"),
    )!;
    const place =
      kind === "app"
        ? { kind, machineId: machine.id, appKey: computerAppIdentityKey(session.apps[0]!) }
        : { kind, machineId: machine.id, display: "main" };
    await act(async () =>
      f.host.receivePersonShow(
        PersonShowMessageSchema.parse({
          ...f.message,
          runId: session.runId,
          target: { place },
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
          machineId: machine.id,
          computerSessionId: session.sessionId,
          ...(kind === "app"
            ? { appKey: "appKey" in place ? place.appKey : null }
            : { phone: true }),
        },
      },
    });
  },
);

it("routes an authorized unloaded Thread through the existing Thread screen", async () => {
  const f = await mount();
  const threadId = createId("thread");
  await act(async () => f.host.receivePersonShow({ ...f.message, target: { threadId } }));
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "PUSH",
    payload: {
      name: "Thread",
      params: { deploymentId: f.snapshot.deploymentId, threadId },
    },
  });
});

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

it("keeps following its Run from places opened over its conversation, and no other", async () => {
  const f = await mount();
  const home = state.route!;
  const place = { ...home, name: "WorkspaceBrowser" };
  state.route = place;
  state.routes = [
    {
      ...home,
      name: "Thread",
      params: { deploymentId: f.snapshot.deploymentId, threadId: f.target.id },
    },
    place,
  ];
  await act(async () => f.host.receivePersonShow(f.message));
  expect(state.dispatch).not.toHaveBeenCalled();
  state.routes = [home, place, { ...place, key: "next" }];
  await act(async () => f.host.receivePersonShow(f.message));
  expect(state.dispatch).toHaveBeenCalledOnce();
});

it("opens what the voice call's agent shows from any screen, and ignores a call it replaced", async () => {
  const f = await mount();
  const call = {
    threadId: createId("thread"),
    runId: createId("run"),
    workspaceId: f.source.workspaceId,
  };
  let current: typeof call | null = call;
  vi.spyOn(VoiceController.prototype, "call").mockImplementation(() => current);
  const showed = vi.spyOn(VoiceController.prototype, "showed");
  const message = PersonShowMessageSchema.parse({ ...f.message, ...call });
  // Settings names no conversation, and the call's own Thread is never on screen.
  state.route = { key: "settings", name: "Settings" };
  await act(async () => f.host.receivePersonShow(message));
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "PUSH",
    payload: {
      name: "Thread",
      params: { deploymentId: f.snapshot.deploymentId, threadId: f.target.id },
    },
  });
  expect(showed).toHaveBeenCalledOnce();
  for (const name of ["Chat", "WorkspaceBrowser", "Thread", "Settings"]) {
    state.dispatch.mockClear();
    state.route = { key: name, name };
    await act(async () => f.host.receivePersonShow(message));
    expect(state.dispatch).toHaveBeenCalledOnce();
  }
  expect(showed).toHaveBeenCalledTimes(5);
  state.dispatch.mockClear();
  state.appState = "background";
  await act(async () => f.host.receivePersonShow(message));
  state.appState = "active";
  current = { ...call, runId: createId("run") };
  await act(async () => f.host.receivePersonShow(message));
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(showed).toHaveBeenCalledTimes(5);
});
