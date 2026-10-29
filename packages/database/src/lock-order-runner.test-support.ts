import { appendFileSync, existsSync } from "node:fs";
import { TestRunner, type RunnerTestFile } from "vitest";

export default class LockOrderTestRunner extends TestRunner {
  #file: string | undefined;

  override onCollectStart(file: RunnerTestFile): void {
    super.onCollectStart(file);
    this.#file = file.filepath;
  }

  override onAfterRunFiles(): void {
    super.onAfterRunFiles();
    const trace = process.env.OPENSTEER_LOCK_ORDER_TRACE;
    if (!trace || !existsSync(trace)) throw new Error(`Missing lock trace: ${trace}`);
    // Skipped files bypass suite hooks; this also runs after all fixture cleanup.
    appendFileSync(
      trace,
      JSON.stringify({
        type: "file-end",
        file: this.#file,
        worker: process.env.VITEST_WORKER_ID,
      }) + "\n",
    );
  }
}
