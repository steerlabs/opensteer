import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TriggerRevisionViewSchema } from "./models.js";
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
  });
});
