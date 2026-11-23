import { describe, expect, it } from "vitest";
import { migrationProvider } from "./migrations.js";

describe("Automations migration contract (AA13)", () => {
  it("collapses all automations schema changes into a single 0055_automations_contract migration", async () => {
    const names = Object.keys(await migrationProvider().getMigrations());
    const after0054 = names.filter((name) => name > "0054_command_requests");
    expect(after0054).toEqual(["0055_automations_contract"]);
  });
});
