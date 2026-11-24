import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../..");

const guardedFiles = [
  "packages/database/src/trigger-store.ts",
  "apps/host/src/triggers/trigger-service.ts",
  "apps/host/src/triggers/trigger-routes.ts",
  "apps/host/src/mcp/handlers/triggers.ts",
] as const;

const forbiddenPredicates: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "triggerAccess", pattern: /\btriggerAccess\b/u },
  { name: "assertTriggerAccess", pattern: /\bassertTriggerAccess\b/u },
  { name: "lockTriggerAuthorityThreads", pattern: /\blockTriggerAuthorityThreads\b/u },
  { name: "readTriggerAuthorityThreads", pattern: /\breadTriggerAuthorityThreads\b/u },
  { name: "actorAccessMode", pattern: /\bactorAccessMode\b/u },
  { name: "threadAccessModeAtMost", pattern: /\bthreadAccessModeAtMost\b/u },
  { name: "#assertLineage", pattern: /#assertLineage\b/u },
  { name: "caller.accessMode", pattern: /\bcaller\.accessMode\b/u },
  {
    name: "standalone program replacement refusal",
    pattern: /cannot replace the program of an automation it did not create/u,
  },
];

describe("Track B authority guard (brief section 10)", () => {
  it("holds no standalone authority predicates in the automations store or tools", () => {
    const violations: string[] = [];
    for (const relative of guardedFiles) {
      const source = readFileSync(path.join(repository, relative), "utf8");
      for (const { name, pattern } of forbiddenPredicates) {
        if (pattern.test(source)) violations.push(`${relative}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("decides automation tool writes through dispatchCommand / admitCommand", () => {
    const handlerSource = readFileSync(
      path.join(repository, "apps/host/src/mcp/handlers/triggers.ts"),
      "utf8",
    );
    expect(handlerSource).toContain("dispatchCommand");
    expect(handlerSource).not.toMatch(/this\.triggers\.manage\(\s*caller\.userId,\s*operation/u);
  });
});
