import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { EditingContext } from "@opensteer/protocol/editing";
import { FakeCdpSession, flushMicrotasks } from "../test-support/fakes.js";
import { PageEditingObserver } from "./editing-observer.js";

it("offsets a renderer's local frames before mapping its root into the parent renderer", async () => {
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "renderer-root" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  cdp.responses.set("DOM.getFrameOwner", { backendNodeId: 1 });
  cdp.responses.set("DOM.getBoxModel", { model: { content: [100, 50] } });
  const mapped: unknown[] = [];
  const observer = new PageEditingObserver(
    cdp,
    () => {},
    () => {},
    async (frame, caret) => {
      mapped.push({ frame, caret });
      return null;
    },
  );
  await observer.start();
  try {
    const world = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!;
    cdp.emit("Runtime.executionContextCreated", {
      context: {
        id: 7,
        uniqueId: randomUUID(),
        name: world.executionContextName,
        origin: "http://fixture",
        auxData: { frameId: "local-child", isDefault: false },
      },
    });
    cdp.emit("Runtime.bindingCalled", {
      name: world.name,
      executionContextId: 7,
      payload: JSON.stringify({
        fieldId: "field",
        field: { kind: "text", multiline: false, sensitive: false },
        caret: { x: 10, y: 20, height: 5 },
      }),
    });
    await flushMicrotasks();
    expect(mapped).toEqual([{ frame: "renderer-root", caret: { x: 110, y: 70, height: 5 } }]);
  } finally {
    await observer.close();
  }
});

it("publishes only the newest caret when geometry replies reverse and never after blur", async () => {
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  cdp.responses.set("DOM.getFrameOwner", () => {
    throw new Error("The root has no owner.");
  });
  const contexts: EditingContext[] = [];
  const observer = new PageEditingObserver(cdp, (context) => contexts.push(context));
  await observer.start();
  try {
    const world = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!;
    cdp.emit("Runtime.executionContextCreated", {
      context: {
        id: 7,
        uniqueId: randomUUID(),
        name: world.executionContextName,
        origin: "http://fixture",
        auxData: { frameId: "main", isDefault: false },
      },
    });
    const replies: (() => void)[] = [];
    cdp.responses.set(
      "Page.getLayoutMetrics",
      () =>
        new Promise((resolve) => {
          replies.push(() => resolve({ visualViewport: { clientWidth: 100, clientHeight: 100 } }));
        }),
    );
    const report = (x: number | null) =>
      cdp.emit("Runtime.bindingCalled", {
        name: world.name,
        executionContextId: 7,
        payload: JSON.stringify({
          fieldId: x === null ? null : "field",
          field: x === null ? null : { kind: "text", multiline: false, sensitive: false },
          caret: x === null ? null : { x, y: 10, height: 5 },
        }),
      });
    report(10);
    report(20);
    expect(replies).toHaveLength(2);
    replies[1]!();
    await flushMicrotasks();
    replies[0]!();
    await flushMicrotasks();
    expect(contexts.at(-1)?.caret?.x).toBe(0.2);
    report(30);
    report(null);
    replies[2]!();
    await flushMicrotasks();
    expect(contexts.at(-1)?.field).toBeNull();
  } finally {
    await observer.close();
  }
});

