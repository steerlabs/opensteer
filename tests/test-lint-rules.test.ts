import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import plugin, {
  assertBaselineShrinks,
  fingerprint,
} from "../tooling/oxlint-plugin-opensteer/index.mjs";

const cases = [
  [
    "no-unit-test-timeout",
    'import {test as baseIt} from "vitest"; const it = baseIt.extend({}); it("slow", () => {}, 10000);',
    false,
  ],
  [
    "no-unit-test-timeout",
    'import {test as check} from "vitest"; function f(check) {check("app API", () => {}, 10000);}',
    true,
  ],
  [
    "no-real-time-wait-in-tests",
    'beforeEach(() => vi.useRealTimers()); it("fake", async () => {vi.useFakeTimers(); await new Promise(r => setTimeout(r, 10));});',
    true,
  ],
  [
    "no-polling-loop-in-tests",
    'beforeEach(() => vi.useFakeTimers()); it("real", async () => {while (!ready) {vi.useRealTimers(); await new Promise(r => setTimeout(r, 10));}});',
    false,
  ],
  [
    "no-unit-test-timeout",
    'import * as vitest from "vitest"; vitest.test.each([1])("slow", () => {}, 10000);',
    false,
  ],
  [
    "no-unreasoned-skip-or-retry",
    'import {describe as suite} from "vitest"; suite.skip("broken", () => {});',
    false,
  ],
  [
    "no-unreasoned-skip-or-retry",
    'import {describe as suite} from "vitest"; suite("flaky", {retry: 1}, () => {});',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'it("deadline", async () => {let signal; const captured = new Promise((resolve, reject) => {signal = resolve; setTimeout(() => reject(new Error("deadline")), 100);}); await captured;});',
    true,
  ],
  [
    "no-unbounded-created-promise",
    'it("deadline", async () => {let signal; const captured = new Promise(resolve => {signal = resolve; const timer = setTimeout(resolve, 100);}); await captured;});',
    true,
  ],
  [
    "no-unbounded-created-promise",
    'it("shadow", async () => {let signal; const captured = new Promise(resolve => {signal = resolve; setTimeout((resolve) => resolve(), 100);}); await captured;});',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'it("unused", async () => {let signal; const captured = new Promise(resolve => {signal = resolve; const unused = () => setTimeout(resolve, 100);}); await captured;});',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'it("signal", async () => {let signal; const captured = new Promise(resolve => {signal = resolve; AbortSignal.timeout(100);}); await captured;});',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'import {test as check} from "vitest"; check("capture", async () => {let signal; const captured = new Promise(resolve => {signal = resolve;}); await captured;});',
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    'beforeEach(() => vi.useFakeTimers()); it("real", async () => {vi.useRealTimers(); await new Promise(r => setTimeout(r, 10));});',
    false,
  ],
  [
    "no-polling-loop-in-tests",
    'beforeEach(() => vi.useFakeTimers()); it("real", async () => {vi.useRealTimers(); while (!ready) {await new Promise(r => setTimeout(r, 10));}});',
    false,
  ],
  [
    "no-unit-test-timeout",
    'import {test as check} from "vitest"; check("slow", () => {}, 10000);',
    false,
  ],
  [
    "no-unreasoned-skip-or-retry",
    'import {test as check} from "vitest"; check("flaky", {retry: 1}, () => {});',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'it("capture", async () => {let signal; const captured = new Promise(resolve => {signal = resolve; setTimeout(() => log("waiting"), 100);}); await captured;});',
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    'import * as timers from "node:timers/promises"; await timers.setTimeout(10);',
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    'beforeEach(() => {vi.useFakeTimers()}); it("fake", async () => {await new Promise(r => setTimeout(r, 10));});',
    true,
  ],
  [
    "no-real-time-wait-in-tests",
    "vi.useFakeTimers(); vi.useRealTimers(); await new Promise(r => setTimeout(r, 10));",
    false,
  ],
  ["no-real-time-wait-in-tests", "await new Promise(r => setTimeout(r, 10));", false],
  [
    "no-real-time-wait-in-tests",
    'import {setTimeout as pause} from "node:timers/promises"; await pause(10);',
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    'import {scheduler as s} from "node:timers/promises"; await s.wait(10);',
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    "const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(10);",
    false,
  ],
  [
    "no-real-time-wait-in-tests",
    "vi.useFakeTimers(); await new Promise(r => setTimeout(r, 10));",
    true,
  ],
  [
    "no-real-time-wait-in-tests",
    "await vi.waitFor(() => expect(ready).toBe(true)); await vi.waitUntil(() => ready);",
    true,
  ],
  ["no-real-time-wait-in-tests", "const wait = () => actualEvent; await wait();", true],
  [
    "no-real-time-wait-in-tests",
    "function f(setTimeout) { return new Promise(r => setTimeout(r, 10)); }",
    true,
  ],
  [
    "no-polling-loop-in-tests",
    "while (!ready) { await new Promise(r => setTimeout(r, 10)); }",
    false,
  ],
  [
    "no-polling-loop-in-tests",
    'import {setTimeout as pause} from "node:timers/promises"; for (;;) { await pause(10); }',
    false,
  ],
  ["no-polling-loop-in-tests", "for (const event of events) { await handle(event); }", true],
  ["no-unreasoned-skip-or-retry", 'it.skip("broken", () => {});', false],
  [
    "no-unreasoned-skip-or-retry",
    'test.todo("unfinished"); describe.fails("known failure", () => {});',
    false,
  ],
  [
    "no-unreasoned-skip-or-retry",
    '// Requires macOS kernel locks.\nit.skip("platform", () => {});',
    true,
  ],
  [
    "no-unreasoned-skip-or-retry",
    'test.skipIf(!supported)("platform", () => {}); test.runIf(supported)("platform", () => {});',
    true,
  ],
  ["no-unreasoned-skip-or-retry", 'it("flaky", { retry: 1 }, () => {});', false],
  ["no-unreasoned-skip-or-retry", "const response = {retry: 1};", true],
  [
    "require-suppression-reason",
    '// oxlint-disable-next-line opensteer/no-unit-test-timeout\nit("x", () => {});',
    false,
  ],
  [
    "require-suppression-reason",
    '// oxlint-disable-next-line opensteer/no-unit-test-timeout -- Exercises a subprocess deadline.\nit("x", () => {});',
    true,
  ],
  ["no-unit-test-timeout", 'it("slow", () => {}, 10000);', false],
  ["no-unit-test-timeout", 'it("slow", {timeout: 10000}, () => {});', false],
  [
    "no-unit-test-timeout",
    'it("normal", () => {}); await vi.waitFor(() => ready, {timeout: 100});',
    true,
  ],
  [
    "no-unbounded-created-promise",
    'it("capture", async () => { let signal; const captured = new Promise(r => {signal = r}); listen(() => signal()); await captured; });',
    false,
  ],
  [
    "no-unbounded-created-promise",
    'it("capture", async () => { let signal; const captured = new Promise(r => {signal = r}); await withTimeout(captured, 100, options); });',
    true,
  ],
  [
    "no-unbounded-created-promise",
    'it("capture", async () => { const captured = new Promise(r => { setTimeout(r, 10); }); await captured; });',
    true,
  ],
  [
    "no-unbounded-created-promise",
    'it("gate", async () => { let signal; const gate = new Promise(r => {signal = r}); const worker = async () => {await gate}; signal(); await worker(); });',
    true,
  ],
] as const;

