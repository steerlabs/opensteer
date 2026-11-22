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

// A clickable row is one node to TalkBack: Compose merges what is inside it, and a merged node
// with a description is spoken as that description alone. So the row says itself whole, and none
// of its lines has a description of its own (an address line's would be all that is spoken). A
// row that does nothing is not merged: each line is its own, the address heard plainly.
it("has TalkBack hear a row with an address whole, and the address as it is", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "account",
              title: "Account",
              rows: [
                {
                  addressIn: "detail",
                  detail: "person@fixture.invalid",
                  key: "signed-in",
                  kind: "button",
                  label: "Signed in as",
                  onPress: vi.fn(),
                },
                {
                  addressIn: "detail",
                  detail: "https://studio.tailnet.ts.net",
                  key: "home",
                  kind: "text",
                  label: "This Home",
                },
              ],
            },
          ]}
        />,
      ),
    );
    const row = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Signed in as"),
    )!;
    expect(row.getAttribute("aria-label")).toBe("Signed in as, person@fixture.invalid");
    expect(row.querySelectorAll("[aria-label]")).toHaveLength(0);
    // The address as drawn, with the characters that hold it whole taken out.
    const still = [...element.querySelectorAll("span")].find((span) =>
      span.textContent?.replace(/[\u2060\u200B]/gu, "").includes("studio"),
    )!;
    expect(still.getAttribute("aria-label")).toBe("https://studio.tailnet.ts.net");
    expect(still.closest("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
