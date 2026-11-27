import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { journeyShard, journeysRunElsewhere, webJourneys } from "./journeys.js";

const scripts = import.meta.dirname;
const files = readdirSync(scripts)
  .filter((file) => file.endsWith("-journey.ts"))
  .map((file) => file.slice(0, -"-journey.ts".length))
  // The helper every journey opens the mock web with, not a journey itself.
  .filter((name) => name !== "mock-web");
const packageScripts = (
  JSON.parse(readFileSync(path.join(scripts, "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
const listed = webJourneys.map((journey) => journey.name);

describe("web journeys", () => {
  test("every journey file is run, or says where it runs instead", () => {
    const unlisted = files.filter((name) => !listed.includes(name) && !journeysRunElsewhere[name]);
    expect(unlisted).toEqual([]);
    expect(listed.filter((name) => journeysRunElsewhere[name])).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("every listed journey exists and has its own package script", () => {
    for (const name of [...listed, ...Object.keys(journeysRunElsewhere)])
      expect(files, name).toContain(name);
    for (const name of listed)
      expect(packageScripts[`test:${name}`], name).toBe(`tsx scripts/${name}-journey.ts`);
    expect(packageScripts["test:journeys"]).toBe("tsx scripts/run-journeys.ts");
  });

  test("the shards hold every journey once", () => {
    for (const count of [1, 2, 3, 4]) {
      const shards = Array.from({ length: count }, (_, index) =>
        journeyShard(webJourneys, index + 1, count).map((journey) => journey.name),
      );
      expect(shards.flat().sort()).toEqual([...listed].sort());
    }
    expect(() => journeyShard(webJourneys, 3, 2)).toThrow();
  });
});