it("enforces test rules through the shipped oxlint parser and plugin loader", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-test-lint-"));
  try {
    const config = join(directory, ".oxlintrc.json");
    writeFileSync(
      config,
      JSON.stringify({
        jsPlugins: [
          { name: "opensteer", specifier: resolve("tooling/oxlint-plugin-opensteer/index.mjs") },
        ],
        rules: Object.fromEntries(
          Object.keys(plugin.rules).map((rule) => [`opensteer/${rule}`, "error"]),
        ),
      }),
    );
    const files = cases.map((entry, index) => {
      const file = join(directory, `case-${index}.test.ts`);
      writeFileSync(file, entry[1]);
      return file;
    });
    const integration = join(directory, "allowed.integration.test.ts");
    writeFileSync(integration, 'it("stack", () => {}, 120000);');
    const configs = [0, 1].map((retry) => {
      const file = join(directory, `vitest${retry}.config.ts`);
      writeFileSync(file, `export default {test: {retry: ${retry}}};`);
      return file;
    });
    const result = spawnSync(
      resolve("node_modules/.bin/oxlint"),
      ["--config", config, "--format", "json", ...files, integration, ...configs],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const diagnostics = JSON.parse(result.stdout).diagnostics as {
      filename: string;
      code: string;
    }[];
    cases.forEach(([rule, , valid], index) => {
      const found = diagnostics.some(
        (d) => d.filename === files[index] && d.code === `opensteer(${rule})`,
      );
      expect.soft(found, `case ${index}: ${rule}`).toBe(!valid);
    });
    expect(diagnostics.filter((d) => d.filename === integration)).toEqual([]);
    expect(diagnostics.some((d) => d.filename === configs[0])).toBe(false);
    expect(diagnostics.some((d) => d.filename === configs[1])).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keys baseline allowances by rule and exact source, with positive occurrence budgets", () => {
  expect(fingerprint("sleep", "await sleep(1)")).not.toBe(fingerprint("sleep", "await sleep(2)"));
  expect(fingerprint("sleep", "await sleep(1)")).not.toBe(fingerprint("poll", "await sleep(1)"));
  const baseline = JSON.parse(
    readFileSync(resolve("tooling/oxlint-plugin-opensteer/baseline.json"), "utf8"),
  ) as Record<string, Record<string, number>>;
  for (const entries of Object.values(baseline))
    for (const count of Object.values(entries)) {
      expect(Number.isSafeInteger(count) && count > 0).toBe(true);
    }
});

it("rejects baseline growth, replacement fingerprints and moved allowances", () => {
  const ceiling = { "a.test.ts": { "rule:hash": 2 } };
  expect(() => assertBaselineShrinks({ "a.test.ts": { "rule:hash": 1 } }, ceiling)).not.toThrow();
  expect(() => assertBaselineShrinks({}, ceiling)).not.toThrow();
  for (const changed of [
    { "a.test.ts": { "rule:hash": 3 } },
    { "b.test.ts": { "rule:hash": 1 } },
    { "a.test.ts": { "rule:new": 1 } },
    { "a.test.ts": { "rule:hash": 0 } },
  ])
    expect(() => assertBaselineShrinks(changed, ceiling)).toThrow("Baseline may only shrink");
});
