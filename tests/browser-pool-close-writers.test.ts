// V1: a pooled row is closed only with its evidence. Inside the Host every state write goes
// through BrowserService's own #transitionBrowserSession, whose type asks a `closed` write for its
// evidence; the pool store closes rows only through endBrowserPoolSessions, whose type does too.
// This test keeps a new writer from going around both.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !/\.test\.|test-support/u.test(name) ? [path] : [];
  });
}

it("lets nothing in the Host write a session's state around the writer that asks for evidence", () => {
  const found: string[] = [];
  for (const path of sources(join(root, "apps/host/src"))) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/transitionBrowserSession\(/u.test(line)) return;
      const file = relative(root, path);
      const allowed =
        file === "apps/host/src/browser/browser-service.ts" &&
        (/this\.#transitionBrowserSession\(/u.test(line) ||
          /async #transitionBrowserSession\(/u.test(line) ||
          /this\.#repository\.transitionBrowserSession\(/u.test(line) ||
          /^\s*transitionBrowserSession\(input: \{/u.test(line));
      if (!allowed) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(found).toEqual([]);
});

it("closes a pooled row in the pool store only through the writer that takes its evidence", () => {
  const store = readFileSync(join(root, "packages/database/src/browser-pool-store.ts"), "utf8");
  // The one generic transition left writes a Stop's `closing`, never `closed`.
  const generic = [...store.matchAll(/await transitionBrowserSession\(tx, \{([^}]*)\}\);/gu)];
  expect(generic.map((match) => match[1]!.replace(/\s+/gu, " ").trim())).toEqual([
    'from: ["starting", "ready", "closing"], sessionId: input.sessionId, state,',
  ]);
  expect(store).toContain('const state = slot?.phase === "parked" ? ("closed" as const)');
  // Every other closed write names its evidence.
  const closed = [...store.matchAll(/state: "closed"(?!, evidence| as const|;)/gu)];
  expect(closed).toEqual([]);
});
