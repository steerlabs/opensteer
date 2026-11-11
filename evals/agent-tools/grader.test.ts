import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { resolvedInputParts } from "@opensteer/harness";
import { inputForCaseTurn, parseCases } from "./cases.js";
import { grade, gradeWorkspaceFiles, majority, partialMatch } from "./grader.js";

const base = {
  id: "one",
  area: "routing",
  kind: "bad",
  source: { commit: "a".repeat(40), note: "incident" },
  profile: "task",
  purpose: "task",
  turns: ["Do it"],
  expect: {},
};
const line = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...patch });
describe("case boundary failure modes", () => {
  it("rejects malformed JSON, duplicate IDs, unknown fields and absent provenance", () => {
    for (const text of [
      "{",
      `${line()}\n${line()}`,
      line({ typo: true }),
      line({ source: undefined }),
    ])
      expect(() => parseCases(text)).toThrow();
  });
  it("rejects unsafe fixture paths and broken regexes", () => {
    for (const path of ["../escape", "/tmp/escape", "a/../../escape", "a\\escape"])
      expect(() => parseCases(line({ fixtures: { [path]: "x" } }))).toThrow();
    expect(() => parseCases(line({ expect: { textMust: ["["] } }))).toThrow();
  });
  it("parses defaults and identifies line numbers", () => {
    expect(parseCases(line())[0]?.expect.maxInvalidCalls).toBe(0);
    expect(() => parseCases(`${line()}\n{`)).toThrow(/line 2/);
  });
});
describe("trajectory grading failure modes", () => {
  it("matches recursive partial objects without coercion", () => {
    expect(
      partialMatch({ nested: { x: 1, y: 2 }, a: ["b", "c"] }, { nested: { x: 1 }, a: ["b"] }),
    ).toBe(true);
    expect(partialMatch({ x: null }, { x: "null" })).toBe(false);
    expect(partialMatch({}, { x: null })).toBe(false);
  });
  it("excludes invalid calls from expectations but counts and forbids them", () => {
    const c = parseCases(line({ expect: { calls: [{ tool: "foo" }], notCalls: ["foo"] } }))[0]!;
    const checks = grade(c.expect, [{ tool: "foo", args: {}, valid: false }], "");
    expect(checks.every((c) => c.pass)).toBe(false);
    expect(checks.filter((c) => !c.pass)).toHaveLength(3);
  });
  it("orders repeated occurrences and enforces counts and final text", () => {
    const c = parseCases(
      line({
        expect: {
          order: ["a", "b", "a"],
          minCalls: { a: 2 },
          maxCalls: { b: 1 },
          textMust: ["done"],
          textMustNot: ["pending"],
        },
      }),
    )[0]!;
    const calls = ["a", "b", "a"].map((tool) => ({ tool, args: {}, valid: true }));
    expect(grade(c.expect, calls, "done").every((c) => c.pass)).toBe(true);
    expect(grade(c.expect, calls.slice(0, 2), "pending").every((c) => c.pass)).toBe(false);
  });
  it("fails ties and empty sets", () => {
    expect(majority([])).toBe(false);
    expect(majority([true, false])).toBe(false);
    expect(majority([true, false, true])).toBe(true);
  });
});

it("parses all orchestration cases including person message guards", async () => {
  const cases = parseCases(
    await readFile(new URL("./cases/orchestration.ndjson", import.meta.url), "utf8"),
  );
  expect(cases.filter((value) => value.id.startsWith("person-message-"))).toHaveLength(8);
});

