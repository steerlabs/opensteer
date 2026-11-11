import { z } from "zod";
import { createId, TimeZoneSchema } from "@opensteer/core";
import { HarnessInputSchema } from "@opensteer/protocol";

const regex = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value, "u");
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid regular expression" });
  }
});
const fixturePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (part) => part !== ".." && part !== "." && part !== "" && !part.startsWith(".eval-"),
        ),
    "Fixture must be a relative path without traversal",
  );
const call = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.json()).default({}),
});
const structuredTurn = z
  .strictObject({
    text: z.string().min(1).optional(),
    content: HarnessInputSchema.shape.content.optional(),
    author: HarnessInputSchema.shape.author,
    kind: HarnessInputSchema.shape.kind,
  })
  .superRefine((turn, ctx) => {
    if ((turn.text === undefined) === (turn.content === undefined))
      ctx.addIssue({ code: "custom", message: "Provide exactly one of text or content" });
    const result = HarnessInputSchema.safeParse({
      author: turn.author,
      kind: turn.kind,
      content: turn.content ?? [{ type: "text", text: turn.text }],
      createdAt: new Date().toISOString(),
      messageId: createId("message"),
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
const fileRules = z
  .array(
    z.strictObject({
      path: z.union([fixturePath, z.literal("."), z.array(fixturePath).min(1)]),
      exists: z.boolean().optional(),
      recursive: z.boolean().default(false),
      matchingText: regex.optional(),
      count: z.number().int().nonnegative().optional(),
      mode: z.number().int().min(0).max(0o777).optional(),
      gitIgnored: z.boolean().optional(),
      exclude: z.array(fixturePath).default([]),
      textMust: z.array(regex).default([]),
      textMustNot: z.array(regex).default([]),
    }),
  )
  .default([]);
export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  after: z.string().optional(),
  area: z.string().min(1),
  kind: z.enum(["bad", "guard", "control"]),
  source: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), note: z.string().min(1) }),
  profile: z.enum(["task", "delegated"]),
  caller: z.enum(["run", "connection"]).default("run"),
  purpose: z.enum(["task", "voice", "background-job"]).default("task"),
  assigned: z.boolean().optional(),
  voice: z.boolean().optional(),
  teamBound: z.boolean().default(false),
  teamContext: z.string().min(1).optional(),
  folder: fixturePath.optional(),
  machineAccessNotice: z.string().min(1).optional(),
  requesterTimeZone: TimeZoneSchema.optional(),
  engines: z
    .array(z.enum(["claude", "codex", "cursor", "opencode", "pi"]))
    .min(1)
    .optional(),
  fixtures: z.record(fixturePath, z.string()).default({}),
  gitRepository: z.boolean().default(false),
  turns: z.array(z.union([z.string().min(1), structuredTurn])).min(1),
  mocks: z.record(z.string(), z.json()).default({}),
  expect: z.strictObject({
    files: fileRules,
    /** Snapshot before matching calls, until ordered groups of successful results complete. */
    boundaries: z
      .array(
        z.strictObject({
          call: call.optional(),
          until: z.array(z.array(call.extend({ result: z.json().optional() })).min(1)).default([]),
          files: fileRules,
        }),
      )
      .default([]),
    callsOnlyKeys: z.array(call.extend({ keys: z.array(z.string()) })).default([]),
    calls: z.array(call).default([]),
    notCalls: z.array(z.string()).default([]),
    notCallsWithArgs: z.array(call).default([]),
    callsArgMatch: z
      .array(
        z.strictObject({
          tool: z.string().min(1),
          args: z.record(z.string(), z.json()).default({}),
          path: z.array(z.string().min(1)).min(1),
          pattern: regex,
          first: z.boolean().default(false),
          /** Only calls after the first valid one matching this, result included, count. */
          after: call.extend({ result: z.json() }).optional(),
        }),
      )
      .default([]),
    notCallsArgMatch: z
      .array(
        z.strictObject({
          tool: z.string().min(1),
          args: z.record(z.string(), z.json()).default({}),
          path: z.array(z.string().min(1)).min(1),
          pattern: regex,
          after: call.extend({ result: z.json() }),
        }),
      )
      .default([]),
    finalText: z.enum(["empty", "nonempty"]).optional(),
    maxFinalTextBytes: z.number().int().nonnegative().optional(),
    order: z.array(z.string()).default([]),
    minCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
    maxCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
    noAssistantText: z.boolean().default(false),
    textMust: z.array(regex).default([]),
    textMustNot: z.array(regex).default([]),
    /** Checked against assistant text from turns before the graded last turn. */
    earlierTextMust: z.array(regex).default([]),
    maxInvalidCalls: z.number().int().nonnegative().default(0),
  }),
});
export type EvalCase = z.infer<typeof CaseSchema>;
export function parseCases(text: string): EvalCase[] {
  const ids = new Set<string>();
  const cases = text.split(/\r?\n/u).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const value = CaseSchema.parse(JSON.parse(line));
      if (ids.has(value.id)) throw new Error(`Duplicate case ${value.id}`);
      ids.add(value.id);
      return [value];
    } catch (cause) {
      throw new Error(`Case line ${i + 1}: ${String(cause)}`, { cause });
    }
  });
  for (const c of cases) {
    if (c.after && !cases.slice(0, cases.indexOf(c)).some((p) => p.id === c.after))
      throw new Error(`Case ${c.id}: after must name an earlier case`);
  }
  return cases;
}

export function inputForCaseTurn(turn: EvalCase["turns"][number]) {
  return HarnessInputSchema.parse({
    author:
      typeof turn === "string"
        ? { kind: "human", displayName: "Eval user", principalId: "eval" }
        : turn.author,
    content:
      typeof turn === "string"
        ? [{ type: "text", text: turn }]
        : (turn.content ?? [{ type: "text", text: turn.text }]),
    kind: typeof turn === "string" ? "input" : turn.kind,
    createdAt: new Date().toISOString(),
    messageId: createId("message"),
  });
}
