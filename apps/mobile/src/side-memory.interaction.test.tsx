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
  return null;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps Home, a task and its browser as the chain Back returns along, without a tab still opening", async () => {
  const navigation = createNavigationContainerRef<ParamListBase>();
  const root = createRoot(document.createElement("div"));
  const home = { name: "Home", params: { deploymentId: "d" } };
  const task = { name: "Thread", params: { deploymentId: "d", threadId: "task" } };
  const page = {
    name: "WorkspaceBrowser",
    params: { deploymentId: "d", threadId: "task", sessionId: "s", tabId: "tab" },
  };
  const settings = { name: "Settings", params: { deploymentId: "d" } };
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
  const routes = () => state().routes.map((route) => ({ name: route.name, params: route.params }));
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
            {[home, task, page, settings].map(({ name }) => (
              <Stack.Screen key={name} name={name} component={Screen} />
            ))}
          </Stack.Navigator>
        </NavigationContainer>,
      ),
    );
    await enter(task);
    expect(routes()).toEqual([home, task]);
    const tasks = state().routes;
    // A tab still opening is not an address to come back to.
    await dispatch(StackActions.push(page.name, { ...page.params, pendingBrowserTab: "opening" }));
    const browser = state().routes.at(-1)!;
    // Presenting over the chain rebuilds it from what is remembered.
    await enter(settings);
    expect(routes()).toEqual([home, task, page, settings]);
    expect(state().routes.slice(0, 2)).toEqual(tasks);
    expect(state().routes[2]?.key).toBe(browser.key);
    await dispatch(CommonActions.goBack());
    expect(routes()).toEqual([home, task, page]);
    expect(state().routes.at(-1)?.params).toEqual(page.params);
    await dispatch(CommonActions.goBack());
    expect(state().routes).toEqual(tasks);
    await dispatch(CommonActions.goBack());
    expect(state().routes.map((route) => route.name)).toEqual(["Home"]);
  } finally {
    await act(async () => root.unmount());
    sideMemory.clear();
  }
});
