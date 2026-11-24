import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CloudComputerHealthViewSchema,
  HomeHealthReportSchema,
  MachineStatusSchema,
  ProblemSchema,
  ReleaseVersionSchema,
  compareProblems,
  diskBucket,
  problemCodes,
  problemTable,
  type HomeHealthReport,
} from "./problems.js";

/**
 * Every leaf a report can hold, by kind. A string is allowed only as an enum, a literal, an ISO
 * time or the release version; any other string could carry an address, a name or an error's
 * own text, which no report may (docs/architecture.md, "Problems and reports").
 */
function freeTextLeaves(schema: z.ZodType, path: string, out: string[]): void {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  switch (def.type) {
    case "enum":
    case "literal":
    case "boolean":
      return;
    case "number": {
      // Whole numbers only, bounded: a count or minutes, never an id or a timestamp in disguise.
      const number = schema as z.ZodNumber;
      if (!number.isInt) out.push(`${path} (a fractional number)`);
      if ((number.maxValue ?? Infinity) > 1_000_000 || (number.minValue ?? -Infinity) < 0)
        out.push(`${path} (an unbounded number)`);
      return;
    }
    case "string": {
      if (schema === ReleaseVersionSchema) return;
      if ((def as { format?: string }).format === "datetime") return;
      out.push(path);
      return;
    }
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
      return freeTextLeaves(def.innerType as z.ZodType, path, out);
    case "array":
      return freeTextLeaves(def.element as z.ZodType, `${path}[]`, out);
    case "record": {
      freeTextLeaves(def.keyType as z.ZodType, `${path}{key}`, out);
      return freeTextLeaves(def.valueType as z.ZodType, `${path}{value}`, out);
    }
    case "object": {
      if (
        (def.catchall as { _zod?: { def: { type: string } } } | undefined)?._zod?.def.type !==
        "never"
      )
        out.push(`${path} (not strict)`);
      for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>))
        freeTextLeaves(value, `${path}.${key}`, out);
      return;
    }
    case "union":
      for (const option of def.options as z.ZodType[]) freeTextLeaves(option, path, out);
      return;
    default:
      out.push(`${path} (${String(def.type)})`);
  }
}

const report: HomeHealthReport = {
  schema: 1,
  home: "cloud-computer",
  version: "1.4.0",
  disk: "70-85",
  services: { host: "healthy", runner: "unhealthy" },
  lastBackup: { result: "failed", failure: "repository-unreachable", at: "2026-11-24T10:00:00Z" },
  lastUpdate: {
    result: "rolled-back",
    at: "2026-11-24T09:00:00Z",
    fromVersion: "1.3.9",
    toVersion: "1.4.0",
  },
  problems: [
    {
      code: "engine.inspection_failed",
      count: 1,
      firstSeenAt: "2026-11-24T08:00:00Z",
      lastSeenAt: "2026-11-24T10:00:00Z",
      fields: { engine: "codex" },
    },
  ],
};

describe("problems", () => {
  it("can hold no free text: every field of a report is an enum, a whole number, a time or a version", () => {
    for (const [name, schema] of [
      ["report", HomeHealthReportSchema],
      ["machine status", MachineStatusSchema],
      ["the owner's view", CloudComputerHealthViewSchema],
    ] as const) {
      const leaves: string[] = [];
      freeTextLeaves(schema, name, leaves);
      expect(leaves).toEqual([]);
    }
  });

  it("the guard finds a free-text field, a loose object and an unbounded number added anywhere", () => {
    const leaves: string[] = [];
    freeTextLeaves(
      HomeHealthReportSchema.extend({
        note: z.string().optional(),
        detail: z.object({ code: z.enum(["a"]) }),
        size: z.number().int(),
      }),
      "report",
      leaves,
    );
    expect(leaves).toEqual([
      "report.note",
      "report.detail (not strict)",
      "report.size (an unbounded number)",
    ]);
  });

  it("refuses anything outside the schema: unknown fields, other codes' fields, text", () => {
    expect(HomeHealthReportSchema.parse(report)).toEqual(report);
    const problem = report.problems[0]!;
    for (const bad of [
      { ...report, note: "https://example.com/private" },
      { ...report, version: "1.4.0 /Users/person/secret" },
      { ...report, problems: [{ ...problem, message: "Bearer PRIVATE_TOKEN" }] },
      { ...report, problems: [{ ...problem, fields: { engine: "codex", service: "host" } }] },
      { ...report, problems: [{ ...problem, fields: { engine: "/Users/person/.codex" } }] },
      { ...report, services: { "my-laptop": "healthy" } },
      // A problem only the account service knows is never in a Home's report.
      {
        ...report,
        problems: [{ ...problem, code: "cloud_computer.not_ready", fields: { minutes: 40 } }],
      },
    ])
      expect(HomeHealthReportSchema.safeParse(bad).success).toBe(false);
  });

  it("gives every code one sentence, what to do, and only known fields", () => {
    expect(problemCodes.length).toBeGreaterThanOrEqual(10);
    expect(problemCodes.length).toBeLessThanOrEqual(15);
    for (const code of problemCodes) {
      const { words, next, fields } = problemTable[code];
      for (const sentence of [words, next]) expect(sentence).toMatch(/^[A-Z][^]*\.$/u);
      expect(code).toMatch(/^[a-z_]+\.[a-z_]+$/u);
      for (const field of fields)
        expect(
          ProblemSchema.safeParse({
            code,
            count: 1,
            firstSeenAt: "2026-11-24T08:00:00Z",
            lastSeenAt: "2026-11-24T08:00:00Z",
            fields: { [field]: field === "minutes" ? 1 : "x" },
          }).error?.issues.some((issue) => issue.message === "Not a field of it"),
        ).not.toBe(true);
    }
  });

  it("buckets a disk coarsely and orders what needs someone first", () => {
    expect([0.1, 0.7, 0.86, 0.99].map(diskBucket)).toEqual([
      "under-70",
      "70-85",
      "85-95",
      "over-95",
    ]);
    const at = "2026-11-24T08:00:00Z";
    const later = "2026-11-24T09:00:00Z";
    const sorted = [
      {
        code: "operation.outcome_unknown",
        count: 1,
        firstSeenAt: at,
        lastSeenAt: later,
        fields: {},
      },
      { code: "stop.unconfirmed", count: 1, firstSeenAt: at, lastSeenAt: at, fields: {} },
    ] as const;
    expect([...sorted].sort(compareProblems).map(({ code }) => code)).toEqual([
      "stop.unconfirmed",
      "operation.outcome_unknown",
    ]);
  });
});