async function personWorld(markup: string) {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://accounts.example.test/login" });
  const reports: Record<string, unknown>[] = [];
  const observations: import("./editing-observer.js").PersonFillObservation[] = [];
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", {
    frameTree: { frame: { id: "main", securityOrigin: "https://accounts.example.test" } },
  });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
  const observer = new PageEditingObserver(
    cdp,
    () => {},
    () => {},
    undefined,
    (event) => observations.push(event),
  );
  await observer.start();
  const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!;
  cdp.emit("Runtime.executionContextCreated", {
    context: {
      id: 7,
      uniqueId: randomUUID(),
      name: binding.executionContextName,
      origin: "https://untrusted-report.test",
      auxData: { frameId: "main", isDefault: false },
    },
  });
  window.document.head.innerHTML = "<style>input { visibility: visible }</style>";
  window.document.body.innerHTML = markup;
  // DOM emulators have no layout; all fixture inputs occupy a visible rectangle.
  window.HTMLInputElement.prototype.getBoundingClientRect = () =>
    new window.DOMRect(10, 20, 120, 30);
  Object.defineProperty(window, "visualViewport", { value: null });
  Object.defineProperty(window, String(binding.name), {
    value: (payload: string) => {
      reports.push(JSON.parse(payload));
      cdp.emit("Runtime.bindingCalled", { name: binding.name, executionContextId: 7, payload });
    },
  });
  const source = cdp.sent.find((entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument")!
    .parameters!.source;
  window.eval(String(source));
  cdp.responses.set("Runtime.evaluate", (parameters: Record<string, unknown> | undefined) => ({
    result: { value: window.eval(String(parameters?.expression)) },
  }));
  const activate = (id: string, trusted = true, key = false) => {
    const input = window.document.getElementById(id)!;
    if (key && input instanceof window.HTMLInputElement) input.focus();
    const event = key
      ? new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true })
      : new window.PointerEvent("pointerdown", { bubbles: true, composed: true });
    Object.defineProperty(event, "isTrusted", { value: trusted });
    input.dispatchEvent(event);
    return observations.filter((event) => event.type === "binding" && event.activated).at(-1);
  };
  return {
    window,
    cdp,
    observer,
    reports,
    observations,
    activate,
    close: async () => {
      await observer.close();
      await window.happyDOM.close();
    },
  };
}

it.each([
  ['<input id="field" type="password">', "password"],
  ['<input id="field" type="password" autocomplete="new-password">', null],
  ['<input id="field" autocomplete="section-login username">', "username"],
  ['<input id="field" type="email">', "username"],
  ['<input id="field" name="identifier">', "username"],
  ['<input id="field" type="tel" name="account">', "username"],
  ['<input id="field" autocomplete="one-time-code">', "code"],
  ['<input id="field" placeholder="Verification code">', "code"],
  ['<input id="field" type="number" aria-label="Security code">', "code"],
  ['<input id="field" name="otp">', "code"],
  ['<input id="field" name="user" readonly>', null],
  ['<input disabled id="field" name="user">', null],
  ['<input id="field" name="user" style="visibility:hidden">', null],
  ['<input id="field" name="user" type="hidden">', null],
  ['<input id="field" name="search">', null],
])("classifies only writable login fields: %s", async (markup, role) => {
  const world = await personWorld(markup);
  try {
    expect(world.activate("field", false)).toBeUndefined();
    const event = world.activate("field");
    expect(event?.type === "binding" ? event.binding.role : null).toBe(role);
  } finally {
    await world.close();
  }
});

it("binds the same-form partner at activation, writes without reselection, and checks document, origin and writability", async () => {
  const world = await personWorld(
    '<form><input id="username" name="user"><input id="password" type="password"></form><input id="other" type="password">',
  );
  try {
    const event = world.activate("username", true, true);
    if (event?.type !== "binding") throw new Error("Missing username binding");
    expect(event.binding.slots).toEqual({ partner: true, group: false });
    expect(await event.binding.origin()).toBe("https://accounts.example.test");
    const password = world.window.document.getElementById("password")!;
    const events: string[] = [];
    password.addEventListener("input", (event) =>
      events.push(`${event.type}:${event.bubbles}:${event.composed}`),
    );
    password.addEventListener("change", (event) =>
      events.push(`${event.type}:${event.bubbles}:${event.composed}`),
    );
    const origin = "https://accounts.example.test";
    expect(await event.binding.write("partner", "fixture", "https://changed.test")).toBe(false);
    expect(await event.binding.write("partner", "fixture", origin)).toBe(true);
    expect(events).toEqual(["input:true:true", "change:true:true"]);
    password.setAttribute("readonly", "");
    expect(await event.binding.write("partner", "blocked", origin)).toBe(false);
    password.removeAttribute("readonly");
    password.remove();
    expect(await event.binding.write("partner", "blocked", origin)).toBe(false);
    world.cdp.responses.set("Page.getFrameTree", {
      frameTree: { frame: { id: "main", securityOrigin: "https://changed.test" } },
    });
    expect(await event.binding.write("target", "blocked", origin)).toBe(false);
    world.cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
    expect(await event.binding.write("target", "blocked", origin)).toBe(false);
  } finally {
    await world.close();
  }
});

