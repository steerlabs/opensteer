import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  piExtensionSource,
  piHandshakePrefix,
  type PiExtensionPlan,
  type PiExtensionToolDefinition,
} from "./extension.js";
import { piAccessModeGate, piCommandTools, piFileChangeTools, piReadOnlyTools } from "./sources.js";

/** Executes the generated file; registration/validation also use pinned Pi below. */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const knownTools = [...piCommandTools, ...piFileChangeTools, ...piReadOnlyTools];
const notice = "No other computers are reachable from this Run.";

const threadRead: PiExtensionToolDefinition = {
  description: "Read a Thread",
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: { description: "How many", type: "integer", minimum: 1, maximum: 5, default: 3 },
      mode: { description: "Which mode", enum: ["fast", "thorough"] },
      query: { description: "What to look for", type: "string", pattern: "^[a-z]+$", minLength: 2 },
      tags: { items: { type: "string" }, type: "array" },
    },
    required: ["query"],
    type: "object",
  },
  name: "thread_read",
  server: "opensteer",
};

describe("the generated Opensteer extension", () => {
  it("gates a command in approval-required and lets an allow through", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    const asked: string[] = [];
    const ctx = stubContext({ answer: JSON.stringify({ decision: "allow" }), asked });
    const result = await extension.toolCall(
      { input: { command: "rm -rf /tmp/x" }, toolCallId: "call_1", toolName: "bash" },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(JSON.parse(asked[0] ?? "{}")).toEqual({
      input: { command: "rm -rf /tmp/x" },
      kind: "command",
      toolCallId: "call_1",
      toolName: "bash",
      v: 1,
    });
  });

  it("blocks a denial and carries the person's note to the model", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    const withNote = await extension.toolCall(
      { input: { command: "curl evil" }, toolCallId: "c", toolName: "bash" },
      stubContext({ answer: JSON.stringify({ decision: "deny", note: "not on a Friday" }) }),
    );
    expect(withNote).toEqual({ block: true, reason: "not on a Friday" });

    const withoutNote = await extension.toolCall(
      { input: { command: "curl evil" }, toolCallId: "c", toolName: "bash" },
      stubContext({ answer: JSON.stringify({ decision: "deny" }) }),
    );
    expect(withoutNote).toEqual({
      block: true,
      reason: "Denied by the person supervising this Run",
    });
  });

  it("asks for a file change in approval-required and not in auto-accept-edits", async () => {
    const strict = await loadExtension({ accessMode: "approval-required" });
    const strictAsked: string[] = [];
    await strict.toolCall(
      { input: { edits: [], path: "/w/a.ts" }, toolCallId: "c", toolName: "edit" },
      stubContext({ answer: JSON.stringify({ decision: "allow" }), asked: strictAsked }),
    );
    expect(JSON.parse(strictAsked[0] ?? "{}").kind).toBe("file-change");

    const edits = await loadExtension({ accessMode: "auto-accept-edits" });
    const editsAsked: string[] = [];
    const write = await edits.toolCall(
      { input: { content: "x", path: "/w/a.ts" }, toolCallId: "c", toolName: "write" },
      stubContext({ answer: "never used", asked: editsAsked }),
    );
    expect(write).toBeUndefined();
    expect(editsAsked).toEqual([]);
    // A command is still gated in that mode.
    await edits.toolCall(
      { input: { command: "ls" }, toolCallId: "c", toolName: "bash" },
      stubContext({ answer: JSON.stringify({ decision: "allow" }), asked: editsAsked }),
    );
    expect(JSON.parse(editsAsked[0] ?? "{}").kind).toBe("command");
  });

  it("asks for nothing in full-access", async () => {
    const extension = await loadExtension({ accessMode: "full-access" });
    const asked: string[] = [];
    for (const [toolName, input] of [
      ["bash", { command: "ls" }],
      ["powershell", { command: "ls" }],
      ["edit", { edits: [], path: "/w/a.ts" }],
      ["write", { content: "x", path: "/w/a.ts" }],
    ] as const) {
      expect(
        await extension.toolCall(
          { input, toolCallId: "c", toolName },
          stubContext({ answer: "never used", asked }),
        ),
      ).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  it("never gates a read-only tool or one of Opensteer's own", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    const asked: string[] = [];
    for (const toolName of [...piReadOnlyTools, "thread_read"]) {
      expect(
        await extension.toolCall(
          { input: {}, toolCallId: "c", toolName },
          stubContext({ answer: "never used", asked }),
        ),
      ).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  it("blocks a tool this driver was never written against, in every mode", async () => {
    for (const accessMode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      const extension = await loadExtension({ accessMode });
      const asked: string[] = [];
      expect(
        await extension.toolCall(
          { input: {}, toolCallId: "c", toolName: "browser_use" },
          stubContext({ answer: "never used", asked }),
        ),
      ).toEqual({
        block: true,
        reason: "Opensteer does not recognise the tool browser_use and blocked it.",
      });
      expect(asked).toEqual([]);
    }
  });

  it("blocks when it cannot reach a person, or when the answer never comes back", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    expect(
      await extension.toolCall(
        { input: { command: "ls" }, toolCallId: "c", toolName: "bash" },
        stubContext({ answer: "irrelevant", hasUI: false }),
      ),
    ).toEqual({
      block: true,
      reason: "Opensteer could not reach the person to approve this action.",
    });
    for (const answer of [undefined, "not json at all", JSON.stringify({ decision: "maybe" })]) {
      expect(
        await extension.toolCall(
          { input: { command: "ls" }, toolCallId: "c", toolName: "bash" },
          stubContext({ answer }),
        ),
      ).toEqual({
        block: true,
        reason: expect.stringMatching(/cancelled this approval|Denied by the person/u),
      });
    }
  });

  it("announces itself at session start with this session's nonce", async () => {
    const extension = await loadExtension({ accessMode: "approval-required", nonce: "nonce-42" });
    const notified: { message: string; type: string }[] = [];
    const ctx = stubContext({ answer: "unused", notified });
    await extension.sessionStart({}, ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.type).toBe("info");
    const message = notified[0]?.message ?? "";
    expect(message.startsWith(piHandshakePrefix)).toBe(true);
    expect(JSON.parse(message.slice(piHandshakePrefix.length))).toEqual({
      hasUi: true,
      nonce: "nonce-42",
      tools: ["thread_read"],
    });
  });

  it("appends the machine-access notice to every turn's system prompt", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    expect(await extension.beforeAgentStart({ systemPrompt: "Pi's own prompt." })).toEqual({
      systemPrompt: `Pi's own prompt.\n\n${notice}`,
    });
  });

  it("registers Opensteer's tools and runs one through the driver", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    expect(extension.tools.map((tool) => tool.name)).toEqual(["thread_read"]);
    expect(extension.tools[0]?.description).toBe("Read a Thread");

    const asked: string[] = [];
    const result = await extension.tools[0]?.execute(
      "call_9",
      { query: "recent" },
      undefined,
      undefined,
      stubContext({
        answer: JSON.stringify({
          content: [{ text: "served", type: "text" }],
          isError: false,
        }),
        asked,
      }),
    );
    expect(JSON.parse(asked[0] ?? "{}")).toEqual({
      arguments: { query: "recent" },
      kind: "tool",
      name: "thread_read",
      server: "opensteer",
      toolCallId: "call_9",
      v: 1,
    });
    expect(result).toEqual({ content: [{ text: "served", type: "text" }], details: {} });
  });

  it("throws a failed Opensteer tool call, because Pi only marks a throw as an error", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    const tool = extension.tools[0];
    if (!tool) throw new Error("Expected a registered tool");
    await expect(
      tool.execute(
        "c",
        {},
        undefined,
        undefined,
        stubContext({
          answer: JSON.stringify({
            content: [{ text: "the Host refused", type: "text" }],
            isError: true,
          }),
        }),
      ),
    ).rejects.toThrow("the Host refused");
    await expect(
      tool.execute("c", {}, undefined, undefined, stubContext({ answer: undefined })),
    ).rejects.toThrow(/did not answer the thread_read call/u);
  });

  it("registers and validates the advertised schema through pinned Pi", async () => {
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
    const piRoot = dirname(dirname(piEntry));
    const {
      loadExtensions,
    }: {
      loadExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult>;
    } = await import(pathToFileURL(join(piRoot, "core/extensions/loader.js")).href);
    const {
      validateToolArguments,
    }: {
      validateToolArguments(
        tool: { name: string; parameters: unknown },
        call: { id: string; name: string; arguments: unknown; type: "toolCall" },
      ): unknown;
    } = await import(pathToFileURL(join(piRoot, "../../pi-ai/dist/utils/validation.js")).href);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-pi-registration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "extension.mjs");
    await writeFile(
      path,
      piExtensionSource({
        gate: piAccessModeGate("full-access"),
        handshakeNonce: "validation",
        knownTools,
        machineAccessNotice: notice,
        tools: [threadRead],
      }),
    );
    const loaded = await loadExtensions([path], directory);
    expect(loaded.errors).toEqual([]);
    const tool = loaded.extensions[0]?.tools.get("thread_read")?.definition;
    if (!tool) throw new Error("Pi did not register thread_read");
    expect(tool.parameters).toEqual(threadRead.inputSchema);
    const validate = (args: unknown) =>
      validateToolArguments(tool, {
        id: "call",
        name: "thread_read",
        arguments: args,
        type: "toolCall",
      });
    expect(validate({ query: "recent", mode: "fast", limit: 2 })).toEqual({
      query: "recent",
      mode: "fast",
      limit: 2,
    });
    expect(validate({ query: "ok", tags: [false] })).toEqual({ query: "ok", tags: ["false"] });
    for (const args of [
      {},
      { query: "X" },
      { query: "ok", limit: 0 },
      { query: "ok", limit: 6 },
      { query: "ok", mode: "invalid" },
      { query: "ok", extra: true },
    ]) {
      expect(() => validate(args), JSON.stringify(args)).toThrow(/Validation failed/);
    }
  });

  it("preserves the Host JSON Schema exactly at registration", async () => {
    const extension = await loadExtension({ accessMode: "approval-required" });
    expect(extension.tools[0]?.parameters).toEqual(threadRead.inputSchema);
  });
});

