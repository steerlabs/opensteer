import { ThreadAccessModeSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  orgModeLabel,
  orgWords,
  workAuditRecordFields,
  workAuditRecordKinds,
  workPolicyLines,
} from "./organization-copy.js";
import { defaultWorkPolicy, WorkAuditRecordSchema } from "./organizations.js";

describe("organization words", () => {
  it("names every audit record kind the schema has, and only those", () => {
    expect(workAuditRecordKinds.map(({ kind }) => kind)).toEqual(
      WorkAuditRecordSchema.options.map((option) => option.shape.kind.value),
    );
    for (const { words } of workAuditRecordKinds) expect(words.length).toBeGreaterThan(0);
  });

  it("keeps every record field to ids, choices and times", () => {
    expect(workAuditRecordFields).toContain("sequence");
    expect(workAuditRecordFields).toContain("toolFamily");
    for (const field of workAuditRecordFields)
      expect(field).not.toMatch(
        /url|title|content|script|argument|result|message|prompt|file|path|screenshot|label|text|name/iu,
      );
  });

  it("reads the default policy as its four switches", () => {
    expect(workPolicyLines(defaultWorkPolicy).map(({ value }) => value)).toEqual([
      "Supervised",
      "Not allowed",
      "Not allowed",
      "Only the work Home’s own Cloud Computer",
    ]);
    expect(
      workPolicyLines({ ...defaultWorkPolicy, allowEverything: true, allowTasks: false })[2]?.value,
    ).toBe("Not allowed");
    for (const mode of ThreadAccessModeSchema.options) expect(orgModeLabel(mode)).not.toBe("");
  });

  it("fills values and leaves unknown ones visible", () => {
    expect(orgWords("org.work.badge", { organization: "Acme" })).toBe("Work · Acme");
    expect(orgWords("org.work.badge")).toBe("Work · {organization}");
  });
});
