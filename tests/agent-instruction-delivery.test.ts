import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("agent instruction delivery", () => {
  it("keeps guidance out of MCP initialization", () => {
    const service = source("apps/host/src/mcp/opensteer-mcp-service.ts");
    const initialization = service.slice(
      service.indexOf("new McpServer("),
      service.indexOf("const advertisedTools"),
    );
    expect(initialization).toContain("McpServer(");
    expect(initialization).not.toContain("instructions");
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
