import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolsForEnvironmentContract } from "./catalog.js";

const previous = z
  .object({ description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })
  .parse(
    JSON.parse(
      readFileSync(new URL("./fixtures/trigger-write-e45e4ecdc.json", import.meta.url), "utf8"),
    ),
  );
describe("previous-release Trigger authoring inventory", () => {
  it.each(["main", "workspace", "delegated"] as const)(
    "freezes %s's legacy description and schema at e45e4ecdc",
    (profile) => {
      const tool = toolsForEnvironmentContract(profile, true).find(
        ({ name }) => name === "trigger_write",
      )!;
      expect(tool.description).toBe(previous.description);
      expect(JSON.stringify(tool.advertisedInputSchema)).toBe(JSON.stringify(previous.inputSchema));
    },
  );
  it("keeps the current skill-based v3 contract", () => {
    const tool = toolsForEnvironmentContract("workspace", false).find(
      ({ name }) => name === "trigger_write",
    )!;
    expect(tool.description).toContain("load opensteer-triggers");
    expect(tool.description).not.toBe(previous.description);
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" });
    expect(JSON.stringify(schema)).toContain('"enum":[1,2,3]');
  });
});
