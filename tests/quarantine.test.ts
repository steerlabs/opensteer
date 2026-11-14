import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { activeQuarantines, QuarantineSchema } from "../scripts/quarantine.js";

const entry = {
  file: "historical/not-present.test.ts",
  name: ["suite", "case"],
  area: "Browser",
  owner: "browser owner",
  status: "investigating",
  firstSeen: "2026-10-28T01:24:00Z",
  deadline: "2026-11-04T01:24:00Z",
  sha: null,
  evidence: [],
};
const sha = "a".repeat(40);

describe("quarantine register", () => {
  it("expires execution exemptions, including at the deadline, but keeps investigations informational", () => {
    const record = {
      ...entry,
      status: "quarantined",
      sha,
      evidence: ["same-SHA failure and pass"],
    };
    const records = QuarantineSchema.parse([record]);
    expect(activeQuarantines(records, Date.parse(entry.deadline) - 1)).toEqual(records);
    for (const now of [Date.parse(entry.deadline), Date.parse(entry.deadline) + 1])
      expect(() => activeQuarantines(records, now)).toThrow(
        /expired.*historical\/not-present.test.ts/s,
      );
    expect(
      activeQuarantines(QuarantineSchema.parse([entry]), Date.parse(entry.deadline) + 1),
    ).toEqual([]);
  });
  it("accepts each status and the inclusive zero-to-seven-day deadline bounds", () => {
    for (const status of ["quarantined", "investigating", "known-failure"]) {
      const record = { ...entry, status, sha, evidence: ["failure and same-SHA rerun"] };
      expect(QuarantineSchema.parse([record])).toEqual([record]);
      expect(QuarantineSchema.parse([{ ...record, deadline: entry.firstSeen }])).toHaveLength(1);
    }
    expect(QuarantineSchema.parse([entry])).toEqual([entry]);
  });

  it.each([
    ["a non-UTC first-seen offset", { firstSeen: "2026-10-28T01:24:00+00:00" }],
    ["a non-UTC deadline offset", { deadline: "2026-11-04T02:24:00+01:00" }],
    ["a timestamp without a zone", { firstSeen: "2026-10-28T01:24:00" }],
    ["a date without a time", { deadline: "2026-11-04" }],
    ["an impossible calendar date", { firstSeen: "2026-02-30T00:00:00Z" }],
    ["a deadline before firstSeen", { deadline: "2026-10-28T01:23:59.999Z" }],
    ["a deadline over seven days by one millisecond", { deadline: "2026-11-04T01:24:00.001Z" }],
    ["an empty file identity", { file: "" }],
    ["a file glob", { file: "tests/../*.test.ts" }],
    ["an absolute file", { file: "/tests/case.test.ts" }],
    ["an empty title path", { name: [] }],
    ["an empty title component", { name: ["suite", ""] }],
    ["missing ownership", { owner: " " }],
    ["an unknown status", { status: "closed" }],
    ["an exemption flag", { skip: true }],
    ["a quarantined entry without SHA", { status: "quarantined", evidence: ["log"] }],
    ["a quarantined entry without evidence", { status: "quarantined", sha }],
    ["a malformed SHA", { status: "quarantined", sha: "not-a-commit", evidence: ["log"] }],
    ["blank evidence", { status: "quarantined", sha, evidence: [" "] }],
  ])("rejects %s", (_reason, patch) => {
    expect(QuarantineSchema.safeParse([{ ...entry, ...patch }]).success).toBe(false);
  });

  it("rejects duplicate file/title paths while keeping distinct arrays and files distinct", () => {
    expect(QuarantineSchema.safeParse([entry, { ...entry, area: "another area" }]).success).toBe(
      false,
    );
    expect(
      QuarantineSchema.parse([
        { ...entry, name: ["A > B", "C"] },
        { ...entry, name: ["A", "B > C"] },
        { ...entry, file: "another.test.ts", name: ["A", "B > C"] },
      ]),
    ).toHaveLength(3);
  });

  it("validates historical records without consulting the clock or requiring the file to exist", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("register validation must not read the clock");
    });
    expect(
      QuarantineSchema.parse([
        { ...entry, firstSeen: "2000-02-29T00:00:00Z", deadline: "2000-03-07T00:00:00Z" },
      ]),
    ).toHaveLength(1);
  });

  it("parses the checked-in register so malformed edits fail the candidate gate", () => {
    const records: unknown = JSON.parse(
      readFileSync(new URL("./quarantine.json", import.meta.url), "utf8"),
    );
    expect(() => activeQuarantines(QuarantineSchema.parse(records))).not.toThrow();
  });
});

