import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ModelSelectionSchema,
  createId,
  harnessUsageLimitFailureCode,
  type HarnessInstanceId,
  type Message,
} from "@opensteer/core";
import {
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  threadTitlePrompt,
  spawnSupervised,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessInput,
  type HarnessInspectionResult,
  type HarnessProcessLaunch,
  type HarnessRunInput,
  type HarnessSessionContext,
  type SupervisedProcess,
} from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiHarnessDriver,
  connectPiMcpServer,
  piToolCallTimeoutMs,
  piAccessModeGate,
  piCommandTools,
  piCompatibleSourceId,
  piExtensionFileName,
  piFileChangeTools,
  piInstructions,
  piLoginScriptSource,
  piNonRetryableLimitPattern,
  piPackageEntryUrl,
  piThinkingLevels,
  piToolContent,
  type PiExtensionToolDefinition,
  type PiMcpConnect,
  type PiMcpConnection,
  type PiToolAnswer,
} from "./index.js";
import { PiHarnessConfigSchema, TESTED_PI_VERSION } from "./config.js";

// A Run outside any task with nothing earlier to state, for a person whose
// time zone is unknown: its thread context is one fixed line, so these turns
// carry exactly that context and the inputs and reports each test names.
const noThreadContext = {
  assignment: null,
  requesterTimeZone: null,
  threadState: { previousAssignment: null, previousRun: null },
};

const fakePi = fileURLToPath(new URL("./test-fixtures/fake-pi-rpc.mjs", import.meta.url));
const fakeMcpServer = fileURLToPath(
  new URL("./test-fixtures/fake-opensteer-mcp-server.mjs", import.meta.url),
);
const noComputersNotice = "No other computers are reachable from this Run.";
const temporaryDirectories: string[] = [];
const runningServers: SupervisedProcess[] = [];

afterEach(async () => {
  await Promise.allSettled(runningServers.splice(0).map((server) => server.terminate(0)));
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Pi access modes", () => {
  it.each([
    ["approval-required", piCommandTools, piFileChangeTools],
    ["auto-accept-edits", piCommandTools, []],
    ["full-access", [], []],
    // Never declared, because Pi cannot judge "routine"; answered with the
    // strictest gate so a mode that somehow arrived fails closed.
    ["auto", piCommandTools, piFileChangeTools],
  ] as const)("gates %s", (accessMode, commandTools, fileChangeTools) => {
    expect(piAccessModeGate(accessMode)).toEqual({
      commandTools: [...commandTools],
      fileChangeTools: [...fileChangeTools],
    });
  });
});

describe("Pi protocol framing", () => {
  it("classifies Pi's own non-retryable provider-limit wording", () => {
    for (const message of [
      '429 {"error":{"type":"GoUsageLimitError"}}',
      "Monthly usage limit reached",
      "insufficient_quota",
      "quota exceeded",
      "please update your billing details",
    ]) {
      expect(piNonRetryableLimitPattern.test(message)).toBe(true);
    }
    for (const message of ["529 overloaded_error", "rate limit exceeded", "fetch failed"]) {
      expect(piNonRetryableLimitPattern.test(message)).toBe(false);
    }
  });
});

describe("Pi model catalog", () => {
  it("folds gateway spellings onto canonical pairs and keeps the native id", async () => {
    const result = await inspectSource("anthropic");
    if (result?.status !== "ready") throw new Error(`Expected ready, got ${result?.status}`);
    expect(
      result.models.map((model) => [model.providerId, model.modelId, model.nativeModelId]),
    ).toEqual([
      ["anthropic", "claude-opus-4-8", "claude-opus-4-8"],
      ["anthropic", "claude-haiku-4-5", "claude-haiku-4-5"],
    ]);
    // Only the source's own provider is offered; a catalog carries many.
    expect(result.models.every((model) => model.providerId === "anthropic")).toBe(true);
    // Pi's registry states each model's input modalities, so the descriptors
    // carry them rather than leaving the Host to guess.
    expect(result.models.map((model) => model.acceptsImages)).toEqual([true, false]);
  });

  it("canonicalizes an OpenRouter :free id and an opencode-go bare id", async () => {
    const openrouter = await inspectSource("openrouter");
    if (openrouter?.status !== "ready") throw new Error("Expected ready");
    expect(openrouter.models).toEqual([
      expect.objectContaining({
        modelId: "claude-opus-4.8:free",
        nativeModelId: "anthropic/claude-opus-4.8:free",
        providerId: "anthropic",
      }),
    ]);
    const go = await inspectSource("opencode-go");
    if (go?.status !== "ready") throw new Error("Expected ready");
    expect(go.models).toEqual([
      expect.objectContaining({
        modelId: "kimi-k2.6",
        nativeModelId: "kimi-k2.6",
        providerId: "moonshot",
      }),
    ]);
    // A registry row that names no input modalities says nothing, and silence
    // is not a declaration: the descriptor omits it.
    expect(go.models[0]?.acceptsImages).toBeUndefined();
    expect(openrouter.models[0]?.acceptsImages).toBeUndefined();
  });

  it("offers a Thinking option only for a reasoning model, narrowed by its level map", () => {
    expect(
      piThinkingLevels({
        reasoning: true,
        thinkingLevelMap: {
          high: "high",
          low: "low",
          max: null,
          medium: "medium",
          minimal: "minimal",
          off: "off",
          xhigh: null,
        },
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(piThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(piThinkingLevels({ reasoning: false })).toEqual([]);
  });

  it("preserves a complete catalog beyond the former 256-model cutoff", async () => {
    const result = await inspectSource("openai", {
      environment: { FAKE_PI_SCENARIO: "large-catalog" },
    });
    if (result?.status !== "ready") throw new Error(`Expected ready, got ${result?.status}`);
    expect(result.models).toHaveLength(300);
    expect(result.models.at(-1)?.nativeModelId).toBe("gpt-test-0299");
  });

  it("reports an oversized catalog instead of publishing a partial one", async () => {
    const result = await inspectSource("openai", {
      environment: { FAKE_PI_SCENARIO: "oversized-catalog" },
    });
    expect(result).toMatchObject({
      detail: expect.stringContaining("8193 models"),
      status: "unavailable",
    });
  });
});

describe("Pi inspection", () => {
  it("refuses an isolated-service Runner outright", async () => {
    const result = await inspectSource("openai", {
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });
    expect(result).toEqual({
      detail: expect.stringContaining("no command sandbox"),
      status: "unavailable",
    });
  });

  it("reports an unsupported Pi version as unavailable", async () => {
    const result = await inspectSource("openai", { environment: { FAKE_PI_VERSION: "0.84.0" } });
    expect(result).toEqual({
      detail: expect.stringContaining(TESTED_PI_VERSION),
      status: "unavailable",
    });
  });

  it("reports a missing executable as unavailable rather than throwing", async () => {
    const result = await inspectSource("openai", { executable: join(tmpdir(), "no-such-pi.js") });
    expect(result?.status).toBe("unavailable");
  });

  it("reports a provider Pi has no credential for as authentication-required", async () => {
    const result = await inspectSource("openai", { environment: { FAKE_PI_AUTH_READY: "0" } });
    if (result?.status !== "authentication-required") {
      throw new Error(`Expected authentication-required, got ${result?.status}`);
    }
    expect(result.setupMethods?.map((method) => method.kind)).toEqual(["secret-input"]);
    expect(result.connections?.[0]?.authKind).toBe("api-key");
  });

  it("names a subscription source's connection a subscription before any sign-in", async () => {
    const result = await inspectSource("openai-codex", {
      environment: { FAKE_PI_AUTH_READY: "0" },
    });
    if (result?.status !== "authentication-required") throw new Error("Expected auth required");
    expect(result.connections?.[0]?.authKind).toBe("subscription");
    expect(result.setupMethods?.map((method) => method.kind)).toEqual(["device-code"]);
  });

  it("offers no setup methods for an ambient profile", async () => {
    const result = await inspectSource("openai", {
      environment: { FAKE_PI_AUTH_READY: "0" },
      providerStateKind: "ambient",
    });
    if (result?.status !== "authentication-required") throw new Error("Expected auth required");
    expect(result.setupMethods).toBeUndefined();
  });

  it("reads a compatible endpoint's own model list and reports it unreachable otherwise", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = testDriver({
      fetchModels: (_input, init) =>
        Promise.resolve(
          new Headers(init?.headers).get("authorization") === "Bearer sk-endpoint-key"
            ? new Response(
                JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "openai/gpt-5.5" }] }),
                { headers: { "content-type": "application/json" }, status: 200 },
              )
            : new Response("unauthorized", { status: 401 }),
        ),
    });
    const context = {
      config: { baseUrl: "https://openrouter.ai/api/v1" },
      environment: stringEnvironment(process.env),
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: piCompatibleSourceId,
      workingDirectory: directory,
    } as const;
    // Discovery asks without a key first; only the endpoint's refusal asks for one.
    const missingKey = await driver.inspect(context);
    expect(missingKey).toMatchObject({
      detail: "openrouter.ai needs an API key",
      setupMethods: [{ kind: "secret-input", methodId: "pi-api-key" }],
      status: "authentication-required",
    });

    await driver.authenticate!(context, { methodId: "pi-api-key" }).then((start) => {
      if (start.status !== "pending") throw new Error("Expected a pending sign-in");
      return start.submit?.("sk-endpoint-key");
    });
    const ready = await driver.inspect(context);
    if (ready.status !== "ready") throw new Error(`Expected ready, got ${ready.status}`);
    expect(ready.connections?.[0]).toMatchObject({ authKind: "api-key", logoutSupported: true });
    // Two spellings of one model collapse to one canonical row.
    expect(ready.models).toEqual([
      expect.objectContaining({ modelId: "gpt-5.5", providerId: "openai" }),
    ]);

    const unreachable = await testDriver({
      fetchModels: () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          }),
        ),
    }).inspect(context);
    expect(unreachable).toMatchObject({
      detail: "Nothing is answering at openrouter.ai. Start the server, then try again.",
      status: "unavailable",
    });

    const notJson = await testDriver({
      fetchModels: () =>
        Promise.resolve(
          new Response("<html>nope</html>", {
            headers: { "content-type": "text/html" },
            status: 200,
          }),
        ),
    }).inspect(context);
    expect(notJson).toMatchObject({
      detail:
        "openrouter.ai answered, but not with a model list. Check the address and the server type.",
      status: "unavailable",
    });
  });

  it("keeps a compatible endpoint's complete large list and rejects overflow", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `local-model-${index}` }));
    const context = {
      config: { baseUrl: "https://endpoint.test/v1" },
      environment: stringEnvironment(process.env),
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: piCompatibleSourceId,
      workingDirectory: directory,
    } as const;
    const authenticate = testDriver();
    await authenticate.authenticate!(context, { methodId: "pi-api-key" }).then((start) => {
      if (start.status !== "pending") throw new Error("Expected a pending sign-in");
      return start.submit?.("endpoint-key");
    });

    const listed = await testDriver({
      fetchModels: async () => Response.json({ data: entries(300) }),
    }).inspect(context);
    if (listed.status !== "ready") throw new Error(`Expected ready, got ${listed.status}`);
    expect(listed.models).toHaveLength(300);
    expect(listed.models.at(-1)?.nativeModelId).toBe("local-model-299");

    const oversized = await testDriver({
      fetchModels: async () => Response.json({ data: entries(8_193) }),
    }).inspect(context);
    expect(oversized).toMatchObject({
      detail: expect.stringContaining("8193 models"),
      status: "unavailable",
    });

    const partlyInvalid = await testDriver({
      fetchModels: async () => Response.json({ data: [{ id: "valid" }, { id: " " }] }),
    }).inspect(context);
    expect(partlyInvalid).toMatchObject({
      detail: expect.stringContaining("not with a model list"),
      status: "unavailable",
    });
  });
});

