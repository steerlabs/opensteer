import { describe, expect, it } from "vitest";
import { localAddressHint, slugFromName } from "./team-address.js";

describe("team address", () => {
  it("suggests a valid address from any name", () => {
    expect(slugFromName("Acme Design")).toBe("acme-design");
    expect(slugFromName("  Crème Brûlée & Co. ")).toBe("creme-brulee-co");
    expect(slugFromName("x".repeat(31) + " y")).toBe("x".repeat(31));
  });

  it("refuses what Account would refuse before asking it", () => {
    expect(localAddressHint("ab")?.hint).toBe("At least 3 characters.");
    expect(localAddressHint("teams")?.hint).toBe("That address is reserved.");
    expect(localAddressHint("a--b")?.ok).toBe(false);
    expect(localAddressHint("acme")).toBeNull();
  });
});