it.each(["unit", "integration"])(
  "skips exact quarantines before hooks in the %s runner and accounts for fully quarantined files",
  (lane) => {
    const repository = path.resolve(import.meta.dirname, "..");
    const root = mkdtempSync(path.join(tmpdir(), "opensteer-quarantine-"));
    const quote = JSON.stringify;
    const now = Date.now();
    const record = {
      ...entry,
      status: "quarantined",
      sha,
      evidence: ["reproduced failure and same-SHA pass"],
      firstSeen: new Date(now - 1_000).toISOString(),
      deadline: new Date(now + 60_000).toISOString(),
    };
    try {
      symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
      mkdirSync(path.join(root, "tests"));
      writeFileSync(
        path.join(root, "tests/quarantine.json"),
        JSON.stringify([
          { ...record, file: "cases.test.ts", name: ["suite", "case"] },
          { ...record, file: "all.test.ts", name: ["all"] },
          { ...entry, file: "cases.test.ts", name: ["suite", "investigation"] },
        ]),
      );
      writeFileSync(
        path.join(root, "cases.test.ts"),
        `
import { beforeEach, describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
describe('suite', () => {
  beforeEach(() => { appendFileSync(${quote(path.join(root, "hooks"))}, 'hook\\n'); });
  it('case', () => { throw Error('QUARANTINE_BODY_RAN'); });
  describe('nested', () => { it('case', () => {}); });
  it('investigation', () => {});
});
`,
      );
      writeFileSync(
        path.join(root, "other.test.ts"),
        `import { describe, it } from 'vitest'; describe('suite', () => { it('case', () => {}); });`,
      );
      writeFileSync(
        path.join(root, "all.test.ts"),
        `import { beforeAll, it } from 'vitest'; beforeAll(() => { throw Error('QUARANTINE_HOOK_RAN'); }); it('all', () => { throw Error('QUARANTINE_BODY_RAN'); });`,
      );
      const base = path.join(
        repository,
        lane === "unit" ? "vitest.config.ts" : "vitest.integration.config.ts",
      );
      const runner = path.join(
        repository,
        lane === "unit"
          ? "scripts/quarantine-runner.ts"
          : "scripts/integration-quarantine-runner.ts",
      );
      const config = path.join(root, "vitest.config.mts");
      writeFileSync(
        config,
        `import base from ${quote(base)};
export default { ...base, root: ${quote(root)}, cacheDir: ${quote(path.join(root, "cache"))}, test: { ...base.test, globalSetup: [], setupFiles: [], include: ['*.test.ts'], exclude: [], maxWorkers: 1, runner: ${quote(runner)}, reporters: ['default', 'json', ${quote(path.join(repository, "scripts/ci-inventory-reporter.ts"))}], outputFile: { json: ${quote(path.join(root, "results.json"))} } } };`,
      );
      const trace = path.join(root, "trace.jsonl");
      writeFileSync(trace, "");
      const discovery = path.join(root, "discovery.json");
      writeFileSync(
        discovery,
        JSON.stringify(
          ["cases.test.ts", "other.test.ts", "all.test.ts"].map((file) => ({
            file: path.join(root, file),
          })),
        ),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            OPENSTEER_LOCK_ORDER_TRACE: trace,
            CI_DISCOVERY_PATH: discovery,
            CI_INVENTORY_PATH: path.join(root, "inventory.json"),
            CI_LANE: lane,
            CI_SHARD: "1",
            CI_SHARDS: "1",
          },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("[quarantined] cases.test.ts");
      expect(output).toContain("owner: browser owner; deadline:");
      expect(output).not.toMatch(/QUARANTINE_(BODY|HOOK)_RAN/);
      const report = z
        .object({ numPassedTests: z.number(), numPendingTests: z.number() })
        .parse(JSON.parse(readFileSync(path.join(root, "results.json"), "utf8")));
      expect(report).toEqual({ numPassedTests: 3, numPendingTests: 2 });
      expect(readFileSync(path.join(root, "hooks"), "utf8")).toBe("hook\nhook\n");
      const inventory = z
        .object({ executed: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(path.join(root, "inventory.json"), "utf8")));
      expect(inventory.executed).toEqual(["all.test.ts", "cases.test.ts", "other.test.ts"]);
      if (lane === "integration")
        expect(readFileSync(trace, "utf8")).toContain('"type":"file-end"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