describe("Pi credentials", () => {
  it("writes an API key into a private auth.json and never into the process environment", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = testDriver();
    const start = await driver.authenticate!(
      authenticationContext(directory, providerState, "anthropic"),
      { methodId: "pi-api-key" },
    );
    if (start.status !== "pending") throw new Error("Expected a pending sign-in");
    expect(start.challenge).toMatchObject({ kind: "secret-input" });
    await start.submit?.("sk-ant-secret-value");
    expect(await start.result).toEqual({ status: "ready" });

    const authPath = join(providerState.providerHomeDirectory ?? "", "auth.json");
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    expect(stored).toEqual({ anthropic: { key: "sk-ant-secret-value", type: "api_key" } });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);

    // A second source shares the file rather than replacing it.
    const second = await driver.authenticate!(
      authenticationContext(directory, providerState, "openai"),
      { methodId: "pi-api-key" },
    );
    if (second.status !== "pending") throw new Error("Expected a pending sign-in");
    await second.submit?.("sk-openai-secret");
    expect(Object.keys(JSON.parse(await readFile(authPath, "utf8")))).toEqual([
      "anthropic",
      "openai",
    ]);

    await driver.logout!(authenticationContext(directory, providerState, "anthropic"));
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      openai: { key: "sk-openai-secret", type: "api_key" },
    });
  });

  it("refuses to sign in or out of an ambient profile", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "ambient");
    const driver = testDriver();
    await expect(
      driver.authenticate!(authenticationContext(directory, providerState, "openai"), {
        methodId: "pi-api-key",
      }),
    ).rejects.toThrow(/never writes a credential/);
    await expect(
      driver.logout!(authenticationContext(directory, providerState, "openai")),
    ).rejects.toThrow(/sign out with Pi yourself/);
  });

  it("refuses a setup method the source does not have", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    await expect(
      testDriver().authenticate!(authenticationContext(directory, providerState, "openai"), {
        methodId: "pi-device-code",
      }),
    ).rejects.toThrow(/Unknown Pi setup method/);
  });

  it("surfaces a device-code challenge from the sign-in child and cancels it", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    let terminated = false;
    const driver = testDriver({
      executable: await fakePiPackage(directory),
      spawnLoginProcess: (options) => {
        expect(options.args[1]).toMatch(/^file:\/\//u);
        expect(options.args[2]).toBe("github-copilot");
        return fakeLoginProcess(
          [
            {
              type: "device_code",
              userCode: "E63D-B3E2",
              verificationUrl: "https://github.com/login/device",
            },
          ],
          () => {
            terminated = true;
          },
        );
      },
    });
    const start = await driver.authenticate!(
      authenticationContext(directory, providerState, "github-copilot"),
      { methodId: "pi-device-code" },
    );
    if (start.status !== "pending") throw new Error("Expected a pending sign-in");
    expect(start.challenge).toEqual({
      kind: "device-code",
      userCode: "E63D-B3E2",
      verificationUrl: "https://github.com/login/device",
    });
    // The generated program is written where Pi will read its own auth.json.
    const scriptPath = join(providerState.providerHomeDirectory ?? "", "opensteer-login.mjs");
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o600);
    await start.cancel();
    expect(await start.result).toMatchObject({ status: "failed" });
    expect(terminated).toBe(true);
  });

  it.each([
    [
      "an exit code with no ready frame",
      [`${JSON.stringify({ type: "device_code", userCode: "A", verificationUrl: "https://x" })}\n`],
      0,
      /did not complete/u,
    ],
    [
      "a frame Opensteer cannot read",
      [
        `${JSON.stringify({ type: "device_code", userCode: "A", verificationUrl: "https://x" })}\n`,
        "not a frame at all\n",
      ],
      0,
      /could not read/u,
    ],
    [
      "a failure the child stated",
      [
        `${JSON.stringify({ type: "device_code", userCode: "A", verificationUrl: "https://x" })}\n`,
        `${JSON.stringify({ detail: "the provider said no", type: "failed" })}\n`,
      ],
      1,
      /the provider said no/u,
    ],
  ] as const)("fails a device-code sign-in on %s", async (_name, chunks, exitCode, detail) => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = testDriver({
      executable: await fakePiPackage(directory),
      spawnLoginProcess: () => rawLoginProcess([...chunks], exitCode),
    });
    const start = await driver.authenticate!(
      authenticationContext(directory, providerState, "github-copilot"),
      { methodId: "pi-device-code" },
    );
    if (start.status !== "pending") throw new Error("Expected a pending sign-in");
    expect(await start.result).toEqual({ detail: expect.stringMatching(detail), status: "failed" });
  });

  it("accepts a device-code sign-in only on the child's ready frame", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = testDriver({
      executable: await fakePiPackage(directory),
      // No trailing newline on the last frame: a child that exits without one
      // still said something, so the framer's remainder is read.
      spawnLoginProcess: () =>
        rawLoginProcess(
          [
            `${JSON.stringify({ type: "device_code", userCode: "A", verificationUrl: "https://x" })}\n`,
            JSON.stringify({ type: "ready" }),
          ],
          0,
        ),
    });
    const start = await driver.authenticate!(
      authenticationContext(directory, providerState, "github-copilot"),
      { methodId: "pi-device-code" },
    );
    if (start.status !== "pending") throw new Error("Expected a pending sign-in");
    expect(await start.result).toEqual({ status: "ready" });
  });

  it("fails a device-code sign-in whose child writes an unreadable line after ready", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    let terminated = false;
    const driver = testDriver({
      executable: await fakePiPackage(directory),
      spawnLoginProcess: () =>
        rawLoginProcess(
          [
            `${JSON.stringify({ type: "device_code", userCode: "A", verificationUrl: "https://x" })}\n`,
            `${JSON.stringify({ type: "ready" })}\n`,
            // Longer than the driver's own line bound, so the framer rejects.
            `${"x".repeat(80 * 1_024)}\n`,
          ],
          0,
          () => {
            terminated = true;
          },
        ),
    });
    const start = await driver.authenticate!(
      authenticationContext(directory, providerState, "github-copilot"),
      { methodId: "pi-device-code" },
    );
    if (start.status !== "pending") throw new Error("Expected a pending sign-in");
    // `ready` plus exit 0 must not outweigh output the driver could not read.
    expect(await start.result).toEqual({
      detail: expect.stringMatching(/longer than/u),
      status: "failed",
    });
    expect(terminated).toBe(true);
  });

  it("reports a device-code child that dies before it ever shows a code", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = testDriver({
      executable: await fakePiPackage(directory),
      spawnLoginProcess: () =>
        rawLoginProcess([`${JSON.stringify({ detail: "no network", type: "failed" })}\n`], 1),
    });
    // There is nothing for the person to do, so the flow never becomes pending.
    await expect(
      driver.authenticate!(authenticationContext(directory, providerState, "github-copilot"), {
        methodId: "pi-device-code",
      }),
    ).rejects.toThrow(/no network/u);
  });

  it("generates a sign-in program that parses, and finds the Pi package entry", async () => {
    const directory = await temporaryDirectory();
    const scriptPath = join(directory, "opensteer-login.mjs");
    await writeFile(scriptPath, piLoginScriptSource());
    // Node parses it as an ES module, which is how the Runner will start it.
    const check = spawnSupervised({
      args: ["--check", scriptPath],
      cwd: directory,
      environment: stringEnvironment(process.env),
      executable: process.execPath,
    });
    expect((await check.exited).code).toBe(0);

    const packageRoot = join(directory, "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    await mkdir(join(packageRoot, "dist", "bundle"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: { ".": { import: "./dist/index.js" } },
        name: "@earendil-works/pi-coding-agent",
      }),
    );
    const entry = await piPackageEntryUrl(join(packageRoot, "dist", "bundle", "cli.js"));
    expect(entry).toBe(`file://${join(packageRoot, "dist", "index.js")}`);
    await expect(piPackageEntryUrl(join(directory, "elsewhere", "cli.js"))).rejects.toThrow(
      /Pi package could not be found/,
    );
  });
});

