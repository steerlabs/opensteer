import { describe, expect, it } from "vitest";
import { BrowserServerMessageSchema, createBrowserSessionId } from "./browser.js";
import { RunnerBrowserModuleSchema } from "./runner.js";

const snapshot = {
  type: "browser.snapshot",
  access: "full-control",
  state: "ready",
  dialog: null,
  sessionId: createBrowserSessionId(),
  surfaces: [],
};
describe("browser editing split capability", () => {
  it.each([false, true])("accepts v2 only with explicit clipboard %s", (clipboard) => {
    expect(
      BrowserServerMessageSchema.parse({ ...snapshot, editingVersion: 2, clipboard }),
    ).toMatchObject({ editingVersion: 2, clipboard });
    expect(
      RunnerBrowserModuleSchema.parse({ runtimeId: "browser", editing: 2, clipboard }),
    ).toMatchObject({ editing: 2, clipboard });
  });
  it("keeps v1 and baseline shapes exact and rejects ambiguous v2 snapshots", () => {
    expect(BrowserServerMessageSchema.parse({ ...snapshot, editingVersion: 1 })).not.toHaveProperty(
      "clipboard",
    );
    expect(BrowserServerMessageSchema.safeParse({ ...snapshot, editingVersion: 2 }).success).toBe(
      false,
    );
    expect(
      BrowserServerMessageSchema.safeParse({ ...snapshot, editingVersion: 1, clipboard: false })
        .success,
    ).toBe(false);
    expect(BrowserServerMessageSchema.safeParse({ ...snapshot, clipboard: false }).success).toBe(
      false,
    );
    const future = RunnerBrowserModuleSchema.parse({
      runtimeId: "browser",
      editing: 3,
      clipboard: true,
    });
    expect(future.editing).toBeUndefined();
    expect(future.clipboard).toBeUndefined();
  });
});
