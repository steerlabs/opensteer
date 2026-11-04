import { describe, expect, it } from "vitest";
import { intersectResourceAccess } from "./resource-access.js";

describe("resource ceilings", () => {
  it("intersects Workspace, connection and specialist levels without granting missing consent", () => {
    expect(intersectResourceAccess("read-write", "read")).toBe("read");
    expect(intersectResourceAccess("read", "read-write")).toBe("read");
    expect(intersectResourceAccess(null, "read-write")).toBeNull();
    expect(intersectResourceAccess("read-write", null)).toBeNull();
    expect(intersectResourceAccess("read-write")).toBe("read-write");
  });
});
