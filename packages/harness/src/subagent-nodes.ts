import {
  createId,
  executionNodeMessageMaxLength,
  executionNodePhasesMax,
  executionNodePromptMaxBytes,
  executionNodeResultMaxBytes,
  liveNodeProgressMaxLength,
  surrogateSafeCut,
  type ExecutionNodeId,
  type ExecutionNodeKind,
  type ExecutionNodeOutcome,
  type RunUsage,
} from "@opensteer/core";
import type { HarnessEvent } from "./types.js";

/** How often one subagent's progress line may change on the wire. */
const progressIntervalMs = 1_000;

/** What an engine said about a subagent when it first saw it. */
export interface SubagentStart {
  /** A subagent unless named a background task, such as a shell left running. */
  readonly kind?: ExecutionNodeKind;
  /**
   * This invocation, as the engine names it; unique within the Run. Absent
   * while the engine has not named it — a question that arrives before the
   * call that spawned the child — and the node's own id stands for it, so a
   * resumed child seen the same way is never mistaken for its last invocation.
   */
  readonly nativeRef?: string;
  /** The child session a later invocation may resume. */
  readonly sessionRef?: string | null;
  readonly title?: string | null;
  readonly prompt?: string | null;
  readonly model?: string | null;
  /** How hard the engine was asked to think, in its own word for it. */
  readonly effort?: string | null;
  /** The tool call of the agent that started it. */
  readonly originCallId?: string | null;
  /** The key of the subagent or workflow that started this one, if not the Run's own agent. */
  readonly parentKey?: string | null;
  /** Which of its workflow's phases a member belongs to. */
  readonly phaseIndex?: number | null;
}

interface LiveNode {
  readonly nodeId: ExecutionNodeId;
  originCallId: string | null;
  parentNodeId: ExecutionNodeId | null;
  result: string | null;
  title: string;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  phaseIndex: number | null;
  phases: readonly string[];
  /** The progress line last sent, and when. */
  progress: string | null;
  progressAt: number;
  /** A newer line waiting for the interval to pass. */
  pendingProgress: string | null;
  progressTimer: ReturnType<typeof setTimeout> | undefined;
}

const defaultTitle = "Subagent";

/**
 * The subagents one engine turn started, keyed by the engine's own name for
 * each child: its thread, its session, or the call that spawned it. Whatever
 * reaches the driver first about a child — its spawn, its first event, a
 * question it asks — finds or opens its node, so a node is always reported
 * before anything names it. Nothing outlives the turn: whatever is still
 * running when it ends was stopped with it.
 */
export class SubagentNodes {
  readonly #live = new Map<string, LiveNode>();
  readonly #publish: (event: HarnessEvent) => void;

  constructor(publish: (event: HarnessEvent) => void) {
    this.#publish = publish;
  }

  /** The running node for `key`, if one is. */
  nodeId(key: string): ExecutionNodeId | undefined {
    return this.#live.get(key)?.nodeId;
  }

  /**
   * The call that started the running node for `key`: null while nothing has
   * named it yet, undefined when no node for `key` runs.
   */
  originCallId(key: string): string | null | undefined {
    return this.#live.get(key)?.originCallId;
  }

  /** The running node for `key`, opened now if nothing announced it yet. */
  ensure(key: string, start: SubagentStart): ExecutionNodeId {
    return this.#live.get(key)?.nodeId ?? this.open(key, start);
  }

  /**
   * Opens a new invocation for `key`. A key that is still running ends first:
   * a resumed child is a new node, never the old one continued.
   */
  open(key: string, start: SubagentStart): ExecutionNodeId {
    if (this.#live.has(key)) this.complete(key, "completed");
    const node: LiveNode = {
      effort: start.effort?.trim() || null,
      model: start.model ?? null,
      nodeId: createId("executionNode"),
      originCallId: start.originCallId ?? null,
      parentNodeId: start.parentKey ? (this.#live.get(start.parentKey)?.nodeId ?? null) : null,
      pendingProgress: null,
      phaseIndex: start.phaseIndex ?? null,
      phases: [],
      progress: null,
      progressAt: 0,
      progressTimer: undefined,
      prompt: boundedText(start.prompt, executionNodePromptMaxBytes),
      result: null,
      title: nodeTitle(start.title),
    };
    this.#live.set(key, node);
    this.#publish({
      data: {
        ...(node.effort ? { effort: node.effort } : {}),
        kind: start.kind ?? "subagent",
        model: node.model,
        nativeRef: start.nativeRef ?? node.nodeId,
        nodeId: node.nodeId,
        originCallId: node.originCallId,
        parentNodeId: node.parentNodeId,
        ...(node.phaseIndex === null ? {} : { phaseIndex: node.phaseIndex }),
        prompt: node.prompt,
        sessionRef: start.sessionRef ?? null,
        title: node.title,
      },
      type: "node.started",
    });
    return node.nodeId;
  }

