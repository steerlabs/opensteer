import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import {
  classify,
  laneOf,
  parseFailures,
  reachability,
  selects,
  sharding,
  unzipEntry,
} from "./ci-flake-ledger.mjs";

test("reads failing tests from Vitest, Go and Swift output as GitHub logs them", () => {
  const log = [
    "2026-11-14T03:40:02.5629289Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m apps/host/a.integration.test.ts\u001b[2m > \u001b[22msuite\u001b[2m > \u001b[22mkeeps it",
    // The summary repeats; a test is listed once.
    "2026-11-14T03:40:04.9808101Z  FAIL  apps/host/a.integration.test.ts > suite > keeps it",
    " FAIL  |unit| tests/b.test.ts [ tests/b.test.ts ]",
    " FAIL  packages/c.windows.test.ts > runs > on Windows",
    "    --- FAIL: TestDrain (0.20s)",
    "        --- FAIL: TestDrain/nested (0.10s)",
    "FAIL\tgithub.com/steerlabs/opensteer/supervisor\t1.234s",
    "Test Case '-[ComputerUseTests.BridgeTests testFences]' failed (0.012 seconds).",
    '✘ Test "decodes a frame" failed after 0.003 seconds with 1 issue.',
    " ✓ tests/passing.test.ts (3 tests) 12ms",
  ].join("\n");
  assert.deepEqual(parseFailures(log), [
    { kind: "vitest", file: "apps/host/a.integration.test.ts", name: ["suite", "keeps it"] },
    { kind: "vitest", file: "tests/b.test.ts", name: [] },
    { kind: "vitest", file: "packages/c.windows.test.ts", name: ["runs", "on Windows"] },
    { kind: "go", file: "github.com/steerlabs/opensteer/supervisor", name: ["TestDrain"] },
    { kind: "swift", file: "ComputerUseTests.BridgeTests", name: ["testFences"] },
    { kind: "swift", file: "swift", name: ["decodes a frame"] },
  ]);
  assert.deepEqual(parseFailures("All good\n ✓ tests/a.test.ts"), []);
});

test("names lanes as CI selects them; native-mac tasks are lanes of their own", () => {
  assert.deepEqual(laneOf("integration (3)"), { lane: "integration", base: "integration" });
  assert.deepEqual(laneOf("native-windows"), { lane: "native-windows", base: "native-windows" });
  assert.deepEqual(laneOf("native-mac (iphone)"), {
    lane: "native-mac (iphone)",
    base: "native-mac",
    task: "iphone",
  });
});

test("unit and integration lanes run their planned files; other lanes run all of theirs", () => {
  const unit = { kind: "vitest", file: "a.test.ts", job: "tests (1)" };
  assert.ok(selects({ whole: { tests: true }, files: { tests: [] } }, unit));
  assert.ok(selects({ whole: { tests: false }, files: { tests: ["a.test.ts"] } }, unit));
  assert.ok(!selects({ whole: { tests: false }, files: { tests: ["b.test.ts"] } }, unit));
  const mac = { kind: "vitest", file: "x.test.ts", job: "native-mac (iphone)" };
  assert.ok(selects({ nativeMac: ["iphone"] }, mac));
  assert.ok(!selects({ nativeMac: ["dictation"] }, mac));
  const windows = { kind: "vitest", file: "w.windows.test.ts", job: "native-windows" };
  assert.ok(selects({ lanes: { "native-windows": true } }, windows));
  assert.ok(!selects({ lanes: { "native-windows": false } }, windows));
});

test("reads one file from an artifact archive, stored or deflated", () => {
  const entry = (name, data, method) => {
    const body = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name), 26);
    return { name, body, local, method, size: data.length };
  };
  const entries = [
    entry("other.txt", Buffer.from("ignored"), 0),
    entry("ci-plan.json", Buffer.from('{"version":2}'), 8),
  ];
  const parts = [];
  const central = [];
  let offset = 0;
  for (const item of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(item.method, 10);
    header.writeUInt32LE(item.body.length, 20);
    header.writeUInt32LE(item.size, 24);
    header.writeUInt16LE(Buffer.byteLength(item.name), 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, Buffer.from(item.name));
    parts.push(item.local, Buffer.from(item.name), item.body);
    offset += 30 + Buffer.byteLength(item.name) + item.body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, directory, end]);
  assert.equal(unzipEntry(zip, "ci-plan.json").toString(), '{"version":2}');
  assert.equal(unzipEntry(zip, "other.txt").toString(), "ignored");
  assert.equal(unzipEntry(zip, "missing.json"), undefined);
  assert.throws(() => unzipEntry(Buffer.from("not a zip"), "ci-plan.json"), /Not a zip/);
});

