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
    }: {
      children?: ReactNode;
      label?: string;
      onPress?: () => void;
    }) => (
      <div data-native={name}>
        {onPress ? <button onClick={onPress}>{label}</button> : label}
        {children}
      </div>
    );
  const Toolbar = Object.assign(view("Toolbar"), { Content: view("Toolbar.Content") });
  return {
    Host: view("Host"),
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
  navigationTitle: () => ({}),
  tag: () => ({}),
  pickerStyle: () => ({}),
  searchable: (_query: unknown, options: { onChange: (value: string) => void }) => {
    state.search = options;
    return {};
  },
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
