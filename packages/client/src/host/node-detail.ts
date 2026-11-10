import {
  nodeSubagentCard,
  type AgentCard,
  type SubagentReader,
  transcriptNodes,
} from "./subagent-model.js";
import {
  compareSequence,
  nodeDetailEventNodeId,
  type AgentEventView as AgentEvent,
  type Sequence,
} from "@opensteer/core";
import type { NodeEventPage } from "@opensteer/protocol";
import type { NodeEntry, ReasoningEntry, ToolEntry, TranscriptEntry } from "./client.js";
import { LiveStreamLedger, type LiveProgressInput } from "./live-progress.js";
import { foldLiveRun, foldNodeDetailEvent, foldTranscriptEvent } from "./transcript.js";

export interface NodeMessageEntry {
  readonly kind: "node-message";
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
}

export interface NodeResultEntry {
  readonly kind: "node-result";
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
}

export type NodeDetailEntry =
  NodeMessageEntry | NodeResultEntry | ReasoningEntry | ToolEntry | NodeEntry;

export interface NodeDetailSnapshot {
  readonly nodeId: string;
  readonly threadId: string;
  readonly node: NodeEntry | null;
  readonly status: "unavailable" | "loading" | "ready" | "error" | "missing" | "closed";
  readonly entries: readonly NodeDetailEntry[];
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
}

/** Hold while the read-only transcript is visible; a new watch replaces the old one. */
export interface NodeDetailSubscription {
  getSnapshot(): NodeDetailSnapshot;
  subscribe(listener: () => void): () => void;
  loadOlder(): Promise<void>;
  retry(): void;
  release(): void;
}

export interface NodeDetailOptions {
  readonly available: () => boolean;
  readonly sendWatch: (workspaceId: string, nodeId: string | null) => boolean;
  readonly read: (input: {
    threadId: string;
    nodeId: string;
    through: Sequence;
    before?: string;
    limit: number;
  }) => Promise<NodeEventPage>;
  readonly nodes: (threadId: string) => readonly NodeEntry[];
  readonly readNodes?: (threadId: string, nodeId: string) => Promise<readonly NodeEntry[]>;
}

interface Watch {
  readonly workspaceId: string;
  readonly listeners: Set<() => void>;
  readonly events: Map<string, AgentEvent>;
  readonly live: LiveStreamLedger;
  readonly buffered: AgentEvent[];
  readonly bufferedLive: LiveProgressInput[];
  nodes: readonly NodeEntry[];
  sourceNodes: readonly NodeEntry[];
  snapshot: NodeDetailSnapshot;
  epoch: number;
  sent: boolean;
  through: Sequence | null;
  before: string | null;
  older: Promise<void> | null;
}

export class NodeDetailStore {
  readonly #options: NodeDetailOptions;
  #current: Watch | null = null;
  #pending: { workspaceId: string; nodeId: string | null; watch: Watch; epoch: number }[] = [];

  constructor(options: NodeDetailOptions) {
    this.#options = options;
  }