  /** Reports what the engine said about a running node later, when it says something new. */
  update(
    key: string,
    update: {
      readonly effort?: string | null;
      readonly model?: string | null;
      readonly originCallId?: string | null;
      /**
       * The subagent that started it, proven only after the node was seen. A
       * node's parent is set once: a later claim never moves it.
       */
      readonly parentKey?: string | null;
      readonly phaseIndex?: number | null;
      /** A workflow's phases, in order, by title. */
      readonly phases?: readonly string[] | null;
      readonly prompt?: string | null;
      readonly title?: string | null;
    },
  ): void {
    const node = this.#live.get(key);
    if (!node) return;
    const title = update.title ? nodeTitle(update.title) : undefined;
    const prompt = update.prompt ? boundedText(update.prompt, executionNodePromptMaxBytes) : null;
    const effort = update.effort?.trim() || null;
    const parent =
      node.parentNodeId === null && update.parentKey && update.parentKey !== key
        ? this.#live.get(update.parentKey)
        : undefined;
    const phases = update.phases ? phaseTitles(update.phases) : null;
    const changed = {
      ...(title !== undefined && title !== node.title ? { title } : {}),
      ...(prompt !== null && prompt !== node.prompt ? { prompt } : {}),
      ...(update.model && update.model !== node.model ? { model: update.model } : {}),
      ...(effort && effort !== node.effort ? { effort } : {}),
      ...(update.originCallId && update.originCallId !== node.originCallId
        ? { originCallId: update.originCallId }
        : {}),
      ...(parent ? { parentNodeId: parent.nodeId } : {}),
      ...(typeof update.phaseIndex === "number" && update.phaseIndex !== node.phaseIndex
        ? { phaseIndex: update.phaseIndex }
        : {}),
      ...(phases && !sameTitles(phases, node.phases) ? { phases } : {}),
    };
    if (Object.keys(changed).length === 0) return;
    Object.assign(node, changed);
    this.#publish({ data: { nodeId: node.nodeId, ...changed }, type: "node.updated" });
  }

  /**
   * Something the subagent said, whole. It joins the subagent's own
   * transcript, and the last thing it says becomes its result when it ends.
   */
  message(key: string, text: string): void {
    const node = this.#live.get(key);
    if (!node || !text.trim()) return;
    node.result = text;
    this.#publish({
      data: { nodeId: node.nodeId, text: boundedLength(text, executionNodeMessageMaxLength) },
      type: "node.message",
    });
    this.progress(key, text);
  }

  /** A block of the subagent's own reasoning, whole. */
  reasoning(key: string, blockId: string, text: string): void {
    const node = this.#live.get(key);
    if (!node || !text.trim()) return;
    this.#publish({
      data: { blockId, nodeId: node.nodeId, text: boundedLength(text, 300_000) },
      type: "reasoning.completed",
    });
  }

  /**
   * The one line a running subagent's card shows: what it is doing now. Never
   * recorded, and sent at most once a second for one subagent, the newest
   * line winning.
   */
  progress(key: string, text: string): void {
    const node = this.#live.get(key);
    if (!node) return;
    const line = progressLine(text);
    if (!line) return;
    if (line === node.progress) {
      node.pendingProgress = null;
      return;
    }
    const wait = node.progressAt + progressIntervalMs - Date.now();
    if (wait <= 0) {
      this.#sendProgress(node, line);
      return;
    }
    node.pendingProgress = line;
    node.progressTimer ??= setTimeout(() => {
      node.progressTimer = undefined;
      const pending = node.pendingProgress;
      if (pending !== null && this.#live.get(key) === node) this.#sendProgress(node, pending);
    }, wait);
    node.progressTimer.unref?.();
  }

  #sendProgress(node: LiveNode, line: string): void {
    node.pendingProgress = null;
    node.progress = line;
    node.progressAt = Date.now();
    this.#publish({ data: { nodeId: node.nodeId, text: line }, type: "node.progress" });
  }

  /**
   * A result the engine reports apart from anything the subagent said, such as
   * a summary its parent was handed. `message` is for what it said itself.
   */
  noteResult(key: string, text: string): void {
    const node = this.#live.get(key);
    if (node && text.trim()) node.result = text;
  }

  complete(
    key: string,
    status: ExecutionNodeOutcome,
    options: { readonly result?: string | null; readonly usage?: RunUsage | null } = {},
  ): void {
    const node = this.#live.get(key);
    if (!node) return;
    this.#live.delete(key);
    clearTimeout(node.progressTimer);
    this.#publish({
      data: {
        nodeId: node.nodeId,
        result: boundedText(options.result ?? node.result, executionNodeResultMaxBytes),
        status,
        usage: options.usage ?? null,
      },
      type: "node.completed",
    });
  }

  /** The keys of every node still running. */
  liveKeys(): readonly string[] {
    return [...this.#live.keys()];
  }

  /** Ends every node still running, as the turn that owned them ends. */
  endAll(status: ExecutionNodeOutcome = "interrupted"): void {
    for (const key of this.liveKeys()) this.complete(key, status);
  }
}

function nodeTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  if (!trimmed) return defaultTitle;
  // The limit is in UTF-16 units, which a character outside the BMP takes two of.
  return trimmed.slice(0, surrogateSafeCut(trimmed, 240));
}

/** At most `maxLength` UTF-16 units, never ending on half a character. */
function boundedLength(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, surrogateSafeCut(text, maxLength));
}

/** The last line of `text` that says something, on one line and short enough for a card. */
function progressLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .findLast((part) => part.length > 0);
  if (!line) return null;
  if (line.length <= liveNodeProgressMaxLength) return line;
  return `${line.slice(0, surrogateSafeCut(line, liveNodeProgressMaxLength - 1))}…`;
}

function phaseTitles(phases: readonly string[]): string[] {
  return phases
    .map((phase) => phase.trim())
    .filter((phase) => phase.length > 0)
    .slice(0, executionNodePhasesMax)
    .map((phase) => phase.slice(0, surrogateSafeCut(phase, 120)));
}

function sameTitles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((title, index) => title === right[index]);
}

/** At most `maxBytes` of UTF-8, cut at a character boundary. */
function boundedText(text: string | null | undefined, maxBytes: number): string | null {
  if (!text) return null;
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes - 3) break;
    bytes += size;
    kept += character;
  }
  return `${kept}…`;
}
