import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { startFakeHost } from "./host.js";

it("validates screen presentation mocks with the production tool contract", async () => {
  const testCase = parseCases(
    await readFile(new URL("./cases/screen-presentation.ndjson", import.meta.url), "utf8"),
  )[0]!;
  const host = await startFakeHost(testCase);
  const client = new Client({ name: "eval-screen-acceptance", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    expect((await client.listTools()).tools.some(({ name }) => name === "screen_show")).toBe(true);
    const args = testCase.expect.calls[0]!.args;
    expect(await client.callTool({ name: "screen_show", arguments: args })).toMatchObject({
      structuredContent: { outcome: "applied" },
    });
    const invalid = await client.callTool({
      name: "screen_show",
      arguments: { ...args, endpointRef: "private-endpoint" },
    });
    expect(invalid.isError).toBe(true);
    expect(host.calls.map(({ valid }) => valid)).toEqual([true, false]);
  } finally {
    await client.close();
    await host.close();
  }
});

it("serves the production inventory and validates mocked calls through real MCP HTTP", async () => {
  const c = parseCases(
    JSON.stringify({
      id: "transport",
      area: "transport",
      kind: "guard",
      source: { commit: "a".repeat(40), note: "production transport acceptance" },
      role: "work",
      profile: "main",
      turns: ["hi"],
      mocks: { integration_search: { $responses: [{ marker: "first" }, { marker: "second" }] } },
      expect: {},
    }),
  )[0]!;
  const host = await startFakeHost(c);
  const clients: Client[] = [];
  try {
    for (const name of ["agent", "integrations"]) {
      const client = new Client({ name: "eval-acceptance", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/${name}`, host.url), {
          requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
        }) as unknown as Transport,
      );
      expect((await client.listTools()).tools).toEqual(host.endpoints.get(name)?.tools);
      if (name === "integrations")
        expect(host.endpoints.get(name)?.tools.some(({ name }) => name === "computer")).toBe(true);
      const tool = name === "agent" ? "browser_profile_list" : "integration_search";
      const validArgs = name === "agent" ? {} : { query: "mail" };
      const valid = await client.callTool({ name: tool, arguments: validArgs });
      expect(valid.isError).not.toBe(true);
      if (name === "integrations") expect(JSON.stringify(valid)).toContain("first");
      const invalid = await client.callTool({ name: tool, arguments: { unexpected: true } });
      expect(invalid.isError).toBe(true);
      if (name === "integrations") {
        const second = await client.callTool({ name: tool, arguments: validArgs });
        expect(JSON.stringify(second)).toContain("second");
      }
    }
    expect(host.calls.map((call) => call.valid)).toEqual([true, false, true, false, true]);
    const out = await mkdtemp(join(tmpdir(), "opensteer-eval-mcp-evidence-"));
    await writeFile(
      join(out, "journey.json"),
      JSON.stringify(
        {
          calls: host.calls,
          inventories: [...host.endpoints].map(([name, endpoint]) => ({
            name,
            tools: endpoint.tools,
          })),
        },
        null,
        2,
      ),
    );
    console.log(`MCP journey evidence: ${out}/journey.json`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await host.close();
  }
}, 30_000);
