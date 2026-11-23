import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const allowedWriterFile = "packages/database/src/trigger-occurrence-state.ts";

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "dist-integration" ||
      entry.name === ".next" ||
      entry.name === "build"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx|mts|mjs)$/u.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx|mts|mjs)$/u.test(entry.name)) continue;
    if (entry.name.endsWith("-migration.ts") || entry.name === "baseline-schema.ts") continue;
    out.push(full);
  }
  return out;
}

function extractBalancedObject(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  return source.slice(openBraceIndex + 1);
}

/**
 * Finds any non-test production code that directly writes `status` on
 * `triggerOccurrences` / `trigger_occurrences` outside the single writer helper
 * `triggerOccurrenceStateColumns` (Z3 / AA3).
 */
function findDirectOccurrenceStateWrites(source: string): string[] {
  const hits: string[] = [];
  const kyselyHead =
    /\.(?:updateTable|insertInto)\(\s*["']triggerOccurrences["']\s*\)[\s\S]{0,200}?\.(?:set|values)\(\s*\{/gu;
  for (const match of source.matchAll(kyselyHead)) {
    const openBraceIndex = (match.index ?? 0) + match[0].length - 1;
    const body = extractBalancedObject(source, openBraceIndex);
    if (/(?:^|[,\s{])status\s*:/u.test(body)) {
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      hits.push(`line ${line}: direct Kysely status write on triggerOccurrences`);
    }
  }
  const rawUpdatePattern =
    /\bupdate\s+["']?trigger_occurrences["']?\s+set\b[\s\S]{0,400}?\bstatus\s*=/giu;
  for (const match of source.matchAll(rawUpdatePattern)) {
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    hits.push(`line ${line}: raw SQL UPDATE writing trigger_occurrences status`);
  }
  const rawInsertPattern =
    /\binsert\s+into\s+["']?trigger_occurrences["']?\s*\([^)]*\bstatus\b[^)]*\)/giu;
  for (const match of source.matchAll(rawInsertPattern)) {
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    hits.push(`line ${line}: raw SQL INSERT writing trigger_occurrences status`);
  }
  return hits;
}

describe("trigger_occurrences state single writer (Z3 / AA3)", () => {
  it("forbids any direct status write on trigger_occurrences outside triggerOccurrenceStateColumns", () => {
    const files = [
      ...collectSourceFiles(join(repoRoot, "packages")),
      ...collectSourceFiles(join(repoRoot, "apps")),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(repoRoot, file).replaceAll("\\", "/");
      if (rel === allowedWriterFile) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("triggerOccurrences") && !source.includes("trigger_occurrences")) {
        continue;
      }
      for (const hit of findDirectOccurrenceStateWrites(source)) {
        violations.push(`${rel}:${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
