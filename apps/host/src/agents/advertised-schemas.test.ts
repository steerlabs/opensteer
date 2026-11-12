import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { agentTools } from "@opensteer/agent-tools";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { expect, it } from "vitest";
import { measureMcpContext } from "./agent-context-budget.test-support.js";

it.each(["run", "program", "connection"] as const)(
  "advertises compact schemas for %s callers with full input validation",
  async (kind) => {
    const context = await measureMcpContext(kind);
    const listed = JSON.parse(context.toolsJson) as {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
    const specs = agentTools.filter(
      (t) =>
        t.callers.some((c) => c === kind) &&
        !["team_read", "team_search", "team_reply", "sql"].includes(t.name),
    );
    expect(listed.map((t) => t.name)).toEqual(specs.map((t) => t.name));
    for (const spec of specs) {
      const schema = listed.find((t) => t.name === spec.name)!.inputSchema;
      expect(schema).toEqual(
        advertisedJsonSchema(
          toJsonSchemaCompat(spec.input, { strictUnions: true, pipeStrategy: "input" }),
        ),
      );
      expect(schema.type).toBe("object");
      expect(Object.keys(schema)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(?:oneOf|anyOf|allOf)$/u)]),
      );
    }
    expect(context.toolsJson).not.toMatch(/"(?:pattern|\$schema)":/u);
  },
);
