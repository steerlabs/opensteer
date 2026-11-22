// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * `AddressText`, the one way the phone draws an email address, a host or a URL, and the floating
 * title's line that names a connected agent's source. Each text is drawn as an element carrying
 * the props React Native would get: Android's hyphenation, the lines it may take, and its label.
 */

vi.mock("react-native", async () => {
  const base = (await import("../../test-support/yoga-frames.js")).layoutReactNative;
  return {
    ...base,
    Text: (props: Record<string, unknown> & { readonly children?: ReactNode }) =>
      createElement(
        "span",
        {
          "aria-label": props["accessibilityLabel"],
          "data-hyphenation": props["android_hyphenationFrequency"] ?? "unset",
          "data-lines": props["numberOfLines"] ?? "any",
          "data-text": "",
        },
        props.children,
      ),
  };
});
vi.mock(
  "react-native-reanimated",
  async () => (await import("../../test-support/yoga-frames.js")).layoutReanimated,
);
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("./symbol.js", () => ({ Symbol: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("./action-line.js", () => ({ ActionLine: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ height: 0, width: 0, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("./pane.js", () => ({ useContentInsets: () => ({ left: 0, right: 0 }) }));
vi.mock("./bar-control.js", () => ({
  BarControl: (props: { children: ReactNode }) => props.children,
}));
vi.mock("./task-mark.js", () => ({ TaskMark: () => null }));
vi.mock("../thread/task-status.js", () => ({ TaskStatus: () => null }));

const { AddressText } = await import("./address-text.js");
const { addressWords } = await import("./address-words.js");
const { ThreadSubtitle } = await import("../thread/thread-subtitle.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function draw(node: ReactNode): Promise<HTMLElement[]> {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(node));
  return [...document.querySelectorAll<HTMLElement>("[data-text]")];
}

describe("an address drawn the one way", () => {
  it("never hyphenates on Android, draws the address's own characters, and says it whole", async () => {
    const [text] = await draw(<AddressText role="title" value="person@fixture.invalid" />);
    expect(text?.dataset["hyphenation"]).toBe("none");
    expect(text?.textContent).toBe(addressWords("person@fixture.invalid"));
    // A screen reader hears the address, not its joiners.
    expect(text?.getAttribute("aria-label")).toBe("person@fixture.invalid");
  });

  it("keeps a label its place gives it", async () => {
    const [text] = await draw(
      <AddressText accessibilityLabel="Opensteer account" value="person@fixture.invalid" />,
    );
    expect(text?.getAttribute("aria-label")).toBe("Opensteer account");
  });
});

describe("the floating title's line that names a source", () => {
  it("wraps rather than cut the host, and never hyphenates it", async () => {
    const [text] = await draw(
      <ThreadSubtitle
        connectionLabel={`Connected agent · ${addressWords("claude.ai")}`}
        connectionWraps
        task={null}
      />,
    );
    expect(text?.dataset["lines"]).toBe("any");
    expect(text?.dataset["hyphenation"]).toBe("none");
  });

  it("keeps any other state to its one line", async () => {
    const [text] = await draw(<ThreadSubtitle connectionLabel="Studio Mac offline" task={null} />);
    expect(text?.dataset["lines"]).toBe("1");
  });
});
