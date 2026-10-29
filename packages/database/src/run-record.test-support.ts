/**
 * The integration run record's two in-Vitest phases (scripts/run-record.ts
 * reads them): a reporter that wraps every configured reporter, and the global
 * teardown's completion entry. Both write only when the launcher names an
 * attempt directory in OPENSTEER_RUN_RECORD.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  Reporter,
  SerializedError,
  TestModule,
  TestRunEndReason,
  TestSpecification,
  Vitest,
} from "vitest/node";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

function write(name: string, value: unknown): void {
  const directory = process.env.OPENSTEER_RUN_RECORD;
  if (!directory) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/**
 * Vitest dispatches each hook to all reporters at once and only logs a
 * rejection, so another reporter can fail after this one has written. This
 * reporter is the only one Vitest sees: it calls each wrapped reporter in
 * order, records every throw or rejection, rethrows it so the exit status is
 * unchanged, and writes its record last, once every `onTestRunEnd` settled.
 */
export class RunRecordReporter {
  readonly #delegates: readonly Reporter[];
  #root = process.cwd();
  #expected: string[] = [];
  readonly #errors: { hook: string; message: string }[] = [];

  constructor(delegates: readonly Reporter[]) {
    this.#delegates = delegates;
    const hooks = new Set<string>();
    for (const delegate of delegates)
      for (let prototype = delegate; prototype && prototype !== Object.prototype;) {
        for (const name of Object.getOwnPropertyNames(prototype))
          if (
            /^on[A-Z]/u.test(name) &&
            typeof (delegate as Record<string, unknown>)[name] === "function"
          )
            hooks.add(name);
        prototype = Object.getPrototypeOf(prototype) as Reporter;
      }
    for (const hook of hooks)
      if (!(hook in this))
        Object.defineProperty(this, hook, {
          value: (...args: unknown[]) => this.#dispatch(hook, args),
        });
  }

  #dispatch(hook: string, args: readonly unknown[]): void | Promise<void> {
    const failures: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    for (const delegate of this.#delegates) {
      const method = (delegate as Record<string, unknown>)[hook];
      if (typeof method !== "function") continue;
      try {
        const result: unknown = method.apply(delegate, args);
        if (result instanceof Promise) pending.push(result);
      } catch (error) {
        failures.push(error);
      }
    }
    const settle = (rejected: unknown[]): void => {
      for (const error of rejected) this.#errors.push({ hook, message: message(error) });
      if (rejected.length) throw new AggregateError(rejected, `A reporter's ${hook} failed`);
    };
    if (!pending.length) return settle(failures);
    return Promise.allSettled(pending).then((results) =>
      settle([
        ...failures,
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ]),
    );
  }

  onInit(vitest: Vitest): void | Promise<void> {
    this.#root = vitest.config.root;
    return this.#dispatch("onInit", [vitest]);
  }

  onTestRunStart(specifications: readonly TestSpecification[]): void | Promise<void> {
    this.#expected = specifications.map((spec) => path.relative(this.#root, spec.moduleId));
    return this.#dispatch("onTestRunStart", [specifications]);
  }

  async onTestRunEnd(
    modules: readonly TestModule[],
    unhandledErrors: readonly SerializedError[],
    reason: TestRunEndReason,
  ): Promise<void> {
    let failure: unknown;
    try {
      await this.#dispatch("onTestRunEnd", [modules, unhandledErrors, reason]);
    } catch (error) {
      failure = error;
    }
    const file = (module: TestModule) => path.relative(this.#root, module.moduleId);
    write("reporter.json", {
      expected: this.#expected,
      modules: modules.map((module) => ({
        file: file(module),
        state: module.state(),
        errors: module.errors().map(message),
      })),
      cases: modules.flatMap((module) =>
        [...module.children.allTests()].map((testCase) => {
          const titlePath: string[] = [testCase.name];
          for (let parent = testCase.parent; parent.type === "suite"; parent = parent.parent)
            titlePath.unshift(parent.name);
          return {
            file: file(module),
            project: module.project.name,
            titlePath,
            state: testCase.result().state,
          };
        }),
      ),
      suiteErrors: modules.flatMap((module) =>
        [...module.children.allSuites()].flatMap((suite) =>
          suite.errors().map((error) => ({ file: file(module), message: message(error) })),
        ),
      ),
      unhandledErrors: unhandledErrors.map(message),
      reporterErrors: this.#errors,
      reason,
      dispatched: true,
    });
    if (failure) throw failure;
  }
}

/** Runs the global teardown, then records that it finished and what failed. */
export async function recordTeardown(teardown: () => Promise<void>): Promise<void> {
  const errors: string[] = [];
  try {
    await teardown();
  } catch (error) {
    errors.push(
      ...(error instanceof AggregateError ? [error, ...error.errors] : [error]).map(message),
    );
    throw error;
  } finally {
    write("teardown.json", { completed: true, errors });
  }
}