describe("Pi sessions", () => {
  it("starts the process the Runner's way and proves the extension loaded", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say something"));
    await session.stop();

    const captured = await fixture.capture();
    const launch = captured.find((entry) => entry.fakePiProcess)?.fakePiProcess as
      Record<string, unknown> | undefined;
    const argv = (launch?.argv ?? []) as string[];
    expect(argv.slice(0, 7)).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
    ]);
    expect(argv).toContain("--extension");
    expect(argv).toContain("--append-system-prompt");
    expect(launch?.cwd).toBe(fixture.context.workspacePath);
    const environment = launch?.environment as Record<string, string>;
    expect(environment.PI_OFFLINE).toBe("1");
    expect(environment.PI_TELEMETRY).toBe("0");
    expect(environment.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(environment.PI_CODING_AGENT_DIR).toBe(
      fixture.context.providerState.providerHomeDirectory,
    );

    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.delta",
      "assistant.message",
      "run.usage",
      "run.completed",
    ]);
    await fixture.adapter.close();
  });

  it("sends the native model id and the thinking level, and verifies both", async () => {
    const fixture = await setup({
      modelSelection: {
        modelId: "claude-opus-4-8",
        nativeModelId: "anthropic/claude-opus-4.8:free",
        options: { thinking: "high" },
        providerId: "anthropic",
      },
      sourceId: "openrouter",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    const captured = await fixture.capture();
    const argv = ((captured.find((entry) => entry.fakePiProcess)?.fakePiProcess as JsonRecord)
      ?.argv ?? []) as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/claude-opus-4.8:free");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
    expect(captured.find((entry) => entry.type === "set_model")).toMatchObject({
      modelId: "anthropic/claude-opus-4.8:free",
      provider: "openrouter",
    });
    expect(captured.find((entry) => entry.type === "set_thinking_level")).toMatchObject({
      level: "high",
    });
    await fixture.adapter.close();
  });

  it("fails the session when Pi selects a different model", async () => {
    const fixture = await setup({ scenario: "model-missing" });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(/could not select/);
    await fixture.adapter.close();
  });

  it("fails the session when Pi clamps the thinking level it was given", async () => {
    const fixture = await setup({
      modelSelection: {
        modelId: "claude-opus-4-8",
        options: { thinking: "low" },
        providerId: "anthropic",
      },
      scenario: "thinking-clamped",
    });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(
      /selected thinking level high instead of low/u,
    );
    await fixture.adapter.close();
  });

  it.each(["no-handshake", "stale-extension", "no-ui", "extension-error"])(
    "refuses to run when the extension never announced itself (%s)",
    async (scenario) => {
      const fixture = await setup({ scenario, startupTimeoutMs: 1_500 });
      await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow();
      await fixture.adapter.close();
    },
  );

  it("writes the extension and the instructions into Thread state at 0600", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    const extensionPath = join(fixture.context.threadStateDirectory, piExtensionFileName);
    expect((await stat(extensionPath)).mode & 0o777).toBe(0o600);
    const extension = await readFile(extensionPath, "utf8");
    expect(extension).toContain(noComputersNotice);
    expect(extension).toContain("thread_read");
    // No credential ever reaches the file the model's own commands could read.
    expect(extension).not.toContain(fixture.context.agentTools.token);
    expect(extension).not.toContain(fixture.context.integrationTools.token);

    const instructions = await readFile(
      join(fixture.context.threadStateDirectory, "opensteer-instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("Opensteer platform guide.");
    expect(instructions).toContain("Follow the workspace instructions.");
    expect(instructions).toContain("thread_read");
    await fixture.adapter.close();
  });

  it("keeps every Opensteer token out of the harness process environment", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    const captured = await fixture.capture();
    const environment = ((
      captured.find((entry) => entry.fakePiProcess)?.fakePiProcess as JsonRecord
    )?.environment ?? {}) as Record<string, string>;
    const serialized = JSON.stringify(environment);
    expect(serialized).not.toContain(fixture.context.agentTools.token);
    expect(serialized).not.toContain(fixture.context.integrationTools.token);
    await fixture.adapter.close();
  });

  it("opens a command approval, and a denial's note reaches the model", async () => {
    const fixture = await setup({ scenario: "approval" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    expect(opened.data.request.presentation).toMatchObject({
      detail: "rm -rf /tmp/scratch",
      kind: "choice",
      title: "Approve command",
    });
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "reject",
      text: "not on a Friday",
    });
    await running;
    const completed = observer.events.find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({
      data: {
        isError: true,
        output: expect.objectContaining({ text: expect.stringContaining("not on a Friday") }),
      },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("opens a file-change approval that shows the edit the model proposed", async () => {
    const fixture = await setup({ scenario: "approval-file" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Edit it"));
    const opened = await observer.waitFor("request.opened");
    expect(opened.data.request.presentation).toMatchObject({
      detail: expect.stringContaining("/w/app.ts"),
      title: "Approve file changes",
    });
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await running;
    expect(observer.events.find((event) => event.type === "tool.completed")).toMatchObject({
      data: { isError: false },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("refuses a response that does not match the pending approval", async () => {
    const fixture = await setup({ scenario: "approval" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    await expect(
      session.resolveRequest(opened.data.request.id, { kind: "form", answers: {} }),
    ).rejects.toThrow(/does not match/);
    await expect(
      session.resolveRequest(createId("request"), { kind: "choice", optionId: "allow-once" }),
    ).rejects.toThrow(/not found/);
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await running;
    await session.stop();
    await fixture.adapter.close();
  });

  it("cancels a pending approval when the turn is interrupted", async () => {
    const fixture = await setup({ scenario: "approval-pending" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    await session.interrupt();
    await running;
    expect(observer.events.find((event) => event.type === "request.cancelled")).toMatchObject({
      data: { reason: "run-ended", requestId: opened.data.request.id },
    });
    expect(normalizedTypes(observer.events).filter((type) => type.startsWith("run."))).toContain(
      "run.interrupted",
    );
    expect(
      normalizedTypes(observer.events).filter((type) =>
        ["run.completed", "run.failed", "run.interrupted"].includes(type),
      ),
    ).toHaveLength(1);
    await session.stop();
    await fixture.adapter.close();
  });

  it("pins Opensteer tool calls above the autonomous sign-in wait", () => {
    expect(piToolCallTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("runs an Opensteer tool through the driver's own MCP client", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const fixture = await setup({
      connectMcpServer: fakeMcp((name, args) => {
        calls.push({ args, name });
        return { content: [{ text: `served ${name}`, type: "text" }], isError: false };
      }),
      scenario: "opensteer-tool",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Read the Thread"));
    expect(calls).toEqual([{ args: { query: "recent" }, name: "thread_read" }]);
    const started = observer.events.find((event) => event.type === "tool.started");
    expect(started).toMatchObject({
      data: { tool: { name: "thread_read", namespace: "opensteer" } },
    });
    expect(observer.events.find((event) => event.type === "tool.completed")).toMatchObject({
      data: { isError: false, output: expect.objectContaining({ text: "served thread_read" }) },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("reports a failing Opensteer tool back to the model as an error", async () => {
    const fixture = await setup({
      connectMcpServer: fakeMcp(() => {
        throw new Error("the Host refused");
      }),
      scenario: "opensteer-tool-error",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Read the Thread"));
    expect(observer.events.find((event) => event.type === "tool.completed")).toMatchObject({
      data: {
        isError: true,
        output: expect.objectContaining({ text: expect.stringContaining("the Host refused") }),
      },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("reads Opensteer's tools from a real MCP server over Streamable HTTP", async () => {
    const directory = await temporaryDirectory();
    const token = "os_secret_test_token";
    const url = await startFakeMcpServer(directory, token, ["thread_read", "workspace_list"]);
    const connectOptions = { signal: new AbortController().signal, timeoutMs: 10_000 };
    const connection = await connectPiMcpServer(
      { name: "opensteer", token, toolNames: ["thread_read"], url },
      connectOptions,
    );
    try {
      const tools = await connection.listTools(connectOptions);
      // Only the declared tool is offered onward, whatever the server listed.
      expect(tools.map((tool) => tool.name)).toEqual(["thread_read"]);
      expect(tools[0]?.inputSchema).toMatchObject({ required: ["query"], type: "object" });
      const result = await connection.callTool(
        "thread_read",
        { query: "hello" },
        new AbortController().signal,
      );
      expect(result).toEqual({
        content: [{ text: "thread_read:hello", type: "text" }],
        isError: false,
      });
      await expect(
        connection.callTool("workspace_list", {}, new AbortController().signal),
      ).rejects.toThrow(/does not offer the tool/);
      const failure = await connection.callTool(
        "thread_read",
        { query: "fail" },
        new AbortController().signal,
      );
      expect(failure.isError).toBe(true);
      // A result that carries a picture keeps it: Pi's tool results hold text
      // and images in exactly these shapes. The audio block has no place in
      // one, so it is left out rather than handed to a provider blind.
      const picture = await connection.callTool(
        "thread_read",
        { query: "picture" },
        new AbortController().signal,
      );
      expect(picture).toEqual({
        content: [
          { text: "thread_read:observed", type: "text" },
          { data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png", type: "image" },
        ],
        isError: false,
      });
    } finally {
      await connection.close();
    }
  });

  it("maps an MCP result's text and image blocks onto Pi's tool-result content", () => {
    expect(
      piToolContent([
        { text: "Observation obs_1 of Notes", type: "text" },
        { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
        { resource: { text: "x", uri: "file:///note" }, type: "resource" },
        { data: "", mimeType: "image/png", type: "image" },
        "not a block",
      ]),
    ).toEqual([
      { text: "Observation obs_1 of Notes", type: "text" },
      { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
    ]);
    // A result that is not a list of blocks at all is no content, never a
    // half-read one.
    expect(piToolContent(undefined)).toEqual([]);
  });

  it("refuses a request that names a tool Opensteer does not serve", async () => {
    const fixture = await setup({
      connectMcpServer: fakeMcp(() => ({ content: [], isError: false }), []),
      scenario: "opensteer-tool",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Read the Thread"));
    expect(observer.events.find((event) => event.type === "tool.completed")).toMatchObject({
      data: { isError: true },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("answers an Opensteer tool call while an approval is still pending", async () => {
    const fixture = await setup({
      connectMcpServer: fakeMcp(() => ({
        content: [{ text: "served while waiting", type: "text" }],
        isError: false,
      })),
      scenario: "tool-during-approval",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Do both"));
    const opened = await observer.waitFor("request.opened");
    // The tool completed although the person has not answered yet.
    const completed = await waitForOccurrence(observer, "tool.completed", 1);
    expect(completed.data).toMatchObject({ callId: "call_b", isError: false });
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await running;
    expect(observer.events.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    await session.stop();
    await fixture.adapter.close();
  });

  it("cancels a pending approval before the Run fails with the Pi process", async () => {
    const fixture = await setup({ scenario: "die-during-approval" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    await running;
    const order = normalizedTypes(observer.events);
    expect(order).toContain("request.cancelled");
    expect(observer.events.find((event) => event.type === "request.cancelled")).toMatchObject({
      data: { reason: "run-ended", requestId: opened.data.request.id },
    });
    // The cancellation is on the stream before the Run's outcome, so nothing
    // the Host records leaves a Request pending past its Run.
    expect(order.indexOf("request.cancelled")).toBeLessThan(order.indexOf("run.failed"));
    await session.stop();
    await fixture.adapter.close();
  });

  it("cancels a pending approval before a Run that settles anyway completes", async () => {
    const fixture = await setup({ scenario: "settle-with-approval-pending" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    await running;
    const order = normalizedTypes(observer.events);
    expect(observer.events.find((event) => event.type === "request.cancelled")).toMatchObject({
      data: { reason: "run-ended", requestId: opened.data.request.id },
    });
    expect(order.indexOf("request.cancelled")).toBeLessThan(order.indexOf("run.completed"));
    // The Request is gone, so answering it afterwards is refused rather than
    // reaching a turn that has ended.
    await expect(
      session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "allow-once" }),
    ).rejects.toThrow(/not found/u);
    await session.stop();
    await fixture.adapter.close();
  });

  it("publishes nothing when a session is stopped after its turn completed", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    // `execute` resolves when the terminal event is published, which is not yet
    // when the consumer has drained it.
    await observer.waitFor("run.completed");
    const afterRun = normalizedTypes(observer.events);
    expect(afterRun.at(-1)).toBe("run.completed");
    await session.stop();
    await observer.done;
    expect(normalizedTypes(observer.events)).toEqual(afterRun);
    await fixture.adapter.close();
  });

  it("cancels a pending approval when the session is stopped", async () => {
    const fixture = await setup({ scenario: "approval-pending" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Clean up"));
    const opened = await observer.waitFor("request.opened");
    await session.stop();
    await running;
    expect(observer.events.find((event) => event.type === "request.cancelled")).toMatchObject({
      data: { requestId: opened.data.request.id },
    });
    await fixture.adapter.close();
  });

  it("kills a Pi process tree that ignores termination", async () => {
    const fixture = await setup({ scenario: "ignore-termination", shutdownGraceMs: 0 });
    const session = await fixture.adapter.startSession(fixture.context);
    const captured = await fixture.capture();
    const grandchild = captured.find((entry) => entry.fakeGrandchildPid)?.fakeGrandchildPid;
    expect(typeof grandchild).toBe("number");
    await session.stop();
    await waitForProcessExit(grandchild as number);
    expect(processExists(grandchild as number)).toBe(false);
    await fixture.adapter.close();
  });

  it("steers a running turn and refuses to steer an idle one", async () => {
    const fixture = await setup({ scenario: "long-tool" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Take your time"));
    await observer.waitFor("run.started");
    const steer = session.steer?.bind(session);
    if (!steer) throw new Error("Pi sessions must advertise steering");
    await steer({ input: humanInput("actually, do this instead") });
    await session.interrupt();
    await running;
    await expect(steer({ input: humanInput("too late") })).rejects.toThrow(/no steerable/);
    await session.stop();
    await fixture.adapter.close();
  });

  it("answers a steer Pi takes between tool rounds within the same turn", async () => {
    const fixture = await setup({ scenario: "long-tool" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Take your time"));
    await observer.waitFor("tool.started");
    await session.steer!({ input: humanInput("also check the logs") });
    await running;
    await session.stop();
    await observer.done;
    // Pi took it with the tool's result, so the one answer covers both.
    expect(assistantTexts(observer.events)).toEqual(["All done."]);
    expect(normalizedTypes(observer.events)).not.toContain("run.phase");
    expect(normalizedTypes(observer.events).at(-1)).toBe("run.completed");
    await fixture.adapter.close();
  });

  it("keeps the answer Pi gave before taking a steer as that turn's reply", async () => {
    const fixture = await setup({ scenario: "late-answer" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Answer briefly"));
    await observer.waitFor("run.started");
    await session.steer!({ input: humanInput("and mention Friday") });
    await running;
    await session.stop();
    await observer.done;
    expect(lifecycle(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.phase",
      "run.phase",
      "assistant.message",
      "run.completed",
    ]);
    expect(
      observer.events.flatMap((event) =>
        event.type === "run.phase" ? [(event.data as { readonly phase: string }).phase] : [],
      ),
    ).toEqual(["background", "turn"]);
    await fixture.adapter.close();
  });

  it("answers a steer that reaches Pi after it settled, as a turn of the same Run", async () => {
    const fixture = await setup({ scenario: "late-steer" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Answer briefly"));
    await observer.waitFor("run.started");
    await session.steer!({ input: humanInput("and mention Friday") });
    await running;
    await session.stop();
    await observer.done;
    expect(lifecycle(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.phase",
      "run.phase",
      "assistant.message",
      "run.completed",
    ]);
    expect(
      observer.events.flatMap((event) =>
        event.type === "run.phase" ? [(event.data as { readonly phase: string }).phase] : [],
      ),
    ).toEqual(["background", "turn"]);
    // The late message opened a turn of its own instead of waiting in Pi's queue.
    const prompts = (await fixture.capture()).filter((entry) => entry.type === "prompt");
    expect(prompts.at(-1)).toMatchObject({ streamingBehavior: "steer" });
    expect(String(prompts.at(-1)?.message)).toContain("and mention Friday");
    await fixture.adapter.close();
  });

  it("clears the queue before aborting, so no queued work starts", async () => {
    const fixture = await setup({ scenario: "long-tool" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const running = session.execute(fixture.turn("Take your time"));
    await observer.waitFor("run.started");
    await session.steer!({ input: humanInput("queued") });
    await session.interrupt();
    await running;
    const captured = await fixture.capture();
    const order = captured.flatMap((entry) =>
      entry.type === "clear_queue" || entry.type === "abort" ? [entry.type] : [],
    );
    expect(order).toEqual(["clear_queue", "abort"]);
    expect(normalizedTypes(observer.events)).toContain("run.interrupted");
    await session.stop();
    await fixture.adapter.close();
  });

  it("reports a plan-exhaustion error under the shared usage-limit code", async () => {
    const fixture = await setup({ scenario: "limit-error" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    const failed = await observer.waitFor("run.failed");
    expect(failed.data).toMatchObject({ code: harnessUsageLimitFailureCode, retryable: false });
    // Usage still travels: the provider stated it before it refused.
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.delta",
      "run.usage",
      "run.failed",
    ]);
    await session.stop();
    await fixture.adapter.close();
  });

  it("reports an authentication error as a harness failure and a 503 as retryable", async () => {
    const auth = await setup({ scenario: "auth-error" });
    const authSession = await auth.adapter.startSession(auth.context);
    const authObserver = observe(authSession.events);
    await authSession.execute(auth.turn("Go"));
    expect((await authObserver.waitFor("run.failed")).data).toMatchObject({
      code: "pi_harness_error",
      message: expect.stringContaining("authentication_error"),
      retryable: false,
    });
    await authSession.stop();
    await auth.adapter.close();

    const transient = await setup({ scenario: "plain-error" });
    const transientSession = await transient.adapter.startSession(transient.context);
    const transientObserver = observe(transientSession.events);
    await transientSession.execute(transient.turn("Go"));
    expect((await transientObserver.waitFor("run.failed")).data).toMatchObject({ retryable: true });
    await transientSession.stop();
    await transient.adapter.close();
  });

  it("fails the Run when Pi dies mid-turn", async () => {
    const fixture = await setup({ scenario: "die-mid-turn" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    expect((await observer.waitFor("run.failed")).data).toMatchObject({
      message: expect.stringContaining("exited unexpectedly"),
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("reports a refused prompt as the Run's failure", async () => {
    const fixture = await setup({ scenario: "prompt-refused" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    expect((await observer.waitFor("run.failed")).data).toMatchObject({
      message: expect.stringContaining("No API key"),
    });
    expect(normalizedTypes(observer.events)).toEqual(["run.failed"]);
    await session.stop();
    await fixture.adapter.close();
  });

  it("does not acknowledge a turn interrupted before provider admission", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = fixture.turn("Do not submit this");
    const controller = new AbortController();
    controller.abort();

    await session.execute({ ...turn, signal: controller.signal });
    await session.stop();
    await observer.done;

    expect(normalizedTypes(observer.events)).toEqual(["run.interrupted"]);
    await fixture.adapter.close();
  });

  it("states this Run's usage once, with cache reads kept out of the input count", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    const usage = await observer.waitFor("run.usage");
    expect(usage.data).toEqual({
      cacheWriteTokens: 25,
      cachedInputTokens: 1_000,
      costUsd: 0.000446,
      inputTokens: 234,
      outputTokens: 56,
      reasoningTokens: 7,
    });
    expect(observer.events.filter((event) => event.type === "run.usage")).toHaveLength(1);
    // It always precedes the terminal event.
    expect(normalizedTypes(observer.events).indexOf("run.usage")).toBeLessThan(
      normalizedTypes(observer.events).indexOf("run.completed"),
    );
    await session.stop();
    await fixture.adapter.close();
  });

  it("publishes thinking as reasoning and keeps a Run working through Pi's own retry", async () => {
    const fixture = await setup({ scenario: "thinking" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await observer.waitFor("run.completed");
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "reasoning.delta",
      "reasoning.completed",
      "assistant.delta",
      "assistant.message",
      "run.usage",
      "run.completed",
    ]);
    await session.stop();
    await fixture.adapter.close();

    const retry = await setup({ scenario: "retry" });
    const retrySession = await retry.adapter.startSession(retry.context);
    const retryObserver = observe(retrySession.events);
    await retrySession.execute(retry.turn("Go"));
    await retryObserver.waitFor("run.completed");
    expect(normalizedTypes(retryObserver.events)).toContain("run.started");
    expect(normalizedTypes(retryObserver.events)).not.toContain("run.status");
    await retrySession.stop();
    await retry.adapter.close();
  });

  it("survives a U+2028 inside a streamed JSON string", async () => {
    const fixture = await setup({ scenario: "line-separator" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    expect(observer.events.find((event) => event.type === "assistant.delta")).toMatchObject({
      data: { text: "before\u2028after" },
    });
    await session.stop();
    await fixture.adapter.close();
  });

  it("refuses to run on an isolated-service Runner", async () => {
    const fixture = await setup({ runtimeBoundary: isolatedServiceHarnessRuntimeBoundary });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(
      /no command sandbox/,
    );
    await fixture.adapter.close();
  });

  it("refuses to replay durable history as a fresh provider session", async () => {
    const fixture = await setup({ history: [historyMessage("user", "earlier")] });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(
      /cannot be replayed/,
    );
    await fixture.adapter.close();
  });
});

describe("Pi tool servers", () => {
  it.each([
    ["initialize", /did not finish connecting/u],
    // `connect` awaits this POST after `initialize` returns and honours none of
    // the SDK request options, so only the raced deadline ends it.
    ["notifications/initialized", /did not finish connecting/u],
    // Whichever deadline fires first — the SDK's own request timeout or the
    // raced one — the session refuses to open rather than waiting.
    ["tools/list", /did not finish listing|could not be listed/u],
  ] as const)(
    "refuses to open a session when the tool server never answers %s",
    async (stall, detail) => {
      const directory = await temporaryDirectory();
      const fixture = await setup({ startupTimeoutMs: 1_500 });
      // The real connector, pointed at a server that answers the bearer and
      // then says nothing.
      const token = fixture.context.agentTools.token;
      const url = await startFakeMcpServer(directory, token, ["thread_read"], stall);
      fixture.connectMcpServer.value = (plan, options) =>
        connectPiMcpServer({ ...plan, url }, options);
      // The Host accepted the socket and said nothing; only Opensteer's own
      // deadline can end that, and it must end the session rather than the Run.
      await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(detail);
      await fixture.adapter.close();
    },
  );

  it("refuses two tool servers that offer the same tool name", async () => {
    const fixture = await setup({
      // Both servers answer with `thread_read`, which would leave the driver
      // unable to say which one a call belongs to.
      connectMcpServer: fakeMcp(() => ({ content: [], isError: false }), ["thread_read"], true),
    });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(
      /Two Opensteer servers offer a tool named thread_read/u,
    );
    await fixture.adapter.close();
  });

  it("closes a connection that was opened before a later one failed", async () => {
    const closed: string[] = [];
    const fixture = await setup({
      connectMcpServer: async (plan) => {
        if (plan.name === "opensteer_integrations") throw new Error("the Host refused");
        return {
          callTool: async () => ({ content: [], isError: false }),
          close: async () => {
            closed.push(plan.name);
          },
          listTools: async () => [],
        };
      },
    });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toThrow(/Host refused/u);
    expect(closed).toEqual(["opensteer"]);
    await fixture.adapter.close();
  });
});

describe("Pi resume", () => {
  it("rewrites the resolved skill catalog for a resumed session", async () => {
    const fixture = await setup({
      skills: [{ description: "Prepare release notes", name: "release-notes" }],
    });
    const first = await fixture.adapter.startSession(fixture.context);
    await first.execute(fixture.turn("First"));
    const reference = first.providerSessionReference;
    await first.stop();

    const resumed = await fixture.adapter.resumeSession(reference, fixture.context);
    const instructions = await readFile(
      join(fixture.context.threadStateDirectory, "opensteer-instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("- release-notes: Prepare release notes");
    expect(instructions).toContain(
      `SKILL.md: ${join(fixture.context.skills!.skills[0]!.path, "SKILL.md")}`,
    );
    await resumed.stop();
    await fixture.adapter.close();
  });

  it("attaches to exactly the recorded session and never replays it", async () => {
    const fixture = await setup();
    const first = await fixture.adapter.startSession(fixture.context);
    await first.execute(fixture.turn("First"));
    const reference = first.providerSessionReference;
    await first.stop();

    const resumed = await fixture.adapter.resumeSession(reference, fixture.context);
    const observer = observe(resumed.events);
    expect(resumed.providerSessionReference).toBe(reference);
    await resumed.execute(fixture.turn("Second"));
    // Attaching publishes nothing of the earlier conversation.
    expect(normalizedTypes(observer.events)[0]).toBe("run.started");
    const captured = await fixture.capture();
    const resumeLaunch = captured.filter((entry) => entry.fakePiProcess).at(-1)
      ?.fakePiProcess as JsonRecord;
    expect((resumeLaunch.argv as string[]).at(-1)).toBe(reference);
    await resumed.stop();
    await fixture.adapter.close();
  });

  it("fails rather than forking when the recorded session is gone", async () => {
    const fixture = await setup();
    await expect(
      fixture.adapter.resumeSession(
        join(fixture.context.workspacePath, "gone.jsonl"),
        fixture.context,
      ),
    ).rejects.toThrow(/no longer exists/);
    await fixture.adapter.close();
  });

  it("fails rather than forking when the recorded session belongs elsewhere", async () => {
    const fixture = await setup();
    const reference = join(fixture.context.workspacePath, "elsewhere.jsonl");
    await writeFile(
      reference,
      `${JSON.stringify({ cwd: "/somewhere/else", id: "01a0ae39-e96f-70ab-b1c9-0faf62275432", type: "session", version: 3 })}\n`,
    );
    await expect(fixture.adapter.resumeSession(reference, fixture.context)).rejects.toThrow(
      /belongs to \/somewhere\/else/,
    );
    await fixture.adapter.close();
  });

  it("fails when Pi attaches to another session than the one asked for", async () => {
    for (const scenario of ["wrong-session", "wrong-session-id"]) {
      const fixture = await setup({ scenario });
      const reference = join(fixture.context.workspacePath, "recorded.jsonl");
      await writeFile(
        reference,
        `${JSON.stringify({ cwd: fixture.context.workspacePath, id: "01a0ae39-e96f-70ab-b1c9-0faf62275432", type: "session", version: 3 })}\n`,
      );
      await expect(fixture.adapter.resumeSession(reference, fixture.context)).rejects.toThrow(
        /Opensteer asked for/,
      );
      await fixture.adapter.close();
    }
  });

  it("treats Pi's silent fork prompt as a hard failure", async () => {
    const fixture = await setup({ scenario: "cwd-mismatch", startupTimeoutMs: 2_000 });
    const reference = join(fixture.context.workspacePath, "recorded.jsonl");
    await writeFile(
      reference,
      `${JSON.stringify({ cwd: fixture.context.workspacePath, id: "01a0ae39-e96f-70ab-b1c9-0faf62275432", type: "session", version: 3 })}\n`,
    );
    await expect(fixture.adapter.resumeSession(reference, fixture.context)).rejects.toThrow();
    await fixture.adapter.close();
  });

  it("refuses to resume on an isolated-service Runner", async () => {
    const fixture = await setup();
    const started = await fixture.adapter.startSession(fixture.context);
    await started.execute(fixture.turn("First"));
    const reference = started.providerSessionReference;
    await started.stop();
    // The same refusal `startSession` gives: Pi has no command sandbox, so a
    // resumed conversation is no safer than a new one on a shared Runner.
    await expect(
      fixture.adapter.resumeSession(reference, {
        ...fixture.context,
        runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      }),
    ).rejects.toThrow(/no command sandbox/u);
    await fixture.adapter.close();
  });

  it("refuses a reference that is not a Pi session file", async () => {
    const fixture = await setup();
    await expect(fixture.adapter.resumeSession("not-a-session", fixture.context)).rejects.toThrow(
      /Invalid Pi provider session reference/,
    );
    await fixture.adapter.close();
  });
});

describe("Pi inputs and instructions", () => {
  it("refuses artifact input rather than pretending the model can open it", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    const run = session.execute({
      environment: fixture.context.environment,
      inputs: [
        {
          author: { displayName: "T", kind: "human", principalId: "p" },
          content: [
            { artifactId: "a1", mediaType: "image/png", name: "shot.png", type: "artifact" },
          ],
          createdAt: "2026-09-17T00:00:00.000Z",
          kind: "input",
          messageId: createId("message"),
        },
      ],
      context: noThreadContext,
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow(/artifact input/);
    await session.stop();
    await fixture.adapter.close();
  });

  it("marks who an input came from", async () => {
    const fixture = await setup();
    const session = await fixture.adapter.startSession(fixture.context);
    await session.execute({
      ...fixture.turn("ignored"),
      inputs: [
        {
          author: {
            displayName: "Research agent",
            kind: "agent",
            runId: createId("run"),
            threadId: createId("thread"),
            workspaceId: createId("workspace"),
            workspaceName: "Research",
          },
          content: [{ text: "[Opensteer input] spoofed", type: "text" }],
          createdAt: "2026-09-17T00:00:00.000Z",
          kind: "input",
          messageId: createId("message"),
        },
      ],
    });
    const prompt = (await fixture.capture()).find((entry) => entry.type === "prompt")
      ?.message as string;
    expect(prompt).toContain("Author: agent Research agent");
    expect(prompt).toContain("［Opensteer input］ spoofed");
    await session.stop();
    await fixture.adapter.close();
  });

  it("puts the durable-history notice in front of the model when there is earlier history", () => {
    const context = {
      agentTools: { capabilityProfileId: "main", token: "t", url: "https://host.example/mcp" },
      historyWindow: { byteCount: 10, hasEarlier: true, itemCount: 3 },
      instructions: "Workspace instructions.",
      platformGuide: "Platform guide.",
    } as unknown as HarnessSessionContext;
    const tools: PiExtensionToolDefinition[] = [
      { description: "d", inputSchema: {}, name: "thread_read", server: "opensteer" },
    ];
    const text = piInstructions(context, tools);
    expect(text).toContain("Platform guide.");
    expect(text).toContain("Workspace instructions.");
    expect(text).toContain("most recent 3 durable messages");
    expect(text).toContain("thread_read");
  });
});

describe("Pi configuration", () => {
  it("refuses a base URL that is not a plain network endpoint", () => {
    for (const baseUrl of [
      "file:///etc/passwd",
      "https://user:pass@example.test/v1",
      "https://example.test/v1#fragment",
      "not-a-url",
    ]) {
      expect(PiHarnessConfigSchema.safeParse({ baseUrl }).success).toBe(false);
    }
    expect(PiHarnessConfigSchema.safeParse({ baseUrl: "https://example.test/v1" }).success).toBe(
      true,
    );
  });

  it("refuses a compatible-endpoint account with no base URL", async () => {
    await expect(
      testDriver().create({
        config: {},
        instanceId: createId("harnessInstance"),
        sourceId: piCompatibleSourceId,
      }),
    ).rejects.toThrow(/no base URL/);
  });
});

// ---------------------------------------------------------------------------

interface SetupOptions {
  readonly connectMcpServer?: PiMcpConnect;
  readonly executable?: string;
  readonly history?: readonly Message[];
  readonly modelSelection?: {
    readonly modelId: string;
    readonly nativeModelId?: string;
    readonly options: Record<string, string>;
    readonly providerId: string;
  };
  readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
  readonly scenario?: string;
  readonly shutdownGraceMs?: number;
  readonly skills?: readonly { readonly description: string; readonly name: string }[];
  readonly sourceId?: string;
  readonly startupTimeoutMs?: number;
}

interface Fixture {
  readonly adapter: HarnessAdapter;
  readonly connectMcpServer: { value: PiMcpConnect };
  readonly context: HarnessSessionContext;
  capture(): Promise<JsonRecord[]>;
  turn(text: string): HarnessRunInput;
}

function testDriver(
  overrides: Partial<ConstructorParameters<typeof PiHarnessDriver>[0]> = {},
): PiHarnessDriver {
  return new PiHarnessDriver({
    executable: fakePi,
    nodeExecutable: process.execPath,
    ...overrides,
  });
}

function fakeMcp(
  call: (name: string, args: unknown) => PiToolAnswer,
  toolNames: readonly string[] = ["thread_read"],
  onBothServers = false,
): PiMcpConnect {
  return async (plan) => {
    const connection: PiMcpConnection = {
      callTool: async (name, args) => call(name, args),
      close: async () => undefined,
      listTools: async () =>
        onBothServers || plan.name === "opensteer"
          ? toolNames.map((name) => ({
              description: `Fake ${name}`,
              inputSchema: { properties: { query: { type: "string" } }, type: "object" },
              name,
              server: plan.name,
            }))
          : [],
    };
    return connection;
  };
}

/** A directory shaped like the staged Pi tree, so the login child can find the package entry. */
async function fakePiPackage(directory: string): Promise<string> {
  const root = join(directory, "pi", "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      exports: { ".": { import: "./dist/index.js" } },
      name: "@earendil-works/pi-coding-agent",
    }),
  );
  return join(root, "dist", "bundle", "cli.js");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pi-test-"));
  temporaryDirectories.push(directory);
  // macOS puts the system temporary directory behind a symlink; Pi records its
  // own resolved cwd, so the fixture works from the resolved path too.
  return realpath(directory);
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const directory = await temporaryDirectory();
  const capturePath = join(directory, "capture.jsonl");
  const environment = stringEnvironment({
    ...process.env,
    FAKE_PI_CAPTURE_PATH: capturePath,
    FAKE_PI_SCENARIO: options.scenario ?? "happy",
    FAKE_PI_SESSION_DIR: join(directory, "sessions"),
  });
  // A box, so a test can swap the connector after the fixture knows its tokens.
  const connectMcpServer: { value: PiMcpConnect } = {
    value: options.connectMcpServer ?? fakeMcp(() => ({ content: [], isError: false })),
  };
  const driver = testDriver({
    connectMcpServer: (plan, connectOptions) => connectMcpServer.value(plan, connectOptions),
    ...(options.executable ? { executable: options.executable } : {}),
  });
  const harnessInstanceId = createId("harnessInstance") as HarnessInstanceId;
  const adapter = await driver.create({
    config: {
      ...(options.shutdownGraceMs === undefined
        ? {}
        : { shutdownGraceMs: options.shutdownGraceMs }),
      ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    },
    instanceId: harnessInstanceId,
    sourceId: options.sourceId ?? "anthropic",
  });
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const skills = await Promise.all(
    (options.skills ?? []).map(async ({ description, name }) => {
      const path = join(directory, "resolved-skills", name);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nPRIVATE ${name} BODY\n`,
      );
      return { name, path };
    }),
  );
  const context: HarnessSessionContext = {
    accessMode: "approval-required",
    agentTools: {
      capabilityProfileId: "main",
      token: "os_secret_agent_tools_token",
      url: "https://host.example/internal/v1/mcp",
    },
    environment,
    environmentId: createId("environment"),
    harnessInstanceId,
    history: options.history ?? [],
    historyWindow: {
      byteCount: 0,
      hasEarlier: false,
      itemCount: options.history?.length ?? 0,
    },
    instructions: "Follow the workspace instructions.",
    integrationTools: {
      token: "os_secret_integration_tools_token",
      url: "https://host.example/internal/v1/integration-mcp",
    },
    machineAccessNotice: noComputersNotice,
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse(
      options.modelSelection ?? {
        modelId: "claude-opus-4-8",
        options: {},
        providerId: "anthropic",
      },
    ),
    platformGuide: "Opensteer platform guide.",
    providerState: testProviderState(directory, "isolated"),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    skills: skills.length > 0 ? { skills } : undefined,
    threadId: createId("thread"),
    threadStateDirectory: join(directory, "state", "threads", "thread-fixture"),
    workspaceId: createId("workspace"),
    workspacePath,
    wrapProcessLaunch: (launch: HarnessProcessLaunch) => launch,
    writableRoots: [workspacePath],
  };
  return {
    adapter,
    connectMcpServer,
    context,
    async capture() {
      const text = await readFile(capturePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonRecord);
    },
    turn(text) {
      return {
        environment,
        inputs: [humanInput(text)],
        context: noThreadContext,
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        requestedBy: createId("user"),
        runId: createId("run"),
        signal: new AbortController().signal,
      };
    },
  };
}

async function inspectSource(
  sourceId: string,
  options: {
    readonly environment?: Record<string, string>;
    readonly executable?: string;
    readonly providerStateKind?: "ambient" | "isolated";
    readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
  } = {},
): Promise<HarnessInspectionResult | undefined> {
  const directory = await temporaryDirectory();
  const driver = testDriver(options.executable ? { executable: options.executable } : {});
  return driver.inspect({
    config: {},
    environment: stringEnvironment({ ...process.env, ...options.environment }),
    providerState: testProviderState(directory, options.providerStateKind ?? "isolated"),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    sourceId,
    workingDirectory: directory,
  });
}

function authenticationContext(
  directory: string,
  providerState: ReturnType<typeof testProviderState>,
  sourceId: string,
) {
  return {
    config: {},
    environment: stringEnvironment(process.env),
    providerState,
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    sourceId,
    workingDirectory: directory,
  } as const;
}

/** The MCP fixture resolves the SDK from this package's own install. */
async function startFakeMcpServer(
  directory: string,
  token: string,
  tools: readonly string[],
  stall?: "initialize" | "notifications/initialized" | "tools/list",
): Promise<string> {
  const localRequire = createRequire(import.meta.url);
  const server = spawnSupervised({
    args: [fakeMcpServer],
    cwd: directory,
    environment: {
      ...stringEnvironment(process.env),
      OPENSTEER_MCP_SERVER_MODULE: localRequire.resolve(
        "@modelcontextprotocol/sdk/server/index.js",
      ),
      OPENSTEER_MCP_TOKEN: token,
      OPENSTEER_MCP_TOOLS: JSON.stringify(tools),
      ...(stall ? { OPENSTEER_MCP_STALL: stall } : {}),
      OPENSTEER_MCP_TRANSPORT_MODULE: localRequire.resolve(
        "@modelcontextprotocol/sdk/server/streamableHttp.js",
      ),
      OPENSTEER_MCP_TYPES_MODULE: localRequire.resolve("@modelcontextprotocol/sdk/types.js"),
    },
    executable: process.execPath,
    maxOutputBytes: 64 * 1_024,
  });
  runningServers.push(server);
  for await (const chunk of server.stdout) {
    const line = chunk.toString("utf8").trim();
    if (line.startsWith("listening ")) return line.slice("listening ".length);
  }
  throw new Error("The fake MCP server never reported a URL");
}

function fakeLoginProcess(
  messages: readonly unknown[],
  onTerminate: () => void,
): SupervisedProcess {
  return rawLoginProcess(
    messages.map((message) => `${JSON.stringify(message)}\n`),
    undefined,
    onTerminate,
  );
}

/**
 * A sign-in child whose exact bytes and exit code the test chooses, so the
 * driver's fail-closed reading of them is what is under test. `exitCode`
 * undefined means the child stays alive until it is terminated.
 */
function rawLoginProcess(
  chunks: readonly string[],
  exitCode: number | undefined,
  onTerminate: () => void = () => undefined,
): SupervisedProcess {
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const stdout = (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
    if (exitCode === undefined) await new Promise<void>(() => undefined);
    else resolveExit({ code: exitCode, signal: null });
  })();
  return {
    child: { stdin: new PassThrough() } as unknown as SupervisedProcess["child"],
    exited,
    stderr: (async function* () {
      yield* [];
    })(),
    stdout,
    terminate: async () => {
      onTerminate();
      resolveExit({ code: 143, signal: null });
    },
  };
}

interface Observer {
  done: Promise<void>;
  readonly events: HarnessEvent[];
  error: unknown;
  waitFor<T extends HarnessEvent["type"]>(type: T): Promise<Extract<HarnessEvent, { type: T }>>;
}

function observe(stream: AsyncIterable<HarnessEvent>): Observer {
  const observer: Observer = {
    done: Promise.resolve(),
    error: undefined,
    events: [],
    async waitFor<T extends HarnessEvent["type"]>(
      type: T,
    ): Promise<Extract<HarnessEvent, { type: T }>> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const event = this.events.find(
          (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
        );
        if (event) return event;
        if (this.error) throw this.error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(
        `Timed out waiting for ${type}; saw ${this.events.map((event) => event.type).join(", ")}`,
      );
    },
  };
  observer.done = (async () => {
    try {
      for await (const event of stream) observer.events.push(event);
    } catch (error) {
      observer.error = error;
    }
  })();
  return observer;
}

async function waitForOccurrence<T extends HarnessEvent["type"]>(
  observer: Observer,
  type: T,
  count: number,
): Promise<Extract<HarnessEvent, { type: T }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const matches = observer.events.filter(
      (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
    );
    const event = matches[count - 1];
    if (event) return event;
    if (observer.error) throw observer.error;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for occurrence ${count} of ${type}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function normalizedTypes(events: readonly HarnessEvent[]): string[] {
  return events.map((event) => event.type);
}

/** How a Run went, turn by turn, without its live progress. */
function lifecycle(events: readonly HarnessEvent[]): string[] {
  return normalizedTypes(events).filter((type) =>
    ["assistant.message", "run.completed", "run.phase", "run.started"].includes(type),
  );
}

function assistantTexts(events: readonly HarnessEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "assistant.message"
      ? (event.data as { readonly content: readonly { readonly text?: string }[] }).content.map(
          (part) => part.text ?? "",
        )
      : [],
  );
}

function humanInput(text: string): HarnessInput {
  return {
    author: { displayName: "Test user", kind: "human", principalId: "test-principal" },
    content: [{ text, type: "text" }],
    createdAt: "2026-09-17T00:00:00.000Z",
    kind: "input",
    messageId: createId("message"),
  };
}

function historyMessage(role: "assistant" | "user", text: string): Message {
  return {
    author:
      role === "user"
        ? { displayName: "Test user", kind: "human", principalId: "test-principal" }
        : { cause: "assistant-history", kind: "platform" },
    content: [{ text, type: "text" }],
    createdAt: new Date().toISOString(),
    id: createId("message"),
    kind: role === "user" ? "input" : "assistant",
    runId: null,
    sequence: "0" as Message["sequence"],
    threadId: createId("thread"),
  };
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function testProviderState(directory: string, kind: "ambient" | "isolated") {
  const privateStateRoot = join(directory, "state");
  return {
    continuationKey: `test:${directory}:${kind}`,
    kind,
    privateStateRoot,
    providerHomeDirectory:
      kind === "isolated" ? join(directory, "profile", "provider-home") : undefined,
    store: {
      directory: join(privateStateRoot, "harness-stores", "pi", "store"),
      id: "store-fixture",
    },
  } as const;
}

type JsonRecord = Record<string, unknown>;

describe("pi Thread naming", () => {
  it("returns both lines from an isolated, tool-free naming process", async () => {
    const fixture = await setup({});
    let namingLaunch: import("@opensteer/harness").HarnessProcessLaunch | undefined;
    const prompt = threadTitlePrompt("Migrate support", { icon: true });
    const session = await fixture.adapter.startSession({
      ...fixture.context,
      wrapProcessLaunch: (launch) => {
        if (!launch.cwd.includes("title-")) return launch;
        namingLaunch = launch;
        return launch;
      },
    });
    try {
      expect(await session.generateTitle!({ prompt, signal: AbortSignal.timeout(2_000) })).toBe(
        "Support migration\nheadphones",
      );
      const launch = namingLaunch!;
      expect(launch.cwd).toContain("title-");

      expect(launch.args).toEqual(
        expect.arrayContaining([
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
        ]),
      );
      expect(launch.args[launch.args.indexOf("--system-prompt") + 1]).toBe(
        "You name tasks. Reply exactly in the format the request asks for. Never use tools.",
      );

      expect(
        (await readdir(fixture.context.threadStateDirectory)).filter((name) =>
          name.startsWith("title-"),
        ),
      ).toEqual([]);
    } finally {
      await session.stop();
      await fixture.adapter.close();
    }
  });
});
