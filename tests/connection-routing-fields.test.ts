import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * Route selection is one decision in one function. These three fields are how
 * a Deployment connection says where it can be reached; reading any of them
 * anywhere else is how the desktop grew four disagreeing answers to the same
 * question. Only the resolver and the store that persists them may — and both
 * now live in `@opensteer/client`, which every Opensteer client resolves
 * through, so the rule follows them there.
 */
const allowedFiles = new Set([
  // The one place an arm becomes an origin, an access kind, and a fence key.
  "packages/client/src/connections/connection-resolver.ts",
  // The schema that declares and persists these fields in the first place.
  "packages/client/src/connections/deployment-catalog.ts",
  // Constructs catalog connection inputs from verified Account directory
  // entries, so it writes all three before any connection exists to read.
  "packages/client/src/connections/account-deployment-directory.ts",
  // Reads `AccountDeploymentDirectoryEntry.reachability` — the control-plane
  // homonym, which is a different field on a different type.
  "apps/desktop/src/account/personal-directory-projection.ts",
]);

/**
 * A property read (dot or bracket), a destructured name, or an object/schema
 * key, never the words in a comment: the point is to pin where the decision
 * is taken, not to police prose.
 */
const routingFields =
  /(?:\.(?:personalAccessRoute|preferredEndpointOrigin|reachability)\b)|(?:\[\s*["'](?:personalAccessRoute|preferredEndpointOrigin|reachability)["']\s*\])|(?:\b(?:personalAccessRoute|preferredEndpointOrigin|reachability)\s*:)|(?:\{[^}\n]*\b(?:personalAccessRoute|preferredEndpointOrigin|reachability)\b[^}\n]*\}\s*=)/u;

describe("connection routing fields", () => {
  it("keeps route selection in the resolver and the catalog store", () => {
    const offenders = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "apps/desktop/src",
        "packages/client/src",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => existsSync(path.join(repositoryRoot, file)))
      .filter((file) => routingFields.test(readFileSync(path.join(repositoryRoot, file), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("still recognizes a read it is meant to catch", () => {
    expect(routingFields.test('if (connection.reachability === "routed") return null;')).toBe(true);
    expect(routingFields.test("const route = connection.personalAccessRoute;")).toBe(true);
    expect(routingFields.test("preferredEndpointOrigin: null,")).toBe(true);
    expect(routingFields.test("// remote reachability is what the tunnel provides")).toBe(false);
  });
});
