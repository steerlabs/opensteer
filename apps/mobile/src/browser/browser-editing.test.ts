import { describe, expect, it, vi } from "vitest";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { BrowserEditingStore, type BrowserCommand } from "@opensteer/client/host";
import { createMobileBrowserEditing } from "./browser-editing.js";

const surfaceId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
const contextId = "00000000-0000-4000-8000-000000000001";

// CZ6: the send the native field waits on is the transport's own answer. The real client's
// transport refuses at once (the view is not synchronized); that refusal is what the proxy is
// told, so the reducer hears it, not a later rejection nobody reads.
describe("the phone app's browser send", () => {
  it.each([
    [true, true],
    [false, false],
  ] as const)("answers %s when the real store's transport takes it (%s)", (takes, answer) => {
    const sent: BrowserCommand[] = [];
    const store = new BrowserEditingStore((_session, _surface, command) => {
      if (!takes) throw new Error("The browser view is not synchronized.");
      sent.push(command);
    });
    store.negotiate("session", 2, surfaceId, false);
    store.receive("session", {
      type: "browser.editing",
      surfaceId,
      context: {
        contextId,
        field: { kind: "text", multiline: false, sensitive: false },
        caret: null,
      },
    });
    const errors: string[] = [];
    const editing = createMobileBrowserEditing(
      { browserFrames: { editing: store } },
      "session",
      surfaceId,
      () => true,
      {
        write: async () => "written",
        read: async () => ({ outcome: "empty", items: [] }),
      } as never,
    );
    const stop = editing.activate((message) => errors.push(message));
    expect(
      editing.send({ kind: "edit", edit: { contextId, text: "a", before: "", after: "" } }),
    ).toBe(answer);
    expect(sent.length).toBe(takes ? 1 : 0);
    if (!takes) expect(errors.length).toBeGreaterThan(0);
    stop();
    store.dispose();
  });

  it("writes a late cut result to the clipboard and updates the status after showing unknown", async () => {
    vi.useFakeTimers();
    const sent: BrowserCommand[] = [];
    const written: unknown[] = [];
    const store = new BrowserEditingStore((_session, _surface, command) => {
      sent.push(command);
    });
    store.negotiate("session", 2, surfaceId, true);
    store.receive("session", {
      type: "browser.editing",
      surfaceId,
      context: {
        contextId,
        field: { kind: "text", multiline: false, sensitive: false },
        caret: null,
      },
    });
    const messages: string[] = [];
    const editing = createMobileBrowserEditing(
      { browserFrames: { editing: store } },
      "session",
      surfaceId,
      () => true,
      {
        write: async (items: unknown) => {
          written.push(items);
          return "written";
        },
        read: async () => ({ outcome: "empty", items: [] }),
      } as never,
    );
    const stop = editing.activate((message) => messages.push(message));
    try {
      expect(editing.send({ kind: "cut", contextId })).toBe(true);
      const cutCmd = sent.find((c) => c.type === "clipboard.cut");
      if (cutCmd?.type !== "clipboard.cut") throw new Error("Missing cut command.");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(messages).toEqual(["May have been cut: check before cutting again."]);

      store.receive("session", {
        type: "clipboard.result",
        surfaceId,
        operationId: cutCmd.operationId,
        outcome: "cut",
        items: [{ type: "text/plain", size: 8 }],
      });
      store.receive("session", {
        type: "clipboard.part",
        part: { operationId: cutCmd.operationId, index: 0, data: btoa("rescued!") },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(written).toEqual([
        [{ type: "text/plain", bytes: new TextEncoder().encode("rescued!") }],
      ]);
      expect(messages).toEqual([
        "May have been cut: check before cutting again.",
        "Cut finished and copied to your clipboard.",
      ]);
    } finally {
      stop();
      store.dispose();
      vi.useRealTimers();
    }
  });
});