it("validates structured seeds with production authorship rules and preserves human strings", () => {
  expect(inputForCaseTurn("hello").author.kind).toBe("human");
  const turn = {
    text: "Task complete",
    author: { kind: "platform", cause: "task-result" },
    kind: "continuation",
  };
  const parsed = parseCases(line({ turns: [turn] }))[0]!;
  expect(inputForCaseTurn(parsed.turns[0]!)).toMatchObject({
    author: turn.author,
    kind: "continuation",
    content: [{ type: "text", text: turn.text }],
  });
  const trigger = {
    text: "Nothing changed",
    author: {
      kind: "trigger",
      displayName: "Monitor",
      triggerId: createId("trigger"),
      occurrenceId: createId("triggerOccurrence"),
      source: "schedule",
    },
    kind: "input",
  };
  expect(inputForCaseTurn(parseCases(line({ turns: [trigger] }))[0]!.turns[0]!)).toMatchObject({
    author: trigger.author,
    kind: "input",
  });
  expect(() => parseCases(line({ turns: [{ ...trigger, kind: "continuation" }] }))).toThrow();
  for (const patch of [
    { kind: "input" },
    { author: { kind: "platform" } },
    { author: { kind: "human", displayName: "x", principalId: "x" } },
  ])
    expect(() => parseCases(line({ turns: [{ ...turn, ...patch }] }))).toThrow();
});
it("silence rejects any assistant text and unknown forbidden tools, after an earlier delivery", () => {
  const c = parseCases(
    line({
      expect: {
        noAssistantText: true,
        notCalls: ["person_message", "person_notify"],
        earlierTextMust: ["42"],
      },
    }),
  )[0]!;
  expect(grade(c.expect, [], "", "", "42 services").every((c) => c.pass)).toBe(true);
  // Silence on the repeat proves nothing unless the earlier turn delivered it.
  expect(grade(c.expect, [], "", "", "").every((c) => c.pass)).toBe(false);
  expect(grade(c.expect, [], "", "Nothing new", "42 services").every((c) => c.pass)).toBe(false);
  expect(
    grade(c.expect, [{ tool: "person_notify", args: {}, valid: false }], "", "", "42").every(
      (c) => c.pass,
    ),
  ).toBe(false);
});

it("grades trimmed final presence independently of commentary and counts UTF-8 bytes", () => {
  const expectations = (value: Record<string, unknown>) =>
    parseCases(line({ expect: value }))[0]!.expect;
  expect(
    grade(expectations({ finalText: "empty" }), [], " \n\t", "commentary").every((c) => c.pass),
  ).toBe(true);
  expect(grade(expectations({ finalText: "nonempty" }), [], " \n").every((c) => c.pass)).toBe(
    false,
  );
  expect(
    grade(expectations({ finalText: "nonempty", maxFinalTextBytes: 4 }), [], "😀").every(
      (c) => c.pass,
    ),
  ).toBe(true);
  expect(grade(expectations({ maxFinalTextBytes: 3 }), [], "😀").every((c) => c.pass)).toBe(false);
  expect(
    grade(expectations({ noAssistantText: true }), [], "", "commentary").every((c) => c.pass),
  ).toBe(false);
});

it("forbids partial arguments even on invalid attempts without banning other actions", () => {
  const e = parseCases(
    line({
      expect: {
        notCallsWithArgs: [{ tool: "trigger_write", args: { action: "run", nested: { id: 1 } } }],
      },
    }),
  )[0]!.expect;
  const call = {
    tool: "trigger_write",
    valid: false,
    args: { action: "run", nested: { id: 1, extra: true } },
  };
  expect(grade(e, [call], "").find((c) => c.name.startsWith("notCallsWithArgs"))?.pass).toBe(false);
  expect(
    grade(e, [{ ...call, valid: true, args: { action: "get" } }], "").every((c) => c.pass),
  ).toBe(true);
});

it("checks the first tool attempt's string argument, not a later repair", () => {
  const e = parseCases(
    line({
      expect: {
        callsArgMatch: [{ tool: "computer", path: ["code"], pattern: "app\\(", first: true }],
      },
    }),
  )[0]!.expect;
  const call = (code: unknown, valid = true) => ({ tool: "computer", args: { code }, valid });
  expect(grade(e, [call('await app("Notes")')], "").every((c) => c.pass)).toBe(true);
  for (const calls of [
    [call('win.type("x")'), call('app("Notes")')],
    [call(42)],
    [call('app("Notes")', false)],
    [],
  ])
    expect(grade(e, calls, "").every((c) => c.pass)).toBe(false);
});

it("requires a resumed computer call to bind a fresh window or phone before acting", async () => {
  const cases = parseCases(
    await readFile(new URL("./cases/browser.ndjson", import.meta.url), "utf8"),
  );
  const e = cases.find((c) => c.id === "resumed-computer-reopens")!.expect;
  const pass = (code: string) =>
    grade(e, [{ tool: "computer", args: { code }, valid: true }], "").every((c) => c.pass);
  expect(pass('const win = await (await app("Notes")).window(); await win.observe();')).toBe(true);
  expect(pass('const p = await phone("Eval phone"); await p.observe();')).toBe(true);
  expect(pass('await app("Notes"); await globalThis.win.type("Reviewed");')).toBe(false);
  expect(pass('await globalThis.win.type("Reviewed");')).toBe(false);
});

