import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workAuditKindValues, WorkAuditRecordSchema } from "./organizations.js";
import { workAuditRecordKinds } from "./organization-copy.js";

describe("Work audit wire", () => {
  it("no excluded field can reach a record", () => {
    const fields = new Set([
      "kind",
      "sequence",
      "at",
      "connectionId",
      "grantId",
      "grantRevision",
      "ownerId",
      "agentSessionId",
      "operationId",
      "toolFamily",
      "targetKind",
      "grantedResourceId",
      "effectiveMode",
      "policyRevision",
      "decidedBy",
      "handedOffAt",
      "outcome",
      "requestId",
      "deviceId",
      "enabled",
      "switch",
      "revision",
    ]);
    const json = z.toJSONSchema(WorkAuditRecordSchema, { io: "input" });
    const branches = json.oneOf ?? json.anyOf;
    expect(branches).toHaveLength(workAuditKindValues.length);
    for (const variant of branches ?? []) {
      expect(variant.additionalProperties).toBe(false);
      for (const [name, schema] of Object.entries(variant.properties ?? {})) {
        expect(fields.has(name)).toBe(true);
        function check(value: typeof schema): void {
          if (typeof value === "boolean") {
            expect(value).toBe(false);
            return;
          }
          const alternatives = value.anyOf ?? value.oneOf;
          if (alternatives) {
            alternatives.forEach(check);
          } else if (value.type === "string") {
            expect(
              Boolean(
                value.pattern ||
                value.enum ||
                value.const ||
                value.format === "uuid" ||
                value.format === "date-time",
              ),
              name,
            ).toBe(true);
          } else {
            expect(["integer", "null"].includes(String(value.type)), name).toBe(true);
          }
        }
        check(schema);
      }
    }
    expect(workAuditRecordKinds.map(({ kind }) => kind).sort()).toEqual(
      [...workAuditKindValues].sort(),
    );
  });
});
