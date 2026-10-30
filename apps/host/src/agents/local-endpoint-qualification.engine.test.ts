import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessIdSchema, ModelSelectionSchema, type Attachment } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createHarnessRegistry, parseAgentExecutionConfig } from "@opensteer/runner";
import sharp from "sharp";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachmentReference,
  startVerticalStack,
  type VerticalStack,
} from "./vertical-stack.test-support.js";

/*
 * Opt-in qualification against an actual model server and the pinned engine
 * binaries. It uses the real Host, Runner, account setup, model catalog, engine
 * process and workspace. Live cases require a server already running; their
 * unscripted tool call and on-disk artifact prove model execution. The local
 * HTTP fixture scripts only wire behavior and is labeled separately.
 */

const qualification =
  process.env.OPENSTEER_LOCAL_ENDPOINT_QUALIFY === "1" ? describe : describe.skip;
const omlxSettingsSchema = z.object({
  auth: z.object({ api_key: z.string().min(1) }),
  sampling: z.object({ max_context_window: z.number().int().positive() }),
  server: z.object({ host: z.string().min(1), port: z.number().int().positive() }),
});

interface Endpoint {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly contextWindow: number;
  readonly nativeModelId?: string | undefined;
  readonly runtime: "generic" | "ollama" | "lmstudio" | "omlx";
}

async function endpoint(): Promise<Endpoint> {
  const settingsPath = process.env.OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS;
  if (settingsPath) {
    const settings = omlxSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    return {
      apiKey: settings.auth.api_key,
      baseUrl: `http://${settings.server.host}:${settings.server.port}/v1`,
      contextWindow: settings.sampling.max_context_window,
      nativeModelId: process.env.OPENSTEER_LOCAL_ENDPOINT_MODEL_ID,
      runtime: "omlx",
    };
  }
  const baseUrl = process.env.OPENSTEER_LOCAL_ENDPOINT_BASE_URL;
  const apiKey = process.env.OPENSTEER_LOCAL_ENDPOINT_API_KEY;
  const contextWindow = Number(process.env.OPENSTEER_LOCAL_ENDPOINT_CONTEXT_WINDOW);
  // No key qualifies a keyless server: the account must be ready without a sign-in.
  if (!baseUrl || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Set an oMLX settings path or endpoint URL and context window");
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    contextWindow,
    nativeModelId: process.env.OPENSTEER_LOCAL_ENDPOINT_MODEL_ID,
    runtime: z
      .enum(["generic", "ollama", "lmstudio", "omlx"])
      .parse(process.env.OPENSTEER_LOCAL_ENDPOINT_RUNTIME ?? "generic"),
  };
}

function evidencePreview(value: unknown, apiKey: string | undefined): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (apiKey ? text.replaceAll(apiKey, "[redacted]") : text)
    .replaceAll(homedir(), "~")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 2_000);
}

interface WireRequest {
  readonly authorization: string | undefined;
  readonly model: string | undefined;
  readonly path: string;
  readonly status: number;
}

interface WireFixture {
  readonly baseUrl: string;
  readonly completionModels: string[];
  readonly holdingRequest: Promise<void>;
  readonly requests: WireRequest[];
  readonly close: () => Promise<void>;
}

/*
 * One scripted server speaks both the generic `/v1/models` list and Ollama's
 * native catalog, so a case picks its runtime by account configuration alone.
 * `local-ctx:1` declares its context only through its Modelfile; `local-loaded:1`
 * is loaded with a smaller context than its Modelfile names.
 */