interface LoadedExtension {
  readonly tools: readonly {
    readonly description: string;
    readonly name: string;
    readonly parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<{ readonly content: unknown; readonly details: unknown }>;
  }[];
  beforeAgentStart(event: { readonly systemPrompt: string }): Promise<{ systemPrompt: string }>;
  sessionStart(event: unknown, ctx: unknown): Promise<void>;
  toolCall(
    event: { readonly input: unknown; readonly toolCallId: string; readonly toolName: string },
    ctx: unknown,
  ): Promise<{ readonly block?: boolean; readonly reason?: string } | undefined>;
}

async function loadExtension(options: {
  readonly accessMode: Parameters<typeof piAccessModeGate>[0];
  readonly nonce?: string;
  readonly tools?: readonly PiExtensionToolDefinition[];
}): Promise<LoadedExtension> {
  const plan: PiExtensionPlan = {
    gate: piAccessModeGate(options.accessMode),
    handshakeNonce: options.nonce ?? "nonce-test",
    knownTools,
    machineAccessNotice: notice,
    tools: options.tools ?? [threadRead],
  };
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pi-extension-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "opensteer-extension.mjs");
  await writeFile(path, piExtensionSource(plan));
  const module = (await import(pathToFileURL(path).href)) as {
    default: (pi: unknown) => void;
  };

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools: LoadedExtension["tools"][number][] = [];
  module.default({
    on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    registerTool: (definition: LoadedExtension["tools"][number]) => tools.push(definition),
  });
  const handler = (event: string) => {
    const found = handlers.get(event);
    if (!found) throw new Error(`The extension registered no ${event} handler`);
    return found;
  };
  return {
    beforeAgentStart: async (event) =>
      (await handler("before_agent_start")(event)) as { systemPrompt: string },
    sessionStart: async (event, ctx) => {
      await handler("session_start")(event, ctx);
    },
    toolCall: async (event, ctx) =>
      (await handler("tool_call")(event, ctx)) as
        { readonly block?: boolean; readonly reason?: string } | undefined,
    tools,
  };
}

function stubContext(options: {
  readonly answer: string | undefined;
  readonly asked?: string[];
  readonly hasUI?: boolean;
  readonly notified?: { message: string; type: string }[];
}) {
  return {
    hasUI: options.hasUI ?? true,
    ui: {
      input: async (title: string) => {
        options.asked?.push(title);
        return options.answer;
      },
      notify: (message: string, type: string) => {
        options.notified?.push({ message, type });
      },
    },
  };
}
