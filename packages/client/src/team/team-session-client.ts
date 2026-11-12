import type { TeamFileUpload } from "./files.js";
import { type TeamChannelId, type TeamMessageId, type UserId } from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import {
  TeamServerFrameSchema,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
  type HostApiClient,
  type HostApiCommandInput,
  type TeamMessage,
} from "@opensteer/protocol";
import type { z } from "zod";
import type {
  TeamBootstrapSchema,
  TeamSearchInputSchema,
  TeamSearchPageSchema,
  TeamFileSchema,
} from "@opensteer/protocol";
import type { WebSocketClient } from "../host/host-session-client.js";
import { teamRpcResult as unwrapRpcResult } from "./rpc-result.js";
import {
  teamScopeKey,
  emptyTeamTimeline,
  reduceTeamCut,
  reduceTeamPage,
  monotonicTeamSidebar,
  type TeamSidebar,
  type TeamTimeline,
  type TeamScope,
} from "./reducers.js";
import {
  TeamSendCommandSchema,
  TeamSavedStateSchema,
  type TeamCacheScope,
  type TeamPersistence,
  type PendingTeamSend,
  type TeamSavedState,
} from "./persistence.js";

type TeamBootstrap = z.infer<typeof TeamBootstrapSchema>;
type SearchInput = z.infer<typeof TeamSearchInputSchema>;
type SearchPage = z.infer<typeof TeamSearchPageSchema>;
export interface TeamSessionSnapshot {
  readonly bootstrap: TeamBootstrap | null;
  readonly sidebar: TeamSidebar | null;
  readonly channel: TeamTimeline | null;
  readonly thread: TeamTimeline | null;
  readonly connection: "offline" | "connecting" | "connected";
  readonly pending: readonly PendingTeamSend[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly typing: Readonly<Record<string, readonly string[]>>;
  readonly presence: Readonly<Record<string, boolean>>;
  readonly search: SearchPage | null;
  readonly error: string | null;
}
export interface TeamSessionOptions {
  readonly scope: TeamCacheScope;
  readonly rpc: HostApiClient;
  readonly persistence: TeamPersistence;
  readonly connect: () => WebSocketClient;
  readonly readFile?: (
    file: z.infer<typeof TeamFileSchema>,
    part: "preview" | "original",
    signal?: AbortSignal,
  ) => Promise<Blob>;
  readonly uploadFile?: (input: TeamFileUpload) => Promise<z.infer<typeof TeamFileSchema>>;
  readonly notify?: (entry: TeamSidebar["channels"][number]) => void;
}
export class TeamSessionClient {
  readonly rpc: HostApiClient;
  readonly #options: TeamSessionOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: TeamSessionSnapshot = {
    bootstrap: null,
    sidebar: null,
    channel: null,
    thread: null,
    connection: "offline",
    pending: [],
    drafts: {},
    typing: {},
    presence: {},
    search: null,
    error: null,
  };
  #socket: WebSocketClient | null = null;
  #generation = 0;
  #lifetime = 0;
  #searchGeneration = 0;
  #persist: Promise<void> = Promise.resolve();
  #reconnecting: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connected = false;
  #removed = false;
  #disposed = false;
  #loading: Promise<void> | null = null;
  #stateRevision = 0;
  readonly #editedDrafts = new Set<string>();
  #attempt = 0;
  #typingAt = new Map<string, number>();
  #presenceAt = -Infinity;
  #files = new Map<string, Blob>();
  #fileBytes = 0;
  #contentGeneration = 0;
  #connectionGeneration = 0;
  #sidebarGeneration = 0;
  constructor(options: TeamSessionOptions) {
    this.#options = options;
    this.rpc = options.rpc;
  }
  readonly getSnapshot = (): TeamSessionSnapshot => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(patch: Partial<TeamSessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  async load(connect = true): Promise<void> {
    if (this.#removed || this.#disposed) return;
    if (!this.#loading) {
      const lifetime = this.#lifetime,
        revision = this.#stateRevision;
      this.#loading = (async () => {
        const [saved, bootstrap] = await Promise.all([
          this.#options.persistence.load(this.#options.scope),
          this.rpc["team.bootstrap.get"]({}).then(unwrapRpcResult),
        ]);
        if (lifetime !== this.#lifetime) return;
        if (
          bootstrap.teamId !== this.#options.scope.teamDeploymentId ||
          bootstrap.member.userId !== this.#options.scope.userId
        )
          throw new Error("Team session identity changed.");
        const state = saved ? TeamSavedStateSchema.parse(saved) : { drafts: {}, pending: [] };
        const pending =
          revision === this.#stateRevision
            ? state.pending
            : [
                ...new Map(
                  [...state.pending, ...this.#snapshot.pending].map((row) => [
                    row.command.clientMessageId,
                    row,
                  ]),
                ).values(),
              ];
        this.#update({
          bootstrap,
          sidebar: monotonicTeamSidebar(this.#snapshot.sidebar, bootstrap.sidebar),
          drafts:
            revision === this.#stateRevision
              ? state.drafts
              : Object.fromEntries([
                  ...Object.entries(state.drafts).filter(([key]) => !this.#editedDrafts.has(key)),
                  ...Object.entries(this.#snapshot.drafts),
                ]),
          pending,
        });
      })().finally(() => {
        this.#loading = null;
      });
    }
    await this.#loading;
    if (connect) this.connect();
  }
  connect(): void {
    if (this.#removed || this.#disposed || this.#socket) return;
    this.#connected = true;
    this.#update({ connection: "connecting", error: null });
    const socket = this.#options.connect();
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#update({ connection: "connected" });
      this.#subscribe(null);
      if (this.#snapshot.channel) this.#subscribe(this.#snapshot.channel);
      if (this.#snapshot.thread) this.#subscribe(this.#snapshot.thread);
      void this.reconcilePending().catch((error: unknown) =>
        this.#update({
          error: error instanceof Error ? error.message : "Could not confirm sent messages.",
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || typeof event.data !== "string") return;
      try {
        if (event.data.length > 512 * 1024) throw new Error("Team frame exceeds its byte bound.");
        this.receive(TeamServerFrameSchema.parse(JSON.parse(event.data)));
      } catch {
        this.#update({
          channel: this.#fresh(this.#snapshot.channel),
          thread: this.#fresh(this.#snapshot.thread),
          error: "Team synchronization needs a fresh snapshot.",
        });
        this.disconnect();
        this.connect();
      }
    });
    const closed = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#connectionGeneration++;
      this.#update({ connection: "offline", typing: {}, presence: {} });
      if (!this.#connected || this.#removed) return;
      this.#reconnectTimer = setTimeout(
        () => {
          this.#reconnectTimer = null;
          this.connect();
        },
        Math.min(12000, 300 * 2 ** Math.min(this.#attempt++, 6)),
      );
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", () => {
      socket.close();
      closed();
    });
  }
  #fresh(view: TeamTimeline | null): TeamTimeline | null {
    return view ? emptyTeamTimeline(view.subscriptionId, view.generation, view.scope) : null;
  }
  #subscribe(view: TeamTimeline | null): void {
    this.#send({
      type: "team.subscribe",
      teamApiVersion,
      sidebar: true,
      subscriptionId: view?.subscriptionId ?? "sidebar",
      generation: view?.generation ?? 1,
      scope: view?.scope ?? null,
      sinceSeq: view?.throughSeq ?? null,
    });
  }
  #send(frame: unknown): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(frame));
  }
  selectChannel(channelId: TeamChannelId | null): void {
    const channel = channelId
      ? emptyTeamTimeline("channel", ++this.#generation, { kind: "channel", channelId })
      : null;
    this.#update({ channel, thread: null, typing: {} });
    this.#send({
      type: "team.subscribe",
      teamApiVersion,
      sidebar: true,
      subscriptionId: "thread",
      generation: ++this.#generation,
      scope: null,
      sinceSeq: null,
    });
    if (channel) this.#subscribe(channel);
    else
      this.#send({
        type: "team.subscribe",
        teamApiVersion,
        sidebar: true,
        subscriptionId: "channel",
        generation: ++this.#generation,
        scope: null,
        sinceSeq: null,
      });
  }
  selectThread(channelId: TeamChannelId, rootId: TeamMessageId | null): void {
    const thread = rootId
      ? emptyTeamTimeline("thread", ++this.#generation, { kind: "thread", channelId, rootId })
      : null;
    this.#update({ thread });
    if (thread) this.#subscribe(thread);
    else
      this.#send({
        type: "team.subscribe",
        teamApiVersion,
        sidebar: true,
        subscriptionId: "thread",
        generation: ++this.#generation,
        scope: null,
        sinceSeq: null,
      });
  }
  async loadPage(
    view: "channel" | "thread",
    direction: "newest" | "before" | "after",
  ): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const selected = this.#snapshot[view];
    if (!selected) return;
    const anchor = direction === "before" ? selected.messages[0]?.id : selected.messages.at(-1)?.id;
    if (direction !== "newest" && !anchor) return;
    const page =
      direction === "newest" ? ({ direction } as const) : { direction, messageId: anchor! };
    const lifetime = this.#lifetime;
    const result =
      selected.scope.kind === "channel"
        ? await this.rpc["team.messages.page"]({ channelId: selected.scope.channelId, page }).then(
            unwrapRpcResult,
          )
        : await this.rpc["team.thread.page"]({
            channelId: selected.scope.channelId,
            rootId: selected.scope.rootId,
            page,
          }).then(unwrapRpcResult);
    const current = this.#snapshot[view];
    if (lifetime !== this.#lifetime || !current || selected.generation !== current.generation)
      return;
    this.#update({ [view]: reduceTeamPage(current, result, selected.generation, direction) });
  }
  receive(frame: z.infer<typeof TeamServerFrameSchema>): void {
    if (this.#removed) return;
    switch (frame.type) {
      case "team.cut": {
        const view = frame.cut.scope.kind === "channel" ? "channel" : "thread";
        const held = this.#snapshot[view];
        if (!held) return;
        const next = reduceTeamCut(held, frame.cut);
        if (next !== held) this.#update({ [view]: next });
        break;
      }
      case "team.sidebar":
        this.#applySidebar(frame.sidebar);
        break;
      case "team.sidebar.dirty":
        void this.#refreshSidebarRows(frame.channelIds).catch(() => undefined);
        break;
      case "team.access.changed": {
        this.#contentGeneration++;
        // Content is hidden until a new authorized cut; old pages cannot reinstall it.
        const channel = this.#snapshot.channel,
          thread = this.#snapshot.thread;
        this.#update({
          sidebar: null,
          channel: channel ? emptyTeamTimeline("channel", ++this.#generation, channel.scope) : null,
          thread: thread ? emptyTeamTimeline("thread", ++this.#generation, thread.scope) : null,
          search: null,
        });
        this.#files.clear();
        this.#fileBytes = 0;
        this.#searchGeneration++;
        void this.refreshSidebar().catch(() => undefined);
        if (this.#snapshot.channel) this.#subscribe(this.#snapshot.channel);
        if (this.#snapshot.thread) this.#subscribe(this.#snapshot.thread);
        break;
      }
      case "team.typing":
        this.#update({
          typing: {
            ...this.#snapshot.typing,
            [JSON.stringify([frame.channelId, frame.rootId])]: frame.userIds,
          },
        });
        break;
      case "team.presence":
        this.#update({
          presence: {
            ...this.#snapshot.presence,
            ...Object.fromEntries(frame.people.map((person) => [person.userId, person.online])),
          },
        });
        break;
      case "team.link.presence":
        if (this.#snapshot.sidebar)
          this.#applySidebar({
            ...this.#snapshot.sidebar,
            channels: this.#snapshot.sidebar.channels.map((entry) => ({
              ...entry,
              agentOnline:
                frame.userId === this.#options.scope.userId ? frame.online : entry.agentOnline,
            })),
          });
        break;
    }
  }
  #applySidebar(sidebar: TeamSidebar, replace = false, notify = true): void {
    const previous = this.#snapshot.sidebar;
    const last = sidebar.channels.at(-1)?.channel.id;
    const extra =
      !replace && last && sidebar.nextCursor && previous?.accessRevision === sidebar.accessRevision
        ? previous.channels.filter((row) => row.channel.id > last)
        : [];
    const merged = extra.length
      ? {
          ...sidebar,
          channels: [...sidebar.channels, ...extra].slice(0, 1000),
          nextCursor: previous!.nextCursor,
        }
      : sidebar;
    const next = monotonicTeamSidebar(previous, merged);
    this.#update({ sidebar: next });
    if (notify && previous) this.#notifySidebar(previous, next);
  }
  #notifySidebar(previous: TeamSidebar, next: TeamSidebar): void {
    for (const entry of next.channels) {
      const held = previous.channels.find((row) => row.channel.id === entry.channel.id);
      const notify =
        entry.notificationLevel === "all" ||
        (entry.notificationLevel === "mentions" && entry.mentionCount > (held?.mentionCount ?? 0));
      if (
        notify &&
        entry.unread &&
        (!held?.unread ||
          (BigInt(entry.channel.latestMessageId ?? "0") >
          BigInt(held.channel.latestMessageId ?? "0")
            ? 1
            : -1) > 0)
      )
        this.#options.notify?.(entry);
    }
  }
  async #refreshSidebarRows(channelIds: readonly TeamChannelId[]): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const lifetime = this.#lifetime,
      generation = this.#contentGeneration;
    const pages: TeamSidebar[] = [];
    for (let offset = 0; offset < channelIds.length; offset += 50) {
      pages.push(
        await this.rpc["team.sidebar.get"]({
          channelIds: channelIds.slice(offset, offset + 50),
        }).then(unwrapRpcResult),
      );
      if (lifetime !== this.#lifetime || generation !== this.#contentGeneration) return;
    }
    if (!pages.length) return;
    const page = { ...pages[0]!, channels: pages.flatMap((result) => result.channels) };
    if (pages.some((result) => result.accessRevision !== page.accessRevision))
      return this.refreshSidebar();
    if (lifetime !== this.#lifetime || generation !== this.#contentGeneration) return;
    const current = this.#snapshot.sidebar;
    if (!current || current.accessRevision !== page.accessRevision) {
      await this.refreshSidebar();
      return;
    }
    const requested = new Set(channelIds);
    const rows = [
      ...current.channels.filter((row) => !requested.has(row.channel.id)),
      ...page.channels,
    ].sort((a, b) => a.channel.id.localeCompare(b.channel.id));
    this.#notifySidebar(
      current,
      monotonicTeamSidebar(current, { ...current, channels: page.channels }),
    );
    this.#applySidebar({ ...current, channels: rows.slice(0, 1000) }, true, false);
  }
  async refreshSidebar(): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const generation = ++this.#sidebarGeneration,
      lifetime = this.#lifetime,
      limit = Math.max(50, this.#snapshot.sidebar?.channels.length ?? 0);
    let sidebar = await this.rpc["team.sidebar.get"]({}).then(unwrapRpcResult);
    while (sidebar.nextCursor && sidebar.channels.length < Math.min(1000, limit)) {
      if (generation !== this.#sidebarGeneration || lifetime !== this.#lifetime) return;
      const page = await this.rpc["team.sidebar.get"]({ after: sidebar.nextCursor }).then(
        unwrapRpcResult,
      );
      if (page.accessRevision !== sidebar.accessRevision)
        throw new Error("Team access changed while loading channels.");
      sidebar = { ...page, channels: [...sidebar.channels, ...page.channels] };
    }
    if (generation === this.#sidebarGeneration && lifetime === this.#lifetime)
      this.#applySidebar(sidebar, true);
  }
  async loadMoreSidebar(): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const before = this.#snapshot.sidebar,
      lifetime = this.#lifetime,
      generation = this.#sidebarGeneration;
    if (!before?.nextCursor || before.channels.length >= 1000) return;
    const page = await this.rpc["team.sidebar.get"]({ after: before.nextCursor }).then(
        unwrapRpcResult,
      ),
      current = this.#snapshot.sidebar;
    if (
      lifetime !== this.#lifetime ||
      generation !== this.#sidebarGeneration ||
      current?.nextCursor !== before.nextCursor ||
      page.accessRevision !== current.accessRevision
    )
      return;
    const channels = [...current.channels, ...page.channels]
      .filter(
        (row, index, rows) =>
          rows.findIndex((other) => other.channel.id === row.channel.id) === index,
      )
      .slice(0, 1000);
    this.#applySidebar({ ...page, channels }, true);
  }
  async #save(): Promise<void> {
    this.#stateRevision++;
    const state: TeamSavedState = {
      pending: [...this.#snapshot.pending],
      drafts: { ...this.#snapshot.drafts },
    };
    this.#persist = this.#persist
      .catch(() => undefined)
      .then(() =>
        this.#removed || this.#disposed
          ? undefined
          : this.#options.persistence.save(this.#options.scope, state),
      );
    await this.#persist;
  }
  async setDraft(scope: TeamScope, text: string): Promise<void> {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    const key = teamScopeKey(scope),
      drafts = { ...this.#snapshot.drafts };
    if (text) drafts[key] = text;
    else delete drafts[key];
    TeamSavedStateSchema.shape.drafts.parse(drafts);
    this.#editedDrafts.add(key);
    this.#update({ drafts });
    await this.#save();
  }
  async send(
    input: Omit<
      Extract<HostApiCommandInput, { type: "team.message.send" }>,
      "type" | "clientMessageId"
    >,
  ): Promise<string> {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    if (this.#snapshot.pending.length >= 100) throw new Error("Too many unconfirmed messages.");
    const pending: PendingTeamSend = {
      command: TeamSendCommandSchema.parse({
        type: "team.message.send",
        clientMessageId: crypto.randomUUID(),
        ...input,
      }),
      createdAt: new Date().toISOString(),
    };
    this.#update({ pending: [...this.#snapshot.pending, pending] });
    await this.#save();
    if (this.#snapshot.connection === "connected") await this.#transmit(pending, this.#lifetime);
    return pending.command.clientMessageId;
  }
  async #transmit(pending: PendingTeamSend, lifetime: number): Promise<void> {
    const result = await this.rpc["commands.dispatch"](pending.command).then(unwrapRpcResult);
    if (lifetime !== this.#lifetime || result.type !== "team.message.send") return;
    await this.#confirm([result.message]);
  }
  async #confirm(messages: readonly TeamMessage[]): Promise<void> {
    const confirmed = new Set(
      messages
        .filter(
          (message) =>
            message.authorUserId === this.#options.scope.userId && message.authorKind === "human",
        )
        .map((message) => message.clientMessageId),
    );
    this.#update({
      pending: this.#snapshot.pending.filter(
        (send) => !confirmed.has(send.command.clientMessageId),
      ),
    });
    await this.#save();
  }
  reconcilePending(): Promise<void> {
    if (this.#removed || this.#disposed) return Promise.resolve();
    if (this.#reconnecting) return this.#reconnecting;
    const lifetime = this.#lifetime,
      connectionGeneration = this.#connectionGeneration;
    const current = () =>
      lifetime === this.#lifetime &&
      connectionGeneration === this.#connectionGeneration &&
      this.#snapshot.connection === "connected";
    const operation = (async () => {
      const pending = [...this.#snapshot.pending];
      const channels = new Set(pending.map((send) => send.command.channelId));
      for (const channelId of channels) {
        const sends = pending.filter((send) => send.command.channelId === channelId);
        for (let index = 0; index < sends.length; index += 50) {
          const batch = sends.slice(index, index + 50);
          const stored = await this.rpc["team.messages.check"]({
            channelId,
            clientMessageIds: batch.map((send) => send.command.clientMessageId),
          }).then(unwrapRpcResult);
          if (!current()) return;
          await this.#confirm(stored.messages);
          for (const send of batch) {
            if (!current()) return;
            if (
              this.#snapshot.pending.some(
                (row) => row.command.clientMessageId === send.command.clientMessageId,
              )
            )
              await this.#transmit(send, lifetime);
          }
        }
      }
    })().finally(() => {
      if (this.#reconnecting === operation) this.#reconnecting = null;
    });
    this.#reconnecting = operation;
    return operation;
  }
  async markRead(channelId: TeamChannelId, throughMessageId: TeamMessageId): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const known = this.#snapshot.sidebar?.channels.find(
      (row) => row.channel.id === channelId,
    )?.lastReadMessageId;
    if (known && BigInt(known) >= BigInt(throughMessageId)) return;
    const lifetime = this.#lifetime;
    await this.rpc["commands.dispatch"]({
      type: "team.channel.read",
      channelId,
      throughMessageId,
    }).then(unwrapRpcResult);
    if (lifetime !== this.#lifetime) return;
    await this.refreshSidebar();
  }
  typing(channelId: TeamChannelId, rootId: TeamMessageId | null, typing: boolean): void {
    const key = JSON.stringify([channelId, rootId]),
      now = Date.now();
    if (typing && now - (this.#typingAt.get(key) ?? -Infinity) < 3000) return;
    this.#typingAt.set(key, now);
    this.#send({ type: "team.typing", channelId, rootId, typing });
  }
  presence(visible: boolean, watchedUserIds: readonly UserId[], force = false): void {
    const now = Date.now();
    if (!force && now - this.#presenceAt < 30000) return;
    this.#presenceAt = now;
    this.#send({ type: "team.presence", visible, watchedUserIds: watchedUserIds.slice(0, 50) });
  }
  async search(input: SearchInput): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const generation = ++this.#searchGeneration,
      lifetime = this.#lifetime;
    const search = await this.rpc["team.search"]({ input }).then(unwrapRpcResult);
    if (generation === this.#searchGeneration && lifetime === this.#lifetime)
      this.#update({ search });
  }
  async file(
    file: z.infer<typeof TeamFileSchema>,
    open = false,
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    if (this.#removed || this.#disposed) return null;
    const part = open ? "original" : "preview";
    if (!open && !file.preview) return null;
    const key = `${file.id}:${part}`,
      cached = this.#files.get(key);
    if (cached) return cached;
    if (!this.#options.readFile) throw new Error("The platform has no team file transport.");
    const lifetime = this.#lifetime,
      contentGeneration = this.#contentGeneration;
    const blob = await this.#options.readFile(file, part, signal);
    if (blob.size > (open ? teamUploadMaxBytes : teamPreviewMaxBytes))
      throw new Error("Team file exceeds its byte bound.");
    if (
      lifetime !== this.#lifetime ||
      contentGeneration !== this.#contentGeneration ||
      this.#removed
    )
      return null;
    if (blob.size <= 32 * 1024 * 1024) {
      while (this.#fileBytes + blob.size > 32 * 1024 * 1024) {
        const first = this.#files.entries().next().value;
        if (!first) break;
        this.#files.delete(first[0]);
        this.#fileBytes -= first[1].size;
      }
      this.#files.set(key, blob);
      this.#fileBytes += blob.size;
    }
    return blob;
  }
  async upload(input: TeamFileUpload) {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    if (!this.#options.uploadFile) throw new Error("The platform has no team upload transport.");
    const lifetime = this.#lifetime,
      generation = this.#contentGeneration;
    const file = await this.#options.uploadFile(input);
    if (lifetime !== this.#lifetime || generation !== this.#contentGeneration)
      throw new Error("Team access changed during the upload.");
    return file;
  }
  async registerNotificationPreview(
    input: Omit<Extract<HostApiCommandInput, { type: "notification.preview.register" }>, "type">,
  ): Promise<void> {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    const result = await this.rpc["commands.dispatch"]({
      type: "notification.preview.register",
      ...input,
    }).then(unwrapRpcResult);
    if (result.type !== "notification.preview.register")
      throw new Error("Notification registration result mismatch.");
  }
  disconnect(): void {
    this.#connectionGeneration++;
    this.#connected = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#update({ connection: "offline", typing: {}, presence: {} });
  }
  async remove(): Promise<void> {
    this.#removed = true;
    this.#lifetime++;
    this.disconnect();
    this.#files.clear();
    this.#fileBytes = 0;
    this.#update({
      bootstrap: null,
      sidebar: null,
      channel: null,
      thread: null,
      pending: [],
      drafts: {},
      search: null,
    });
    await this.#persist.catch(() => undefined);
    await this.#options.persistence.remove(this.#options.scope);
  }
  dispose(): void {
    this.#disposed = true;
    this.#lifetime++;
    this.disconnect();
    this.#listeners.clear();
  }
}
