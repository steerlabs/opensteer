import type { EvalCase } from "./cases.js";
export interface RecordedCall {
  readonly tool: string;
  readonly args: unknown;
  readonly valid: boolean;
}
export interface Check {
  readonly name: string;
  readonly pass: boolean;
}
export function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.every((e) => actual.some((a: unknown) => partialMatch(a, e)))
    );
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      partialMatch(Reflect.get(actual, key), value),
    );
  }
  return Object.is(actual, expected);
}
function toolMatches(actual: string, expected: string): boolean {
  return expected === "*" || expected.split("|").includes(actual);
}
export function grade(
  expect: EvalCase["expect"],
  calls: readonly RecordedCall[],
  finalText: string,
): Check[] {
  const valid = calls.filter((call) => call.valid);
  const checks: Check[] = [];
  const add = (name: string, pass: boolean) => {
    checks.push({ name, pass });
  };
  for (const [i, required] of expect.calls.entries())
    add(
      `calls[${i}]:${required.tool}`,
      valid.some((c) => toolMatches(c.tool, required.tool) && partialMatch(c.args, required.args)),
    );
  for (const name of expect.notCalls)
    add(`notCalls:${name}`, !calls.some((c) => toolMatches(c.tool, name)));
  let previous = -1;
  for (const [i, name] of expect.order.entries()) {
    const next = valid.findIndex((c, index) => index > previous && toolMatches(c.tool, name));
    add(`order[${i}]:${name}`, next !== -1);
    previous = next === -1 ? valid.length : next;
  }
  for (const [name, count] of Object.entries(expect.minCalls))
    add(`minCalls:${name}`, valid.filter((c) => toolMatches(c.tool, name)).length >= count);
  for (const [name, count] of Object.entries(expect.maxCalls))
    add(`maxCalls:${name}`, calls.filter((c) => toolMatches(c.tool, name)).length <= count);
  for (const pattern of expect.textMust)
    add(`textMust:${pattern}`, new RegExp(pattern, "u").test(finalText));
  for (const pattern of expect.textMustNot)
    add(`textMustNot:${pattern}`, !new RegExp(pattern, "u").test(finalText));
  add("maxInvalidCalls", calls.filter((c) => !c.valid).length <= expect.maxInvalidCalls);
  return checks;
}
export function majority(passes: readonly boolean[]): boolean {
  return passes.filter(Boolean).length > passes.length / 2;
}
