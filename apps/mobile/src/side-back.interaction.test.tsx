// @vitest-environment happy-dom
import { createRequire } from "node:module";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  NavigationContainer,
  CommonActions,
  StackActions,
  StackRouter,
  createNavigationContainerRef,
  createNavigatorFactory,
  useNavigationBuilder,
  type NavigationAction,
  type ParamListBase,
} from "@react-navigation/native";
import { enterSide, navigationRef } from "./navigation-ref.js";
import { useTeamSideBack } from "./side-back.js";
import { sideMemory } from "./side-memory.js";

// Keep the real navigator, router and prevent-remove event handling; only omit native views.
vi.mock("@react-navigation/native", async () => {
  const require = createRequire(import.meta.url);
  const core = await import(
    require.resolve("@react-navigation/core", {
      paths: [require.resolve("@react-navigation/native")],
    })
  );
  return { ...core, NavigationContainer: core.BaseNavigationContainer };
});

function TestNavigator({ children }: { readonly children: ReactNode }) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(
    StackRouter as Parameters<typeof useNavigationBuilder>[0],
    {
      children,
    },
  );
  return (
    <NavigationContent>
      {state.routes.map((route) => descriptors[route.key]!.render())}
    </NavigationContent>
  );
}
const Stack = createNavigatorFactory(TestNavigator)();
function Screen() {
  useTeamSideBack();
  return null;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("allows switches, resets and pop-to-top away from a team root, and redirects only its Back to remembered Tasks", async () => {
  const navigation = createNavigationContainerRef<ParamListBase>();
  const root = createRoot(document.createElement("div"));
  const home = { name: "Home", params: { deploymentId: "d" } };
  const task = { name: "Thread", params: { deploymentId: "d", threadId: "task" } };
  const page = {
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", threadId: "task", sessionId: "s", tabId: "tab" },
  };
  const channel = { name: "TeamChannel", params: { teamId: "a", channelId: "general" } };
  const reply = { name: "TeamThread", params: { ...channel.params, rootId: "root" } };
  const dispatch = async (
    action: NavigationAction | ReturnType<typeof CommonActions.reset> | null,
  ) => {
    if (action !== null)
      await act(async () => navigation.dispatch({ ...action, payload: action.payload ?? {} }));
  };
  const state = () => {
    const value = navigation.getRootState();
    if (value === undefined) throw new Error("The navigator is not ready");
    return value;
  };
  const enter = (target: { name: string; params: object }) =>
    dispatch(sideMemory.enter(state(), target));
  try {
    sideMemory.clear();
    await act(async () =>
      root.render(
        <NavigationContainer
          ref={navigation}
          initialState={{ index: 0, routes: [home] }}
          onReady={() => sideMemory.record(state())}
          onStateChange={(next) => next && sideMemory.record(next)}
        >
          <Stack.Navigator>
            {[home, task, page, channel, reply].map(({ name }) => (
              <Stack.Screen key={name} name={name} component={Screen} />
            ))}
          </Stack.Navigator>
        </NavigationContainer>,
      ),
    );
    await enter(task);
    await dispatch(StackActions.push(page.name, page.params));
    const tasks = state().routes;
    await enter(channel);
    await dispatch(StackActions.push(reply.name, reply.params));
    const team = state().routes;
    await dispatch(sideMemory.resume(state(), "tasks"));
    expect(state().routes).toEqual(tasks);
    await dispatch(sideMemory.resume(state(), "a"));
    expect(state().routes).toEqual(team);
    await dispatch(CommonActions.goBack());
    expect(state().routes.map((route) => route.name)).toEqual(["Home", "TeamChannel"]);
    await dispatch(CommonActions.goBack());
    expect(state().routes).toEqual(tasks);
    await dispatch(sideMemory.resume(state(), "a"));
    await dispatch(sideMemory.resume(state(), "tasks"));
    expect(state().routes).toEqual(tasks);
    await dispatch(sideMemory.resume(state(), "a"));
    await enter({ ...channel, params: { teamId: "b", channelId: "other" } });
    expect(state().routes.map((route) => ({ name: route.name, params: route.params }))).toEqual([
      home,
      { ...channel, params: { teamId: "b", channelId: "other" } },
    ]);
    await enter(reply);
    expect(state().routes.map((route) => ({ name: route.name, params: route.params }))).toEqual([
      home,
      reply,
    ]);
    await dispatch(CommonActions.goBack());
    expect(state().routes).toEqual(tasks);
    await dispatch(sideMemory.resume(state(), "a"));
    // Opening a new task from a team (writing Home's draft) reaches Home itself.
    await dispatch(StackActions.popToTop());
    expect(state().routes.map((route) => route.name)).toEqual(["Home"]);
    // A tab still opening is not an address to come back to.
    await enter(task);
    await dispatch(StackActions.push(page.name, { ...page.params, pendingBrowserTab: "opening" }));
    await enter(channel);
    await dispatch(sideMemory.resume(state(), "tasks"));
    expect(state().routes.at(-1)?.params).toEqual(page.params);
    await dispatch(sideMemory.resume(state(), "a"));
    await dispatch(CommonActions.reset({ index: 0, routes: [home] }));
    expect(state().routes.map((route) => route.name)).toEqual(["Home"]);
  } finally {
    await act(async () => root.unmount());
    sideMemory.clear();
  }
});

it("opens a team destination when no computer is selected, with no Home to keep", async () => {
  const root = createRoot(document.createElement("div"));
  const channel = { name: "TeamChannel", params: { teamId: "a", channelId: "general" } };
  try {
    await act(async () =>
      root.render(
        <NavigationContainer
          ref={navigationRef}
          initialState={{ index: 0, routes: [{ name: "Deployments" }] }}
        >
          <Stack.Navigator>
            {["Deployments", "Home", channel.name].map((name) => (
              <Stack.Screen key={name} name={name} component={Screen} />
            ))}
          </Stack.Navigator>
        </NavigationContainer>,
      ),
    );
    await act(async () => {
      expect(enterSide(channel)).toBe(true);
    });
    const state = navigationRef.getRootState();
    expect(state?.routes.at(-1)).toMatchObject(channel);
  } finally {
    await act(async () => root.unmount());
  }
});
