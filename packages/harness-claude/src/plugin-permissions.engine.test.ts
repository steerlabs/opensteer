import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createId, ModelSelectionSchema } from "@opensteer/core";
import {
  meetsMinimumVersion,
  nativeUserHarnessRuntimeBoundary,
  type HarnessEvent,
  type HarnessSessionContext,
} from "@opensteer/harness";
import { expect, it } from "vitest";
import { ClaudeHarnessDriver } from "./claude-driver.js";
import { MINIMUM_CLAUDE_CODE_VERSION } from "./config.js";
import { resolveClaudeExecutable } from "./executable.js";

it.each([
  { accessMode: "approval-required", fixture: true },
  { accessMode: "full-access", fixture: true },
  ...(["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(
    (accessMode) => ({ accessMode, fixture: false }),
  ),
] as const)(
  "installed Claude permissions in $accessMode (fixture: $fixture)",
  async ({ accessMode, fixture }) => {
    const executable = resolveClaudeExecutable(process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude");
    if (!executable) throw new Error("Claude is not installed");
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
    const release = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec(version)?.[1];
    expect(
      release !== undefined && meetsMinimumVersion(release, MINIMUM_CLAUDE_CODE_VERSION),
      `Claude ${version} is older than ${MINIMUM_CLAUDE_CODE_VERSION}`,
    ).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-permissions-"));
    const plugin = join(directory, "fixture");
    const reason = "Opensteer fixture plugin asks before harmless marker creation";
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(plugin, "hooks"));
    await writeFile(
      join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "permission-fixture", version: "1.0.0" }),
    );
    const askScript = join(plugin, "hooks", "ask.cjs");
    await writeFile(
      join(plugin, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `"${process.execPath}" "${askScript}"` }],
            },
          ],
        },
      }),
    );
    await writeFile(
      askScript,
      `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(directory, "hook-ran"))}, "yes");
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "ask",
  permissionDecisionReason: ${JSON.stringify(reason)}
} }));
`,
    );
    const driver = new ClaudeHarnessDriver({
      executable,
      // Exercise the real driver callback and native plugin loader. This seam
      // explicitly enables only the fixture’s hooks in per-Run settings; ordinary
      // permission modes remain native. The fixture replaces the SDK Bash ask
      // so its own reason can be observed; no computer policy is changed.
      sdk: {
        query: (parameters) => {
          const handle = query({
            ...parameters,
            options: {
              ...parameters.options,
              ...(fixture ? { hooks: {} } : {}),
              managedSettings: {
                ...parameters.options.managedSettings,
                ...(fixture ? { disableAllHooks: false } : {}),
              },
              plugins: [
                ...(parameters.options.plugins ?? []),
                ...(fixture
                  ? [{ type: "local" as const, path: plugin, skipMcpDiscovery: true }]
                  : []),
              ],
            },
          });
          return {
            async *[Symbol.asyncIterator]() {
              for await (const message of handle) {
                if (fixture && message.type === "system" && message.subtype === "init")
                  expect(message.plugins.some((entry) => entry.name === "permission-fixture")).toBe(
                    true,
                  );
                yield message;
              }
            },
            close: () => handle.close(),
            interrupt: () => handle.interrupt(),
            stopTask: (taskId) => handle.stopTask(taskId),
          };
        },
      },
    });
    const instanceId = createId("harnessInstance");
    const adapter = await driver.create({
      config: { maxTurns: 4 },
      instanceId,
      sourceId: "anthropic",
    });
    const threadId = createId("thread");
    const state = join(directory, "state");
    const threadStateDirectory = join(state, threadId);
    await mkdir(threadStateDirectory, { recursive: true });
    const context: HarnessSessionContext = {
      accessMode,
      agentTools: {
        tools: [],
        toolsRevision: "fixture",
        instructions: "",
        skills: [],
        token: "fixture",
        url: "http://127.0.0.1:1/internal/v1/mcp",
      },
      environment: process.env as Record<string, string>,
      environmentId: createId("environment"),
      harnessInstanceId: instanceId,
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      instructions: "",
      platformGuide: "",
      machineAccessNotice: "No other computers are reachable.",
      machineAccessPlatform: undefined,
      machineAccessRelaySocket: undefined,
      providerState: {
        continuationKey: directory,
        providerHomeDirectory: undefined,
        kind: "ambient",
        privateStateRoot: state,
        store: { directory: join(state, "store"), id: "fixture" },
      },
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        providerId: "anthropic",
        options: {},
      }),
      signal: AbortSignal.timeout(120_000),
      skills: { skills: [] },
      threadId,
      threadStateDirectory,
      workspacePath: directory,
      writableRoots: [directory],
      wrapProcessLaunch: (launch) => launch,
    };
    const events: HarnessEvent[] = [];
    const session = await adapter.startSession(context);
    const observing = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "request.opened") {
          await session.resolveRequest(event.data.request.id, {
            kind: "choice",
            optionId: "reject",
          });
        }
      }
    })();
    try {
      await session.execute({
        environment: {},
        inputs: [
          {
            author: { kind: "human", displayName: "Qualification", principalId: "fixture" },
            content: [
              {
                type: "text",
                text: fixture
                  ? "Run exactly this Bash command once: printf FIXTURE > marker.txt . Do not use other tools. If denied, stop and report the denial; never retry."
                  : "Perform both actions in order: (1) call Bash with exactly printf PROBE (2) use the native Write tool to create marker.txt containing FIXTURE. If Bash is denied, still attempt Write. Never retry a denied tool or use an alternative tool.",
              },
            ],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
        ],
        context: {
          assignment: null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        requestedBy: createId("user"),
        runId: createId("run"),
        signal: context.signal,
      });
      await session.stop();
      await observing;
      const requests = events.filter((event) => event.type === "request.opened");
      const evidence = join(
        tmpdir(),
        `opensteer-claude-permissions-${accessMode}-${fixture}-${createId("run")}.json`,
      );
      await writeFile(
        evidence,
        JSON.stringify(
          {
            version,
            accessMode,
            fixture,
            head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            sources: await Promise.all(
              ["claude-driver.ts", "plugin-permissions.engine.test.ts"].map(async (file) => ({
                file,
                sha256: createHash("sha256")
                  .update(await readFile(new URL(file, import.meta.url)))
                  .digest("hex"),
              })),
            ),
            requests,
            terminal: events.filter(
              (event) => event.type === "run.failed" || event.type === "run.completed",
            ),
          },
          null,
          2,
        ),
      );
      console.log(
        `Claude ${version}, ${accessMode}, fixture=${fixture}: ${requests.length} Requests; evidence: ${evidence}`,
      );
      expect(events.some((event) => event.type === "run.failed")).toBe(false);
      if (fixture) {
        expect(await readFile(join(directory, "hook-ran"), "utf8")).toBe("yes");
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.some((event) =>
            JSON.stringify(event.data.request.presentation).includes(reason),
          ),
        ).toBe(true);
        await expect(readFile(join(directory, "marker.txt"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        const supervised = accessMode === "approval-required" || accessMode === "auto-accept-edits";
        const shellRequests = requests.filter(
          (event) => event.data.request.presentation.title === "Bash",
        );
        expect(shellRequests.length).toBe(supervised ? 1 : 0);
        expect(requests.length).toBe(accessMode === "approval-required" ? 2 : supervised ? 1 : 0);
        if (accessMode === "approval-required") {
          await expect(readFile(join(directory, "marker.txt"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await readFile(join(directory, "marker.txt"), "utf8")).toContain("FIXTURE");
        }
      }
    } finally {
      await adapter.close();
      await observing;
      await rm(directory, { recursive: true, force: true });
    }
  },
  150_000,
);