async function startWireFixture(requiredKey?: string): Promise<WireFixture> {
  const requests: WireRequest[] = [];
  const completionModels: string[] = [];
  let holdingRequestStarted!: () => void;
  const holdingRequest = new Promise<void>((resolve) => {
    holdingRequestStarted = resolve;
  });
  const ollamaModels: Record<string, string | undefined> = {
    "local-chat:1": undefined,
    "local-ctx:1":
      'num_ctx                        16384\nstop                           "<|im_end|>"',
    "local-loaded:1": "num_ctx 32768",
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? z.record(z.string(), z.unknown()).parse(JSON.parse(text)) : {};
      const model = typeof body.model === "string" ? body.model : undefined;
      const authorization = request.headers.authorization;
      const path = request.url ?? "";
      const answer = (status: number, value?: unknown) => {
        requests.push({ authorization, model, path, status });
        if (value === undefined) {
          response.writeHead(status).end();
          return;
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (requiredKey && authorization !== `Bearer ${requiredKey}`) return answer(401);
      if (path === "/v1/models" && request.method === "GET") {
        return answer(200, {
          object: "list",
          data: [
            { id: "local-chat:1", object: "model" },
            { id: "local-embed:1", object: "model", type: "embedding" },
          ],
        });
      }
      if (path === "/api/tags" && request.method === "GET") {
        return answer(200, { models: Object.keys(ollamaModels).map((id) => ({ model: id })) });
      }
      if (path === "/api/ps" && request.method === "GET") {
        return answer(200, { models: [{ model: "local-loaded:1", context_length: 12_288 }] });
      }
      if (path === "/api/show" && request.method === "POST" && model && model in ollamaModels) {
        const parameters = ollamaModels[model];
        return answer(200, {
          capabilities: ["completion", "tools"],
          ...(parameters ? { parameters } : {}),
        });
      }
      if (path !== "/v1/chat/completions" || request.method !== "POST" || !model) {
        return answer(404);
      }
      const input = z
        .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
        .parse(body);
      requests.push({ authorization, model, path, status: 200 });
      completionModels.push(model);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const row = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-wire-only",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      const latestUserMessage = input.messages.findLast((message) => message.role === "user");
      if (JSON.stringify(latestUserMessage?.content).includes("WAIT_FOR_INTERRUPT")) {
        response.write(row({ role: "assistant", content: "PARTIAL" }, null));
        holdingRequestStarted();
        return;
      }
      response.write(row({ role: "assistant", content: "WIRE_ONLY_READY" }, null));
      response.write(row({}, "stop"));
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    completionModels,
    holdingRequest,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

interface OmlxFixture {
  readonly origin: string;
  readonly requests: WireRequest[];
  /** Makes the server take only `key` from now on, as oMLX does after its key changes. */
  readonly requireKey: (key: string) => void;
  readonly close: () => Promise<void>;
}

/*
 * oMLX as its Mac app leaves it: an API key required on everything under
 * `/v1`, and an unauthenticated `/health` that names it by its engine pool.
 */
async function startOmlxFixture(initialKey: string): Promise<OmlxFixture> {
  const requests: WireRequest[] = [];
  let key = initialKey;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? z.record(z.string(), z.unknown()).parse(JSON.parse(text)) : {};
      const model = typeof body.model === "string" ? body.model : undefined;
      const authorization = request.headers.authorization;
      const path = request.url ?? "";
      const answer = (status: number, value?: unknown) => {
        requests.push({ authorization, model, path, status });
        if (value === undefined) {
          response.writeHead(status).end();
          return;
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/health" && request.method === "GET") {
        return answer(200, {
          default_model: "local-chat",
          engine_pool: { loaded_count: 0, model_count: 1 },
          status: "healthy",
        });
      }
      if (authorization !== `Bearer ${key}`) return answer(401, { detail: "API key required" });
      if (path === "/v1/models/status" && request.method === "GET") {
        return answer(200, {
          models: [
            {
              id: "local-chat",
              is_helper: false,
              is_hidden: false,
              loaded: false,
              max_context_window: 32_768,
              max_tokens: 8_192,
              model_type: "llm",
            },
          ],
        });
      }
      if (path !== "/v1/chat/completions" || request.method !== "POST" || !model) {
        return answer(404);
      }
      requests.push({ authorization, model, path, status: 200 });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const row = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-omlx-wire-only",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(row({ role: "assistant", content: "SERVER_KEY_READY" }, null));
      response.write(row({}, "stop"));
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    requireKey: (next) => {
      key = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

interface WireImage {
  readonly base64Bytes: number;
  readonly height: number;
  readonly mediaType: string;
  readonly width: number;
}

const WireImagePartSchema = z.object({
  image_url: z.object({ url: z.string() }),
  type: z.literal("image_url"),
});

/*
 * A vision model that records every image each request carries, decoded, so a
 * case asserts on exactly what a provider would receive. A message saying
 * RUN_SLEEP_<n> gets `n` consecutive `bash` calls to `sleep`, which keep the
 * engine's turn in flight long enough to steer into it; anything else is
 * answered with the number of images in the newest user message.
 */
async function startVisionWireFixture(): Promise<{
  readonly baseUrl: string;
  readonly requests: (readonly WireImage[])[];
  readonly close: () => Promise<void>;
}> {
  const requests: WireImage[][] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = request.url ?? "";
      if (path === "/v1/models" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "local-vision:1", input_modalities: ["text", "image"], object: "model" }],
          }),
        );
        return;
      }
      if (path !== "/v1/chat/completions" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const body = z
        .object({
          messages: z.array(z.object({ content: z.unknown(), role: z.string() })),
          model: z.string(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const images: WireImage[] = [];
      let newest = 0;
      for (const message of body.messages) {
        if (message.role !== "user" || !Array.isArray(message.content)) continue;
        newest = 0;
        for (const part of message.content) {
          const image = WireImagePartSchema.safeParse(part);
          if (!image.success) continue;
          const inline = /^data:([^;,]+);base64,(.*)$/su.exec(image.data.image_url.url);
          if (!inline?.[1] || !inline[2]) throw new Error("An image did not arrive inline");
          const metadata = await sharp(Buffer.from(inline[2], "base64")).metadata();
          images.push({
            base64Bytes: inline[2].length,
            height: metadata.height ?? 0,
            mediaType: inline[1],
            width: metadata.width ?? 0,
          });
          newest += 1;
        }
      }
      requests.push(images);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const row = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-vision-wire",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      const sleeper = body.messages.findLastIndex(
        (message) =>
          message.role === "user" && /RUN_SLEEP_\d/u.test(JSON.stringify(message.content)),
      );
      const sleeps = Number(
        /RUN_SLEEP_(\d)/u.exec(JSON.stringify(body.messages[sleeper]?.content))?.[1] ?? 0,
      );
      const slept = body.messages
        .slice(sleeper + 1)
        .filter((message) => message.role === "tool").length;
      if (sleeper >= 0 && slept < sleeps) {
        response.write(
          row(
            {
              role: "assistant",
              tool_calls: [
                {
                  function: { arguments: JSON.stringify({ command: "sleep 8" }), name: "bash" },
                  id: `call_${randomUUID()}`,
                  index: 0,
                  type: "function",
                },
              ],
            },
            null,
          ),
        );
        response.write(row({}, "tool_calls"));
      } else {
        response.write(row({ role: "assistant", content: `IMAGES ${newest}` }, null));
        response.write(row({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * A default 24 MP phone photo, noisy enough to exceed 5 MiB. Heavier grain
 * keeps even the fitted copy large (about 1.5 MB at 2000 px), so every image
 * uses its whole share of a transport budget.
 */
async function phonePhoto(
  grain: { readonly sigma: number; readonly quality: number } = {
    sigma: 24,
    quality: 94,
  },
): Promise<Buffer> {
  return sharp({
    create: {
      width: 5712,
      height: 4284,
      channels: 3,
      background: "#808080",
      noise: { type: "gaussian", mean: 128, sigma: grain.sigma },
    },
  })
    .jpeg({ quality: grain.quality })
    .toBuffer();
}

/** oMLX's settings as its Mac app writes them: its port, its key, its admin secret. */
async function writeOmlxSettings(home: string, port: number, key: string): Promise<void> {
  await mkdir(join(home, ".omlx"), { recursive: true });
  await writeFile(
    join(home, ".omlx", "settings.json"),
    JSON.stringify({
      auth: { api_key: key, secret_key: "never-read", skip_api_key_verification: false },
      server: { host: "127.0.0.1", port },
    }),
    { mode: 0o600 },
  );
}

/** A home where oMLX keeps its settings and LM Studio is installed with its server off. */
async function modelServerHome(omlxPort: number, key: string, lmStudioPort: number) {
  const home = await mkdtemp(join(tmpdir(), "opensteer-model-server-home-"));
  await writeOmlxSettings(home, omlxPort, key);
  await mkdir(join(home, ".lmstudio", ".internal"), { recursive: true });
  await writeFile(
    join(home, ".lmstudio", ".internal", "http-server-config.json"),
    JSON.stringify({ port: lmStudioPort }),
  );
  return home;
}

function wireArtifactDirectory(): string {
  return (
    process.env.OPENSTEER_LOCAL_ENDPOINT_ARTIFACT_DIR ??
    join(tmpdir(), "opensteer-local-endpoint-qualification")
  );
}

async function writeWireArtifact(name: string, evidence: Record<string, unknown>): Promise<void> {
  const directory = wireArtifactDirectory();
  const path = join(directory, `${name}-${randomUUID()}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Local endpoint wire-only artifact: ${path}\n`);
}

async function stagedPiModelsText(stack: VerticalStack): Promise<string> {
  const files = await readdir(stack.runnerDataDirectory, { recursive: true });
  // Pi's own file sits at its profile's home; other engines keep caches of
  // the same name deeper in theirs, and the listing order is not stable.
  const modelsFile = files.find((file) => file.endsWith("/provider-home/models.json"));
  if (!modelsFile) throw new Error("Pi must stage its native model file");
  return readFile(join(stack.runnerDataDirectory, modelsFile), "utf8");
}

/** The account's catalog as the next bootstrap reports it. */
async function stackCatalog(stack: VerticalStack) {
  const bootstrap = await stack.api["bootstrap.get"]({});
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);
  const catalog = bootstrap.data.environments
    .find((environment) => environment.id === stack.environmentId)
    ?.harnessCatalogs.find((entry) => entry.harnessInstanceId === stack.harnessInstanceId);
  if (!catalog) throw new Error("The account has no catalog");
  return catalog;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the account");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const wireEngines = [
  { driverKind: "opencode", methodId: "opencode-api-key" },
  { driverKind: "pi", methodId: "pi-api-key" },
] as const;

/** Pi's `models.json` placeholder; a keyless server ignores it and a stored key replaces it. */
const piKeylessBearer = "Bearer opensteer-keyless-endpoint";

qualification("local endpoint qualification", () => {
  for (const engine of wireEngines) {
    it(`wire-only ${engine.driverKind}: keyless discovery, embedding exclusion, explicit limits and reset`, async () => {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl) throw new Error("Run through pnpm test:engines");
      const fixture = await startWireFixture();
      let stack: VerticalStack | undefined;
      const evidence: Record<string, unknown> = {
        engine: engine.driverKind,
        kind: "wire-only-keyless",
        status: "started",
      };
      // Pi requires some `apiKey` in `models.json`; a keyless server ignores it.
      const expectedCompletionAuth = engine.driverKind === "pi" ? piKeylessBearer : undefined;
      try {
        stack = await startVerticalStack({
          catalogTimeoutMs: 60_000,
          cleanupTimeoutMs: 120_000,
          databaseUrl,
          harnessInstance: {
            config: { baseUrl: fixture.baseUrl, runtime: "generic" },
            driverKind: engine.driverKind,
            sourceId: "openai-compatible",
            stateKind: "isolated",
          },
          harnesses: createHarnessRegistry(
            parseAgentExecutionConfig(process.env).harnessExecutables,
            { nodeExecutable: process.execPath },
          ),
          harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
          runTimeoutMs: 30_000,
        });
        expect(stack.initialCatalog.status).toBe("ready");
        expect(fixture.requests.every((request) => request.authorization === undefined)).toBe(true);
        expect(stack.catalog.connections[0]).toMatchObject({ authKind: "none" });
        expect(stack.catalog.connections[0]?.logoutSupported).not.toBe(true);
        expect(stack.catalog.models).toHaveLength(1);
        const model = stack.catalog.models[0]!;
        expect(model.nativeModelId).toBe("local-chat:1");
        expect(model.contextWindow).toBeUndefined();
        expect(model.unavailableReason).toMatch(/context window is unknown/iu);
        expect(model.needsContextWindow).toBe(true);
        const configured = await stack.configureModel("local-chat:1", { contextWindow: 8_192 });
        expect(configured.unavailableReason).toBeUndefined();
        expect(configured.needsContextWindow).toBeUndefined();
        expect(configured.contextWindow).toBe(8_192);
        const workspace = await stack.createWorkspace("Wire-only endpoint qualification");
        const threadId = await stack.createThread({
          modelSelection: ModelSelectionSchema.parse({
            modelId: configured.modelId,
            options: {},
            providerId: configured.providerId,
          }),
          title: `Wire-only native provider ${randomUUID()}`,
          workspaceId: workspace.id,
        });
        const turn = await stack.sendMessage({
          text: "Reply with WIRE_ONLY_READY.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(turn.assistantText).toContain("WIRE_ONLY_READY");
        expect(fixture.completionModels).toEqual(["local-chat:1"]);
        const interrupted = await stack.sendMessage({
          text: "WAIT_FOR_INTERRUPT",
          threadId,
          workspaceId: workspace.id,
          onQueued: async (runId) => {
            await fixture.holdingRequest;
            await stack!.interruptRun(threadId, runId);
          },
        });
        expect(interrupted.events.map((event) => event.type)).toContain("run.interrupted");
        for (let attempt = 0; attempt < 50; attempt++) {
          const snapshot = await stack.host.store.workspaceSnapshot(workspace.id);
          if (snapshot.threads.find((thread) => thread.id === threadId)?.status === "idle") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await stack.resumeThreadInputQueue(threadId);
        const resumed = await stack.sendMessage({
          text: "Continue after the interrupted turn and reply WIRE_ONLY_READY.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(resumed.assistantText).toContain("WIRE_ONLY_READY");
        expect(fixture.completionModels).toEqual(["local-chat:1", "local-chat:1", "local-chat:1"]);
        const discovery = fixture.requests.filter((request) => request.path === "/v1/models");
        const completions = fixture.requests.filter(
          (request) => request.path === "/v1/chat/completions",
        );
        expect(discovery.map((request) => request.authorization)).toEqual(
          discovery.map(() => undefined),
        );
        expect(completions.map((request) => request.authorization)).toEqual(
          completions.map(() => expectedCompletionAuth),
        );
        if (engine.driverKind === "pi") {
          const staged = z
            .object({
              providers: z.object({ opensteer: z.object({ apiKey: z.string() }) }),
            })
            .parse(JSON.parse(await stagedPiModelsText(stack)));
          expect(`Bearer ${staged.providers.opensteer.apiKey}`).toBe(piKeylessBearer);
        }
        const reset = await stack.configureModel("local-chat:1", null);
        expect(reset.contextWindow).toBeUndefined();
        expect(reset.unavailableReason).toMatch(/context window is unknown/iu);
        expect(reset.needsContextWindow).toBe(true);
        await expect(
          stack.createThread({
            modelSelection: ModelSelectionSchema.parse({
              modelId: reset.modelId,
              options: {},
              providerId: reset.providerId,
            }),
            title: `Unavailable model ${randomUUID()}`,
            workspaceId: workspace.id,
          }),
        ).rejects.toThrow();
        evidence.connection = stack.catalog.connections[0];
        evidence.model = {
          nativeModelId: model.nativeModelId,
          configured: configured.contextWindow,
        };
        evidence.completionModels = fixture.completionModels;
        evidence.turn = {
          assistantText: turn.assistantText,
          events: turn.events.map((e) => e.type),
        };
        evidence.interrupted = interrupted.events.map((event) => event.type);
        evidence.resumed = resumed.events.map((event) => event.type);
        evidence.requests = fixture.requests;
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = String(error);
        evidence.requests = fixture.requests;
        throw error;
      } finally {
        try {
          await stack?.close();
        } finally {
          await fixture.close();
          await writeWireArtifact(`wire-only-keyless-${engine.driverKind}`, evidence);
        }
      }
    }, 300_000);

    it(`wire-only ${engine.driverKind}: fits full-resolution photos to what the model receives`, async () => {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl) throw new Error("Run through pnpm test:engines");
      const fixture = await startVisionWireFixture();
      const harnesses = createHarnessRegistry(
        parseAgentExecutionConfig(process.env).harnessExecutables,
        { nodeExecutable: process.execPath },
      );
      const evidence: Record<string, unknown> = {
        engine: engine.driverKind,
        kind: "wire-only-photos",
        status: "started",
      };
      // What every engine's own client fitting produces, and what Anthropic
      // and OpenAI accept on every path.
      const fits = (images: readonly WireImage[]) =>
        images.every(
          (image) =>
            Math.max(image.width, image.height) <= 2_000 &&
            image.base64Bytes <= 4.5 * 1_024 * 1_024,
        );
      let stack: VerticalStack | undefined;
      try {
        stack = await startVerticalStack({
          catalogTimeoutMs: 60_000,
          cleanupTimeoutMs: 120_000,
          databaseUrl,
          harnessInstance: {
            config: { baseUrl: fixture.baseUrl, runtime: "generic" },
            driverKind: engine.driverKind,
            sourceId: "openai-compatible",
            stateKind: "isolated",
          },
          harnesses,
          harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
          runTimeoutMs: 180_000,
        });
        const configured = await stack.configureModel("local-vision:1", { contextWindow: 131_072 });
        expect(configured.acceptsImages).toBe(true);
        const workspace = await stack.createWorkspace("Wire-only photo delivery");
        const threadId = await stack.createThread({
          modelSelection: ModelSelectionSchema.parse({
            modelId: configured.modelId,
            options: {},
            providerId: configured.providerId,
          }),
          title: `Wire-only photos ${randomUUID()}`,
          workspaceId: workspace.id,
        });
        // Three photos of more than 5 MiB each: together far past the 4 MiB
        // an engine protocol line carries.
        const photos = [];
        for (const name of ["IMG_8003.jpeg", "IMG_8004.jpeg", "IMG_8005.jpeg"])
          photos.push(
            await stack.uploadAttachment({
              bytes: await phonePhoto(),
              mediaType: "image/jpeg",
              name,
              workspaceId: workspace.id,
            }),
          );
        expect(photos.every((photo) => photo.sizeBytes > 5 * 1_024 * 1_024)).toBe(true);
        const counted = await stack.sendMessage({
          attachments: photos.map(attachmentReference),
          text: "How many photos are attached?",
          threadId,
          workspaceId: workspace.id,
        });
        expect(counted.assistantText).toContain("IMAGES 3");
        const prompted = fixture.requests.at(-1) ?? [];
        expect(prompted).toHaveLength(3);
        expect(fits(prompted)).toBe(true);
        evidence.prompt = prompted;

        if (
          harnesses.driverCapabilities(HarnessIdSchema.parse(engine.driverKind))?.messageAttachments
            ?.nativeImages?.steering === true
        ) {
          // The engine's steering path hands images to the provider as given.
          const extra = await stack.uploadAttachment({
            bytes: await phonePhoto(),
            mediaType: "image/jpeg",
            name: "IMG_8006.jpeg",
            workspaceId: workspace.id,
          });
          const active = stack;
          const steered = await active.sendMessage({
            onQueued: async (runId) => {
              await active.waitForToolStart(runId);
              await active.steerMessage({
                attachments: [attachmentReference(extra)],
                text: "One more photo.",
                threadId,
              });
            },
            text: "RUN_SLEEP_1",
            threadId,
            workspaceId: workspace.id,
          });
          expect(steered.assistantText).toContain("IMAGES 1");
          const followed = fixture.requests.at(-1) ?? [];
          expect(followed).toHaveLength(4);
          expect(fits(followed)).toBe(true);
          evidence.steer = followed;
        }
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = String(error);
        evidence.requests = fixture.requests;
        throw error;
      } finally {
        try {
          await stack?.close();
        } finally {
          await fixture.close();
          await writeWireArtifact(`wire-only-photos-${engine.driverKind}`, evidence);
        }
      }
    }, 600_000);

    if (engine.driverKind === "pi")
      it("wire-only pi: images from a prompt and two steers share one run", async () => {
        const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
        if (!databaseUrl) throw new Error("Run through pnpm test:engines");
        const fixture = await startVisionWireFixture();
        const evidence: Record<string, unknown> = {
          engine: engine.driverKind,
          kind: "wire-only-photos-one-run",
          status: "started",
        };
        let stack: VerticalStack | undefined;
        try {
          stack = await startVerticalStack({
            catalogTimeoutMs: 60_000,
            cleanupTimeoutMs: 120_000,
            databaseUrl,
            harnessInstance: {
              config: { baseUrl: fixture.baseUrl, runtime: "generic" },
              driverKind: engine.driverKind,
              sourceId: "openai-compatible",
              stateKind: "isolated",
            },
            harnesses: createHarnessRegistry(
              parseAgentExecutionConfig(process.env).harnessExecutables,
              { nodeExecutable: process.execPath },
            ),
            harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
            runTimeoutMs: 180_000,
          });
          const active = stack;
          const configured = await active.configureModel("local-vision:1", {
            contextWindow: 131_072,
          });
          const workspace = await active.createWorkspace("Wire-only photos in one run");
          const threadId = await active.createThread({
            modelSelection: ModelSelectionSchema.parse({
              modelId: configured.modelId,
              options: {},
              providerId: configured.providerId,
            }),
            title: `Wire-only one-run photos ${randomUUID()}`,
            workspaceId: workspace.id,
          });
          // Six heavy photos, two per command: each command fits its own line,
          // but Pi echoes the whole run's messages once more when it ends.
          const photos: Attachment[] = [];
          for (let index = 0; index < 6; index++)
            photos.push(
              await active.uploadAttachment({
                bytes: await phonePhoto({ sigma: 80, quality: 80 }),
                mediaType: "image/jpeg",
                name: `IMG_81${index}.jpeg`,
                workspaceId: workspace.id,
              }),
            );
          const run = await active.sendMessage({
            attachments: photos.slice(0, 2).map(attachmentReference),
            onQueued: async (runId) => {
              for (const [index, pair] of [photos.slice(2, 4), photos.slice(4, 6)].entries()) {
                await active.waitForToolStart(runId, index + 1);
                await active.steerMessage({
                  attachments: pair.map(attachmentReference),
                  text: `Two more photos (${index + 1}).`,
                  threadId,
                });
              }
            },
            text: "RUN_SLEEP_2",
            threadId,
            workspaceId: workspace.id,
          });
          expect(run.assistantText).toContain("IMAGES 2");
          const last = fixture.requests.at(-1) ?? [];
          expect(last).toHaveLength(6);
          const echoed = last.reduce((sum, image) => sum + image.base64Bytes, 0);
          // The run's images alone exceed the 8 MiB line Pi echoes them on.
          expect(echoed).toBeGreaterThan(8 * 1_024 * 1_024);
          evidence.images = last;
          evidence.status = "passed";
        } catch (error) {
          evidence.status = "failed";
          evidence.error = String(error);
          evidence.requests = fixture.requests;
          throw error;
        } finally {
          try {
            await stack?.close();
          } finally {
            await fixture.close();
            await writeWireArtifact("wire-only-photos-one-run-pi", evidence);
          }
        }
      }, 600_000);

    if (engine.driverKind === "pi")
      it("wire-only pi: a person's Chat follow-ups reach the reply under way, once", async () => {
        const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
        if (!databaseUrl) throw new Error("Run through pnpm test:engines");
        const fixture = await startVisionWireFixture();
        const evidence: Record<string, unknown> = {
          engine: engine.driverKind,
          kind: "wire-only-chat-follow-ups",
          status: "started",
        };
        let stack: VerticalStack | undefined;
        try {
          stack = await startVerticalStack({
            catalogTimeoutMs: 60_000,
            cleanupTimeoutMs: 120_000,
            databaseUrl,
            harnessInstance: {
              config: { baseUrl: fixture.baseUrl, runtime: "generic" },
              driverKind: engine.driverKind,
              sourceId: "openai-compatible",
              stateKind: "isolated",
            },
            harnesses: createHarnessRegistry(
              parseAgentExecutionConfig(process.env).harnessExecutables,
              { nodeExecutable: process.execPath },
            ),
            harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
            runTimeoutMs: 180_000,
          });
          const active = stack;
          const configured = await active.configureModel("local-vision:1", {
            contextWindow: 131_072,
          });
          const threadId = await active.createThread({
            home: true,
            modelSelection: ModelSelectionSchema.parse({
              modelId: configured.modelId,
              options: {},
              providerId: configured.providerId,
            }),
            title: "Chat",
            workspaceId: active.mainWorkspaceId,
          });
          const database = active.host.store.database;
          const input = (messageId: string) =>
            database
              .selectFrom("threadInputs")
              .select(["runId", "state"])
              .where("messageId", "=", messageId as never)
              .executeTakeFirstOrThrow();
          const phases = (events: readonly { readonly type: string; readonly data: unknown }[]) =>
            events.flatMap((event) =>
              event.type === "run.phase" ? [(event.data as { readonly phase: string }).phase] : [],
            );

          // Sent while Pi waits on its tool: Pi takes it before its next model
          // call, in the same run, through the prompt that steers.
          let duringTool = "";
          const toolRun = await active.sendMessage({
            onQueued: async (runId) => {
              await active.waitForToolStart(runId);
              const followUp = await active.queueMessage({ text: "While the tool runs", threadId });
              expect(followUp.runId).toBe(runId);
              duringTool = followUp.messageId;
            },
            text: "RUN_SLEEP_1",
            threadId,
            workspaceId: active.mainWorkspaceId,
          });
          expect(await input(duringTool)).toEqual({ runId: toolRun.runId, state: "delivered" });
          evidence.duringTool = { phases: phases(toolRun.events), reply: toolRun.assistantText };

          // Sent as Pi answers at once: answered in this Run or, refused before
          // Pi took it, by the next one. Never accepted and left unanswered.
          let late = "";
          const quick = await active.sendMessage({
            onQueued: async (runId) => {
              await waitForRunning(active, runId);
              late = (await active.queueMessage({ text: "Right after you start", threadId }))
                .messageId;
            },
            text: "Answer at once",
            threadId,
            workspaceId: active.mainWorkspaceId,
          });
          const lateInput = await input(late);
          if (lateInput.runId === quick.runId) {
            expect(lateInput.state).toBe("delivered");
            const answers = await database
              .selectFrom("messages")
              .select("sequence")
              .where("runId", "=", quick.runId as never)
              .where("kind", "=", "assistant")
              .execute();
            const placed = await database
              .selectFrom("messages")
              .select("sequence")
              .where("id", "=", late as never)
              .executeTakeFirstOrThrow();
            expect(answers.some(({ sequence }) => BigInt(sequence) > BigInt(placed.sequence))).toBe(
              true,
            );
          } else {
            const next = await database
              .selectFrom("runs")
              .select("id")
              .where("seedInputId", "=", late as never)
              .executeTakeFirstOrThrow();
            await waitForRunEnd(active, next.id);
          }
          evidence.lateFollowUp = {
            answeredIn: lateInput.runId === quick.runId ? "same run" : "next run",
            phases: phases(quick.events),
            state: lateInput.state,
          };
          evidence.status = "passed";
        } catch (error) {
          evidence.status = "failed";
          evidence.error = String(error);
          throw error;
        } finally {
          try {
            await stack?.close();
          } finally {
            await fixture.close();
            await writeWireArtifact("wire-only-chat-follow-ups-pi", evidence);
          }
        }
      }, 600_000);

    if (engine.driverKind === "pi")
      it("wire-only pi: a small configured transport still carries a small image", async () => {
        const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
        if (!databaseUrl) throw new Error("Run through pnpm test:engines");
        const fixture = await startVisionWireFixture();
        let stack: VerticalStack | undefined;
        try {
          stack = await startVerticalStack({
            catalogTimeoutMs: 60_000,
            cleanupTimeoutMs: 120_000,
            databaseUrl,
            harnessInstance: {
              // Far below the default 4 MiB, yet ample for a thumbnail.
              config: { baseUrl: fixture.baseUrl, maxWriteBufferBytes: 49_152, runtime: "generic" },
              driverKind: engine.driverKind,
              sourceId: "openai-compatible",
              stateKind: "isolated",
            },
            harnesses: createHarnessRegistry(
              parseAgentExecutionConfig(process.env).harnessExecutables,
              { nodeExecutable: process.execPath },
            ),
            harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
            runTimeoutMs: 120_000,
          });
          const configured = await stack.configureModel("local-vision:1", {
            contextWindow: 131_072,
          });
          const workspace = await stack.createWorkspace("Wire-only small transport");
          const threadId = await stack.createThread({
            modelSelection: ModelSelectionSchema.parse({
              modelId: configured.modelId,
              options: {},
              providerId: configured.providerId,
            }),
            title: `Wire-only small transport ${randomUUID()}`,
            workspaceId: workspace.id,
          });
          const thumbnail = await stack.uploadAttachment({
            bytes: await sharp({
              create: { width: 64, height: 64, channels: 3, background: "#3a6" },
            })
              .png()
              .toBuffer(),
            mediaType: "image/png",
            name: "thumbnail.png",
            workspaceId: workspace.id,
          });
          const turn = await stack.sendMessage({
            attachments: [attachmentReference(thumbnail)],
            text: "How many images?",
            threadId,
            workspaceId: workspace.id,
          });
          expect(turn.assistantText).toContain("IMAGES 1");
        } finally {
          try {
            await stack?.close();
          } finally {
            await fixture.close();
          }
        }
      }, 300_000);

    it(`wire-only ${engine.driverKind}: key requested on refusal, Ollama Modelfile context`, async () => {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl) throw new Error("Run through pnpm test:engines");
      const requiredKey = `wire-only-key-${randomUUID()}`;
      const fixture = await startWireFixture(requiredKey);
      let stack: VerticalStack | undefined;
      const evidence: Record<string, unknown> = {
        engine: engine.driverKind,
        kind: "wire-only-key-required",
        status: "started",
      };
      const redact = (value: unknown) =>
        JSON.parse(JSON.stringify(value).replaceAll(requiredKey, "[redacted]")) as unknown;
      try {
        stack = await startVerticalStack({
          catalogTimeoutMs: 60_000,
          cleanupTimeoutMs: 120_000,
          databaseUrl,
          harnessInstance: {
            apiKey: { connectionSlot: "primary", methodId: engine.methodId, value: requiredKey },
            config: { baseUrl: fixture.baseUrl, runtime: "ollama" },
            driverKind: engine.driverKind,
            sourceId: "openai-compatible",
            stateKind: "isolated",
          },
          harnesses: createHarnessRegistry(
            parseAgentExecutionConfig(process.env).harnessExecutables,
            { nodeExecutable: process.execPath },
          ),
          harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
          runTimeoutMs: 30_000,
        });
        const refused = stack.initialCatalog;
        expect(refused.status).toBe("authentication-required");
        expect(refused.detail).toMatch(/needs an API key/iu);
        expect(refused.setupMethods).toEqual([
          expect.objectContaining({ kind: "secret-input", methodId: engine.methodId }),
        ]);
        expect(fixture.requests[0]).toMatchObject({ authorization: undefined, status: 401 });
        expect(stack.catalog.connections[0]).toMatchObject({
          authKind: "api-key",
          logoutSupported: true,
        });
        const byId = new Map(stack.catalog.models.map((model) => [model.nativeModelId, model]));
        expect(byId.get("local-chat:1")).toMatchObject({ needsContextWindow: true });
        expect(byId.get("local-ctx:1")).toMatchObject({ contextWindow: 16_384 });
        expect(byId.get("local-ctx:1")?.unavailableReason).toBeUndefined();
        expect(byId.get("local-loaded:1")).toMatchObject({ contextWindow: 12_288 });
        const selected = byId.get("local-ctx:1")!;
        const workspace = await stack.createWorkspace("Keyed endpoint qualification");
        const threadId = await stack.createThread({
          modelSelection: ModelSelectionSchema.parse({
            modelId: selected.modelId,
            options: {},
            providerId: selected.providerId,
          }),
          title: `Keyed native provider ${randomUUID()}`,
          workspaceId: workspace.id,
        });
        const beforeRun = fixture.requests.length;
        const turn = await stack.sendMessage({
          text: "Reply with WIRE_ONLY_READY.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(turn.assistantText).toContain("WIRE_ONLY_READY");
        expect(fixture.completionModels).toEqual(["local-ctx:1"]);
        const runRequests = fixture.requests.slice(beforeRun);
        expect(runRequests.every((request) => request.status === 200)).toBe(true);
        expect(
          runRequests.every((request) => request.authorization === `Bearer ${requiredKey}`),
        ).toBe(true);
        const runShows = runRequests.filter((request) => request.path === "/api/show");
        expect(runShows.length).toBeGreaterThan(0);
        // OpenCode's session config is its own, so a start reads only the
        // selected model; Pi rewrites one shared catalog and reads them all.
        if (engine.driverKind === "opencode") {
          expect(runShows.map((request) => request.model)).toEqual(
            runShows.map(() => "local-ctx:1"),
          );
        } else {
          const stagedText = await stagedPiModelsText(stack);
          expect(stagedText).not.toContain(requiredKey);
          expect(stagedText).toContain(piKeylessBearer.replace("Bearer ", ""));
        }
        evidence.refused = { detail: refused.detail, setupMethods: refused.setupMethods };
        evidence.connection = stack.catalog.connections[0];
        evidence.models = stack.catalog.models.map((model) => ({
          nativeModelId: model.nativeModelId,
          contextWindow: model.contextWindow ?? null,
          needsContextWindow: model.needsContextWindow ?? false,
        }));
        evidence.turn = {
          assistantText: turn.assistantText,
          events: turn.events.map((e) => e.type),
        };
        evidence.runShowModels = runShows.map((request) => request.model);
        evidence.requests = redact(fixture.requests);
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = String(error).replaceAll(requiredKey, "[redacted]");
        evidence.requests = redact(fixture.requests);
        throw error;
      } finally {
        try {
          await stack?.close();
        } finally {
          await fixture.close();
          await writeWireArtifact(`wire-only-keyed-${engine.driverKind}`, evidence);
        }
      }
    }, 300_000);
    it(`wire-only ${engine.driverKind}: found on this computer and connected with the server's own key`, async () => {
      const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
      if (!databaseUrl) throw new Error("Run through pnpm test:engines");
      const firstKey = `omlx-key-${randomUUID()}`;
      const rotatedKey = `omlx-rotated-${randomUUID()}`;
      const fixture = await startOmlxFixture(firstKey);
      const lmStudioPort = await freePort();
      const home = await modelServerHome(
        Number(new URL(fixture.origin).port),
        firstKey,
        lmStudioPort,
      );
      let stack: VerticalStack | undefined;
      const evidence: Record<string, unknown> = {
        engine: engine.driverKind,
        kind: "wire-only-server-settings-key",
        status: "started",
      };
      const redact = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value)
            .replaceAll(firstKey, "[first key]")
            .replaceAll(rotatedKey, "[rotated key]"),
        ) as unknown;
      const baseUrl = `${fixture.origin}/v1`;
      try {
        stack = await startVerticalStack({
          catalogTimeoutMs: 60_000,
          cleanupTimeoutMs: 120_000,
          databaseUrl,
          // Connect: nothing is typed or pasted; the key is oMLX's own.
          harnessInstance: {
            apiKey: { methodId: "model-server-settings" },
            config: { baseUrl, runtime: "omlx" },
            driverKind: engine.driverKind,
            sourceId: "openai-compatible",
            stateKind: "isolated",
          },
          harnesses: createHarnessRegistry(
            parseAgentExecutionConfig(process.env).harnessExecutables,
            { modelServerHome: home, nodeExecutable: process.execPath },
          ),
          harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
          modelServerHome: home,
          runTimeoutMs: 30_000,
        });
        const api = stack.api;

        // Discovery reads each app's own settings and names each server by
        // what answers, never by its port alone.
        const discovered = await api["harness.modelServers.discover"]({
          environmentId: stack.environmentId,
        });
        if (!discovered.ok) throw new Error(discovered.error.message);
        // Discovery never sends a key: oMLX's own `/health` says what it is and
        // how many models it has; its list stays behind the key until Connect.
        expect(discovered.data.servers).toEqual([
          { baseUrl, models: 1, runtime: "omlx", status: "ready" },
          {
            baseUrl: `http://127.0.0.1:${lmStudioPort}/v1`,
            runtime: "lmstudio",
            status: "not-running",
          },
        ]);
        expect(JSON.stringify(discovered.data)).not.toContain(firstKey);
        const identified = await api["harness.modelServers.discover"]({
          address: fixture.origin,
          environmentId: stack.environmentId,
        });
        if (!identified.ok) throw new Error(identified.error.message);
        expect(identified.data.servers).toEqual([
          { baseUrl: fixture.origin, models: 1, runtime: "omlx", status: "ready" },
        ]);
        evidence.discovered = discovered.data.servers;
        evidence.identified = identified.data.servers;

        // The server refused without a key, and its own settings hold one: the
        // account offers that first, and it was used.
        expect(stack.initialCatalog).toMatchObject({ status: "authentication-required" });
        expect(stack.initialCatalog.setupMethods[0]).toMatchObject({
          kind: "local-import",
          methodId: "model-server-settings",
        });
        expect(stack.catalog.connections[0]).toMatchObject({ authKind: "api-key" });
        const model = stack.catalog.models[0]!;
        expect(model).toMatchObject({ contextWindow: 32_768, nativeModelId: "local-chat" });
        evidence.initialSetupMethods = stack.initialCatalog.setupMethods;

        const workspace = await stack.createWorkspace("Model server settings key");
        const threadId = await stack.createThread({
          modelSelection: ModelSelectionSchema.parse({
            modelId: model.modelId,
            options: {},
            providerId: model.providerId,
          }),
          title: `Server settings key ${randomUUID()}`,
          workspaceId: workspace.id,
        });
        const turn = await stack.sendMessage({
          text: "Reply with SERVER_KEY_READY.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(turn.assistantText).toContain("SERVER_KEY_READY");
        const completions = () =>
          fixture.requests.filter((request) => request.path === "/v1/chat/completions");
        expect(completions().at(-1)?.authorization).toBe(`Bearer ${firstKey}`);

        // oMLX's key changes: the account says so and offers the new one, one click.
        fixture.requireKey(rotatedKey);
        await writeOmlxSettings(home, Number(new URL(fixture.origin).port), rotatedKey);
        const refreshed = await api["harness.catalog.refresh"]({
          environmentId: stack.environmentId,
          harnessInstanceId: stack.harnessInstanceId,
        });
        if (!refreshed.ok) throw new Error(refreshed.error.message);
        const rejected = await stackCatalog(stack);
        expect(rejected).toMatchObject({
          detail: expect.stringMatching(/rejected the API key/u),
          status: "authentication-required",
        });
        expect(rejected.setupMethods[0]).toMatchObject({ kind: "local-import" });
        const begun = await api["commands.dispatch"]({
          connectionSlot: "primary",
          environmentId: stack.environmentId,
          harnessInstanceId: stack.harnessInstanceId,
          idempotencyKey: `rotated-${randomUUID()}`,
          methodId: "model-server-settings",
          type: "harness.authentication.begin",
        });
        if (!begun.ok) throw new Error(begun.error.message);
        await waitFor(async () => (await stackCatalog(stack!)).status === "ready");
        const afterRotation = await stack.sendMessage({
          text: "Reply with SERVER_KEY_READY again.",
          threadId,
          workspaceId: workspace.id,
        });
        expect(afterRotation.assistantText).toContain("SERVER_KEY_READY");
        expect(completions().at(-1)?.authorization).toBe(`Bearer ${rotatedKey}`);
        evidence.rotation = { rejected: redact(rejected), recovered: true };
        evidence.turns = [turn, afterRotation].map((entry) => ({
          assistantText: entry.assistantText,
          events: entry.events.map((event) => event.type),
        }));
        evidence.requests = redact(fixture.requests);
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = String(redact(String(error)));
        evidence.requests = redact(fixture.requests);
        throw error;
      } finally {
        try {
          await stack?.close();
        } finally {
          await fixture.close();
          await rm(home, { force: true, recursive: true });
          await writeWireArtifact(`wire-only-server-settings-key-${engine.driverKind}`, evidence);
        }
      }
    }, 300_000);
  }

  for (const engine of wireEngines) {
    describe(engine.driverKind, () => {
      let stack: VerticalStack | undefined;

      afterEach(async () => {
        await stack?.close();
        stack = undefined;
      }, 180_000);

      it("lists a native model, runs a tool, saves an artifact and continues", async () => {
        const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
        if (!databaseUrl) throw new Error("Run through pnpm test:engines");
        const target = await endpoint();
        const evidenceId = randomUUID();
        const evidenceDirectory =
          process.env.OPENSTEER_LOCAL_ENDPOINT_ARTIFACT_DIR ??
          join(tmpdir(), "opensteer-local-endpoint-qualification");
        const evidencePath = join(evidenceDirectory, `${engine.driverKind}-${evidenceId}.json`);
        const evidence: Record<string, unknown> = {
          engine: engine.driverKind,
          endpoint: new URL(target.baseUrl).host,
          status: "started",
          timestamp: new Date().toISOString(),
        };
        try {
          if (process.env.OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS) {
            const wrongKey = await fetch(`${target.baseUrl.replace(/\/+$/u, "")}/models`, {
              headers: { authorization: "Bearer invalid-opensteer-qualification-key" },
            });
            evidence.wrongKeyStatus = wrongKey.status;
            await wrongKey.body?.cancel();
            expect(wrongKey.status).toBe(401);
          }
          // oMLX is connected the way a person does it now: with the key its
          // own settings hold, read where oMLX keeps them, nothing pasted.
          const omlxSettings = process.env.OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS;
          if (omlxSettings) process.env.OMLX_BASE_PATH = dirname(omlxSettings);
          stack = await startVerticalStack({
            catalogTimeoutMs: 180_000,
            cleanupTimeoutMs: 120_000,
            databaseUrl,
            harnessInstance: {
              ...(omlxSettings
                ? { apiKey: { connectionSlot: "primary", methodId: "model-server-settings" } }
                : target.apiKey
                  ? {
                      apiKey: {
                        connectionSlot: "primary",
                        methodId: engine.methodId,
                        value: target.apiKey,
                      },
                    }
                  : {}),
              config: { baseUrl: target.baseUrl, runtime: target.runtime },
              driverKind: engine.driverKind,
              sourceId: "openai-compatible",
              stateKind: "isolated",
            },
            harnesses: createHarnessRegistry(
              parseAgentExecutionConfig(process.env).harnessExecutables,
              { nodeExecutable: process.execPath },
            ),
            harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
            runTimeoutMs: 300_000,
          });
          evidence.initialStatus = stack.initialCatalog.status;
          if (omlxSettings) {
            const discovered = await stack.api["harness.modelServers.discover"]({
              environmentId: stack.environmentId,
            });
            if (!discovered.ok) throw new Error(discovered.error.message);
            expect(discovered.data.servers).toContainEqual(
              expect.objectContaining({ runtime: "omlx", status: "ready" }),
            );
            expect(JSON.stringify(discovered.data)).not.toContain(target.apiKey);
            evidence.discovered = discovered.data.servers;
          }
          if (process.env.OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS) {
            // oMLX refuses keyless requests, so the key is requested rather than assumed.
            expect(stack.initialCatalog).toMatchObject({ status: "authentication-required" });
          }
          if (!target.apiKey) {
            // A keyless server is usable as soon as it answers; nothing asks for a key.
            expect(stack.initialCatalog).toMatchObject({ status: "ready" });
          }

          const model = target.nativeModelId
            ? stack.catalog.models.find((entry) => entry.nativeModelId === target.nativeModelId)
            : stack.catalog.models[0];
          expect(model, "The endpoint model must appear in the Runner catalog").toBeDefined();
          evidence.nativeModelId = model!.nativeModelId;
          evidence.initialContextWindow = model!.contextWindow ?? null;
          evidence.initialUnavailableReason = model!.unavailableReason ?? null;

          // The endpoint's /models list commonly omits context limits. The
          // account's explicit setting must make the selected model runnable.
          // Configure through the Host command, then use its refreshed catalog.
          const configured = await stack.configureModel(model!.nativeModelId ?? model!.modelId, {
            contextWindow: target.contextWindow,
            maxOutputTokens: Math.min(8_192, target.contextWindow - 1),
          });
          expect(configured.unavailableReason).toBeUndefined();
          expect(configured.contextWindow).toBe(target.contextWindow);
          evidence.configuredContextWindow = configured.contextWindow;

          const workspace = await stack.createWorkspace(`${engine.driverKind} local qualification`);
          const threadId = await stack.createThread({
            modelSelection: ModelSelectionSchema.parse({
              modelId: configured.modelId,
              options: {},
              providerId: configured.providerId,
            }),
            title: `${engine.driverKind} local qualification ${evidenceId}`,
            workspaceId: workspace.id,
          });
          await stack.updateThreadAccess(threadId, "full-access");
          const marker = `LOCAL_MODEL_QUALIFIED_${evidenceId.replaceAll("-", "")}`;
          const artifactName = `qualification-${evidenceId}.txt`;
          const artifactPath = join(stack.mountedWorkspacePath, artifactName);
          const prompt = `Create one file at this exact absolute path: ${artifactPath}. Its contents must be exactly this one line: ${marker}. Use your file-writing tool, then tell me the file name.`;
          const first = await stack.sendMessage({
            text: prompt,
            threadId,
            workspaceId: workspace.id,
          });
          evidence.firstTurn = {
            assistantText: first.assistantText,
            events: first.events.map((event) => event.type),
            prompt,
            tools: first.events.flatMap<Record<string, unknown>>((event) => {
              if (event.type === "tool.started") {
                return [
                  {
                    phase: "started",
                    callId: event.data.callId,
                    tool: event.data.tool,
                    arguments: evidencePreview(event.data.arguments, target.apiKey),
                  },
                ];
              }
              if (event.type === "tool.completed") {
                return [
                  {
                    phase: "completed",
                    callId: event.data.callId,
                    isError: event.data.isError,
                    output: evidencePreview(event.data.output.text, target.apiKey),
                  },
                ];
              }
              return [];
            }),
          };
          expect(first.events.map((event) => event.type)).toContain("tool.completed");
          evidence.workspaceEntries = await readdir(stack.mountedWorkspacePath, {
            recursive: true,
          });
          const artifact = (await readFile(artifactPath, "utf8")).trim();
          expect(artifact).toBe(marker);
          evidence.artifact = { name: artifactName, content: artifact };

          const secondPrompt = `Read the file at this exact absolute path: ${artifactPath}. Repeat the marker you find there.`;
          const second = await stack.sendMessage({
            text: secondPrompt,
            threadId,
            workspaceId: workspace.id,
          });
          evidence.secondTurn = {
            assistantText: second.assistantText,
            events: second.events.map((event) => event.type),
            prompt: secondPrompt,
          };
          expect(second.assistantText).toContain(marker);
          const sessions = await stack.host.store.database
            .selectFrom("providerSessions")
            .select(["providerSessionReference", "status"])
            .where("threadId", "=", threadId)
            .execute();
          expect(sessions).toHaveLength(1);
          expect(sessions[0]?.status).toBe("ready");
          evidence.sessionCount = sessions.length;
          if (engine.driverKind === "pi") {
            const stagedText = await stagedPiModelsText(stack);
            expect(stagedText).not.toContain(target.apiKey);
            const staged = z
              .object({
                providers: z.object({
                  opensteer: z.object({
                    models: z.array(
                      z.object({
                        id: z.string(),
                        contextWindow: z.number(),
                        maxTokens: z.number(),
                      }),
                    ),
                  }),
                }),
              })
              .parse(JSON.parse(stagedText));
            const nativeModel = staged.providers.opensteer.models.find(
              (entry) => entry.id === (model!.nativeModelId ?? model!.modelId),
            );
            expect(nativeModel).toMatchObject({
              contextWindow: target.contextWindow,
              maxTokens: Math.min(8_192, target.contextWindow - 1),
            });
            evidence.piNativeModels = staged.providers.opensteer.models.map((entry) => ({
              id: entry.id,
              contextWindow: entry.contextWindow,
              maxTokens: entry.maxTokens,
            }));
          }
          evidence.status = "passed";
        } catch (error) {
          evidence.status = "failed";
          evidence.error = evidencePreview(String(error), target.apiKey);
          throw error;
        } finally {
          delete process.env.OMLX_BASE_PATH;
          await mkdir(evidenceDirectory, { recursive: true });
          await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
          process.stdout.write(`Local endpoint qualification artifact: ${evidencePath}\n`);
        }
      }, 900_000);
    });
  }
});

async function waitForRunning(active: VerticalStack, runId: string): Promise<void> {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
    const run = await active.host.store.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId as never)
      .executeTakeFirstOrThrow();
    if (run.status !== "queued" && run.status !== "starting") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The Run did not start");
}

async function waitForRunEnd(active: VerticalStack, runId: string): Promise<void> {
  for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
    const run = await active.host.store.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId as never)
      .executeTakeFirstOrThrow();
    if (run.status === "completed") return;
    if (run.status === "failed" || run.status === "interrupted")
      throw new Error(`The Run ended ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Run did not end");
}
