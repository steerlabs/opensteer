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

it("does not publish a transient null field when focus switches directly between two inputs", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("visualViewport", null);
  const first = document.createElement("input");
  const second = document.createElement("input");
  document.body.append(first, second);
  first.focus();
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  const observer = new PageEditingObserver(cdp, () => {});
  await observer.start();
  try {
    const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!
      .name as string;
    const payloads: Array<{ fieldId: string | null }> = [];
    vi.stubGlobal(binding, (raw: string) => payloads.push(JSON.parse(raw)));
    const source = cdp.sent.find(
      (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
    )!.parameters!.source as string;
    globalThis.eval(source);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.fieldId).not.toBeNull();

    // Switching focus directly to another input must not emit fieldId: null (even when the
    // element's own blur event captures through window before focusin lands on the second field).
    payloads.length = 0;
    second.focus();
    vi.runAllTimers();
    expect(payloads.some((entry) => entry.fieldId === null)).toBe(false);
    expect(payloads.at(-1)?.fieldId).not.toBeNull();

    // Blurring to the page background still publishes fieldId: null.
    payloads.length = 0;
    second.blur();
    vi.runAllTimers();
    expect(payloads.at(-1)?.fieldId).toBeNull();
  } finally {
    await observer.close();
  }
});

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

it("refuses exact edits and commands under a context rotated within the same coalesced rAF frame even if final state matches", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("visualViewport", null);
  const field = document.createElement("input");
  field.value = "hello";
  document.body.append(field);
  field.focus();
  field.setSelectionRange(5, 5);

  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  cdp.responses.set("Page.getLayoutMetrics", {
    visualViewport: { clientWidth: 800, clientHeight: 600 },
  });
  cdp.responses.set("Runtime.evaluate", (params?: Record<string, unknown>) => ({
    result: { value: globalThis.eval(String(params?.expression ?? "undefined")) },
  }));
  cdp.responses.set("Input.insertText", (params?: Record<string, unknown>) => {
    const text = String(params?.text ?? "");
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    field.setSelectionRange(start + text.length, start + text.length);
    return {};
  });

  const published: Array<{ contextId: string; field: unknown }> = [];
  const observer = new PageEditingObserver(cdp, (ctx) => published.push(ctx));
  await observer.start();
  try {
    const addBinding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!;
    const binding = addBinding.parameters!.name as string;
    const world = addBinding.parameters!.executionContextName as string;
    cdp.emit("Runtime.executionContextCreated", {
      context: { id: 1, name: world, auxData: { frameId: "main" } },
    });
    const bindingCalls: string[] = [];
    vi.stubGlobal(binding, (raw: string) => {
      bindingCalls.push(raw);
      cdp.emit("Runtime.bindingCalled", { name: binding, payload: raw, executionContextId: 1 });
    });
    const source = cdp.sent.find(
      (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
    )!.parameters!.source as string;
    globalThis.eval(source);
    await Promise.resolve();
    await Promise.resolve();
    const c1 = observer.context.contextId;
    expect(observer.context.field).not.toBeNull();
    const bindingCountBeforeBurst = bindingCalls.length;

    // 1) Burst of own keystrokes via observer.input() coalesces publish into rAF (finishInput(false)).
    for (const ch of ["a", "b"]) {
      await observer.input(async () => {
        field.value += ch;
        field.setSelectionRange(field.value.length, field.value.length);
      });
    }
    expect(field.value).toBe("helloab");
    expect(bindingCalls.length).toBe(bindingCountBeforeBurst);

    // 2) Inside the SAME animation frame (before rAF fires), an external selection change moves
    // the caret away and back to 7 so the frame's final state matches caret 7, while rotating the
    // selection revision inside the same coalesced frame.
    field.setSelectionRange(2, 2);
    document.dispatchEvent(new Event("selectionchange"));
    field.setSelectionRange(7, 7);
    document.dispatchEvent(new Event("selectionchange"));
    // rAF has still not fired, so the observer has not yet published a new context.
    expect(bindingCalls.length).toBe(bindingCountBeforeBurst);

    // 3) Still inside the same frame, an exact command under c1 must be refused as stale (not
    // applied just because rAF has not flushed or final caret equals 7).
    const exactAction = vi.fn(async () => {});
    expect(await observer.command(c1, "selectAll", exactAction)).toBe(false);
    expect(exactAction).not.toHaveBeenCalled();

    // 4) An exact named replacement under c1 inside the same frame is also refused as stale.
    expect(await observer.edit({ contextId: c1, before: "ab", after: "", text: "AB" }, false)).toBe(
      false,
    );
    expect(field.value).toBe("helloab");

    // 5) Flushing the animation frame publishes the rotated context c2 != c1, and an exact command
    // under c2 is admitted, while a relative insertion under c1 still applies at the collapsed caret.
    await vi.advanceTimersToNextFrame();
    await Promise.resolve();
    await Promise.resolve();
    const c2 = observer.context.contextId;
    expect(c2).not.toBe(c1);
    expect(await observer.edit({ contextId: c1, before: "", after: "", text: "!" }, false)).toBe(
      true,
    );
    expect(field.value).toBe("helloab!");
    expect(await observer.command(c2, "selectAll", exactAction)).toBe(true);
    expect(exactAction).toHaveBeenCalledOnce();
  } finally {
    await observer.close();
  }
});
