import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createId,
  harnessRuntimeExpectedVersion,
  ThreadIdSchema,
  ModelSelectionSchema,
  type ModelSelection,
} from "@opensteer/core";
import {
  appHostingGuide,
  opensteerAgentSkillsFor,
  platformGuideForRun,
  toolsFor,
} from "@opensteer/agent-tools";
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
import { discoverAgentHomeSkills } from "../../apps/runner/src/skills/agent-home-skills.js";
import { voiceGuide } from "../../apps/host/src/agents/voice-tools.js";
import { inputForCaseTurn, type EvalCase } from "./cases.js";
import type { startFakeHost } from "./host.js";
import { isolate } from "./isolation.js";
import { fingerprint } from "./report.js";

import { prepareBrowserHarness } from "./browser-harness.js";

const claudeExecutable = process.env.OPENSTEER_CLAUDE_EXECUTABLE ?? "claude";

// Adding an engine is one factory, with no replay prompt or native-tool copy.
export const drivers: Record<"claude" | "codex", () => HarnessDriver> = {
  claude: () =>
    new ClaudeHarnessDriver({
      executable: claudeExecutable,
      sdk: claudeAgentSdk,
      inspectExecutable: inspectClaudeExecutable,
    }),
  codex: () =>
    new CodexHarnessDriver({ launch: { executable: packagedCodexExecutable(), arguments: [] } }),
};
export type Engine = keyof typeof drivers;

/** Codex ships with Opensteer; Claude Code is the person's own install. */
export async function engineVersion(engine: Engine): Promise<string> {
  if (engine === "codex") return harnessRuntimeExpectedVersion("codex");
  const inspected = await inspectClaudeExecutable(claudeExecutable, process.env);
  if (inspected.status !== "available") throw new Error(inspected.detail);
  return inspected.version;
}
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
    planAgentSkills(bundle, c.caller === "run" ? opensteerAgentSkillsFor() : []).map(
      async (skill) => {
        const { fullName, path } = skill;
        const destination = join(p.workspace, ".eval-skills", fullName);
        await cp(path, destination, { recursive: true });
        return { ...skill, path: destination };
      },
    ),
  );
  const skills = await resolveSkillPlan({
    bundled: selected,
    integration: [],
    home: (await discoverAgentHomeSkills(p.workspace)).skills,
  });
  const instructions = c.fixtures["AGENTS.md"] ?? "";
  const tools = toolsFor({
    kind: c.caller,
    accessMode: "full-access",
    teamsAvailable: c.teamBound || c.knowledge,
    knowledge: c.knowledge,
  }).map(({ name }) => name);
  // Assembled as the Host plans it and the hosting Runner completes it.
  const guide =
    c.caller === "run"
      ? [
          platformGuideForRun({
            purpose: c.purpose,
            teamsAvailable: c.teamBound || c.knowledge,
            knowledge: c.knowledge,
          }) + (c.voice ? `\n\n${voiceGuide}` : ""),
          appHostingGuide({ platform: c.hostingPlatform, tools }),
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
  const treatment = {
    prompt: fingerprint({
      guide,
      instructions,
      skills: await Promise.all(
        (skills?.skills ?? []).map(async (skill) => ({
          name: skill.fullName,
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
  const browser = await prepareBrowserHarness(join(p.workspace, ".eval-browser"), c.browser);
  const context: HarnessSessionContext = {
    accessMode: "full-access",
    agentTools: {
      tools,
      toolsRevision: "eval-tools-v1",
      instructions: guide,
      skills: selected.map(({ fullName }) => fullName),
      token: host.secret,
      url: new URL("/agent", host.url).href,
    },
    environmentId: host.scope.environmentId,
    commandEnvironment: browser.commandEnvironment,
    environment: p.environment,
    harnessInstanceId: p.instanceId,
    history: [],
    historyWindow: { hasEarlier: false, byteCount: 0, itemCount: 0 },
    instructions,
    platformGuide: guide,
    modelSelection: ModelSelectionSchema.parse(input.selection),
    providerState: p.providerState,
    runtimeBoundary: { kind: "isolated-service" },
    machineAccessNotice: c.machineAccessNotice ?? "No other computers are available to this Run.",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
    threadId: host.scope.threadId,
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
  const assignmentId = createId("delegation");
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
      await browser.reset();
      const finished = new Promise<void>((resolve) => {
        turnFinished = resolve;
      });
      await session.execute({
        context: {
          assignment:
            c.caller === "run" && (c.assigned ?? c.profile === "delegated")
              ? {
                  id: assignmentId,
                  objective: inputForCaseTurn(c.turns[0]!)
                    .content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("\n"),
                  origin: "run",
                  parentThreadId: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001"),
                }
              : null,
          teamTurnContext: c.teamContext ?? null,
          requesterTimeZone: c.requesterTimeZone ?? null,
          threadState: { previousAssignment: null, previousRun: null },
        },
        environment: p.environment,
        inputs: [inputForCaseTurn(turn)],
        reports: { messages: [], omittedCount: 0, throughSequence: null },
        runId: createId("run"),
        requestedBy: host.scope.requestedBy,
        signal,
      });
      await finished;
      host.calls.push(...(await browser.calls()));
      host.calls.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
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
