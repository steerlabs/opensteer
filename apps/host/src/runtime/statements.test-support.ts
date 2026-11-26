import pg from "pg";
import { vi } from "vitest";

/** Every statement this process sends to PostgreSQL while `action` runs, in order. */
export async function statementsSent(action: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
  const query = prototype.query;
  const spy = vi.spyOn(prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0];
    sent.push(
      typeof first === "string"
        ? first
        : first && typeof first === "object" && "text" in first
          ? String(first.text)
          : "",
    );
    return Reflect.apply(query, this, args);
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return sent;
}
