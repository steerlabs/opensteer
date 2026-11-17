import { integrationMark } from "../packages/client/src/integrations/bundled-icons.js";
import { describe, expect, it } from "vitest";

describe("integration marks", () => {
  it("leaves custom server names without artwork for the initials fallback", () => {
    for (const id of ["custom-mcp", "constructor", "__proto__", "toString"])
      expect(integrationMark(id), id).toBeNull();
  });

  it("draws iMessage with the Messages mark", () => {
    expect(integrationMark("imessage")).toEqual(integrationMark("apple-messages"));
  });
});
