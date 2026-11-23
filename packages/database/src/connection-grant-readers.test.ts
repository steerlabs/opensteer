import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A connection's grant is read for its standing in one statement only
 * (`readConnectionStanding` in resource-access.ts). Any other query that reads `grant` from `agentConnections` is listed here with why it may;
 * a new one fails until it goes through that statement or says why it need not.
 */
const allowed: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  "packages/database/src/resource-access.ts": {
    count: 1,
    reason: "The one statement itself (readConnectionStanding).",
  },
  "packages/database/src/agent-connection-store.ts": {
    count: 2,
    reason:
      "The person's list of connections and the row an edit locks and rewrites: drawn for the person and written, never an admission.",
  },
};

it("reads a connection's grant for its standing in one statement only", () => {
  const repository = path.resolve(import.meta.dirname, "../../..");
  const found = new Map<string, number>();
  for (const root of ["packages/database/src", "apps/host/src"])
    for (const file of sources(path.join(repository, root))) {
      const text = readFileSync(file, "utf8");
      let count = 0;
      for (const match of text.matchAll(/selectFrom\(\s*"agentConnections"\s*\)/gu)) {
        const rest = text.slice(match.index, match.index + 1500);
        const end = /\.execute(TakeFirst(OrThrow)?)?\(\)/u.exec(rest);
        const statement = end ? rest.slice(0, end.index + end[0].length) : rest;
        if (/"grant"|"agentConnections\.grant"|selectAll\(/u.test(statement)) count += 1;
      }
      if (count > 0) found.set(path.relative(repository, file), count);
    }
  const unexplained = [...found].filter(([file, count]) => allowed[file]?.count !== count);
  const stale = Object.keys(allowed).filter((file) => !found.has(file));
  expect({ unexplained, stale }).toEqual({ unexplained: [], stale: [] });
});

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.name.endsWith(".ts") && !/\.test\.|test-support/u.test(entry.name)) yield full;
  }
}
