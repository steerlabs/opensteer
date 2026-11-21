import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./browser-service.ts", import.meta.url), "utf8");
const callers = (name: string) =>
  source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.includes(`${name}(`) && !line.startsWith(`async ${name}(`));

it("reaches the pooled adoption and its page close only from the managed pooled target's startup", () => {
  // The adopter is installed in exactly one place: initialize, for the managed pooled runner.
  const installs = callers("this.#poolAdopter");
  expect(installs.map(({ line }) => line)).toEqual([
    "pool.setAdopter(this.#poolAdopter(runnerId));",
  ]);
  const initialize = source.slice(source.indexOf("  async initialize(): Promise<void> {"));
  const guarded = initialize.slice(0, initialize.indexOf("\n  }\n"));
  expect(guarded).toContain("const runnerId = this.#managedPoolTestRunner;");
  expect(guarded).toContain("if (runnerId) {");
  // The adopter refuses any other runner, and the per-session adoption (with the close of a tab
  // closed while parked) is reached only through it.
  expect(source).toContain(
    'if (runnerId !== this.#managedPoolTestRunner)\n      throw new Error("Only the pooled target adopts retained sessions.");',
  );
  expect(callers("this.#adoptPooledSession").map(({ line }) => line)).toEqual([
    "...(await this.#adoptPooledSession(runnerId, sessionId, documents, fence, attempt)),",
  ]);
});
