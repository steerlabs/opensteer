import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
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
  assistantText: string = finalText,
  earlierText: string = "",
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
    async function visit(path: string): Promise<void> {
      if (rule.exclude.some((excluded) => join(workspace, excluded) === path)) return;
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
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

/** Execute submitted ESM in a bounded subprocess; agents' programs are untrusted. */
export async function gradeWorkerPrograms(
  expectations: EvalCase["expect"],
  calls: readonly RecordedCall[],
): Promise<Check[]> {
  if (!expectations.workerPrograms) return [];
  const creates = calls.filter(
    (c) => c.valid && c.tool === "trigger_write" && partialMatch(c.args, { action: "create" }),
  );
  const checks: Check[] = [{ name: "workerPrograms:count", pass: creates.length === 2 }];
  for (const [index, call] of creates.entries()) {
    let pass = false;
    try {
      const args = call.args as {
        anchorThreadId: string;
        name: string;
        source: { cron?: string };
        program: { source: string };
      };
      const script = `
        import { createContext, SourceTextModule, runInContext } from 'node:vm';
        const { source, anchor, nightly } = JSON.parse(process.argv[1]);
        for (const [status, inputQueuePaused] of [['idle',false],['running',false],['waiting',false],['idle',true]]) {
          const context = createContext({}, {codeGeneration:{strings:false,wasm:false}});
          const fixture = runInContext('(function() { const state = ' + JSON.stringify({anchor,status,inputQueuePaused}) + '; const calls = []; return { getCalls: () => JSON.stringify(calls), input: {event:{trigger:{anchorThreadId:state.anchor},source:{scheduledFor:"2026-11-03T12:00:00Z"},receivedAt:"2026-11-03T12:00:00Z"},opensteer:{callTool:async (tool,args) => { calls.push(JSON.parse(JSON.stringify({tool,args}))); if(tool === "thread_read" && args.threadId === state.anchor) return {thread:{status:state.status,inputQueuePaused:state.inputQueuePaused}}; if(tool !== "thread_message") throw Error("Unexpected tool"); return {}; }}}}; })()', context, {timeout:1000});
          const program = new SourceTextModule(source, {context});
          await program.link(() => { throw Error('Imports are unavailable in Trigger programs'); });
          await program.evaluate({timeout:1000});
          await program.namespace.default(fixture.input);
          const wakes = JSON.parse(fixture.getCalls()).filter(c => c.tool === 'thread_message');
          if (wakes.length !== (status === 'idle' && !inputQueuePaused ? 1 : 0)) throw Error('Wake count');
          for (const {args} of wakes) if (args.threadId !== anchor || args.delivery !== 'queue' ||
            typeof args.message !== 'string' || !args.message.includes('2026-11-03T12:00:00Z') ||
            !(nightly ? /nightly/i : /light/i).test(args.message)) throw Error('Wrong wake');
        }
      `;
      await promisify(execFile)(
        process.execPath,
        [
          "--experimental-vm-modules",
          "--input-type=module",
          "-e",
          script,
          JSON.stringify({
            source: args.program.source,
            anchor: args.anchorThreadId,
            nightly: args.source.cron === "0 3 * * *",
          }),
        ],
        { timeout: 5_000, maxBuffer: 8192 },
      );
      pass = true;
    } catch {
      /* Invalid, hanging or misbehaving submitted programs fail grading. */
    }
    checks.push({ name: `workerPrograms[${index}]`, pass });
  }
  return checks;
}
