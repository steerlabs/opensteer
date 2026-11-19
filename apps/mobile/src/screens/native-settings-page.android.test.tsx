// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NativeSettingsPage } from "./native-settings-page.android.js";

vi.mock(
  "@expo/ui/jetpack-compose",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).compose,
);
vi.mock(
  "@expo/ui/jetpack-compose/modifiers",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).composeModifiers,
);
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
vi.mock("../ui/integration-icon.js", () => ({ RowMarkIcon: () => null }));
vi.mock("../theme.js", () => ({ color: new Proxy({}, { get: () => "#000000" }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps the form action outside the scrolling Android settings rows", async () => {
  const save = vi.fn();
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "setup",
              title: "Set up",
              rows: [
                { key: "sign-in", kind: "primary", label: "Sign in", onPress: vi.fn() },
                { key: "key", kind: "input", label: "API key", value: "", onChange: vi.fn() },
                { key: "save", kind: "primary", label: "Save", onPress: save, pinned: true },
              ],
            },
          ]}
        />,
      ),
    );

    const scroll = element.querySelector("[data-scroll-list]")!;
    expect(scroll.querySelector("textarea")).not.toBeNull();
    expect(scroll.textContent).toContain("Sign in");
    const saveButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    expect(scroll.contains(saveButton)).toBe(false);
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("offers the full label for each Android choice and dispatches the selected value", async () => {
  const change = vi.fn();
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "access",
              title: "Agent access",
              rows: [
                {
                  key: "choice",
                  kind: "chips",
                  label: "Agents may use",
                  value: "all",
                  choices: [
                    { value: "all", label: "All tools" },
                    { value: "read-only", label: "Read-only" },
                    { value: "off", label: "Off" },
                  ],
                  onChange: change,
                },
              ],
            },
          ]}
        />,
      ),
    );
    const buttons = [...element.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["✓All tools", "Read-only", "Off"]);
    await act(async () => buttons[1]!.click());
    expect(change).toHaveBeenCalledExactlyOnceWith("read-only");
  } finally {
    act(() => root.unmount());
  }
});
