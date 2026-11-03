import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TriggerProgramSchema,
  TriggerRevisionViewSchema,
  triggerProgramContract,
} from "./models.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Trigger program contract", () => {
  it("is present in the program reference and absent from tool metadata", () => {
    const content = readFileSync(
      resolve(
        repositoryRoot,
        "apps/runner/agent-skills/skills/opensteer-triggers/references/program-contract.md",
      ),
      "utf8",
    );
    expect(content).toContain(triggerProgramContract);
    expect(TriggerProgramSchema.description).toBeUndefined();
    expect(TriggerRevisionViewSchema.shape.program.description).toBeUndefined();
  });

  it("keeps the shipped watch example async-iterable and its proof rule watch-specific", () => {
    const content = readFileSync(
      resolve(
        repositoryRoot,
        "apps/runner/agent-skills/skills/opensteer-triggers/references/watches.md",
      ),
      "utf8",
    );
    expect(content).toContain(
      'import { readFile, rename, watch, writeFile } from "node:fs/promises";',
    );
    expect(content).not.toContain('import { watch } from "node:fs";');
    expect(content).toContain(
      "A watch works only when its activation is healthy and you observe its intended effect.",
    );
    const verification = readFileSync(
      resolve(
        repositoryRoot,
        "apps/runner/agent-skills/skills/opensteer-triggers/references/verification.md",
      ),
      "utf8",
    );
    expect(verification).toContain("An occurrence-based Trigger works only after");
  });
});
