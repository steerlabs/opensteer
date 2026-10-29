import type { Reporter, TestCase, TestModule, Vitest } from "vitest/node";

/**
 * Prints each integration failure the moment the reporter receives it, with
 * the wall time and the time since the run started. A full run lasts about
 * half an hour, and the default reporter shows failures only in its final
 * summary, which it still prints. Vitest 4's worker can hold a result until
 * its next task update, so a failure arrives at most about one test late.
 */
export default class IntegrationFailureReporter implements Reporter {
  #log: (line: string) => void = (line) => process.stdout.write(`${line}\n`);
  #started = performance.now();

  onInit(vitest: Vitest): void {
    this.#log = (line) => vitest.logger.log(line);
  }

  onTestRunStart(): void {
    this.#started = performance.now();
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    if (result.state === "failed")
      this.#print(`${testCase.module.relativeModuleId} > ${testCase.fullName}`, result.errors);
  }

  onTestModuleEnd(testModule: TestModule): void {
    // Collection, hook and suite errors fail no single test.
    const errors = [testModule, ...testModule.children.allSuites()].flatMap((suite) =>
      suite.errors(),
    );
    if (errors.length) this.#print(testModule.relativeModuleId, errors);
  }

  #print(subject: string, errors: ReadonlyArray<{ readonly message: string }>): void {
    const seconds = Math.floor((performance.now() - this.#started) / 1000);
    const elapsed = `+${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    const lines = [`[${new Date().toISOString().slice(11, 19)}Z ${elapsed}] FAIL ${subject}`];
    for (const error of errors)
      for (const line of error.message.split("\n").slice(0, 4)) lines.push(`    ${line}`);
    this.#log(lines.join("\n"));
  }
}
