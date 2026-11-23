import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as triggersExports from "./index.js";
import { TriggerRevisionViewSchema, TriggerSchema } from "./models.js";
import { AutomationScriptSchema } from "./script.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Automation skill and script guide", () => {
  it("leads with writing, testing, and registering an ordinary script with no contract boilerplate", () => {
    const skill = readFileSync(
      resolve(repositoryRoot, "apps/runner/agent-skills/skills/automations/SKILL.md"),
      "utf8",
    );
    const guide = readFileSync(
      resolve(repositoryRoot, "apps/runner/agent-skills/skills/automations/references/scripts.md"),
      "utf8",
    );
    expect(skill).toContain("Write a normal file in Agent home");
    expect(skill).toContain("run it in your shell to test it like any file");
    expect(skill).toContain("To change it, edit the file, test it, and register the updated text");
    expect(skill).not.toContain("wrapper");
    expect(guide).toContain("OPENSTEER_EVENT");
    expect(guide).toContain("OPENSTEER_SECRET_");
    expect(skill).not.toContain("toolContractVersion");
    expect(guide).not.toContain("toolContractVersion");
    expect(guide).not.toContain("120");
    expect(guide).not.toContain("integrationMcp");
    expect(guide).not.toContain("opensteer.integrations");
    expect(AutomationScriptSchema.description).toBeUndefined();
    expect(TriggerRevisionViewSchema.shape.script.description).toBeUndefined();
  });

  it("keeps the shipped watch example async-iterable and its proof rule watch-specific", () => {
    const content = readFileSync(
      resolve(repositoryRoot, "apps/runner/agent-skills/skills/automations/references/watches.md"),
      "utf8",
    );
    expect(content).toMatch(/import \{[^}]*\bwatch\b[^}]*\} from "node:fs\/promises";/);
    expect(content).not.toContain('import { watch } from "node:fs";');
    expect(content).not.toContain("export default");
    expect(content).toContain(
      "A watch works only when its activation is healthy and you observe its intended effect.",
    );
    const verification = readFileSync(
      resolve(
        repositoryRoot,
        "apps/runner/agent-skills/skills/automations/references/verification.md",
      ),
      "utf8",
    );
    expect(verification).toContain("An occurrence-based automation works only after");
    expect(content).not.toContain("observationId");
  });

  it("keeps tool descriptions and mock automations free of pre-overhaul contract claims (AA5)", () => {
    const tools = readFileSync(
      resolve(repositoryRoot, "packages/agent-tools/src/tools/triggers.ts"),
      "utf8",
    );
    expect(tools).not.toContain("Started work keeps running.");
    const mockAutomations = readFileSync(
      resolve(repositoryRoot, "packages/client/src/mock/mock-automations.ts"),
      "utf8",
    );
    expect(mockAutomations).not.toContain("observationId");
  });

  it("removes legacy v5 program schemas, auto-pause constants, and unused trigger consecutiveFailures (AA13)", () => {
    for (const removed of [
      "TRIGGER_AUTO_PAUSE_FAILURE_THRESHOLD",
      "TRIGGER_AUTO_PAUSE_REASON",
      "WATCH_AUTO_PAUSE_FAILURE_THRESHOLD",
      "WATCH_AUTO_PAUSE_REASON",
      "TRIGGER_PROGRAM_VERSION_REFUSAL",
      "StoredTriggerProgramSchema",
      "TriggerProgramSchema",
      "isExecutableTriggerProgram",
    ]) {
      expect(removed in triggersExports, removed).toBe(false);
    }
    expect("consecutiveFailures" in TriggerSchema.shape).toBe(false);
  });
});
