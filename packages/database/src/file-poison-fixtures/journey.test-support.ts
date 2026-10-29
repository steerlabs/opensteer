import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it as baseIt } from "vitest";
import { failDatabaseContainment, guardTestCleanup } from "../test-database-worker.test-support.js";

const directory = process.env.OPENSTEER_FILE_POISON_OUTPUT!;
const scenario = process.env.OPENSTEER_FILE_POISON_SCENARIO!;
const gate = Promise.withResolvers<void>();

const it = baseIt.extend<{ fixture: string }>({
  fixture: async ({ task, signal, onTestFinished }, use) => {
    guardTestCleanup({ task, signal, onTestFinished });
    if (task.name === "next-fixture")
      await writeFile(join(directory, "fixture-entered"), "unsafe after contamination");
    await use("owned");
  },
});

const first = scenario === "expected-timeout" ? it.fails : it;
first("poison-origin", { timeout: 50 }, async ({ fixture, onTestFinished, signal, skip }) => {
  if (fixture !== "owned") throw new Error("Fixture was not supplied");
  if (scenario === "healthy") return;
  if (scenario === "expected-timeout")
    onTestFinished(() => writeFile(join(directory, "expected-abort"), String(signal.aborted)));
  if (scenario === "skip") {
    onTestFinished(async () => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      skip("SKIP_AFTER_CLEANUP_TIMEOUT_SENTINEL");
    }, 50);
  } else if (scenario === "diagnostics") {
    onTestFinished(() => failDatabaseContainment(new Error("CLEANUP_FAILURE_SENTINEL")));
  } else {
    onTestFinished(() => {
      gate.resolve();
    });
    await gate.promise;
    return;
  }
  throw new Error("ORIGINAL_BODY_FAILURE_SENTINEL");
});

it("next-fixture", ({ fixture }) => {
  if (fixture !== "owned") throw new Error("Fixture was not supplied");
});