it("binds the nearest preceding username and keeps username-first and password-only pages usable", async () => {
  const world = await personWorld(
    '<form><input id="first" name="user"><input id="username" type="email"><input id="password" type="password"></form>',
  );
  try {
    const event = world.activate("password");
    if (event?.type !== "binding") throw new Error("Missing password binding");
    expect(await event.binding.write("partner", "fixture", "https://accounts.example.test")).toBe(
      true,
    );
    expect(world.window.eval('document.getElementById("username").value')).toBe("fixture");
    expect(world.window.eval('document.getElementById("first").value')).toBe("");
  } finally {
    await world.close();
  }
  for (const markup of [
    '<input id="field" name="username">',
    '<input id="field" type="password">',
  ]) {
    const single = await personWorld(markup);
    try {
      const event = single.activate("field");
      expect(event?.type === "binding" && event.binding.slots.partner).toBe(false);
    } finally {
      await single.close();
    }
  }
});

it("distributes a bound code in order with leading zeros, rechecking after each page event", async () => {
  const world = await personWorld(
    `<div>${Array.from({ length: 6 }, (_, i) => `<input id="box${i}" maxlength="1">`).join("")}</div>`,
  );
  try {
    const event = world.activate("box2");
    if (event?.type !== "binding") throw new Error("Missing code binding");
    expect(event.binding.role).toBe("code");
    expect(event.binding.slots.group).toBe(true);
    // Code widgets move focus to the next box as each digit arrives.
    world.window.eval(
      'document.querySelectorAll("input").forEach((input, index, all) => input.addEventListener("input", () => all[index + 1]?.focus()))',
    );
    expect(await event.binding.write("group", "001234", "https://accounts.example.test")).toBe(
      true,
    );
    expect(
      world.window.eval('Array.from(document.querySelectorAll("input"), input => input.value)'),
    ).toEqual(["0", "0", "1", "2", "3", "4"]);
    world.window.document
      .getElementById("box0")!
      .addEventListener("input", () => world.window.document.getElementById("box1")!.remove());
    expect(await event.binding.write("group", "987654", "https://accounts.example.test")).toBe(
      false,
    );
    expect(world.window.eval('document.getElementById("box2").value')).toBe("1");
  } finally {
    await world.close();
  }
});

