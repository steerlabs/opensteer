import { readdir, readFile } from "node:fs/promises";
import { agentTools } from "@opensteer/agent-tools";
import { isRecord } from "@opensteer/shared/isRecord";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";

function responses(value: unknown): unknown[] {
  if (isRecord(value)) {
    if (typeof value.$error === "string") return [];
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
      for (const [name, mock] of Object.entries(c.mocks)) {
        const tool = agentTools.find((tool) => tool.name === name);
        if (!tool) {
          failures.push(`${c.id}: unknown tool ${name}`);
          continue;
        }
        for (const value of responses(mock)) {
          const output = tool.output.safeParse(value);
          if (!output.success) failures.push(`${file}/${c.id}/${name}: ${output.error.message}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});
