// The iphone native-mac task runs only when its inputs change, so every file its
// TypeScript tests read or launch must be one of them. Ways this guard could fail,
// each pinned below:
// - the tracer misses a read: sync, callback or promise API, a URL or Buffer path,
//   an ESM named import bound before the tracer loaded, a directory listing, or a
//   read in a process the test started;
// - the tracer records Vitest's own main process, whose discovery lists the whole
//   checkout, or records anything when no trace was asked for;
// - the tracer breaks the code it observes, or traces its own trace writes;
// - the checker passes vacuously on a missing or empty trace, or on malformed lines;
// - the checker counts a file as covered across a name boundary (computer-use-x is
//   not under computer-use), misses a symlinked path, or flags what no input can
//   name: node_modules, files outside the checkout, untracked build output;
// - a directory a test lists counts as covered because one file in it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAccessTrace, parseAccessTrace, uncoveredAccesses } from "./ci-native-access.mjs";

const root = resolve(import.meta.dirname, "../..");
const tracked = new Set([
  "packages/apple-data/Package.swift",
  "apps/web/package.json",
  "scripts/x.ts",
]);
const inputs = ["packages/apple-data", "apps/desktop/native/computer-use", "scripts/x.ts"];
const read = (path, kind = "read") => ({ kind, path: join(root, path), cwd: root });

test("a tracked file outside the task's inputs is reported; covered ones are not", () => {
  assert.deepEqual(
    uncoveredAccesses([read("apps/web/package.json"), read("packages/apple-data/Package.swift")], {
      root,
      tracked,
      inputs,
    }),
    ["read apps/web/package.json"],
  );
});

test("coverage respects path-segment boundaries", () => {
  const near = new Set(["apps/desktop/native/computer-use-x/a.swift"]);
  assert.deepEqual(
    uncoveredAccesses([read("apps/desktop/native/computer-use-x/a.swift")], {
      root,
      tracked: near,
      inputs,
    }),
    ["read apps/desktop/native/computer-use-x/a.swift"],
  );
});

test("a directory listing is covered only from inside an input", () => {
  assert.deepEqual(
    uncoveredAccesses([read("packages/apple-data", "list"), read("packages", "list")], {
      root,
      tracked,
      inputs,
    }),
    ["list packages"],
  );
});

test("launched repository files count, including words of a shell command", () => {
  assert.deepEqual(
    uncoveredAccesses(
      [
        { kind: "exec", path: "apps/web/package.json", cwd: root },
        { kind: "exec", path: "scripts/x.ts", cwd: root },
        { kind: "shell", path: "node scripts/x.ts apps/web/package.json --flag", cwd: root },
      ],
      { root, tracked, inputs },
    ),
    ["exec apps/web/package.json", "shell apps/web/package.json"],
  );
});

test("node_modules, paths outside the checkout and untracked files are not inputs", () => {
  assert.deepEqual(
    uncoveredAccesses(
      [
        read("node_modules/vitest/package.json"),
        read("packages/apple-data/node_modules/x/index.js"),
        { kind: "read", path: join(tmpdir(), "anything"), cwd: root },
        read("apps/mobile/modules/iphone-apps/ios/.build/debug/IphoneAppsVectors"),
      ],
      { root, tracked, inputs },
    ),
    [],
  );
});

test("a symlink into the checkout is judged by its target", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-native-access-"));
  try {
    const link = join(directory, "manifest.json");
    symlinkSync(join(root, "apps/web/package.json"), link);
    assert.deepEqual(
      uncoveredAccesses([{ kind: "read", path: link, cwd: root }], { root, tracked, inputs }),
      ["read apps/web/package.json"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing, empty or malformed trace fails instead of passing", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-native-access-"));
  try {
    assert.throws(() => checkAccessTrace(join(directory, "missing.jsonl"), "iphone"), /ENOENT/u);
    writeFileSync(join(directory, "empty.jsonl"), "");
    assert.throws(() => parseAccessTrace(join(directory, "empty.jsonl")), /recorded no access/u);
    writeFileSync(join(directory, "bad.jsonl"), '{"kind":"read"}\n');
    assert.throws(() => parseAccessTrace(join(directory, "bad.jsonl")), /Malformed access/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs `source` as an ES module with the tracer preloaded, as the darwin step does. */
function traced(source, env) {
  const directory = mkdtempSync(join(tmpdir(), "ci-access-trace-"));
  const trace = join(directory, "trace.jsonl");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_ACCESS_TRACE: trace,
      NODE_OPTIONS: `--import ${join(root, ".github/scripts/ci-access-trace.mjs")}`,
      ...env,
    },
  });
  let lines = [];
  try {
    lines = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {}
  rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return lines.map(({ kind, path, cwd }) => {
    const absolute = resolve(cwd, path);
    return `${kind} ${absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute}`;
  });
}

test("the tracer records every read API, listings, launches and reads of child processes", () => {
  const recorded = traced(
    `
import { readFileSync, readFile, existsSync, readdirSync, createReadStream } from "node:fs";
import { readFile as readFilePromise, stat } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
readFileSync("package.json");
readFileSync(new URL("file://${root}/pnpm-workspace.yaml"));
existsSync(Buffer.from("AGENTS.md"));
readdirSync("docs");
await readFilePromise("vitest.config.ts");
await stat("tsconfig.base.json");
await new Promise((done) => readFile("README.md", done));
await new Promise((done) => createReadStream("LICENSE").on("close", done).resume());
execFileSync(process.execPath, ["--eval", "require('node:fs').readFileSync('.npmrc')"]);
spawnSync("sh", ["-c", "true"], { cwd: "docs" });
`,
    { VITEST: "true" },
  );
  for (const access of [
    "read package.json",
    "read pnpm-workspace.yaml",
    "read AGENTS.md",
    "list docs",
    "read vitest.config.ts",
    "read tsconfig.base.json",
    "read README.md",
    "read LICENSE",
    "read .npmrc",
    "exec docs/sh",
  ])
    assert.ok(recorded.includes(access), `${access} missing from ${JSON.stringify(recorded)}`);
  assert.ok(!recorded.some((line) => line.includes("trace.jsonl")), "traced its own writes");
});

test("the tracer stays silent in Vitest's main process and without a trace file", () => {
  assert.deepEqual(
    traced(`import { readFileSync } from "node:fs"; readFileSync("package.json");`, { VITEST: "" }),
    [],
  );
  assert.deepEqual(
    traced(`import { readFileSync } from "node:fs"; readFileSync("package.json");`, {
      VITEST: "true",
      CI_ACCESS_TRACE: "",
    }),
    [],
  );
});

test("end to end: a child process reading an unlisted file fails the iphone check", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-native-access-"));
  const trace = join(directory, "trace.jsonl");
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--eval",
        "require('node:child_process').execFileSync(process.execPath, ['--eval', \"require('node:fs').readFileSync('apps/web/package.json')\"])",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          VITEST: "true",
          CI_ACCESS_TRACE: trace,
          NODE_OPTIONS: `--import ${join(root, ".github/scripts/ci-access-trace.mjs")}`,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(checkAccessTrace(trace, "iphone").includes("read apps/web/package.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