  open(threadId: string, nodeId: string, workspaceId: string): NodeDetailSubscription {
    this.clear();
    const watch: Watch = {
      workspaceId,
      listeners: new Set(),
      events: new Map(),
      live: new LiveStreamLedger(),
      buffered: [],
      bufferedLive: [],
      nodes: [],
      sourceNodes: [],
      epoch: 0,
      sent: false,
      through: null,
      before: null,
      older: null,
      snapshot: {
        nodeId,
        threadId,
        node: null,
        status: this.#options.available() ? "loading" : "unavailable",
        entries: [],
        hasMore: false,
        loadingOlder: false,
        error: null,
      },
    };
    this.#current = watch;
    this.#send(watch);
    return {
      getSnapshot: () => watch.snapshot,
      subscribe: (listener) => {
        watch.listeners.add(listener);
        return () => {
          watch.listeners.delete(listener);
        };
      },
      loadOlder: () => this.#loadOlder(watch),
      retry: () => {
        if (this.#current !== watch) return;
        watch.epoch += 1;
        watch.sent = false;
        this.#send(watch);
      },
      release: () => {
        if (this.#current === watch) this.clear();
      },
    };
  }

  clear(): void {
    const watch = this.#current;
    if (!watch) return;
    this.#current = null;
    watch.epoch += 1;
    if (watch.sent && this.#options.sendWatch(watch.workspaceId, null))
      this.#pending.push({
        workspaceId: watch.workspaceId,
        nodeId: null,
        watch,
        epoch: watch.epoch,
      });
    this.#set(watch, {
      ...watch.snapshot,
      status: "closed",
      node: null,
      entries: [],
      loadingOlder: false,
    });
    watch.nodes = [];
    watch.sourceNodes = [];
    watch.events.clear();
    watch.live.clear();
    watch.buffered.length = 0;
    watch.bufferedLive.length = 0;
  }

  forgetWorkspace(workspaceId: string): void {
    if (this.#current?.workspaceId === workspaceId) this.clear();
    this.#pending = this.#pending.filter((item) => item.workspaceId !== workspaceId);
  }

  disconnected(workspaceId: string): void {
    this.#pending = this.#pending.filter((item) => item.workspaceId !== workspaceId);
    const watch = this.#current;
    if (!watch || watch.workspaceId !== workspaceId) return;
    watch.epoch += 1;
    watch.sent = false;
    watch.through = null;
    watch.older = null;
    watch.buffered.length = 0;
    watch.bufferedLive.length = 0;
    watch.live.clear();
    this.#set(watch, { ...watch.snapshot, status: "loading", loadingOlder: false, error: null });
  }

  connected(workspaceId: string): void {
    if (this.#current?.workspaceId === workspaceId) this.#send(this.#current);
  }

  capabilitiesChanged(): void {
    const watch = this.#current;
    if (!watch) return;
    if (!this.#options.available()) {
      if (watch.sent && this.#options.sendWatch(watch.workspaceId, null))
        this.#pending.push({
          workspaceId: watch.workspaceId,
          nodeId: null,
          watch,
          epoch: watch.epoch,
        });
      watch.epoch += 1;
      watch.sent = false;
      watch.events.clear();
      watch.nodes = [];
      watch.sourceNodes = [];
      watch.buffered.length = 0;
      watch.bufferedLive.length = 0;
      watch.live.clear();
      this.#set(watch, {
        ...watch.snapshot,
        node: null,
        entries: [],
        status: "unavailable",
        loadingOlder: false,
        error: null,
      });
    } else this.#send(watch);
  }

  #send(watch: Watch): void {
    if (watch.sent || !this.#options.available()) return;
    if (!this.#options.sendWatch(watch.workspaceId, watch.snapshot.nodeId)) return;
    watch.sent = true;
    this.#set(watch, { ...watch.snapshot, status: "loading", error: null });
    this.#pending.push({
      workspaceId: watch.workspaceId,
      nodeId: watch.snapshot.nodeId,
      watch,
      epoch: watch.epoch,
    });
  }

  watched(workspaceId: string, nodeId: string | null, sequence: Sequence): void {
    const index = this.#pending.findIndex(
      (item) => item.workspaceId === workspaceId && item.nodeId === nodeId,
    );
    if (index < 0) return;
    const pending = this.#pending.splice(index, 1)[0]!;
    const { watch, epoch } = pending;
    if (nodeId === null || this.#current !== watch || watch.epoch !== epoch) return;
    watch.through = sequence;
    void this.#reload(watch, epoch, sequence);
  }

  accept(event: AgentEvent): void {
    const watch = this.#current;
    if (
      !watch ||
      watch.snapshot.status === "unavailable" ||
      event.threadId !== watch.snapshot.threadId ||
      event.workspaceId !== watch.workspaceId
    )
      return;
    if (nodeDetailEventNodeId(event) === watch.snapshot.nodeId) {
      if (watch.snapshot.status !== "ready") watch.buffered.push(event);
      else {
        watch.events.set(event.eventId, event);
        watch.live.complete(event);
        this.#draw(watch);
      }
    } else if (
      event.type === "run.completed" ||
      event.type === "run.interrupted" ||
      event.type === "run.failed" ||
      event.type === "run.restarted" ||
      (event.type === "run.status" &&
        (event.data.status === "completed" ||
          event.data.status === "failed" ||
          event.data.status === "interrupted"))
    ) {
      watch.live.complete(event);
      if (watch.snapshot.status !== "ready") watch.buffered.push(event);
      else {
        watch.events.set(event.eventId, event);
        this.#draw(watch);
      }
    }
  }

  acceptLive(input: LiveProgressInput): void {
    const watch = this.#current;
    if (
      !watch ||
      watch.snapshot.status === "unavailable" ||
      input.progress.threadId !== watch.snapshot.threadId ||
      input.progress.workspaceId !== watch.workspaceId
    )
      return;
    const items = input.progress.items.filter(
      (item) => item.stream === "tool" && item.nodeId === watch.snapshot.nodeId,
    );
    if (items.length === 0) return;
    const own = { ...input, progress: { ...input.progress, items } };
    if (watch.snapshot.status !== "ready") watch.bufferedLive.push(own);
    else {
      watch.live.apply(own);
      this.#draw(watch);
    }
  }

  refreshNodes(): void {
    const watch = this.#current;
    if (!watch || watch.snapshot.status !== "ready") return;
    const nodes = this.#options
      .nodes(watch.snapshot.threadId)
      .filter(
        (node) =>
          node.nodeId === watch.snapshot.nodeId || node.parentNodeId === watch.snapshot.nodeId,
      );
    if (
      nodes.length === watch.sourceNodes.length &&
      nodes.every((node, index) => node === watch.sourceNodes[index])
    )
      return;
    this.#draw(watch);
  }

  async #reload(watch: Watch, epoch: number, through: Sequence): Promise<void> {
    const previous = [...watch.events.values()]
      .map((event) => event.sequence)
      .sort(compareSequence)
      .at(-1);
    try {
      let before: string | undefined;
      const received: AgentEvent[] = [];
      const cursors = new Set<string>();
      const [firstPage, nodes] = await Promise.all([
        this.#options.read({
          threadId: watch.snapshot.threadId,
          nodeId: watch.snapshot.nodeId,
          through,
          limit: 100,
        }),
        this.#options.readNodes?.(watch.snapshot.threadId, watch.snapshot.nodeId) ??
          Promise.resolve([]),
      ]);
      if (watch !== this.#current || epoch !== watch.epoch) return;
      watch.nodes = nodes;
      let page = firstPage;
      do {
        if (before)
          page = await this.#options.read({
            threadId: watch.snapshot.threadId,
            nodeId: watch.snapshot.nodeId,
            through,
            limit: 100,
            before,
          });
        if (watch !== this.#current || epoch !== watch.epoch) return;
        received.push(...page.events);
        const oldest = page.events[0]?.sequence;
        const next = page.window.nextBefore;
        if (
          !previous ||
          (oldest && compareSequence(oldest, previous) <= 0) ||
          !page.window.hasMore ||
          !next
        )
          break;
        if (cursors.has(next)) throw new Error("Node history did not advance.");
        cursors.add(next);
        before = next;
      } while (true);
      for (const event of received) watch.events.set(event.eventId, event);
      for (const event of watch.buffered) watch.events.set(event.eventId, event);
      watch.buffered.length = 0;
      const ordered = [...watch.events.values()].sort((a, b) =>
        compareSequence(a.sequence, b.sequence),
      );
      for (const event of ordered) watch.live.complete(event);
      for (const input of watch.bufferedLive) watch.live.apply(input);
      watch.bufferedLive.length = 0;
      if (!previous) watch.before = page.window.nextBefore;
      watch.snapshot = {
        ...watch.snapshot,
        status: "ready",
        hasMore: watch.before !== null,
        error: null,
      };
      this.#draw(watch);
    } catch (error) {
      if (watch !== this.#current || epoch !== watch.epoch) return;
      this.#set(watch, {
        ...watch.snapshot,
        status:
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "not_found" || error.code === "forbidden")
            ? "missing"
            : "error",
        entries: [],
        node: null,
        error: error instanceof Error ? error.message : "Could not load this subagent.",
      });
    }
  }

  #loadOlder(watch: Watch): Promise<void> {
    if (watch.older) return watch.older;
    if (
      this.#current !== watch ||
      watch.snapshot.status !== "ready" ||
      !watch.before ||
      !watch.through
    )
      return Promise.resolve();
    const epoch = watch.epoch;
    const before = watch.before;
    const through = watch.through;
    this.#set(watch, { ...watch.snapshot, loadingOlder: true, error: null });
    const operation = this.#options
      .read({
        threadId: watch.snapshot.threadId,
        nodeId: watch.snapshot.nodeId,
        through,
        before,
        limit: 100,
      })
      .then((page) => {
        if (watch !== this.#current || epoch !== watch.epoch) return;
        for (const event of page.events) {
          watch.events.set(event.eventId, event);
          watch.live.complete(event);
        }
        watch.before = page.window.nextBefore;
        watch.snapshot = { ...watch.snapshot, hasMore: page.window.hasMore, loadingOlder: false };
        this.#draw(watch);
      })
      .catch((error: unknown) => {
        if (watch === this.#current && epoch === watch.epoch)
          this.#set(watch, {
            ...watch.snapshot,
            loadingOlder: false,
            error: error instanceof Error ? error.message : "Could not load older work.",
          });
      })
      .finally(() => {
        if (watch.older === operation) watch.older = null;
      });
    watch.older = operation;
    return operation;
  }

  #draw(watch: Watch): void {
    let entries: TranscriptEntry[] = [];
    const messages: NodeMessageEntry[] = [];
    const positions = new Map<string, Sequence>();
    for (const event of [...watch.events.values()].sort((a, b) =>
      compareSequence(a.sequence, b.sequence),
    )) {
      if (event.type === "node.message") {
        positions.set(event.eventId, event.sequence);
        messages.push({
          kind: "node-message",
          id: event.eventId,
          createdAt: event.createdAt,
          text: event.data.text,
        });
      } else if (
        event.type === "tool.started" ||
        event.type === "tool.completed" ||
        event.type === "reasoning.completed"
      ) {
        const existing = new Set(entries.map((entry) => entry.id));
        entries = foldNodeDetailEvent(entries, event, watch.snapshot.nodeId);
        for (const entry of entries)
          if (!existing.has(entry.id)) positions.set(entry.id, event.sequence);
      } else entries = foldTranscriptEvent(entries, event);
    }
    for (const run of watch.live.threadRuns(
      watch.snapshot.threadId as import("@opensteer/core").ThreadId,
    )) {
      entries = foldLiveRun(
        entries,
        { ...run, streams: run.streams.map(({ nodeId: _owner, ...stream }) => stream) },
        new Date().toISOString(),
      );
    }
    watch.sourceNodes = this.#options
      .nodes(watch.snapshot.threadId)
      .filter(
        (node) =>
          node.nodeId === watch.snapshot.nodeId || node.parentNodeId === watch.snapshot.nodeId,
      );
    const nodes = new Map(watch.nodes.map((node) => [node.nodeId, node]));
    for (const node of watch.sourceNodes) {
      const read = nodes.get(node.nodeId);
      nodes.set(
        node.nodeId,
        read && read.status !== "running" && node.status === "running" ? read : node,
      );
    }
    const own = nodes.get(watch.snapshot.nodeId) ?? null;
    const children = [...nodes.values()].filter(
      (node) => node.parentNodeId === watch.snapshot.nodeId,
    );
    const calls = new Set(
      children.flatMap((node) => (node.originCallId ? [node.originCallId] : [])),
    );
    const detail: NodeDetailEntry[] = entries.filter(
      (entry): entry is ToolEntry | ReasoningEntry =>
        entry.kind === "reasoning" || (entry.kind === "tool" && !calls.has(entry.callId)),
    );
    detail.push(...messages, ...children);
    for (const child of children) if (child.sequence) positions.set(child.id, child.sequence);
    if (own?.result && own.completedAt && messages.at(-1)?.text !== own.result)
      detail.push({
        kind: "node-result",
        id: `result:${own.nodeId}`,
        createdAt: own.completedAt,
        text: own.result,
      });
    detail.sort((a, b) => {
      const left = positions.get(a.id);
      const right = positions.get(b.id);
      return left && right ? compareSequence(left, right) : a.createdAt.localeCompare(b.createdAt);
    });
    this.#set(watch, { ...watch.snapshot, node: own, entries: detail });
  }

  #set(watch: Watch, snapshot: NodeDetailSnapshot): void {
    watch.snapshot = snapshot;
    for (const listener of watch.listeners) listener();
  }
}

