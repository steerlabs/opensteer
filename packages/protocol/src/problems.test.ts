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
/** A string's patterns, each with its flags: a flag such as `m` changes what a source admits. */
const patternsOf = (def: Def) =>
  checksOf(def)
    .filter((check) => check.check === "string_format" && check.format === "regex")
    .map((check) => `/${(check.pattern as RegExp).source}/${(check.pattern as RegExp).flags}`);
const maximumOf = (def: Def) =>
  checksOf(def).find((check) => check.check === "max_length")?.maximum as number | undefined;

/**
 * The only patterns a report's strings may have, each with its own schema's maximum length: a
 * release version and a minute's time.
 */
const namedPatterns = new Map(
  [ReleaseVersionSchema, ReportTimeSchema].map((schema) => {
    const def = defOf(schema);
    return [patternsOf(def)[0]!, maximumOf(def)!] as const;
  }),
);
const maxEnumValues = 64;
/** At most this many repeats along any path through arrays and records. */
const maxArrayProduct = 64;
/** At most this many leaves in all; the health report holds 498. */
const maxLeaves = 512;

/**
 * The "no words" check on everything a Home sends (docs/architecture.md, "Problems and
 * reports"). What it promises: no free text gets into a report, so no field can carry an
 * address, a name, a path, a token or an error's own words. It allows an enum or a literal of at
 * most 64 values, a boolean, a bounded whole number, or a string with exactly one of the two named
 * patterns (flags and maximum length included); records keyed by an enum; arrays and records whose
 * sizes multiply to at most 64 along any path, and at most 512 leaves in all; strict objects and
 * unions of those. What it does not promise: a bound on how many chosen bits a report carries
 * (about 340 bytes today, in counts, times and versions). It need not be one: the receiver is the
 * operator of that Cloud Computer or the self-hoster's own collector, and the writers are the Host
 * and root. Returns how many leaves the schema can hold.
 */
