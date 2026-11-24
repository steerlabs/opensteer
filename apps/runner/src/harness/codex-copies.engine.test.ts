import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  harnessKindRecord,
  HarnessIdSchema,
  ModelSelectionSchema,
  type HarnessId,
} from "@opensteer/core";
import type { HarnessEvent, HarnessSessionContext } from "@opensteer/harness";
import { packagedCodexExecutable } from "@opensteer/harness-codex";
import { afterEach, expect, it, vi } from "vitest";
import { createHarnessRegistry } from "./harness-registry.js";

/**
 * The person's only Codex is older than Opensteer supports: the real old
 * executable is first and alone on PATH (`OPENSTEER_OLD_CODEX`, its version in
 * `OPENSTEER_OLD_CODEX_VERSION`). Their own sign-in runs on the Codex this
 * Runner ships instead: inspection answers (the old one fails its own version
 * check), a turn runs against a local stand-in for the Responses API, and Stop
 * ends it. Nothing reads the computer's own Codex configuration.
 */
const oldCodex = process.env.OPENSTEER_OLD_CODEX;
const oldVersion = process.env.OPENSTEER_OLD_CODEX_VERSION;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function stubApi() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.url?.startsWith("/mcp")) {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                capabilities: { tools: {} },
                protocolVersion: "2025-06-18",
                serverInfo: { name: "opensteer", version: "1.0.0" },
              }
            : message.method === "tools/list"
              ? { tools: [] }
              : message.method === "resources/list"
                ? { resources: [] }
                : message.method === "resources/templates/list"
                  ? { resourceTemplates: [] }
                  : {};
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
        return;
      }
      if (!request.url?.includes("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (data: Record<string, unknown>) =>
        response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      send({ response: { id: "resp_1" }, type: "response.created" });
      send({
        item: {
          content: [{ text: "done", type: "output_text" }],
          id: "msg_1",
          role: "assistant",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.done",
      });
      send({
        response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        type: "response.completed",
      });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stub address");
  return {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
  };
}

it.skipIf(!oldCodex || !oldVersion)(
  "runs the person's own Codex sign-in on Opensteer's Codex when theirs is too old",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-codex-copies-")));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const bin = join(root, "bin");
    const home = join(root, "home");
    const codexHome = join(home, ".codex");
    const project = join(root, "agent-home");
    const state = join(root, "state");
    await mkdir(bin, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(join(state, "threads", "thread"), { recursive: true });
    await symlink(oldCodex!, join(bin, "codex"));
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    const api = await stubApi();
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-local-stub", auth_mode: "apikey" }),
    );
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "stub"',
        "",
        "[model_providers.stub]",
        'name = "stub"',
        `base_url = "${api.url}"`,
        'wire_api = "responses"',
        'env_key = "STUB_API_KEY"',
        "",
        `[projects."${project}"]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    const environment = {
      CODEX_HOME: codexHome,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_API_KEY: "local-stub",
      TMPDIR: state,
    };
    const codex = HarnessIdSchema.parse("codex") as HarnessId;
    const harnesses = createHarnessRegistry(
      harnessKindRecord((kind) => (kind === "codex" ? packagedCodexExecutable() : `/none/${kind}`)),
      { nodeExecutable: process.execPath, runtimeCacheDirectory: join(root, "runtime-cache") },
    );
    cleanups.push(() => harnesses.close());
    await expect(harnesses.installationNotice(codex)).resolves.toBe(
      `Using Opensteer’s own Codex 0.162.0: the one on this computer (${oldVersion}) is too old.`,
    );

    const definition = {
      config: {},
      driverKind: codex,
      id: createId("harnessInstance"),
      name: "Codex",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "ambient" as const,
    };
    const providerState = {
      continuationKey: root,
      kind: "ambient" as const,
      privateStateRoot: state,
      providerHomeDirectory: undefined,
      store: { directory: codexHome, id: "codex-copies" },
    };
    harnesses.configureInstance(definition);
    // The old copy would fail its own version check here; Opensteer's answers.
    let inspected = await harnesses.inspectDefinition(
      definition,
      environment,
      providerState,
      project,
      AbortSignal.timeout(120_000),
    );
    for (let attempt = 0; inspected.status === "preparing" && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      inspected = await harnesses.inspectDefinition(
        definition,
        environment,
        providerState,
        project,
        AbortSignal.timeout(120_000),
      );
    }
    // The engine answered for itself: an old copy refuses here as "older than".
    // The stand-in's API key is no OpenAI account, so it asks for a sign-in;
    // a turn needs none against the stand-in.
    expect(inspected).not.toMatchObject({ detail: expect.stringContaining("older than") });
    expect(["authentication-required", "ready"]).toContain(inspected.status);

    const adapter = await harnesses.adapter(definition.id);
    const context: HarnessSessionContext = {
      accessMode: "full-access",
      agentTools: {
        instructions: "",
        skills: [],
        token: "local-stub",
        tools: [],
        toolsRevision: "codex-copies",
        url: api.mcpUrl,
      },
      commandEnvironment: {},
      environment,
      environmentId: createId("environment"),
      harnessInstanceId: definition.id,
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      instructions: undefined,
      machineAccessNotice: "No other computers are reachable.",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.4",
        options: {},
        providerId: "openai",
      }),
      personalContext: true,
      personLineage: true,
      platformGuide: "",
      providerState,
      signal: AbortSignal.timeout(180_000),
      skills: { skills: [] },
      threadId: createId("thread"),
      threadStateDirectory: join(state, "threads", "thread"),
      workspacePath: project,
      wrapProcessLaunch: (launch) => launch,
      writableRoots: [project],
    };
    const events: HarnessEvent[] = [];
    const session = await adapter.startSession(context);
    const observing = (async () => {
      for await (const event of session.events) events.push(event);
    })();
    try {
      await session.execute({
        context: {
          assignment: null,
          startedAt: "2026-11-24T00:00:00.000Z",
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment,
        inputs: [
          {
            author: { displayName: "Person", kind: "human", principalId: "person" },
            content: [{ text: "Say done.", type: "text" }],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
        ],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        requestedBy: createId("user"),
        runId: createId("run"),
        signal: AbortSignal.timeout(180_000),
      });
    } finally {
      // Stop: the session's own stop resolves only once its engine is gone.
      await session.stop();
      await observing;
    }
    expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    expect(api.requests.length).toBeGreaterThan(0);
  },
  300_000,
);
