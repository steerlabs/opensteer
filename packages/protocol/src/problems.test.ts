import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HomeHealthReportSchema,
  MachineStatusSchema,
  OpensteerProblemReportSchema,
  ProblemSchema,
  ReleaseVersionSchema,
  ReportTimeSchema,
  compareProblems,
  problemCountBucket,
  reportTime,
  diskBucket,
  problemCodes,
  problemTable,
  type HomeHealthReport,
} from "./problems.js";

/**
 * Whether a pattern can carry chosen text: unanchored, an open repetition (`*`, `+`, `{n,}`), a
 * wildcard, or a class with letters in it. Letters may appear only as fixed words.
 */
function openPattern(pattern: RegExp): boolean {
  const source = pattern.source;
  if (!source.startsWith("^") || !source.endsWith("$")) return true;
  const body = source.replace(/\\[.\-:]/gu, "");
  return /[*+]|\{\d+,\}|\\[wWsSpP]|\[\^|\[[^\]]*[a-zA-Z][^\]]*\]|\./u.test(body);
}

/**
 * Every leaf a report can hold, by kind. A string is allowed only as an enum, a literal or a
 * bounded string every pattern of which is closed; an array only with a maximum length. Anything
 * else could carry an address, a name or an error's own text, which no report may
 * (docs/architecture.md, "Problems and reports"). Nothing is exempt by name.
 */
function freeTextLeaves(schema: z.ZodType, path: string, out: string[]): void {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  // What its checks say: a maximum length, its patterns, a string format such as a datetime.
  const checks = ((def.checks ?? []) as readonly { _zod: { def: Record<string, unknown> } }[]).map(
    (check) => check._zod.def,
  );
  const maximum = checks.find((check) => check.check === "max_length")?.maximum as
    number | undefined;
  const patterns = checks
    .filter((check) => check.check === "string_format" && check.format === "regex")
    .map((check) => check.pattern as RegExp);
  const format =
    (def.format as string | undefined) ??
    (checks.find((check) => check.check === "string_format" && check.format !== "regex")?.format as
      string | undefined);
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
      if (format !== undefined && format !== "regex") out.push(`${path} (a ${format})`);
      else if (!patterns.length) out.push(path);
      else if (patterns.some(openPattern)) out.push(`${path} (an open pattern)`);
      if (maximum === undefined || maximum > 64) out.push(`${path} (no bounded length)`);
      return;
    }
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
      return freeTextLeaves(def.innerType as z.ZodType, path, out);
    case "array":
      if (maximum === undefined || maximum > 64) out.push(`${path} (no maximum length)`);
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
      ["what a person's own Home sends Opensteer", OpensteerProblemReportSchema],
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
      "report.note (no bounded length)",
      "report.detail (not strict)",
      "report.size (an unbounded number)",
    ]);
  });

  it("the guard finds the three leaks the review put in: open arrays, fine times, free version tags", () => {
    const leaves: string[] = [];
    freeTextLeaves(
      HomeHealthReportSchema.extend({
        // A byte string spelled as small numbers.
        bytes: z.array(z.number().int().min(0).max(255)),
        // Any number of fractional digits.
        at: z.iso.datetime(),
        // A pre-release tag of free letters: "1.0.0-timjang.gmail.com".
        tag: z
          .string()
          .max(64)
          .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-z0-9]{1,20}(?:\.[a-z0-9]{1,20}){0,3})?$/u),
        // And the plain shapes of the same: an unbounded tail, no length, no anchor.
        tail: z
          .string()
          .max(40)
          .regex(/^v\d+$/u),
        long: z.string().regex(/^\d{1,6}$/u),
        loose: z
          .string()
          .max(20)
          .regex(/\d{1,6}/u),
      }),
      "report",
      leaves,
    );
    expect(leaves).toEqual([
      "report.bytes (no maximum length)",
      "report.at (a datetime)",
      "report.at (no bounded length)",
      "report.tag (an open pattern)",
      "report.tail (an open pattern)",
      "report.long (no bounded length)",
      "report.loose (an open pattern)",
    ]);
  });

  it("refuses the review's three leaks as values too", () => {
    expect(ReleaseVersionSchema.safeParse("1.0.0-timjang.gmail.com").success).toBe(false);
    expect(ReleaseVersionSchema.safeParse("1.0.0-rc.2").success).toBe(true);
    expect(
      ReportTimeSchema.safeParse(
        "2026-11-24T10:00:00.1234567890123456789012345678901234567890123456789Z",
      ).success,
    ).toBe(false);
    expect(ReportTimeSchema.safeParse("2026-11-24T10:00:59Z").success).toBe(false);
    expect(reportTime("2026-11-24T10:42:59.999Z")).toBe("2026-11-24T10:42:00Z");
    expect(
      HomeHealthReportSchema.safeParse({
        ...report,
        lastUpdate: { result: "updated", at: "2026-11-24T09:00:00Z", toVersion: "1.0.0-a.b.c" },
      }).success,
    ).toBe(false);
  });

  it("sends a person's own Home's Opensteer report as codes and bucketed counts only", () => {
    expect([1, 2, 9, 10, 99, 100, 1_000_000].map(problemCountBucket)).toEqual([
      "1",
      "2-9",
      "2-9",
      "10-99",
      "10-99",
      "100+",
      "100+",
    ]);
    const body = { schema: 1, home: "mac", version: "1.4.0", codes: { "stop.unconfirmed": "2-9" } };
    expect(OpensteerProblemReportSchema.parse(body)).toEqual(body);
    for (const bad of [
      { ...body, home: "cloud-computer" },
      { ...body, codes: { "stop.unconfirmed": 3 } },
      { ...body, codes: { "cloud_computer.not_ready": "1" } },
      { ...body, at: "2026-11-24T10:00:00Z" },
    ])
      expect(OpensteerProblemReportSchema.safeParse(bad).success).toBe(false);
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
