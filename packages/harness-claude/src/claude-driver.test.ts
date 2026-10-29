import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { text } from "node:stream/consumers";
import type {
  AccountInfo,
  ModelInfo,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ModelSelectionSchema,
  createId,
  harnessUsageLimitFailureCode,
  toolOutputTextMaxBytes,
  utf8ByteLength,
  type Message,
} from "@opensteer/core";
import {
  harnessInputHeader,
  harnessThreadContextPrompt,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  threadTitlePrompt,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessInput,
  type HarnessProcessLaunch,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessRuntimeBoundary,
} from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import { MINIMUM_CLAUDE_CODE_VERSION, TESTED_CLAUDE_CODE_VERSION } from "./config.js";
import {
  ClaudeHarnessDriver,
  type ClaudeAuthenticationProcess,
  type ClaudeAuthenticationProcessOptions,
  claudeAccessModeConfiguration,
  managedClaudeSettings,
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
} from "./index.js";

// A Run outside any task with nothing earlier to state, for a person whose
// time zone is unknown: its thread context is one fixed line, so these turns
// carry exactly that context and the inputs and reports each test names.
const noThreadContext = {
  assignment: null,
  requesterTimeZone: null,
  threadState: { previousAssignment: null, previousRun: null },
};

/** A Run's first input, which opens with the Run's thread context. */
function opening(text: string): string {
  return `${harnessThreadContextPrompt(noThreadContext)}\n\n${text}`;
}

const temporaryDirectories: string[] = [];
const fakeClaudeExecutable = "/opt/fake/claude";
const testInputCreatedAt = "2026-08-22T00:00:00.000Z";
const testAgentThreadId = createId("thread");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const noComputersNotice = "No other computers are reachable from this Run.";

