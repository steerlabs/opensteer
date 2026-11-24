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
      modifiers,
      onPress,
      allowsFullSwipe,
    }: {
      children?: ReactNode;
      label?: string;
      modifiers?: readonly unknown[];
      onPress?: () => void;
      allowsFullSwipe?: boolean;
    }) => (
      <div
        data-native={name}
        data-full-swipe={allowsFullSwipe}
        data-modifiers={JSON.stringify(modifiers ?? [])}
      >
        {onPress ? <button onClick={onPress}>{label}</button> : label}
        {children}
      </div>
    );
  const Toolbar = Object.assign(view("Toolbar"), { Content: view("Toolbar.Content") });
  return {
    Circle: view("Circle"),
    Image: view("Image"),
    ProgressView: view("ProgressView"),
    Spacer: view("Spacer"),
    VStack: view("VStack"),
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
vi.mock("../theme.js", () => ({
  color: new Proxy({}, { get: () => "#000000" }),
  deploymentPaint: {},
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityAddTraits: () => ({}),
  accessibilityHidden: () => ({}),
  accessibilityLabel: (label: string) => ({ accessibilityLabel: label }),
  background: () => ({}),
  buttonBorderShape: () => ({}),
  buttonStyle: () => ({}),
  contentShape: () => ({}),
  controlSize: () => ({}),
  font: () => ({}),
  foregroundStyle: () => ({}),
  listStyle: () => ({}),
  shapes: { rectangle: () => ({}), roundedRectangle: () => ({}), circle: () => ({}) },
  textSelection: (value: boolean) => ({ textSelection: value }),
  tint: () => ({}),
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
  RowMarkIcon: ({ mark }: { mark: { definitionId: string } }) => (
    <i data-mark={mark.definitionId} />
  ),
}));
const copied = vi.hoisted(() => [] as string[]);
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (text: string) => {
    copied.push(text);
    return true;
  },
}));
const stacked = vi.hoisted(() => ({ value: false }));
vi.mock("../ui/stacked-layout.js", () => ({ useStackedLayout: () => stacked.value }));
const { NativeSettingsPage } = await import("./native-settings-page.ios.js");
const { addressWords } = await import("../ui/address-words.js");
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

it("draws a status row's address whole, never selectable, heard and copied as it is", async () => {
  const redirect = "https://home.example/api/plugins/oauth/callback";
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <NativeSettingsPage
          sections={[
            {
              key: "oauth",
              title: "Your own OAuth app",
              rows: [
                {
                  key: "redirect",
                  kind: "status",
                  tone: "neutral",
                  label: "Register this as the redirect URL",
                  detail: redirect,
                  addressIn: "detail",
                },
                { key: "plain", kind: "status", tone: "neutral", label: "Code", detail: "AB12" },
              ],
            },
          ]}
        />,
      ),
    );
    const texts = [...container.querySelectorAll<HTMLElement>('[data-native="Text"]')];
    const drawn = texts.find((text) => text.textContent === addressWords(redirect));
    expect(drawn).toBeDefined();
    const modifiers = JSON.parse(drawn!.dataset["modifiers"]!) as Record<string, unknown>[];
    // A selection would copy the characters drawn, which are not the address: no selection.
    expect(modifiers.some((modifier) => "textSelection" in modifier)).toBe(false);
    expect(modifiers).toContainEqual({ accessibilityLabel: redirect });
    // Copy in the system's menu gives the address exactly.
    const copy = [...container.querySelectorAll("button")].find((b) => b.textContent === "Copy");
    await act(async () => copy!.click());
    expect(copied).toEqual([redirect]);
    // A detail that is not an address stays selectable, as it was.
    const plain = texts.find((text) => text.textContent === "AB12");
    expect(JSON.parse(plain!.dataset["modifiers"]!)).toContainEqual({ textSelection: true });
  } finally {
    act(() => root.unmount());
  }
});

// Build 9's walk: on the GitHub plugin's consent at the largest size the hosts in its sentence were
// drawn as words, and iOS hyphenated them ("api.github.-" / "com and" / "upload-" / ...). A row whose
// label holds addresses among its words draws each as one, and is read as the sentence.
it("draws the addresses among a row's words as addresses, and reads the sentence plainly", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
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
    const line = [...container.querySelectorAll('[data-native="Text"]')].find((text) =>
      (text.textContent ?? "").startsWith("Your GitHub credential"),
    )!;
    expect(line.textContent).toBe(
      `Your GitHub credential can only be sent to ${addressWords("api.github.com")} and ${addressWords("uploads.github.com")}.`,
    );
    expect(line.getAttribute("data-modifiers")).toContain(
      JSON.stringify({
        accessibilityLabel:
          "Your GitHub credential can only be sent to api.github.com and uploads.github.com.",
      }).slice(1, -1),
    );
  } finally {
    act(() => root.unmount());
  }
});

// Build 9's walk: at the largest size Settings drew the account's email beside its initial, in a
// column 47 points narrower, and "last+travel@" no longer fit a line. As the Your Opensteers card
// does at that size, the initial stands above the address and the address has the row's width.
it("puts the account's initial above its address at the largest sizes, and beside it otherwise", async () => {
  const draw = async (large: boolean) => {
    stacked.value = large;
    const container = document.createElement("div");
    const root = createRoot(container);
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
    const mark = [...container.querySelectorAll("[data-native]")].find(
      (node) => node.textContent === "F",
    )!;
    const holder = mark.closest('[data-native="HStack"], [data-native="VStack"]');
    const kind = holder?.getAttribute("data-native");
    act(() => root.unmount());
    return kind;
  };
  expect(await draw(false)).toBe("HStack");
  expect(await draw(true)).toBe("VStack");
  stacked.value = false;
});
