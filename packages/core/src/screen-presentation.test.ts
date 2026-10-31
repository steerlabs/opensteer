import { describe, expect, it } from "vitest";
import { ScreenShowTargetSchema, ScreenSurfaceSchema } from "./screen-presentation.js";

describe("screen presentation target authority", () => {
  it("requires a destination and refuses arbitrary routes", () => {
    expect(ScreenShowTargetSchema.safeParse({}).success).toBe(false);
    expect(ScreenShowTargetSchema.safeParse({ conversationId: "/settings" }).success).toBe(false);
    expect(ScreenShowTargetSchema.safeParse({ url: "https://example.com" }).success).toBe(false);
  });

  it("requires native source provenance and an exact owner window", () => {
    const app = {
      kind: "app",
      machineId: "rnr_11111111-1111-4111-8111-111111111111",
      appKey: "mail",
    };
    expect(ScreenSurfaceSchema.safeParse(app).success).toBe(false);
    const source = {
      kind: "owner-view",
      viewId: "cvw_11111111-1111-4111-8111-111111111111",
      generation: 1,
    };
    expect(ScreenSurfaceSchema.safeParse({ ...app, source }).success).toBe(false);
    expect(
      ScreenSurfaceSchema.safeParse({ ...app, source: { ...source, windowId: 42 } }).success,
    ).toBe(true);
    expect(
      ScreenSurfaceSchema.safeParse({
        ...app,
        source: { ...source, windowId: 42, sessionId: "another-task" },
      }).success,
    ).toBe(false);
  });
});
