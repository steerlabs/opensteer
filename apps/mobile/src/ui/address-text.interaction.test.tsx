// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The components that draw an email address, a host or a URL (`address-text.tsx`), and the
 * floating title's line that names a connected agent's host. Each text is drawn as an element
 * carrying the props React Native would get: Android's hyphenation, the lines it may take, which
 * end gives way, and what a screen reader hears.
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
          "data-ellipsize": props["ellipsizeMode"] ?? "tail",
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
const clipboard = vi.hoisted(() => ({ copied: [] as string[] }));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (text: string) => {
    clipboard.copied.push(text);
    return true;
  },
}));
// The platform's own menu, as its options: one button each.
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    children: ReactNode;
    options: readonly { id: string; label: string; onPress: () => void }[];
  }) => (
    <div>
      {props.children}
      {props.options.map((option) => (
        <button key={option.id} onClick={option.onPress} type="button">
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
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

const { AddressSentence, AddressText, HostLine } = await import("./address-text.js");
const { CopyableAddressText } = await import("./copyable-address-text.js");
const { addressWords } = await import("./address-words.js");
const { Notice } = await import("./primitives.js");
const { sentence } = await import("./sentence-parts.js");
const { ThreadSubtitle } = await import("../thread/thread-subtitle.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  clipboard.copied.length = 0;
});

async function draw(node: ReactNode): Promise<HTMLElement[]> {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(node));
  return [...document.querySelectorAll<HTMLElement>("[data-text]")];
}

/** The characters an address is drawn with, which nothing but the drawing may carry. */
const drawnForm = /[\u2060\u200B]/u;

/** Every label a screen reader would hear on the page. */
const heard = () =>
  [...document.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("an address drawn alone", () => {
  it("never hyphenates on Android, draws the address's own characters, and says it plainly", async () => {
    const [text] = await draw(<AddressText role="title" value="person@fixture.invalid" />);
    expect(text?.dataset["hyphenation"]).toBe("none");
    expect(text?.textContent).toBe(addressWords("person@fixture.invalid"));
    expect(text?.getAttribute("aria-label")).toBe("person@fixture.invalid");
  });

  it("offers Copy of the plain value where it could be copied, and copies it exactly", async () => {
    await draw(<CopyableAddressText value="https://studio.tailnet.ts.net" />);
    const copy = [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy");
    expect(copy).toBeDefined();
    await act(async () => copy!.click());
    expect(clipboard.copied).toEqual(["https://studio.tailnet.ts.net"]);
  });
});

describe("a sentence that holds an address", () => {
  it("draws the address as one, its words as words, and is heard exactly as written", async () => {
    const [text] = await draw(
      <AddressSentence parts={sentence`Your agent will be able to use ${"github.com"} as you.`} />,
    );
    expect(text?.textContent).toBe(
      `Your agent will be able to use ${addressWords("github.com")} as you.`,
    );
    expect(text?.getAttribute("aria-label")).toBe(
      "Your agent will be able to use github.com as you.",
    );
  });

  it("draws a part that is not an address as words", async () => {
    const [text] = await draw(
      <AddressSentence parts={[{ address: "Tim Jang" }, " · github.com"]} />,
    );
    expect(text?.textContent).toBe("Tim Jang · github.com");
  });

  it("in a notice, is heard plainly too", async () => {
    await draw(
      <Notice detail={sentence`Open ${"https://account.example"} in your browser.`} title="x" />,
    );
    expect(heard().some((label) => label !== null && drawnForm.test(label))).toBe(false);
    expect(heard()).toContain("Open https://account.example in your browser.");
  });
});

describe("a host where there is one line", () => {
  it("is drawn plain on one line and gives up its start, keeping its end", async () => {
    const [text] = await draw(
      <HostLine before="Switch to tab · " host="accounts.google.com.evil.example" />,
    );
    expect(text?.textContent).toBe("Switch to tab · accounts.google.com.evil.example");
    expect(text?.dataset["lines"]).toBe("1");
    expect(text?.dataset["ellipsize"]).toBe("head");
  });
});

describe("the floating title's line that names a connected agent's host", () => {
  it("is one line that keeps the host's end, drawn plain", async () => {
    const [text] = await draw(
      <ThreadSubtitle
        connectionKeepsEnd
        connectionLabel="Connected agent · accounts.google.com.evil.example"
        task={null}
      />,
    );
    expect(text?.dataset["lines"]).toBe("1");
    expect(text?.dataset["ellipsize"]).toBe("head");
    expect(text?.textContent).not.toMatch(drawnForm);
  });

  it("keeps any other state to its one line, cut at its end", async () => {
    const [text] = await draw(<ThreadSubtitle connectionLabel="Studio Mac offline" task={null} />);
    expect(text?.dataset["lines"]).toBe("1");
    expect(text?.dataset["ellipsize"]).toBe("tail");
  });
});
