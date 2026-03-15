import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
} from "./phase6-fixture.js";

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

describe("Opensteer MCP server", () => {
  test("lists semantic tools and returns screenshot image content for computer.execute", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const fixtureServer = await startPhase6FixtureServer();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "packages/opensteer/src/cli/bin.ts",
        "mcp",
        "--name",
        "phase9-mcp-server",
        "--root-dir",
        rootDir,
      ],
      env: process.env as Record<string, string>,
    });
    const client = new Client({
      name: "opensteer-vitest",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);

      const listed = await client.listTools();
      const toolNames = listed.tools.map((tool) => tool.name);
      expect(toolNames).toContain("opensteer_session_open");
      expect(toolNames).toContain("opensteer_computer_execute");

      await client.callTool({
        name: "opensteer_session_open",
        arguments: {
          url: `${fixtureServer.url}/phase6/main`,
          browser: {
            headless: true,
          },
        },
      });

      const result = await client.callTool({
        name: "opensteer_computer_execute",
        arguments: {
          action: {
            type: "screenshot",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.content?.some((entry) => entry.type === "image")).toBe(true);
      const image = result.content?.find(
        (entry): entry is Extract<(typeof result.content)[number], { readonly type: "image" }> =>
          entry.type === "image",
      );
      expect(image?.mimeType).toBe("image/png");
      expect(typeof image?.data).toBe("string");
      expect(image?.data.length).toBeGreaterThan(0);
      expect(
        (
          result.structuredContent as {
            readonly screenshot?: { readonly payload?: { readonly data?: string } };
          }
        ).screenshot?.payload?.data,
      ).toBe(image?.data);

      await client.callTool({
        name: "opensteer_session_close",
        arguments: {},
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
