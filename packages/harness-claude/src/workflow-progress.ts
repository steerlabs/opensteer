// Adapted from T3 Code (MIT): Claude workflow progress and retry merging.
import { isRecord } from "@opensteer/shared/isRecord";

export interface ClaudeWorkflowPhase {
  readonly index: number;
  readonly title: string;
}
export interface ClaudeWorkflowRunHandles {
  readonly runId?: string;
  readonly transcriptDir?: string;
  readonly scriptPath?: string;
}
export interface ClaudeWorkflowAgent {
  readonly index: number;
  readonly label: string;
  readonly state: "queued" | "running" | "completed" | "failed";
  readonly agentId?: string;
  readonly phaseIndex?: number;
  readonly phaseTitle?: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly totalTokens?: number;
  readonly toolCalls?: number;
  readonly durationMs?: number;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly prompt?: string;
  readonly result?: string;
}
export interface ClaudeWorkflow {
  readonly name?: string;
  readonly runHandles?: ClaudeWorkflowRunHandles;
  readonly phases: readonly ClaudeWorkflowPhase[];
  readonly agents: readonly ClaudeWorkflowAgent[];
  readonly totalTokens?: number;
  readonly toolCalls?: number;
  readonly durationMs?: number;
}
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";

export function hasClaudeWorkflowSnapshot(
  message: unknown,
): message is { readonly workflow_progress: ReadonlyArray<unknown> } {
  const entries = field(message, "workflow_progress");
  return Array.isArray(entries) && entries.length > 0;
}

const AGENT_STATES: Record<string, ClaudeWorkflowAgent["state"] | undefined> = {
  queued: "queued",
  start: "running",
  done: "completed",
  error: "failed",
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const milliseconds = count(value);
  return milliseconds !== undefined && milliseconds <= 8_640_000_000_000_000
    ? milliseconds
    : undefined;
}