export type SubagentDetailEntry =
  | { readonly kind: "message"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
  | ToolEntry
  | { readonly kind: "agent"; readonly card: AgentCard };
export interface SubagentDetail {
  readonly state: "loading" | "ready" | "summary-only" | "error" | "unavailable" | "missing";
  readonly card: AgentCard;
  readonly prompt: string | null;
  readonly parent: { readonly threadId: string; readonly title: string; readonly nodeId?: string };
  readonly entries: readonly SubagentDetailEntry[];
  readonly result: string | null;
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
}
export function subagentDetail(
  snapshot: NodeDetailSnapshot,
  summary: NodeEntry,
  reader: SubagentReader,
): SubagentDetail {
  const node = snapshot.node ?? summary;
  const nodes = [
    ...new Map(
      [
        ...transcriptNodes(reader.transcripts[snapshot.threadId] ?? []),
        ...snapshot.entries.filter((entry): entry is NodeEntry => entry.kind === "node"),
      ].map((entry) => [entry.nodeId, entry]),
    ).values(),
  ];
  const card = nodeSubagentCard(node, snapshot.threadId, nodes, reader);
  if (!card) throw new Error("Background tasks do not have subagent views.");
  const parentNode = nodes.find((candidate) => candidate.nodeId === node.parentNodeId);
  const entries: SubagentDetailEntry[] = snapshot.entries.flatMap(
    (entry): SubagentDetailEntry[] => {
      switch (entry.kind) {
        case "node-message":
          return [{ kind: "message", id: entry.id, text: entry.text }];
        case "reasoning":
          return [{ kind: "reasoning", id: entry.id, text: entry.text }];
        case "tool":
          return [entry];
        case "node": {
          if (node.nodeKind === "workflow") return [];
          const child = nodeSubagentCard(entry, snapshot.threadId, nodes, reader);
          return child ? [{ kind: "agent", card: child }] : [];
        }
        case "node-result":
          return [];
      }
    },
  );
  const lastMessage = entries.findLast((entry) => entry.kind === "message");
  const result =
    lastMessage?.kind === "message" && lastMessage.text === node.result ? null : node.result;
  const state =
    snapshot.status === "closed"
      ? "missing"
      : snapshot.status === "ready" &&
          node.status !== "running" &&
          !snapshot.hasMore &&
          !entries.some((entry) => entry.kind !== "agent")
        ? "summary-only"
        : snapshot.status;
  return {
    state,
    card,
    prompt: node.prompt,
    parent: {
      threadId: snapshot.threadId,
      title:
        parentNode?.title ??
        reader.threads.find((thread) => thread.id === snapshot.threadId)?.title ??
        "Parent conversation",
      ...(parentNode ? { nodeId: parentNode.nodeId } : {}),
    },
    entries,
    result,
    hasEarlier: snapshot.hasMore,
    loadingEarlier: snapshot.loadingOlder,
  };
}
