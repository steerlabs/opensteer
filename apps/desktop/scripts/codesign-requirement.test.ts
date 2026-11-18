import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { codesignRequirementArguments } from "../src/signed-helpers/developer-id.js";

const require = createRequire(import.meta.url);
const { requirementOption } =
  require("./signing-input.cjs") as typeof import("./signing-input.cjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Mocked codesign cannot see how its argv is parsed; a release and a running app did.
it.skipIf(process.platform !== "darwin").each([
  [
    "release scripts",
    (binary: string, requirement: string) => [
      "--verify",
      "--strict",
      requirementOption(requirement),
      binary,
    ],
  ],
  [
    "app",
    (binary: string, requirement: string) => codesignRequirementArguments(binary, requirement),
  ],
])(
  "%s: passes a requirement to the real codesign as text, not a file path",
  (_caller, argumentsFor) => {
    const root = mkdtempSync(path.join(tmpdir(), "codesign-requirement-"));
    roots.push(root);
    const binary = path.join(root, "fixture");
    copyFileSync("/usr/bin/true", binary);
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "com.opensteer.requirement-fixture",
      binary,
    ]);
    const verify = (requirement: string) =>
      execFileSync("/usr/bin/codesign", argumentsFor(binary, requirement), { stdio: "pipe" });
    expect(() =>
      verify('identifier "com.opensteer.requirement-fixture" and !anchor apple generic'),
    ).not.toThrow();
    expect(() =>
      verify('identifier "com.opensteer.requirement-fixture" and anchor apple generic'),
    ).toThrow(/failed to satisfy/u);
  },
);
