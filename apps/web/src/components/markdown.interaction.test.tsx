// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { MemoryRouter } from "react-router";
import { WorkspaceProvider } from "./workspace/workspace-context.js";
import type { WorkspaceNavigation } from "./workspace/navigation.js";
import { Markdown } from "./markdown.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const showLauncher = vi.fn();
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  showLauncher.mockClear();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "opensteerDesktop");
});

function render(text: string, workspace = true): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const markdown = <Markdown text={text} />;
  act(() =>
    root.render(
      workspace ? (
        <MemoryRouter>
          <WorkspaceProvider
            attention={0}
            nav={{ showLauncher } as unknown as WorkspaceNavigation}
            openDrawer={() => undefined}
          >
            {markdown}
          </WorkspaceProvider>
        </MemoryRouter>
      ) : (
        markdown
      ),
    ),
  );
  return container;
}

function anchorFor(container: HTMLElement, label: string): HTMLAnchorElement | null {
  return [...container.querySelectorAll("a")].find((a) => a.textContent === label) ?? null;
}

/** Agent text that may not open anything keeps its words and loses the link. */
const inertLinks = [
  ["the incident's downloaded file", "/Users/person/Downloads/tiger-in-snow.jpg"],
  ["an app route", "/settings/devices"],
  ["a Workspace-relative file", "docs/portablefs-contract.md"],
  ["a dot-relative file", "./out/report.pdf"],
  ["a file URL", "file:///Users/person/notes.md"],
  ["a fragment", "#contract"],
  ["a script", "javascript:alert(1)"],
  ["a protocol-relative URL", "//cdn.example.test/guide"],
  ["a URL carrying credentials", "https://reader:secret@example.test/private"],
] as const;

describe("Markdown links written by an agent, in a browser", () => {
  it.each(inertLinks)("shows %s as text, never as a link", (_name, href) => {
    const container = render(`Saved it: [the label](${href}).`);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Saved it: the label.");
  });

  it.each(["https://example.test/guide", "http://example.test/mirror", "mailto:a@example.test"])(
    "renders %s as a real link",
    (href) => {
      const anchor = anchorFor(render(`See [the guide](${href}).`), "the guide");
      expect(anchor?.getAttribute("href")).toBe(href);
      expect(anchor?.target).toBe("_blank");
      expect(anchor?.rel).toBe("noreferrer");
    },
  );

  it.each(["https://example.test/guide", "http://localhost:3000/", "http://192.168.1.5/"])(
    "opens %s through the workspace start page",
    (href) => {
      const anchor = anchorFor(render(`[guide](${href})`), "guide")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => {
        anchor.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(showLauncher).toHaveBeenCalledExactlyOnceWith({ address: href });
    },
  );

  it.each([
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { button: 2 },
  ])("leaves browser gestures alone: %j", (gesture) => {
    const anchor = anchorFor(render("[guide](https://example.test/guide)"), "guide")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...gesture });
    let intercepted = false;
    // Observe after React, then stop happy-dom from fetching a device page.
    const observe = (click: Event) => {
      intercepted = click.defaultPrevented;
      click.preventDefault();
    };
    document.addEventListener("click", observe, { once: true });
    act(() => {
      anchor.dispatchEvent(event);
    });
    expect(intercepted).toBe(false);
    expect(showLauncher).not.toHaveBeenCalled();
  });

  it("shows web links as words without a workspace", () => {
    const container = render(
      "[https](https://example.test/) [http](http://localhost:3000/) www.example.test",
      false,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("https http www.example.test");
    expect(showLauncher).not.toHaveBeenCalled();
  });

  it("applies the same rule to autolinks and same-block references", () => {
    const container = render(
      "Status at www.example.test and https://example.test/bare.\n" +
        "Notes in [the draft][draft].\n\n" +
        "[draft]: /Users/person/draft.md",
    );
    expect(anchorFor(container, "www.example.test")?.target).toBe("_blank");
    expect(anchorFor(container, "https://example.test/bare")?.target).toBe("_blank");
    expect(anchorFor(container, "the draft")).toBeNull();
  });

  it("never loads an image an agent names, and keeps its words", () => {
    const container = render(
      "![Mount sequence](/Users/person/Workspaces/main/mount-sequence.png)\n\n" +
        "![](https://images.example.test/tracker.png)\n\n" +
        "![](file:///Users/person/Downloads/report.png)\n\n" +
        "[![Grant flow](https://images.example.test/grant-flow.png)](https://example.test/grants)",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Mount sequence");
    expect(container.textContent).toContain("https://images.example.test/tracker.png");
    expect(anchorFor(container, "https://images.example.test/tracker.png")).toBeNull();
    expect(container.textContent).toContain("file:///Users/person/Downloads/report.png");
    expect(container.querySelectorAll("a a")).toHaveLength(0);
    expect(anchorFor(container, "Grant flow")?.getAttribute("href")).toBe(
      "https://example.test/grants",
    );
  });
});

describe("Markdown links written by an agent, on desktop", () => {
  function desktop() {
    const openExternalUrl = vi.fn(async () => ({ opened: true as const }));
    Object.assign(window, {
      opensteerDesktop: { openExternalUrl } as unknown as OpensteerDesktopBridge,
    });
    return openExternalUrl;
  }

  it.each([
    "https://example.test/guide",
    "http://localhost:3000/",
    "http://127.0.0.1:12345/connect/chrome#invitation",
  ])("opens %s in Opensteer for plain and modified clicks", (href) => {
    const openExternalUrl = desktop();
    const anchor = anchorFor(render(`[guide](${href})`), "guide")!;
    expect(anchor?.href).toBe(href);
    const gestures = [
      { type: "click" },
      { type: "click", metaKey: true },
      { type: "click", ctrlKey: true },
      { type: "click", shiftKey: true },
      { type: "click", altKey: true },
      { type: "auxclick", button: 1 },
    ];
    for (const { type, ...gesture } of gestures) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...gesture });
      act(() => {
        anchor.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(showLauncher.mock.calls).toEqual(gestures.map(() => [{ address: href }]));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("never opens a link on a right click", () => {
    const openExternalUrl = desktop();
    const anchor = anchorFor(render("[guide](https://example.test/guide)"), "guide")!;
    const event = new MouseEvent("auxclick", { bubbles: true, button: 2, cancelable: true });
    act(() => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(showLauncher).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens GFM www autolinks in Opensteer", () => {
    const openExternalUrl = desktop();
    const anchor = anchorFor(render("www.example.test"), "www.example.test")!;
    act(() => anchor.click());
    expect(showLauncher).toHaveBeenCalledExactlyOnceWith({ address: "http://www.example.test/" });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens a linked image's destination once, not once per nested link", () => {
    const openExternalUrl = desktop();
    const container = render(
      "[![Grant flow](https://images.example.test/grant-flow.png)](https://example.test/grants)",
    );
    act(() => {
      anchorFor(container, "Grant flow")?.click();
    });
    expect(showLauncher).toHaveBeenCalledExactlyOnceWith({
      address: "https://example.test/grants",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it.each([...inertLinks.map(([, href]) => href), "mailto:a@x.test"])(
    "shows %s as text",
    (href) => {
      const openExternalUrl = desktop();
      const container = render(`See [the label](${href}).`);
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toBe("See the label.");
      expect(openExternalUrl).not.toHaveBeenCalled();
    },
  );
});
