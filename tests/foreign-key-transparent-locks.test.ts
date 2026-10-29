import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import { strongRowLockViolations } from "../packages/database/src/strong-row-locks.test-support.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

it("requires a deletion or referenced-key reason for strong production row locks", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages", "apps"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(
      (file) =>
        /^(?:packages|apps)\/[^/]+\/src\//u.test(file) &&
        /\.(?:[cm]?[jt]sx?|sql)$/u.test(file) &&
        !/(?:\.test\.|\.test-support\.|(?:^|\/)tests?\/|(?:^|\/)migrations(?:[./])|(?:^|\/)baseline-schema\.)/u.test(
          file,
        ) &&
        existsSync(path.join(repositoryRoot, file)),
    );
  const violations: string[] = [];
  for (const file of new Set(files)) {
    const source = readFileSync(path.join(repositoryRoot, file), "utf8");
    const lines = source.split("\n");
    for (const line of strongRowLockViolations(source, file.endsWith(".sql") ? "sql" : "source")) {
      violations.push(`${file}:${line}: ${lines[line - 1]!.trim()}`);
    }
  }
  expect(violations).toEqual([]);
});

it.each([
  ".forUpdate()",
  'query["forUpdate"]()',
  "query['forUpdate']()",
  "const { forUpdate: lock } = query; lock()",
  "const lock = query.forUpdate; lock.call(query)",
  "FOR UPDATE",
  "FOR\n\tUPDATE",
  "FOR /* row fence */ UPDATE",
  "FOR/* outer /* inner */ still outer */UPDATE",
  "FOR -- row fence\n UPDATE",
])("detects strong lock syntax: %s", (source) => {
  expect(
    strongRowLockViolations(source, /^(?:FOR|SELECT|--|\/\*)/u.test(source) ? "sql" : "source"),
  ).toHaveLength(1);
});

it.each([
  "// FOR UPDATE: Deletes this row.\nquery.forUpdate()",
  "-- FOR UPDATE: Deletes this row.\nSELECT * FROM users FOR UPDATE;",
  "/* FOR UPDATE: Deletes this row. */\nSELECT * FROM users FOR /* row */ UPDATE;",
  "// A forUpdate identifier in guidance is not a lock.",
  "/* FOR UPDATE is discussed here, not issued. */",
  "SELECT * FROM users FOR NO KEY UPDATE",
  "query.forNoKeyUpdate()",
])("accepts documented or weaker locks: %s", (source) => {
  expect(
    strongRowLockViolations(source, /^(?:FOR|SELECT|--|\/\*)/u.test(source) ? "sql" : "source"),
  ).toEqual([]);
});

it.each([
  "BEGIN PERFORM $$--$$; PERFORM id FROM users FOR UPDATE; END;",
  "BEGIN PERFORM $tag$--$tag$; PERFORM id FROM users FOR UPDATE; END;",
])("does not treat dollar-quoted comment markers as comments: %s", (source) => {
  expect(strongRowLockViolations(source, "sql")).toEqual([1]);
});

it.each([
  String.raw`sql.raw("SELECT * FROM users FOR\nUPDATE")`,
  String.raw`sql.raw("SELECT * FROM users FOR\x20UPDATE")`,
  String.raw`sql.raw("SELECT * FROM users FOR\u0020UPDATE")`,
  String.raw`sql.raw("SELECT * FROM users FOR\u{20}UPDATE")`,
])("decodes JavaScript SQL escapes without changing source line numbers: %s", (source) => {
  expect(strongRowLockViolations(source)).toEqual([1]);
});
