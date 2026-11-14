import path from "node:path";
import {
  TestRunner,
  type RunnerTask,
  type RunnerTestFile,
  type RunnerTestSuite,
  type VitestTestRunner,
} from "vitest";
import { readQuarantines } from "./quarantine.js";

export function quarantineRunner(Base: typeof TestRunner): typeof TestRunner {
  return class QuarantineTestRunner extends Base {
    declare onTaskUpdate: VitestTestRunner["onTaskUpdate"];

    async onCollected(files: RunnerTestFile[]): Promise<void> {
      const entries = readQuarantines(this.config.root);
      for (const file of files) {
        const relative = path.relative(this.config.root, file.filepath).split(path.sep).join("/");
        const matching = entries.filter((entry) => entry.file === relative);
        if (!matching.length) continue;
        const tests: { task: RunnerTask; name: string[] }[] = [];
        const collect = (suite: RunnerTestSuite, parents: string[]) => {
          for (const task of suite.tasks) {
            const name = [...parents, task.name];
            if (task.type === "suite") collect(task, name);
            else tests.push({ task, name });
          }
        };
        collect(file, []);
        for (const entry of matching) {
          const matches = tests.filter(
            ({ name }) => JSON.stringify(name) === JSON.stringify(entry.name),
          );
          if (matches.length !== 1)
            throw new Error(
              `Quarantine must match exactly one test: ${relative} ${JSON.stringify(entry.name)}; found ${matches.length}`,
            );
          const task = matches[0]!.task;
          task.mode = "skip";
          task.result = { state: "skip" };
          Object.assign(task.meta, { quarantined: true });
          console.warn(
            `[quarantined] ${relative} ${JSON.stringify(entry.name)}; owner: ${entry.owner}; deadline: ${entry.deadline}; ${entry.evidence.join(" ")}`,
          );
        }
        const skipEmpty = (suite: RunnerTestSuite) => {
          for (const task of suite.tasks) if (task.type === "suite") skipEmpty(task);
          if (
            suite.tasks.length &&
            suite.tasks.every((task) => task.mode === "skip" || task.mode === "todo")
          )
            suite.mode = "skip";
        };
        skipEmpty(file);
        if (
          tests.length &&
          tests.every(({ task }) => "quarantined" in task.meta && task.meta.quarantined === true)
        )
          Object.assign(file.meta, { quarantined: true });
        // Vitest sends collection before this hook; publish skip results for reporters as well.
        await this.onTaskUpdate?.(
          tests
            .filter(({ task }) => task.result?.state === "skip")
            .map(({ task }) => [task.id, task.result, task.meta]),
          [],
        );
      }
    }
  };
}

export default quarantineRunner(TestRunner);
