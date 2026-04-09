// Tries expression-mode first (auto-return); falls back to statement block
// (requires explicit return). Runs in the local Node.js process.
export async function runExecExpression(
  context: object,
  expression: string,
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(`return (${expression})`);
  } catch {
    fn = new AsyncFunction(expression);
  }

  return fn.call(context);
}
