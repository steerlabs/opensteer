import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile Host bundle boundary", () => {
  it("keeps the network Host port independent of the mock client", () => {
    const source = readFileSync(new URL("./host-port.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@opensteer/client/mock");
  });
});
