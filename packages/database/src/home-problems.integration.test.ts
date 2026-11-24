import { createId } from "@opensteer/core";
import { HomeHealthReportSchema } from "@opensteer/protocol/problems";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import {
  readProblemReportsSetting,
  readStoredProblems,
  setProblemReportsSetting,
} from "./home-problems.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("reads this Home's problems from the rows it keeps, as codes and counts only", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/tmp/problems-home");
    expect(await readStoredProblems(database)).toEqual([]);

    // An engine whose inspection failed, its reason private to the person's own screen.
    const harnessId = createId("harnessInstance");
    await sql`insert into harness_instances
      (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled,
       is_default, source_id)
      values (${harnessId}, ${personal.environmentId}, 'codex', 'Codex', '{}', 1, 'native', true,
       true, 'path')`.execute(database);
    await sql`insert into harness_catalogs (environment_id, harness_instance_id, catalog, captured_at)
      values (${personal.environmentId}, ${harnessId}, ${JSON.stringify({
        status: "error",
        driverKind: "codex",
        harnessInstanceId: harnessId,
        models: [],
        detail: "spawn /Users/alex/.local/bin/codex ENOENT",
      })}, '2026-11-24T08:00:00Z')`.execute(database);
    // Plugin sign-ins: one failed, one expired unfinished, one finished, one failed long ago.
    const attempt = (status: string, surface: string, created: string, expires: string) =>
      sql`insert into integration_auth_attempts
        (id, flow, owner_user_id, state_hash, launch_ticket_hash, encrypted_payload,
         encryption_key_version, status, surface, failure_reason, expires_at, created_at)
        values (${crypto.randomUUID()}, 'oauth', ${personal.userId},
         ${crypto.randomUUID()}, ${crypto.randomUUID()}, '\\x00', 1, ${status}, ${surface},
         'https://accounts.example.com/callback?code=PRIVATE', ${expires}, ${created})`.execute(
        database,
      );
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await attempt("failed", "web", hourAgo, new Date(Date.now() + 60_000).toISOString());
    await attempt("pending", "web", hourAgo, new Date(Date.now() - 60_000).toISOString());
    await attempt("completed", "web", hourAgo, new Date(Date.now() - 60_000).toISOString());
    await attempt("failed", "desktop", "2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z");
    // A desktop update that failed.
    await sql`insert into personal_desktop_update
      (id, requested_by, idempotency_key, intent, state, detail)
      values ('pdu_1', ${personal.userId}, 'k1', '{}', 'failed', 'ENOSPC /Applications')`.execute(
      database,
    );

    const problems = await readStoredProblems(database);
    expect(problems.toSorted((a, b) => a.code.localeCompare(b.code))).toEqual([
      expect.objectContaining({
        code: "engine.inspection_failed",
        count: 1,
        firstSeenAt: "2026-11-24T08:00:00Z",
        fields: { engine: "codex" },
      }),
      expect.objectContaining({ code: "sign_in.unfinished", count: 2, fields: { surface: "web" } }),
      expect.objectContaining({
        code: "update.failed",
        count: 1,
        fields: { updateTarget: "desktop", updateResult: "failed" },
      }),
    ]);
    // What it read is exactly what a report may carry: no detail, path or address of any row.
    expect(() =>
      HomeHealthReportSchema.parse({ schema: 1, home: "mac", version: "1.0.0", problems }),
    ).not.toThrow();
    const text = JSON.stringify(problems);
    for (const secret of ["ENOENT", "/Users/alex", "PRIVATE", "ENOSPC"])
      expect(text).not.toContain(secret);

    expect(await readProblemReportsSetting(database)).toBe("off");
    expect(await setProblemReportsSetting(database, "on")).toBe("on");
    expect(await readProblemReportsSetting(database)).toBe("on");
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
