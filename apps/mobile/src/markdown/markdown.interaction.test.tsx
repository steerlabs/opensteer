// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));

// The real renderer over DOM hosts: what a phone would draw, in order and by kind.
vi.mock("react-native", () => {
  const style = (value: unknown): string => JSON.stringify(value ?? null);
  return {
    Alert: { alert: vi.fn() },
    Linking: linking,
    Platform: { OS: "ios", Version: "27.0", select: () => undefined },
    ScrollView: ({ children }: { children?: ReactNode }) => <div data-scroll>{children}</div>,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: (props: {
      accessibilityRole?: string;
      children?: ReactNode;
      onPress?: () => void;
      selectable?: boolean;
      style?: unknown;
    }) => (
      <span
        data-role={props.accessibilityRole}
        data-selectable={props.selectable === true || undefined}
        data-style={style(props.style)}
        onClick={props.onPress}
      >
        {props.children}
      </span>
    ),
    View: (props: { children?: ReactNode; style?: unknown }) => (
      <div data-style={style(props.style)}>{props.children}</div>
    ),
  };
});
vi.mock("../ui/copy-mark.js", () => ({
  CopyMark: (props: { accessibilityLabel: string; text: string }) => (
    <button aria-label={props.accessibilityLabel} data-copies={props.text} />
  ),
}));
vi.mock("../ui/primitives.js", () => ({ monoFontFamily: "Menlo" }));
vi.mock("../ui/symbol.js", () => ({
  Symbol: (props: { name: string }) => <i data-symbol={props.name} />,
}));

import { Markdown } from "./markdown.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  linking.openURL.mockClear();
});

function draw(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

const bold = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-style]")]
    .filter((node) => node.dataset["style"] === '{"fontWeight":"600"}')
    .map((node) => node.textContent ?? "");

describe("Markdown on a phone", () => {
  it("reads inline text as web does, keeping what the old parser mangled", () => {
    const words = draw(
      <Markdown
        text={
          "see my_file_name.txt, 2 * 3 * 4, and \\*\\*escaped\\*\\* &amp; **[a](https://a.co)**"
        }
      />,
    );
    expect(words.textContent).toBe("see my_file_name.txt, 2 * 3 * 4, and **escaped** & a");
    expect(bold(words)).toEqual(["a"]);
  });

  it("draws bold CommonMark refuses, with what is nested in it", () => {
    const words = draw(<Markdown text={"**Note:**next and **`code`**text"} />);
    expect(bold(words)).toEqual(["Note:", "code"]);
    expect(words.textContent).toBe("Note:next and codetext");
  });

  it("draws bold still being written as bold, with no stray markers", () => {
    const words = draw(<Markdown streaming text={"Done.\n\nThis is **partial"} />);
    expect(bold(words)).toEqual(["partial"]);
    expect(words.textContent).not.toContain("**");
  });

  it("keeps a heading from swallowing the body written straight under it", () => {
    const words = draw(<Markdown text={"# Result\nIt passed."} />);
    expect(words.querySelector('[data-role="header"]')?.textContent).toBe("Result");
    expect(words.textContent).toBe("ResultIt passed.");
  });

  it("numbers a list from where its author started it, and nests one in another", () => {
    const words = draw(<Markdown text={"3. Third\n   - inner\n4. Fourth"} />);
    expect(words.textContent).toBe("3.Third•inner4.Fourth");
  });

  it("gives a list item's words the width of a bubble that sizes itself by them", () => {
    const words = draw(<Markdown look="bubble" text={"- one\n- two"} />);
    const bodies = [...words.querySelectorAll<HTMLElement>("[data-style]")].filter((node) =>
      node.dataset["style"]?.includes("flexShrink"),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.dataset["style"]).not.toContain('"flex":');
  });

  it("marks done and open tasks, and strikes out what the author struck", () => {
    const words = draw(<Markdown text={"- [x] done\n- [ ] open\n\n~~gone~~"} />);
    const marks = [...words.querySelectorAll<HTMLElement>("[data-symbol]")];
    expect(marks.map((mark) => mark.dataset["symbol"])).toEqual([
      "checkmark.circle.fill",
      "circle",
    ]);
    expect(words.textContent).toContain("gone");
    expect(words.textContent).not.toContain("~~");
  });

  it("reads a table's cells, padding a short row to the header's width", () => {
    const words = draw(<Markdown text={"| a | b |\n|---|---|\n| **1** |"} />);
    expect(words.textContent).toBe("ab1");
    expect(bold(words)).toEqual(["1"]);
  });

  it("keeps a fence that has not closed yet readable while it streams", () => {
    const words = draw(<Markdown streaming text={"```ts\nconst a = 1;"} />);
    expect(words.querySelector("button")?.dataset["copies"]).toBe("const a = 1;");
  });

  it("copies a block's own words, and names what it copies", () => {
    const words = draw(<Markdown text={"```draft\nHeads up.\n```\n\n```\nls\n```"} />);
    const marks = [...words.querySelectorAll("button")];
    expect(marks.map((mark) => mark.getAttribute("aria-label"))).toEqual([
      "Copy draft",
      "Copy code",
    ]);
    expect(marks.map((mark) => mark.dataset["copies"])).toEqual(["Heads up.", "ls"]);
  });

  it("lets a task's words be selected in place, and leaves a bubble's to its hold", () => {
    expect(draw(<Markdown text="Words" />).querySelector("[data-selectable]")).not.toBeNull();
    expect(
      draw(<Markdown look="bubble" text="Words" />).querySelector("[data-selectable]"),
    ).toBeNull();
  });
});

describe("Links an agent wrote, on a phone", () => {
  const linkIn = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[data-role="link"]');

  it("opens a web link, and a bare address the author did not wrap", () => {
    const words = draw(<Markdown text="[docs](https://a.co/x) and https://b.co/y." />);
    act(() => linkIn(words)?.click());
    expect(linking.openURL).toHaveBeenCalledWith("https://a.co/x");
    expect(words.querySelectorAll('[data-role="link"]')).toHaveLength(2);
    expect(words.textContent).toBe("docs and https://b.co/y.");
  });

  it("opens a link written by reference, and keeps a referenced image's words", () => {
    const words = draw(
      <Markdown
        text={"[docs][ref] ![a chart][img]\n\n[ref]: https://a.co/x\n[img]: https://a.co/c.png"}
      />,
    );
    act(() => linkIn(words)?.click());
    expect(linking.openURL).toHaveBeenCalledWith("https://a.co/x");
    expect(words.textContent).toBe("docs a chart");
  });

  it.each([
    ["a local file", "/Users/person/Downloads/report.pdf"],
    ["a script", "javascript:alert(1)"],
    ["a URL carrying credentials", "https://reader:secret@example.test/private"],
  ])("keeps the words of %s and never opens it", (_name, href) => {
    const words = draw(<Markdown text={`[the words](${href})`} />);
    expect(linkIn(words)).toBeNull();
    expect(words.textContent).toBe("the words");
  });

  it("never fetches an image an agent names, and keeps its words", () => {
    const words = draw(<Markdown text="![a chart](https://a.co/chart.png)" />);
    expect(words.querySelector("img")).toBeNull();
    expect(words.textContent).toBe("a chart");
  });
});
