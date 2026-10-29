import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
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
