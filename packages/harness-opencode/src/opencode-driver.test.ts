import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelSelectionSchema,
  createId,
  harnessUsageLimitFailureCode,
  type HarnessInstanceId,
  type Message,
} from "@opensteer/core";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import {
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
  threadTitlePrompt,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessInput,
  type HarnessInspectionResult,
  type HarnessRunInput,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpencodeHarnessDriver } from "./opencode-driver.js";
import { opencodeAccessModeConfiguration, opencodeToolIdentity } from "./configuration.js";
import { TESTED_OPENCODE_VERSION } from "./config.js";

// A Run outside any task with nothing earlier to state, for a person whose
// time zone is unknown: its thread context is one fixed line, so these turns
// carry exactly that context and the inputs and reports each test names.
const noThreadContext = {
  assignment: null,
  requesterTimeZone: null,
  threadState: { previousAssignment: null, previousRun: null },
};

const fakeServer = fileURLToPath(
  new URL("./test-fixtures/fake-opencode-server.mjs", import.meta.url),
);
const noComputersNotice = "No other computers are reachable from this Run.";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("OpenCode access modes", () => {
  it("translates approval-required into an ask-by-default permission table", () => {
    const permission = opencodeAccessModeConfiguration("approval-required", [
      "opensteer_thread_read",
    ]);
    expect(Object.entries(permission)[0]).toEqual(["*", "ask"]);
    expect(permission).toMatchObject({
      "*": "ask",
      bash: "ask",
      doom_loop: "ask",
      edit: "ask",
      external_directory: "ask",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      opensteer_thread_read: "allow",
      question: "allow",
      read: "allow",
      skill: "allow",
      task: { "*": "deny", explore: "allow", general: "allow" },
      todowrite: "allow",
      webfetch: "ask",
      websearch: "ask",
    });
  });

  it("translates auto-accept-edits into edits allowed and everything else asked", () => {
    const permission = opencodeAccessModeConfiguration("auto-accept-edits", [
      "opensteer_thread_read",
    ]);
    expect(permission).toMatchObject({
      "*": "ask",
      bash: "ask",
      edit: "allow",
      external_directory: "ask",
      opensteer_thread_read: "allow",
      task: { "*": "deny", explore: "allow", general: "allow" },
      webfetch: "ask",
      websearch: "ask",
    });
  });

  it("translates full-access into an allow-everything table", () => {
    const permission = opencodeAccessModeConfiguration("full-access", ["opensteer_thread_read"]);
    // Only OpenCode's own subagents, which run under this same table.
    const { task, ...rest } = permission;
    expect(task).toEqual({ "*": "deny", explore: "allow", general: "allow" });
    for (const action of Object.values(rest)) expect(action).toBe("allow");
    expect(permission["*"]).toBe("allow");
    expect(permission.bash).toBe("allow");
  });

  it("approves Opensteer's own tools without a prompt in every mode", () => {
    const openSteerTools = ["opensteer_thread_read", "opensteer_integrations_integration_call"];
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      const permission = opencodeAccessModeConfiguration(mode, openSteerTools);
      for (const tool of openSteerTools) expect(permission[tool]).toBe("allow");
      // The broad rule comes first so a later, narrower key wins: OpenCode
      // evaluates the last matching rule.
      expect(Object.keys(permission).indexOf("*")).toBe(0);
      for (const tool of openSteerTools) {
        expect(Object.keys(permission).indexOf(tool)).toBeGreaterThan(0);
      }
    }
  });
});

describe("OpenCode tool identity", () => {
  it("splits the flat tool id on the longest Opensteer server name", () => {
    expect(opencodeToolIdentity("opensteer_thread_read")).toEqual({
      name: "thread_read",
      namespace: "opensteer",
    });
    expect(opencodeToolIdentity("opensteer_integrations_integration_call")).toEqual({
      name: "integration_call",
      namespace: "opensteer.integrations",
    });
    expect(opencodeToolIdentity("bash")).toEqual({ name: "bash", namespace: "opencode" });
  });

  it("is unambiguous for every tool the two Opensteer servers actually offer", () => {
    // The split only works because no agent tool name begins with
    // `integrations_`; assert that over the real lists rather than trusting it.
    for (const { name } of toolsForCapabilityProfile("main")) {
      expect(name.startsWith("integrations_")).toBe(false);
      expect(opencodeToolIdentity(`opensteer_${name}`)).toEqual({
        name,
        namespace: "opensteer",
      });
    }
    for (const name of integrationGatewayToolNames) {
      expect(opencodeToolIdentity(`opensteer_integrations_${name}`)).toEqual({
        name,
        namespace: "opensteer.integrations",
      });
    }
  });
});