it("preserves included native places for production input projection and rejects conflicting content", async () => {
  const cases = parseCases(
    await readFile(new URL("./cases/integrations.ndjson", import.meta.url), "utf8"),
  );
  for (const id of ["included-mac-uses-computer", "included-phone-uses-computer"]) {
    const turn = cases.find((c) => c.id === id)!.turns[0]!;
    const input = inputForCaseTurn(turn);
    expect(input.author.kind).toBe("human");
    expect(input.content).toHaveLength(2);
    expect(resolvedInputParts(input, undefined).body).toContain("The person included");
    expect(() => parseCases(line({ turns: [{ ...Object(turn), text: "conflict" }] }))).toThrow(
      /exactly one/,
    );
  }
  expect(() =>
    parseCases(
      line({
        turns: [
          {
            author: { kind: "human", displayName: "x", principalId: "eval" },
            kind: "input",
            content: [{ type: "phone", machineId: "invalid" }],
          },
        ],
      }),
    ),
  ).toThrow();
});

it("rejects duplicate, public, tracked and unignored PIN files and echoed PINs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "opensteer-pin-grader-"));
  const git = (...args: string[]) =>
    promisify(execFile)("git", ["-C", workspace, ...args], { timeout: 5000 });
  try {
    await git("init");
    await mkdir(join(workspace, ".private"));
    const pin = join(workspace, ".private/phone.pin");
    await writeFile(pin, "4821", { mode: 0o600 });
    await writeFile(join(workspace, ".gitignore"), "/.private/\n");
    const expectations = parseCases(
      line({
        expect: {
          files: [
            {
              path: ".",
              recursive: true,
              matchingText: "4821",
              count: 1,
              mode: 0o600,
              gitIgnored: true,
            },
          ],
          textMustNot: ["4821"],
        },
      }),
    )[0]!.expect;
    const check = async (name: string) =>
      (await gradeWorkspaceFiles(expectations, workspace)).find(
        (c) => c.name === `files[0]:${name}`,
      )?.pass;
    expect((await gradeWorkspaceFiles(expectations, workspace)).every((c) => c.pass)).toBe(true);
    await chmod(pin, 0o644);
    expect(await check("mode")).toBe(false);
    await chmod(pin, 0o600);
    const copy = join(workspace, ".private/copy.pin");
    await writeFile(copy, "4821", { mode: 0o600 });
    expect(await check("count")).toBe(false);
    await rm(copy);
    await git("add", "--force", ".private/phone.pin");
    expect(await check("gitIgnored")).toBe(false);
    await git("rm", "--cached", ".private/phone.pin");
    await writeFile(join(workspace, ".gitignore"), "");
    expect(await check("gitIgnored")).toBe(false);
    expect(grade(expectations, [], "Saved 4821").every((c) => c.pass)).toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("rejects renewed phone input after a rejected PIN while allowing observation and release", () => {
  const expectations = parseCases(
    line({
      expect: {
        notCallsArgMatch: [
          {
            tool: "computer",
            path: ["code"],
            pattern: "\\.(?:type|tap|act)\\s*\\(",
            after: { tool: "computer", result: { output: "PIN rejected" } },
          },
        ],
      },
    }),
  )[0]!.expect;
  const call = (code: string) => ({ tool: "computer", args: { code }, valid: true });
  const rejected = { ...call('await p.type("4821")'), result: { output: "PIN rejected" } };
  const safe = [call("await p.observe()"), rejected, call("await p.observe(); await p.release()")];
  expect(grade(expectations, safe, "The PIN was rejected.").every((c) => c.pass)).toBe(true);
  for (const code of [
    'await p.type("4821")',
    'await p.type("1234")',
    "await p.tap(2)",
    "await p.act([])",
  ])
    expect(grade(expectations, [...safe, call(code)], "").every((c) => c.pass)).toBe(false);
  expect(grade(expectations, [], "").every((c) => c.pass)).toBe(false);
});