const failing = { kind: "vitest", file: "tests/a.integration.test.ts", name: ["a", "races"] };
const plan = { whole: { integration: true }, files: { integration: [failing.file] } };
const job = (name, conclusion, attempt = 1, failures) => ({
  name,
  attempt,
  conclusion,
  url: `https://example.invalid/${name}/${attempt}`,
  ...(failures ? { failures } : {}),
});
const ci = (id, sha, jobs, extra = {}) => ({
  id,
  sha,
  event: "push",
  createdAt: `2026-11-${String(10 + id).padStart(2, "0")}T00:00:00Z`,
  plan,
  jobs,
  ...extra,
});
const red = () => job("integration (1)", "failure", 1, [failing]);
const green = (name = "integration (1)") => job(name, "success");
// Commits newest first: c (index 0), b, a.
const position = new Map([
  ["c", 0],
  ["b", 1],
  ["a", 2],
]);
const never = () => assert.fail("reachability is not needed");

test("a test that passed on a rerun of the same job is a flake", () => {
  const { flakes, unproven } = classify(
    [ci(1, "b", [red(), job("integration (1)", "success", 2), job("Check", "failure")])],
    position,
    never,
  );
  assert.equal(unproven.length, 0);
  assert.equal(flakes.length, 1);
  assert.deepEqual(
    { ...flakes[0], occurrences: undefined },
    {
      lane: "integration",
      kind: "vitest",
      file: failing.file,
      name: failing.name,
      firstSeen: "2026-11-11T00:00:00Z",
      failures: 1,
      flakes: 1,
      evidence: ["rerun"],
      occurrences: undefined,
      lastFailure: "https://example.invalid/integration (1)/1",
    },
  );
});

test("a test another run of the same commit ran and passed is a flake", () => {
  const runs = [ci(1, "b", [red()]), ci(2, "b", [green()], { event: "schedule" })];
  assert.deepEqual(classify(runs, position, never).flakes[0].evidence, ["same commit"]);
  // That run must have run the file: a narrower plan, or none from a push, proves nothing.
  const narrow = { whole: { integration: false }, files: { integration: ["other.test.ts"] } };
  runs[1] = ci(2, "b", [green()], { plan: narrow });
  assert.equal(classify(runs, new Map(), never).flakes.length, 0);
  runs[1] = ci(2, "b", [green()], { plan: undefined });
  assert.equal(classify(runs, new Map(), never).flakes.length, 0);
  runs[1] = ci(2, "b", [green()], { plan: undefined, event: "schedule" });
  assert.equal(classify(runs, new Map(), never).flakes.length, 1);
});

test("a pass on a neighbouring commit proves a flake only across a diff that cannot reach it", () => {
  const runs = [ci(1, "a", [green()]), ci(2, "b", [red()]), ci(3, "c", [green()])];
  const asked = [];
  const reaches = (from, to, test) => {
    asked.push(`${from}..${to} ${test.file}`);
    return true;
  };
  assert.deepEqual(classify(runs, position, reaches).unproven[0].evidence, []);
  assert.deepEqual(asked, [`a..b ${failing.file}`, `b..c ${failing.file}`]);
  const after = classify(runs, position, (from) => from === "a");
  assert.deepEqual(after.flakes[0].evidence, ["unreachable diff"]);
  // A failing neighbour is no pass: the nearest pass is further away.
  const further = new Map([...position, ["d", 3]]);
  const skipped = [ci(0, "d", [green()]), ci(1, "a", [red()]), ci(2, "b", [red()])];
  const pairs = [];
  classify(skipped, further, (from, to) => (pairs.push(`${from}..${to}`), true));
  assert.deepEqual(pairs, ["d..a", "d..b"]);
});

