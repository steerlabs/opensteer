// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { FakeCdpSession } from "../test-support/fakes.js";
import { PageEditingObserver } from "./editing-observer.js";

type EditingOwner = { publish(): void; stop(): void };
const owner = () => (globalThis as typeof globalThis & { editingOwner: EditingOwner }).editingOwner;

afterEach(() => {
  owner()?.stop();
  document.documentElement.replaceChildren(document.createElement("body"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["input", "textarea"] as const)(
  "does not mutate page text when refreshing an unchanged empty %s",
  async (tag) => {
    vi.useFakeTimers();
    vi.stubGlobal("visualViewport", null);
    const field = document.createElement(tag);
    document.body.append(field);
    field.focus();
    const cdp = new FakeCdpSession();
    cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
    cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
    const observer = new PageEditingObserver(cdp, () => {});
    await observer.start();
    try {
      const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!
        .name as string;
      const publish = vi.fn();
      vi.stubGlobal(binding, publish);
      const source = cdp.sent.find(
        (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
      )!.parameters!.source as string;
      globalThis.eval(source);
      expect(publish).toHaveBeenCalledOnce();
      const mutations: MutationRecord[] = [];
      const changes = new MutationObserver((records) => mutations.push(...records));
      changes.observe(document.documentElement, { characterData: true, subtree: true });
      try {
        owner().publish();
        await vi.advanceTimersToNextFrame();
        expect(publish).toHaveBeenCalledTimes(2);
        expect([...mutations, ...changes.takeRecords()]).toEqual([]);

        field.value = "measurement fixture";
        owner().publish();
        await vi.advanceTimersToNextFrame();
        expect(publish).toHaveBeenCalledTimes(3);
        expect([...mutations, ...changes.takeRecords()].length).toBeGreaterThan(0);
        expect(document.documentElement.textContent).not.toContain(field.value);
      } finally {
        changes.disconnect();
      }
    } finally {
      await observer.close();
    }
  },
);

it("ignores untrusted contextmenu events and extracts empty href, area href, and namespaced SVG xlink:href", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("visualViewport", null);
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  const observer = new PageEditingObserver(cdp, () => {});
  await observer.start();
  try {
    const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!
      .name as string;
    const publish = vi.fn();
    vi.stubGlobal(binding, publish);
    const source = cdp.sent.find(
      (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
    )!.parameters!.source as string;
    globalThis.eval(source);
    publish.mockClear();

    const emptyAnchor = document.createElement("a");
    emptyAnchor.setAttribute("href", "");
    document.body.append(emptyAnchor);

    // Untrusted synthetic contextmenu must be ignored.
    emptyAnchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.runAllTimersAsync();
    expect(publish).not.toHaveBeenCalled();

    const trustedMenu = (target: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "isTrusted", { value: true });
      target.dispatchEvent(event);
    };

    trustedMenu(emptyAnchor);
    await vi.runAllTimersAsync();
    expect(JSON.parse(publish.mock.calls.at(-1)![0] as string)).toMatchObject({
      kind: "menu",
      linkUrl: new URL("", emptyAnchor.baseURI).href,
    });

    const area = document.createElement("area");
    area.setAttribute("href", "");
    document.body.append(area);
    trustedMenu(area);
    await vi.runAllTimersAsync();
    expect(JSON.parse(publish.mock.calls.at(-1)![0] as string)).toMatchObject({
      kind: "menu",
      linkUrl: new URL("", area.baseURI).href,
    });

    const svgNs = "http://www.w3.org/2000/svg";
    const xlinkNs = "http://www.w3.org/1999/xlink";
    const svg = document.createElementNS(svgNs, "svg");
    const svgLink = document.createElementNS(svgNs, "a");
    svgLink.setAttributeNS(xlinkNs, "xlink:href", "https://svg.test/item");
    const child = document.createElementNS(svgNs, "rect");
    svgLink.append(child);
    svg.append(svgLink);
    document.body.append(svg);
    trustedMenu(child);
    await vi.runAllTimersAsync();
    expect(JSON.parse(publish.mock.calls.at(-1)![0] as string)).toMatchObject({
      kind: "menu",
      linkUrl: "https://svg.test/item",
    });
  } finally {
    await observer.close();
  }
});

it("suppresses caret mirror measurement and editing publications while remote editing is inactive", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("visualViewport", null);
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  const observer = new PageEditingObserver(
    cdp,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  );
  await observer.start();
  try {
    expect(cdp.sent.some((entry) => entry.method === "Emulation.setFocusEmulationEnabled")).toBe(
      false,
    );
    const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!
      .name as string;
    const publish = vi.fn();
    vi.stubGlobal(binding, publish);
    const source = cdp.sent.find(
      (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
    )!.parameters!.source as string;
    globalThis.eval(source);

    field.value = "bookface query";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersToNextFrame();
    expect(publish).not.toHaveBeenCalled();

    const typedOwner = owner() as EditingOwner & { setRemote(enabled: boolean): void };
    typedOwner.setRemote(true);
    await vi.advanceTimersToNextFrame();
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    await observer.close();
  }
});

it("reconciles remote editing toggles that arrive during start without leaking focus emulation or duplicate scripts", async () => {
  const cdp = new FakeCdpSession();
  const focusGate = Promise.withResolvers<unknown>();
  let scriptId = 0;
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Emulation.setFocusEmulationEnabled", (params?: Record<string, unknown>) =>
    params?.enabled === true ? focusGate.promise : {},
  );
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", () => ({
    identifier: `script-${++scriptId}`,
  }));
  const observer = new PageEditingObserver(
    cdp,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  const starting = observer.start();
  await vi.waitFor(() =>
    expect(cdp.sent.some((entry) => entry.method === "Emulation.setFocusEmulationEnabled")).toBe(
      true,
    ),
  );
  // Disable remote editing while initial focus emulation is still in flight.
  observer.setRemoteEditing(false);
  focusGate.resolve({});
  await starting;
  await vi.waitFor(() =>
    expect(
      cdp.sent
        .filter((entry) => entry.method === "Emulation.setFocusEmulationEnabled")
        .map((entry) => entry.parameters),
    ).toEqual([{ enabled: true }, { enabled: false }]),
  );
  // Initial script-1 must be removed before registering script-2 (no duplicates).
  await vi.waitFor(() =>
    expect(
      cdp.sent
        .filter(
          (entry) =>
            entry.method === "Page.addScriptToEvaluateOnNewDocument" ||
            entry.method === "Page.removeScriptToEvaluateOnNewDocument",
        )
        .map((entry) => entry.method),
    ).toEqual([
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnNewDocument",
    ]),
  );

  // Re-enabling remote editing after the first toggle settles must run cleanly.
  observer.setRemoteEditing(true);
  await vi.waitFor(() =>
    expect(
      cdp.sent
        .filter((entry) => entry.method === "Emulation.setFocusEmulationEnabled")
        .map((entry) => entry.parameters),
    ).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]),
  );
  await vi.waitFor(() =>
    expect(
      cdp.sent
        .filter(
          (entry) =>
            entry.method === "Page.addScriptToEvaluateOnNewDocument" ||
            entry.method === "Page.removeScriptToEvaluateOnNewDocument",
        )
        .map((entry) => entry.method),
    ).toEqual([
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnNewDocument",
    ]),
  );
  await observer.close();
});
