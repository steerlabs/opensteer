import { describe, expect, it } from "vitest";
import { antigravityToolIdentity } from "./tool-identity.js";

const context = { agentTools: { tools: ["opensteer_task_read"] } } as Parameters<
  typeof antigravityToolIdentity
>[1];

describe("Antigravity tool identity", () => {
  it("names calls by agy's title convention, never by free text", () => {
    const name = (call: Parameters<typeof antigravityToolIdentity>[0]) =>
      antigravityToolIdentity(call, context);
    expect(name({ id: "1", kind: "read", title: "Running view_file" })).toEqual({
      name: "view_file",
      namespace: "antigravity",
    });
    expect(name({ id: "2", kind: "search", title: "Run grep_search?" })).toEqual({
      name: "grep_search",
      namespace: "antigravity",
    });
    expect(name({ id: "3", kind: "execute", title: `ls ${"x".repeat(400)}` })).toEqual({
      name: "run_command",
      namespace: "antigravity",
    });
    expect(name({ id: "4", kind: "other", title: "Running opensteer_task_read" })).toEqual({
      name: "opensteer_task_read",
      namespace: "opensteer",
    });
    // Structured MCP fields and unknown titles fall through to the ACP identity.
    expect(
      name({ id: "5", meta: { mcp: { server: "opensteer", tool: "x" } }, title: "opensteer_x" }),
    ).toBeUndefined();
    expect(name({ id: "6", kind: "other", title: "Thinking about it" })).toBeUndefined();
  });
});
