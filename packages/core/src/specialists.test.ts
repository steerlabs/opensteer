import { describe, expect, it } from "vitest";
import { SpecialistManifestSchema } from "./specialists.js";

describe("specialist manifest", () => {
  const model = { engine: "claude", model: "haiku", options: { effort: "low" } };
  it("defaults fallback and reuses resource access levels", () => {
    expect(
      SpecialistManifestSchema.parse({
        version: 1,
        models: [model],
        access: [
          { type: "integration", service: "gmail", level: "read", reason: "Find invoices" },
          { type: "browser-profile", level: "read-write", reason: "Research" },
          { type: "computer-app", app: "com.apple.mail", level: "read", reason: "Read messages" },
          { type: "phone", level: "read", reason: "Check alerts" },
        ],
      }).fallback,
    ).toBe("none");
  });
  it.each([
    { version: 1, models: [model], unknown: true },
    { version: 1, models: [{ ...model, extra: true }] },
    { version: 1, models: [{ ...model, engine: "made-up" }] },
    { version: 1, models: [] },
    { version: 1, models: Array.from({ length: 9 }, () => model) },
    {
      version: 1,
      models: [model],
      access: [{ type: "phone", level: "full-control", reason: "Read" }],
    },
  ])("rejects invalid manifest %j", (manifest) => {
    expect(SpecialistManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