test("a red shard that did not run the test does not hide its pass", () => {
  const runs = [
    ci(1, "b", [red(), green("integration (2)")]),
    ci(2, "b", [green(), job("integration (2)", "failure")], { event: "schedule" }),
  ];
  // Unknown sharding needs every shard of the lane green.
  assert.equal(classify(runs, new Map(), never).flakes.length, 0);
  const shardOf = (item, test) => (test.file === failing.file ? "integration (1)" : undefined);
  assert.equal(classify(runs, new Map(), never, shardOf).flakes.length, 1);
});

test("a failed job whose log names no test is listed by its failed step", () => {
  const runs = [
    ci(1, "b", [{ ...job("build-types", "failure"), step: "Typecheck", failures: [] }]),
    ci(2, "b", [green("build-types")], { event: "schedule" }),
  ];
  const [entry] = classify(runs, new Map(), never).flakes;
  assert.equal(entry.kind, "job");
  assert.equal(entry.file, null);
  assert.deepEqual(entry.name, ["Typecheck"]);
});

test("shards are recomputed only for commits that shard with today's code", () => {
  const blobs = { HEAD: "same", b: "same", c: "older" };
  const git = (command, target) => {
    if (command === "rev-parse") return `${blobs[target.split(":")[0]]}\n`;
    assert.equal(command, "show");
    return JSON.stringify({ integration: { "big.integration.test.ts": 90_000 } });
  };
  const shardOf = sharding(git);
  const files = ["big.integration.test.ts", "small.integration.test.ts"];
  const item = (sha) => ({
    id: sha,
    sha,
    plan: { files: { integration: files }, shards: { integration: 2 } },
  });
  const test = (file) => ({ kind: "vitest", file, job: "integration (2)" });
  assert.equal(shardOf(item("b"), test("big.integration.test.ts")), "integration (1)");
  assert.equal(shardOf(item("b"), test("small.integration.test.ts")), "integration (2)");
  assert.equal(shardOf(item("b"), test("absent.integration.test.ts")), undefined);
  assert.equal(shardOf(item("c"), test("big.integration.test.ts")), undefined);
  assert.equal(shardOf(item("b"), { ...test("x"), kind: "go" }), undefined);
});

test("a quarantine edit or a test no longer in the tree counts as reaching it", () => {
  const real = (...args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const git = (...args) => (args[0] === "diff" ? "tests/quarantine.json\0" : real(...args));
  const reaches = reachability(process.cwd(), git);
  const unit = { kind: "vitest", file: "tests/quarantine.test.ts", job: "tests (1)" };
  assert.equal(reaches("a", "b", unit), true);
  assert.equal(reaches("a", "b", { ...unit, file: "tests/deleted.test.ts" }), true);
});

test("a lockfile edit is read from each side of the diff, so a dependency change reaches every test", () => {
  const real = (...args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const lock = real("show", "HEAD:pnpm-lock.yaml");
  const git = (...args) => {
    if (args[0] === "diff") return "pnpm-lock.yaml\0";
    if (args[0] === "show") {
      const [ref, file] = args[1].split(":");
      if (file === "pnpm-lock.yaml" && ref === "a") return `${lock}\n# an older dependency set\n`;
      return real("show", `HEAD:${file}`);
    }
    return real(...args);
  };
  const reaches = reachability(process.cwd(), git);
  assert.equal(
    reaches("a", "b", { kind: "vitest", file: "tests/quarantine.test.ts", job: "tests (1)" }),
    true,
  );
});

test("a proof names the passing job and the commits compared", () => {
  const rerun = classify(
    [ci(1, "b", [red(), job("integration (1)", "success", 2)])],
    position,
    never,
  ).flakes[0];
  assert.deepEqual(rerun.occurrences[0].proof, {
    kind: "rerun",
    passing: { sha: "b", url: "https://example.invalid/integration (1)/2" },
  });
  const runs = [ci(1, "b", [red()]), ci(2, "a", [green()], { event: "schedule" })];
  const unreachable = classify(runs, position, () => false).flakes[0];
  assert.deepEqual(unreachable.occurrences[0].proof.kind, "unreachable diff");
  assert.equal(unreachable.occurrences[0].proof.passing.sha, "a");
  assert.equal(typeof unreachable.occurrences[0].proof.passing.url, "string");
  const { from, to } = unreachable.occurrences[0].proof.compared;
  assert.deepEqual([from, to].sort(), ["a", "b"]);
});