describe("OpenCode inspection", () => {
  it("reports a signed-in account as ready with provider-qualified models", async () => {
    const result = await inspect({ scenario: "happy", sourceId: "anthropic", key: "sk-ant-test" });
    expect(result).toMatchObject({ status: "ready" });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.models).toEqual([
      expect.objectContaining({
        // OpenCode says this model reads images, so the descriptor says so
        // too and the Host may send a tool result's picture.
        acceptsImages: true,
        displayName: "Claude Sonnet 4.6",
        isDefault: true,
        modelId: "claude-sonnet-4-6",
        nativeModelId: "claude-sonnet-4-6",
        providerId: "anthropic",
      }),
    ]);
    expect(result.models[0]?.options).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        values: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
          { label: "Max", value: "max" },
        ],
      },
    ]);
    expect(result.connections?.[0]).toMatchObject({
      authKind: "api-key",
      logoutSupported: true,
      status: "connected",
    });
  });

  it("reports OpenCode Zen as connected with no key at all", async () => {
    const result = await inspect({ scenario: "zen-free", sourceId: "opencode" });
    expect(result?.status).toBe("ready");
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    // Free Zen models answer with no credential, so the account is usable; it
    // has no sign-out, because there is nothing stored to remove.
    expect(result.connections?.[0]?.logoutSupported).toBeUndefined();
    expect(result.models.map((model) => model.nativeModelId)).toEqual([
      "union-alpha",
      "ling-3.0-flash-fin-free",
    ]);
    // A text-only capability is a declaration; a missing one is not, so
    // the second model says nothing and the Host reads that as no images.
    expect(result.models[0]?.acceptsImages).toBe(false);
    expect(result.models[1]?.acceptsImages).toBeUndefined();
    expect(result.models[1]?.options[0]).toMatchObject({ id: "effort", type: "select" });
  });

  it("asks for a key before running any source other than Zen", async () => {
    const result = await inspect({ scenario: "happy", sourceId: "anthropic" });
    expect(result).toMatchObject({ status: "authentication-required" });
    expect(result?.setupMethods?.[0]).toMatchObject({
      kind: "secret-input",
      methodId: "opencode-api-key",
    });
  });

  it("reports a cold profile with no model catalogue as unavailable, never as an empty catalog", async () => {
    const result = await inspect({ scenario: "cold-catalog", sourceId: "anthropic", key: "k" });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("model catalogue is downloaded on first use");
  });

  it("refuses a server that is not the pinned version", async () => {
    const result = await inspect({ scenario: "version-mismatch", sourceId: "anthropic", key: "k" });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain(TESTED_OPENCODE_VERSION);
    expect(result?.detail).toContain("0.0.0");
  });

  it("reports a server that cannot start as unavailable", async () => {
    const result = await inspect({ scenario: "spawn-failure", sourceId: "anthropic", key: "k" });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("OpenCode exited before it started listening");
  });

  it("reports a stored key OpenCode does not accept as authentication-required", async () => {
    const result = await inspect({ scenario: "not-connected", sourceId: "anthropic", key: "k" });
    expect(result?.status).toBe("authentication-required");
    expect(result?.detail).toContain("no credential");
  });

  it("refuses to run at all on an isolated-service Runner", async () => {
    const result = await inspect({
      scenario: "happy",
      sourceId: "anthropic",
      key: "k",
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });
    expect(result).toEqual({
      detail: "OpenCode has no command sandbox of its own, so it runs only on a computer you own.",
      status: "unavailable",
    });
  });

  it("refuses an ambient profile", async () => {
    const result = await inspect({
      scenario: "happy",
      sourceId: "anthropic",
      key: "k",
      providerStateKind: "ambient",
    });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("private profile");
  });

  it("folds an OpenRouter :free id onto its lab and keeps the route suffix", async () => {
    const result = await inspect({
      scenario: "openrouter-catalog",
      sourceId: "openrouter",
      key: "k",
    });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.models).toEqual([
      expect.objectContaining({
        modelId: "gemma-4-31b-it:free",
        nativeModelId: "google/gemma-4-31b-it:free",
        providerId: "google",
      }),
      expect.objectContaining({
        // Nobody can place "nvidia", so the model belongs to the source itself
        // rather than being dropped.
        modelId: "nvidia/nemotron-3-ultra:free",
        nativeModelId: "nvidia/nemotron-3-ultra:free",
        providerId: "openrouter",
      }),
    ]);
  });

  it("folds an OpenCode Go bare id onto its lab and keeps Go's own spelling", async () => {
    const result = await inspect({ scenario: "go-catalog", sourceId: "opencode-go", key: "k" });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.models).toEqual([
      expect.objectContaining({
        isDefault: true,
        modelId: "glm-5.3",
        nativeModelId: "glm-5.3",
        providerId: "zai",
      }),
      expect.objectContaining({ modelId: "kimi-k3", providerId: "moonshot" }),
    ]);
    expect(result.models[0]?.options[0]).toMatchObject({
      values: [
        { label: "Low", value: "low" },
        { label: "High", value: "high" },
        { label: "Max", value: "max" },
      ],
    });
  });

  it("always names a default, even when OpenCode's own default is not in the list", async () => {
    const result = await inspect({ scenario: "no-default", sourceId: "anthropic", key: "k" });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    // A catalog where nothing is default leaves the client with no model to
    // open on.
    expect(result.models.filter((model) => model.isDefault)).toHaveLength(1);
    expect(result.models[0]?.isDefault).toBe(true);
  });

  it("preserves a complete catalog beyond the former 256-model cutoff", async () => {
    const result = await inspect({ scenario: "large-catalog", sourceId: "anthropic", key: "k" });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.models).toHaveLength(300);
    expect(result.models.at(-1)?.nativeModelId).toBe("claude-test-0299");
  });

  it("reports an oversized catalog instead of publishing a partial one", async () => {
    const result = await inspect({
      scenario: "oversized-catalog",
      sourceId: "anthropic",
      key: "k",
    });
    expect(result).toMatchObject({
      detail: expect.stringContaining("8193 models"),
      status: "unavailable",
    });
  });

  it("keeps the provider's native default when canonical aliases collapse", async () => {
    const result = await inspect({ scenario: "default-alias", sourceId: "openrouter", key: "k" });
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.models).toEqual([
      expect.objectContaining({
        isDefault: true,
        modelId: "gpt-5.5",
        nativeModelId: "gpt-5.5",
        providerId: "openai",
      }),
    ]);
  });

  it("lists a compatible endpoint's own models and refuses one with no base URL", async () => {
    const listed = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      fetchModels: async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }, { id: "local-thing" }] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });
    if (listed?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(listed.models).toEqual([
      expect.objectContaining({ modelId: "gpt-5.6-luna", providerId: "openai" }),
      expect.objectContaining({ modelId: "local-thing", providerId: "custom" }),
    ]);
    expect(listed.connections?.[0]?.label).toBe("endpoint.test");

    const missing = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
    });
    expect(missing?.status).toBe("unavailable");
    expect(missing?.detail).toContain("no base URL");
  });

  it("keeps a compatible endpoint's complete large list and rejects overflow", async () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `local-model-${index}` }));
    const options = {
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
    } as const;
    const listed = await inspect({
      ...options,
      fetchModels: async () => Response.json({ data: entries(300) }),
    });
    if (listed?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(listed.models).toHaveLength(300);
    expect(listed.models.at(-1)?.nativeModelId).toBe("local-model-299");

    const oversized = await inspect({
      ...options,
      fetchModels: async () => Response.json({ data: entries(8_193) }),
    });
    expect(oversized).toMatchObject({
      detail: expect.stringContaining("8193 models"),
      status: "unavailable",
    });
  });

  it("reports an endpoint that cannot be listed rather than an empty catalog", async () => {
    const httpError = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      fetchModels: async () => new Response("nope", { status: 503 }),
    });
    expect(httpError?.status).toBe("unavailable");
    expect(httpError?.detail).toBe("endpoint.test answered with HTTP 503.");

    const notJson = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      fetchModels: async () =>
        new Response("<html>hello</html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    });
    expect(notJson?.status).toBe("unavailable");
    expect(notJson?.detail).toContain("endpoint.test");

    const notAModelList = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      fetchModels: async () =>
        new Response(JSON.stringify({ models: ["a"] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });
    expect(notAModelList?.status).toBe("unavailable");
    expect(notAModelList?.detail).toBe(
      "endpoint.test answered, but not with a model list. Check the address and the server type.",
    );

    const partlyInvalid = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      fetchModels: async () => Response.json({ data: [{ id: "valid" }, { id: " " }] }),
    });
    expect(partlyInvalid?.status).toBe("unavailable");
    expect(partlyInvalid?.detail).toContain("not with a model list");
  });

  it("gives up on an endpoint that accepts the connection and never answers", async () => {
    const timedOut = await inspect({
      scenario: "compatible",
      sourceId: "openai-compatible",
      key: "endpoint-key",
      config: { baseUrl: "https://endpoint.test/v1" },
      // The fetch carries its own five-second deadline, so inspection cannot
      // hang on a silent endpoint.
      fetchModels: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    expect(timedOut?.status).toBe("unavailable");
    expect(timedOut?.detail).toBe("endpoint.test didn't answer within 5 seconds.");
  }, 15_000);

  it("writes the account's configuration without the compatible endpoint's key", async () => {
    const directory = await temporaryDirectory();
    const providerState = testProviderState(directory, "isolated");
    const driver = new OpencodeHarnessDriver(
      fakeDependencies("compatible", {
        fetchModels: async () =>
          new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      }),
    );
    await signIn(driver, directory, "openai-compatible", "endpoint-key", {
      baseUrl: "https://endpoint.test/v1",
    });
    await driver.inspect?.({
      config: { baseUrl: "https://endpoint.test/v1" },
      environment: {},
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "openai-compatible",
      workingDirectory: directory,
    });
    const written = JSON.parse(
      await readFile(
        join(directory, "profile", "provider-home", "inspect-config", "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    expect(written.enabled_providers).toEqual(["opensteer"]);
    expect(written.provider?.opensteer?.options).toEqual({ baseURL: "https://endpoint.test/v1" });
    expect(JSON.stringify(written)).not.toContain("endpoint-key");
  });
});

describe("OpenCode sign-in", () => {
  it("writes auth.json at 0600 and never puts the key in the spawn environment", async () => {
    const directory = await temporaryDirectory();
    const driver = new OpencodeHarnessDriver(fakeDependencies("happy"));
    await signIn(driver, directory, "anthropic", "sk-ant-SECRET-VALUE");

    const path = join(directory, "profile", "provider-home", "data", "opencode", "auth.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      anthropic: { key: "sk-ant-SECRET-VALUE", type: "api" },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const capture = await inspectWithCapture(driver, directory, "anthropic");
    const environment = capture.find((entry) => entry.kind === "process")?.environment as
      Record<string, string> | undefined;
    expect(environment).toBeDefined();
    expect(JSON.stringify(environment)).not.toContain("sk-ant-SECRET-VALUE");
    // The one secret the environment may carry is the server password, which
    // authorizes nothing but this Run's own server.
    expect(environment?.OPENCODE_SERVER_PASSWORD?.length ?? 0).toBeGreaterThan(16);
  });

  it("sets the eight disable switches and the four XDG homes on the server", async () => {
    const directory = await temporaryDirectory();
    const driver = new OpencodeHarnessDriver(fakeDependencies("happy"));
    await signIn(driver, directory, "anthropic", "k");
    const capture = await inspectWithCapture(driver, directory, "anthropic");
    const environment = capture.find((entry) => entry.kind === "process")?.environment as Record<
      string,
      string
    >;
    for (const name of [
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
      "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_SHARE",
    ]) {
      expect(environment[name]).toBe("1");
    }
    const home = join(directory, "profile", "provider-home");
    expect(environment.XDG_DATA_HOME).toBe(join(home, "data"));
    expect(environment.XDG_CACHE_HOME).toBe(join(home, "cache"));
    expect(environment.XDG_STATE_HOME).toBe(join(home, "state"));
    // Never `OPENCODE_CONFIG_CONTENT`: the configuration carries the Run's MCP
    // bearer tokens, and the model's own shell sees the environment.
    expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    const argv = capture.find((entry) => entry.kind === "process")?.argv as string[];
    expect(argv.slice(-5)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  it("removes only the signed-out provider's entry", async () => {
    const directory = await temporaryDirectory();
    const driver = new OpencodeHarnessDriver(fakeDependencies("happy"));
    const providerState = testProviderState(directory, "isolated");
    const path = join(directory, "profile", "provider-home", "data", "opencode", "auth.json");
    await mkdir(join(directory, "profile", "provider-home", "data", "opencode"), {
      recursive: true,
    });
    await writeFile(
      path,
      JSON.stringify({
        anthropic: { key: "a", type: "api" },
        openrouter: { key: "b", type: "api" },
      }),
      { mode: 0o600 },
    );
    await driver.logout({
      config: {},
      environment: {},
      providerState,
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openrouter: { key: "b", type: "api" },
    });
  });

  it("removes the whole credential file with the profile", async () => {
    const directory = await temporaryDirectory();
    const driver = new OpencodeHarnessDriver(fakeDependencies("happy"));
    await signIn(driver, directory, "anthropic", "k");
    await driver.removeProfile?.({
      config: {},
      environment: {},
      providerState: testProviderState(directory, "isolated"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    });
    await expect(
      readFile(
        join(directory, "profile", "provider-home", "data", "opencode", "auth.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a setup method and a source it does not offer", async () => {
    const directory = await temporaryDirectory();
    const driver = new OpencodeHarnessDriver(fakeDependencies("happy"));
    const context = {
      config: {},
      environment: {},
      providerState: testProviderState(directory, "isolated"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "anthropic",
      workingDirectory: directory,
    } as const;
    await expect(driver.authenticate(context, { methodId: "device" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      driver.authenticate(
        { ...context, sourceId: "github-copilot" },
        { methodId: "opencode-api-key" },
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("OpenCode sessions", () => {
  it("runs a turn end to end and reaches exactly one terminal event", async () => {
    const fixture = await setup("happy");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    await fixture.adapter.close();

    const types = observer.events.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(types).toContain("assistant.delta");
    expect(types).toContain("assistant.message");
    expect(
      types.filter(
        (type) => type.startsWith("run.") && type !== "run.started" && type !== "run.usage",
      ),
    ).toEqual(["run.completed"]);
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.completed"));
    const message = observer.events.find((event) => event.type === "assistant.message");
    expect(message?.data).toMatchObject({
      content: [{ text: "Completed by OpenCode.", type: "text" }],
    });
    const tool = observer.events.find((event) => event.type === "tool.started");
    expect(tool?.data).toMatchObject({
      callId: "call_fake_1",
      tool: { name: "bash", namespace: "opencode" },
    });
  });

  it("restates completed tool arguments when a running part had not yet supplied them", async () => {
    const fixture = await setup("streamed-tool-arguments");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Use an integration"));
    await session.stop();
    await fixture.adapter.close();

    const starts = observer.events.filter((event) => event.type === "tool.started");
    expect(starts.map((event) => event.data)).toEqual([
      {
        arguments: {},
        callId: "call_gateway",
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
      {
        arguments: { toolRef: "igr_grant.itl_tool.digest", arguments: { query: "hello" } },
        callId: "call_gateway",
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
      {
        arguments: { command: "echo hi", description: "A full input" },
        callId: "call_bash",
        tool: { name: "bash", namespace: "opencode" },
      },
    ]);
    // Repeated terminal snapshots and a terminal without input cannot
    // overwrite the complete start or create another start for that call.
    expect(observer.events.filter((event) => event.type === "tool.completed")).toHaveLength(3);
  });

  it("puts the machine-access notice on every Run's own prompt, resumed or not", async () => {
    const fixture = await setup("happy", {
      machineAccessNotice: "You can reach example-mac over ssh.",
    });
    const started = await fixture.adapter.startSession(fixture.context);
    await started.execute(fixture.turn("First"));
    const reference = started.providerSessionReference;
    await started.stop();

    const resumedFixture = await setup("happy", {
      directory: fixture.directory,
      existingSession: reference,
      machineAccessNotice: "example-mac is no longer reachable from this Run.",
      threadStateDirectory: fixture.context.threadStateDirectory,
    });
    const resumed = await resumedFixture.adapter.resumeSession(reference, resumedFixture.context);
    await resumed.execute(resumedFixture.turn("Second"));
    await resumed.stop();
    await fixture.adapter.close();
    await resumedFixture.adapter.close();

    const prompts = (await resumedFixture.capture()).filter((entry) => entry.kind === "prompt");
    expect(prompts).toHaveLength(1);
    const payload = prompts[0]?.payload as { readonly system: string };
    expect(payload.system).toContain("example-mac is no longer reachable from this Run.");
  });

  it("sends the account's native model id and the selected variant", async () => {
    const fixture = await setup("happy", { effort: "high" });
    const session = await fixture.adapter.startSession(fixture.context);
    const turn = fixture.turn("Go");
    const input = turn.inputs[0]!;
    input.presentationContext = { currentThreadId: createId("thread") };
    await session.execute(turn);
    await session.stop();
    await fixture.adapter.close();

    const prompt = (await fixture.capture()).find((entry) => entry.kind === "prompt")?.payload as {
      readonly model: { readonly modelID: string; readonly providerID: string };
      readonly variant?: string;
      readonly parts: readonly { readonly text: string }[];
    };
    expect(prompt.model).toEqual({ modelID: "union-alpha", providerID: "opencode" });
    expect(prompt.variant).toBe("high");
    expect(prompt.parts[0]?.text).toMatch(/^\[Opensteer thread context\]/u);
    expect(prompt.parts[1]?.text).toContain("Go");
    expect(prompt.parts[1]?.text).toContain("[Opensteer input]");
    expect(prompt.parts[1]?.text).toContain(`Message ID: ${input.messageId}\n`);
    expect(prompt.parts[1]?.text).toContain(
      `Viewed conversation at input: ${input.presentationContext.currentThreadId}`,
    );
  });

  it("writes the Run's configuration under the Thread's own state directory at 0600", async () => {
    const fixture = await setup("happy", { accessMode: "approval-required" });
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    await fixture.adapter.close();

    const entry = (await fixture.capture()).find((row) => row.kind === "config");
    expect(entry?.configMode).toBe(0o600);
    const config = entry?.config as Record<string, unknown>;
    expect(config.autoupdate).toBe(false);
    expect(config.share).toBe("disabled");
    expect(config.lsp).toBe(false);
    expect(config.formatter).toBe(false);
    expect(config.snapshot).toBe(false);
    expect(config.enabled_providers).toEqual(["opencode"]);
    expect(config.model).toBe("opencode/union-alpha");
    expect(config.small_model).toBe("opencode/union-alpha");
    expect(config.agent).toEqual({ title: { disable: true } });
    expect(config.experimental).toEqual({ continue_loop_on_deny: true });
    expect((config.permission as Record<string, string>).bash).toBe("ask");
    expect(config.instructions).toEqual([
      join(fixture.context.threadStateDirectory, "opencode", "instructions.md"),
    ]);
    expect(config.skills).toEqual({
      paths: [join(fixture.context.threadStateDirectory, "opencode", "skills")],
    });
    const mcp = config.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.opensteer).toMatchObject({
      enabled: true,
      headers: { Authorization: "Bearer test-agent-tools-token" },
      oauth: false,
      timeout: 120_000,
      type: "remote",
      url: "https://host.example/internal/v1/mcp",
    });
    expect(mcp.opensteer_integrations).toMatchObject({
      headers: { Authorization: "Bearer test-integration-tools-token" },
      oauth: false,
      type: "remote",
    });
    const permission = config.permission as Record<string, string>;
    for (const { name } of toolsForCapabilityProfile("main")) {
      expect(permission[`opensteer_${name}`]).toBe("allow");
    }
    for (const name of integrationGatewayToolNames) {
      expect(permission[`opensteer_integrations_${name}`]).toBe("allow");
    }
  });

  it("replaces a permissive configuration file rather than reusing its mode", async () => {
    const directory = await temporaryDirectory();
    const threadStateDirectory = join(directory, "state", "threads", "thread-mode");
    const configDirectory = join(threadStateDirectory, "opencode", "config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    // A file left behind by an earlier release, or by anything else, is
    // world-readable — and the document carries this Run's MCP bearer tokens.
    await writeFile(join(configDirectory, "opencode.json"), "{}\n", { mode: 0o644 });
    const fixture = await setup("happy", { directory, threadStateDirectory });
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    await fixture.adapter.close();

    const path = join(configDirectory, "opencode.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("test-agent-tools-token");
    expect((await fixture.capture()).find((entry) => entry.kind === "config")?.configMode).toBe(
      0o600,
    );
  });

  it("names the Opensteer tools in the instructions of every Run, resumed or not", async () => {
    const fixture = await setup("happy");
    const started = await fixture.adapter.startSession(fixture.context);
    const reference = started.providerSessionReference;
    await started.stop();

    const resumedFixture = await setup("happy", {
      directory: fixture.directory,
      existingSession: reference,
      threadStateDirectory: fixture.context.threadStateDirectory,
    });
    const resumed = await resumedFixture.adapter.resumeSession(reference, resumedFixture.context);
    await resumed.stop();
    await fixture.adapter.close();
    await resumedFixture.adapter.close();

    const instructions = await readFile(
      join(fixture.context.threadStateDirectory, "opencode", "instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("Opensteer tools");
    // The model is told the names it must type, not just the servers: OpenCode
    // renames every MCP tool to `<server>_<tool>`.
    expect(instructions).toContain("opensteer_thread_read");
    expect(instructions).toContain("opensteer_integrations_integration_call");
  });

  it("refuses to load two Agent Skills of one name", async () => {
    const fixture = await setup("happy", {
      skills: {
        skills: [
          { name: "duplicate", path: join(await temporaryDirectory(), "one") },
          { name: "duplicate", path: join(await temporaryDirectory(), "two") },
        ],
      },
    });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("duplicate"),
    });
    await fixture.adapter.close();
  });

  it("refuses the session when the saved-permission sweep itself fails", async () => {
    // A sweep that cannot run leaves rules this driver never agreed to in
    // force, so the session does not open.
    const fixture = await setup("saved-permissions-failure");
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "harness_error",
    });
    await fixture.adapter.close();
  });

  it("refuses an artifact input instead of describing it to the model", async () => {
    const fixture = await setup("happy");
    const session = await fixture.adapter.startSession(fixture.context);
    await expect(
      session.execute({
        ...fixture.turn("ignored"),
        inputs: [
          {
            author: { displayName: "Test user", kind: "human", principalId: "test-principal" },
            content: [
              { text: "Look at this", type: "text" },
              {
                artifactId: "artifact_1",
                mediaType: "image/png",
                name: "screenshot.png",
                type: "artifact",
              },
            ],
            createdAt: "2026-09-16T00:00:00.000Z",
            kind: "input",
            messageId: createId("message"),
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("screenshot.png"),
    });
    await session.stop();
    await fixture.adapter.close();
    // Nothing about the artifact reached the model: a reference to a file it
    // cannot open reads as a real attachment.
    expect(JSON.stringify(await fixture.capture())).not.toContain("artifact_1");
  });

  it("does not acknowledge a turn interrupted before provider admission", async () => {
    const fixture = await setup("happy");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = fixture.turn("Do not submit this");
    const controller = new AbortController();
    controller.abort();

    await session.execute({ ...turn, signal: controller.signal });
    await session.stop();
    await observer.done;

    expect(observer.events.map((event) => event.type)).toEqual(["run.interrupted"]);
    await fixture.adapter.close();
  });

  it("materialises the instructions file and the skills directory for the Run", async () => {
    const fixture = await setup("happy");
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    await fixture.adapter.close();

    const instructions = await readFile(
      join(fixture.context.threadStateDirectory, "opencode", "instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("Opensteer platform guide.");
    expect(instructions).toContain("Follow the workspace instructions.");
    const skill = await readFile(
      join(
        fixture.context.threadStateDirectory,
        "opencode",
        "skills",
        "opensteer-workspaces",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(skill).toContain("opensteer-workspaces");
  });

  it("gives two concurrent sessions of one account their own configuration and one data home", async () => {
    const first = await setup("happy");
    const second = await setup("happy", { directory: first.directory });
    const firstSession = await first.adapter.startSession(first.context);
    const secondSession = await second.adapter.startSession(second.context);
    expect(firstSession.providerSessionReference).not.toBe(second.context.threadStateDirectory);
    await firstSession.stop();
    await secondSession.stop();
    await first.adapter.close();
    await second.adapter.close();

    const environments = [...(await first.capture()), ...(await second.capture())]
      .filter((entry) => entry.kind === "process")
      .map((entry) => entry.environment as Record<string, string>);
    expect(environments).toHaveLength(2);
    expect(environments[0]?.XDG_DATA_HOME).toBe(environments[1]?.XDG_DATA_HOME);
    expect(environments[0]?.XDG_CONFIG_HOME).not.toBe(environments[1]?.XDG_CONFIG_HOME);
    expect(environments[0]?.XDG_CONFIG_HOME).toContain(first.context.threadStateDirectory);
    expect(environments[1]?.XDG_CONFIG_HOME).toContain(second.context.threadStateDirectory);
  });

  it("sweeps saved permissions before the first turn", async () => {
    const fixture = await setup("saved-permissions");
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    await fixture.adapter.close();

    const requests = (await fixture.capture()).filter((entry) => entry.kind === "request");
    expect(requests.filter((row) => row.path === "/api/permission/saved/psv_fake1")).toHaveLength(
      1,
    );
    expect(requests.filter((row) => row.path === "/api/permission/saved/psv_fake2")).toHaveLength(
      1,
    );
    expect(requests.every((row) => row.authorized === true)).toBe(true);
  });

  it("refuses to open a session on an isolated-service Runner", async () => {
    const fixture = await setup("happy", {
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("no command sandbox"),
    });
    await fixture.adapter.close();
  });

  it("refuses to resume a session on an isolated-service Runner", async () => {
    // Resume reaches the same guard as a fresh start: both launch a server that
    // hands the model the account's credential home.
    const fixture = await setup("happy", {
      existingSession: "ses_fake_resumed",
      runtimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });
    await expect(
      fixture.adapter.resumeSession("ses_fake_resumed", fixture.context),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("no command sandbox"),
    });
    await fixture.adapter.close();
  });

  it("refuses to replay durable history into a fresh provider session", async () => {
    const fixture = await setup("happy", { history: [historyMessage("Earlier context")] });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "conflict",
    });
    await fixture.adapter.close();
  });

  it("fails a resume of a session the profile does not hold, without opening a new one", async () => {
    const fixture = await setup("happy");
    await expect(
      fixture.adapter.resumeSession("ses_missing_0000000000000000", fixture.context),
    ).rejects.toMatchObject({ code: "not_found" });
    const created = (await fixture.capture()).filter(
      (entry) => entry.kind === "request" && entry.method === "POST" && entry.path === "/session",
    );
    expect(created).toHaveLength(0);
    await fixture.adapter.close();
  });

  it("refuses an invalid provider session reference", async () => {
    const fixture = await setup("happy");
    await expect(fixture.adapter.resumeSession("  ", fixture.context)).rejects.toMatchObject({
      code: "bad_request",
    });
    await fixture.adapter.close();
  });
});

describe("OpenCode approvals", () => {
  it("opens a command approval, allows it, and lets the turn finish", async () => {
    const fixture = await setup("approval");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run the tests"));
    const opened = await observer.waitFor("request.opened");
    expect(opened.data.request).toMatchObject({
      kind: "harness.approval",
      presentation: {
        detail: "echo hi",
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow-once", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Reject" },
        ],
        title: "Approve command",
      },
    });
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();

    const reply = (await fixture.capture()).find(
      (entry) => entry.kind === "request" && entry.path === "/permission/per_fake1/reply",
    );
    expect(JSON.parse(String(reply?.body))).toEqual({ reply: "once" });
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
  });

  it("carries the person's note to the model on a denial and never sends always", async () => {
    const fixture = await setup("approval");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run the tests"));
    const opened = await observer.waitFor("request.opened");
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "reject",
      text: "Not on production, please.",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();

    const capture = await fixture.capture();
    const reply = capture.find(
      (entry) => entry.kind === "request" && entry.path === "/permission/per_fake1/reply",
    );
    expect(JSON.parse(String(reply?.body))).toEqual({
      message: "Not on production, please.",
      reply: "reject",
    });
    expect(JSON.stringify(capture)).not.toContain('"always"');
    const failed = observer.events.find((event) => event.type === "tool.completed");
    expect(failed?.data).toMatchObject({ isError: true });
    expect(JSON.stringify(failed?.data)).toContain("Not on production, please.");
  });

  it("presents a file change with the patch OpenCode supplied", async () => {
    const fixture = await setup("file-approval");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Write the file"));
    const opened = await observer.waitFor("request.opened");
    expect(opened.data.request.presentation).toMatchObject({ title: "Approve file changes" });
    expect(JSON.stringify(opened.data.request.presentation)).toContain("+HELLO");
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();
  });

  it("refuses a response that does not match the pending Request", async () => {
    const fixture = await setup("approval");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run the tests"));
    const opened = await observer.waitFor("request.opened");
    await expect(
      session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "allow-always" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      session.resolveRequest(createId("request"), { kind: "choice", optionId: "allow-once" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();
  });

  it("answers a native question and carries the selection back", async () => {
    const fixture = await setup("question");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Ask me"));
    const opened = await observer.waitFor("request.opened");
    expect(opened.data.request).toMatchObject({
      kind: "harness.input",
      presentation: {
        fields: [
          {
            choices: [
              { description: "Deploy to staging", label: "Staging", value: "Staging" },
              { description: "Deploy to production", label: "Production", value: "Production" },
            ],
            id: "question-0",
            multiSelect: false,
            prompt: "Deploy where?",
            secret: false,
          },
        ],
        kind: "form",
      },
    });
    await session.resolveRequest(opened.data.request.id, {
      answers: { "question-0": ["Staging"] },
      kind: "form",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();

    const reply = (await fixture.capture()).find(
      (entry) => entry.kind === "request" && entry.path === "/question/que_fake1/reply",
    );
    expect(JSON.parse(String(reply?.body))).toEqual({ answers: [["Staging"]] });
  });
});

describe("OpenCode interruption and failure", () => {
  it("interrupts the active turn and cancels every pending Request", async () => {
    const fixture = await setup("interrupt-pending-approval");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run forever"));
    const opened = await observer.waitFor("request.opened");
    await session.interrupt();
    await run;
    await session.stop();
    await fixture.adapter.close();

    const cancelled = observer.events.find((event) => event.type === "request.cancelled");
    expect(cancelled?.data).toEqual({ reason: "run-ended", requestId: opened.data.request.id });
    const types = observer.events.map((event) => event.type);
    expect(types).toContain("run.interrupted");
    expect(types).not.toContain("run.completed");
    expect(types.indexOf("request.cancelled")).toBeLessThan(types.indexOf("run.interrupted"));
    // The abort does not answer the row OpenCode is blocked on, so the driver
    // rejects it, and the session waits for that reply before killing the
    // server; otherwise the engine waits on a reply nobody will send.
    const replies = (await fixture.capture()).filter(
      (entry) => entry.kind === "request" && entry.path === "/permission/per_fake1/reply",
    );
    expect(replies).toHaveLength(1);
    expect(JSON.parse(String(replies[0]?.body))).toEqual({ reply: "reject" });
  });

  it("answers the ask OpenCode is blocked on before it aborts and waits", async () => {
    // The fixture's abort deliberately does not settle this turn: only the
    // permission reply releases it. If the driver rejected after the settle
    // wait, the interrupt would sit out the whole budget.
    const fixture = await setup("interrupt-blocked-approval", { interruptTimeoutMs: 8_000 });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run forever"));
    await observer.waitFor("request.opened");
    const startedAt = Date.now();
    await session.interrupt();
    await run;
    const elapsed = Date.now() - startedAt;
    await session.stop();
    await fixture.adapter.close();

    expect(elapsed).toBeLessThan(2_000);
    const paths = (await fixture.capture())
      .filter((entry) => entry.kind === "request")
      .map((entry) => String(entry.path));
    const rejected = paths.indexOf("/permission/per_fake1/reply");
    const aborted = paths.findIndex((path) => path.endsWith("/abort"));
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(aborted).toBeGreaterThanOrEqual(0);
    expect(rejected).toBeLessThan(aborted);
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
  });

  it("stops waiting the moment an aborted turn settles, and drops its deadline", async () => {
    // The budget is a ceiling, not a delay. The fixture settles 400ms after the
    // abort; with a ten-second budget, a wait that ended on the deadline rather
    // than on the turn would be unmistakable.
    const fixture = await setup("interrupt-delayed-idle", { interruptTimeoutMs: 10_000 });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Count forever"));
    await observer.waitFor("run.started");
    // The settle deadline is the only timer in this window armed for the whole
    // budget, so it can be picked out and followed to its clearTimeout.
    const deadlines: unknown[] = [];
    const scheduleTimer = globalThis.setTimeout as unknown as (
      ...args: readonly unknown[]
    ) => unknown;
    const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const handle = scheduleTimer(handler, delay, ...rest);
      if (delay === 10_000) deadlines.push(handle);
      return handle;
    }) as unknown as typeof globalThis.setTimeout);
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const startedAt = Date.now();
    await session.interrupt();
    await run;
    const elapsed = Date.now() - startedAt;
    // The losing timer is cleared rather than left to fire nine seconds later.
    expect(deadlines).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(deadlines[0]);
    scheduled.mockRestore();
    cleared.mockRestore();
    await session.stop();
    await fixture.adapter.close();

    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
  });

  it("abandons the turn when the Run's own signal aborts", async () => {
    const fixture = await setup("interrupt");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const controller = new AbortController();
    const turn = { ...fixture.turn("Count to a million"), signal: controller.signal };
    const run = session.execute(turn);
    await observer.waitFor("run.started");
    controller.abort();
    await run;
    await session.stop();
    await fixture.adapter.close();
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
  });

  it("reports an exhausted plan with the shared usage-limit code", async () => {
    const fixture = await setup("usage-limit");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await session.stop();
    await fixture.adapter.close();

    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed?.data).toMatchObject({
      code: harnessUsageLimitFailureCode,
      retryable: true,
      status: "failed",
    });
    const types = observer.events.map((event) => event.type);
    // The usage the steps already reported is still this Run's own.
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.failed"));
    expect(types).not.toContain("run.completed");
  });

  it("does not read the idle after a failed message as a completion", async () => {
    const fixture = await setup("message-error");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await session.stop();
    await fixture.adapter.close();

    const types = observer.events.map((event) => event.type);
    expect(types).toContain("run.failed");
    expect(types).not.toContain("run.completed");
    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed?.data).toMatchObject({
      code: "opencode_UnknownError",
      message: "the model exploded",
    });
  });

  it("keeps a Run working through the engine's own retry", async () => {
    const fixture = await setup("retry");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await session.stop();
    await fixture.adapter.close();
    expect(observer.events.find((event) => event.type === "run.status")).toBeUndefined();
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
  });

  it("fails the Run when the event stream drops mid-turn", async () => {
    const fixture = await setup("stream-drop");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await session.stop();
    await fixture.adapter.close();
    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed).toBeDefined();
    expect(observer.events.map((event) => event.type)).not.toContain("run.completed");
  });

  it("refuses a second turn while one is active", async () => {
    const fixture = await setup("interrupt");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("First"));
    await observer.waitFor("run.started");
    await expect(session.execute(fixture.turn("Second"))).rejects.toMatchObject({
      code: "conflict",
    });
    await session.interrupt();
    await run;
    await session.stop();
    await fixture.adapter.close();
  });
});

describe("OpenCode after the terminal event", () => {
  it("publishes nothing a turn produced once that turn has ended", async () => {
    const fixture = await setup("post-terminal-content");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Finish"));
    // The fixture keeps sending parts for 20ms after `session.idle`.
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    await session.stop();
    await fixture.adapter.close();

    const types = observer.events.map((event) => event.type);
    expect(types).toContain("run.completed");
    const terminal = types.indexOf("run.completed");
    expect(types.slice(terminal + 1)).toEqual([]);
    expect(JSON.stringify(observer.events)).not.toContain("LATE TEXT");
    expect(JSON.stringify(observer.events)).not.toContain("LATE DELTA");
    expect(observer.events.filter((event) => event.type === "tool.completed")).toHaveLength(0);
  });

  it("rejects a permission OpenCode asks with no Run left to answer it", async () => {
    const fixture = await setup("post-terminal-content");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Finish"));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await session.stop();
    await fixture.adapter.close();

    // Leaving it unanswered would block the engine on a reply that can never
    // come; no Request is opened, because no Run could carry it.
    const replies = (await fixture.capture()).filter(
      (entry) => entry.kind === "request" && entry.path === "/permission/per_orphan/reply",
    );
    expect(replies).toHaveLength(1);
    expect(JSON.parse(String(replies[0]?.body))).toEqual({ reply: "reject" });
    expect(observer.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
  });

  it("fails the Run on a blocking ask it cannot answer rather than hanging", async () => {
    const fixture = await setup("unknown-ask");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    // `session.idle` never arrives in this scenario: without the guard the Run
    // would wait forever.
    await session.execute(fixture.turn("Ask me something new"));
    await session.stop();
    await fixture.adapter.close();

    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed?.data).toMatchObject({
      message: expect.stringContaining("question.v2.asked"),
      status: "failed",
    });
    expect(observer.events.map((event) => event.type)).not.toContain("run.completed");
  });
});

describe("OpenCode reply failures", () => {
  it("keeps a Request answerable when OpenCode refuses the reply", async () => {
    const fixture = await setup("reply-failure");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Run the tests"));
    const opened = await observer.waitFor("request.opened");

    await expect(
      session.resolveRequest(opened.data.request.id, { kind: "choice", optionId: "allow-once" }),
    ).rejects.toMatchObject({ code: "harness_error" });
    // The entry survives the failure, so the person can answer again; dropping
    // it would leave OpenCode holding the permission with nothing able to
    // answer it.
    await session.resolveRequest(opened.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();

    const replies = (await fixture.capture()).filter(
      (entry) => entry.kind === "request" && entry.path === "/permission/per_fake1/reply",
    );
    expect(replies).toHaveLength(2);
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
  });

  it("keeps a question answerable when OpenCode refuses the reply", async () => {
    const fixture = await setup("question-reply-failure");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const run = session.execute(fixture.turn("Ask me"));
    const opened = await observer.waitFor("request.opened");

    await expect(
      session.resolveRequest(opened.data.request.id, {
        answers: { "question-0": ["Staging"] },
        kind: "form",
      }),
    ).rejects.toMatchObject({ code: "harness_error" });
    // Same rule as the approval: OpenCode still holds the question, so the
    // Request has to stay answerable.
    await session.resolveRequest(opened.data.request.id, {
      answers: { "question-0": ["Staging"] },
      kind: "form",
    });
    await run;
    await session.stop();
    await fixture.adapter.close();

    const replies = (await fixture.capture()).filter(
      (entry) => entry.kind === "request" && entry.path === "/question/que_fake1/reply",
    );
    expect(replies).toHaveLength(2);
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
  });
});

describe("OpenCode bounded transport", () => {
  it("gives up when OpenCode accepts the event stream and never answers it", async () => {
    const fixture = await setup("no-sse", { requestTimeoutMs: 300 });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("event stream"),
    });
    await fixture.adapter.close();
  });

  it("fails the stream on an oversized event line, newline or not", async () => {
    const fixture = await setup("oversized-line", { maxEventLineBytes: 16 * 1_024 });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Flood one line"));
    await session.stop();
    await fixture.adapter.close();

    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed?.data).toMatchObject({
      message: expect.stringContaining("beyond the configured limit"),
    });
  });

  it("measures an event line as it arrived, before any trailing whitespace is cut", async () => {
    const fixture = await setup("oversized-padded-line", { maxEventLineBytes: 16 * 1_024 });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Pad one line"));
    await session.stop();
    await fixture.adapter.close();

    const failed = observer.events.find((event) => event.type === "run.failed");
    expect(failed?.data).toMatchObject({
      message: expect.stringContaining("beyond the configured limit"),
    });
  });

  it("refuses an ordinary response body beyond the configured limit", async () => {
    const result = await inspect({
      scenario: "oversized-body",
      sourceId: "anthropic",
      key: "k",
      config: { maxResponseBytes: 64 * 1_024 },
    });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("beyond the configured response limit");
  });
});

describe("OpenCode usage and process hygiene", () => {
  it("sums every step of one Run and states it once", async () => {
    const fixture = await setup("two-steps");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Go"));
    await session.stop();
    await fixture.adapter.close();

    const usage = observer.events.filter((event) => event.type === "run.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.data).toEqual({
      cacheWriteTokens: 6,
      cachedInputTokens: 12,
      costUsd: 0.75,
      inputTokens: 150,
      outputTokens: 32,
      reasoningTokens: 2,
    });
  });

  it("reports reasoning as its own block", async () => {
    const fixture = await setup("reasoning");
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Think"));
    await session.stop();
    await fixture.adapter.close();

    expect(observer.events.find((event) => event.type === "reasoning.delta")?.data).toMatchObject({
      text: "Weighing the options",
    });
    expect(
      observer.events.find((event) => event.type === "reasoning.completed")?.data,
    ).toMatchObject({ text: "Weighing the options" });
  });

  it("stops the server's whole process group when the session stops", async () => {
    const fixture = await setup("happy");
    const session = await fixture.adapter.startSession(fixture.context);
    await session.stop();
    await fixture.adapter.close();
    // A live server would still answer; the fixture records every request, so a
    // health check after the stop proves nothing is listening.
    const capture = await fixture.capture();
    const before = capture.filter((entry) => entry.kind === "request").length;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect((await fixture.capture()).filter((entry) => entry.kind === "request").length).toBe(
      before,
    );
  });

  it("gives up on a server that never announces a listening address", async () => {
    const fixture = await setup("slow-start", { startupTimeoutMs: 200 });
    await expect(fixture.adapter.startSession(fixture.context)).rejects.toMatchObject({
      code: "timeout",
    });
    await fixture.adapter.close();
  });
});

/* ---------------------------------------------------------------- helpers */

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

function fakeDependencies(scenario: string, options: { readonly fetchModels?: typeof fetch } = {}) {
  return {
    arguments: [fakeServer, `--scenario=${scenario}`],
    executable: process.execPath,
    ...(options.fetchModels ? { fetchModels: options.fetchModels } : {}),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-opencode-"));
  temporaryDirectories.push(directory);
  return directory;
}

function testProviderState(directory: string, kind: "ambient" | "isolated") {
  const privateStateRoot = join(directory, "state");
  return {
    continuationKey: `test:${directory}`,
    kind,
    privateStateRoot,
    providerHomeDirectory:
      kind === "isolated" ? join(directory, "profile", "provider-home") : undefined,
    store: {
      directory: join(privateStateRoot, "harness-stores", "opencode"),
      id: "store-fixture",
    },
  } as const;
}

async function signIn(
  driver: OpencodeHarnessDriver,
  directory: string,
  sourceId: string,
  key: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  const started = await driver.authenticate(
    {
      config,
      environment: {},
      providerState: testProviderState(directory, "isolated"),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId,
      workingDirectory: directory,
    },
    { methodId: "opencode-api-key" },
  );
  if (started.status !== "pending") throw new Error("Expected a pending OpenCode sign-in");
  await started.submit?.(key);
  const result = await started.result;
  if (result.status !== "ready") throw new Error(`Sign-in failed: ${result.detail}`);
}

async function inspect(options: {
  readonly scenario: string;
  readonly sourceId: string;
  readonly key?: string;
  readonly config?: Record<string, unknown>;
  readonly fetchModels?: typeof fetch;
  readonly providerStateKind?: "ambient" | "isolated";
  readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
}): Promise<HarnessInspectionResult | undefined> {
  const directory = await temporaryDirectory();
  const driver = new OpencodeHarnessDriver(
    fakeDependencies(
      options.scenario,
      options.fetchModels ? { fetchModels: options.fetchModels } : {},
    ),
  );
  if (options.key !== undefined) {
    await signIn(driver, directory, options.sourceId, options.key, options.config ?? {});
  }
  return driver.inspect?.({
    config: options.config ?? {},
    environment: {},
    providerState: testProviderState(directory, options.providerStateKind ?? "isolated"),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    sourceId: options.sourceId,
    workingDirectory: directory,
  });
}

async function inspectWithCapture(
  driver: OpencodeHarnessDriver,
  directory: string,
  sourceId: string,
): Promise<CaptureEntry[]> {
  const capturePath = join(directory, "capture.jsonl");
  await driver.inspect?.({
    config: {},
    environment: { FAKE_OPENCODE_CAPTURE_PATH: capturePath },
    providerState: testProviderState(directory, "isolated"),
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    sourceId,
    workingDirectory: directory,
  });
  return readCapture(capturePath);
}

type CaptureEntry = Record<string, unknown> & { readonly kind: string };

async function readCapture(path: string): Promise<CaptureEntry[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

function historyMessage(text: string): Message {
  return {
    author: { displayName: "Test user", kind: "human", principalId: "test-principal" },
    content: [{ text, type: "text" }],
    createdAt: new Date().toISOString(),
    id: createId("message"),
    kind: "input",
    runId: null,
    sequence: "0" as Message["sequence"],
    threadId: createId("thread"),
  };
}

function humanInput(text: string): HarnessInput {
  return {
    author: { displayName: "Test user", kind: "human", principalId: "test-principal" },
    content: [{ text, type: "text" }],
    createdAt: "2026-09-16T00:00:00.000Z",
    kind: "input",
    messageId: createId("message"),
  };
}

interface SetupOptions {
  readonly accessMode?: HarnessSessionContext["accessMode"];
  readonly directory?: string;
  readonly effort?: string;
  readonly existingSession?: string;
  readonly history?: readonly Message[];
  readonly interruptTimeoutMs?: number;
  readonly machineAccessNotice?: string;
  readonly maxEventLineBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
  readonly skills?: HarnessSessionContext["skills"];
  readonly startupTimeoutMs?: number;
  readonly threadStateDirectory?: string;
}

interface Fixture {
  readonly adapter: HarnessAdapter;
  readonly context: HarnessSessionContext;
  readonly directory: string;
  capture(): Promise<CaptureEntry[]>;
  turn(text: string): HarnessRunInput;
}

async function setup(scenario: string, options: SetupOptions = {}): Promise<Fixture> {
  const directory = options.directory ?? (await temporaryDirectory());
  const capturePath = join(directory, `capture-${Math.random().toString(36).slice(2)}.jsonl`);
  const driver = new OpencodeHarnessDriver(fakeDependencies(scenario));
  const harnessInstanceId = createId("harnessInstance") as HarnessInstanceId;
  const adapter = await driver.create({
    config: {
      ...(options.interruptTimeoutMs ? { interruptTimeoutMs: options.interruptTimeoutMs } : {}),
      ...(options.maxEventLineBytes ? { maxEventLineBytes: options.maxEventLineBytes } : {}),
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    },
    instanceId: harnessInstanceId,
    sourceId: "opencode",
  });
  const environment: Record<string, string> = {
    FAKE_OPENCODE_CAPTURE_PATH: capturePath,
    ...(options.existingSession ? { FAKE_OPENCODE_EXISTING_SESSION: options.existingSession } : {}),
  };
  const threadStateDirectory =
    options.threadStateDirectory ??
    join(directory, "state", "threads", `thread-${Math.random().toString(36).slice(2)}`);
  const context: HarnessSessionContext = {
    accessMode: options.accessMode ?? "approval-required",
    agentTools: {
      capabilityProfileId: "main",
      token: "test-agent-tools-token",
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
      token: "test-integration-tools-token",
      url: "https://host.example/internal/v1/integration-mcp",
    },
    machineAccessNotice: options.machineAccessNotice ?? noComputersNotice,
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "union-alpha",
      nativeModelId: "union-alpha",
      options: options.effort ? { effort: options.effort } : {},
      providerId: "opencode",
    }),
    platformGuide: "Opensteer platform guide.",
    providerState: testProviderState(directory, "isolated"),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    skills: options.skills ?? {
      skills: [
        { name: "opensteer-workspaces", path: join(directory, "skills", "opensteer-workspaces") },
      ],
    },
    threadId: createId("thread"),
    threadStateDirectory,
    workspaceId: createId("workspace"),
    workspacePath: directory,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [directory],
  };
  for (const skill of context.skills?.skills ?? []) {
    await mkdir(skill.path, { recursive: true });
    await writeFile(
      join(skill.path, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: Test.\n---\n\nTest skill.\n`,
    );
  }
  return {
    adapter,
    context,
    directory,
    capture: () => readCapture(capturePath),
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

describe("opencode Thread naming", () => {
  it("returns both lines from an isolated, tool-free naming process", async () => {
    const fixture = await setup("happy");
    let namingConfig: unknown;
    let namingLaunch: import("@opensteer/harness").HarnessProcessLaunch | undefined;
    const prompt = threadTitlePrompt("Migrate support", { icon: true });
    const session = await fixture.adapter.startSession({
      ...fixture.context,
      wrapProcessLaunch: (launch) => {
        if (!launch.cwd.includes("title-")) return launch;
        namingLaunch = launch;
        namingConfig = JSON.parse(readFileSync(launch.environment.OPENCODE_CONFIG!, "utf8"));
        return launch;
      },
    });
    try {
      expect(await session.generateTitle!({ prompt, signal: AbortSignal.timeout(2_000) })).toBe(
        "Support migration\nheadphones",
      );
      const launch = namingLaunch!;
      expect(launch.cwd).toContain("title-");

      const config = namingConfig;
      expect(config).toMatchObject({
        tools: { "*": false },
        permission: { "*": "deny" },
        mcp: {},
        plugin: [],
        instructions: [],
        skills: { paths: [], urls: [] },
        agent: {
          title: { disable: true },
          "opensteer-title": {
            prompt:
              "You name tasks. Reply exactly in the format the request asks for. Never use tools.",
            tools: { "*": false },
            permission: { "*": "deny" },
          },
        },
      });

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
