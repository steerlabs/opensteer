import { readdir, readFile } from "node:fs/promises";
import { agentTools } from "@opensteer/agent-tools";
import { isRecord } from "@opensteer/shared/isRecord";
import { expect, it } from "vitest";
import { partialMatch } from "./grader.js";
import { parseCases } from "./cases.js";

function responses(value: unknown): unknown[] {
  if (isRecord(value)) {
    if (typeof value.$error === "string") return [value];
    if (Array.isArray(value.$responses)) return value.$responses.flatMap(responses);
    if (Array.isArray(value.$byArgs))
      return value.$byArgs.flatMap((entry) => responses(isRecord(entry) ? entry.result : entry));
  }
  return [value];
}

it("validates every configured mock response against its production output schema", async () => {
  const failures: string[] = [];
  for (const file of await readdir(new URL("./cases/", import.meta.url))) {
    if (!file.endsWith(".ndjson")) continue;
    for (const c of parseCases(
      await readFile(new URL(`./cases/${file}`, import.meta.url), "utf8"),
    )) {
      for (const rule of [...c.expect.callsArgMatch, ...c.expect.notCallsArgMatch]) {
        if (!rule.after) continue;
        const after = rule.after;
        if (isRecord(after.result) && Object.keys(after.result).length === 0) continue;
        const mocks = Object.entries(c.mocks).filter(
          ([name]) => after.tool.split("|").includes(name) || after.tool === "*",
        );
        if (
          mocks.length &&
          !mocks.some(([, mock]) =>
            responses(mock).some((value) => partialMatch(value, after.result)),
          )
        )
          failures.push(`${c.id}: after.result matches no configured response for ${after.tool}`);
      }
      for (const [name, mock] of Object.entries(c.mocks)) {
        const tool = agentTools.find((tool) => tool.name === name);
        if (!tool) {
          failures.push(`${c.id}: unknown tool ${name}`);
          continue;
        }
        for (const value of responses(mock)) {
          if (isRecord(value) && typeof value.$error === "string") continue;
          const output = tool.output.safeParse(value);
          if (!output.success) failures.push(`${file}/${c.id}/${name}: ${output.error.message}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});
