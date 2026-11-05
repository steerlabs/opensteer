import { integrationMark } from "../packages/client/src/integrations/bundled-icons.js";
import { catalogProducts } from "../packages/integration-catalog/src/index.js";
import { describe, expect, it } from "vitest";

describe("integration marks", () => {
  it("leaves custom server names without artwork for the initials fallback", () => {
    for (const id of ["custom-mcp", "constructor", "__proto__", "toString"])
      expect(integrationMark(id), id).toBeNull();
  });

  it("draws every catalog product with one mark across its ways in", () => {
    const unmarked: string[] = [];
    for (const { definitionIds } of catalogProducts) {
      const marks = definitionIds.map((id) => integrationMark(id));
      if (marks[0] === null) unmarked.push(...definitionIds);
      for (const mark of marks) expect(mark, definitionIds.join()).toEqual(marks[0]);
    }
    expect(unmarked).toEqual([]);
    expect(integrationMark("imessage")).toEqual(integrationMark("apple-messages"));
  });
});
