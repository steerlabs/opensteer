import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HomeHealthReportSchema,
  MachineStatusSchema,
  ProblemSchema,
  ReleaseVersionSchema,
  ReportTimeSchema,
  compareProblems,
  reportTime,
  diskBucket,
  problemCodes,
  problemTable,
  type HomeHealthReport,
} from "./problems.js";

type Def = Record<string, unknown>;
const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: Def } })._zod.def;
const checksOf = (def: Def) =>
  ((def.checks ?? []) as readonly { _zod: { def: Def } }[]).map((check) => check._zod.def);
const patternsOf = (def: Def) =>
  checksOf(def)
    .filter((check) => check.check === "string_format" && check.format === "regex")
    .map((check) => (check.pattern as RegExp).source);

/** The only patterns a report's strings may have: a release version and a minute's time. */
const namedPatterns = new Set(
  [ReleaseVersionSchema, ReportTimeSchema].flatMap((schema) => patternsOf(defOf(schema))),
);
const maxEnumValues = 64;
/** At most this many leaves along any path through nested arrays. */
const maxArrayProduct = 64;

/**
 * An allow-list of what a report may hold (docs/architecture.md, "Problems and reports"): an enum
 * of at most 64 values, a literal, a boolean, a bounded whole number, or a string with exactly
 * one of the two named patterns; records keyed by an enum; arrays whose maxima multiply to at
 * most 64 along any path; strict objects and unions of those. Anything else is reported, so a
 * field that could carry an address, a name, an error's own words or chosen digits fails here.
 */
function freeTextLeaves(schema: z.ZodType, path: string, out: string[], product = 1): void {
  const def = defOf(schema);
  const checks = checksOf(def);
  const maximum = checks.find((check) => check.check === "max_length")?.maximum as
    number | undefined;
  switch (def.type) {
    case "enum": {
      const size = Object.keys(def.entries as object).length;
      if (size > maxEnumValues) out.push(`${path} (an enum of ${size})`);
      return;
    }
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
      const patterns = patternsOf(def);
      const named =
        def.format === undefined &&
        patterns.length === 1 &&
        namedPatterns.has(patterns[0]!) &&
        maximum !== undefined &&
        maximum <= 24;
      if (!named) out.push(`${path} (free text)`);
      return;
    }
    case "optional":
    case "nullable":
    case "readonly":
      return freeTextLeaves(def.innerType as z.ZodType, path, out, product);
    case "array": {
      const total = maximum === undefined ? Infinity : product * maximum;
      if (total > maxArrayProduct) out.push(`${path} (up to ${total} leaves)`);
      return freeTextLeaves(def.element as z.ZodType, `${path}[]`, out, total);
    }
    case "record": {
      if (defOf(def.keyType as z.ZodType).type !== "enum") out.push(`${path} (free keys)`);
      else freeTextLeaves(def.keyType as z.ZodType, `${path}{key}`, out, product);
      return freeTextLeaves(def.valueType as z.ZodType, `${path}{value}`, out, product);
    }
    case "object": {
      const catchall = def.catchall as z.ZodType | undefined;
      if (!catchall || defOf(catchall).type !== "never") out.push(`${path} (not strict)`);
      for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>))
        freeTextLeaves(value, `${path}.${key}`, out, product);
      return;
    }
    case "union":
      for (const option of def.options as z.ZodType[]) freeTextLeaves(option, path, out, product);
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
      "report.note (free text)",
      "report.detail (not strict)",
      "report.size (an unbounded number)",
    ]);
  });

  it("the guard finds the first review's three leaks: open arrays, fine times, free version tags", () => {
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
      }),
      "report",
      leaves,
    );
    expect(leaves).toEqual([
      "report.bytes (up to Infinity leaves)",
      "report.at (free text)",
      "report.tag (free text)",
    ]);
  });

  it("the guard finds the second review's seven shapes, which the first guard passed", () => {
    const digits = z
      .string()
      .max(64)
      .regex(/^\d{1,64}$/u);
    const printable = z
      .string()
      .max(64)
      .regex(/^[!-~]{1,64}$/u);
    const leaves: string[] = [];
    freeTextLeaves(
      z.strictObject({
        // A class of printable characters with no letter in its source.
        printable,
        // 64 chosen digits.
        digits,
        // Letters as "fixed words" under a bounded repeat.
        letters: z
          .string()
          .max(64)
          .regex(/^(?:a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z){1,64}$/u),
        // Free keys, any number of entries.
        keyed: z.record(digits, z.literal(1)),
        // 262,144 numbers in three nested arrays of 64.
        nested: z
          .array(z.array(z.array(z.number().int().min(0).max(1_000_000)).max(64)).max(64))
          .max(64),
        // A dictionary.
        word: z.enum(
          Array.from({ length: 5_000 }, (_, index) => `w${index}`) as [string, ...string[]],
        ),
        // A union with one permissive branch.
        either: z.union([z.enum(["a"]), printable]),
      }),
      "shape",
      leaves,
    );
    expect(leaves).toEqual([
      "shape.printable (free text)",
      "shape.digits (free text)",
      "shape.letters (free text)",
      "shape.keyed (free keys)",
      // 64 leaves at the first level is allowed; the nesting multiplies past it.
      "shape.nested[] (up to 4096 leaves)",
      "shape.nested[][] (up to 262144 leaves)",
      "shape.word (an enum of 5000)",
      "shape.either (free text)",
    ]);
  });

  it("refuses the reviews' leaks as values too, an impossible time among them", () => {
    expect(ReleaseVersionSchema.safeParse("1.0.0-timjang.gmail.com").success).toBe(false);
    expect(ReleaseVersionSchema.safeParse("999999.999999.999999-rc.999999").success).toBe(false);
    expect(ReleaseVersionSchema.safeParse("1.0.0-rc.2").success).toBe(true);
    for (const time of [
      "2026-11-24T10:00:00.1234567890123456789012345678901234567890123456789Z",
      "2026-11-24T10:00:59Z",
      "9999-99-99T99:99:00Z",
      "1234-56-78T90:12:00Z",
      "2026-13-01T00:00:00Z",
      "2026-11-32T00:00:00Z",
      "2026-11-24T24:00:00Z",
      "2026-11-24T23:60:00Z",
    ])
      expect(ReportTimeSchema.safeParse(time).success, time).toBe(false);
    expect(ReportTimeSchema.safeParse("2026-11-24T23:59:00Z").success).toBe(true);
    expect(reportTime("2026-11-24T10:42:59.999Z")).toBe("2026-11-24T10:42:00Z");
    expect(
      HomeHealthReportSchema.safeParse({
        ...report,
        lastUpdate: { result: "updated", at: "2026-11-24T09:00:00Z", toVersion: "1.0.0-a.b.c" },
      }).success,
    ).toBe(false);
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
