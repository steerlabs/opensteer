import { describe, expect, it } from "vitest";
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
});
