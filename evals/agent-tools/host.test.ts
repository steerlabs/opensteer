import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { startFakeHost } from "./host.js";

it("returns a native runtime update refusal as an MCP tool error after validation", async () => {
  const testCase = parseCases(
    await readFile(new URL("./cases/browser.ndjson", import.meta.url), "utf8"),
  ).find((testCase) => testCase.id === "native-runtime-update-refusal")!;
  const host = await startFakeHost(testCase);
  const client = new Client({ name: "eval-profile-refusal", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    const call = testCase.expect.calls[0]!;
    const result = await client.callTool({ name: call.tool, arguments: call.args });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Update this computer to open this profile." }],
    });
    expect(host.calls).toEqual([{ ...call, valid: true }]);
    const invalid = await client.callTool({ name: call.tool, arguments: { unexpected: true } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).not.toEqual(result.content);
    expect(host.calls.at(-1)?.valid).toBe(false);
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
    for (const name of ["agent"]) {
      const client = new Client({ name: "eval-acceptance", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/${name}`, host.url), {
          requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
        }) as unknown as Transport,
      );
      expect((await client.listTools()).tools).toEqual(host.endpoints.get(name)?.tools);
      expect(host.endpoints.get(name)?.tools.some(({ name }) => name === "computer")).toBe(true);
      expect(host.endpoints.get(name)?.tools.some(({ name }) => name === "integration_call")).toBe(
        true,
      );
      const valid = await client.callTool({
        name: "integration_search",
        arguments: { query: "mail" },
      });
      expect(valid.isError).not.toBe(true);
      expect(JSON.stringify(valid)).toContain("first");
      const invalid = await client.callTool({
        name: "integration_search",
        arguments: { unexpected: true },
      });
      expect(invalid.isError).toBe(true);
      const second = await client.callTool({
        name: "integration_search",
        arguments: { query: "mail" },
      });
      expect(JSON.stringify(second)).toContain("second");
    }
    expect(host.endpoints.size).toBe(1);
    expect(host.calls.map((call) => call.valid)).toEqual([true, false, true]);
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

it("validates prompt overhaul case inputs and mocked positive calls with production boundaries", async () => {
  for (const file of ["integrations", "triggers", "browser"]) {
    const cases = parseCases(
      await readFile(new URL(`./cases/${file}.ndjson`, import.meta.url), "utf8"),
    );
    for (const c of cases.filter(
      (c) => c.source.commit === "b0efe75413a275f2e4a5cb06d1606fae7cd96713",
    )) {
      const host = await startFakeHost(c);
      const clients: Client[] = [];
      try {
        for (const required of c.expect.calls) {
          const endpoint = [...host.endpoints].find(([, endpoint]) =>
            endpoint.tools.some((t) => t.name === required.tool),
          );
          expect(endpoint, `${c.id}: ${required.tool} is offered`).toBeDefined();
          const client = new Client({ name: "eval-case-validation", version: "1" });
          clients.push(client);
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`/${endpoint![0]}`, host.url), {
              requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
            }) as unknown as Transport,
          );
          const args =
            required.tool === "computer"
              ? { code: 'return await app("Notes")' }
              : required.tool === "integration_call"
                ? { ...required.args, arguments: {} }
                : required.tool === "integration_search"
                  ? { query: "Notes" }
                  : required.args;
          await client.callTool({
            name: required.tool,
            arguments:
              required.tool === "sign_in"
                ? { ...args, reason: "Check the assigned account" }
                : args,
          });
          expect(host.calls.at(-1)?.valid, `${c.id}: ${required.tool} args`).toBe(true);
        }
      } finally {
        await Promise.allSettled(clients.map((c) => c.close()));
        await host.close();
      }
    }
  }
});

it("validates the new surface cases with each caller's production inventory", async () => {
  const cases = parseCases(
    await readFile(new URL("./cases/surface.ndjson", import.meta.url), "utf8"),
  );
  for (const c of cases) {
    const host = await startFakeHost(c);
    const client = new Client({ name: "eval-surface", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/agent", host.url), {
          requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
        }) as unknown as Transport,
      );
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.includes("thread_wait")).toBe(c.caller === "connection");
      expect(!!client.getInstructions()).toBe(c.caller === "connection");
      for (const required of c.expect.calls) {
        expect(names, c.id).toContain(required.tool);
        await client.callTool({
          name: required.tool,
          arguments: {
            ...required.args,
            ...(["integration_request", "sign_in"].includes(required.tool)
              ? { reason: "Complete the account check" }
              : {}),
            ...(required.tool === "thread_delegate" ? { task: "Compare vendors" } : {}),
          },
        });
        expect(host.calls.at(-1)?.valid, `${c.id}: ${required.tool}`).toBe(true);
      }
      if (c.caller === "connection") {
        const result = await client.callTool({
          name: "sign_in",
          arguments: { site: "example.com", reason: "Check account" },
        });
        expect(result.isError).toBe(true);
        expect(host.calls.at(-1)?.valid).toBe(false);
      }
    } finally {
      await client.close();
      await host.close();
    }
  }
});
