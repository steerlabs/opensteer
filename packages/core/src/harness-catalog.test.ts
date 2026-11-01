import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  harnessCatalog,
  harnessCatalogEntry,
  harnessRuntimeExpectedVersion,
  harnessRuntimeVersion,
  shippedHarnessKindRecord,
  shippedHarnessKinds,
} from "./harness-catalog.js";

describe("harness catalog", () => {
  it("stays free of runtime imports, so a packaging hook can read it without a bundler", () => {
    // apps/desktop/scripts/after-pack.cjs transpiles this one file and
    // evaluates it with no `require` in scope. A value import would only fail
    // there, during a real desktop build, so it is refused here instead.
    const source = readFileSync(new URL("./harness-catalog.ts", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\b/u.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/u);
  });

  it("separates the engines whose bytes a distribution ships from the one it does not", () => {
    // Cursor's CLI has no established redistribution grant, so the person
    // installs it: nothing here stages, version-asserts or names its bytes.
    expect(shippedHarnessKinds).toEqual(["codex", "opencode", "pi"]);
    expect(
      harnessCatalog
        .filter((entry) => entry.runtime.shape === "installed")
        .map((entry) => entry.kind),
    ).toEqual(["claude", "muse", "cursor"]);
    expect(shippedHarnessKindRecord((kind) => kind.length)).toEqual({
      codex: 5,
      opencode: 8,
      pi: 2,
    });
  });

  it("names the runtime shape each engine arrives in", () => {
    expect(harnessCatalogEntry("opencode")?.runtime).toEqual({
      expectedVersion: harnessRuntimeExpectedVersion("opencode"),
      npmPackage: "opencode-ai",
      path: "bin/opencode",
      shape: "file",
    });
    // Pi is published as JavaScript, so the distribution ships a tree the
    // Runner's own verified interpreter runs rather than a platform binary.
    expect(harnessCatalogEntry("pi")?.runtime).toEqual({
      expectedVersion: harnessRuntimeExpectedVersion("pi"),
      npmPackage: "@earendil-works/pi-coding-agent",
      path: "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      shape: "script",
      treeRoot: "pi",
    });
    expect(harnessCatalogEntry("cursor")?.runtime).toEqual({
      command: "agent",
      installUrl: "https://cursor.com/install",
      minimumVersion: "2026.09.10",
      shape: "installed",
    });
    expect(harnessCatalogEntry("muse")?.runtime).toEqual({
      command: "muse",
      installUrl: "https://dev.meta.ai/docs/muse-code",
      minimumVersion: "1.4.14",
      shape: "installed",
    });
  });

  it("keeps a staged tree's executable inside the directory that travels with it", () => {
    for (const entry of harnessCatalog) {
      if (entry.runtime.shape !== "tree" && entry.runtime.shape !== "script") continue;
      expect([entry.kind, entry.runtime.path.startsWith(`${entry.runtime.treeRoot}/`)]).toEqual([
        entry.kind,
        true,
      ]);
    }
  });

  it("derives each driver's pinned runtime version from the asserted --version output", () => {
    // The versions themselves move with every engine bump; what holds is that
    // each driver's protocol pin is the one semver inside its --version line.
    for (const kind of shippedHarnessKinds) {
      const version = harnessRuntimeVersion(kind);
      expect([kind, version]).toEqual([kind, expect.stringMatching(/^\d+\.\d+\.\d+$/u)]);
      expect(harnessRuntimeExpectedVersion(kind)).toContain(version);
    }
  });

  it.each(["cursor", "muse"] as const)(
    "refuses to state a version for the installed %s engine",
    (kind) => {
      expect(() => harnessRuntimeExpectedVersion(kind)).toThrow(
        `Harness ${kind} is installed by the person, so nothing pins its version`,
      );
      expect(() => harnessRuntimeVersion(kind)).toThrow(
        `Harness ${kind} is installed by the person, so nothing pins its version`,
      );
    },
  );
});
