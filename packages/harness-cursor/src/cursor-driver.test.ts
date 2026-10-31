import { readdir, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelSelectionSchema,
  createId,
  harnessUsageLimitFailureCode,
  type HarnessInstanceId,
} from "@opensteer/core";
import {
  isolatedServiceHarnessRuntimeBoundary,
  meetsMinimumVersion,
  nativeUserHarnessRuntimeBoundary,
  threadTitlePrompt,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessInput,
  type HarnessInspectionResult,
  type HarnessModelDescriptor,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  CursorHarnessDriver,
  cursorAccessModeHooks,
  cursorExitFailure,
  cursorModelArgument,
  cursorModelDescriptors,
  cursorPreToolUseDecision,
  cursorTranscriptDirectory,
  cursorWorkspaceSlug,
  parseCursorModelListing,
} from "./index.js";

// A Run outside any task with nothing earlier to state, for a person whose
// time zone is unknown: its thread context is one fixed line, so these turns
// carry exactly that context and the inputs and reports each test names.
const noThreadContext = {
  assignment: null,
  requesterTimeZone: null,
  threadState: { previousAssignment: null, previousRun: null },
};

const fakeAgent = fileURLToPath(new URL("./test-fixtures/fake-cursor-agent.mjs", import.meta.url));
const capturedListing = fileURLToPath(
  new URL("./test-fixtures/cursor-models.txt", import.meta.url),
);
const noComputersNotice = "No other computers are reachable from this Run.";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Cursor runtime boundary", () => {
  it.each(["start", "resume"] as const)(
    "refuses an isolated-service Runner on %s",
    async (mode) => {
      const fixture = await setup({ runtimeBoundary: isolatedServiceHarnessRuntimeBoundary });
      if (mode === "resume") await seedTranscript(fixture);
      const open =
        mode === "start"
          ? fixture.adapter.startSession(fixture.context)
          : fixture.adapter.resumeSession(fixture.reference, fixture.context);
      await expect(open).rejects.toThrow("Cursor runs only on a computer you signed in on.");
      await expect(open).rejects.toMatchObject({ code: "forbidden" });
      // Nothing was launched and nothing was written for a Run that cannot run.
      expect(await fixture.invocations()).toEqual([]);
      await fixture.adapter.close();
    },
  );
});

describe("Cursor access-mode hooks", () => {
  it.each([
    ["approval-required", "Write", "file-change"],
    ["approval-required", "Edit", "file-change"],
    ["auto-accept-edits", "Write", "allow"],
    ["auto-accept-edits", "Edit", "allow"],
    ["approval-required", "Read", "allow"],
    ["auto-accept-edits", "Grep", "allow"],
    ["approval-required", "Glob", "allow"],
    // Already gated by their own events; answering here would open a second
    // Request for one action.
    ["approval-required", "Shell", "allow"],
    ["auto-accept-edits", "MCP:probe", "allow"],
    // Anything this build cannot name is treated as mutating, in both modes.
    ["approval-required", "Deploy", "unknown-tool"],
    ["auto-accept-edits", "Deploy", "unknown-tool"],
    ["approval-required", "", "unknown-tool"],
  ] as const)("decides preToolUse for %s / %s", (accessMode, tool, decision) => {
    expect(cursorPreToolUseDecision(accessMode, tool)).toBe(decision);
  });

  it("refuses the auto mode the engine cannot enforce", () => {
    expect(() => cursorAccessModeHooks("auto")).toThrow(/auto access mode/u);
  });
});

