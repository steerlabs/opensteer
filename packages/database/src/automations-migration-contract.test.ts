import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationProvider } from "./migrations.js";

describe("Automations migration contract (AA13 / AB5)", () => {
  it("collapses all automations schema changes into a single 0113_automations_contract migration", async () => {
    const names = Object.keys(await migrationProvider().getMigrations());
    expect(names.filter((name) => name.includes("automation"))).toEqual([
      "0113_automations_contract",
    ]);
  });

  it("enforces sent-firing outcome invariants via PostgreSQL CHECK and deletes the pretence helper (AB5)", () => {
    const migrationSource = readFileSync(
      fileURLToPath(new URL("./automation-scripts-migration.ts", import.meta.url)),
      "utf8",
    );
    expect(migrationSource).toContain("trigger_occurrences_sent_evidence_check");
    expect(migrationSource).toContain("runner_reported_at");
    expect(migrationSource).toContain("proven_not_started_at");
    expect(
      existsSync(fileURLToPath(new URL("./trigger-occurrence-state.ts", import.meta.url))),
    ).toBe(false);
    expect(
      existsSync(
        fileURLToPath(new URL("./trigger-occurrence-state-writers.test.ts", import.meta.url)),
      ),
    ).toBe(false);
  });

  it("cancels pending firings of legacy automations paused by 0113 (AB7)", () => {
    const migrationSource = readFileSync(
      fileURLToPath(new URL("./automation-scripts-migration.ts", import.meta.url)),
      "utf8",
    );
    expect(migrationSource).toContain("canceled_legacy_upgrade");
    expect(migrationSource).toMatch(/update trigger_occurrences[\s\S]*status = 'canceled'/u);
  });

  it("cleans triggers.name via the single TypeScript outsideName helper with no SQL copy (N2)", () => {
    const migrationSource = readFileSync(
      fileURLToPath(new URL("./automation-scripts-migration.ts", import.meta.url)),
      "utf8",
    );
    expect(migrationSource).toContain('from "@opensteer/shared/outsideName"');
    expect(migrationSource).not.toContain("pg_temp.outside_name");
    expect(migrationSource).not.toContain("create function");
  });
});
