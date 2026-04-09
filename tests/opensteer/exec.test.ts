import { describe, expect, test } from "vitest";

import { runExecExpression } from "../../packages/opensteer/src/cli/exec.js";

describe("exec command", () => {
  test("evaluates a simple expression and returns the result", async () => {
    const result = await runExecExpression({}, "1 + 2");
    expect(result).toBe(3);
  });

  test("evaluates an async expression with await", async () => {
    const result = await runExecExpression({}, "await Promise.resolve(42)");
    expect(result).toBe(42);
  });

  test("evaluates a statement block with explicit return", async () => {
    const result = await runExecExpression({}, "const x = 10; return x * 3");
    expect(result).toBe(30);
  });

  test("accesses this context", async () => {
    const context = { greeting: "hello" };
    const result = await runExecExpression(context, "this.greeting");
    expect(result).toBe("hello");
  });

  test("calls async methods on this", async () => {
    const context = {
      async fetchData() {
        return { status: 200, items: [1, 2, 3] };
      },
    };
    const result = await runExecExpression(context, "await this.fetchData()");
    expect(result).toEqual({ status: 200, items: [1, 2, 3] });
  });

  test("returns undefined for expressions with no return value", async () => {
    const result = await runExecExpression({}, "void 0");
    expect(result).toBeUndefined();
  });

  test("throws on invalid syntax", async () => {
    await expect(runExecExpression({}, "{{{{")).rejects.toThrow();
  });
});