describe("Claude Agent SDK harness", () => {
  it("opens only the platform-appropriate Unix socket sandbox access", async () => {
    const providerState = (await context(await temporaryDirectory())).providerState;
    expect(
      managedClaudeSettings({
        machineAccessPlatform: "darwin",
        machineAccessRelaySocket: "/tmp/opensteer/relay.sock",
        providerState,
        runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      }).sandbox?.network,
    ).toEqual({ allowUnixSockets: ["/tmp/opensteer/relay.sock"] });
    expect(
      managedClaudeSettings({
        machineAccessPlatform: "linux",
        machineAccessRelaySocket: "/tmp/opensteer/relay.sock",
        providerState,
        runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      }).sandbox?.network,
    ).toEqual({ allowAllUnixSockets: true });
  });

  it("runs the official CLI browser-code flow without forwarding credentials", async () => {
    const directory = await temporaryDirectory();
    const authentication = fakeAuthentication({
      output: [
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=ephemeral\nPaste code here if prompted > ",
      ],
    });
    let options: ClaudeAuthenticationProcessOptions | undefined;
    const driver = new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: {
        query: () => {
          throw new Error("unused");
        },
      },
      spawnAuthenticationProcess: (input) => {
        options = input;
        return authentication.process;
      },
    });
    const sessionContext = await context(directory);
    const started = await driver.authenticate({
      config: {},
      environment: sessionContext.environment,
      providerState: sessionContext.providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: sessionContext.signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });
    expect(started.status).toBe("pending");
    if (started.status !== "pending") throw new Error("Expected pending Claude sign-in");
    expect(started.challenge).toEqual({
      authorizationUrl: "https://claude.com/cai/oauth/authorize?state=ephemeral",
      inputPrompt: "Paste code here if prompted",
      kind: "browser-code",
    });
    expect(options?.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options?.environment.CLAUDE_CONFIG_DIR).toBe(
      sessionContext.environment.CLAUDE_CONFIG_DIR,
    );
    expect(options?.executable).toBe(fakeClaudeExecutable);
    // Only the driver's own sign-in subprocess may run the login command.
    expect(options?.environment.DISABLE_LOGIN_COMMAND).toBeUndefined();
    expect(options?.environment.DISABLE_LOGOUT_COMMAND).toBeUndefined();
    await started.submit?.("one-time-code");
    expect(authentication.written).toEqual(["one-time-code\n"]);
    authentication.exit(0);
    await expect(started.result).resolves.toEqual({ status: "ready" });
  });

  it("treats a sign-in that completes without a browser URL as ready", async () => {
    const directory = await temporaryDirectory();
    const authentication = fakeAuthentication();
    authentication.exit(0);
    const started = await authenticationDriver(authentication).authenticate({
      config: {},
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    expect(started).toEqual({ status: "ready" });
  });

  it("removes a stored profile API key once the subscription sign-in completes", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const providerHome = providerState.providerHomeDirectory;
    if (!providerHome) throw new Error("Expected an isolated provider home");
    await mkdir(providerHome, { recursive: true });
    const apiKeyPath = join(providerHome, ".opensteer-anthropic-api-key");
    // The driver refuses to read a key other accounts on the computer could,
    // so the fixture stores it the way the driver's own sign-in does.
    await writeFile(apiKeyPath, "superseded-key\n", { mode: 0o600 });
    const authentication = fakeAuthentication({ output: ["visit https://claude.com/oauth\n"] });
    const started = await authenticationDriver(authentication).authenticate({
      config: {},
      environment: {},
      providerState,
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    if (started.status !== "pending") throw new Error("Expected pending Claude sign-in");
    authentication.exit(0);
    await expect(started.result).resolves.toEqual({ status: "ready" });
    await expect(readFile(apiKeyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a cancelled sign-in when the caller aborts the pending flow", async () => {
    const directory = await temporaryDirectory();
    const controller = new AbortController();
    const authentication = fakeAuthentication({ output: ["visit https://claude.com/oauth\n"] });
    const started = await authenticationDriver(authentication).authenticate({
      config: {},
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: controller.signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    if (started.status !== "pending") throw new Error("Expected pending Claude sign-in");
    controller.abort();
    await expect(started.result).resolves.toEqual({
      detail: "Claude sign-in was canceled",
      status: "failed",
    });
  });

  it("fails the sign-in instead of the Runner when the CLI stdin breaks", async () => {
    const directory = await temporaryDirectory();
    const authentication = fakeAuthentication({ output: ["visit https://claude.com/oauth\n"] });
    const started = await authenticationDriver(authentication).authenticate({
      config: {},
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    if (started.status !== "pending") throw new Error("Expected pending Claude sign-in");
    authentication.stdin.destroy(new Error("EPIPE"));
    await started.submit?.("one-time-code");
    const result = await started.result;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected a failed Claude sign-in");
    expect(result.detail).toMatch(/Claude sign-in could not/u);
  });

  it("keeps a redacted tail of the CLI output in a failed sign-in", async () => {
    const directory = await temporaryDirectory();
    const authentication = fakeAuthentication({
      output: [
        "visit https://claude.com/oauth\n",
        "error: oauth_org_not_allowed using os_secret_relay and key deployment-secret\n",
      ],
    });
    const started = await authenticationDriver(authentication).authenticate({
      config: {},
      environment: { OPENSTEER_TEST_API_KEY: "deployment-secret" },
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    if (started.status !== "pending") throw new Error("Expected pending Claude sign-in");
    authentication.exit(7);
    const result = await started.result;
    if (result.status !== "failed") throw new Error("Expected a failed Claude sign-in");
    expect(result.detail).toContain("exit 7");
    expect(result.detail).toContain("oauth_org_not_allowed");
    expect(result.detail).not.toContain("os_secret_relay");
    expect(result.detail).not.toContain("deployment-secret");
    expect(result.detail.length).toBeLessThanOrEqual(500);
  });

  it("never signs an ambient profile out when its Opensteer record is removed", async () => {
    const directory = await temporaryDirectory();
    let spawned = 0;
    const driver = new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: {
        query: () => {
          throw new Error("unused");
        },
      },
      spawnAuthenticationProcess: () => {
        spawned += 1;
        const authentication = fakeAuthentication({ hold: false });
        authentication.exit(0);
        return authentication.process;
      },
    });
    const removal = {
      config: {},
      environment: {},
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    } as const;

    await driver.removeProfile?.({
      ...removal,
      providerState: testProviderState(directory, "ambient"),
    });
    expect(spawned).toBe(0);

    const isolated = testProviderState(directory, "isolated");
    if (!isolated.providerHomeDirectory) throw new Error("Expected an isolated provider home");
    await mkdir(isolated.providerHomeDirectory, { recursive: true });
    await driver.removeProfile?.({ ...removal, providerState: isolated });
    expect(spawned).toBe(1);
  });

  it("gates isolated macOS subscription accounts behind the Keychain qualification", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    if (!providerState.providerHomeDirectory) {
      throw new Error("Expected an isolated provider home");
    }
    await mkdir(providerState.providerHomeDirectory, { recursive: true });
    const sdk = new FakeSdk(
      () => scriptedQuery([]),
      [
        {
          description: "Balanced model",
          displayName: "Sonnet",
          supportsEffort: false,
          value: "sonnet",
        },
      ],
    );

    const catalog = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk,
    }).inspect({
      config: {},
      environment: {},
      providerState,
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });

    expect(catalog.status).toBe("ready");
    expect(catalog.setupMethods?.map(({ methodId }) => methodId)).toEqual(
      process.platform === "darwin"
        ? ["claude-api-key"]
        : ["claude-subscription", "claude-api-key"],
    );
  });

  it("classifies first-party authentication evidence without mistaking no subscription for login", async () => {
    const directory = await temporaryDirectory();
    const models: readonly ModelInfo[] = [
      {
        description: "Balanced model",
        displayName: "Sonnet",
        supportsEffort: false,
        value: "sonnet",
      },
    ];
    const inspection = {
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    } as const;

    const signedOut = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, null),
    }).inspect({ ...inspection, config: {} });
    expect(signedOut).toMatchObject({
      detail: "Sign in to Claude Code on this Runner before using the Claude engine",
      status: "authentication-required",
    });

    const noSubscription = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, {
        apiProvider: "firstParty",
        subscriptionType: "none",
      }),
    }).inspect({ ...inspection, config: {} });
    expect(noSubscription).toMatchObject({
      detail: "Sign in to Claude Code on this Runner before using the Claude engine",
      status: "authentication-required",
    });

    const apiKey = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, {
        apiKeySource: "ANTHROPIC_API_KEY",
        apiProvider: "firstParty",
        subscriptionType: "none",
      }),
    }).inspect({ ...inspection, config: {} });
    expect(apiKey.status).toBe("ready");

    const bedrock = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, null),
    }).inspect({
      ...inspection,
      config: {},
      sourceId: "bedrock",
    });
    expect(bedrock.status).toBe("ready");
    expect(bedrock.setupMethods).toEqual([]);
  });

  it("stores an Anthropic API key only in an isolated profile and injects it at runtime", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const providerHome = providerState.providerHomeDirectory;
    if (!providerHome) throw new Error("Expected an isolated provider home");
    await mkdir(providerHome, { recursive: true });
    const sdk = new FakeSdk(
      () => scriptedQuery([]),
      [
        {
          description: "Balanced model",
          displayName: "Sonnet",
          supportsEffort: false,
          value: "sonnet",
        },
      ],
    );
    const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
    const signal = new AbortController().signal;
    const started = await driver.authenticate(
      {
        config: {},
        environment: { ANTHROPIC_API_KEY: "deployment-key" },
        providerState,
        runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        signal,
        sourceId: "anthropic",
        workingDirectory: directory,
      },
      { connectionSlot: "primary", methodId: "claude-api-key" },
    );
    expect(started).toMatchObject({
      challenge: { inputLabel: "Anthropic API key", kind: "secret-input" },
      status: "pending",
    });
    if (started.status !== "pending") throw new Error("Expected pending Claude API-key setup");
    await started.submit?.("profile-key");
    await expect(started.result).resolves.toEqual({ status: "ready" });
    expect(await readFile(join(providerHome, ".opensteer-anthropic-api-key"), "utf8")).toBe(
      "profile-key",
    );

    const catalog = await driver.inspect({
      config: {},
      environment: { ANTHROPIC_API_KEY: "deployment-key" },
      providerState,
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });
    expect(sdk.inspections[0]?.env?.ANTHROPIC_API_KEY).toBe("profile-key");
    expect(catalog.setupMethods).toEqual(
      expect.arrayContaining([expect.objectContaining({ methodId: "claude-api-key" })]),
    );
  });
  it("maps every Opensteer access mode to an explicit Claude Code policy", () => {
    expect(claudeAccessModeConfiguration("approval-required")).toEqual({
      allowDangerouslySkipPermissions: false,
      permissionMode: "default",
    });
    expect(claudeAccessModeConfiguration("auto-accept-edits")).toEqual({
      allowDangerouslySkipPermissions: false,
      permissionMode: "acceptEdits",
    });
    expect(claudeAccessModeConfiguration("auto")).toEqual({
      allowDangerouslySkipPermissions: false,
      permissionMode: "auto",
    });
    expect(claudeAccessModeConfiguration("full-access")).toEqual({
      allowDangerouslySkipPermissions: true,
      permissionMode: "bypassPermissions",
    });
  });

  it("names the model by the spelling the account's endpoint answers to", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([initMessage(sessionId), successMessage(sessionId, "Done.")]);
    });
    const { adapter, session } = await openSession(sdk, {
      modelSelection: ModelSelectionSchema.parse({
        modelId: "claude-sonnet-5",
        nativeModelId: "anthropic/claude-sonnet-5",
        options: { effort: "medium" },
        providerId: "anthropic",
      }),
    });

    await send(session, "Which model is this?");
    await session.stop();
    await adapter.close();

    expect(sdk.calls[0]?.options.model).toBe("anthropic/claude-sonnet-5");
  });

  it("sends the selected reasoning level and fast mode, and neither when left to Claude Code", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([initMessage(sessionId), successMessage(sessionId, "Done.")]);
    });
    const selected = await openSession(sdk, {
      modelSelection: ModelSelectionSchema.parse({
        modelId: "claude-opus-5[1m]",
        options: { effort: "xhigh", fast: true },
        providerId: "anthropic",
      }),
    });
    await send(selected.session, "Go quickly");
    await selected.session.stop();
    await selected.adapter.close();
    const unset = await openSession(sdk, {
      modelSelection: ModelSelectionSchema.parse({
        modelId: "claude-opus-5[1m]",
        options: { effort: "default", fast: false },
        providerId: "anthropic",
      }),
    });
    await send(unset.session, "Take your time");
    await unset.session.stop();
    await unset.adapter.close();

    expect(sdk.calls[0]?.options).toMatchObject({
      effort: "xhigh",
      model: "claude-opus-5[1m]",
      settings: { fastMode: true },
    });
    expect(sdk.calls[1]?.options.effort).toBeUndefined();
    expect(sdk.calls[1]?.options.settings).toBeUndefined();
  });

  it("leaves runtime resolution to the SDK and denies Runner-private state in an isolated service", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([initMessage(sessionId), successMessage(sessionId, "Done.")]);
    });
    const {
      adapter,
      context: sessionContext,
      session,
    } = await openSession(sdk, {
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });

    await send(session, "Inspect the workspace");
    await session.stop();
    await adapter.close();

    const options = sdk.calls[0]?.options;
    expect(options?.pathToClaudeCodeExecutable).toBe(fakeClaudeExecutable);
    // Background work runs inside the Run that started it, so it stays on.
    expect(options?.disallowedTools).toBeUndefined();
    expect(options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
    expect(options?.env?.DISABLE_LOGIN_COMMAND).toBe("1");
    expect(options?.env?.DISABLE_LOGOUT_COMMAND).toBe("1");
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(
      sessionContext.providerState.providerHomeDirectory,
    );
    expect(options?.managedSettings).toMatchObject({
      permissions: {
        deny: [
          `Read(${sessionContext.providerState.privateStateRoot}/**)`,
          `Edit(${sessionContext.providerState.privateStateRoot}/**)`,
        ],
      },
      sandbox: {
        allowUnsandboxedCommands: false,
        enabled: true,
        failIfUnavailable: true,
        filesystem: {
          denyRead: [sessionContext.providerState.privateStateRoot],
          denyWrite: [sessionContext.providerState.privateStateRoot],
        },
      },
    });
  });

  it("starts the Claude Code process through the Runner's launch wrapper", async () => {
    const launches: HarnessProcessLaunch[] = [];
    const sdkArgs = ["-e", "process.stderr.write('claude-stderr'); process.stdout.write('ok')"];
    let stdout: string | undefined;
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        yield initMessage(providerSessionId(parameters.options));
        const spawnClaudeCodeProcess = parameters.options.spawnClaudeCodeProcess;
        if (!spawnClaudeCodeProcess) throw new Error("Claude harness must install a custom spawn");
        const child = spawnClaudeCodeProcess({
          args: [...sdkArgs],
          command: process.execPath,
          env: { PATH: process.env.PATH ?? "", UNSET_BY_THE_SDK: undefined },
          signal: new AbortController().signal,
        });
        if (!(child instanceof ChildProcess) || !child.stderr) {
          throw new Error("Claude harness must spawn a Node child process");
        }
        // `end` arrives only after the last `data` the driver's forwarder saw,
        // and it can land before the process's stdout is drained, so the wait
        // is registered first.
        const stderrEnded = once(child.stderr, "end");
        stdout = await text(child.stdout);
        await stderrEnded;
        throw new Error("Claude runtime ended");
      }),
    );
    const {
      adapter,
      context: sessionContext,
      session,
    } = await openSession(sdk, {
      wrapProcessLaunch: (launch) => {
        launches.push(launch);
        return {
          ...launch,
          args: ["-e", "process.stderr.write('wrapped'); process.stdout.write('ok')"],
        };
      },
    });
    const observer = observe(session.events);

    await send(session, "Hello");
    const failure = await observer.waitFor("run.failed");
    await session.stop();
    await observer.done;
    await adapter.close();

    expect(launches).toHaveLength(1);
    expect(launches[0]?.executable).toBe(process.execPath);
    expect(launches[0]?.args).toEqual(sdkArgs);
    expect(launches[0]?.cwd).toBe(sessionContext.workspacePath);
    expect(launches[0]?.environment.PATH).toBe(process.env.PATH ?? "");
    expect(launches[0]?.environment).not.toHaveProperty("UNSET_BY_THE_SDK");
    expect(stdout).toBe("ok");
    // The SDK reads only stdin and stdout from a custom spawn, so the wrapped
    // process's stderr reaches the turn's collector only if the driver forwards
    // it; the collector surfaces in the failure it decorates.
    expect(failure.data.message).toContain("Claude runtime stderr:\nwrapped");
  });

  it("normalizes a turn, preserves every lifecycle event, and resumes the fixed provider session", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        message({
          event: {
            delta: { text: "Working", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        message({
          event: {
            content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
            index: 1,
            type: "content_block_start",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        message({
          event: {
            delta: { partial_json: '{"file_path":"README.md"}', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        assistantMessage(sessionId, [
          { id: "tool-1", input: { file_path: "README.md" }, name: "Read", type: "tool_use" },
        ]),
        userMessage(sessionId, [
          { content: "# Opensteer", is_error: false, tool_use_id: "tool-1", type: "tool_result" },
        ]),
        successMessage(sessionId, "Done."),
      ]);
    });
    const {
      adapter,
      context: sessionContext,
      session,
    } = await openSession(sdk, {
      additionalWritableDirectory: "attached-workspace",
      machineAccessNotice: "Other computers: build-box.",
    });
    const observer = observe(session.events);

    await send(session, "Inspect the README");
    await send(session, "Now summarize it");
    await session.stop();
    await observer.done;

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[0]?.options.sessionId).toBe(session.providerSessionReference);
    expect(sdk.calls[0]?.options.resume).toBeUndefined();
    expect(sdk.calls[1]?.options.resume).toBe(session.providerSessionReference);
    expect(sdk.calls[1]?.options.sessionId).toBeUndefined();
    expect(sdk.calls[0]?.options.env?.ENABLE_TOOL_SEARCH).toBe("true");
    expect(sdk.calls[1]?.options.env?.ENABLE_TOOL_SEARCH).toBe("true");
    expect(sdk.calls[0]?.options.mcpServers?.opensteer_integrations).toMatchObject({
      alwaysLoad: false,
    });
    expect(sdk.calls[0]?.options.settingSources).toEqual([]);
    expect(sdk.calls[0]?.options.strictMcpConfig).toBe(true);
    expect(sdk.calls[0]?.options.pathToClaudeCodeExecutable).toBe(fakeClaudeExecutable);
    expect(sdk.calls[0]?.options.permissionMode).toBe("bypassPermissions");
    expect(sdk.calls[0]?.options.allowDangerouslySkipPermissions).toBe(true);
    expect(sdk.calls[0]?.options.additionalDirectories).toEqual([
      join(sessionContext.workspacePath, "attached-workspace"),
    ]);
    expect(sdk.calls[0]?.options.managedSettings).toEqual({
      disableAllHooks: true,
      disableBundledSkills: true,
      disableClaudeAiConnectors: true,
      disableRemoteControl: true,
      disableWorkflows: true,
    });
    expect(sdk.calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(sdk.calls[0]?.options.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBeUndefined();
    expect(sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-user");
    expect(sdk.calls[0]?.options.tools).toEqual([
      "AskUserQuestion",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "NotebookEdit",
      "Read",
      "Skill",
      "ToolSearch",
      "Write",
      "Agent",
      "TaskStop",
    ]);
    expect(sdk.calls[0]?.options.disallowedTools).toBeUndefined();
    expect(sdk.calls[0]?.options.mcpServers?.opensteer).toEqual({
      alwaysLoad: false,
      timeout: 120_000,
      headers: { Authorization: "Bearer test-agent-tools-token" },
      type: "http",
      url: "https://host.example/internal/v1/mcp",
    });
    expect(sdk.calls[0]?.options.allowedTools).toEqual([
      "ToolSearch",
      "mcp__opensteer__request_list",
      "mcp__opensteer__request_withdraw",
      "mcp__opensteer__environment_list",
      "mcp__opensteer__workspace_list",
      "mcp__opensteer__workspace_create",
      "mcp__opensteer__workspace_mount",
      "mcp__opensteer__thread_read",
      "mcp__opensteer__thread_list",
      "mcp__opensteer__thread_delegate",
      "mcp__opensteer__assignment_cancel",
      "mcp__opensteer__thread_message",
      "mcp__opensteer__thread_write",
      "mcp__opensteer__browser_profile_list",
      "mcp__opensteer__sign_in",
      "mcp__opensteer__browser_access_request",
      "mcp__opensteer__machine_full_disk_access_request",
      "mcp__opensteer__browser_tab_read",
      "mcp__opensteer__browser_tab_write",
      "mcp__opensteer__browser_session_list",
      "mcp__opensteer__browser_session_open",
      "mcp__opensteer__browser_profile_create",
      "mcp__opensteer__browser_session_close",
      "mcp__opensteer__trigger_read",
      "mcp__opensteer__trigger_write",
      "mcp__opensteer_integrations__integration_search",
      "mcp__opensteer_integrations__integration_describe",
      "mcp__opensteer_integrations__integration_call",
      "mcp__opensteer_integrations__computer",
      "mcp__opensteer_integrations__integration_request",
      "mcp__opensteer_integrations__integration_propose",
    ]);
    const pluginPath = await realpath(join(sessionContext.threadStateDirectory, "claude-plugin"));
    expect(sdk.calls[0]?.options.plugins).toEqual([
      {
        path: pluginPath,
        skipMcpDiscovery: true,
        type: "local",
      },
    ]);
    expect(sdk.calls[0]?.options.skills).toEqual(["opensteer:opensteer-workspaces"]);
    expect(
      JSON.parse(await readFile(join(pluginPath, ".claude-plugin", "plugin.json"), "utf8")),
    ).toEqual({ name: "opensteer", version: "1.0.0" });
    expect(await realpath(join(pluginPath, "skills", "opensteer-workspaces"))).toBe(
      await realpath(sessionContext.skills?.skills[0]?.path ?? ""),
    );
    expect(sdk.calls[0]?.options.systemPrompt).toMatchObject({
      append: expect.not.stringContaining("Other computers: build-box."),
      preset: "claude_code",
      type: "preset",
    });

    const firstRun = observer.events.slice(
      0,
      observer.events.findIndex((event) => event.type === "run.completed") + 1,
    );
    expect(normalizedTypes(firstRun)).toEqual([
      "run.started",
      "assistant.delta",
      "tool.started",
      "tool.delta",
      // Restated with the complete arguments once the whole block arrived.
      "tool.started",
      "tool.completed",
      "assistant.message",
      "run.completed",
    ]);
    expect(firstRun.find((event) => event.type === "assistant.message")).toMatchObject({
      data: { content: [{ text: "Done.", type: "text" }] },
    });
    expect(firstRun.find((event) => event.type === "tool.started")).toMatchObject({
      data: { tool: { name: "Read", namespace: "claude" } },
    });
    await adapter.close();
  });

  it("projects oversized native tool deltas and results into bounded canonical text", async () => {
    const output = `HEAD-${"🙂".repeat(300_000)}-TAIL`;
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        message({
          event: {
            content_block: { id: "tool-large", input: {}, name: "Bash", type: "tool_use" },
            index: 0,
            type: "content_block_start",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        message({
          event: {
            delta: { partial_json: output, type: "input_json_delta" },
            index: 0,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        assistantMessage(sessionId, [
          { id: "tool-large", input: {}, name: "Bash", type: "tool_use" },
        ]),
        userMessage(sessionId, [
          { content: output, is_error: false, tool_use_id: "tool-large", type: "tool_result" },
        ]),
        successMessage(sessionId, "Done."),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Produce a very large result");
    await session.stop();
    await observer.done;

    const delta = observer.events.find((event) => event.type === "tool.delta");
    const completed = observer.events.find((event) => event.type === "tool.completed");
    if (delta?.type !== "tool.delta" || completed?.type !== "tool.completed") {
      throw new Error("Expected the complete tool lifecycle");
    }
    expect(utf8ByteLength(delta.data.text)).toBeLessThanOrEqual(toolOutputTextMaxBytes);
    expect(completed.data.output.text).toMatch(/^HEAD-[\s\S]*bytes omitted[\s\S]*-TAIL$/u);
    expect(completed.data.output.truncation?.originalBytes).toBe(1_200_010);
    expect(utf8ByteLength(completed.data.output.text)).toBeLessThanOrEqual(toolOutputTextMaxBytes);
    await adapter.close();
  });

  it("normalizes external MCP identities independently of Claude's combined tool name", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        assistantMessage(sessionId, [
          {
            id: "tool-mcp",
            input: { path: "README.md" },
            name: "mcp__github__read_file",
            type: "tool_use",
          },
        ]),
        userMessage(sessionId, [
          { content: "# Opensteer", is_error: false, tool_use_id: "tool-mcp", type: "tool_result" },
        ]),
        successMessage(sessionId, "Done."),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Read the file");
    await session.stop();
    await observer.done;

    expect(observer.events.find((event) => event.type === "tool.started")).toMatchObject({
      data: { tool: { name: "read_file", namespace: "mcp:github" } },
    });
    await adapter.close();
  });

  it("restates a streamed call's start once its arguments are complete", async () => {
    const toolRef = "igr_grant.itl_tool.digest";
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        message({
          event: {
            content_block: {
              id: "tool-gateway",
              input: {},
              name: "mcp__opensteer_integrations__integration_call",
              type: "tool_use",
            },
            index: 0,
            type: "content_block_start",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        message({
          event: {
            delta: { partial_json: `{"toolRef":"${toolRef}"`, type: "input_json_delta" },
            index: 0,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "stream_event",
          uuid: randomProviderUuid(),
        }),
        assistantMessage(sessionId, [
          {
            id: "tool-gateway",
            input: { arguments: {}, toolRef },
            name: "mcp__opensteer_integrations__integration_call",
            type: "tool_use",
          },
        ]),
        userMessage(sessionId, [
          {
            content: "Looked at Slack",
            is_error: false,
            tool_use_id: "tool-gateway",
            type: "tool_result",
          },
        ]),
        successMessage(sessionId, "Done."),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Look at Slack");
    await session.stop();
    await observer.done;

    const starts = observer.events.filter((event) => event.type === "tool.started");
    expect(starts.map((event) => event.data)).toEqual([
      {
        arguments: {},
        callId: "tool-gateway",
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
      {
        arguments: { arguments: {}, toolRef },
        callId: "tool-gateway",
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
    ]);
    await adapter.close();
  });

  it("opens the query with a streaming input that stays open until the result", async () => {
    const received: SDKUserMessage[] = [];
    let inputEnded = false;
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const drained = (async () => {
        for await (const input of streamingPrompt(parameters)) received.push(input);
        inputEnded = true;
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        expect(inputEnded).toBe(false);
        yield successMessage(sessionId, "Done.");
        await drained;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Inspect the README");
    await session.stop();
    await observer.done;

    expect(received).toEqual([
      userInput(opening("Inspect the README"), { currentRunContext: noComputersNotice }),
    ]);
    expect(inputEnded).toBe(true);
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.completed",
    ]);
    await adapter.close();
  });

  it("projects every initial input with typed authorship and queries only after the batch", async () => {
    const received: SDKUserMessage[] = [];
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const drained = (async () => {
        for await (const input of streamingPrompt(parameters)) received.push(input);
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        yield successMessage(sessionId, "Done.");
        await drained;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    const scheduled = triggerInput("The fare watch fired", "schedule");
    const webhook = triggerInput("The webhook fired", "webhook");
    const manual = triggerInput("The manual trigger fired", "manual");
    await session.execute({
      environment: {},
      inputs: [humanInput("Book a flight"), scheduled, webhook, manual],
      context: noThreadContext,
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: new AbortController().signal,
    });
    await session.stop();
    await observer.done;

    expect(received).toEqual([
      userInput(opening("Book a flight"), { shouldQuery: false }),
      // Claude's origin names no automation, so its name and occurrence come in the header.
      userInput(harnessInputHeader(scheduled, "The fare watch fired"), {
        shouldQuery: false,
        origin: { kind: "task-notification", subkind: "scheduled-trigger" },
      }),
      userInput(harnessInputHeader(webhook, "The webhook fired"), {
        origin: { kind: "task-notification" },
        shouldQuery: false,
      }),
      userInput(harnessInputHeader(manual, "The manual trigger fired"), {
        currentRunContext: noComputersNotice,
        origin: { kind: "task-notification" },
      }),
    ]);
    await adapter.close();
  });

  it("forwards streamed extended thinking as reasoning deltas with one completion", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        streamEvent(sessionId, {
          content_block: { signature: "", thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start",
        }),
        streamEvent(sessionId, {
          delta: { thinking: "Let me ", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        }),
        streamEvent(sessionId, {
          delta: { thinking: "reason about this.", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        }),
        streamEvent(sessionId, {
          delta: { signature: "sig-1", type: "signature_delta" },
          index: 0,
          type: "content_block_delta",
        }),
        streamEvent(sessionId, { index: 0, type: "content_block_stop" }),
        successMessage(sessionId, "Done."),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Think about it");
    await session.stop();
    await observer.done;

    expect(observer.events.filter((event) => event.type === "reasoning.delta")).toEqual([
      { data: { blockId: "thinking_1", text: "Let me " }, type: "reasoning.delta" },
      { data: { blockId: "thinking_1", text: "reason about this." }, type: "reasoning.delta" },
    ]);
    expect(observer.events.filter((event) => event.type === "reasoning.completed")).toEqual([
      {
        data: { blockId: "thinking_1", text: "Let me reason about this." },
        type: "reasoning.completed",
      },
    ]);
    await adapter.close();
  });

  it("publishes a reasoning completion for a non-streamed assistant thinking block", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        assistantMessage(sessionId, [
          { signature: "sig-1", thinking: "Quiet reasoning.", type: "thinking" },
          { text: "Answer", type: "text" },
        ]),
        successMessage(sessionId, "Answer"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Think quietly");
    await session.stop();
    await observer.done;

    expect(observer.events.filter((event) => event.type === "reasoning.delta")).toEqual([]);
    expect(observer.events.filter((event) => event.type === "reasoning.completed")).toEqual([
      { data: { blockId: "thinking_1", text: "Quiet reasoning." }, type: "reasoning.completed" },
    ]);
    await adapter.close();
  });

  it("does not duplicate a completion when the assistant message replays streamed thinking", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        streamEvent(sessionId, {
          content_block: { signature: "", thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start",
        }),
        streamEvent(sessionId, {
          delta: { thinking: "Streamed reasoning.", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        }),
        streamEvent(sessionId, { index: 0, type: "content_block_stop" }),
        assistantMessage(sessionId, [
          { signature: "sig-1", thinking: "Streamed reasoning.", type: "thinking" },
          { text: "Answer", type: "text" },
        ]),
        successMessage(sessionId, "Answer"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Think out loud");
    await session.stop();
    await observer.done;

    expect(observer.events.filter((event) => event.type === "reasoning.completed")).toEqual([
      { data: { blockId: "thinking_1", text: "Streamed reasoning." }, type: "reasoning.completed" },
    ]);
    await adapter.close();
  });

  it("ignores redacted thinking blocks entirely", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        streamEvent(sessionId, {
          content_block: { data: "opaque", type: "redacted_thinking" },
          index: 0,
          type: "content_block_start",
        }),
        streamEvent(sessionId, { index: 0, type: "content_block_stop" }),
        assistantMessage(sessionId, [
          { data: "opaque", type: "redacted_thinking" },
          { text: "Answer", type: "text" },
        ]),
        successMessage(sessionId, "Answer"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Think privately");
    await session.stop();
    await observer.done;

    expect(
      observer.events.filter(
        (event) => event.type === "reasoning.delta" || event.type === "reasoning.completed",
      ),
    ).toEqual([]);
    await adapter.close();
  });

  it("bridges tool approval using the provider tool-call identity", async () => {
    let permissionResult: PermissionResult | null | undefined;
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        const controller = new AbortController();
        permissionResult = await parameters.options.canUseTool?.(
          "Bash",
          { command: "pnpm test" },
          {
            description: "Run the test suite",
            requestId: "provider-request-1",
            signal: controller.signal,
            toolUseID: "tool-approval-1",
          },
        );
        yield successMessage(sessionId, "Tests passed.");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Run tests");
    const requested = await observer.waitFor("request.opened");

    await session.resolveRequest(requested.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await running;
    await session.stop();
    await observer.done;

    expect(permissionResult).toEqual({
      behavior: "allow",
      decisionClassification: "user_temporary",
      updatedInput: { command: "pnpm test" },
    });
    expect(requested.data.request.callId).toBe("tool-approval-1");
    expect(normalizedTypes(observer.events)).toContain("request.opened");
    await adapter.close();
  });

  it("re-scopes provider permission suggestions to this Run and forwards a denial note", async () => {
    const permissionResults: PermissionResult[] = [];
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        const first = await parameters.options.canUseTool?.(
          "Bash",
          { command: "pnpm test" },
          {
            ...permissionOptions("run-scoped"),
            suggestions: [
              {
                behavior: "allow",
                destination: "userSettings",
                rules: [{ ruleContent: "pnpm test", toolName: "Bash" }],
                type: "addRules",
              },
            ],
          },
        );
        if (first) permissionResults.push(first);
        const second = await parameters.options.canUseTool?.(
          "Bash",
          { command: "pnpm publish" },
          permissionOptions("denied-with-note"),
        );
        if (second) permissionResults.push(second);
        yield successMessage(sessionId, "Done.");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Run commands");
    const allow = await observer.waitFor("request.opened");
    expect(allow.data.request.presentation).toMatchObject({
      options: expect.arrayContaining([
        { hint: "allow-for-run", id: "allow-run", label: "Allow for this Run" },
      ]),
    });
    await session.resolveRequest(allow.data.request.id, {
      kind: "choice",
      optionId: "allow-run",
    });
    const deny = await waitForOccurrence(observer, "request.opened", 2);
    await session.resolveRequest(deny.data.request.id, {
      kind: "choice",
      optionId: "reject",
      text: "Do not publish from this workspace",
    });
    await running;
    await session.stop();
    await observer.done;

    expect(permissionResults).toEqual([
      expect.objectContaining({
        behavior: "allow",
        updatedPermissions: [expect.objectContaining({ destination: "session" })],
      }),
      expect.objectContaining({
        behavior: "deny",
        message: "Do not publish from this workspace",
      }),
    ]);
    await adapter.close();
  });

  it("keeps concurrent native-worker approvals independently addressable", async () => {
    let permissionResults: readonly (PermissionResult | null | undefined)[] = [];
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        const approve = parameters.options.canUseTool;
        permissionResults = await Promise.all([
          approve?.("Bash", { command: "pnpm test" }, permissionOptions("native-worker-1")),
          approve?.("Bash", { command: "pnpm lint" }, permissionOptions("native-worker-2")),
        ]);
        yield successMessage(sessionId, "Checks passed.");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Run checks in parallel");
    const first = await observer.waitFor("request.opened");
    const second = await waitForOccurrence(observer, "request.opened", 2);

    await Promise.all(
      [first, second].map((event) =>
        session.resolveRequest(event.data.request.id, {
          kind: "choice",
          optionId: "allow-once",
        }),
      ),
    );
    await running;
    await session.stop();
    await observer.done;

    expect(permissionResults).toEqual([
      expect.objectContaining({ behavior: "allow", updatedInput: { command: "pnpm test" } }),
      expect.objectContaining({ behavior: "allow", updatedInput: { command: "pnpm lint" } }),
    ]);
    await adapter.close();
  });

  it("reports a provider-cancelled native-worker approval", async () => {
    const providerRequest = new AbortController();
    let permissionResult: PermissionResult | null | undefined;
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        permissionResult = await parameters.options.canUseTool?.(
          "Bash",
          { command: "pnpm test" },
          {
            ...permissionOptions("cancelled-native-worker"),
            signal: providerRequest.signal,
          },
        );
        yield successMessage(sessionId, "Continued without the cancelled check.");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Run checks in a worker");
    const opened = await observer.waitFor("request.opened");

    providerRequest.abort(new Error("Native worker ended"));
    await running;
    await session.stop();
    await observer.done;

    expect(observer.events).toContainEqual({
      data: { reason: "source-closed", requestId: opened.data.request.id },
      type: "request.cancelled",
    });
    expect(permissionResult).toMatchObject({ behavior: "deny" });
    await adapter.close();
  });

  it("cancels every pending Request before an interrupted Run terminates", async () => {
    let permissionResult: PermissionResult | null | undefined;
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        permissionResult = await parameters.options.canUseTool?.(
          "Bash",
          { command: "pnpm test" },
          permissionOptions("interrupt-pending"),
        );
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Run tests");
    const opened = await observer.waitFor("request.opened");

    await session.interrupt();
    await running;
    await session.stop();
    await observer.done;

    const cancellationIndex = observer.events.findIndex(
      (event) =>
        event.type === "request.cancelled" && event.data.requestId === opened.data.request.id,
    );
    const terminalIndex = observer.events.findIndex((event) => event.type === "run.interrupted");
    expect(cancellationIndex).toBeGreaterThan(-1);
    expect(terminalIndex).toBeGreaterThan(cancellationIndex);
    expect(
      observer.events.filter(
        (event) =>
          event.type === "request.cancelled" && event.data.requestId === opened.data.request.id,
      ),
    ).toHaveLength(1);
    expect(permissionResult).toMatchObject({ behavior: "deny", interrupt: true });
    await adapter.close();
  });

  it("keeps native-worker transcript text out of the root answer", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        childAssistantMessage(sessionId, "Private worker notes"),
        successMessage(sessionId, "Root answer"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Delegate research");
    await session.stop();
    await observer.done;

    expect(observer.events.filter((event) => event.type === "assistant.message")).toEqual([
      {
        data: { content: [{ text: "Root answer", type: "text" }], messageId: expect.any(String) },
        type: "assistant.message",
      },
    ]);
    await adapter.close();
  });

  it("maps AskUserQuestion to the shared answer-map contract", async () => {
    let permissionResult: PermissionResult | null | undefined;
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        const sessionId = providerSessionId(parameters.options);
        yield initMessage(sessionId);
        permissionResult = await parameters.options.canUseTool?.(
          "AskUserQuestion",
          {
            questions: [
              {
                multiSelect: false,
                options: [
                  { description: "Brief", label: "Summary" },
                  { description: "Complete", label: "Detailed" },
                ],
                question: "How should I format the output?",
              },
              {
                multiSelect: true,
                options: [{ description: "Opening", label: "Introduction" }],
                question: "Which sections should I include?",
              },
            ],
          },
          {
            requestId: "provider-input-1",
            signal: new AbortController().signal,
            toolUseID: "ask-1",
          },
        );
        yield successMessage(sessionId, "Here is the requested output.");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Prepare a report");
    const requested = await observer.waitFor("request.opened");
    expect(requested.data.request).toMatchObject({
      callId: "ask-1",
      presentation: {
        fields: [
          {
            choices: [
              { description: "Brief", label: "Summary", value: "Summary" },
              { description: "Complete", label: "Detailed", value: "Detailed" },
            ],
          },
          {
            choices: [{ description: "Opening", label: "Introduction", value: "Introduction" }],
          },
        ],
        kind: "form",
      },
    });

    await expect(
      session.resolveRequest(requested.data.request.id, {
        answers: { unexpected: ["no"] },
        kind: "form",
      }),
    ).rejects.toThrow(/unexpected answers|missing answers/u);
    const answers = {
      question_1: ["Detailed"],
      question_2: ["Introduction", "Conclusion"],
    };
    await session.resolveRequest(requested.data.request.id, { answers, kind: "form" });
    await running;
    await session.stop();
    await observer.done;

    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "How should I format the output?": "Detailed",
          "Which sections should I include?": "Introduction, Conclusion",
        },
      },
    });
    await adapter.close();
  });

  it("interrupts an in-flight SDK query and emits one terminal interruption", async () => {
    const sdk = new FakeSdk((parameters) =>
      blockingQuery(initMessage(providerSessionId(parameters.options))),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Keep working");
    await waitForSdkCall(sdk);

    await session.interrupt();
    await running;
    await session.stop();
    await observer.done;

    expect(normalizedTypes(observer.events)).toEqual(["run.interrupted"]);
    await adapter.close();
  });

  it("pushes a steered message into the input of the running turn", async () => {
    const received: SDKUserMessage[] = [];
    const injected = new Gate();
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const drained = (async () => {
        for await (const input of streamingPrompt(parameters)) {
          received.push(input);
          if (received.length === 2) injected.open();
        }
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        await injected.reached;
        // Claude folded the steer into this turn, so this result answers both.
        yield turnResult(sessionId, "Done.", { consumed: received, queued: 0 });
        await drained;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Inspect the README");

    await steering(session)({
      input: agentInput("Check the README too."),
    });
    await running;
    await session.stop();
    await observer.done;

    expect(received).toEqual([
      userInput(opening("Inspect the README"), { currentRunContext: noComputersNotice }),
      userInput("Check the README too.", {
        origin: {
          body: "Check the README too.",
          from: testAgentThreadId,
          kind: "peer",
          name: "Research agent",
        },
        priority: "next",
      }),
    ]);
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.completed",
    ]);
    await adapter.close();
  });

  it("keeps the Run for the turn Claude queued a late steer into, and keeps each turn's reply", async () => {
    // The person writes while Claude gives its final answer: Claude runs the
    // message as the next turn of the same query, after this turn's result.
    const inputs: SDKUserMessage[] = [];
    const steered = new Gate();
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const reader = (async () => {
        for await (const input of streamingPrompt(parameters)) {
          inputs.push(input);
          if (inputs.length === 2) steered.open();
        }
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        await steered.reached;
        yield turnResult(sessionId, "First answer.", { consumed: [inputs[0]!], queued: 1 });
        yield initMessage(sessionId);
        yield turnResult(sessionId, "Second answer.", { consumed: [inputs[1]!], queued: 0 });
        await reader;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Draft the note");
    await steering(session)({ input: humanInput("Also mention Friday") });
    await running;
    await session.stop();
    await observer.done;

    expect(inputs.map(({ uuid }) => uuid)).toEqual([expect.any(String), expect.any(String)]);
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.phase",
      "run.phase",
      "assistant.message",
      "run.completed",
    ]);
    expect(phases(observer.events)).toEqual(["background", "turn"]);
    expect(replies(observer.events)).toEqual(["First answer.", "Second answer."]);
    await adapter.close();
  });

  it("tolerates the lifecycle frames Claude reports for each uuid-stamped message", async () => {
    // Recorded from claude-agent-sdk 0.3.295: these come before `init`.
    const inputs: SDKUserMessage[] = [];
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return generatedQuery(async function* () {
        const prompt = streamingPrompt(parameters)[Symbol.asyncIterator]();
        const opening = await prompt.next();
        inputs.push(opening.value as SDKUserMessage);
        const lifecycle = (state: string) =>
          message({
            command_uuid: inputs[0]!.uuid,
            session_id: sessionId,
            state,
            type: "command_lifecycle",
            uuid: randomProviderUuid(),
          });
        yield lifecycle("queued");
        yield lifecycle("started");
        yield initMessage(sessionId);
        yield turnResult(sessionId, "Done.", { consumed: inputs, queued: 0 });
        yield lifecycle("completed");
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    await send(session, "Inspect the README");
    await session.stop();
    await observer.done;

    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.completed",
    ]);
    await adapter.close();
  });

  it("answers a several-message opening once, past Claude's empty result for its context", async () => {
    // Recorded from Claude Code 2.1.295: a message sent without querying is
    // its own command, answered at once with an empty result naming only it.
    const inputs: SDKUserMessage[] = [];
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return generatedQuery(async function* () {
        const prompt = streamingPrompt(parameters)[Symbol.asyncIterator]();
        inputs.push((await prompt.next()).value as SDKUserMessage);
        inputs.push((await prompt.next()).value as SDKUserMessage);
        yield initMessage(sessionId);
        yield turnResult(sessionId, "", { consumed: [inputs[0]!], queued: 0 });
        yield initMessage(sessionId);
        yield turnResult(sessionId, "ECHO FOXTROT", { consumed: [inputs[1]!], queued: 0 });
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    await session.execute({
      environment: {},
      inputs: [humanInput("Remember the word ECHO."), humanInput("Reply with it and FOXTROT.")],
      context: noThreadContext,
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      requestedBy: createId("user"),
      runId: createId("run"),
      signal: new AbortController().signal,
    });
    await session.stop();
    await observer.done;

    expect(inputs.map(({ shouldQuery }) => shouldQuery)).toEqual([false, true]);
    expect(normalizedTypes(observer.events)).toEqual([
      "run.started",
      "assistant.message",
      "run.completed",
    ]);
    expect(replies(observer.events)).toEqual(["ECHO FOXTROT"]);
    await adapter.close();
  });

  it("waits for a steer still on its way to Claude when the turn answers", async () => {
    const inputs: SDKUserMessage[] = [];
    const steered = new Gate();
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const reader = (async () => {
        for await (const input of streamingPrompt(parameters)) {
          inputs.push(input);
          if (inputs.length === 2) steered.open();
        }
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        await steered.reached;
        // Claude had not read the steer when it wrote this result.
        yield turnResult(sessionId, "First answer.", { consumed: [inputs[0]!], queued: 0 });
        yield initMessage(sessionId);
        yield turnResult(sessionId, "Second answer.", { consumed: [inputs[1]!], queued: 0 });
        await reader;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Draft the note");
    await steering(session)({ input: humanInput("Also mention Friday") });
    await running;
    await session.stop();
    await observer.done;

    expect(phases(observer.events)).toEqual(["background", "turn"]);
    expect(replies(observer.events)).toEqual(["First answer.", "Second answer."]);
    expect(normalizedTypes(observer.events).at(-1)).toBe("run.completed");
    await adapter.close();
  });

  it("does not end a Run between turns while a steer it accepted waits for its turn", async () => {
    const inputs: SDKUserMessage[] = [];
    const steered = new Gate();
    const background = new Gate();
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const reader = (async () => {
        for await (const input of streamingPrompt(parameters)) {
          inputs.push(input);
          if (inputs.length === 2) steered.open();
        }
      })();
      return generatedQuery(async function* () {
        yield initMessage(sessionId);
        yield message({
          session_id: sessionId,
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-1" }],
          type: "system",
          uuid: randomProviderUuid(),
        });
        yield turnResult(sessionId, "Started the long job.", { consumed: [inputs[0]!], queued: 0 });
        background.open();
        await steered.reached;
        // The background work ends before Claude starts the steered turn.
        yield message({
          session_id: sessionId,
          subtype: "background_tasks_changed",
          tasks: [],
          type: "system",
          uuid: randomProviderUuid(),
        });
        yield initMessage(sessionId);
        yield turnResult(sessionId, "Here is Friday too.", { consumed: [inputs[1]!], queued: 0 });
        await reader;
      });
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Start the long job");
    await background.reached;
    await steering(session)({ input: humanInput("Also mention Friday") });
    await running;
    await session.stop();
    await observer.done;

    expect(phases(observer.events)).toEqual(["background", "turn"]);
    expect(replies(observer.events)).toEqual(["Started the long job.", "Here is Friday too."]);
    expect(normalizedTypes(observer.events).at(-1)).toBe("run.completed");
    await adapter.close();
  });

  it("rejects steering when no turn is active", async () => {
    const { adapter, session } = await openSession(new FakeSdk(() => scriptedQuery([])));

    await expect(
      steering(session)({
        input: humanInput("Anyone there?"),
      }),
    ).rejects.toThrow(/no active turn to steer/u);
    await session.stop();
    await adapter.close();
  });

  it("rejects steering once the turn has produced its result", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([initMessage(sessionId), successMessage(sessionId, "Done.")]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Inspect the README");
    await expect(
      steering(session)({
        input: humanInput("One more thing"),
      }),
    ).rejects.toThrow(/no active turn to steer/u);
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it("rejects steering that races the input stream closing on interrupt", async () => {
    const sdk = new FakeSdk((parameters) =>
      blockingQuery(initMessage(providerSessionId(parameters.options))),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Keep working");
    await waitForSdkCall(sdk);

    const interrupting = session.interrupt();
    const steered = steering(session)({
      input: humanInput("Too late"),
    });
    await expect(steered).rejects.toThrow(/input stream is already closed/u);
    await interrupting;
    await running;
    await session.stop();
    await observer.done;

    expect(normalizedTypes(observer.events)).toEqual(["run.interrupted"]);
    await adapter.close();
  });

  it("interrupts cleanly after a turn was steered", async () => {
    const received: SDKUserMessage[] = [];
    const injected = new Gate();
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      void (async () => {
        for await (const input of streamingPrompt(parameters)) {
          received.push(input);
          if (received.length === 2) injected.open();
        }
      })();
      return blockingQuery(initMessage(sessionId));
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);
    const running = send(session, "Keep working");

    await steering(session)({
      input: humanInput("Wrap up soon"),
    });
    await injected.reached;
    await session.interrupt();
    await running;
    await session.stop();
    await observer.done;

    expect(received).toEqual([
      userInput(opening("Keep working"), { currentRunContext: noComputersNotice }),
      userInput("Wrap up soon", { priority: "next" }),
    ]);
    expect(normalizedTypes(observer.events)).toEqual(["run.interrupted"]);
    await adapter.close();
  });

  it.each([
    {
      init: (sessionId: string) => initMessage(sessionId, { claude_code_version: "0.0.0" }),
      message: `Claude Code 0.0.0 is older than Opensteer supports; update it to ${MINIMUM_CLAUDE_CODE_VERSION} or newer`,
      name: "runtime version",
    },
    {
      init: (sessionId: string) =>
        initMessage(sessionId, { capabilities: ["interrupt_receipt_v1"] }),
      message: /missing required capabilities/u,
      name: "runtime capability",
    },
  ])("fails closed on incompatible $name", async ({ init, message: expectedMessage }) => {
    const sdk = new FakeSdk((parameters) =>
      scriptedQuery([init(providerSessionId(parameters.options))]),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Hello");
    const failure = await observer.waitFor("run.failed");
    expect(failure.data.message).toMatch(expectedMessage);
    await expect(send(session, "Try again")).rejects.toThrow(expectedMessage);
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it("preserves an authentication failure reported through an error-marked success result", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        message({
          error: "authentication_failed",
          message: {
            content: [
              {
                text: "Failed to authenticate: OAuth session expired and could not be refreshed",
                type: "text",
              },
            ],
            role: "assistant",
          },
          parent_tool_use_id: null,
          session_id: sessionId,
          type: "assistant",
          uuid: randomProviderUuid(),
        }),
        message({
          duration_api_ms: 0,
          duration_ms: 1,
          is_error: true,
          modelUsage: {},
          num_turns: 1,
          permission_denials: [],
          result: "Claude execution failed",
          session_id: sessionId,
          stop_reason: null,
          subtype: "success",
          total_cost_usd: 0,
          type: "result",
          usage: {},
          uuid: randomProviderUuid(),
        }),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Hello");
    expect(await observer.waitFor("run.failed")).toMatchObject({
      data: {
        message:
          "Failed to authenticate: OAuth session expired and could not be refreshed. Sign in to Claude again.",
        retryable: false,
      },
    });
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it("states what each Run consumed once, before the Run ends", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      // Claude keeps per-model totals for the whole query pipeline: the main
      // loop and every Task subagent it ran.
      return scriptedQuery([
        initMessage(sessionId),
        usageSuccessMessage(sessionId, "Done.", 0.0873, {
          "claude-opus-4-7": modelUsage({
            cacheRead: 12_000,
            cacheWrite: 1_900,
            input: 18_000,
            output: 1_200,
          }),
          "claude-sonnet-4-7": modelUsage({
            cacheRead: 760,
            cacheWrite: 84,
            input: 430,
            output: 65,
          }),
        }),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Inspect the README");
    await session.stop();
    await observer.done;

    const usageEvents = observer.events.filter((candidate) => candidate.type === "run.usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.data).toEqual({
      cacheWriteTokens: 1_984,
      cachedInputTokens: 12_760,
      costUsd: 0.0873,
      inputTokens: 18_430,
      outputTokens: 1_265,
    });
    const types = observer.events.map((candidate) => candidate.type);
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.completed"));
    await adapter.close();
  });

  it("gives each Run of one session its own totals rather than a running total", async () => {
    const totals = [
      { cacheRead: 0, cacheWrite: 0, input: 1_000, output: 100 },
      { cacheRead: 0, cacheWrite: 0, input: 9_000, output: 900 },
    ];
    let call = 0;
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      const turn = totals[call];
      call += 1;
      if (!turn) throw new Error("Unexpected Claude query");
      return scriptedQuery([
        initMessage(sessionId),
        usageSuccessMessage(sessionId, "Done.", 0.01, { "claude-opus-4-7": modelUsage(turn) }),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "First");
    await send(session, "Second");
    await session.stop();
    await observer.done;

    // The second Run is its own `query()` call against the resumed provider
    // session, so Claude's totals start again there and are not a running
    // total this driver would have to subtract from.
    expect(sdk.calls[1]?.options.resume).toBe(session.providerSessionReference);
    expect(
      observer.events.filter((candidate) => candidate.type === "run.usage").map(({ data }) => data),
    ).toEqual([
      {
        cacheWriteTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0.01,
        inputTokens: 1_000,
        outputTokens: 100,
      },
      {
        cacheWriteTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0.01,
        inputTokens: 9_000,
        outputTokens: 900,
      },
    ]);
    await adapter.close();
  });

  it("states usage before a failing Run's terminal event too", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        message({
          ...usageSuccessMessage(sessionId, "Claude execution failed", 0.004, {
            "claude-opus-4-7": modelUsage({ cacheRead: 0, cacheWrite: 0, input: 500, output: 20 }),
          }),
          is_error: true,
        }),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Hello");
    await observer.waitFor("run.failed");
    await session.stop();
    await observer.done;

    const types = observer.events.map((candidate) => candidate.type);
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.failed"));
    await adapter.close();
  });

  it("signs out through the official CLI and refuses an unknown connection", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const providerHome = providerState.providerHomeDirectory;
    if (!providerHome) throw new Error("Expected an isolated provider home");
    await mkdir(providerHome, { recursive: true });
    const apiKeyPath = join(providerHome, ".opensteer-anthropic-api-key");
    await writeFile(apiKeyPath, "stored-key", { mode: 0o600 });
    let spawns = 0;
    const driver = new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: {
        query: () => {
          throw new Error("unused");
        },
      },
      spawnAuthenticationProcess: () => {
        spawns += 1;
        const authentication = fakeAuthentication({ hold: false });
        authentication.exit(0);
        return authentication.process;
      },
    });
    const context = {
      config: {},
      environment: {},
      providerState,
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    } as const;

    // The registry names which connection to sign out of; a driver that
    // dropped it would sign the wrong one out.
    await expect(driver.logout(context, { connectionSlot: "secondary" })).rejects.toMatchObject({
      code: "bad_request",
      message: "Unknown Claude connection",
    });
    expect(spawns).toBe(0);
    expect(await readFile(apiKeyPath, "utf8")).toBe("stored-key");

    await driver.logout(context, { connectionSlot: "primary" });
    expect(spawns).toBe(1);
    await expect(readFile(apiKeyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an exhausted plan as the shared usage-limit code", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        rateLimitMessage(sessionId, "rejected"),
        failureMessage(sessionId, "rate_limit"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Hello");
    // The reader is offered another account, not a provider word only this
    // driver understands.
    expect((await observer.waitFor("run.failed")).data.code).toBe(harnessUsageLimitFailureCode);
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it("keeps an ordinary failure ordinary while the plan still admits work", async () => {
    const sdk = new FakeSdk((parameters) => {
      const sessionId = providerSessionId(parameters.options);
      return scriptedQuery([
        initMessage(sessionId),
        rateLimitMessage(sessionId, "allowed_warning"),
        failureMessage(sessionId, "server_error"),
      ]);
    });
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Hello");
    expect((await observer.waitFor("run.failed")).data.code).toBe("claude_harness_error");
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it("reuses the local Claude subscription login without changing its config directory", async () => {
    const sdk = new FakeSdk((parameters) =>
      scriptedQuery([
        initMessage(providerSessionId(parameters.options), { apiKeySource: "oauth" }),
        successMessage(providerSessionId(parameters.options), "Done."),
      ]),
    );
    const { adapter, session } = await openSession(sdk, {
      environment: {
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "consumer-token",
      },
    });
    const observer = observe(session.events);

    await send(session, "Hello");
    expect(await observer.waitFor("run.completed")).toBeDefined();
    expect(sdk.calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("consumer-token");
    expect(sdk.calls[0]?.options.env?.CLAUDE_CONFIG_DIR).toContain(".claude-user");
    await session.stop();
    await observer.done;
    await adapter.close();
  });

  it.each([
    {
      expected: "MCP servers outside",
      overrides: { mcp_servers: [{ name: "user-github", status: "connected" }] },
    },
    {
      expected: "tools outside",
      overrides: { tools: ["Read", "WebSearch"] },
    },
    {
      // Addressing an agent resumes it in the background, which no turn owns.
      expected: "tools outside",
      overrides: { tools: ["Read", "SendMessage"] },
    },
    {
      expected: "plugins outside",
      overrides: { plugins: [{ name: "ambient", path: "/user/plugin" }] },
    },
  ])(
    "fails closed if Claude reports provider-native $expected the boundary",
    async ({ expected, overrides }) => {
      const sdk = new FakeSdk((parameters) =>
        scriptedQuery([initMessage(providerSessionId(parameters.options), overrides)]),
      );
      const { adapter, session } = await openSession(sdk);
      const observer = observe(session.events);

      await send(session, "Hello");
      const failure = await observer.waitFor("run.failed");
      expect(failure.data.message).toContain(expected);
      await session.stop();
      await observer.done;
      await adapter.close();
    },
  );

  it.each([
    { name: "native-user", runtimeBoundary: nativeUserHarnessRuntimeBoundary },
    { name: "isolated-service", runtimeBoundary: isolatedServiceHarnessRuntimeBoundary },
  ])(
    "continues a bounded Host transcript through Claude's native resume at the $name boundary",
    async ({ runtimeBoundary }) => {
      const reference = "123e4567-e89b-42d3-a456-426614174001";
      const durableHistory = [
        historyMessage("Earlier durable request", "1"),
        historyMessage("Latest bounded durable request", "2"),
      ];
      const received: SDKUserMessage[] = [];
      const sdk = new FakeSdk((parameters) => {
        const drained = (async () => {
          for await (const input of streamingPrompt(parameters)) received.push(input);
        })();
        return generatedQuery(async function* () {
          yield initMessage(providerSessionId(parameters.options), {
            model: "claude-opus-5",
          });
          yield successMessage(reference, "Current continuation result.");
          await drained;
        });
      });
      const directory = await temporaryDirectory();
      const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
      const harnessInstanceId = createId("harnessInstance");
      const adapter = await driver.create({
        sourceId: "anthropic",
        config: {},
        instanceId: harnessInstanceId,
      });
      const baseContext = await context(
        directory,
        {},
        durableHistory,
        harnessInstanceId,
        runtimeBoundary,
      );
      const session = await adapter.resumeSession(reference, {
        ...baseContext,
        historyWindow: {
          ...baseContext.historyWindow,
          hasEarlier: true,
        },
        modelSelection: ModelSelectionSchema.parse({
          modelId: "claude-opus-5",
          options: { effort: "medium" },
          providerId: "anthropic",
        }),
      });
      const observer = observe(session.events);

      await send(session, "Current run request");
      await session.stop();
      await observer.done;

      expect(sdk.calls).toHaveLength(1);
      expect(sdk.calls[0]?.options).toMatchObject({
        effort: "medium",
        model: "claude-opus-5",
        resume: reference,
      });
      expect(sdk.calls[0]?.options.sessionId).toBeUndefined();
      expect(received).toEqual([
        userInput(opening("Current run request"), { currentRunContext: noComputersNotice }),
      ]);
      expect(normalizedTypes(observer.events)).toEqual([
        "run.started",
        "assistant.message",
        "run.completed",
      ]);
      expect(observer.events.find((event) => event.type === "assistant.message")).toMatchObject({
        data: { content: [{ text: "Current continuation result.", type: "text" }] },
      });
      await adapter.close();
    },
  );

  it("tells the model this Run's computer inventory on every turn, resumed or not", async () => {
    const received: SDKUserMessage[][] = [];
    const sdk = new FakeSdk((parameters) => {
      const inputs: SDKUserMessage[] = [];
      received.push(inputs);
      const drained = (async () => {
        for await (const input of streamingPrompt(parameters)) inputs.push(input);
      })();
      return generatedQuery(async function* () {
        yield initMessage(providerSessionId(parameters.options));
        yield successMessage(providerSessionId(parameters.options), "Checked.");
        await drained;
      });
    });
    const directory = await temporaryDirectory();
    const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
    const adapter = await driver.create({
      sourceId: "anthropic",
      config: {},
      instanceId: createId("harnessInstance"),
    });
    const baseContext = await context(directory);
    const started = await adapter.startSession({
      ...baseContext,
      machineAccessNotice: "Other computers: build-box.",
    });
    await send(started, "Check the computers");
    await started.stop();
    for (const machineAccessNotice of [noComputersNotice, "Other computers: lab-mini."]) {
      const session = await adapter.resumeSession(started.providerSessionReference, {
        ...baseContext,
        machineAccessNotice,
      });
      await send(session, "Check the computers");
      await session.stop();
    }
    expect(received).toEqual([
      [
        userInput(opening("Check the computers"), {
          currentRunContext: "Other computers: build-box.",
        }),
      ],
      [userInput(opening("Check the computers"), { currentRunContext: noComputersNotice })],
      [
        userInput(opening("Check the computers"), {
          currentRunContext: "Other computers: lab-mini.",
        }),
      ],
    ]);
    for (const call of sdk.calls) {
      expect(call.options.systemPrompt).toMatchObject({
        append: expect.not.stringMatching(/Other computers|No other computers/u),
      });
    }
    await adapter.close();
  });

  it("fails a native resume without replacing the provider session", async () => {
    const reference = "123e4567-e89b-42d3-a456-426614174002";
    const sdk = new FakeSdk(() => {
      throw new Error("provider resume failed");
    });
    const directory = await temporaryDirectory();
    const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
    const adapter = await driver.create({
      sourceId: "anthropic",
      config: {},
      instanceId: createId("harnessInstance"),
    });
    const session = await adapter.resumeSession(reference, await context(directory));
    const observer = observe(session.events);

    await send(session, "Continue the existing session");
    await session.stop();
    await observer.done;

    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.options.resume).toBe(reference);
    expect(sdk.calls[0]?.options.sessionId).toBeUndefined();
    expect(normalizedTypes(observer.events)).toEqual(["run.failed"]);
    await adapter.close();
  });

  it("does not acknowledge input when transport fails after initialization", async () => {
    const sdk = new FakeSdk((parameters) =>
      generatedQuery(async function* () {
        yield initMessage(providerSessionId(parameters.options));
        throw new Error("transport failed before the turn began");
      }),
    );
    const { adapter, session } = await openSession(sdk);
    const observer = observe(session.events);

    await send(session, "Do not acknowledge this early");
    await session.stop();
    await observer.done;

    expect(normalizedTypes(observer.events)).toEqual(["run.failed"]);
    await adapter.close();
  });

  it.each([
    { flag: "CLAUDE_CODE_USE_BEDROCK", provider: "bedrock" },
    { flag: "CLAUDE_CODE_USE_VERTEX", provider: "vertex" },
    { flag: "CLAUDE_CODE_USE_FOUNDRY", provider: "foundry" },
  ] as const)(
    "selects $provider provider credentials without consumer auth",
    async ({ flag, provider }) => {
      const sdk = new FakeSdk((parameters) =>
        scriptedQuery([
          initMessage(providerSessionId(parameters.options), { apiKeySource: "org" }),
          successMessage(providerSessionId(parameters.options), "Done."),
        ]),
      );
      const { adapter, session } = await openSession(sdk, {
        environment: { ANTHROPIC_API_KEY: "" },
        sourceId: provider,
      });
      const observer = observe(session.events);

      await send(session, "Hello");
      expect(sdk.calls[0]?.options.env?.[flag]).toBe("1");
      expect(sdk.calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      await session.stop();
      await observer.done;
      await adapter.close();
    },
  );

  it("rejects superseded provider-instance permission settings", async () => {
    const driver = new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([])),
    });
    await expect(
      driver.create({
        sourceId: "anthropic",
        config: { autoApproveTools: ["Bash"] },
        instanceId: createId("harnessInstance"),
      }),
    ).rejects.toThrow();
    await expect(
      driver.create({
        sourceId: "anthropic",
        config: { disallowedTools: ["Bash"] },
        instanceId: createId("harnessInstance"),
      }),
    ).rejects.toThrow();
    await expect(
      driver.create({
        sourceId: "anthropic",
        config: { permissionMode: "bypassPermissions" },
        instanceId: createId("harnessInstance"),
      }),
    ).rejects.toThrow();
    await expect(
      driver.create({
        sourceId: "anthropic",
        config: { mcpServers: { ambient: { command: "ambient" } } },
        instanceId: createId("harnessInstance"),
      }),
    ).rejects.toThrow();
    await expect(
      driver.create({
        sourceId: "anthropic",
        config: { tools: "claude-code" },
        instanceId: createId("harnessInstance"),
      }),
    ).rejects.toThrow();
  });

  it("reports provider-qualified canonical models without duplicate aliases", async () => {
    const sdk = new FakeSdk(
      () => scriptedQuery([]),
      [
        {
          description: "Recommended model",
          displayName: "Default (recommended)",
          resolvedModel: "claude-opus-5[1m]",
          supportedEffortLevels: ["low", "high"],
          supportsEffort: true,
          supportsFastMode: true,
          value: "default",
        },
        {
          description: "Largest model",
          displayName: "Opus (1M context)",
          resolvedModel: "claude-opus-5[1m]",
          supportedEffortLevels: ["low", "high"],
          supportsEffort: true,
          supportsFastMode: true,
          value: "opus[1m]",
        },
        {
          description: "Balanced model",
          displayName: "Sonnet",
          resolvedModel: "claude-sonnet-5",
          // A level a later Claude Code could add, which this SDK's types do not name yet.
          supportedEffortLevels: ["low", "medium", "high", "ultra"] as NonNullable<
            ModelInfo["supportedEffortLevels"]
          >,
          supportsEffort: true,
          value: "sonnet",
        },
        {
          description: "Fastest model",
          displayName: "Haiku",
          resolvedModel: "claude-haiku-4-5",
          supportsEffort: false,
          value: "haiku",
        },
      ],
    );
    const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
    const inspectionDirectory = await temporaryDirectory();

    const catalog = await driver.inspect({
      // An older Host may still store the account's own defaults; they are
      // read and dropped, and the engine's recommendation is the default.
      config: { effort: "medium", model: "sonnet" },
      environment: {},
      providerState: testProviderState(inspectionDirectory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: inspectionDirectory,
    });

    expect(catalog.status).toBe("ready");
    if (catalog.status !== "ready") throw new Error("Expected a ready Claude inspection");
    // Every Claude model reads images, so every descriptor declares it.
    expect(catalog.models.every((model) => model.acceptsImages === true)).toBe(true);
    expect(catalog.models).toEqual([
      // The recommended row folds into the model it resolves to, which is
      // what makes that model the default; its own label never names it.
      expect.objectContaining({
        displayName: "Opus (1M context)",
        isDefault: true,
        modelId: "claude-opus-5[1m]",
        options: [
          {
            defaultValue: "default",
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [
              {
                description: "Claude Code chooses for this model",
                label: "Default",
                value: "default",
              },
              { label: "Low", value: "low" },
              { label: "High", value: "high" },
            ],
          },
          { defaultValue: false, id: "fast", label: "Fast mode", type: "toggle" },
        ],
        providerId: "anthropic",
      }),
      // Levels come from Claude Code as listed, including one this tree has
      // never seen, after the choice that leaves the level to Claude Code.
      expect.objectContaining({
        displayName: "Sonnet",
        isDefault: false,
        modelId: "claude-sonnet-5",
        options: [
          {
            defaultValue: "default",
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [
              {
                description: "Claude Code chooses for this model",
                label: "Default",
                value: "default",
              },
              { label: "Low", value: "low" },
              { label: "Medium", value: "medium" },
              { label: "High", value: "high" },
              { label: "Ultra", value: "ultra" },
            ],
          },
        ],
        providerId: "anthropic",
      }),
      expect.objectContaining({
        displayName: "Haiku",
        isDefault: false,
        modelId: "claude-haiku-4-5",
        options: [],
      }),
    ]);
    expect(sdk.inspections[0]?.pathToClaudeCodeExecutable).toBe(fakeClaudeExecutable);
    expect(sdk.inspections[0]?.model).toBeUndefined();
  });
});

describe("Claude Code sources", () => {
  const models: readonly ModelInfo[] = [
    {
      description: "Balanced model",
      displayName: "Sonnet",
      supportsEffort: false,
      value: "sonnet",
    },
  ];

  it("reads each connection's authorisation from the account rather than its label", async () => {
    const directory = await temporaryDirectory();
    const inspection = {
      config: {},
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      workingDirectory: directory,
    } as const;

    const subscription = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, {
        email: "person@example.test",
        subscriptionType: "max",
      }),
    }).inspect({ ...inspection, sourceId: "anthropic" });
    expect(subscription).toMatchObject({
      connections: [expect.objectContaining({ authKind: "subscription" })],
      status: "ready",
    });

    const apiKey = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, {
        apiKeySource: "ANTHROPIC_API_KEY",
        apiProvider: "firstParty",
        subscriptionType: "none",
      }),
    }).inspect({ ...inspection, sourceId: "anthropic" });
    expect(apiKey).toMatchObject({
      connections: [expect.objectContaining({ authKind: "api-key" })],
      status: "ready",
    });

    const bedrock = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), models, null),
    }).inspect({ ...inspection, sourceId: "bedrock" });
    expect(bedrock).toMatchObject({
      connections: [expect.objectContaining({ authKind: "cloud-identity" })],
      setupMethods: [],
      status: "ready",
    });
  });

  it("names the missing cloud credentials when a cloud route lists no models", async () => {
    const directory = await temporaryDirectory();
    const inspection = {
      config: {},
      environment: {},
      providerState: testProviderState(directory, "ambient"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      workingDirectory: directory,
    } as const;

    const empty = await new ClaudeHarnessDriver({
      executable: fakeClaudeExecutable,
      sdk: new FakeSdk(() => scriptedQuery([]), [], null),
    }).inspect({ ...inspection, sourceId: "vertex" });
    expect(empty).toEqual({
      connections: [
        {
          authKind: "cloud-identity",
          connectionSlot: "primary",
          label: "Claude Code",
          status: "authentication-required",
        },
      ],
      detail: "No Google Cloud credentials for Vertex AI are available on this computer",
      setupMethods: [],
      status: "authentication-required",
    });

    const failing = new FakeSdk(() => scriptedQuery([]), models, null);
    failing.inspectModels = () => Promise.reject(new Error("Could not load AWS credentials"));
    await expect(
      new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk: failing }).inspect({
        ...inspection,
        sourceId: "bedrock",
      }),
    ).resolves.toMatchObject({
      detail: "No AWS credentials for Amazon Bedrock are available on this computer",
      status: "authentication-required",
    });
  });

  it("reports a cancelled cloud inspection as cancelled, not as a missing identity", async () => {
    const directory = await temporaryDirectory();
    const cancelled = new AbortController();
    cancelled.abort(new Error("Claude inspection canceled"));
    const failing = new FakeSdk(() => scriptedQuery([]), [], null);
    failing.inspectModels = () => Promise.reject(new Error("Claude inspection canceled"));

    await expect(
      new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk: failing }).inspect({
        config: {},
        environment: {},
        providerState: testProviderState(directory, "ambient"),
        runtimeBoundary: nativeUserHarnessRuntimeBoundary,
        signal: cancelled.signal,
        sourceId: "bedrock",
        workingDirectory: directory,
      }),
    ).rejects.toThrow("Claude inspection canceled");
  });

  it("routes a Run through the source's provider, not through a stored provider field", async () => {
    const sdk = new FakeSdk((parameters) =>
      scriptedQuery([
        initMessage(providerSessionId(parameters.options), { apiKeySource: "org" }),
        successMessage(providerSessionId(parameters.options), "Done."),
      ]),
    );
    const { adapter, session } = await openSession(sdk, {
      // A stale stored route must lose to the source the account was added for.
      config: { provider: "anthropic" },
      environment: { ANTHROPIC_API_KEY: "" },
      sourceId: "foundry",
    });
    const observer = observe(session.events);

    await send(session, "Hello");
    expect(sdk.calls[0]?.options.env?.CLAUDE_CODE_USE_FOUNDRY).toBe("1");
    await session.stop();
    await observer.done;
    await adapter.close();
  });
});

interface FakeAuthentication {
  readonly process: ClaudeAuthenticationProcess;
  readonly stdin: PassThrough;
  readonly written: string[];
  exit(code: number | null): void;
}

function fakeAuthentication(
  options: { readonly hold?: boolean; readonly output?: readonly string[] } = {},
): FakeAuthentication {
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => written.push(String(chunk)));
  let settle!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    settle = resolve;
  });
  return {
    exit: (code) => settle({ code, signal: null }),
    process: {
      child: { stdin },
      exited,
      stderr: (async function* () {})(),
      stdout: (async function* () {
        for (const chunk of options.output ?? []) yield Buffer.from(chunk);
        if (options.hold !== false) await new Promise<void>(() => undefined);
      })(),
      terminate: async () => settle({ code: null, signal: "SIGTERM" }),
    },
    stdin,
    written,
  };
}

function authenticationDriver(authentication: FakeAuthentication): ClaudeHarnessDriver {
  return new ClaudeHarnessDriver({
    executable: fakeClaudeExecutable,
    sdk: {
      query: () => {
        throw new Error("unused");
      },
    },
    spawnAuthenticationProcess: () => authentication.process,
  });
}

type ClaudeQueryParameters = Parameters<ClaudeAgentSdk["query"]>[0];

class FakeSdk implements ClaudeAgentSdk {
  readonly calls: ClaudeQueryParameters[] = [];
  readonly inspections: Options[] = [];
  readonly #factory: (parameters: ClaudeQueryParameters) => ClaudeQueryHandle;
  readonly #models: readonly ModelInfo[];
  readonly #account: AccountInfo | null;

  constructor(
    factory: (parameters: ClaudeQueryParameters) => ClaudeQueryHandle,
    models: readonly ModelInfo[] = [],
    /** `null` models a Runner whose Claude Code is not signed in. */
    account: AccountInfo | null = { email: "person@example.test", subscriptionType: "max" },
  ) {
    this.#factory = factory;
    this.#models = models;
    this.#account = account;
  }

  inspectModels = (options: Options) => {
    this.inspections.push(options);
    return Promise.resolve({ account: this.#account ?? undefined, models: this.#models });
  };

  query(parameters: ClaudeQueryParameters): ClaudeQueryHandle {
    this.calls.push(parameters);
    return this.#factory(parameters);
  }
}

function streamingPrompt(parameters: ClaudeQueryParameters): AsyncIterable<SDKUserMessage> {
  if (typeof parameters.prompt === "string") {
    throw new Error("Claude harness must open the query with a streaming prompt");
  }
  return parameters.prompt;
}

function userInput(
  text: string,
  options: {
    readonly currentRunContext?: string;
    readonly origin?: SDKUserMessage["origin"];
    readonly priority?: SDKUserMessage["priority"];
    readonly shouldQuery?: boolean;
  } = {},
): SDKUserMessage {
  return {
    message: {
      content: [
        ...(options.currentRunContext
          ? [
              {
                text: `Opensteer current Run context — computer inventory:\n${options.currentRunContext}`,
                type: "text" as const,
              },
            ]
          : []),
        { text, type: "text" },
      ],
      role: "user",
    },
    origin: options.origin ?? { kind: "human" },
    parent_tool_use_id: null,
    ...(options.priority ? { priority: options.priority } : {}),
    shouldQuery: options.shouldQuery ?? true,
    session_id: "",
    timestamp: testInputCreatedAt,
    type: "user",
    // Every message carries a client uuid each result reports consuming.
    uuid: expect.any(String) as NonNullable<SDKUserMessage["uuid"]>,
  };
}

function steering(session: HarnessSession): NonNullable<HarnessSession["steer"]> {
  if (!session.steer) throw new Error("Claude session must advertise steering");
  return session.steer.bind(session);
}

function permissionOptions(id: string) {
  return {
    requestId: id,
    signal: new AbortController().signal,
    toolUseID: id,
  };
}

class Gate {
  readonly reached: Promise<void>;
  #open: () => void = () => undefined;

  constructor() {
    this.reached = new Promise<void>((resolveReached) => {
      this.#open = resolveReached;
    });
  }

  open(): void {
    this.#open();
  }
}

async function openSession(
  sdk: ClaudeAgentSdk,
  overrides: {
    readonly additionalWritableDirectory?: string;
    readonly config?: unknown;
    readonly environment?: Readonly<Record<string, string>>;
    readonly history?: readonly Message[];
    readonly machineAccessNotice?: string;
    readonly machineAccessPlatform?: "darwin" | "linux";
    readonly machineAccessRelaySocket?: string;
    readonly modelSelection?: HarnessSessionContext["modelSelection"];
    readonly runtimeBoundary?: HarnessRuntimeBoundary;
    readonly sourceId?: string;
    readonly wrapProcessLaunch?: HarnessSessionContext["wrapProcessLaunch"];
  } = {},
): Promise<{
  adapter: HarnessAdapter;
  context: HarnessSessionContext;
  session: HarnessSession;
}> {
  const directory = await temporaryDirectory();
  const driver = new ClaudeHarnessDriver({ executable: fakeClaudeExecutable, sdk });
  const harnessInstanceId = createId("harnessInstance");
  const adapter = await driver.create({
    config: overrides.config ?? {},
    instanceId: harnessInstanceId,
    sourceId: overrides.sourceId ?? "anthropic",
  });
  const baseContext = await context(
    directory,
    overrides.environment,
    overrides.history,
    harnessInstanceId,
    overrides.runtimeBoundary,
    overrides.additionalWritableDirectory,
  );
  const sessionContext: HarnessSessionContext = {
    ...baseContext,
    machineAccessNotice: overrides.machineAccessNotice ?? noComputersNotice,
    machineAccessPlatform: overrides.machineAccessPlatform,
    machineAccessRelaySocket: overrides.machineAccessRelaySocket,
    modelSelection: overrides.modelSelection ?? baseContext.modelSelection,
    wrapProcessLaunch: overrides.wrapProcessLaunch ?? baseContext.wrapProcessLaunch,
  };
  const session = await adapter.startSession(sessionContext);
  return { adapter, context: sessionContext, session };
}

async function context(
  workspacePath: string,
  environment: Readonly<Record<string, string>> = {},
  history: readonly Message[] = [],
  harnessInstanceId = createId("harnessInstance"),
  runtimeBoundary: HarnessRuntimeBoundary = nativeUserHarnessRuntimeBoundary,
  additionalWritableDirectory?: string,
): Promise<HarnessSessionContext> {
  await mkdir(join(workspacePath, "bundled-skills"), { recursive: true });
  await writeFile(
    join(workspacePath, "bundled-skills", "SKILL.md"),
    "---\nname: opensteer-workspaces\ndescription: Test.\n---\n",
  );
  const threadId = createId("thread");
  // The Runner creates the per-Thread directory before the session starts.
  const threadStateDirectory = join(workspacePath, "state", "threads", threadId);
  await mkdir(threadStateDirectory, { recursive: true });
  return {
    accessMode: "full-access",
    machineAccessNotice: noComputersNotice,
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    agentTools: {
      capabilityProfileId: "main",
      token: "test-agent-tools-token",
      url: "https://host.example/internal/v1/mcp",
    },
    integrationTools: {
      token: "test-agent-tools-token",
      url: "https://host.example/internal/v1/integration-mcp",
    },
    environment: {
      ANTHROPIC_API_KEY: "os_secret_api",
      CLAUDE_CONFIG_DIR: join(workspacePath, ".claude-user"),
      ...environment,
    },
    environmentId: createId("environment"),
    harnessInstanceId,
    history,
    historyWindow: {
      byteCount: Buffer.byteLength(JSON.stringify(history), "utf8"),
      hasEarlier: false,
      itemCount: history.length,
    },
    instructions: "Follow workspace policy.",
    platformGuide: "Opensteer platform guide.",
    providerState: testProviderState(
      workspacePath,
      runtimeBoundary.kind === "isolated-service" ? "isolated" : "ambient",
    ),
    runtimeBoundary,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: { effort: "high" },
      providerId: "anthropic",
    }),
    signal: new AbortController().signal,
    skills: {
      skills: [{ name: "opensteer-workspaces", path: join(workspacePath, "bundled-skills") }],
    },
    threadId,
    threadStateDirectory,
    workspaceId: createId("workspace"),
    workspacePath,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [
      workspacePath,
      ...(additionalWritableDirectory ? [join(workspacePath, additionalWritableDirectory)] : []),
    ],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-claude-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function testProviderState(directory: string, kind: "ambient" | "isolated") {
  const providerHomeDirectory =
    kind === "isolated" ? join(directory, "profile", "provider-home") : undefined;
  return {
    continuationKey: `test:${directory}:${kind}`,
    kind,
    privateStateRoot: join(directory, "state"),
    providerHomeDirectory,
    store: {
      directory: providerHomeDirectory ?? join(directory, "state", "store"),
      id: "store-fixture",
    },
  } as const;
}

async function send(session: HarnessSession, text: string): Promise<void> {
  await session.execute({
    environment: {},
    inputs: [humanInput(text)],
    context: noThreadContext,
    reports: { messages: [], omittedCount: 0, throughSequence: null },
    requestedBy: createId("user"),
    runId: createId("run"),
    signal: new AbortController().signal,
  });
}

function humanInput(text: string): HarnessInput {
  return {
    author: {
      displayName: "Test user",
      kind: "human",
      principalId: "test-principal",
    },
    content: [{ text, type: "text" }],
    createdAt: testInputCreatedAt,
    kind: "input",
    messageId: createId("message"),
  };
}

function historyMessage(text: string, sequence: string): Message {
  return {
    author: {
      displayName: "Test user",
      kind: "human",
      principalId: "test-principal",
    },
    content: [{ text, type: "text" }],
    createdAt: testInputCreatedAt,
    id: createId("message"),
    kind: "input",
    runId: null,
    sequence: sequence as Message["sequence"],
    threadId: createId("thread"),
  };
}

function agentInput(text: string): HarnessInput {
  return {
    author: {
      displayName: "Research agent",
      kind: "agent",
      runId: createId("run"),
      threadId: testAgentThreadId,
      workspaceId: createId("workspace"),
      workspaceName: "Research",
    },
    content: [{ text, type: "text" }],
    createdAt: testInputCreatedAt,
    kind: "input",
    messageId: createId("message"),
  };
}

function triggerInput(
  text: string,
  source: "manual" | "schedule" | "webhook" = "schedule",
): HarnessInput {
  return {
    author: {
      displayName: "Fare watch",
      kind: "trigger",
      occurrenceId: createId("triggerOccurrence"),
      source,
      triggerId: createId("trigger"),
    },
    content: [{ text, type: "text" }],
    createdAt: testInputCreatedAt,
    kind: "input",
    messageId: createId("message"),
  };
}

function scriptedQuery(messages: readonly SDKMessage[]): ClaudeQueryHandle {
  return generatedQuery(async function* () {
    for (const providerMessage of messages) yield providerMessage;
  });
}

function generatedQuery(factory: () => AsyncGenerator<SDKMessage, void>): ClaudeQueryHandle {
  let generator: AsyncGenerator<SDKMessage, void> | undefined;
  return {
    [Symbol.asyncIterator]() {
      generator ??= factory();
      return generator;
    },
    close() {
      void generator?.return();
    },
    interrupt: () => Promise.resolve(undefined),
  };
}

function blockingQuery(initial: SDKMessage): ClaudeQueryHandle {
  let release: (() => void) | undefined;
  let closed = false;
  const wait = new Promise<void>((resolveWait) => {
    release = resolveWait;
  });
  return {
    async *[Symbol.asyncIterator]() {
      yield initial;
      await wait;
      if (closed) throw new Error("query closed");
    },
    close() {
      closed = true;
      release?.();
    },
    interrupt: () => Promise.resolve(undefined),
  };
}

function providerSessionId(options: Options): string {
  const id = options.resume ?? options.sessionId;
  if (!id) throw new Error("Test query did not receive a provider session id");
  return id;
}

function initMessage(
  sessionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): SDKMessage {
  return message({
    apiKeySource: "user",
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
    claude_code_version: TESTED_CLAUDE_CODE_VERSION,
    cwd: "/workspace",
    fast_mode_state: "off",
    mcp_servers: [],
    model: "sonnet",
    output_style: "default",
    permissionMode: "default",
    plugins: [],
    session_id: sessionId,
    skills: [],
    slash_commands: [],
    subtype: "init",
    tools: [
      "AskUserQuestion",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "NotebookEdit",
      "Read",
      "Skill",
      "ToolSearch",
      "Write",
    ],
    type: "system",
    uuid: randomProviderUuid(),
    ...overrides,
  });
}

function assistantMessage(sessionId: string, content: readonly unknown[]): SDKMessage {
  return message({
    message: {
      content,
      id: "msg_test",
      model: "sonnet",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    type: "assistant",
    uuid: randomProviderUuid(),
  });
}

function childAssistantMessage(sessionId: string, text: string): SDKMessage {
  return message({
    message: {
      content: [{ text, type: "text" }],
      id: "msg_child",
      model: "sonnet",
      role: "assistant",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: "agent-tool-1",
    session_id: sessionId,
    type: "assistant",
    uuid: randomProviderUuid(),
  });
}

function streamEvent(sessionId: string, event: unknown): SDKMessage {
  return message({
    event,
    parent_tool_use_id: null,
    session_id: sessionId,
    type: "stream_event",
    uuid: randomProviderUuid(),
  });
}

function userMessage(sessionId: string, content: readonly unknown[]): SDKMessage {
  return message({
    message: { content, role: "user" },
    parent_tool_use_id: null,
    session_id: sessionId,
    type: "user",
    uuid: randomProviderUuid(),
  });
}

/** A turn's result as Claude reports it: which client messages it consumed and how many sends still wait. */
function turnResult(
  sessionId: string,
  result: string,
  turn: { readonly consumed: readonly SDKUserMessage[]; readonly queued: number },
): SDKMessage {
  const uuids = turn.consumed.map(({ uuid }) => {
    if (!uuid) throw new Error("The driver sent a message without a client uuid");
    return uuid;
  });
  return message({
    ...(successMessage(sessionId, result) as object),
    queued_turn_count: turn.queued,
    user_message_uuid: uuids.at(-1),
    user_message_uuids: uuids,
  });
}

function phases(events: readonly HarnessEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "run.phase" ? [(event.data as { readonly phase: string }).phase] : [],
  );
}

function replies(events: readonly HarnessEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "assistant.message"
      ? (event.data as { readonly content: readonly { readonly text?: string }[] }).content.map(
          (part) => part.text ?? "",
        )
      : [],
  );
}

function successMessage(sessionId: string, result: string): SDKMessage {
  return message({
    duration_api_ms: 5,
    duration_ms: 10,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result,
    session_id: sessionId,
    stop_reason: "end_turn",
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {},
    uuid: randomProviderUuid(),
  });
}

function usageSuccessMessage(
  sessionId: string,
  result: string,
  totalCostUsd: number,
  perModel: Readonly<Record<string, unknown>>,
): SDKMessage {
  return message({
    ...successMessage(sessionId, result),
    modelUsage: perModel,
    total_cost_usd: totalCostUsd,
  });
}

function modelUsage(counts: {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly output: number;
}): Readonly<Record<string, number>> {
  return {
    cacheCreationInputTokens: counts.cacheWrite,
    cacheReadInputTokens: counts.cacheRead,
    contextWindow: 200_000,
    costUSD: 0,
    inputTokens: counts.input,
    maxOutputTokens: 64_000,
    outputTokens: counts.output,
    webSearchRequests: 0,
  };
}

function rateLimitMessage(sessionId: string, status: string): SDKMessage {
  return message({
    rate_limit_info: { rateLimitType: "five_hour", status, utilization: 100 },
    session_id: sessionId,
    type: "rate_limit_event",
    uuid: randomProviderUuid(),
  });
}

function failureMessage(sessionId: string, error: string): SDKMessage {
  return message({
    duration_api_ms: 0,
    duration_ms: 1,
    errors: [],
    is_error: true,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: `Claude could not run the turn: ${error}`,
    session_id: sessionId,
    stop_reason: null,
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {},
    uuid: randomProviderUuid(),
  });
}

function message(value: unknown): SDKMessage {
  return value as SDKMessage;
}

let providerUuidCounter = 0;
function randomProviderUuid(): `${string}-${string}-${string}-${string}-${string}` {
  providerUuidCounter += 1;
  return `00000000-0000-4000-8000-${providerUuidCounter.toString().padStart(12, "0")}`;
}

interface Observer {
  readonly done: Promise<void>;
  readonly events: HarnessEvent[];
  waitFor<T extends HarnessEvent["type"]>(type: T): Promise<Extract<HarnessEvent, { type: T }>>;
}

function observe(stream: AsyncIterable<HarnessEvent>): Observer {
  const events: HarnessEvent[] = [];
  const waiters = new Map<string, (() => void)[]>();
  const done = (async () => {
    for await (const event of stream) {
      events.push(event);
      for (const resolveWaiter of waiters.get(event.type)?.splice(0) ?? []) resolveWaiter();
    }
  })();
  return {
    done,
    events,
    async waitFor<T extends HarnessEvent["type"]>(
      type: T,
    ): Promise<Extract<HarnessEvent, { type: T }>> {
      const found = events.find(
        (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
      );
      if (found) return found;
      await new Promise<void>((resolveWaiter) => {
        const list = waiters.get(type) ?? [];
        list.push(resolveWaiter);
        waiters.set(type, list);
      });
      const emitted = events.find(
        (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
      );
      if (!emitted) throw new Error(`Event ${type} was signalled but not found`);
      return emitted;
    },
  };
}

function normalizedTypes(events: readonly HarnessEvent[]): string[] {
  return events.map((event) => event.type);
}

async function waitForOccurrence<T extends HarnessEvent["type"]>(
  observer: Observer,
  type: T,
  count: number,
): Promise<Extract<HarnessEvent, { type: T }>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const matches = observer.events.filter(
      (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
    );
    const event = matches[count - 1];
    if (event) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for occurrence ${count} of ${type}`);
}

async function waitForSdkCall(sdk: FakeSdk): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (sdk.calls.length > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Claude SDK query");
}

describe("Claude Thread naming", () => {
  it("returns the complete reply with no tools, MCP, skills, plugins or persistence", async () => {
    const sdk = new FakeSdk((parameters) =>
      scriptedQuery(
        typeof parameters.prompt === "string"
          ? [successMessage("naming", "Support migration\nheadphones")]
          : [],
      ),
    );
    const fixture = await openSession(sdk);
    try {
      const prompt = threadTitlePrompt("Migrate support", { icon: true });
      expect(
        await fixture.session.generateTitle!({ prompt, signal: new AbortController().signal }),
      ).toBe("Support migration\nheadphones");
      const call = sdk.calls.find((entry) => typeof entry.prompt === "string")!;
      expect(call).toMatchObject({
        prompt,
        options: {
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          skills: [],
          plugins: [],
          settingSources: [],
          persistSession: false,
          maxTurns: 1,
          model: "haiku",
        },
      });
      expect(call.options).not.toHaveProperty("maxTokens");
      expect(call.options).not.toHaveProperty("outputFormat");
      expect(
        (await readdir(fixture.context.threadStateDirectory)).filter((name) =>
          name.startsWith("title-"),
        ),
      ).toEqual([]);
    } finally {
      await fixture.session.stop();
      await fixture.adapter.close();
    }
  });
});
