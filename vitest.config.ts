import "./apps/desktop/vitest.config.js";
import { defaultTestInclude, defaultTestExclude } from "./.github/scripts/ci-test-files.mjs";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest runs last-failed, then slowest, files first from the results it keeps
  // here, keyed by path relative to the root; outside the checkout, fresh worktrees
  // inherit them.
  cacheDir: path.join(homedir(), ".cache/opensteer/vitest/unit"),
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
    // Date-formatting assertions must not depend on the machine's timezone.
    env: { TZ: "UTC" },
    environment: "node",
    // Engine qualification drives real engines on real accounts: `pnpm test:engines`.
    // Device tests drive a real Android phone or emulator: `pnpm test:agent-phone`.
    exclude: [...configDefaults.exclude, ...defaultTestExclude],
    include: defaultTestInclude,
    // Browser and engine journeys spawn children beyond the Vitest fork itself, and
    // other work and the agents themselves run beside them: a third of the cores keeps
    // the heaviest tests inside their budgets on a loaded machine.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 3)),
    pool: "forks",
    restoreMocks: true,
  },
});
