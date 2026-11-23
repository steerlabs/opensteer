// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { addressWords } from "../ui/address-words.js";
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
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ fontScale: 1, height: 640, scale: 2, width: 320 }),
}));
const stacked = vi.hoisted(() => ({ value: false }));
vi.mock("../ui/stacked-layout.js", () => ({ useStackedLayout: () => stacked.value }));

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

// A Material 3 ListItem is one node to TalkBack whether or not it can be pressed: Compose merges
// what is inside it, and a merged node with a description is spoken as that description alone.
// So every row that holds an address says itself whole, and none of its lines has a description
// of its own (an address line's would be all that is heard). A button of the row's own, its "…"
// menu, keeps its own name and its own stop. Unverified until TalkBack reads it on a device.
it("has TalkBack hear every row with an address whole, its own button apart", async () => {
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
                  addressIn: "label",
                  detail: "Opensteer account",
                  key: "email",
                  kind: "text",
                  label: "person@fixture.invalid",
                },
                {
                  addressIn: "detail",
                  detail: "https://studio.tailnet.ts.net",
                  key: "remote",
                  kind: "status",
                  label: "Reachable",
                  steps: [{ label: "Tunnel", state: "done" }],
                  tone: "good",
                },
                {
                  addressIn: "label",
                  key: "origin",
                  kind: "status",
                  label: "https://home.tailnet.ts.net",
                  tone: "neutral",
                },
                {
                  actions: [{ label: "Remove", onPress: vi.fn() }],
                  addressIn: "detail",
                  detail: "mac.tailnet.ts.net",
                  key: "computer",
                  kind: "button",
                  label: "Studio Mac",
                  onPress: vi.fn(),
                },
              ],
            },
          ]}
        />,
      ),
    );
    const drawn = (text: string | null) => (text ?? "").replace(/[\u2060\u200B]/gu, "");
    /** The row node TalkBack focuses: the outermost element whose words begin as given. */
    const row = (start: string) =>
      [...element.querySelectorAll("button, div")].find(
        (node) =>
          drawn(node.textContent).startsWith(start) &&
          !drawn(node.parentElement?.textContent ?? "").startsWith(start),
      )!;
    const heard = (node: Element) => [
      node.getAttribute("aria-label"),
      ...[...node.querySelectorAll("[aria-label]")].map((inner) =>
        inner.getAttribute("aria-label"),
      ),
    ];
    expect(heard(row("Signed in as"))).toEqual(["Signed in as, person@fixture.invalid"]);
    expect(heard(row("person@fixture.invalid"))).toEqual([
      "person@fixture.invalid, Opensteer account",
    ]);
    expect(heard(row("Reachable"))).toEqual([
      "Reachable, https://studio.tailnet.ts.net, Tunnel, done",
    ]);
    expect(heard(row("https://home.tailnet.ts.net"))).toEqual(["https://home.tailnet.ts.net"]);
    expect(heard(row("Studio Mac"))).toEqual([
      "Studio Mac, mac.tailnet.ts.net",
      "More actions for Studio Mac",
    ]);
  } finally {
    act(() => root.unmount());
  }
});

// Build 9's walk: the GitHub plugin's consent sentence drew its hosts as words. A row whose label
// holds addresses among its words draws each as one, and TalkBack hears the sentence plainly.
it("draws the addresses among a row's words as addresses, heard as the sentence", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "consent",
              title: "What linking agrees to",
              rows: [
                {
                  key: "sites",
                  kind: "text",
                  label:
                    "Your GitHub credential can only be sent to api.github.com and uploads.github.com.",
                  labelParts: [
                    "Your GitHub credential can only be sent to ",
                    { address: "api.github.com" },
                    " and ",
                    { address: "uploads.github.com" },
                    ".",
                  ],
                },
              ],
            },
          ]}
        />,
      ),
    );
    const line = [...element.querySelectorAll("span")].find((span) =>
      (span.textContent ?? "").startsWith("Your GitHub credential"),
    )!;
    expect(line.textContent).toBe(
      `Your GitHub credential can only be sent to ${addressWords("api.github.com")} and ${addressWords("uploads.github.com")}.`,
    );
    expect(line.closest("[aria-label]")?.getAttribute("aria-label")).toBe(
      "Your GitHub credential can only be sent to api.github.com and uploads.github.com.",
    );
    expect(line.getAttribute("aria-label")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

// As on iOS: at the largest sizes the account's initial stands above its address, so the address
// has the row's width; otherwise it leads the row.
it("puts the account's initial above its address at the largest sizes", async () => {
  const draw = async (large: boolean) => {
    stacked.value = large;
    const element = document.createElement("div");
    const root = createRoot(element);
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "account",
              title: "Account",
              rows: [
                {
                  addressIn: "label",
                  detail: "Opensteer account",
                  initial: "F",
                  key: "email",
                  kind: "text",
                  label: "first.last+travel@studio-mac-mini.fixture.invalid",
                },
              ],
            },
          ]}
        />,
      ),
    );
    const spans = [...element.querySelectorAll("span")].map((span) =>
      (span.textContent ?? "").replace(/[\u2060\u200B]/gu, ""),
    );
    act(() => root.unmount());
    const mark = spans.indexOf("F");
    const address = spans.indexOf("first.last+travel@studio-mac-mini.fixture.invalid");
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(address).toBeGreaterThanOrEqual(0);
    return mark < address ? "above" : "leading";
  };
  // The row's leading slot is drawn after its lines; a mark above them comes first.
  expect(await draw(false)).toBe("leading");
  expect(await draw(true)).toBe("above");
  stacked.value = false;
});
