// Adapted from T3 Code (MIT): workflow member lifecycle and transcript projection.
import type { ExecutionNodeOutcome } from "@opensteer/core";
import type { SubagentNodes } from "@opensteer/harness";
import {
  mergeClaudeWorkflowProgress,
  type ClaudeWorkflow,
  type ClaudeWorkflowRunHandles,
} from "./workflow-progress.js";
import {
  initialWorkflowTranscriptCursor,
  mergeWorkflowAgentMetadata,
  readWorkflowAgentTranscript,
  type WorkflowAgentMetadata,
  type WorkflowTranscriptCursor,
} from "./workflow-transcript.js";

interface Member {
  readonly key: string;
  readonly attempt: number;
  agentId: string | undefined;
  cursor: WorkflowTranscriptCursor;
  metadata: WorkflowAgentMetadata;
  settled: boolean;
}
interface Workflow {
  progress: ClaudeWorkflow;
  readonly members: Map<number, Member>;
}

export class ClaudeWorkflowNodes {
  readonly #workflows = new Map<string, Workflow>();
  readonly #nodes: SubagentNodes;
  readonly #project: (key: string, line: Record<string, unknown>) => void;
  readonly #active: () => boolean;
  readonly #register: (agentId: string, key: string) => Promise<void>;
  sessionRoot: string | undefined;

  constructor(
    nodes: SubagentNodes,
    project: (key: string, line: Record<string, unknown>) => void,
    active: () => boolean,
    register: (agentId: string, key: string) => Promise<void>,
  ) {
    this.#nodes = nodes;
    this.#project = project;
    this.#active = active;
    this.#register = register;
  }

  has(key: string): boolean {
    return this.#workflows.has(key);
  }

  async update(
    key: string,
    message: unknown,
    options: { readonly name?: string; readonly handles?: ClaudeWorkflowRunHandles } = {},
  ): Promise<void> {
    const previous = this.#workflows.get(key);
    const progress = mergeClaudeWorkflowProgress({
      previous: previous?.progress,
      message,
      name: options.name,
      runHandles: options.handles,
    });
    if (!progress || !this.#active()) return;
    const workflow = previous ?? { progress, members: new Map<number, Member>() };
    workflow.progress = progress;
    this.#workflows.set(key, workflow);
    const phases = new Map(progress.phases.map((phase) => [phase.index, phase.title]));
    for (const member of progress.agents)
      if (member.phaseIndex !== undefined && member.phaseTitle && !phases.has(member.phaseIndex))
        phases.set(member.phaseIndex, member.phaseTitle);
    for (const member of progress.agents)
      if (member.phaseIndex !== undefined && !phases.has(member.phaseIndex))
        phases.set(member.phaseIndex, `Phase ${member.phaseIndex}`);
    const phaseIndices = [...phases.keys()].sort((left, right) => left - right).slice(0, 64);
    const phaseIndexFor = (index: number | undefined) =>
      index === undefined ? -1 : phaseIndices.indexOf(index);
    this.#nodes.update(key, {
      title: progress.name ?? null,
      phases: phaseIndices.map((index) => phases.get(index)!),
    });
    for (const agent of progress.agents) {
      if (!this.#active()) return;
      let member = workflow.members.get(agent.index);
      const attempt = agent.attempt ?? member?.attempt ?? 1;
      if (!member || attempt > member.attempt) {
        if (member && !member.settled) this.#nodes.complete(member.key, "interrupted");
        member = {
          key: `${key}:member:${agent.index}:attempt:${attempt}`,
          attempt,
          agentId: agent.agentId,
          cursor: initialWorkflowTranscriptCursor,
          metadata: {},
          settled: false,
        };
        workflow.members.set(agent.index, member);
        this.#nodes.open(member.key, {
          nativeRef: member.key,
          sessionRef: agent.agentId ?? null,
          parentKey: key,
          ...(phaseIndexFor(agent.phaseIndex) >= 0
            ? { phaseIndex: phaseIndexFor(agent.phaseIndex) }
            : {}),
          title: agent.label,
          prompt: agent.prompt ?? null,
          model: agent.model ?? null,
        });
      }
      if (member.settled) continue;
      if (agent.agentId) await this.#register(agent.agentId, member.key);
      if (member.agentId !== agent.agentId) {
        member.agentId = agent.agentId;
        member.cursor = initialWorkflowTranscriptCursor;
        member.metadata = {};
      }
      this.#nodes.update(member.key, {
        title: agent.label,
        prompt: agent.prompt ?? null,
        model: agent.model ?? null,
        parentKey: key,
        ...(phaseIndexFor(agent.phaseIndex) >= 0
          ? { phaseIndex: phaseIndexFor(agent.phaseIndex) }
          : {}),
      });
      if (agent.agentId && progress.runHandles?.transcriptDir && this.sessionRoot) {
        let truncated: boolean;
        do {
          const read = await readWorkflowAgentTranscript({
            sessionRoot: this.sessionRoot,
            transcriptDir: progress.runHandles.transcriptDir,
            agentId: agent.agentId,
            cursor: member.cursor,
          });
          if (!this.#active()) return;
          if (!read) break;
          const advanced = read.cursor.offset !== member.cursor.offset;
          member.cursor = read.cursor;
          member.metadata = mergeWorkflowAgentMetadata(read.lines, member.metadata);
          this.#nodes.update(member.key, { effort: member.metadata.effort ?? null });
          for (const line of read.lines) {
            this.#project(member.key, line);
          }
          truncated = read.truncated && advanced;
        } while (truncated);
      }
      if (agent.state === "completed" || agent.state === "failed") {
        this.#nodes.complete(member.key, agent.state, { result: agent.result ?? null });
        member.settled = true;
      } else if (agent.state === "queued") this.#nodes.progress(member.key, "Queued");
    }
  }

  complete(key: string, outcome: ExecutionNodeOutcome, result?: string): void {
    const workflow = this.#workflows.get(key);
    if (!workflow) return;
    for (const member of workflow.members.values()) {
      if (!member.settled) {
        this.#nodes.complete(member.key, outcome);
        member.settled = true;
      }
    }
    this.#nodes.complete(key, outcome, { result: result ?? null });
  }
}
