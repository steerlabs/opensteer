// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHelper } from "./helper.js";

let helper: ReturnType<typeof createAgentHelper>;
beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return this.hasAttribute("data-zero")
      ? ([] as unknown as DOMRectList)
      : ([new DOMRect(10, 10, 100, 30)] as unknown as DOMRectList);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 100, 30),
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation(
    () => document.querySelector("[data-hit]") ?? document.body.lastElementChild,
  );
  helper = createAgentHelper("document-1");
});
afterEach(() => {
  helper.dispose();
  vi.restoreAllMocks();
});
const locator = (by: "role" | "label" | "text" | "css", value: string, fields = {}) => ({
  by,
  value,
  ...fields,
});
let operationSequence = 0;
const invoke = (name: string, args: unknown) =>
  helper.invoke({
    documentId: "document-1",
    operationId: `operation-${++operationSequence}`,
    name,
    args,
  });
const query = (target: ReturnType<typeof locator>, read = "count", fields = {}) =>
  invoke("query", { type: "dom.query", locator: target, read, ...fields });

describe("isolated phone page helper", () => {
  it("resolves realistic roles, names, labels and scoped shadow controls", async () => {
    document.body.innerHTML =
      '<section role="dialog" aria-labelledby="title"><h2 id="title">Checkout</h2><label for="email">Email address</label><input id="email"><button aria-label="Pay now">Buy</button><img alt="Receipt"><a href="/help">Help</a></section><div id="shadow"></div>';
    document.querySelector("#shadow")!.attachShadow({ mode: "open" }).innerHTML =
      '<label>Search <input type="search"></label><button>Find</button>';
    expect(
      await query(
        locator("role", "button", {
          name: "Pay now",
          exact: true,
          scope: locator("role", "dialog", { name: "Checkout" }),
        }),
      ),
    ).toEqual({ type: "dom.query", value: 1 });
    expect(await query(locator("label", "Email address"))).toMatchObject({ value: 1 });
    expect(await query(locator("role", "img", { name: "Receipt" }))).toMatchObject({ value: 1 });
    expect(await query(locator("role", "searchbox", { name: "Search" }))).toMatchObject({
      value: 1,
    });
    expect(await query(locator("text", "Find", { exact: true }))).toMatchObject({ value: 1 });
  });

  it("refuses ambiguous and missing targets, filters hidden/inert ancestors and invalid scope depth", async () => {
    document.body.innerHTML =
      '<button>Pay</button><button>Pay</button><div hidden><button>Hidden</button></div><div inert><button>Inert</button></div><button aria-hidden="true">Ignored</button>';
    await expect(query(locator("role", "button"), "innerText")).rejects.toMatchObject({
      code: "ambiguous",
    });
    await expect(query(locator("text", "Missing"), "innerText")).rejects.toMatchObject({
      code: "not-found",
    });
    expect(await query(locator("role", "button"))).toMatchObject({ value: 2 });
    expect(
      await query(locator("role", "button", { position: "last", hasText: "Pay" })),
    ).toMatchObject({ value: 1 });
    let target = locator("css", "button");
    for (let index = 0; index < 8; index++) target = locator("css", "div", { scope: target });
    await expect(query(target)).rejects.toMatchObject({ code: "unsupported-operation" });
    await expect(
      helper.invoke({ documentId: "old", name: "query", args: {} }),
    ).rejects.toMatchObject({ code: "stale-document" });
  });

  it("never returns password values or executable attributes", async () => {
    document.body.innerHTML =
      '<label>Password<input type="password" value="secret"></label><button onclick="secret()">Pay</button>';
    const target = locator("css", "input");
    expect(await query(target, "inputValue")).toMatchObject({ value: null });
    expect(await query(target, "attribute", { attribute: "value" })).toMatchObject({ value: null });
    await expect(
      query(locator("css", "button"), "attribute", { attribute: "onclick" }),
    ).rejects.toMatchObject({ code: "unsupported-operation" });
    expect(JSON.stringify(await invoke("snapshot", { type: "dom.snapshot" }))).not.toContain(
      "secret",
    );
  });

  it("bounds snapshot traversal and bytes instead of silently omitting content", async () => {
    document.body.innerHTML = `<main>${"<button>Pay</button>".repeat(10_001)}</main>`;
    await expect(invoke("snapshot", { type: "dom.snapshot" })).rejects.toMatchObject({
      code: "too-large",
    });
    document.body.innerHTML = `<button>${"x".repeat(450_000)}</button>`;
    await expect(invoke("snapshot", { type: "dom.snapshot" })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("dispatches ordered untrusted pointer/mouse events for a double click", async () => {
    document.body.innerHTML = "<button data-hit>Pay</button>";
    const button = document.querySelector("button")!;
    const events: string[] = [];
    for (const name of [
      "pointerover",
      "pointerenter",
      "mouseover",
      "mouseenter",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "dblclick",
    ])
      button.addEventListener(name, (event) => {
        expect(event.isTrusted).not.toBe(true);
        events.push(name);
      });
    expect(
      await invoke("act", {
        type: "dom.act",
        locator: locator("role", "button"),
        kind: "click",
        clickCount: 2,
      }),
    ).toMatchObject({ trusted: false, outcome: "acted" });
    expect(events).toEqual([
      "pointerover",
      "pointerenter",
      "mouseover",
      "mouseenter",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "dblclick",
    ]);
  });

  it("uses native insertion plans for text and fixed events for check/select", async () => {
    document.body.innerHTML = '<input type="text" data-hit>';
    const input = document.querySelector("input")!;
    expect(
      await invoke("act", {
        type: "dom.act",
        locator: locator("css", "input"),
        kind: "fill",
        value: "hello",
      }),
    ).toEqual({ kind: "native-text", clear: true, text: "hello" });
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    document.body.innerHTML = '<input type="checkbox" data-hit>';
    expect(
      await invoke("act", { type: "dom.act", locator: locator("css", "input"), kind: "check" }),
    ).toMatchObject({ trusted: false, outcome: "checked" });
    expect(document.querySelector("input")!.checked).toBe(true);
    document.body.innerHTML =
      '<select data-hit><option value="a">One</option><option value="b">Two</option></select>';
    expect(
      await invoke("act", {
        type: "dom.act",
        locator: locator("css", "select"),
        kind: "selectOption",
        values: ["b"],
      }),
    ).toMatchObject({ values: ["b"], trusted: false });
  });

  it("waits for mutation and cancels without a page-owned deadline", async () => {
    const waiting = invoke("wait", {
      id: "wait-1",
      locator: locator("role", "button"),
      state: "attached",
    });
    document.body.innerHTML = "<button>Ready</button>";
    await expect(waiting).resolves.toEqual({ type: "dom.wait" });
    const canceled = invoke("wait", {
      id: "wait-2",
      locator: locator("text", "Never"),
      state: "visible",
    });
    await invoke("cancel", { id: "wait-2" });
    await expect(canceled).rejects.toMatchObject({ code: "timeout" });
  });

  it("cancels pending input before submission, not just reads", async () => {
    document.body.innerHTML = "<button data-hit>Pay</button>";
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const action = helper.invoke({
      documentId: "document-1",
      operationId: "input-1",
      name: "act",
      args: { type: "dom.act", locator: locator("role", "button"), kind: "click" },
    });
    await invoke("cancel", { id: "input-1" });
    await expect(action).rejects.toMatchObject({ code: "timeout" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("waits for a newly rendered actionable target without resubmitting the click", async () => {
    const action = invoke("act", {
      type: "dom.act",
      locator: locator("role", "button", { name: "Pay" }),
      kind: "click",
    });
    document.body.innerHTML = "<button data-hit>Pay</button>";
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    await expect(action).resolves.toMatchObject({ type: "dom.act", trusted: false });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("supports fixed coordinate taps without moving the measured point", async () => {
    document.body.innerHTML = "<button data-hit>Pay</button>";
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    await expect(invoke("tap", { type: "pointer.tap", x: 20, y: 20, count: 1 })).resolves.toEqual({
      kind: "untrusted-tap",
      trusted: false,
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("does not click until the target is enabled and uncovered", async () => {
    document.body.innerHTML = "<div data-hit>Cover</div><button disabled>Pay</button>";
    const button = document.querySelector("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const action = invoke("act", {
      type: "dom.act",
      locator: locator("role", "button"),
      kind: "click",
    });
    expect(clicked).not.toHaveBeenCalled();
    button.disabled = false;
    document.querySelector("[data-hit]")!.remove();
    await expect(action).resolves.toMatchObject({ type: "dom.act", trusted: false });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("has no code or clipboard entry point, including malformed argument strings", async () => {
    const clipboard = vi.fn(() => {
      throw new Error("Clipboard accessed");
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: clipboard });
    for (const name of [
      "evaluate",
      "eval",
      "constructor",
      "__proto__",
      "paste",
      "clipboard",
      "query",
      "snapshot",
      "act",
      "tap",
      "focus",
      "scroll",
      "wait",
      "cancel",
    ]) {
      await expect(
        invoke(name, { script: "navigator.clipboard.readText()" }),
      ).rejects.toMatchObject({ code: "unsupported-operation" });
    }
    expect(clipboard).not.toHaveBeenCalled();
  });
});
