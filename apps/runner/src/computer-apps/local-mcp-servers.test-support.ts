import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect } from "vitest";
import type { LocalMcpFrame, LocalMcpServers } from "./local-mcp-servers.js";

/**
 * A stdio MCP server: answers `initialize`, echoes a tool call's `text`, and
 * names its own pid for `pid`, so a test can prove it is gone afterwards.
 */
export const echoMcpServerSource = `
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { capabilities: { tools: {} }, protocolVersion: "2025-11-25", serverInfo: { name: "echo", version: "1" } }
    : { content: [{ text: message.params.name === "pid" ? String(process.pid) : message.params.arguments.text, type: "text" }] };
  process.stdout.write(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }) + "\\n");
});
`;

type OpenFrame = Parameters<LocalMcpServers["open"]>[0];
type StdioLaunch = Extract<OpenFrame["launch"], { readonly type: "stdio" }>;

/**
 * Opens one session on `servers`, initializes it, moves more than 1 MiB each
 * way through it, closes it and returns the server's pid.
 */
export async function exchangeOverOneMebibyte(
  servers: LocalMcpServers,
  launch: Omit<StdioLaunch, "type">,
): Promise<{ readonly frames: readonly LocalMcpFrame[]; readonly serverPid: number }> {
  const frames: LocalMcpFrame[] = [];
  const arrived = new Set<() => void>();
  servers.attach(async (frame) => {
    frames.push(frame);
    for (const check of arrived) check();
  });
  const next = (what: string, predicate: (frame: LocalMcpFrame) => boolean) =>
    withTimeout(
      new Promise<LocalMcpFrame>((resolve) => {
        const check = () => {
          const found = frames.find(predicate);
          if (!found) return;
          arrived.delete(check);
          resolve(found);
        };
        arrived.add(check);
        check();
      }),
      15_000,
      { timeoutError: () => new Error(`${what} never arrived`) },
    );
  const sessionId = "echo";
  const answer = async (id: number) => {
    const frame = await next(`The answer to request ${id}`, (candidate) =>
      candidate.type === "runner.integrations.mcp.message"
        ? (candidate.message as { id?: unknown }).id === id
        : candidate.type === "runner.integrations.mcp.closed",
    );
    if (frame.type !== "runner.integrations.mcp.message")
      throw new Error(`The session ended before answering ${id}: ${JSON.stringify(frame)}`);
    return frame.message as { result: { content?: { text: string }[] } };
  };
  const send = (message: unknown) =>
    servers.message({ message, sessionId } as Parameters<LocalMcpServers["message"]>[0]);

  await servers.open({ launch: { ...launch, type: "stdio" }, sessionId } as OpenFrame);
  await next("The opened session", (frame) => frame.type === "runner.integrations.mcp.opened");
  send({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} });
  await answer(1);
  const text = "x".repeat(400 * 1_024);
  for (const id of [2, 3, 4]) {
    send({
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { text }, name: "echo" },
    });
    expect((await answer(id)).result.content?.[0]?.text).toHaveLength(text.length);
  }
  send({ id: 5, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "pid" } });
  const serverPid = Number((await answer(5)).result.content?.[0]?.text);
  expect(serverPid).toBeGreaterThan(0);
  await servers.close({ sessionId });
  return { frames, serverPid };
}
