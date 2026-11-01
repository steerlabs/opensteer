import { ModelSelectionSchema, createId, type HarnessInstanceId } from "@opensteer/core";
import {
  nativeUserHarnessRuntimeBoundary,
  spawnSupervised,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokHarnessConfigSchema } from "./config.js";
import {
  GrokHarnessDriver,
  assertGrokSessionExists,
  generateGrokTitle,
  grokProcessEnvironment,
  inspectGrokUsage,
} from "./grok-driver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Grok containment", () => {
  it("names a Thread in a tool-free ephemeral process", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "grok-home");
    const workspace = join(root, "workspace");
    const capture = join(root, "capture.json");
    const executable = join(root, "fake-grok");
    await mkdir(home);
    await mkdir(workspace);
    await writeFile(join(home, "auth.json"), '{"credential":"not-captured"}', { mode: 0o600 });
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const agent = process.argv[process.argv.indexOf("--agent") + 1];
const prompt = process.argv[process.argv.indexOf("--prompt-file") + 1];
fs.writeFileSync(process.env.GROK_TEST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  authExists: fs.existsSync(path.join(process.env.GROK_HOME, "auth.json")),
  cwd: process.cwd(),
  home: process.env.GROK_HOME,
  profile: fs.readFileSync(agent, "utf8"),
  prompt: fs.readFileSync(prompt, "utf8")
}));
process.stdout.write("Contained title\\n");
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const context = sessionContext(root, workspace, {
      GROK_HOME: home,
      GROK_TEST_CAPTURE: capture,
      PATH: process.env.PATH ?? "",
    });

    await expect(
      generateGrokTitle(
        { executable, fetch, spawn: spawnSupervised },
        GrokHarnessConfigSchema.parse({}),
        context,
        { prompt: "Implement the parser", signal: new AbortController().signal },
      ),
    ).resolves.toBe("Contained title\n");

    const observed = JSON.parse(await readFile(capture, "utf8")) as {
      readonly args: readonly string[];
      readonly authExists: boolean;
      readonly cwd: string;
      readonly home: string;
      readonly profile: string;
      readonly prompt: string;
    };
    expect(observed.args).toEqual(
      expect.arrayContaining([
        "--no-subagents",
        "--disable-web-search",
        "--permission-mode",
        "dontAsk",
      ]),
    );
    expect(observed.authExists).toBe(true);
    expect(observed.cwd).not.toBe(workspace);
    expect(observed.profile).toContain("tools: []");
    expect(observed.profile).toContain("  - Agent");
    expect(observed.prompt).toContain("Implement the parser");
    expect(await stat(observed.cwd).catch(() => undefined)).toBeUndefined();
    expect(await stat(observed.home).catch(() => undefined)).toBeUndefined();
  });

  it("strips ambient API keys and disables ambient compatibility discovery", async () => {
    const root = await temporaryDirectory();
    const context = sessionContext(root, join(root, "workspace"), {
      PATH: process.env.PATH ?? "",
      XAI_API_KEY: "ambient-secret",
    });
    const environment = await grokProcessEnvironment(context.environment, context.providerState);
    expect(environment.apiKey).toBeUndefined();
    expect(environment.values.XAI_API_KEY).toBeUndefined();
    expect(environment.values).toMatchObject({
      GROK_CLAUDE_AGENTS_ENABLED: "0",
      GROK_CLAUDE_HOOKS_ENABLED: "0",
      GROK_CLAUDE_MCPS_ENABLED: "0",
      GROK_CLAUDE_RULES_ENABLED: "0",
      GROK_CLAUDE_SKILLS_ENABLED: "0",
      GROK_CODEX_AGENTS_ENABLED: "0",
      GROK_CODEX_HOOKS_ENABLED: "0",
      GROK_CODEX_MCPS_ENABLED: "0",
      GROK_CODEX_RULES_ENABLED: "0",
      GROK_CODEX_SKILLS_ENABLED: "0",
      GROK_CURSOR_AGENTS_ENABLED: "0",
      GROK_CURSOR_HOOKS_ENABLED: "0",
      GROK_CURSOR_MCPS_ENABLED: "0",
      GROK_CURSOR_RULES_ENABLED: "0",
      GROK_CURSOR_SKILLS_ENABLED: "0",
    });
  });

  it("passes only an isolated profile's stored API key", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "isolated-grok-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const base = sessionContext(root, workspace, {
      PATH: process.env.PATH ?? "",
      XAI_API_KEY: "ambient-secret",
    });
    const context = {
      ...base,
      providerState: {
        ...base.providerState,
        kind: "isolated" as const,
        providerHomeDirectory: home,
      },
    };
    const driver = new GrokHarnessDriver({ executable: "must-not-run" });
    const authentication = await driver.authenticate(
      {
        config: {},
        environment: context.environment,
        providerState: context.providerState,
        runtimeBoundary: context.runtimeBoundary,
        signal: context.signal,
        sourceId: "xai",
        workingDirectory: workspace,
      },
      { methodId: "xai-api-key" },
    );
    if (authentication.status !== "pending" || !authentication.submit) {
      throw new Error("xAI API key setup did not request a secret");
    }
    await authentication.submit("account-owned-key");
    await expect(authentication.result).resolves.toEqual({ status: "ready" });
    await expect(
      grokProcessEnvironment(context.environment, context.providerState),
    ).resolves.toEqual(expect.objectContaining({ apiKey: "account-owned-key" }));
    const environment = await grokProcessEnvironment(context.environment, context.providerState);
    expect(environment.values.XAI_API_KEY).toBe("account-owned-key");
  });

  it("refuses missing or mismatched native session state", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "grok-home");
    const workspace = join(root, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    const context = sessionContext(root, workspace, { GROK_HOME: home });
    await expect(assertGrokSessionExists("native-session", context)).rejects.toMatchObject({
      code: "not_found",
    });
    const summaryDirectory = join(
      home,
      "sessions",
      encodeURIComponent(workspace),
      "native-session",
    );
    await mkdir(summaryDirectory, { recursive: true });
    await writeFile(
      join(summaryDirectory, "summary.json"),
      JSON.stringify({ info: { cwd: join(root, "other"), id: "native-session" } }),
    );
    await expect(assertGrokSessionExists("native-session", context)).rejects.toMatchObject({
      code: "not_found",
    });
    await writeFile(
      join(summaryDirectory, "summary.json"),
      JSON.stringify({ info: { cwd: workspace, id: "native-session" } }),
    );
    await expect(assertGrokSessionExists("native-session", context)).resolves.toBeUndefined();
  });

  it("reports a zero-use subscription period", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "subscription-token" } }),
      { mode: 0o600 },
    );
    let requestHeaders: Headers | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 0,
            currentPeriod: { end: "2026-11-08T00:00:00Z", type: "weekly" },
          },
        }),
        { status: 200 },
      );
    };
    await expect(
      inspectGrokUsage(fetcher, root, new AbortController().signal),
    ).resolves.toMatchObject({
      limitReached: false,
      windows: [{ label: "Weekly", resetsAt: "2026-11-08T00:00:00Z", usedPercent: 0 }],
    });
    expect(requestHeaders?.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
    expect(requestHeaders?.get("x-grok-client-mode")).toBe("cli");
  });

  it("refuses shared Runner inspection, authentication, and session creation", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const context = {
      ...sessionContext(root, workspace, {}),
      runtimeBoundary: { kind: "isolated-service" as const },
    };
    const driver = new GrokHarnessDriver({ executable: "must-not-run" });
    await expect(
      driver.inspect({
        config: {},
        environment: context.environment,
        providerState: context.providerState,
        runtimeBoundary: context.runtimeBoundary,
        signal: context.signal,
        sourceId: "xai",
        workingDirectory: workspace,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      driver.authenticate(
        {
          config: {},
          environment: context.environment,
          providerState: context.providerState,
          runtimeBoundary: context.runtimeBoundary,
          signal: context.signal,
          sourceId: "xai",
          workingDirectory: workspace,
        },
        { methodId: "grok-device-code" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const adapter = await driver.create({
      config: {},
      instanceId: context.harnessInstanceId,
      sourceId: "xai",
    });
    await expect(adapter.startSession(context)).rejects.toMatchObject({ code: "forbidden" });
    await adapter.close();
  });
});

function sessionContext(
  root: string,
  workspacePath: string,
  environment: Readonly<Record<string, string>>,
): HarnessSessionContext {
  const instanceId = createId("harnessInstance") as HarnessInstanceId;
  return {
    accessMode: "approval-required",
    agentTools: { capabilityProfileId: "main", token: "agent", url: "https://host/mcp" },
    environment,
    environmentId: createId("environment"),
    harnessInstanceId: instanceId,
    history: [],
    historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
    instructions: undefined,
    integrationTools: { token: "integration", url: "https://host/integrations" },
    machineAccessNotice: "No other computers are reachable.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "grok-4.6",
      options: { effort: "high" },
      providerId: "xai",
    }),
    platformGuide: "Opensteer guide.",
    providerState: {
      continuationKey: "grok-test",
      kind: "ambient",
      privateStateRoot: root,
      providerHomeDirectory: undefined,
      store: { directory: join(root, "store"), id: "grok-test" },
    },
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    skills: undefined,
    threadId: createId("thread"),
    threadStateDirectory: join(root, "thread-state"),
    workspaceId: createId("workspace"),
    workspacePath,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [workspacePath],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-grok-"));
  temporaryDirectories.push(directory);
  return directory;
}