function freeTextLeaves(
  schema: z.ZodType,
  path: string,
  out: string[],
  product = 1,
  root = true,
): number {
  const def = defOf(schema);
  const maximum = maximumOf(def);
  const leaves = ((): number => {
    switch (def.type) {
      case "enum": {
        const size = Object.keys(def.entries as object).length;
        if (size > maxEnumValues) out.push(`${path} (an enum of ${size})`);
        return 1;
      }
      case "literal": {
        const size = (def.values as readonly unknown[]).length;
        if (size > maxEnumValues) out.push(`${path} (a literal of ${size})`);
        return 1;
      }
      case "boolean":
        return 1;
      case "number": {
        // Whole numbers only, bounded: a count or minutes, never an id or a timestamp in disguise.
        const number = schema as z.ZodNumber;
        if (!number.isInt) out.push(`${path} (a fractional number)`);
        if ((number.maxValue ?? Infinity) > 1_000_000 || (number.minValue ?? -Infinity) < 0)
          out.push(`${path} (an unbounded number)`);
        return 1;
      }
      case "string": {
        const patterns = patternsOf(def);
        const named =
          def.format === undefined &&
          patterns.length === 1 &&
          namedPatterns.has(patterns[0]!) &&
          maximum === namedPatterns.get(patterns[0]!);
        if (!named) out.push(`${path} (free text)`);
        return 1;
      }
      case "optional":
      case "nullable":
      case "readonly":
        return freeTextLeaves(def.innerType as z.ZodType, path, out, product, false);
      case "array": {
        const total = maximum === undefined ? Infinity : product * maximum;
        if (total > maxArrayProduct) out.push(`${path} (up to ${total} leaves)`);
        return (
          (maximum ?? Infinity) *
          freeTextLeaves(def.element as z.ZodType, `${path}[]`, out, total, false)
        );
      }
      case "record": {
        const key = defOf(def.keyType as z.ZodType);
        if (key.type !== "enum") {
          out.push(`${path} (free keys)`);
          return Infinity;
        }
        const keys = Object.keys(key.entries as object).length;
        const total = product * keys;
        if (total > maxArrayProduct) out.push(`${path} (up to ${total} leaves)`);
        return (
          keys * freeTextLeaves(def.valueType as z.ZodType, `${path}{value}`, out, total, false)
        );
      }
      case "object": {
        const catchall = def.catchall as z.ZodType | undefined;
        if (!catchall || defOf(catchall).type !== "never") out.push(`${path} (not strict)`);
        let sum = 0;
        for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>))
          sum += freeTextLeaves(value, `${path}.${key}`, out, product, false);
        return sum;
      }
      case "union": {
        let most = 0;
        for (const option of def.options as z.ZodType[])
          most = Math.max(most, freeTextLeaves(option, path, out, product, false));
        return most;
      }
      default:
        out.push(`${path} (${String(def.type)})`);
        return Infinity;
    }
  })();
  if (root && leaves > maxLeaves) out.push(`${path} (${leaves} leaves in all)`);
  return leaves;
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
      "report (Infinity leaves in all)",
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
      "shape (Infinity leaves in all)",
    ]);
  });

  it("the guard finds the third review's shapes: flags, longer bounds, literals, records, objects", () => {
    const version = (defOf(ReleaseVersionSchema).checks as readonly { _zod: { def: Def } }[])
      .map((check) => check._zod.def.pattern as RegExp | undefined)
      .find(Boolean)!;
    const time = (defOf(ReportTimeSchema).checks as readonly { _zod: { def: Def } }[])
      .map((check) => check._zod.def.pattern as RegExp | undefined)
      .find(Boolean)!;
    const e64 = z.enum(
      Array.from({ length: 64 }, (_, index) => `k${index}`) as [string, ...string[]],
    );
    const int = z.number().int().min(0).max(1_000_000);
    const shapes = {
      // The version's own source with `m`: "hunter2@gmail.com\n1.2.3" passes it.
      multiline: z.string().max(24).regex(new RegExp(version.source, "mu")),
      // The time's own source and flags, with a longer bound than its schema's 20.
      longer: z.string().max(24).regex(time),
      // A dictionary as one multi-value literal.
      words: z.literal(Array.from({ length: 5_000 }, (_, index) => `w${index}`)),
      // 262,144 numbers in records of records.
      records: z.record(e64, z.record(e64, z.record(e64, int))),
      // 4,096 numbers: a record of arrays, and an array of records.
      recordOfArrays: z.record(e64, z.array(int).max(64)),
      arrayOfRecords: z.array(z.record(e64, int)).max(64),
      // 4,096 numbers in an array of objects of 64 fields.
      arrayOfObjects: z
        .array(
          z.strictObject(
            Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`f${index}`, int])),
          ),
        )
        .max(64),
    };
    for (const [name, schema] of Object.entries(shapes)) {
      const leaves: string[] = [];
      freeTextLeaves(schema as z.ZodType, name, leaves);
      expect(leaves.length, `${name} passed the guard`).toBeGreaterThan(0);
    }
    const said = (schema: z.ZodType, name: string) => {
      const leaves: string[] = [];
      freeTextLeaves(schema, name, leaves);
      return leaves;
    };
    expect(said(shapes.multiline, "multiline")).toEqual(["multiline (free text)"]);
    expect(said(shapes.longer, "longer")).toEqual(["longer (free text)"]);
    expect(said(shapes.words, "words")).toEqual(["words (a literal of 5000)"]);
    expect(said(shapes.records, "records")).toEqual([
      "records{value} (up to 4096 leaves)",
      "records{value}{value} (up to 262144 leaves)",
      "records (262144 leaves in all)",
    ]);
    expect(said(shapes.arrayOfObjects, "arrayOfObjects")).toEqual([
      "arrayOfObjects (4096 leaves in all)",
    ]);
    // And the values those shapes would let through.
    expect(
      z
        .string()
        .max(24)
        .regex(new RegExp(version.source, "mu"))
        .safeParse("hunter2@gmail.com\n1.2.3").success,
    ).toBe(true);
    expect(ReleaseVersionSchema.safeParse("hunter2@gmail.com\n1.2.3").success).toBe(false);
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
