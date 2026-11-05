import { writeFile, mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
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
    expect(result).toMatchObject({
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
      mocks: {
        integration_search: { $responses: [{ marker: "first" }, { marker: "second" }] },
        trigger_read: {
          $byArgs: [{ args: { systemRole: "memory-light" }, result: { marker: "light" } }],
        },
      },
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
    const byArgs = async (args: Record<string, unknown>) =>
      JSON.stringify(await clients[0]!.callTool({ name: "trigger_read", arguments: args }));
    expect(await byArgs({ action: "list", systemRole: "memory-light" })).toContain("light");
    expect(await byArgs({ action: "list" })).toContain("No case mock matches these arguments");
    expect(host.calls.map((call) => call.valid)).toEqual([true, false, true, true, true]);
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

it("closes once when a chained sample's stage and final cleanup both close it", async () => {
  const c = parseCases(
    JSON.stringify({
      id: "close-twice",
      area: "transport",
      kind: "guard",
      source: { commit: "a".repeat(40), note: "chained samples close each stage's Host" },
      role: "work",
      profile: "main",
      turns: ["hi"],
      expect: {},
    }),
  )[0]!;
  const host = await startFakeHost(c);
  await host.close();
  await expect(host.close()).resolves.toBeUndefined();
});

it("retains ingress file failures even if the agent recreates memory before later calls", async () => {
  const c = parseCases(
    await readFile(new URL("./cases/memory.ndjson", import.meta.url), "utf8"),
  ).find((c) => c.id === "memory-stop-when-idle")!;
  const workspace = await mkdtemp(join(tmpdir(), "eval-boundary-"));
  const host = await startFakeHost(c, workspace);
  const client = new Client({ name: "eval-boundary", version: "1" });
  try {
    await mkdir(join(workspace, "skills/light-pass"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Memory: off at the person's request.\n");
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    const pause = c.expect.calls.find((call) => call.tool === "trigger_write")!;
    await client.callTool({ name: pause.tool, arguments: pause.args });
    expect(host.boundaryChecks.some((check) => !check.pass)).toBe(true);
    await mkdir(join(workspace, "memory"));
    await client.callTool({ name: pause.tool, arguments: pause.args });
    expect(host.calls.at(-1)?.result).toMatchObject({ status: "paused" });
    expect(host.boundaryChecks.some((check) => !check.pass)).toBe(true);
  } finally {
    await client.close();
    await host.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("reads back successful Trigger writes and the requested one-shot time", async () => {
  const c = parseCases(
    await readFile(new URL("./cases/memory.ndjson", import.meta.url), "utf8"),
  ).find((c) => c.id === "memory-stop-while-running")!;
  const host = await startFakeHost(c);
  const client = new Client({ name: "eval-trigger-state", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    const pause = c.expect.calls.find(
      (call) => call.tool === "trigger_write" && call.args.status === "paused",
    )!;
    await client.callTool({ name: pause.tool, arguments: pause.args });
    await client.callTool({
      name: "trigger_read",
      arguments: { action: "get", triggerId: pause.args.triggerId },
    });
    expect(host.calls.at(-1)?.result).toMatchObject({
      trigger: { status: "paused", nextFireAt: null },
    });
    await client.callTool({
      name: "trigger_write",
      arguments: {
        action: "create",
        name: "Reminder: finish deleting memory",
        anchorThreadId: "home",
        source: { kind: "schedule", at: "2027-01-01T09:05:00-05:00" },
        program: {
          language: "typescript",
          toolContractVersion: 3,
          source: "export default async function () {}",
        },
      },
    });
    const created = host.calls.at(-1)?.result;
    expect(created).toMatchObject({ nextFireAt: "2027-01-01T14:05:00.000Z" });
    await client.callTool({
      name: "trigger_read",
      arguments: { action: "get", triggerId: "trg_00000000-0000-4000-8000-000000000099" },
    });
    expect(host.calls.at(-1)?.result).toMatchObject({ trigger: created });
  } finally {
    await client.close();
    await host.close();
  }
});

it("reads back a source-only schedule change while retaining the person's pause", async () => {
  const c = parseCases(
    await readFile(new URL("./cases/memory.ndjson", import.meta.url), "utf8"),
  ).find((c) => c.id === "memory-nightly-tunes-paused-light")!;
  const host = await startFakeHost(c);
  const client = new Client({ name: "eval-trigger-source", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/agent", host.url), {
        requestInit: { headers: { Authorization: `Bearer ${host.secret}` } },
      }) as unknown as Transport,
    );
    const update = c.expect.calls[0]!;
    await client.callTool({ name: update.tool, arguments: update.args });
    await client.callTool({
      name: "trigger_read",
      arguments: { action: "get", triggerId: update.args.triggerId },
    });
    expect(host.calls.at(-1)?.result).toMatchObject({
      trigger: { status: "paused", nextFireAt: null },
      revision: {
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
        },
      },
    });
  } finally {
    await client.close();
    await host.close();
  }
});
