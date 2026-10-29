import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { QuarantineSchema } from "../scripts/quarantine.js";

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
    expect(() => QuarantineSchema.parse(records)).not.toThrow();
  });
});
