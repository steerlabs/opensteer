import { beforeAll, expect, it, type TestContext } from "vitest";
import {
  assertTestFileHealthy,
  guardTestCleanup,
  guardOwnedDatabaseTest,
  ownTestDatabaseFile,
  poisonTestFile,
} from "./test-database-worker.test-support.js";

beforeAll(() => ownTestDatabaseFile());

function fixture(fails = false, file = {} as TestContext["task"]["file"]) {
  const abort = new AbortController();
  const finished: (() => void)[] = [];
  const context = {
    task: { name: "origin", file, fails },
    signal: abort.signal,
    onTestFinished: (callback: () => void) => finished.push(callback),
  } as unknown as TestContext;
  return { context, abort, finished };
}

it("keeps database contamination within the originating file when a worker is reused", () => {
  const origin = fixture();
  const sameFile = fixture(false, origin.context.task.file);
  const nextFile = fixture();
  poisonTestFile(origin.context, new Error("ORIGINAL_FILE_FAILURE"));
  expect(() => assertTestFileHealthy(sameFile.context)).toThrow("ORIGINAL_FILE_FAILURE");
  expect(() => assertTestFileHealthy(nextFile.context)).not.toThrow();
});

it("allows an expected timeout after its database fixture drains", () => {
  const expected = fixture(true);
  guardTestCleanup(expected.context);
  expected.abort.abort(new Error("EXPECTED_TIMEOUT"));
  for (const finish of expected.finished) finish();
  expect(() => assertTestFileHealthy(expected.context)).not.toThrow();
});

it("still poisons an expected-failure file when database cleanup cannot prove containment", () => {
  const expected = fixture(true);
  poisonTestFile(expected.context, new Error("UNDRAINED_DATABASE"));
  expect(() => assertTestFileHealthy(expected.context)).toThrow("UNDRAINED_DATABASE");
});

it("does not guard a file without a database owner", () => {
  const unrelated = fixture();
  guardOwnedDatabaseTest(unrelated.context);
  unrelated.abort.abort(new Error("UNRELATED_TIMEOUT"));
  expect(unrelated.finished).toHaveLength(0);
  expect(() => assertTestFileHealthy(unrelated.context)).not.toThrow();
});

it("guards tests whose file acquired its database in beforeAll", (context) => {
  const owned = fixture(false, context.task.file);
  guardOwnedDatabaseTest(owned.context);
  owned.abort.abort(new Error("SUITE_DATABASE_TIMEOUT"));
  expect(owned.finished).toHaveLength(1);
  expect(() => assertTestFileHealthy(owned.context)).toThrow("SUITE_DATABASE_TIMEOUT");
});
