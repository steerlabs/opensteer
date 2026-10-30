// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Search, as the window changes shape. What can go wrong:
 * - a result opens differently on a phone and on a wide window, so where Back
 *   leads depends on the window's size at the moment of the tap;
 * - narrowing the window navigates by itself, pushing a task the reader
 *   never chose to open again or dropping the one they had;
 * - opening a result and coming back loses what was typed or the results.
 */

const harness = vi.hoisted(() => ({
  window: { fontScale: 1, height: 844, width: 390 },
  navigate: vi.fn(),
  dispatch: vi.fn(),
  setOptions: vi.fn(),
  focused: true,
  queries: [] as string[],
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useWindowDimensions: () => harness.window,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 100 }));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    push: (name: string, params: object) => ({ payload: { name, params }, type: "PUSH" }),
  },
  useNavigation: () => ({
    addListener: () => () => undefined,
    dispatch: harness.dispatch,
    isFocused: () => harness.focused,
    navigate: harness.navigate,
    setOptions: harness.setOptions,
  }),
}));

vi.mock("../threads/tasks-pane.js", () => ({
  TasksPane: (props: { onOpenTask: (threadId: string) => void; query: string }) => {
    harness.queries.push(props.query);
    return (
      <section data-query={props.query}>
        <button onClick={() => props.onOpenTask("thread-b")}>Result B</button>
      </section>
    );
  },
}));
vi.mock("../thread/thread-pane.js", () => ({
  ThreadPane: () => <article>Task beside the list</article>,
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ signIn: vi.fn() }),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useLayout: () => ({
    gutter: 16,
    kind: harness.window.width >= 720 && harness.window.height >= 600 ? "split" : "compact",
    readingWidth: 560,
  }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => ({}),
}));

import { TaskSearchScreen } from "./task-search.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  harness.window = { fontScale: 1, height: 844, width: 390 };
  harness.navigate.mockReset();
  harness.dispatch.mockReset();
  harness.setOptions.mockReset();
  harness.focused = true;
  harness.queries = [];
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const route = { key: "search", name: "TaskSearch" as const, params: { deploymentId: "dep-a" } };
  const render = () => act(() => root.render(<TaskSearchScreen route={route} />));
  render();
  return { container, render };
}

function typeQuery(words: string) {
  const options = harness.setOptions.mock.calls
    .map(
      ([value]) => value as { headerSearchBarOptions?: { onChangeText: (event: object) => void } },
    )
    .findLast((value) => value.headerSearchBarOptions !== undefined);
  if (!options?.headerSearchBarOptions) throw new Error("No search field in the bar.");
  const { onChangeText } = options.headerSearchBarOptions;
  act(() => onChangeText({ nativeEvent: { text: words } }));
}

function open(container: HTMLElement) {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Result B",
  );
  if (!result) throw new Error("No result.");
  act(() => result.click());
}

describe("search as the window changes shape", () => {
  it("opens a result the same way on a phone and on a wide window", () => {
    const phone = mount();
    open(phone.container);
    harness.window = { fontScale: 1, height: 1133, width: 744 };
    const wide = mount();
    open(wide.container);
    expect(harness.navigate.mock.calls).toEqual([
      ["Thread", { deploymentId: "dep-a", threadId: "thread-b" }],
      ["Thread", { deploymentId: "dep-a", threadId: "thread-b" }],
    ]);
    expect(wide.container.textContent).not.toContain("Task beside the list");
    expect(wide.container.textContent).not.toContain("Pick a task");
  });

  it("navigates nowhere on its own as the window narrows and widens with a result opened", () => {
    harness.window = { fontScale: 1, height: 1133, width: 744 };
    const { container, render } = mount();
    typeQuery("contract");
    open(container);
    harness.navigate.mockReset();
    harness.window = { fontScale: 1, height: 844, width: 390 };
    render();
    harness.window = { fontScale: 1, height: 1133, width: 744 };
    render();
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the query and its results for the return from a result", () => {
    const { container, render } = mount();
    typeQuery("contract");
    open(container);
    render();
    expect(container.querySelector("section")?.dataset["query"]).toBe("contract");
    expect(harness.queries.at(-1)).toBe("contract");
  });
});