function preview(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function parsePhase(entry: unknown): ClaudeWorkflowPhase | null {
  const index = count(field(entry, "index"));
  const title = text(field(entry, "title"));
  return index === undefined || title === undefined ? null : { index, title };
}

function parseAgent(entry: unknown): ClaudeWorkflowAgent | null {
  const index = count(field(entry, "index"));
  const label = text(field(entry, "label"));
  if (index === undefined || label === undefined) return null;
  const reportedState = text(field(entry, "state")) ?? "";
  const state = Object.hasOwn(AGENT_STATES, reportedState)
    ? (AGENT_STATES[reportedState] ?? "running")
    : "running";
  return {
    index,
    label,
    state,
    ...optional("agentId", text(field(entry, "agentId"))),
    ...optional("phaseIndex", count(field(entry, "phaseIndex"))),
    ...optional("phaseTitle", text(field(entry, "phaseTitle"))),
    ...optional("model", text(field(entry, "model"))),
    ...optional("attempt", count(field(entry, "attempt"))),
    ...optional("totalTokens", count(field(entry, "tokens"))),
    ...optional("toolCalls", count(field(entry, "toolCalls"))),
    ...optional("durationMs", count(field(entry, "durationMs"))),
    ...optional("queuedAt", timestamp(field(entry, "queuedAt"))),
    ...optional("startedAt", timestamp(field(entry, "startedAt"))),
    // Execution duration excludes startup waits; terminal progress carries the end instant.
    ...optional(
      "completedAt",
      state === "completed" || state === "failed"
        ? timestamp(field(entry, "lastProgressAt"))
        : undefined,
    ),
    ...optional("prompt", preview(field(entry, "promptPreview"))),
    ...optional("result", preview(field(entry, "resultPreview"))),
  };
}

/** The background-launch ACK is the only frame carrying the run's filesystem handles. */
export function parseClaudeWorkflowRunHandles(
  toolUseResult: unknown,
): ClaudeWorkflowRunHandles | undefined {
  if (text(field(toolUseResult, "taskType")) !== CLAUDE_WORKFLOW_TASK_TYPE) return undefined;
  const handles = {
    ...optional("runId", text(field(toolUseResult, "runId"))),
    ...optional("transcriptDir", text(field(toolUseResult, "transcriptDir"))),
    ...optional("scriptPath", text(field(toolUseResult, "scriptPath"))),
  };
  return Object.keys(handles).length === 0 ? undefined : handles;
}

function parseClaudeWorkflowProgress(message: unknown): {
  readonly phases: ReadonlyArray<ClaudeWorkflowPhase>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgent>;
} | null {
  if (!hasClaudeWorkflowSnapshot(message)) return null;
  const phases: ClaudeWorkflowPhase[] = [];
  const agents: ClaudeWorkflowAgent[] = [];
  for (const entry of message.workflow_progress) {
    const type = text(field(entry, "type"));
    if (type === "workflow_phase") {
      const phase = parsePhase(entry);
      if (phase !== null) phases.push(phase);
    } else if (type === "workflow_agent") {
      const agent = parseAgent(entry);
      if (agent !== null) agents.push(agent);
    }
  }
  return phases.length === 0 && agents.length === 0 ? null : { phases, agents };
}

/** Returns undefined without workflow evidence; progress frames omit task_type and ordinary subagents also emit usage. */
export function mergeClaudeWorkflowProgress(input: {
  readonly previous: ClaudeWorkflow | undefined;
  readonly name?: string | undefined;
  readonly runHandles?: ClaudeWorkflowRunHandles | undefined;
  readonly message: unknown;
}): ClaudeWorkflow | undefined {
  const { previous } = input;
  const snapshot = parseClaudeWorkflowProgress(input.message);
  if (
    previous === undefined &&
    input.name === undefined &&
    input.runHandles === undefined &&
    snapshot === null
  ) {
    return undefined;
  }
  const reported = field(input.message, "usage");
  const phasesByIndex = new Map(
    (previous?.phases ?? []).map((phase) => [phase.index, phase] as const),
  );
  for (const phase of snapshot?.phases ?? []) phasesByIndex.set(phase.index, phase);
  const agentsByIndex = new Map(
    (previous?.agents ?? []).map((agent) => [agent.index, agent] as const),
  );
  for (const agent of snapshot?.agents ?? []) {
    const prior = agentsByIndex.get(agent.index);
    const attempt = agent.attempt ?? prior?.attempt ?? 1;
    if (prior !== undefined && attempt < (prior.attempt ?? 1)) continue;
    const restarted = prior !== undefined && attempt > (prior.attempt ?? 1);
    const regressed =
      !restarted &&
      (((prior?.state === "completed" || prior?.state === "failed") &&
        agent.state !== prior.state) ||
        (prior?.state === "running" && agent.state === "queued"));
    agentsByIndex.set(
      agent.index,
      regressed
        ? { ...agent, ...prior }
        : {
            ...(restarted
              ? {
                  ...optional("phaseIndex", prior.phaseIndex),
                  ...optional("phaseTitle", prior.phaseTitle),
                }
              : prior),
            ...agent,
          },
    );
  }
  const runHandles =
    input.runHandles === undefined
      ? previous?.runHandles
      : { ...previous?.runHandles, ...input.runHandles };
  return {
    ...optional("name", input.name ?? previous?.name),
    ...optional("runHandles", runHandles),
    phases: Array.from(phasesByIndex.values()).sort((left, right) => left.index - right.index),
    agents: Array.from(agentsByIndex.values()).sort((left, right) => left.index - right.index),
    ...optional("totalTokens", count(field(reported, "total_tokens")) ?? previous?.totalTokens),
    ...optional("toolCalls", count(field(reported, "tool_uses")) ?? previous?.toolCalls),
    ...optional("durationMs", count(field(reported, "duration_ms")) ?? previous?.durationMs),
  };
}
