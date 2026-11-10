import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { browserBasicInputAllows } from "@opensteer/protocol/browser";
import type { BrowserCommand } from "../host/client.js";
import { MockBrowserInput } from "./mock-browser-input.js";
import { MockHostClient } from "./mock-host-client.js";

const surfaceId = BrowserSurfaceIdSchema.parse("field");
const operationId = "00000000-0000-4000-8000-000000000001";
const viewport = { viewportWidth: 800, viewportHeight: 600 };
afterEach(() => vi.useRealTimers());

describe("mock basic browser input", () => {
  it("declares a basic-only phone tab in the default world and applies text, composition and plain clipboard", async () => {
    vi.useFakeTimers();
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const loading = client.load();
      await vi.advanceTimersByTimeAsync(0);
      await loading;
      const session = client
        .getSnapshot()
        .browserSessions.find((session) => session.profileId?.endsWith("0003"))!;
      const tab = session.tabs[0]!;
      const release = client.retainBrowserViewer(session.id, tab.id);
      const target = client.browserFrames.editing!.target(session.id, tab.id);
      expect(client.browserViewerState(session.id, tab.id).input).toBe("basic");
      expect(target.get().input).toBe("basic");
      const contextId = target.get().context!.contextId;
      await target.send({
        kind: "edit",
        edit: { contextId, before: "", after: "", text: "hello👨‍👩‍👧" },
      });
      await target.send({ kind: "command", command: "deleteBackward" });
      await target.send({
        kind: "compose",
        composition: { contextId, text: "に", selectionStart: 1, selectionEnd: 1 },
      });
      await target.send({
        kind: "compose",
        composition: { contextId, text: "日本", selectionStart: 2, selectionEnd: 2 },
      });
      await target.send({ kind: "edit", edit: { contextId, before: "", after: "", text: "日本" } });
      await target.send({ kind: "command", command: "selectAll" });
      const copied = await target.send({ kind: "copy" });
      expect(copied?.outcome).toBe("copied");
      expect(new TextDecoder().decode(copied!.items[0]!.bytes)).toBe("hello日本");
      expect(
        await target.send({
          kind: "paste",
          items: [{ type: "text/plain", bytes: new TextEncoder().encode("new text") }],
        }),
      ).toMatchObject({ outcome: "pasted" });
      await target.send({ kind: "command", command: "selectAll" });
      const pasted = await target.send({ kind: "copy" });
      expect(new TextDecoder().decode(pasted!.items[0]!.bytes)).toBe("new text");
      release();
    } finally {
      client.dispose();
    }
  });

  it("admits exactly the protocol predicate, returning typed refusals for the rest", () => {
    const input = new MockBrowserInput(() => undefined);
    input.retain("session", surfaceId);
    const receive = vi.spyOn(input.editing, "receive");
    const commands: BrowserCommand[] = [
      { type: "input.command", surfaceId, command: "selectAll" },
      { type: "input.command", surfaceId, command: "deleteBackward" },
      { type: "input.command", surfaceId, command: "deleteWordBackward" },
      {
        type: "input.text",
        surfaceId,
        edit: { contextId: operationId, before: "", after: "", text: "x" },
      },
      {
        type: "input.text",
        surfaceId,
        edit: { contextId: operationId, before: "x", after: "", text: "y" },
      },
      {
        type: "input.compose",
        surfaceId,
        composition: { contextId: operationId, text: "한", selectionStart: 1, selectionEnd: 1 },
      },
      {
        type: "input.compose",
        surfaceId,
        composition: {
          contextId: operationId,
          before: "x",
          text: "한",
          selectionStart: 1,
          selectionEnd: 1,
        },
      },
      {
        type: "input.pointer",
        ...viewport,
        surfaceId,
        action: "down",
        x: 0.5,
        y: 0.5,
        button: "left",
        modifiers: [],
      },
      {
        type: "input.pointer",
        ...viewport,
        surfaceId,
        action: "down",
        x: 0.5,
        y: 0.5,
        button: "right",
        modifiers: [],
      },
      {
        type: "input.wheel",
        ...viewport,
        surfaceId,
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 50,
        modifiers: [],
      },
      {
        type: "input.wheel",
        ...viewport,
        surfaceId,
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 50,
        modifiers: ["control"],
      },
      { type: "input.key", surfaceId, action: "down", key: "Enter", code: "Enter", modifiers: [] },
      { type: "input.key", surfaceId, action: "down", key: "v", code: "KeyV", modifiers: ["meta"] },
      { type: "clipboard.cut", surfaceId, operationId },
      {
        type: "clipboard.paste-data",
        surfaceId,
        operationId,
        items: [{ type: "text/html", size: 1 }],
      },
      {
        type: "clipboard.paste-data",
        surfaceId,
        operationId,
        items: [{ type: "text/plain", size: 1 }],
      },
    ];
    for (const command of commands) {
      receive.mockClear();
      input.command("session", command);
      const errors = receive.mock.calls.filter(([, message]) => message.type === "browser.error");
      expect(errors.length, JSON.stringify(command)).toBe(browserBasicInputAllows(command) ? 0 : 1);
      for (const [, message] of errors)
        expect(message).toMatchObject({
          type: "browser.error",
          error: { reason: "unsupported-operation", retryable: false },
        });
    }
    input.dispose();
  });
});
