import { z } from "zod";

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
export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  area: z.string().min(1),
  kind: z.enum(["bad", "guard", "control"]),
  source: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), note: z.string().min(1) }),
  profile: z.enum(["main", "workspace", "delegated"]),
  role: z.enum(["conversation", "work"]),
  engines: z
    .array(z.enum(["claude", "codex", "cursor", "opencode", "pi"]))
    .min(1)
    .optional(),
  fixtures: z.record(fixturePath, z.string()).default({}),
  turns: z.array(z.string().min(1)).min(1),
  mocks: z.record(z.string(), z.json()).default({}),
  expect: z.strictObject({
    calls: z.array(call).default([]),
    notCalls: z.array(z.string()).default([]),
    order: z.array(z.string()).default([]),
    minCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
    maxCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
    textMust: z.array(regex).default([]),
    textMustNot: z.array(regex).default([]),
    maxInvalidCalls: z.number().int().nonnegative().default(0),
  }),
});
export type EvalCase = z.infer<typeof CaseSchema>;
export function parseCases(text: string): EvalCase[] {
  const ids = new Set<string>();
  return text.split(/\r?\n/u).flatMap((line, i) => {
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
}
