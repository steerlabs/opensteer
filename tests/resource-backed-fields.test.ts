import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resourceBackedFields } from "../packages/client/src/host/client.js";

/*
 * Every HostSnapshot field a resource detail fills is listed, so reading it watches its kinds; and
 * nothing in the apps watches a snapshot-backed kind by hand beside that.
 */

const root = path.resolve(import.meta.dirname, "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

it("lists every HostSnapshot field a resource detail fills", () => {
  const client = source("packages/client/src/host/host-session-client.ts");
  const start = client.indexOf("  #applyResource(");
  const body = client.slice(start, client.indexOf("\n  }\n", start));
  const updates = [...body.matchAll(/this\.#update\(\{([\s\S]*?)\n {8}\}\);/gu)].map(
    ([, fields]) => fields!,
  );
  const written = new Set(
    updates.flatMap((fields) =>
      [...fields.matchAll(/^ {10}([a-zA-Z]+):/gmu)].map(([, field]) => field!),
    ),
  );
  // The tab store is filled in place rather than replaced.
  if (body.includes("this.#tabs.replaceCurrent")) written.add("tabs");
  expect(written.size).toBeGreaterThan(10);
  expect([...written].filter((field) => !(field in resourceBackedFields))).toEqual([]);
});

it("leaves no hand-written watch on a snapshot-backed kind anywhere in the apps", () => {
  const backed = new Set<string>(Object.values(resourceBackedFields).flat());
  const hits = execFileSync(
    "git",
    ["grep", "-n", "-E", "watchPersonalResource\\(", "--", "apps", "packages/client/src"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(
      (line) => line && !/\.test\.|\/mock\/|host-session-client\.ts|\/client\.ts:/u.test(line),
    );
  const named = hits.flatMap((line) =>
    [...line.matchAll(/"([a-z-]+)"/gu)].map(([, kind]) => kind!).filter((kind) => backed.has(kind)),
  );
  expect(named).toEqual([]);
});
