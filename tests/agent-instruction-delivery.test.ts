import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("agent instruction delivery", () => {
  it("keeps profile instructions out of product MCP initialization", () => {
    const product = source("apps/host/src/agents/agent-tools-mcp-service.ts");
    expect(product).not.toContain("instructions: agentCapabilityProfile(");
  });

  it("keeps integration guidance out of MCP initialization", () => {
    const integration = source("apps/host/src/integrations/integration-tools-mcp-service.ts");
    const initialization = integration.slice(
      integration.indexOf("const server = new Server("),
      integration.indexOf("server.setRequestHandler(ListToolsRequestSchema"),
    );
    expect(initialization).not.toContain("instructions:");
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
