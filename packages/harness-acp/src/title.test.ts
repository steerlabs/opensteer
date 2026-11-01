import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateContainedAcpTitle } from "./title.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("contained ACP title generation", () => {
  it("advertises no tools or file access and exits before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-acp-title-"));
    temporaryDirectories.push(directory);
    const evidence = join(directory, "evidence.json");
    const agent = await writeAgent(directory);

    const result = await generateContainedAcpTitle({
      clientInfo: { name: "zed", version: "0.0.0" },
      initializeDeadlineMs: 2_000,
      launch: {
        args: [agent, evidence],
        cwd: directory,
        environment: { PATH: process.env.PATH ?? "" },
        executable: process.execPath,
      },
      modeId: "default",
      prompt: "Name only this input",
      protocolVersion: 1,
      sessionMetadata: { antigravity: { enabledTools: [] } },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      sessionId: "10000000-0000-4000-8000-000000000001",
      text: "Contained title",
    });
    const rows = (await readFile(evidence, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows[1]).toMatchObject({
      initialize: {
        clientCapabilities: { session: { configOptions: { boolean: {} } }, terminal: false },
        clientInfo: { name: "zed", version: "0.0.0" },
      },
    });
    expect(rows[2]).toEqual({
      session: {
        _meta: { antigravity: { enabledTools: [] } },
        additionalDirectories: [],
        cwd: directory,
        mcpServers: [],
      },
    });
    expect(() => process.kill((rows[0]?.pid as number) ?? 0, 0)).toThrow();
  });

  it("reads a long prompt's traffic and ends an engine that never answers session close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-acp-title-"));
    temporaryDirectories.push(directory);
    const evidence = join(directory, "evidence.json");
    const agent = await writeAgent(directory);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let settled = false;
    const generation = generateContainedAcpTitle({
      clientInfo: { name: "zed", version: "0.0.0" },
      initializeDeadlineMs: 2_000,
      launch: {
        args: [agent, evidence, JSON.stringify({ ignoreClose: true, thoughtBytes: 160 * 1_024 })],
        cwd: directory,
        environment: { PATH: process.env.PATH ?? "" },
        executable: process.execPath,
      },
      modeId: "default",
      prompt: "Name only this input",
      protocolVersion: 1,
      signal: new AbortController().signal,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(
      async () => {
        expect(
          await readFile(evidence, "utf8"),
          "the title prompt never reached session close",
        ).toContain('"close":true');
      },
      { timeout: 3_000 },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(
      () => {
        if (!settled) throw new Error("title cleanup never finished after the close deadline");
      },
      { timeout: 2_000 },
    );
    await expect(generation).resolves.toMatchObject({ text: "Contained title" });
  });
});

async function writeAgent(directory: string): Promise<string> {
  const agent = join(directory, "agent.mjs");
  await writeFile(
    agent,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const evidence = process.argv[2];
const behavior = JSON.parse(process.argv[3] ?? "{}");
const sessionId = "10000000-0000-4000-8000-000000000001";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
appendFileSync(evidence, JSON.stringify({ pid: process.pid }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    appendFileSync(evidence, JSON.stringify({ initialize: message.params }) + "\\n");
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
      agentInfo: { name: "contained-test", version: "1.0.0" }
    }});
  } else if (message.method === "session/new") {
    appendFileSync(evidence, JSON.stringify({ session: message.params }) + "\\n");
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId,
      configOptions: [],
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }
    }});
  } else if (message.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    for (let sent = 0; sent < (behavior.thoughtBytes ?? 0); sent += 1_024) {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t".repeat(1_024) } }
      }});
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Contained title" } }
    }});
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/close") {
    appendFileSync(evidence, JSON.stringify({ close: true }) + "\\n");
    if (!behavior.ignoreClose) send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`,
  );
  return agent;
}
