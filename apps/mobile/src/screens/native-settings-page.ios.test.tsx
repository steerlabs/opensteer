// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  search: null as null | { onChange: (value: string) => void },
  back: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: state.back }) }));
vi.mock("@expo/ui/swift-ui", () => {
  const view =
    (name: string) =>
    ({
      children,
      label,
      onPress,
      allowsFullSwipe,
    }: {
      children?: ReactNode;
      label?: string;
      onPress?: () => void;
      allowsFullSwipe?: boolean;
    }) => (
      <div data-native={name} data-full-swipe={allowsFullSwipe}>
        {onPress ? <button onClick={onPress}>{label}</button> : label}
        {children}
      </div>
    );
  const Toolbar = Object.assign(view("Toolbar"), { Content: view("Toolbar.Content") });
  return {
    ContextMenu: Object.assign(view("ContextMenu"), {
      Trigger: view("ContextMenu.Trigger"),
      Items: view("ContextMenu.Items"),
    }),
    SwipeActions: Object.assign(view("SwipeActions"), { Actions: view("SwipeActions.Actions") }),
    Host: view("Host"),
    HStack: view("HStack"),
    RNHostView: view("RNHostView"),
    BottomSheet: view("BottomSheet"),
    List: view("List"),
    NavigationStack: view("NavigationStack"),
    Section: view("Section"),
    Text: view("Text"),
    TextField: view("TextField"),
    SecureField: view("SecureField"),
    Button: view("Button"),
    Toggle: view("Toggle"),
    DisclosureGroup: view("DisclosureGroup"),
    Toolbar,
    ToolbarItem: view("ToolbarItem"),
    Picker: view("Picker"),
    useNativeState: () => ({ value: "", set: vi.fn() }),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  disabled: () => ({}),
  frame: () => ({}),
  navigationTitle: () => ({}),
  tag: () => ({}),
  pickerStyle: () => ({}),
  searchable: (_query: unknown, options: { onChange: (value: string) => void }) => {
    state.search = options;
    return {};
  },
}));
vi.mock("../ui/integration-icon.js", () => ({
  IntegrationIcon: ({ definitionId }: { definitionId: string }) => <i data-mark={definitionId} />,
}));
const { NativeSettingsPage } = await import("./native-settings-page.ios.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("hosts native search in one SwiftUI navigation environment and returns through the Expo stack", async () => {
  function Page() {
    const [query, setQuery] = useState("");
    return (
      <NativeSettingsPage
        search={{ value: query, onChange: setQuery }}
        sections={[
          {
            key: "results",
            title: "Plugins",
            rows: [{ key: "result", kind: "text", label: query || "All plugins" }],
          },
        ]}
      />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Page />));
    expect(container.querySelectorAll('[data-native="Host"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-native="NavigationStack"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-native="List"]')).toHaveLength(1);
    await act(async () => state.search!.onChange("Gmail"));
    expect(container.textContent).toContain("Gmail");
    await act(async () => container.querySelector("button")!.click());
    expect(state.back).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("leads a row with its integration's mark and keeps secondary actions labeled and unswipeable", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const remove = vi.fn();
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "plugins",
              title: "On",
              rows: [
                {
                  key: "mail",
                  kind: "button",
                  label: "Mail",
                  mark: { definitionId: "google-gmail", name: "Mail" },
                  onPress: vi.fn(),
                  actions: [{ label: "Remove", destructive: true, onPress: remove }],
                },
              ],
            },
          ]}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-native="ContextMenu"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-native="HStack"] [data-native="RNHostView"] [data-mark]'),
    ).toHaveProperty("dataset.mark", "google-gmail");
    expect(
      container
        .querySelector('[data-native="SwipeActions.Actions"]')
        ?.getAttribute("data-full-swipe"),
    ).toBe("false");
    expect(remove).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")!
        .click(),
    );
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("presents plugin review in a SwiftUI sheet with one native list", async () => {
  const close = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage sheet={{ title: "Add plugin", onClose: close }} sections={[]} />,
      ),
    );
    expect(container.querySelectorAll('[data-native="Host"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-native="BottomSheet"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-native="List"]')).toHaveLength(1);
    await act(async () => container.querySelector("button")!.click());
    expect(close).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
