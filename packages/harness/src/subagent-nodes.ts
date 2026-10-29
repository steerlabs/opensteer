import {
  createId,
  executionNodePromptMaxBytes,
  executionNodeResultMaxBytes,
  surrogateSafeCut,
  type ExecutionNodeId,
  type ExecutionNodeKind,
  type ExecutionNodeOutcome,
  type RunUsage,
} from "@opensteer/core";
import type { HarnessDurableEvent } from "./types.js";

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
  /** The tool call of the agent that started it. */
  readonly originCallId?: string | null;
  /** The key of the subagent that started this one, if not the Run's own agent. */
  readonly parentKey?: string | null;
}

interface LiveNode {
  readonly nodeId: ExecutionNodeId;
  originCallId: string | null;
  result: string | null;
  title: string;
  prompt: string | null;
  model: string | null;
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
  readonly #publish: (event: HarnessDurableEvent) => void;

  constructor(publish: (event: HarnessDurableEvent) => void) {
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
      model: start.model ?? null,
      nodeId: createId("executionNode"),
      originCallId: start.originCallId ?? null,
      prompt: boundedText(start.prompt, executionNodePromptMaxBytes),
      result: null,
      title: nodeTitle(start.title),
    };
    this.#live.set(key, node);
    this.#publish({
      data: {
        kind: start.kind ?? "subagent",
        model: node.model,
        nativeRef: start.nativeRef ?? node.nodeId,
        nodeId: node.nodeId,
        originCallId: node.originCallId,
        parentNodeId: start.parentKey ? (this.#live.get(start.parentKey)?.nodeId ?? null) : null,
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
      readonly model?: string | null;
      readonly originCallId?: string | null;
      readonly prompt?: string | null;
      readonly title?: string | null;
    },
  ): void {
    const node = this.#live.get(key);
    if (!node) return;
    const title = update.title ? nodeTitle(update.title) : undefined;
    const prompt = update.prompt ? boundedText(update.prompt, executionNodePromptMaxBytes) : null;
    const changed = {
      ...(title !== undefined && title !== node.title ? { title } : {}),
      ...(prompt !== null && prompt !== node.prompt ? { prompt } : {}),
      ...(update.model && update.model !== node.model ? { model: update.model } : {}),
      ...(update.originCallId && update.originCallId !== node.originCallId
        ? { originCallId: update.originCallId }
        : {}),
    };
    if (Object.keys(changed).length === 0) return;
    Object.assign(node, changed);
    this.#publish({ data: { nodeId: node.nodeId, ...changed }, type: "node.updated" });
  }

  /** What the subagent last said, which becomes its result when it ends. */
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