it("routes cross-process bindings and writes through their owning private world, withdrawing on detach", async () => {
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "root" });
  cdp.responses.set("DOM.getFrameOwner", { backendNodeId: 1 });
  cdp.responses.set("DOM.getBoxModel", { model: { content: [100, 50] } });
  const commands: { method: string; params?: Record<string, unknown> }[] = [];
  cdp.responses.set(
    "Target.sendMessageToTarget",
    (parameters: Record<string, unknown> | undefined) => {
      const command = JSON.parse(String(parameters?.message)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      commands.push(command);
      const result =
        command.method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "child", securityOrigin: "https://frame.example.test" } } }
          : command.method === "Page.addScriptToEvaluateOnNewDocument"
            ? { identifier: "child-script" }
            : command.method === "Runtime.evaluate"
              ? { result: { value: true } }
              : {};
      cdp.emit("Target.receivedMessageFromTarget", {
        sessionId: "child-session",
        message: JSON.stringify({ id: command.id, result }),
      });
      return {};
    },
  );
  const observations: import("./editing-observer.js").PersonFillObservation[] = [];
  const observer = new PageEditingObserver(
    cdp,
    () => {},
    () => {},
    undefined,
    (event) => observations.push(event),
  );
  await observer.start();
  try {
    cdp.emit("Target.attachedToTarget", {
      sessionId: "child-session",
      targetInfo: { type: "iframe" },
    });
    await vi.waitFor(() =>
      expect(
        commands.some((command) => command.method === "Page.addScriptToEvaluateOnNewDocument"),
        "Child private observer never installed",
      ).toBe(true),
    );
    const world = commands.find((command) => command.method === "Runtime.addBinding")!.params!;
    const emit = (method: string, params: unknown) =>
      cdp.emit("Target.receivedMessageFromTarget", {
        sessionId: "child-session",
        message: JSON.stringify({ method, params }),
      });
    emit("Runtime.executionContextCreated", {
      context: {
        id: 8,
        uniqueId: randomUUID(),
        name: world.executionContextName,
        origin: "https://untrusted.test",
        auxData: { frameId: "child", isDefault: false },
      },
    });
    const bindingId = randomUUID();
    emit("Runtime.bindingCalled", {
      name: world.name,
      executionContextId: 8,
      payload: JSON.stringify({
        kind: "person-fill",
        bindingId,
        role: "password",
        activated: true,
        box: { x: 10, y: 20, width: 120, height: 30 },
        slots: { partner: false, group: false },
      }),
    });
    const event = observations.find((event) => event.type === "binding");
    if (event?.type !== "binding") throw new Error("Child binding never reached the parent");
    expect(await event.anchor).toEqual({
      x: 110 / 1280,
      y: 70 / 720,
      width: 120 / 1280,
      height: expect.closeTo(30 / 720),
    });
    expect(await event.binding.origin()).toBe("https://frame.example.test");
    expect(await event.binding.write("target", "fixture", "https://frame.example.test")).toBe(true);
    expect(
      commands.filter((command) => command.method === "Runtime.evaluate").at(-1)?.params,
    ).toMatchObject({ contextId: 8 });
    cdp.emit("Target.detachedFromTarget", { sessionId: "child-session" });
    expect(observations).toContainEqual({ type: "withdrawn", bindingId });
    expect(await event.binding.write("target", "fixture", "https://frame.example.test")).toBe(
      false,
    );
  } finally {
    await observer.close();
  }
});

it.each([3, 4, 8, 9])(
  "recognizes only contiguous code groups of four to eight inputs (%s)",
  async (count) => {
    const world = await personWorld(
      `<div>${Array.from({ length: count }, (_, i) => `<input id="digit${i}" maxlength="1">`).join("")}</div>`,
    );
    try {
      const event = world.activate("digit0");
      expect(event?.type === "binding" ? event.binding.role : null).toBe(
        count >= 4 && count <= 8 ? "code" : null,
      );
    } finally {
      await world.close();
    }
  },
);

it("keeps separate code runs separate and follows form ownership outside the form's subtree", async () => {
  const world = await personWorld(
    '<form id="login"><input id="username" name="user"></form><input form="login" id="password" type="password"><div><input id="digit0" maxlength="1"><input maxlength="1"><span></span><input maxlength="1"><input maxlength="1"></div>',
  );
  try {
    expect(world.activate("digit0")).toBeUndefined();
    const event = world.activate("username");
    if (event?.type !== "binding") throw new Error("Missing form binding");
    expect(event.binding.slots.partner).toBe(true);
    expect(await event.binding.write("partner", "fixture", "https://accounts.example.test")).toBe(
      true,
    );
    expect(world.window.eval('document.getElementById("password").value')).toBe("fixture");
    world.window.location.href = "https://changed.example.test/login";
    expect(await event.binding.write("target", "blocked", "https://accounts.example.test")).toBe(
      false,
    );
  } finally {
    await world.close();
  }
});