describe("Cursor plugin materialisation", () => {
  it.each([
    ["approval-required", ["beforeShellExecution", "beforeMCPExecution", "preToolUse"]],
    ["auto-accept-edits", ["beforeShellExecution", "beforeMCPExecution", "preToolUse"]],
    ["full-access", []],
  ] as const)("writes the %s hook table and the MCP servers", async (accessMode, events) => {
    const fixture = await setup({ accessMode });
    const session = await fixture.adapter.startSession(fixture.context);
    const pluginPath = join(fixture.context.threadStateDirectory, "opensteer");

    const plugin = JSON.parse(
      await readFile(join(pluginPath, ".cursor-plugin", "plugin.json"), "utf8"),
    );
    // The directory basename becomes `plugin-opensteer-<server>` in every tool
    // id the model sees, so it is pinned by this test.
    expect(plugin.name).toBe("opensteer");

    const hooks = JSON.parse(await readFile(join(pluginPath, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks.hooks)).toEqual([...events]);
    for (const entry of Object.values(hooks.hooks) as {
      failClosed: boolean;
      timeout: number;
      command: string;
    }[][]) {
      expect(entry[0]?.failClosed).toBe(true);
      expect(entry[0]?.timeout).toBe(2_147_483);
      expect(entry[0]?.command).toContain(process.execPath);
      // The approval socket cannot live beside the plugin: a Thread state
      // directory alone is longer than a Unix socket address allows.
      const socketPath = hookSocketPath(entry[0]?.command ?? "");
      expect(socketPath.startsWith(tmpdir())).toBe(true);
      expect(socketPath.endsWith("/cursor-hook.sock")).toBe(true);
      expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThan(100);
    }

    const mcp = JSON.parse(await readFile(join(pluginPath, ".mcp.json"), "utf8"));
    expect(mcp).toEqual({
      mcpServers: {
        opensteer: {
          headers: { Authorization: "Bearer test-agent-tools-token" },
          url: "https://host.example/internal/v1/mcp",
        },
        opensteer_integrations: {
          headers: { Authorization: "Bearer test-integration-tools-token" },
          url: "https://host.example/internal/v1/integration-mcp",
        },
      },
    });
    const mode = (await stat(join(pluginPath, ".mcp.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    // A `--plugin-dir`'s rules never reach the model in print mode, so none is
    // written and every instruction travels on the prompt.
    await expect(stat(join(pluginPath, "rules"))).rejects.toThrow();

    await session.stop();
    await fixture.adapter.close();
  });

  it("removes the approval socket's private directory when the session stops", async () => {
    const fixture = await setup({ accessMode: "approval-required" });
    const session = await fixture.adapter.startSession(fixture.context);
    const hooks = JSON.parse(
      await readFile(
        join(fixture.context.threadStateDirectory, "opensteer", "hooks", "hooks.json"),
        "utf8",
      ),
    );
    const socketPath = hookSocketPath(hooks.hooks.beforeShellExecution[0].command);
    const socketDirectory = dirname(socketPath);
    expect((await stat(socketDirectory)).mode & 0o777).toBe(0o700);
    await stat(socketPath);
    await session.stop();
    await expect(stat(socketDirectory)).rejects.toThrow();
    await fixture.adapter.close();
  });

  it("keeps the Opensteer tokens out of the harness process environment", async () => {
    const fixture = await setup({});
    const session = await fixture.adapter.startSession(fixture.context);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    const spawned = await fixture.invocations();
    expect(spawned.length).toBeGreaterThan(0);
    for (const invocation of spawned) {
      const serialized = JSON.stringify(invocation.environment);
      expect(serialized).not.toContain("test-agent-tools-token");
      expect(serialized).not.toContain("test-integration-tools-token");
    }
    await fixture.adapter.close();
  });
});

describe("Cursor inspection", () => {
  it("reports the signed-in account, its plan and its catalog", async () => {
    const result = await inspect({});
    expect(result?.status).toBe("ready");
    if (result?.status !== "ready") throw new Error("Expected a ready inspection");
    expect(result.connections?.[0]).toMatchObject({
      accountLabel: "cursor@example.test",
      authKind: "subscription",
      billingLabel: "Pro",
      logoutSupported: false,
      status: "connected",
    });
    expect(result.setupMethods ?? []).toEqual([]);
    expect(result.models.length).toBeGreaterThan(30);
    expect(result.models.find((model) => model.modelId === "auto")?.isDefault).toBe(true);
  });

  it("asks for a sign-in the Runner cannot perform when the CLI is logged out", async () => {
    const result = await inspect({ scenario: "logged-out" });
    expect(result).toMatchObject({
      detail: "Sign in to use Cursor. Run `agent login` on this computer.",
      status: "authentication-required",
    });
    expect(result?.setupMethods ?? []).toEqual([]);
  });

  it("names the install command when the CLI is absent", async () => {
    const result = await inspect({ executable: join(tmpdir(), "opensteer-missing-agent") });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("https://cursor.com/install");
  });

  it("names both versions when the installed CLI is too old", async () => {
    const result = await inspect({ version: "2026.08.31-4057e58" });
    expect(result?.status).toBe("unavailable");
    expect(result?.detail).toContain("2026.08.31-4057e58");
    expect(result?.detail).toContain("2026.09.10");
  });

  it("refuses the isolated-service boundary outright", async () => {
    const result = await inspect({ runtimeBoundary: isolatedServiceHarnessRuntimeBoundary });
    expect(result).toEqual({
      detail: "Cursor runs only on a computer you signed in on.",
      status: "unavailable",
    });
  });

  it("is unavailable rather than empty when the CLI lists no models", async () => {
    const result = await inspect({ scenario: "no-models" });
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("passes --disable-auto-update to every subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-cursor-audit-"));
    temporaryDirectories.push(directory);
    const capturePath = join(directory, "capture.jsonl");
    await new CursorHarnessDriver({
      executable: fakeAgent,
      nodeExecutable: process.execPath,
    }).inspect?.({
      config: {},
      environment: { FAKE_CURSOR_CAPTURE_PATH: capturePath, PATH: process.env.PATH ?? "" },
      providerState: testProviderState(directory),
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: new AbortController().signal,
      sourceId: "cursor",
      workingDirectory: directory,
    });
    const invocations = await readCapture(capturePath);
    expect(invocations.map((invocation) => invocation.argv[0])).toEqual([
      "--version",
      "status",
      "about",
      "models",
    ]);
    for (const invocation of invocations)
      expect(invocation.argv).toContain("--disable-auto-update");
  });
});

describe("Cursor model catalog", () => {
  it("folds both suffix orders and Cursor's legacy spellings onto one descriptor per base", async () => {
    const listing = parseCursorModelListing(await readFile(capturedListing, "utf8"));
    const models = cursorModelDescriptors(listing, "cursor");

    const opus5 = models.find((model) => model.nativeModelId === "claude-opus-5");
    expect(opus5).toMatchObject({
      displayName: "Claude Opus 5 1M",
      modelId: "claude-opus-5",
      providerId: "anthropic",
    });
    // `claude-opus-5-thinking-high` and `claude-4.6-opus-high-thinking` spell
    // the same two suffixes in opposite orders in one listing.
    const opus46 = models.find((model) => model.nativeModelId === "claude-4.6-opus");
    expect(opus46).toMatchObject({ modelId: "claude-opus-4-6", providerId: "anthropic" });
    expect(models.find((model) => model.nativeModelId === "claude-4.5-sonnet")?.modelId).toBe(
      "claude-sonnet-4-5",
    );
    expect(models.find((model) => model.nativeModelId === "claude-4-sonnet")?.modelId).toBe(
      "claude-sonnet-4",
    );

    // Cursor's first-party model family is presented under xAI/Grok while the
    // exact Cursor CLI spelling remains the native id; other lab models fold home.
    expect(models.find((model) => model.nativeModelId === "composer-2.5")?.providerId).toBe("xai");
    expect(models.find((model) => model.nativeModelId === "cursor-grok-4.6")?.providerId).toBe(
      "xai",
    );
    expect(models.find((model) => model.nativeModelId === "gpt-5.3-codex")?.providerId).toBe(
      "openai",
    );
    expect(models.find((model) => model.nativeModelId === "gemini-3.7-flash")?.providerId).toBe(
      "google",
    );
    expect(models.find((model) => model.nativeModelId === "glm-5.2")?.providerId).toBe("zai");

    // The listing states no modalities, so only families whose makers
    // document image input say so; the rest stay silent rather than claim it.
    const acceptsImages = (nativeModelId: string) =>
      models.find((model) => model.nativeModelId === nativeModelId)?.acceptsImages;
    for (const vision of [
      "claude-opus-5",
      "claude-4.6-sonnet",
      "gpt-5.5",
      "gpt-5-mini",
      "gpt-5.3-codex",
      "gemini-3.1-pro",
      "gemini-3.7-flash",
    ]) {
      expect({ acceptsImages: acceptsImages(vision), vision }).toEqual({
        acceptsImages: true,
        vision,
      });
    }
    for (const unknown of ["glm-5.2", "kimi-k3", "composer-2.5", "cursor-grok-4.6", "auto"]) {
      expect(
        models.find((model) => model.nativeModelId === unknown),
        unknown,
      ).not.toHaveProperty("acceptsImages");
    }

    // Options are only offered where the listing actually holds two values.
    expect(models.find((model) => model.nativeModelId === "auto")?.options).toEqual([]);
    expect(models.find((model) => model.nativeModelId === "composer-2.5")?.options).toEqual([
      { defaultValue: false, id: "fast", label: "Fast", type: "toggle" },
    ]);
    const efforts = models.find((model) => model.nativeModelId === "gpt-5.5")?.options[0];
    expect(efforts).toMatchObject({ id: "effort", type: "select" });
    // `extra-high` and `xhigh` both appear in one listing as effort spellings.
    expect(efforts?.type === "select" ? efforts.values.map((value) => value.value) : []).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "extra-high",
    ]);
    const gpt52 = models.find((model) => model.nativeModelId === "gpt-5.2")?.options[0];
    expect(gpt52?.type === "select" ? gpt52.values[0] : undefined).toEqual({
      label: "Default",
      value: "default",
    });

    // Opus 5 has no non-thinking xhigh/max variants. Independent controls
    // would expose combinations Cursor refuses, so its one control names only
    // exact ids from the listing and gives each tuple an unambiguous label.
    const opus5Variants = opus5?.options[0];
    expect(opus5Variants).toMatchObject({
      defaultValue: "claude-opus-5-thinking-high",
      id: "variant",
      label: "Configuration",
      type: "select",
    });
    if (opus5Variants?.type !== "select") throw new Error("Expected an Opus 5 variant select");
    expect(opus5Variants.values).toContainEqual({
      label: "Max · Thinking · Fast",
      value: "claude-opus-5-thinking-max-fast",
    });
    expect(new Set(opus5Variants.values.map((value) => value.label)).size).toBe(
      opus5Variants.values.length,
    );
  });

  it("composes the exact listed id for a selection and refuses one that is not listed", async () => {
    const listing = parseCursorModelListing(await readFile(capturedListing, "utf8"));
    const resolve = (nativeModelId: string, options: Record<string, string | boolean>) =>
      cursorModelArgument(
        listing,
        ModelSelectionSchema.parse({
          modelId: nativeModelId,
          nativeModelId,
          options,
          providerId: "cursor",
        }),
      );

    expect(resolve("claude-opus-5", {})).toBe("claude-opus-5-thinking-high");
    expect(resolve("claude-opus-5", { variant: "claude-opus-5-thinking-xhigh-fast" })).toBe(
      "claude-opus-5-thinking-xhigh-fast",
    );
    // Threads saved before sparse grids acquired their exact variant picker
    // keep their dimension tuple. It is accepted only when that exact tuple
    // still names an id in the current CLI listing.
    expect(resolve("claude-opus-5", { effort: "xhigh", thinking: true, fast: true })).toBe(
      "claude-opus-5-thinking-xhigh-fast",
    );
    expect(resolve("claude-4.6-opus", { effort: "high", thinking: true })).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolve("gpt-5.2", {})).toBe("gpt-5.2");
    expect(resolve("gpt-5.2", { effort: "default", fast: true })).toBe("gpt-5.2-fast");
    expect(resolve("gpt-5.5", { effort: "extra-high" })).toBe("gpt-5.5-extra-high");
    expect(resolve("auto", {})).toBe("auto");
    // A full variant id from an older catalog read is still a model Cursor runs.
    expect(resolve("claude-opus-4-8-thinking-max-fast", {})).toBe(
      "claude-opus-4-8-thinking-max-fast",
    );

    expect(() => resolve("composer-2.5", { effort: "max" })).toThrow(
      /does not offer the option effort for composer-2\.5/u,
    );
    expect(() => resolve("claude-opus-5", { variant: "claude-opus-5-max-fast" })).toThrow(
      /does not offer the variant/u,
    );
    expect(() =>
      resolve("claude-opus-5", { effort: "xhigh", thinking: false, fast: true }),
    ).toThrow(/does not offer claude-opus-5 with reasoning xhigh, thinking false, fast true/u);
    expect(() =>
      resolve("claude-opus-5", {
        variant: "claude-opus-5-thinking-high",
        effort: "high",
      }),
    ).toThrow(/does not offer the option effort/u);
    expect(() => resolve("claude-opus-5", { effort: false })).toThrow(
      /does not accept the value of option effort/u,
    );
    expect(() => resolve("claude-opus-5", { thinking: "false" })).toThrow(
      /does not accept the value of option thinking/u,
    );
    expect(() => resolve("claude-opus-5", { fast: "false" })).toThrow(
      /does not accept the value of option fast/u,
    );
    expect(() => resolve("gpt-5.2", { effort: false })).toThrow(
      /does not accept the value of option effort/u,
    );
    expect(() => resolve("gpt-5.2", { fast: "false" })).toThrow(
      /does not accept the value of option fast/u,
    );
    expect(() => resolve("gpt-5.2", { surprise: true })).toThrow(
      /does not offer the option surprise/u,
    );
    expect(() => resolve("claude-opus-4-8-thinking-max-fast", { fast: false })).toThrow(
      /does not offer the model/u,
    );
    expect(() => resolve("gpt-4-turbo", {})).toThrow(/does not offer the model gpt-4-turbo/u);
  });

  it("makes every listed variant selectable and every emitted option product resolvable", async () => {
    const listing = parseCursorModelListing(await readFile(capturedListing, "utf8"));
    const models = cursorModelDescriptors(listing, "cursor");

    for (const base of listing.bases) {
      const descriptor = models.find((model) => model.nativeModelId === base.baseId);
      expect(descriptor, base.baseId).toBeDefined();
      if (!descriptor) continue;
      const selections = optionProducts(descriptor.options);
      const resolved = selections.map((options) =>
        cursorModelArgument(
          listing,
          ModelSelectionSchema.parse({
            modelId: descriptor.modelId,
            nativeModelId: descriptor.nativeModelId,
            options,
            providerId: descriptor.providerId,
          }),
        ),
      );
      const listed = base.variants.map((variant) => variant.id);
      expect(new Set(resolved), `${base.baseId} emitted selections`).toEqual(new Set(listed));
      expect(
        resolved.every((id) => listed.includes(id)),
        `${base.baseId} exact ids`,
      ).toBe(true);
    }
  });

  it("deduplicates repeated ids and disambiguates two spellings of the same tuple", () => {
    const listing = parseCursorModelListing(`Available models

sample-high-thinking - Sample High Thinking (default)
sample-high-thinking - Sample High Thinking (default)
sample-thinking-high - Sample Thinking High
`);
    expect(listing.bases[0]?.variants.map((variant) => variant.id)).toEqual([
      "sample-high-thinking",
      "sample-thinking-high",
    ]);
    const model = cursorModelDescriptors(listing, "cursor")[0];
    const option = model?.options[0];
    expect(option?.type).toBe("select");
    if (option?.type !== "select") throw new Error("Expected a variant select");
    expect(option.values).toEqual([
      {
        label: "High · Thinking (sample-high-thinking)",
        value: "sample-high-thinking",
      },
      {
        label: "High · Thinking (sample-thinking-high)",
        value: "sample-thinking-high",
      },
    ]);
  });

  it("claims image input only for families documented to read images", () => {
    const listing = parseCursorModelListing(`Available models

gpt-5.3-codex-spark - Codex 5.3 Spark
gpt-5-spark - GPT-5 Spark
gpt-6-spark - GPT-6 Spark
gpt-6-astra - GPT-6 Astra
gpt-4o - GPT-4o
gpt-4.1 - GPT-4.1
gpt-oss-120b - GPT OSS 120B
grok-4 - Grok 4
grok-4.1 - Grok 4.1
grok-code-fast-1 - Grok Code Fast
`);
    const acceptsImages = Object.fromEntries(
      cursorModelDescriptors(listing, "cursor").map((model) => [
        model.nativeModelId,
        model.acceptsImages,
      ]),
    );
    expect(acceptsImages).toEqual({
      "gpt-4.1": true,
      "gpt-4o": true,
      "gpt-5.3-codex-spark": undefined,
      "gpt-5-spark": undefined,
      "gpt-6-spark": undefined,
      "gpt-6-astra": true,
      "gpt-oss-120b": undefined,
      "grok-4": true,
      "grok-4.1": true,
      "grok-code-fast-1": undefined,
    });
  });

  it("orders versions by their dated prefix", () => {
    expect(meetsMinimumVersion("2026.09.15-d2fe57e", "2026.09.10")).toBe(true);
    expect(meetsMinimumVersion("2026.09.10-fd3934a", "2026.09.10")).toBe(true);
    expect(meetsMinimumVersion("2026.08.31-4057e58", "2026.09.10")).toBe(false);
    expect(meetsMinimumVersion("2025.12.01", "2026.09.10")).toBe(false);
    expect(meetsMinimumVersion("", "2026.09.10")).toBe(false);
  });
});

