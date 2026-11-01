import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createId, ModelSelectionSchema, type ModelSelection } from "@opensteer/core";
import { platformGuideForRun } from "@opensteer/agent-tools";
import {
  ClaudeHarnessDriver,
  claudeAgentSdk,
  inspectClaudeExecutable,
} from "@opensteer/harness-claude";
import { CodexHarnessDriver, packagedCodexExecutable } from "@opensteer/harness-codex";
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessModelDescriptor,
  HarnessSession,
  HarnessSessionContext,
} from "@opensteer/harness";
import {
  loadAgentSkillBundle,
  planAgentSkills,
} from "../../apps/runner/src/skills/agent-skills.js";
import { resolveSkillPlan } from "../../apps/runner/src/skills/skill-plan.js";
import { discoverWorkspaceSkills } from "../../apps/runner/src/skills/workspace-skills.js";
import type { EvalCase } from "./cases.js";
import type { startFakeHost } from "./host.js";
import { isolate } from "./isolation.js";
import { fingerprint } from "./report.js";

// Adding an engine is one factory, with no replay prompt or native-tool copy.
export const drivers: Record<"claude" | "codex", () => HarnessDriver> = {
  claude: () =>
    new ClaudeHarnessDriver({
      executable: process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude",
      sdk: claudeAgentSdk,
      inspectExecutable: inspectClaudeExecutable,
    }),
  codex: () =>
    new CodexHarnessDriver({ launch: { executable: packagedCodexExecutable(), arguments: [] } }),
};
export type Engine = keyof typeof drivers;
export async function prepareEngine(
  root: string,
  engine: Engine,
  signal: AbortSignal,
  models?: readonly HarnessModelDescriptor[],
) {
  const isolation = await isolate(root, engine, signal);
  try {
    const driver = drivers[engine]();
    const instanceId = createId("harnessInstance");
    if (models) return { ...isolation, driver, instanceId, models };
    const inspection = await driver.inspect?.({
      config: {},
      environment: isolation.environment,
      providerState: isolation.providerState,
      runtimeBoundary: { kind: "isolated-service" },
      sourceId: driver.sources[0]!.sourceId,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      workingDirectory: isolation.workspace,
    });
    if (!inspection || inspection.status !== "ready")
      throw new Error(`Engine ${engine}: ${JSON.stringify(inspection)}`);
    return { ...isolation, driver, instanceId, models: inspection.models };
  } catch (cause) {
    await isolation.close();
    throw cause;
  }
}
export type PreparedEngine = Awaited<ReturnType<typeof prepareEngine>>;
export async function runEngine(input: {
  prepared: PreparedEngine;
  testCase: EvalCase;
  host: Awaited<ReturnType<typeof startFakeHost>>;
  selection: ModelSelection;
  checkout: string;
  signal: AbortSignal;
  onTurnStart: () => void;
  onEvent: (event: HarnessEvent) => Promise<void>;
}) {
  const { prepared: p, testCase: c, host, signal } = input;
  const bundlePath = join(p.privateRoot, "bundled-skills");
  await cp(join(input.checkout, "apps/runner/agent-skills"), bundlePath, { recursive: true });
  const bundle = await loadAgentSkillBundle(bundlePath);
  const selected = await Promise.all(
    planAgentSkills(bundle, c.profile).map(async ({ name, path }) => {
      const destination = join(p.workspace, ".eval-skills", name);
      await cp(path, destination, { recursive: true });
      return { name, path: destination };
    }),
  );
  const workspaceSkills = await discoverWorkspaceSkills(p.workspace);
  const skills = resolveSkillPlan({
    bundled: selected,
    integration: [],
    workspace: workspaceSkills.skills,
  });
  const instructions = c.fixtures["AGENTS.md"];
  const guide = platformGuideForRun({ capabilityProfileId: c.profile, role: c.role });
  const treatment = {
    prompt: fingerprint({
      guide,
      instructions,
      skills: await Promise.all(
        (skills?.skills ?? []).map(async (skill) => ({
          name: skill.name,
          body: await readFile(join(skill.path, "SKILL.md"), "utf8"),
        })),
      ),
    }),
    schema: fingerprint(
      [...host.endpoints].map(([name, endpoint]) => ({
        name,
        tools: endpoint.tools,
        instructions: endpoint.instructions,
      })),
    ),
  };
  const threadStateDirectory = join(p.privateRoot, "thread");
  await mkdir(threadStateDirectory, { recursive: true });
  const context: HarnessSessionContext = {
    accessMode: "full-access",
    agentTools: {
      capabilityProfileId: c.profile,
      token: host.secret,
      url: new URL("/agent", host.url).href,
    },
    integrationTools: { token: host.secret, url: new URL("/integrations", host.url).href },
    environmentId: host.scope.environmentId,
    environment: p.environment,
    harnessInstanceId: p.instanceId,
    history: [],
    historyWindow: { hasEarlier: false, byteCount: 0, itemCount: 0 },
    instructions,
    platformGuide: guide,
    modelSelection: ModelSelectionSchema.parse(input.selection),
    providerState: p.providerState,
    runtimeBoundary: { kind: "isolated-service" },
    machineAccessNotice: "No other computers are available to this Run.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    threadId: host.scope.threadId,
    workspaceId: host.scope.workspaceId,
    threadStateDirectory,
    skills,
    signal,
    workspacePath: p.workspace,
    writableRoots: [p.workspace],
    wrapProcessLaunch: p.wrapProcessLaunch,
  };
  const adapter = await p.driver.create({
    config: {},
    instanceId: p.instanceId,
    sourceId: p.driver.sources[0]!.sourceId,
  });
  let session: HarnessSession | undefined;
  let events: Promise<void> | undefined;
  let finalText = "";
  let turnFinished: (() => void) | undefined;
  let eventFailure: unknown;
  let failure: string | undefined;
  try {
    session = await adapter.startSession(context);
    events = (async () => {
      for await (const event of session!.events) {
        await input.onEvent(event);
        if (event.type === "assistant.message")
          finalText = event.data.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
        if (event.type === "run.failed" || event.type === "run.interrupted")
          failure = JSON.stringify(event.data);
        if (event.type === "request.opened") {
          failure = "Native tool requested approval; eval never grants new authority";
          await session!.interrupt();
        }
        if (["run.completed", "run.failed", "run.interrupted"].includes(event.type))
          turnFinished?.();
      }
      turnFinished?.();
    })().catch((cause: unknown) => {
      eventFailure = cause;
      turnFinished?.();
    });
    // Consume real preceding turns in the same native session; only the last
    // turn's reply and calls are graded. All turns remain in the transcript.
    for (const turn of c.turns) {
      input.onTurnStart();
      finalText = "";
      failure = undefined;
      host.calls.splice(0);
      const finished = new Promise<void>((resolve) => {
        turnFinished = resolve;
      });
      await session.execute({
        context: {
          assignment:
            c.profile === "delegated"
              ? {
                  id: createId("delegation"),
                  objective: c.turns[0]!,
                  origin: "run",
                  parentThreadId: createId("thread"),
                }
              : null,
          requesterTimeZone: null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment: p.environment,
        inputs: [
          {
            author: { kind: "human", displayName: "Eval user", principalId: "eval" },
            content: [{ type: "text", text: turn }],
            createdAt: new Date().toISOString(),
            kind: "input",
            messageId: createId("message"),
          },
        ],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        runId: createId("run"),
        requestedBy: host.scope.requestedBy,
        signal,
      });
      await finished;
      if (eventFailure) throw eventFailure;
      if (failure) throw new Error(failure);
    }
    return { finalText, treatment };
  } finally {
    try {
      await session?.stop();
    } finally {
      try {
        await adapter.close();
      } finally {
        await events;
      }
    }
  }
}
