import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("passes no outside-name keys to workWords or agentWords in production sources", () => {
  const repository = path.resolve(import.meta.dirname, "..");
  const forbidden =
    /\b(?:workWords|agentWords)\([^)]*\{[^}]*(?:[{,]\s*)(?:agent|label|name|task)\s*(?::|[,}])/gu;
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name.startsWith(".")
      )
        continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (
        !/\.(?:ts|tsx)$/u.test(entry.name) ||
        /\.test\.|\.test-support\.|\.spec\./u.test(entry.name)
      )
        continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(forbidden)) {
        offenders.push(`${path.relative(repository, full)}: ${match[0]}`);
      }
    }
  };
  walk(path.join(repository, "packages"));
  walk(path.join(repository, "apps"));
  expect(offenders).toEqual([]);
});