function optionProducts(
  options: HarnessModelDescriptor["options"],
): readonly Record<string, string | boolean>[] {
  return options.reduce<readonly Record<string, string | boolean>[]>(
    (products, option) => {
      const values =
        option.type === "toggle" ? [false, true] : option.values.map((value) => value.value);
      return products.flatMap((product) =>
        values.map((value) => ({ ...product, [option.id]: value })),
      );
    },
    [{}],
  );
}

describe("Cursor turns", () => {
  it("publishes one ordered lifecycle with usage before the terminal event", async () => {
    const fixture = await setup({});
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();

    const types = observer.events.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("assistant.delta");
    expect(types).toContain("assistant.message");
    expect(types).toContain("reasoning.delta");
    expect(types).toContain("reasoning.completed");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(
      types.filter(
        (type) => type.startsWith("run.") && type !== "run.started" && type !== "run.usage",
      ),
    ).toEqual(["run.completed"]);
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.completed"));
    expect(types.filter((type) => type === "run.usage")).toHaveLength(1);

    const usage = observer.events.find((event) => event.type === "run.usage");
    expect(usage?.data).toEqual({
      cacheWriteTokens: 0,
      cachedInputTokens: 22_216,
      inputTokens: 13_242,
      outputTokens: 570,
    });
    // Cursor's CLI states no cost on this surface, so the Run states none.
    expect(usage?.data).not.toHaveProperty("costUsd");

    const tool = observer.events.find((event) => event.type === "tool.started");
    expect(tool?.data).toMatchObject({ tool: { name: "shell", namespace: "cursor" } });

    // The CLI updates itself in place, and a Run that starts on one version and
    // ends on another is a Run whose event shapes changed underneath it.
    const invocations = await fixture.invocations();
    expect(invocations.map((invocation) => invocation.argv[0])).toEqual([
      "create-chat",
      "models",
      "-p",
    ]);
    for (const invocation of invocations)
      expect(invocation.argv).toContain("--disable-auto-update");
    await fixture.adapter.close();
  });

  it("prefixes the machine-access notice and the tools notice onto a resumed Run's prompt", async () => {
    const fixture = await setup({
      machineAccessNotice: "You can reach example-mac over SSH.",
      skills: [
        { description: "Prepare release notes", name: "release-notes" },
        { description: "Inspect production logs", name: "inspect-logs" },
      ],
    });
    await seedTranscript(fixture);
    const session = await fixture.adapter.resumeSession(fixture.reference, fixture.context);
    await session.execute(fixture.turn("Check the other computer"));
    await session.stop();

    const prompt = (await fixture.prompts())[0] ?? "";
    expect(prompt).toContain("You can reach example-mac over SSH.");
    expect(prompt).toContain("Opensteer platform guide.");
    expect(prompt).toContain("Follow the workspace instructions.");
    expect(prompt).toContain("plugin-opensteer-opensteer");
    expect(prompt).toContain("getMcpTools");
    expect(prompt).toContain("- release-notes: Prepare release notes");
    expect(prompt).toContain(
      `SKILL.md: ${join(fixture.context.skills!.skills[0]!.path, "SKILL.md")}`,
    );
    expect(prompt).toContain("- inspect-logs: Inspect production logs");
    expect(prompt).not.toContain("PRIVATE release-notes BODY");
    expect(prompt).toContain("[Opensteer input]");
    expect(prompt).toContain("Check the other computer");
    await fixture.adapter.close();
  });

  it("sends the exact composed --model argument and the resumed chat id", async () => {
    const fixture = await setup({
      modelSelection: {
        modelId: "claude-opus-4-6",
        nativeModelId: "claude-4.6-opus",
        options: { effort: "max", thinking: true },
        providerId: "anthropic",
      },
    });
    const session = await fixture.adapter.startSession(fixture.context);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    const print = (await fixture.invocations()).find((invocation) => invocation.argv[0] === "-p");
    expect(print?.argv).toEqual(
      expect.arrayContaining([
        "--model",
        "claude-4.6-opus-max-thinking",
        "--resume",
        fixture.reference,
      ]),
    );
    expect(print?.argv).toEqual(
      expect.arrayContaining(["--trust", "--force", "--approve-mcps", "--disable-auto-update"]),
    );
    expect(print?.cwd).toBe(await realpath(fixture.context.workspacePath));
    await fixture.adapter.close();
  });

  it("launches the CLI with the flags that define the security posture", async () => {
    const fixture = await setup({ accessMode: "approval-required" });
    const session = await fixture.adapter.startSession(fixture.context);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    const argv = (await fixture.invocations()).find((one) => one.argv[0] === "-p")?.argv ?? [];
    expect(argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        // Opensteer already admitted this Workspace; an untrusted CLI refuses
        // to run at all.
        "--trust",
        // Cursor's own classifier can only deny, never ask. The plugin's hooks
        // are the approval channel, and they override `--force`.
        "--force",
        "--approve-mcps",
        "--disable-auto-update",
      ]),
    );
    expect(argv[argv.indexOf("--workspace") + 1]).toBe(fixture.context.workspacePath);
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(
      join(fixture.context.threadStateDirectory, "opensteer"),
    );
    // The prompt is the last argument, and nothing reads stdin.
    expect(argv.at(-1)).toContain("Say hello");
    await fixture.adapter.close();
  });

  it("refuses a turn whose prompt exceeds the configured input bound", async () => {
    const fixture = await setup({ config: { maxTurnInputBytes: 1_024 } });
    const session = await fixture.adapter.startSession(fixture.context);
    await expect(session.execute(fixture.turn("x".repeat(2_048)))).rejects.toThrow(
      /exceeding the configured 1024-byte limit/u,
    );
    await session.stop();
    await fixture.adapter.close();
  });

  it("reports an error result as a failed Run, with its usage", async () => {
    const fixture = await setup({ scenario: "error-result" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    const types = observer.events.map((event) => event.type);
    expect(types).toContain("run.usage");
    expect(types.indexOf("run.usage")).toBeLessThan(types.indexOf("run.failed"));
    expect(observer.events.find((event) => event.type === "run.failed")?.data).toMatchObject({
      code: "cursor_harness_error",
      message: "The model could not finish this turn",
    });
    expect(types).not.toContain("run.completed");
    await fixture.adapter.close();
  });

  it.each([
    ["trust-gate", "cursor_harness_error", /Workspace Trust Required/u],
    ["invalid-key", "cursor_authentication", /agent login/u],
    ["usage-limit", harnessUsageLimitFailureCode, /Usage limit exceeded/u],
  ] as const)("classifies the %s exit", async (scenario, code, message) => {
    const fixture = await setup({ scenario });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    const failure = observer.events.find((event) => event.type === "run.failed");
    expect(observer.events.map((event) => event.type)).not.toContain("run.started");
    expect(failure?.data).toMatchObject({ code });
    expect(String(failure?.data.message ?? "")).toMatch(message);
    await fixture.adapter.close();
  });

  it("does not acknowledge a turn from system/init alone", async () => {
    const fixture = await setup({ scenario: "init-then-failure" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    expect(observer.events.map((event) => event.type)).toEqual(["run.failed"]);
    await fixture.adapter.close();
  });

  it("classifies exits without spawning anything", () => {
    expect(cursorExitFailure(1, "Rate limit exceeded")).toMatchObject({
      code: harnessUsageLimitFailureCode,
    });
    expect(cursorExitFailure(1, "")).toMatchObject({ code: "cursor_harness_error" });
  });

  it("projects a tool kind it has never seen without failing the Run", async () => {
    const fixture = await setup({ scenario: "unknown-tool" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    expect(observer.events.find((event) => event.type === "tool.started")?.data).toMatchObject({
      tool: { name: "crystalBall", namespace: "cursor" },
    });
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
    await fixture.adapter.close();
  });

  it("drops frames the CLI writes after the terminal result", async () => {
    const fixture = await setup({ scenario: "post-terminal" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    await observer.waitFor("run.completed");
    const types = observer.events.map((event) => event.type);
    expect(types.at(-1)).toBe("run.completed");
    expect(JSON.stringify(observer.events)).not.toContain("AFTER-THE-END");
    await fixture.adapter.close();
  });

  it("fails the Run when the CLI streams somebody else's session", async () => {
    const fixture = await setup({ scenario: "foreign-session" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    expect(observer.events.find((event) => event.type === "run.failed")?.data).toMatchObject({
      message: expect.stringContaining("99999999-9999-9999-9999-999999999999"),
    });
    await fixture.adapter.close();
  });

  it("fails the Run rather than truncating an oversized stream line", async () => {
    const fixture = await setup({
      config: { maxStreamLineBytes: 16 * 1_024 },
      scenario: "huge-line",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Say hello"));
    await session.stop();
    expect(observer.events.find((event) => event.type === "run.failed")?.data).toMatchObject({
      message: expect.stringContaining("longer than"),
    });
    await fixture.adapter.close();
  });
});

describe("Cursor approvals", () => {
  it("opens a command Request, carries the note into the denial and lets the Run continue", async () => {
    const fixture = await setup({ accessMode: "approval-required", scenario: "hook-shell" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Run two commands"));

    const first = await observer.waitFor("request.opened");
    expect(first.data.request).toMatchObject({
      kind: "harness.approval",
      presentation: { detail: "echo hi", kind: "choice", title: "Approve command" },
    });
    await session.resolveRequest(first.data.request.id, { kind: "choice", optionId: "allow-once" });

    const second = await waitForOccurrence(observer, "request.opened", 2);
    expect(second.data.request.presentation).toMatchObject({ detail: "uname -a" });
    await session.resolveRequest(second.data.request.id, {
      kind: "choice",
      optionId: "reject",
      text: "not on this machine",
    });

    await turn;
    await session.stop();
    const completions = observer.events.filter((event) => event.type === "tool.completed");
    expect(JSON.stringify(completions[0]?.data)).toContain("stdout");
    expect(completions[0]?.data).toMatchObject({ isError: false });
    expect(completions[1]?.data).toMatchObject({ isError: true });
    expect(JSON.stringify(completions[1]?.data)).toContain("not on this machine");
    expect(observer.events.map((event) => event.type)).toContain("run.completed");
    await fixture.adapter.close();
  });

  it("gates a file change under approval-required and lets it through when edits are auto-accepted", async () => {
    const gated = await setup({ accessMode: "approval-required", scenario: "hook-write" });
    const gatedSession = await gated.adapter.startSession(gated.context);
    const gatedObserver = observe(gatedSession.events);
    const gatedTurn = gatedSession.execute(gated.turn("Write a file"));
    const request = await gatedObserver.waitFor("request.opened");
    expect(request.data.request.presentation).toMatchObject({ title: "Approve file change" });
    await gatedSession.resolveRequest(request.data.request.id, {
      kind: "choice",
      optionId: "reject",
    });
    await gatedTurn;
    await gatedSession.stop();
    expect(
      gatedObserver.events.find((event) => event.type === "tool.completed")?.data,
    ).toMatchObject({
      isError: true,
    });
    await gated.adapter.close();

    const open = await setup({ accessMode: "auto-accept-edits", scenario: "hook-write" });
    const openSession = await open.adapter.startSession(open.context);
    const openObserver = observe(openSession.events);
    await openSession.execute(open.turn("Write a file"));
    await openSession.stop();
    expect(openObserver.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
    expect(
      openObserver.events.find((event) => event.type === "tool.completed")?.data,
    ).toMatchObject({
      isError: false,
    });
    await open.adapter.close();
  });

  it("always allows Opensteer's own MCP servers and asks about everybody else's", async () => {
    const fixture = await setup({ accessMode: "approval-required", scenario: "hook-mcp" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Call both servers"));
    const request = await observer.waitFor("request.opened");
    expect(request.data.request.presentation).toMatchObject({
      detail: "plugin-probe-other · probe",
      title: "Approve MCP tool",
    });
    await session.resolveRequest(request.data.request.id, { kind: "choice", optionId: "reject" });
    await turn;
    await session.stop();
    expect(observer.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    const started = observer.events.filter((event) => event.type === "tool.started");
    // An MCP call reports the tool's own arguments, not Cursor's wrapper
    // naming the server and tool.
    expect(started[0]?.data).toMatchObject({
      arguments: {},
      tool: { name: "probe", namespace: "opensteer" },
    });
    expect(started[0]?.data.arguments).toEqual({});
    expect(started[1]?.data).toMatchObject({
      tool: { name: "probe", namespace: "mcp:plugin-probe-other" },
    });
    await fixture.adapter.close();
  });

  it("restates a completed MCP call when its started frame had incomplete arguments", async () => {
    const fixture = await setup({ scenario: "streamed-mcp-arguments" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Use an integration"));
    await session.stop();

    const starts = observer.events.filter((event) => event.type === "tool.started");
    expect(starts.map((event) => event.data.arguments)).toEqual([
      {},
      { toolRef: "igr_grant.itl_tool.digest", arguments: { query: "hello" } },
      { toolRef: "igr_existing.itl_tool.digest" },
    ]);
    expect(starts.map((event) => event.data.tool)).toEqual([
      { name: "integration_call", namespace: "opensteer.integrations" },
      { name: "integration_call", namespace: "opensteer.integrations" },
      { name: "integration_call", namespace: "opensteer.integrations" },
    ]);
    expect(observer.events.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    await fixture.adapter.close();
  });

  it("keeps complete MCP arguments across completion-only, duplicate, and late frames", async () => {
    const fixture = await setup({ scenario: "mcp-lifecycle-adversarial" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    await session.execute(fixture.turn("Use integrations"));
    await session.stop();

    expect(
      observer.events
        .filter((event) => event.type === "tool.started")
        .map((event) => [event.data.callId, event.data.arguments]),
    ).toEqual([
      ["tool_complete_only", { toolRef: "igr_complete.itl_tool.digest" }],
      ["tool_duplicate", { toolRef: "igr_full.itl_tool.digest" }],
      ["tool_streamed", {}],
      ["tool_streamed", { toolRef: "igr_streamed.itl_tool.digest" }],
      ["tool_second_start", { toolRef: "igr_partial.itl_tool.digest" }],
      ["tool_second_start", { toolRef: "igr_second.itl_tool.digest" }],
    ]);
    expect(observer.events.filter((event) => event.type === "tool.completed")).toHaveLength(4);
    await fixture.adapter.close();
  });

  it("denies fail-closed when nobody answers before the hook's timeout", async () => {
    const fixture = await setup({
      accessMode: "approval-required",
      config: { hookTimeoutSeconds: 1 },
      scenario: "hook-shell",
    });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Run two commands"));
    const request = await observer.waitFor("request.opened");
    // Nobody resolves it: Cursor kills the hook at its timeout and `failClosed`
    // turns the silence into a block rather than an allow.
    await turn;
    await session.stop();
    expect(observer.events.find((event) => event.type === "tool.completed")?.data).toMatchObject({
      isError: true,
    });
    // The hook is gone, so the Request goes with it rather than staying
    // answerable in front of a person.
    expect(observer.events.find((event) => event.type === "request.cancelled")?.data).toMatchObject(
      {
        reason: "source-closed",
        requestId: request.data.request.id,
      },
    );
    await fixture.adapter.close();
  });

  it.each(["approval-required", "auto-accept-edits"] as const)(
    "asks about a tool it does not recognise under %s",
    async (accessMode) => {
      const fixture = await setup({ accessMode, scenario: "hook-unknown-tool" });
      const session = await fixture.adapter.startSession(fixture.context);
      const observer = observe(session.events);
      const turn = session.execute(fixture.turn("Deploy it"));
      const request = await observer.waitFor("request.opened");
      expect(request.data.request.presentation).toMatchObject({
        kind: "choice",
        risk: "high",
        title: "Approve a tool Opensteer does not recognise",
      });
      const detail = String(
        (request.data.request.presentation as { detail?: string }).detail ?? "",
      );
      expect(detail).toContain("Deploy");
      expect(detail).toContain("production");
      await session.resolveRequest(request.data.request.id, { kind: "choice", optionId: "reject" });
      await turn;
      await session.stop();
      expect(observer.events.find((event) => event.type === "tool.completed")?.data).toMatchObject({
        isError: true,
      });
      await fixture.adapter.close();
    },
  );

  it("never asks about a read, in either gated mode", async () => {
    for (const accessMode of ["approval-required", "auto-accept-edits"] as const) {
      const fixture = await setup({ accessMode, scenario: "hook-read" });
      const session = await fixture.adapter.startSession(fixture.context);
      const observer = observe(session.events);
      await session.execute(fixture.turn("Read the file"));
      await session.stop();
      expect(observer.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
      expect(observer.events.find((event) => event.type === "tool.completed")?.data).toMatchObject({
        isError: false,
      });
      await fixture.adapter.close();
    }
  });

  it("cancels every pending Request when the turn is interrupted", async () => {
    const fixture = await setup({ accessMode: "approval-required", scenario: "slow" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Sleep for a while"));
    const request = await observer.waitFor("request.opened");
    await session.interrupt();
    await turn;
    await session.stop();
    expect(observer.events.find((event) => event.type === "request.cancelled")?.data).toMatchObject(
      {
        reason: "run-ended",
        requestId: request.data.request.id,
      },
    );
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
    expect(observer.events.map((event) => event.type)).not.toContain("run.completed");
    await fixture.adapter.close();
  });

  it("refuses a response that does not match the pending Request", async () => {
    const fixture = await setup({ accessMode: "approval-required", scenario: "hook-shell" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Run two commands"));
    const request = await observer.waitFor("request.opened");
    await expect(
      session.resolveRequest(request.data.request.id, { kind: "choice", optionId: "allow-always" }),
    ).rejects.toThrow(/does not match/u);
    await session.resolveRequest(request.data.request.id, {
      kind: "choice",
      optionId: "allow-once",
    });
    await session.interrupt();
    await turn;
    await session.stop();
    await fixture.adapter.close();
  });
});

describe("Cursor interruption and lifetime", () => {
  it("interrupts the turn and ends it exactly once", async () => {
    const fixture = await setup({ scenario: "slow" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Sleep for a while"));
    await observer.waitFor("run.started");
    await session.interrupt();
    await turn;
    await session.stop();
    const terminal = observer.events.filter((event) =>
      ["run.completed", "run.failed", "run.interrupted"].includes(event.type),
    );
    expect(terminal.map((event) => event.type)).toEqual(["run.interrupted"]);
    await fixture.adapter.close();
  });

  it("escalates to SIGKILL when the CLI ignores SIGINT, without waiting forever", async () => {
    const fixture = await setup({ config: { shutdownGraceMs: 100 }, scenario: "ignore-sigint" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Work forever"));
    await observer.waitFor("run.started");
    const pid = (await fixture.invocations()).find((one) => one.argv[0] === "-p")?.pid;
    expect(pid).toBeDefined();
    await session.interrupt();
    // The escalation is awaited, so by the time `interrupt` resolves the
    // process is really gone and `execute` is observing a real exit.
    expect(processExists(pid ?? 0)).toBe(false);
    await turn;
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
    await session.stop();
    await fixture.adapter.close();
  });

  it("does not hold the grace timer open when the CLI stops on SIGINT", async () => {
    // A grace long enough that a timer left running would outlive the test.
    const fixture = await setup({ config: { shutdownGraceMs: 60_000 }, scenario: "slow" });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Sleep for a while"));
    await observer.waitFor("run.started");
    const started = Date.now();
    await session.interrupt();
    await turn;
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(observer.events.map((event) => event.type)).toContain("run.interrupted");
    await session.stop();
    await fixture.adapter.close();
  });

  it("terminates a CLI that ignores SIGTERM when the session stops", async () => {
    const fixture = await setup({ scenario: "hang", config: { shutdownGraceMs: 50 } });
    const session = await fixture.adapter.startSession(fixture.context);
    const observer = observe(session.events);
    const turn = session.execute(fixture.turn("Hang forever"));
    await waitFor(async () => (await fixture.invocations()).some((one) => one.argv[0] === "-p"));
    await session.stop();
    await turn;
    const pids = (await fixture.invocations())
      .filter((invocation) => invocation.argv[0] === "-p")
      .map((invocation) => invocation.pid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      if (pid) await waitForProcessExit(pid);
      if (pid) expect(processExists(pid)).toBe(false);
    }
    // A Run torn down with its session still ends on exactly one terminal event.
    await observer.waitFor("run.interrupted");
    expect(observer.events.filter((event) => event.type === "run.interrupted")).toHaveLength(1);
    await fixture.adapter.close();
  });

  it("refuses a second live session for one conversation and one for a missing transcript", async () => {
    const fixture = await setup({});
    await seedTranscript(fixture);
    const session = await fixture.adapter.resumeSession(fixture.reference, fixture.context);
    await expect(fixture.adapter.resumeSession(fixture.reference, fixture.context)).rejects.toThrow(
      /already active/u,
    );
    await expect(
      fixture.adapter.resumeSession("99999999-0000-0000-0000-000000000000", fixture.context),
    ).rejects.toThrow(/no transcript/u);
    await session.stop();
    await fixture.adapter.close();
  });

  it.each(["empty-directory", "empty-file"] as const)(
    "refuses to resume a conversation whose transcript is %s",
    async (shape) => {
      const fixture = await setup({});
      const directory = cursorTranscriptDirectory(
        fixture.context.environment,
        fixture.context.workspacePath,
        fixture.reference,
      );
      await mkdir(directory, { recursive: true });
      // Cursor creates the directory around a conversation it is about to
      // write, so neither of these is a conversation that can be resumed.
      if (shape === "empty-file")
        await writeFile(join(directory, `${fixture.reference}.jsonl`), "");
      await expect(
        fixture.adapter.resumeSession(fixture.reference, fixture.context),
      ).rejects.toMatchObject({ code: "not_found" });
      await fixture.adapter.close();
    },
  );

  it("derives the transcript directory the way the CLI does", () => {
    expect(cursorWorkspaceSlug("/private/tmp/lab/repo")).toBe("private-tmp-lab-repo");
    expect(cursorTranscriptDirectory({ CURSOR_DATA_DIR: "/data/cursor" }, "/w/s", "chat-1")).toBe(
      "/data/cursor/projects/w-s/agent-transcripts/chat-1",
    );
  });

  it("refuses a fresh session on a Thread that already has durable history", async () => {
    const fixture = await setup({});
    await expect(
      fixture.adapter.startSession({
        ...fixture.context,
        historyWindow: { byteCount: 10, hasEarlier: true, itemCount: 1 },
      }),
    ).rejects.toThrow(/beginning of a Thread/u);
    await fixture.adapter.close();
  });
});

interface SetupOptions {
  readonly accessMode?: HarnessSessionContext["accessMode"];
  readonly config?: Record<string, unknown>;
  readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
  readonly machineAccessNotice?: string;
  readonly modelSelection?: Record<string, unknown>;
  readonly scenario?: string;
  readonly skills?: readonly { readonly description: string; readonly name: string }[];
}

interface Invocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly environment: Record<string, string>;
  readonly pid?: number;
}

interface Fixture {
  readonly adapter: HarnessAdapter;
  readonly context: HarnessSessionContext;
  readonly reference: string;
  invocations(): Promise<Invocation[]>;
  prompts(): Promise<string[]>;
  turn(text: string): HarnessRunInput;
}

async function setup(options: SetupOptions): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "oscur-"));
  temporaryDirectories.push(directory);
  const capturePath = join(directory, "capture.jsonl");
  const environment = {
    CURSOR_DATA_DIR: join(directory, "cursor-data"),
    FAKE_CURSOR_CAPTURE_PATH: capturePath,
    FAKE_CURSOR_SCENARIO: options.scenario ?? "happy",
    PATH: process.env.PATH ?? "",
  };
  const driver = new CursorHarnessDriver({
    executable: fakeAgent,
    nodeExecutable: process.execPath,
  });
  const harnessInstanceId = createId("harnessInstance") as HarnessInstanceId;
  const adapter = await driver.create({
    config: options.config ?? {},
    instanceId: harnessInstanceId,
    sourceId: "cursor",
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
    accessMode: options.accessMode ?? "full-access",
    agentTools: {
      capabilityProfileId: "main",
      token: "test-agent-tools-token",
      url: "https://host.example/internal/v1/mcp",
    },
    environment,
    environmentId: createId("environment"),
    harnessInstanceId,
    history: [],
    historyWindow: { byteCount: 0, hasEarlier: false, itemCount: 0 },
    instructions: "Follow the workspace instructions.",
    integrationTools: {
      token: "test-integration-tools-token",
      url: "https://host.example/internal/v1/integration-mcp",
    },
    machineAccessNotice: options.machineAccessNotice ?? noComputersNotice,
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    modelSelection: ModelSelectionSchema.parse(
      options.modelSelection ?? { modelId: "composer-2.5", options: {}, providerId: "cursor" },
    ),
    platformGuide: "Opensteer platform guide.",
    providerState: testProviderState(directory),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    skills: skills.length > 0 ? { skills } : undefined,
    threadId: createId("thread"),
    // The approval socket lives here, and a Unix socket address is ~104 bytes.
    threadStateDirectory: join(directory, "t"),
    workspaceId: createId("workspace"),
    workspacePath,
    wrapProcessLaunch: (launch) => launch,
    writableRoots: [workspacePath],
  };
  await mkdir(context.threadStateDirectory, { recursive: true });
  return {
    adapter,
    context,
    reference: "11111111-2222-3333-4444-555555555555",
    async invocations() {
      return (await readCapture(capturePath)).map((entry) => entry);
    },
    async prompts() {
      const lines = await readCaptureLines(capturePath);
      return lines.flatMap((line) =>
        typeof line.fakeCursorPrompt === "string" ? [line.fakeCursorPrompt] : [],
      );
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

/** The transcript `--resume` needs, in the exact place the CLI writes it. */
async function seedTranscript(fixture: Fixture): Promise<void> {
  const directory = cursorTranscriptDirectory(
    fixture.context.environment,
    fixture.context.workspacePath,
    fixture.reference,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${fixture.reference}.jsonl`), "{}\n");
}

async function inspect(options: {
  readonly executable?: string;
  readonly runtimeBoundary?: HarnessSessionContext["runtimeBoundary"];
  readonly scenario?: string;
  readonly version?: string;
}): Promise<HarnessInspectionResult | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "oscur-inspect-"));
  temporaryDirectories.push(directory);
  return new CursorHarnessDriver({
    executable: options.executable ?? fakeAgent,
    nodeExecutable: process.execPath,
  }).inspect?.({
    config: {},
    environment: {
      FAKE_CURSOR_SCENARIO: options.scenario ?? "happy",
      PATH: process.env.PATH ?? "",
      ...(options.version ? { FAKE_CURSOR_VERSION: options.version } : {}),
    },
    providerState: testProviderState(directory),
    runtimeBoundary: options.runtimeBoundary ?? nativeUserHarnessRuntimeBoundary,
    signal: new AbortController().signal,
    sourceId: "cursor",
    workingDirectory: directory,
  });
}

async function readCapture(path: string): Promise<Invocation[]> {
  const lines = await readCaptureLines(path);
  return lines.flatMap((line) =>
    line.fakeCursorInvocation ? [line.fakeCursorInvocation as unknown as Invocation] : [],
  );
}

async function readCaptureLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The socket path out of a hook command: `'<node>' '<program>' '<socket>'`. */
function hookSocketPath(command: string): string {
  const quoted = [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? "");
  return quoted.at(-1) ?? "";
}

function testProviderState(directory: string) {
  return {
    continuationKey: `cursor:${directory}`,
    kind: "ambient" as const,
    privateStateRoot: join(directory, "state"),
    providerHomeDirectory: undefined,
    store: { directory: join(directory, "state", "cursor"), id: "store-fixture" },
  };
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
    async waitFor<T extends HarnessEvent["type"]>(type: T) {
      return waitForOccurrence(observer, type, 1);
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const matches = observer.events.filter(
      (candidate): candidate is Extract<HarnessEvent, { type: T }> => candidate.type === type,
    );
    const event = matches[count - 1];
    if (event) return event;
    if (observer.error) throw observer.error;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for ${type} #${count}; saw ${observer.events.map((event) => event.type).join(", ")}`,
  );
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a condition");
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

export type { HarnessSession };

describe("cursor Thread naming", () => {
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
        expect.arrayContaining(["--output-format", "text", "--plugin-dir"]),
      );
      expect(launch.environment.CURSOR_DATA_DIR).toContain("title-");
      expect(launch.environment.HOME).toContain("title-");

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
