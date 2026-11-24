// V1, W5: a session is closed only by one of two writers. A pooled session is closed by the pool's
// writer, with evidence about its own target (`closeBrowserPoolSessions`, and inside the pool
// store `endBrowserPoolSessions`, whose entries require it by type); any other by
// `closeUnpooledBrowserSession`, whose own statement refuses a pooled session. The general
// transition's type excludes `closed`. Those are the guard; this test is the second net: every
// write of a session row, raw SQL included, and every call of those writers, is counted per file
// across the Host and the database package. A new one fails here until it is read and counted.
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

/** Per file, how often each pattern occurs in the non-test sources of both packages. */
function counts(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const directory of ["apps/host/src", "packages/database/src"])
    for (const path of sources(join(root, directory))) {
      const matches = readFileSync(path, "utf8").match(pattern)?.length ?? 0;
      if (matches) found[relative(root, path)] = matches;
    }
  return found;
}

it("counts every write of a session row, raw SQL included, file by file", () => {
  expect(counts(/updateTable\(\s*"browserSessions"\s*\)/gu)).toEqual({
    // endBrowserPoolSessions: the pool's own closed and failed writes.
    "packages/database/src/browser-pool-store.ts": 1,
    // writeBrowserSessionState (the general transition and the unpooled close) and the sweep
    // that fails active sessions at start.
    "packages/database/src/browser-session-store.ts": 2,
    // Standard CDP attempt bookkeeping: never a state.
    "packages/database/src/browser-standard-cdp-lease.ts": 2,
    // Disconnect: tab revisions and attempts, never a state.
    "packages/database/src/connection-disconnect.ts": 5,
    // A revoked Runner's sessions fail; its tab revision.
    "packages/database/src/runner-store.ts": 2,
  });
  expect(counts(/update\s+browser_sessions\b/giu)).toEqual({
    // Standard CDP attempts on disconnect, never a state.
    "packages/database/src/connection-disconnect.ts": 1,
  });
});

it("counts every call of the writers that may close a session, file by file", () => {
  // The general transition: its type excludes `closed`.
  expect(counts(/\btransitionBrowserSession\(/gu)).toEqual({
    "apps/host/src/browser/browser-service.ts": 15,
    // A Stop's `closing` in stopBrowserPoolSession.
    "packages/database/src/browser-pool-store.ts": 1,
    "packages/database/src/browser-session-store.ts": 1,
    "packages/database/src/store.ts": 2,
  });
  // The unpooled close: only BrowserService's #transitionBrowserSession calls it.
  expect(counts(/\bcloseUnpooledBrowserSession\(/gu)).toEqual({
    "apps/host/src/browser/browser-service.ts": 2,
    "packages/database/src/browser-session-store.ts": 1,
    "packages/database/src/store.ts": 2,
  });
  // The pooled close, with evidence about its target: one caller in the Host.
  expect(counts(/\bcloseBrowserPoolSessions\(/gu)).toEqual({
    "apps/host/src/browser/browser-service.ts": 1,
    "packages/database/src/browser-pool-store.ts": 1,
  });
  // Inside the pool store only.
  expect(counts(/\bendBrowserPoolSessions\(/gu)).toEqual({
    "packages/database/src/browser-pool-store.ts": 6,
  });
});

it("lets no general transition write closed, and no pooled close forget its target", () => {
  const sessions = readFileSync(
    join(root, "packages/database/src/browser-session-store.ts"),
    "utf8",
  );
  expect(sessions).toContain('readonly state: Exclude<HostedBrowserSessionState, "closed">;');
  // The unpooled close refuses a pooled session in its own statement.
  expect(sessions).toMatch(/not exists \(\s*select 1 from browser_pool_sessions own/u);
  const pool = readFileSync(join(root, "packages/database/src/browser-pool-store.ts"), "utf8");
  // Every closed end there names its evidence and its target; the update checks the target.
  const ends = [...pool.matchAll(/state: "closed"(?! as const|;)/gu)].map(({ index }) =>
    pool.slice(index, index + 160),
  );
  expect(ends.length).toBeGreaterThan(0);
  for (const end of ends) expect(end).toMatch(/evidence[\s\S]*target/u);
  expect(pool).toContain(
    'if (end.end.state === "closed") update = update.where(ownedBy(end.end.target));',
  );
});
