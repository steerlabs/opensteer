import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("agent instruction delivery", () => {
  it("gives MCP initialization guidance only to connected agents", () => {
    // Runs receive their guide through the Run plan; an external agent has no
    // plan, so its orientation travels with MCP initialization instead.
    const service = source("apps/host/src/mcp/opensteer-mcp-service.ts");
    const initialization = service.slice(
      service.indexOf("new McpServer("),
      service.indexOf("const advertisedTools"),
    );
    expect(initialization).toContain("McpServer(");
    expect(initialization.match(/instructions/g)).toEqual(["instructions"]);
    expect(initialization).toContain(
      'caller.kind === "connection" ? { instructions: connectionInstructions } : {}',
    );
  });

  it.each(["claude", "codex", "cursor", "opencode", "pi"])(
    "%s consumes the Run platform guide",
    (engine) => {
      expect(source(`packages/harness-${engine}/src/${engine}-driver.ts`)).toContain(
        "context.platformGuide",
      );
    },
  );
});
