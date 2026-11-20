import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { PluginElicit } from "../plugins/plugin-service.js";
import { InputCall, ServerInput } from "./server-input.js";

describe("computer MCP call deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps ordinary calls at one minute and extends input to three minutes total", async () => {
    vi.useFakeTimers();
    const callable = {} as CallableIntegrationTool;
    const caller = { run: null, threadId: createId("thread"), agentBindingId: "trigger:test" };
    const ordinary = new InputCall(callable, caller);
    const input = new InputCall(callable, caller);
    try {
      await vi.advanceTimersByTimeAsync(50_000);
      input.extend();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ordinary.signal.aborted, "An ordinary call must still expire after one minute").toBe(
        true,
      );
      expect(input.signal.aborted, "The input call must outlive its original deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      input.extend();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(input.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        input.signal.aborted,
        "A second elicitation must not extend the total beyond three minutes",
      ).toBe(true);
    } finally {
      await ordinary.close();
      await input.close();
    }
  });
});

it("keeps an accepted answer out of later questions on the same MCP session", async () => {
  const input = new ServerInput();
  const client = new Client(
    { name: "input-client", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const server = new Server({ name: "input-server", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const secret = "Q!Z?";
  const elicit = vi
    .fn<PluginElicit>()
    .mockResolvedValueOnce({ action: "accept", content: { code: secret } })
    .mockResolvedValueOnce({ action: "decline" });
  const caller = {
    run: null,
    threadId: createId("thread"),
    agentBindingId: "trigger:test",
    elicit,
  };
  input.register(client);
  try {
    await withTimeout(
      (async () => {
        await server.connect(a);
        await client.connect(b);
        const first = input.start(client, {} as CallableIntegrationTool, caller);
        expect(
          await server.elicitInput({
            message: "Pairing code",
            requestedSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          }),
        ).toEqual({ action: "accept", content: { code: secret } });
        await input.finish(client, first);
        input.start(client, {} as CallableIntegrationTool, caller);
        expect(
          await server.elicitInput({
            message: `Previous ${secret}`,
            requestedSchema: {
              type: "object",
              properties: {
                next: {
                  type: "string",
                  title: `Repeat ${secret}`,
                  description: `Previous ${secret}`,
                },
              },
              required: ["next"],
            },
          }),
        ).toEqual({ action: "decline" });
        expect(elicit).toHaveBeenCalledTimes(2);
        expect(elicit.mock.calls[1]![0]).toMatchObject({
          message: "Previous ****",
          requestedSchema: {
            properties: { next: { title: "Repeat ****", description: "Previous ****" } },
          },
        });
        expect(JSON.stringify(elicit.mock.calls)).not.toContain(secret);
      })(),
      2_000,
      { timeoutError: () => new Error("The MCP input round trips did not finish") },
    );
  } finally {
    await withTimeout(Promise.all([input.close(), client.close(), server.close()]), 1_000, {
      timeoutError: () => new Error("The MCP input session did not close"),
    });
  }
});
