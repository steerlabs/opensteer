import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { EvalCase } from "./cases.js";
export interface RecordedCall {
  readonly tool: string;
  readonly args: unknown;
  readonly valid: boolean;
  readonly result?: unknown;
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
  assistantText: string = finalText,
  earlierText: string = "",
): Check[] {
  const valid = calls.filter((call) => call.valid);
  const checks: Check[] = [];
  const add = (name: string, pass: boolean) => {
    checks.push({ name, pass });
  };
  if (expect.endAfterPendingRequest) {
    const pending = calls.findIndex(
      (call) =>
        partialMatch(call.result, { status: "pending" }) &&
        call.result !== null &&
        typeof call.result === "object" &&
        typeof Reflect.get(call.result, "requestId") === "string",
    );
    add("endAfterPendingRequest", pending >= 0 && pending === calls.length - 1);
  }
  for (const [i, required] of expect.calls.entries())
    add(
      `calls[${i}]:${required.tool}`,
      valid.some((c) => toolMatches(c.tool, required.tool) && partialMatch(c.args, required.args)),
    );
  for (const [i, rule] of expect.callsOnlyKeys.entries())
    add(
      `callsOnlyKeys[${i}]`,
      calls
        .filter((c) => toolMatches(c.tool, rule.tool) && partialMatch(c.args, rule.args))
        .every(
          (c) =>
            c.args !== null &&
            typeof c.args === "object" &&
            Object.keys(c.args).every((key) => rule.keys.includes(key)),
        ),
    );
  for (const name of expect.notCalls)
    add(`notCalls:${name}`, !calls.some((c) => toolMatches(c.tool, name)));
  for (const [i, forbidden] of expect.notCallsWithArgs.entries())
    add(
      `notCallsWithArgs[${i}]:${forbidden.tool}`,
      !calls.some(
        (c) => toolMatches(c.tool, forbidden.tool) && partialMatch(c.args, forbidden.args),
      ),
    );
  for (const [i, match] of expect.callsArgMatch.entries()) {
    const candidates = calls.filter(
      (c) => toolMatches(c.tool, match.tool) && partialMatch(c.args, match.args),
    );
    add(
      `callsArgMatch[${i}]:${match.tool}`,
      (match.first ? candidates.slice(0, 1) : candidates).some((c) => {
        const value = match.path.reduce<unknown>(
          (value, key) =>
            value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined,
          c.args,
        );
        return c.valid && typeof value === "string" && new RegExp(match.pattern, "u").test(value);
      }),
    );
  }
  if (expect.finalText)
    add("finalText", expect.finalText === "empty" ? !finalText.trim() : !!finalText.trim());
  if (expect.maxFinalTextBytes !== undefined)
    add("maxFinalTextBytes", Buffer.byteLength(finalText, "utf8") <= expect.maxFinalTextBytes);
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
  if (expect.noAssistantText) add("noAssistantText", assistantText.length === 0);
  for (const pattern of expect.textMust)
    add(`textMust:${pattern}`, new RegExp(pattern, "u").test(finalText));
  for (const pattern of expect.textMustNot)
    add(`textMustNot:${pattern}`, !new RegExp(pattern, "u").test(finalText));
  for (const pattern of expect.earlierTextMust)
    add(`earlierTextMust:${pattern}`, new RegExp(pattern, "u").test(earlierText));
  add("maxInvalidCalls", calls.filter((c) => !c.valid).length <= expect.maxInvalidCalls);
  return checks;
}
export function majority(passes: readonly boolean[]): boolean {
  return passes.filter(Boolean).length > passes.length / 2;
}

/** Missing files fail positive matches; prohibitions cover every file in a subtree.
 * Never follow agent-created symlinks out of the disposable Workspace. */
export async function gradeWorkspaceFiles(
  expect: EvalCase["expect"],
  workspace: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const physicalWorkspace = await realpath(workspace);
  for (const [i, rule] of expect.files.entries()) {
    const contents: string[] = [];
    let exists = false;
    async function visit(path: string): Promise<void> {
      if (rule.exclude.some((excluded) => join(workspace, excluded) === path)) return;
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      exists = true;
      if (
        stat.isSymbolicLink() ||
        relative(physicalWorkspace, await realpath(path)) !== relative(workspace, path)
      )
        throw new Error(`Cannot grade symlink: ${path}`);
      if (stat.isFile()) contents.push(await readFile(path, "utf8"));
      else if (stat.isDirectory() && rule.recursive)
        for (const name of (await readdir(path)).sort())
          if (!name.startsWith(".eval-")) await visit(join(path, name));
    }
    for (const path of typeof rule.path === "string" ? [rule.path] : rule.path)
      await visit(join(workspace, path));
    if (rule.exists !== undefined)
      checks.push({ name: `files[${i}]:exists`, pass: exists === rule.exists });
    for (const pattern of rule.textMust)
      checks.push({
        name: `files[${i}]:must:${pattern}`,
        pass: contents.some((text) => new RegExp(pattern, "u").test(text)),
      });
    for (const pattern of rule.textMustNot)
      checks.push({
        name: `files[${i}]:mustNot:${pattern}`,
        pass: contents.every((text) => !new RegExp(pattern, "u").test(text)),
      });
  }
  return checks;
}

export async function gradeToolBoundary(
  expect: EvalCase["expect"],
  previous: readonly RecordedCall[],
  current: Pick<RecordedCall, "tool" | "args">,
  workspace: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [i, rule] of expect.boundaries.entries()) {
    if (
      rule.call &&
      (!toolMatches(current.tool, rule.call.tool) || !partialMatch(current.args, rule.call.args))
    )
      continue;
    let cursor = -1;
    const complete =
      rule.until.length > 0 &&
      rule.until.every((group) => {
        const matches = group.map((required) =>
          previous.findIndex(
            (call, index) =>
              index > cursor &&
              call.valid &&
              toolMatches(call.tool, required.tool) &&
              partialMatch(call.args, required.args) &&
              call.result !== undefined &&
              partialMatch(call.result, required.result ?? {}),
          ),
        );
        if (matches.some((index) => index < 0)) return false;
        cursor = Math.max(...matches);
        return true;
      });
    if (complete) continue;
    checks.push(
      ...(await gradeWorkspaceFiles({ ...expect, files: rule.files }, workspace)).map((check) => ({
        ...check,
        name: `boundary[${i}]:${check.name}`,
      })),
    );
  }
  return checks;
}
