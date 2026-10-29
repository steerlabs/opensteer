import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import config from "../vitest.config.js";
import integrationConfig from "../vitest.integration.config.js";
import guiConfig from "../vitest.gui.config.js";
import enginesConfig from "../vitest.engines.config.js";
import deviceConfig from "../vitest.device.config.js";
import soakConfig from "../vitest.soak.config.js";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter((file) => /\.test\.tsx?$/u.test(file) && existsSync(resolve(root, file)));
const source = (file: string) => readFileSync(resolve(root, file), "utf8");
const suites = [
  { name: "unit", directory: root, config },
  { name: "integration", directory: root, config: integrationConfig },
  { name: "gui", directory: root, config: guiConfig },
  { name: "engines", directory: root, config: enginesConfig },
  { name: "device", directory: root, config: deviceConfig },
  { name: "soak", directory: root, config: soakConfig },
];
const browserConfigPath = resolve(root, "apps/browser-runtime/vitest.config.ts");
if (existsSync(browserConfigPath)) {
  const { default: browserConfig }: { default: typeof config } = await import(browserConfigPath);
  suites.push({
    name: "browser-runtime",
    directory: dirname(browserConfigPath),
    config: browserConfig,
  });
}

const databaseUrl = /process\.env\.OPENSTEER_(?:CONTROL_PLANE_)?TEST_DATABASE_URL/u;

// These policies fail closed for new PostgreSQL journeys, real AppKit fixture
// launches in the host tier, and accidental changes to default discovery.
describe("test tiers", () => {
  it("assigns every test file to exactly one qualification suite", () => {
    const ambiguous = files.flatMap((file) => {
      const owners = suites.filter((suite) => {
        const path = relative(suite.directory, resolve(root, file));
        const include = suite.config.test?.include ?? configDefaults.include;
        const exclude = suite.config.test?.exclude ?? configDefaults.exclude;
        return (
          include.some((pattern) => matchesGlob(path, pattern)) &&
          !exclude.some((pattern) => matchesGlob(path, pattern))
        );
      });
      return owners.length === 1 ? [] : [{ file, owners: owners.map((suite) => suite.name) }];
    });
    expect(ambiguous).toEqual([]);
  });

  it("reserves the integration suffix for database-gated journeys", () => {
    const ungated = files.filter((file) => {
      if (!/\.integration\.test\.tsx?$/u.test(file)) return false;
      const text = source(file);
      if (databaseUrl.test(text)) return false;
      const supportImports = [...text.matchAll(/from ["'](\.[^"']*test-support)\.js["']/gu)];
      return !supportImports.some((match) => {
        const support = resolve(root, dirname(file), `${match[1]}.ts`);
        return existsSync(support) && databaseUrl.test(readFileSync(support, "utf8"));
      });
    });
    expect(ungated).toEqual([]);
  });

  it("keeps real AppKit fixture launches out of non-GUI files", () => {
    const unsafe = files.filter((file) => {
      if (/\.gui\.test\.tsx?$/u.test(file)) return false;
      const text = source(file);
      return (
        /OverlayVisibility(?:Fixture|\.swift)/u.test(text) &&
        /["'](?:\/usr\/bin\/)?swiftc["']/u.test(text) &&
        /["']\/usr\/bin\/open["']/u.test(text)
      );
    });
    expect(unsafe).toEqual([]);
  });

  it("excludes PostgreSQL and GUI suffixes from the host tier", () => {
    expect(config.test?.exclude).toContain("**/*.integration.test.*");
    expect(config.test?.exclude).toContain("**/*.gui.test.*");
  });
});
