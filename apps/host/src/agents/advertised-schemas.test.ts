import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { agentTools, connectionToolSchema, isRemovedConnectionTool } from "@opensteer/agent-tools";
import { discover } from "@opensteer/agent-tools/discover";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { expect, it } from "vitest";
import type { z } from "zod";
import { measureMcpContext } from "./agent-context-budget.test-support.js";

it.each(["run", "program", "connection"] as const)(
  "advertises compact schemas for %s callers with full input validation",
  async (kind) => {
    const context = await measureMcpContext(kind);
    const listed = JSON.parse(context.toolsJson) as {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
    const specs = (kind === "connection" ? [...agentTools, discover] : agentTools).filter(
      (t) =>
        t.callers.some((c) => c === kind) &&
        !(kind === "connection" && isRemovedConnectionTool(t.name)),
    );
    expect(listed.map((t) => t.name)).toEqual(specs.map((t) => t.name));
    for (const spec of specs) {
      const schema = listed.find((t) => t.name === spec.name)!.inputSchema;
      const input: z.ZodObject = spec.input;
      const expected = advertisedJsonSchema(
        kind === "connection"
          ? connectionToolSchema(spec, { scope: "everything" })
          : toJsonSchemaCompat(
              "operationId" in input.shape ? input.omit({ operationId: true }) : input,
              {
                strictUnions: true,
                pipeStrategy: "input",
              },
            ),
      );
      expect(schema).toEqual(expected);
      expect(schema.type).toBe("object");
      expect(Object.keys(schema)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(?:oneOf|anyOf|allOf)$/u)]),
      );
    }
    expect(context.toolsJson).not.toMatch(/"(?:pattern|\$schema)":/u);
  },
);
