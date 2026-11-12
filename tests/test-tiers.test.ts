import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { darwinOnlyTests, realBrowserTests } from "../.github/scripts/ci-test-files.mjs";
import config from "../vitest.config.js";
import browserConfig from "../vitest.browser.config.js";
import integrationConfig from "../vitest.integration.config.js";
import guiConfig from "../vitest.gui.config.js";
import enginesConfig from "../vitest.engines.config.js";
import deviceConfig from "../vitest.device.config.js";
import soakConfig from "../vitest.soak.config.js";
import iphoneAppsVmConfig from "../apps/mobile/modules/iphone-apps/journey/vitest.config.js";

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
  { name: "browser", directory: root, config: browserConfig },
  { name: "integration", directory: root, config: integrationConfig },
  { name: "gui", directory: root, config: guiConfig },
  { name: "engines", directory: root, config: enginesConfig },
  { name: "device", directory: root, config: deviceConfig },
  { name: "soak", directory: root, config: soakConfig },
  { name: "iphone-apps-vm", directory: root, config: iphoneAppsVmConfig },
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

const databaseUrl = /process\.env\.OPENSTEER_(?:CONTROL_PLANE_)?TEST_DATABASE_(?:URL|TEMPLATES)/u;

function databaseGated(file: string, visited: Set<string>): boolean {
  if (visited.has(file) || !existsSync(file)) return false;
  visited.add(file);
  const text = readFileSync(file, "utf8");
  if (databaseUrl.test(text)) return true;
  const supports = [
    ...[...text.matchAll(/(?:from\s+|import\(\s*)["'](\.[^"']*test-support)\.js["']/gu)].map(
      (match) => resolve(dirname(file), `${match[1]}.ts`),
    ),
    ...[
      ...text.matchAll(
        /(?:from\s+|import\(\s*)["']@opensteer\/([^/"']+)(\/test-support\/[^"']+)["']/gu,
      ),
    ].map(([, name, subpath]) => {
      const directory = resolve(root, "packages", name!);
      const manifest = resolve(directory, "package.json");
      const exports: Record<string, string> = existsSync(manifest)
        ? (JSON.parse(readFileSync(manifest, "utf8")).exports ?? {})
        : {};
      const target = exports[`.${subpath}`];
      return target ? resolve(directory, target) : "";
    }),
  ];
  return supports.some((support) => databaseGated(support, visited));
}

// These policies fail closed for new PostgreSQL journeys, real AppKit fixture
// launches in the host tier, and accidental changes to default discovery.
describe("test tiers", () => {
  it("assigns every test file to exactly one qualification suite", () => {
    const ambiguous = files.flatMap((file) => {
      const owners = suites.filter((suite) => {
        const path = relative(suite.directory, resolve(root, file));
        const include = suite.config.test?.include ?? configDefaults.include;
        // The unit suite owns darwin-only files everywhere; off Darwin, native-mac runs them.
        const exclude = (suite.config.test?.exclude ?? configDefaults.exclude).filter(
          (pattern) => !darwinOnlyTests.includes(pattern),
        );
        return (
          include.some(
            (pattern) => pattern === path || (pattern.includes("*") && matchesGlob(path, pattern)),
          ) &&
          !exclude.some(
            (pattern) => pattern === path || (pattern.includes("*") && matchesGlob(path, pattern)),
          )
        );
      });
      return owners.length === 1 ? [] : [{ file, owners: owners.map((suite) => suite.name) }];
    });
    expect(ambiguous).toEqual([]);
  });

  it("reserves the integration suffix for database-gated journeys", () => {
    const ungated = files.filter((file) => {
      if (!/\.integration\.test\.tsx?$/u.test(file)) return false;
      return !databaseGated(resolve(root, file), new Set());
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
    expect(config.test?.exclude).toContain("**/*.vm.test.*");
  });
});

it("assigns exactly the listed real-browser files to their bounded config", () => {
  expect(new Set(realBrowserTests).size).toBe(realBrowserTests.length);
  expect(realBrowserTests.every((file) => files.includes(file))).toBe(true);
  expect(browserConfig.test?.include).toEqual(realBrowserTests);
  expect(config.test?.exclude).toEqual(expect.arrayContaining(realBrowserTests));
  expect(config.test?.testTimeout).toBeUndefined();
  expect(browserConfig.test).toMatchObject({
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    retry: 0,
  });
});
