import { TestRunner, type TestContext } from "vitest";

const poisoned = new WeakMap<
  TestContext["task"]["file"],
  {
    readonly test: string;
    readonly error: string;
  }
>();
const guarded = new WeakSet<TestContext["task"]>();
const databaseFiles = new WeakSet<TestContext["task"]["file"]>();
type CleanupContext = Pick<TestContext, "task" | "signal" | "onTestFinished">;

/** beforeAll can own a database without a current test. */
export function ownTestDatabaseFile(context?: CleanupContext): void {
  databaseFiles.add(context?.task.file ?? TestRunner.getCurrentSuite().file);
  if (context) guardTestCleanup(context);
}

export function guardOwnedDatabaseTest(context: CleanupContext): void {
  if (databaseFiles.has(context.task.file)) guardTestCleanup(context);
}

function errorMessage(error: unknown): string {
  // Vitest keeps serialized errors here, rather than Error instances.
  return error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : String(error);
}

export function poisonTestFile(context: CleanupContext, cleanupError?: unknown): void {
  if (poisoned.has(context.task.file)) return;
  const original = context.task.result?.errors?.[0] ?? context.signal.reason ?? cleanupError;
  poisoned.set(context.task.file, { test: context.task.name, error: errorMessage(original) });
}

export function assertTestFileHealthy(context: Pick<TestContext, "task">): void {
  const failure = poisoned.get(context.task.file);
  if (failure) throw new Error(`worker contaminated by ${failure.test}: ${failure.error}`);
}

export function failDatabaseContainment(error: unknown): never {
  const context = TestRunner.getCurrentTest()?.context;
  if (context) poisonTestFile(context, error);
  throw new Error("Database fixture containment failed", { cause: error });
}

/** Registered before fixture cleanup, so it runs last even after a late skip. */
export function guardTestCleanup(context: CleanupContext): void {
  if (guarded.has(context.task)) return;
  guarded.add(context.task);
  // Expected timeout tests verify their own drain; unproved DB cleanup still
  // poisons through failDatabaseContainment regardless of the expected result.
  if (context.task.fails) return;
  // Also capture a late abort before a dynamic skip rewrites Vitest's result.
  context.signal.addEventListener("abort", () => poisonTestFile(context), { once: true });
  context.onTestFinished(() => {
    if (context.signal.aborted) poisonTestFile(context);
  });
}
