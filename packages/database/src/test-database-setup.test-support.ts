import { beforeEach } from "vitest";
import {
  assertTestFileHealthy,
  guardOwnedDatabaseTest,
} from "./test-database-worker.test-support.js";

// Gate only files poisoned by an owned DB fixture, before lazy fixture setup.
beforeEach(({ task, signal, onTestFinished }) => {
  assertTestFileHealthy({ task });
  guardOwnedDatabaseTest({ task, signal, onTestFinished });
});
