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

it("preserves production action validation before consuming mocks", async () => {
  const testCase = parseCases(
    JSON.stringify({
      id: "semantic-admission",
      area: "memory",
      kind: "guard",
      source: { commit: "a".repeat(40), note: "Flat schemas must retain handler validation" },
      profile: "main",
      role: "conversation",
      turns: ["hi"],
      expect: {},
      mocks: { trigger_write: { marker: "admitted" }, trigger_read: { marker: "admitted" } },
    }),
  )[0]!;
  const host = await startFakeHost(testCase);
  const client = new Client({ name: "semantic-validation", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    for (const [name, args] of [
      ["trigger_write", { action: "create" }],
      ["trigger_write", { action: "set_status", status: "paused" }],
      [
        "trigger_write",
        { action: "run", triggerId: "trg_00000000-0000-4000-8000-000000000011", name: "stray" },
      ],
      ["trigger_read", { action: "get" }],
      ["thread_delegate", { task: "Missing destination" }],
      ["browser_session_open", { fresh: true, sessionId: "existing" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("admitted");
      expect(host.calls.at(-1)?.valid).toBe(false);
    }
    const result = await client.callTool({
      name: "trigger_write",
      arguments: {
        action: "create",
        anchorThreadId: "thr_00000000-0000-4000-8000-000000000011",
        name: "Light memory pass",
        source: { kind: "schedule", cron: "*/30 8-22 * * *", timezone: "America/New_York" },
        program: {
          language: "javascript",
          toolContractVersion: 3,
          source: "export default async function () {}",
        },
      },
    });
    expect(JSON.stringify(result)).toContain("admitted");
    expect(host.calls.at(-1)?.valid).toBe(true);
  } finally {
    await client.close();
    await host.close();
  }
});
