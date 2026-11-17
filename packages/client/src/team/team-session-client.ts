import { observeRpcAuthentication } from "../host/host-api-client.js";
import {
  presentActionFailure,
  presentMessageRejection,
  presentReadFailure,
} from "../feedback/client-issue.js";
import {
  createConnectionController,
  type ConnectionAttempt,
  type ConnectionLease,
  type ConnectionController,
} from "../connections/connection-controller.js";
import { classifyClientFailure } from "../connections/operation-error.js";
import { HostTransportError } from "../connections/host-transport-error.js";
import type { ClientLifecycle } from "../host/lifecycle.js";
import { mergeTeamPeople, type TeamRemotePeople } from "./shared-channels.js";
import type { TeamRuntimeOwner } from "./team-runtime-owner.js";
import type { AccountProfileRelay } from "./account-profile-relay.js";
import { bootstrapMembershipRefused, teamEntryRefusalOutcome } from "@opensteer/protocol";
import type { TeamFileUpload } from "./files.js";
import {
  compareSequence,
  OpensteerError,
  type TeamChannelId,
  type TeamMessageId,
  type UserId,
  type TeamAskOutcome,
} from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import {
  readTeamFrame,
  TeamServerFrameViewSchema,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
  type HostApiClient,
  type HostApiCommandInput,
  type TeamMessage,
  type TeamChannel,
  type TeamAgentRecipient,
  type TeamMember,
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
  reduceTeamLinkPresence,
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
  readonly people?: TeamRemotePeople;
  readonly peopleByChannel?: Readonly<Record<string, TeamRemotePeople>>;
  readonly handlesByChannel?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly sendErrors?: Readonly<Record<string, unknown>>;
  readonly agentRecipients: readonly TeamAgentRecipient[];
  readonly bootstrap: TeamBootstrap | null;
  readonly sidebar: TeamSidebar | null;
  readonly channel: TeamTimeline | null;
  readonly thread: TeamTimeline | null;
  /** The socket's state; `offline` between a close and the next attempt, however brief. */
  readonly connection: "offline" | "connecting" | "connected";
  /**
   * Nothing reaches the team: out of reach for longer than a server swap takes, or
   * disconnected on purpose. What "Can't reach" and waiting sends read.
   */
  readonly unreachable: boolean;
  /** Set while the team refuses this app's protocol version, until a check succeeds. */
  readonly versionRefusal: TeamVersionRefusal | null;
  /** Moves on each reconnect after a close; views without a live stream read again. */
  readonly resumedGeneration: number;
  readonly pending: readonly PendingTeamSend[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly typing: Readonly<Record<string, readonly string[]>>;
  readonly presence: Readonly<Record<string, boolean>>;
  readonly search: SearchPage | null;
  readonly sendNotices: Readonly<Record<string, readonly TeamAskOutcome[]>>;
  readonly error: string | null;
  readonly refusalReason?: string | undefined;
  readonly ended: "removed" | "sign-in" | "viewer-changed" | null;
  readonly contentGeneration: number;
  /** Members renamed since the directory was read; readers lay these over it. */
  readonly memberUpdates?: Readonly<Record<string, TeamMember>>;
}
export interface TeamSessionOptions {
  readonly lifecycle?: ClientLifecycle;
  readonly name?: string;
  readonly loginId?: string;
  readonly authorityKey?: string;
  readonly owner?: TeamRuntimeOwner;
  readonly scope: TeamCacheScope;
  readonly rpc: HostApiClient;
  readonly persistence: TeamPersistence;
  /** Upgrade-only state, adopted after authenticated bootstrap confirms this viewer. */
  readonly connect: () => WebSocketClient;
  readonly readFile?: (
    file: z.infer<typeof TeamFileSchema>,
    part: "preview" | "original",
    signal?: AbortSignal,
  ) => Promise<Blob>;
  readonly uploadFile?: (input: TeamFileUpload) => Promise<z.infer<typeof TeamFileSchema>>;
  readonly notify?: (entry: TeamSidebar["channels"][number], current: () => boolean) => void;
  /** Spreads reconnects; tests pin it. */
  readonly random?: () => number;
  /** The signed-in person's Account name, relayed when this team's copy is older. */
  readonly profiles?: AccountProfileRelay;
}
function refusedSend(error: unknown): error is OpensteerError {
  return (
    error instanceof OpensteerError &&
    !error.retryable &&
    ["bad_request", "conflict", "forbidden", "not_found", "resource_exhausted"].includes(error.code)
  );
}

/** Longer than a planned server swap, so a swap never reads as out of reach. */
/** WebSocket close codes the team server sends: a planned restart, or a refusal. */
const restartingCloseCode = 1012;
const memberNamesBound = 1_000;

export type TeamVersionRefusal = "update-app" | "update-server";
/** Which side must update, from a refusal's `reason`. */
export function teamVersionRefusal(reason: string | null | undefined): TeamVersionRefusal | null {
  if (reason === "host-too-old") return "update-server";
  return ["client-too-old", "unsupported-version", "api-version-mismatch"].includes(reason ?? "")
    ? "update-app"
    : null;
}

export class TeamSessionClient {
  readonly #loginId = globalThis.crypto.randomUUID();
  readonly connection: ConnectionController;
  readonly #releaseAuthentication: () => void;
  #synchronize: ((key: string) => void) | null = null;
  #needsRevalidation = false;
  readonly #probeAnswers = new Set<() => void>();
  readonly rpc: HostApiClient;
  readonly owner: TeamRuntimeOwner | undefined;
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly #releaseOwner: (() => void) | undefined;
  readonly #options: TeamSessionOptions;
  /** Who this session reads as; unlike the bootstrap, it survives the session ending. */
  get scope(): TeamCacheScope {
    return this.#options.scope;
  }
  readonly #listeners = new Set<() => void>();
  #snapshot: TeamSessionSnapshot = {
    people: {},
    peopleByChannel: {},
    handlesByChannel: {},
    sendErrors: {},
    agentRecipients: [],
    bootstrap: null,
    sidebar: null,
    channel: null,
    thread: null,
    connection: "offline",
    unreachable: false,
    versionRefusal: null,
    resumedGeneration: 0,
    pending: [],
    drafts: {},
    typing: {},
    presence: {},
    search: null,
    sendNotices: {},
    error: null,
    ended: null,
    contentGeneration: 0,
  };
  #socket: WebSocketClient | null = null;
  #generation = 0;
  #lifetime = 0;
  #searchGeneration = 0;
  #persist: Promise<void> = Promise.resolve();
  #reconnecting: Promise<void> | null = null;
  #opened = false;
  /** The names revision last caught up to (null: read again); renames in between arrive as frames. */
  #namesRevision: string | null | undefined;
  #namesRead = 0;
  #removed = false;
  #removal: Promise<void> | null = null;
  #disposed = false;
  #loading: Promise<void> | null = null;
  #stateRevision = 0;
  readonly #editedDrafts = new Set<string>();
  #typingAt = new Map<string, number>();
  #presenceAt = -Infinity;
  #files = new Map<string, Blob>();
  #fileBytes = 0;
  #contentGeneration = 0;
  #connectionGeneration = 0;
  #sidebarGeneration = 0;
  #landingGeneration = 0;
  #searchInput: SearchInput | null = null;
  #searchMore: Promise<void> | null = null;
  constructor(options: TeamSessionOptions) {
    this.owner = options.owner;
    this.signal = options.owner
      ? AbortSignal.any([options.owner.signal, this.#controller.signal])
      : this.#controller.signal;
    this.#options = options;
    this.connection = createConnectionController({
      driver: { connect: (attempt) => this.openConnection(attempt) },
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.random ? { random: options.random } : {}),
      presentation: { name: options.name ?? null, target: "team", route: "private-network" },
    });
    this.connection.subscribe(() => {
      const state = this.connection.getSnapshot();
      if (
        (state.showInterruption && state.issue?.code === "connection") !==
        this.#snapshot.unreachable
      )
        this.#update({ unreachable: state.showInterruption && state.issue?.code === "connection" });
    });
    this.rpc = options.owner ? options.owner.rpc(options.rpc) : options.rpc;
    this.#releaseAuthentication = observeRpcAuthentication(options.rpc, () => {
      void this.remove("sign-in").catch(() => undefined);
    });
    this.#releaseOwner = options.owner?.own(() => this.dispose());
    this.#releaseProfiles = options.profiles?.subscribe(() => void this.#relayProfile());
  }
  readonly #releaseProfiles: (() => void) | undefined;
  /** A bootstrap read before a rename frame arrived never puts the viewer's old name back. */
  #withNewerOwnName(bootstrap: TeamBootstrap): TeamBootstrap {
    const update = this.#snapshot.memberUpdates?.[bootstrap.member.userId];
    if (!update || (update.nameRevision ?? 0) <= (bootstrap.member.nameRevision ?? 0))
      return bootstrap;
    return {
      ...bootstrap,
      member: {
        ...bootstrap.member,
        displayName: update.displayName,
        nameRevision: update.nameRevision,
      },
    };
  }
  /** Best effort: a team that misses it gets the name at the next attach or sign-in. */
  async #relayProfile(): Promise<void> {
    const member = this.#snapshot.bootstrap?.member;
    if (!member || !this.#options.profiles || this.#removed || this.#disposed) return;
    await this.#options.profiles
      .relay({
        nameRevision: member.nameRevision,
        apply: (receipt) =>
          this.rpc["commands.dispatch"]({ type: "team.member.profile.apply", receipt }),
      })
      .catch(() => undefined);
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
  #peoplePatch(
    people: TeamRemotePeople | undefined,
    channelId: TeamChannelId,
    channel?: TeamChannel,
  ) {
    const handles = { ...this.#snapshot.handlesByChannel?.[channelId] };
    if (channel) {
      delete handles[this.scope.userId];
      if (channel.share?.viewerHandle) handles[this.scope.userId] = channel.share.viewerHandle;
    }
    return {
      handlesByChannel: { ...this.#snapshot.handlesByChannel, [channelId]: handles },
      people: mergeTeamPeople(this.#snapshot.people ?? {}, people),
      peopleByChannel: {
        ...this.#snapshot.peopleByChannel,
        [channelId]: mergeTeamPeople(this.#snapshot.peopleByChannel?.[channelId] ?? {}, people),
      },
    };
  }
  async load(connect = true): Promise<void> {
    if (this.#removed || this.#disposed) return;
    if (!this.#loading) {
      const lifetime = this.#lifetime,
        revision = this.#stateRevision;
      this.#loading = (async () => {
        const [saved, bootstrap] = await Promise.all([
          this.#options.persistence.load(this.#options.scope),
          this.#bootstrap(),
        ]);
        if (lifetime !== this.#lifetime) return;
        if (
          bootstrap.teamId !== this.#options.scope.teamDeploymentId ||
          bootstrap.member.userId !== this.#options.scope.userId
        ) {
          await this.remove("viewer-changed");
          return;
        }
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
        this.#namesRevision ??= bootstrap.sidebar.namesRevision;
        this.#update({
          bootstrap: this.#withNewerOwnName(bootstrap),
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
      })()
        .catch(async (error: unknown) => {
          await this.#authorizationFailure(error);
          throw error;
        })
        .finally(() => {
          this.#loading = null;
        });
    }
    await this.#loading;
    this.connection.setPresentation({
      ...this.connection.getSnapshot(),
      name: this.#snapshot.bootstrap?.teamName ?? this.connection.getSnapshot().name,
    });
    if (connect) this.connect();
    void this.#relayProfile();
  }
  connect(): void {
    if (!this.#removed && !this.#disposed) {
      if (this.connection.getSnapshot().phase === "blocked") this.connection.retry();
      else this.connection.start();
    }
  }
  async openConnection(attempt: ConnectionAttempt): Promise<ConnectionLease> {
    attempt.signal.throwIfAborted();
    if (!this.#snapshot.bootstrap) await this.load(false);
    else if (this.#needsRevalidation && !(await this.#revalidate())) {
      if (this.#removed)
        throw new OpensteerError({ code: "unauthorized", message: "Sign in to continue." });
      if (this.#snapshot.versionRefusal)
        throw new OpensteerError({
          code: "bad_request",
          reason:
            this.#snapshot.versionRefusal === "update-app" ? "client-too-old" : "host-too-old",
          message: "An update is needed.",
        });
      throw new HostTransportError("unreachable");
    }
    attempt.signal.throwIfAborted();
    attempt.acceptScope({
      authorityKey: this.#options.authorityKey ?? this.scope.teamDeploymentId,
      deploymentId: this.scope.teamDeploymentId,
      viewerId: this.scope.userId,
      loginId: this.#options.loginId ?? this.owner?.id ?? this.#loginId,
    });
    return new Promise((resolve, reject) => {
      const required = new Set([
        "sidebar",
        ...[this.#snapshot.channel, this.#snapshot.thread].flatMap((view) =>
          view ? [teamScopeKey(view.scope)] : [],
        ),
      ]);
      let admitted = false;
      let finish!: (failure: ReturnType<typeof classifyClientFailure>) => void;
      const closed = new Promise<ReturnType<typeof classifyClientFailure>>((done) => {
        finish = done;
      });
      const release = () => {
        attempt.signal.removeEventListener("abort", abort);
        this.#synchronize = null;
      };
      const close = () => {
        release();
        const current = this.#socket;
        this.#socket = null;
        current?.close();
        this.#update({ connection: "offline", typing: {}, presence: {} });
      };
      const fail = (error: unknown) => {
        close();
        attempt.fail?.(classifyClientFailure(error));
        if (admitted) finish(classifyClientFailure(error));
        else reject(error);
      };
      const abort = () => fail(attempt.signal.reason);
      const socket = this.#options.connect();
      this.#socket = socket;
      let progressAt = Date.now();
      const lease: ConnectionLease = {
        closed,
        lastProgressAt: () => progressAt,
        close,
        probe: (signal) =>
          new Promise<void>((done, refused) => {
            const answered = () => {
              signal.removeEventListener("abort", cancelled);
              this.#probeAnswers.delete(answered);
              done();
            };
            const cancelled = () => {
              this.#probeAnswers.delete(answered);
              refused(signal.reason);
            };
            signal.addEventListener("abort", cancelled, { once: true });
            this.#probeAnswers.add(answered);
            this.#subscribe(null);
          }),
      };
      attempt.signal.addEventListener("abort", abort, { once: true });
      this.#synchronize = (key) => {
        required.delete(key);
        if (required.size || admitted || this.#socket !== socket) return;
        admitted = true;
        this.#needsRevalidation = false;
        const resumed = this.#opened;
        this.#opened = true;
        this.#update({
          connection: "connected",
          error: null,
          ...(resumed ? { resumedGeneration: this.#snapshot.resumedGeneration + 1 } : {}),
        });
        attempt.admit?.(lease);
        resolve(lease);
        void this.reconcilePending().catch(() => undefined);
      };
      this.#update({ connection: "connecting", error: null });
      socket.addEventListener("open", () => {
        if (this.#socket !== socket) return;
        this.#subscribe(null);
        if (this.#snapshot.channel) this.#subscribe(this.#snapshot.channel);
        if (this.#snapshot.thread) this.#subscribe(this.#snapshot.thread);
      });
      socket.addEventListener("message", (event) => {
        if (this.#socket !== socket || typeof event.data !== "string") return;
        try {
          if (event.data.length > 512 * 1024) throw new Error("Team frame exceeds its byte bound.");
          const frame = readTeamFrame(TeamServerFrameViewSchema, JSON.parse(event.data));
          if (frame) {
            progressAt = Date.now();
            this.receive(frame);
          }
        } catch {
          this.#needsRevalidation = true;
          fail(new HostTransportError("unreachable"));
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.#socket !== socket) return;
        this.#connectionGeneration++;
        this.#needsRevalidation = event.code !== restartingCloseCode;
        if (event.code === 1008) {
          void this.#revalidate().then((accepted) => {
            if (accepted) fail(new HostTransportError("unreachable"));
            else
              fail(
                new OpensteerError({
                  code: this.#removed ? "unauthorized" : "bad_request",
                  message: "Access needs to be checked.",
                  ...(this.#snapshot.versionRefusal
                    ? {
                        reason:
                          this.#snapshot.versionRefusal === "update-app"
                            ? "client-too-old"
                            : "host-too-old",
                      }
                    : {}),
                }),
              );
          }, fail);
        } else fail(new HostTransportError("unreachable"));
      });
      socket.addEventListener("error", () => {
        if (this.#socket === socket) fail(new HostTransportError("unreachable"));
      });
    });
  }
  async #bootstrap() {
    try {
      return await this.rpc["team.bootstrap.get"]({}).then(unwrapRpcResult);
    } catch (error) {
      if (error instanceof OpensteerError && !error.reason && bootstrapMembershipRefused(error))
        await this.remove("removed");
      throw error;
    }
  }
  async #authorizationFailure(error: unknown): Promise<void> {
    if (!(error instanceof OpensteerError)) return;
    const versionRefusal = teamVersionRefusal(error.reason);
    if (versionRefusal) {
      this.#update({ versionRefusal });
      return;
    }
    const refusal = teamEntryRefusalOutcome(error.reason);
    if (refusal === "retryable") return;
    if (refusal === "membership") {
      this.#update({ refusalReason: error.reason });
      await this.remove("removed");
    } else if (error.code === "unauthorized") await this.remove("sign-in");
  }
  /** Whether the viewer still belongs here; a failed check settles false. */
  async #revalidate(): Promise<boolean> {
    const lifetime = this.#lifetime;
    try {
      const bootstrap = await this.#bootstrap();
      if (lifetime !== this.#lifetime) return false;
      if (
        bootstrap.teamId !== this.#options.scope.teamDeploymentId ||
        bootstrap.member.userId !== this.#options.scope.userId
      ) {
        await this.remove("viewer-changed");
        return false;
      }
      if (this.#snapshot.sidebar?.accessRevision !== bootstrap.sidebar.accessRevision) {
        this.receive({
          type: "team.access.changed",
          accessRevision: bootstrap.sidebar.accessRevision,
        });
        const selected = this.#snapshot.channel;
        if (selected) {
          try {
            await this.rpc["team.channel.get"]({ channelId: selected.scope.channelId }).then(
              unwrapRpcResult,
            );
          } catch (error) {
            if (lifetime !== this.#lifetime) return false;
            if (
              !(error instanceof OpensteerError) ||
              !["forbidden", "not_found"].includes(error.code)
            )
              throw error;
            const channelId = selected.scope.channelId;
            this.selectChannel(null);
            this.#update({
              pending: this.#snapshot.pending.filter((row) => row.command.channelId !== channelId),
              drafts: Object.fromEntries(
                Object.entries(this.#snapshot.drafts).filter(([key]) => {
                  try {
                    const parsed: unknown = JSON.parse(key);
                    return !Array.isArray(parsed) || parsed[1] !== channelId;
                  } catch {
                    return true;
                  }
                }),
              ),
            });
            await this.#save();
          }
        }
      }
      if (lifetime === this.#lifetime) {
        this.#update({
          bootstrap: this.#withNewerOwnName(bootstrap),
          sidebar: monotonicTeamSidebar(this.#snapshot.sidebar, bootstrap.sidebar),
          versionRefusal: null,
        });
        this.#catchUpNames(bootstrap.sidebar.namesRevision);
        // A relay that failed or was missed while away is tried again.
        void this.#relayProfile();
      }
      return true;
    } catch (error) {
      if (lifetime === this.#lifetime) await this.#authorizationFailure(error);
      return false;
    }
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
    // A thread's failure is read while it waits for its root, so a new one starts clear.
    this.#update(thread ? { thread, error: null } : { thread });
    if (thread) {
      this.#subscribe(thread);
      const lifetime = this.#lifetime;
      void this.rpc["team.message.get"]({ channelId, messageId: rootId! })
        .then(unwrapRpcResult)
        .then((root) => {
          const current = this.#snapshot.thread;
          if (lifetime !== this.#lifetime || current?.generation !== thread.generation) return;
          if (root.threadRootId !== null) throw new Error("A thread must open from its root.");
          this.#update({
            thread: {
              ...current,
              messages: [root, ...current.messages.filter((row) => row.id !== root.id).slice(-299)],
            },
          });
        })
        .catch((error: unknown) => {
          if (
            lifetime === this.#lifetime &&
            this.#snapshot.thread?.generation === thread.generation
          ) {
            this.#update({
              error: presentReadFailure(error, "this thread") || null,
            });
          }
        });
    } else
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
    const selectedRoot = selected.scope.kind === "thread" ? selected.scope.rootId : null;
    const replies = selected.messages.filter((row) => row.id !== selectedRoot);
    const anchor = direction === "before" ? replies[0]?.id : replies.at(-1)?.id;
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
    this.#update({
      ...this.#peoplePatch(result.people, selected.scope.channelId, result.channel),
      [view]: reduceTeamPage(current, result, selected.generation, direction),
    });
  }
  async landMessage(
    channelId: TeamChannelId,
    messageId: TeamMessageId,
  ): Promise<TeamMessage | null> {
    if (this.#removed || this.#disposed) return null;
    const lifetime = this.#lifetime,
      content = this.#contentGeneration,
      selection = this.#generation,
      landing = ++this.#landingGeneration;
    const message = await this.rpc["team.message.get"]({ channelId, messageId }).then(
      unwrapRpcResult,
    );
    if (
      lifetime !== this.#lifetime ||
      content !== this.#contentGeneration ||
      selection !== this.#generation ||
      landing !== this.#landingGeneration
    )
      return null;
    if (this.#snapshot.channel?.scope.channelId !== channelId) this.selectChannel(channelId);
    const rootId = message.threadRootId;
    if (
      rootId &&
      (this.#snapshot.thread?.scope.kind !== "thread" ||
        this.#snapshot.thread.scope.rootId !== rootId)
    )
      this.selectThread(channelId, rootId);
    if (!rootId && this.#snapshot.thread) this.selectThread(channelId, null);
    const view = rootId ? "thread" : "channel",
      selected = this.#snapshot[view];
    if (!selected) return null;
    const read = (direction: "before" | "after") =>
      selected.scope.kind === "channel"
        ? this.rpc["team.messages.page"]({ channelId, page: { direction, messageId } }).then(
            unwrapRpcResult,
          )
        : this.rpc["team.thread.page"]({
            channelId,
            rootId: selected.scope.rootId,
            page: { direction, messageId },
          }).then(unwrapRpcResult);
    const [before, after] = await Promise.all([read("before"), read("after")]);
    const current = this.#snapshot[view];
    if (
      lifetime !== this.#lifetime ||
      content !== this.#contentGeneration ||
      current?.generation !== selected.generation ||
      landing !== this.#landingGeneration
    )
      return null;
    let next = reduceTeamPage(
      { ...current, messages: current.messages.filter((row) => rootId && row.id === rootId) },
      before,
      selected.generation,
      "before",
    );
    next = reduceTeamPage(
      next,
      { ...after, messages: [message, ...after.messages] },
      selected.generation,
      "after",
    );
    this.#update({
      ...this.#peoplePatch(
        mergeTeamPeople(mergeTeamPeople(message.people ?? {}, before.people), after.people),
        channelId,
        after.channel,
      ),
      [view]: { ...next, hasMore: before.hasMore, anchorId: message.id },
    });
    return message;
  }
  async pinnedMessages(channelId: TeamChannelId) {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    const lifetime = this.#lifetime,
      content = this.#contentGeneration;
    const page = unwrapRpcResult(await this.rpc["team.pins.page"]({ channelId }));
    if (lifetime !== this.#lifetime || content !== this.#contentGeneration)
      throw new Error("Team access changed.");
    this.#update({ ...this.#peoplePatch(page.people, channelId) });
    return page;
  }
  async shareParticipants(input: {
    readonly channelId: TeamChannelId;
    readonly after?: string;
    readonly query?: string;
  }) {
    if (this.#removed || this.#disposed) return null;
    const lifetime = this.#lifetime,
      content = this.#contentGeneration;
    const page = unwrapRpcResult(await this.rpc["team.share.participants.get"](input));
    if (lifetime !== this.#lifetime || content !== this.#contentGeneration) return null;
    this.#update({
      ...this.#peoplePatch(page.people, input.channelId),
      handlesByChannel: {
        ...this.#snapshot.handlesByChannel,
        [input.channelId]: {
          ...this.#snapshot.handlesByChannel?.[input.channelId],
          ...Object.fromEntries(page.participants.map((person) => [person.userId, person.handle])),
        },
      },
    });
    return page;
  }
  async setAgentRecipient(
    channelId: TeamChannelId,
    rootId: TeamMessageId,
    enabled: boolean,
  ): Promise<void> {
    if (this.#removed || this.#disposed) throw new Error("Team session ended.");
    const lifetime = this.#lifetime;
    const contentGeneration = this.#contentGeneration;
    await this.rpc["commands.dispatch"]({
      type: "team.agent.recipient.set",
      channelId,
      rootId,
      enabled,
    }).then(unwrapRpcResult);
    if (lifetime !== this.#lifetime) return;
    const recipient = await this.rpc["team.agent.recipient.get"]({ channelId, rootId }).then(
      unwrapRpcResult,
    );
    if (lifetime === this.#lifetime && contentGeneration === this.#contentGeneration)
      this.#applyRecipients([recipient]);
  }
  #applyRecipients(recipients: readonly TeamAgentRecipient[]): void {
    const merged = new Map(
      this.#snapshot.agentRecipients.map((row) => [`${row.channelId}:${row.rootId}`, row]),
    );
    for (const row of recipients) {
      const key = `${row.channelId}:${row.rootId}`;
      const prior = merged.get(key);
      if (!prior || BigInt(row.version) >= BigInt(prior.version)) merged.set(key, row);
    }
    this.#update({ agentRecipients: [...merged.values()].slice(-1000) });
  }
  receive(frame: z.infer<typeof TeamServerFrameViewSchema>): void {
    if (this.#removed) return;
    switch (frame.type) {
      case "team.agent.recipient":
        this.#applyRecipients([frame.recipient]);
        break;
      case "team.member.updated":
        this.#applyNames([frame.member]);
        break;
      case "team.cut": {
        const view = frame.cut.scope.kind === "channel" ? "channel" : "thread";
        const held = this.#snapshot[view];
        if (!held) return;
        const next = reduceTeamCut(held, frame.cut);
        if (next !== held) {
          this.#update({
            ...this.#peoplePatch(frame.cut.people, frame.cut.scope.channelId, frame.cut.channel),
            [view]: next,
          });
          this.#applyRecipients(frame.cut.agentRecipients);
          this.#synchronize?.(teamScopeKey(frame.cut.scope));
          if (
            frame.cut.type === "snapshot" &&
            held.anchorId &&
            (view === "thread" || !this.#snapshot.thread)
          )
            void this.landMessage(held.scope.channelId, held.anchorId).catch(() => undefined);
        }
        break;
      }
      case "team.sidebar": {
        // Sent as a socket subscribes, so it also tells what moved while it was away.
        const held = this.#snapshot.sidebar;
        if (held && compareSequence(frame.sidebar.accessRevision, held.accessRevision) > 0)
          this.receive({
            type: "team.access.changed",
            accessRevision: frame.sidebar.accessRevision,
          });
        this.#applySidebar(frame.sidebar);
        this.#catchUpNames(frame.sidebar.namesRevision);
        this.#synchronize?.("sidebar");
        for (const answer of this.#probeAnswers) answer();
        break;
      }
      case "team.sidebar.dirty":
        void this.#refreshSidebarRows(frame.channelIds).catch(() => undefined);
        break;
      case "team.access.changed": {
        this.#contentGeneration++;
        // Content is hidden until a new authorized cut; old pages cannot reinstall it.
        const channel = this.#snapshot.channel,
          thread = this.#snapshot.thread;
        this.#update({
          people: {},
          peopleByChannel: {},
          handlesByChannel: {},
          agentRecipients: [],
          sidebar: null,
          channel: channel ? emptyTeamTimeline("channel", ++this.#generation, channel.scope) : null,
          thread: thread ? emptyTeamTimeline("thread", ++this.#generation, thread.scope) : null,
          search: null,
          contentGeneration: this.#contentGeneration,
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
        this.#update({
          channel: reduceTeamLinkPresence(this.#snapshot.channel, frame.userId, frame.online),
          thread: reduceTeamLinkPresence(this.#snapshot.thread, frame.userId, frame.online),
        });
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
  /** Renames commit and publish independently, so an older one can arrive last. */
  #applyNames(members: readonly TeamMember[]): void {
    let updates = this.#snapshot.memberUpdates;
    for (const member of members) {
      const held = updates?.[member.userId];
      if ((member.nameRevision ?? 0) <= (held?.nameRevision ?? 0)) continue;
      updates = { ...updates, [member.userId]: member };
    }
    if (updates === this.#snapshot.memberUpdates || !updates) return;
    const bootstrap = this.#snapshot.bootstrap;
    const self = bootstrap ? updates[bootstrap.member.userId] : undefined;
    this.#update({
      memberUpdates: updates,
      ...(bootstrap && self && (self.nameRevision ?? 0) > (bootstrap.member.nameRevision ?? 0)
        ? {
            bootstrap: {
              ...bootstrap,
              member: {
                ...bootstrap.member,
                displayName: self.displayName,
                nameRevision: self.nameRevision,
              },
            },
          }
        : {}),
    });
  }
  /** Renames made while away were never announced to this session: read the names again. */
  #catchUpNames(namesRevision: string | undefined): void {
    if (namesRevision === undefined || namesRevision === this.#namesRevision) return;
    const first = this.#namesRevision === undefined;
    this.#namesRevision = namesRevision;
    if (first) return;
    const lifetime = this.#lifetime,
      read = ++this.#namesRead;
    void (async () => {
      const members: TeamMember[] = [];
      let after: UserId | undefined;
      do {
        const page = await this.rpc["team.members.list"](after ? { after } : {}).then(
          unwrapRpcResult,
        );
        if (lifetime !== this.#lifetime || read !== this.#namesRead) return;
        members.push(...page.members);
        after = page.hasMore ? page.members.at(-1)?.userId : undefined;
      } while (after && members.length < memberNamesBound);
      this.#applyNames(members);
    })().catch(() => {
      // The next catch-up reads them; a held revision would otherwise hide the miss.
      if (read === this.#namesRead) this.#namesRevision = null;
    });
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
    const lifetime = this.#lifetime;
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
        this.#options.notify?.(
          entry,
          () => !this.#disposed && !this.#removed && lifetime === this.#lifetime,
        );
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
    this.#applySidebar(
      { ...current, totalMentionCount: page.totalMentionCount, channels: rows.slice(0, 1000) },
      true,
      false,
    );
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
      failure: null,
    };
    const noticeKey = teamScopeKey(
      pending.command.threadRootId
        ? {
            kind: "thread",
            channelId: pending.command.channelId,
            rootId: pending.command.threadRootId,
          }
        : { kind: "channel", channelId: pending.command.channelId },
    );
    const sendNotices = { ...this.#snapshot.sendNotices };
    delete sendNotices[noticeKey];
    this.#update({ sendNotices, pending: [...this.#snapshot.pending, pending] });
    try {
      await this.#save();
    } catch (error) {
      this.#update({ pending: this.#snapshot.pending.filter((row) => row !== pending) });
      throw error;
    }
    if (this.#snapshot.connection === "connected")
      void this.#transmit(pending, this.#lifetime).catch((error: unknown) =>
        this.#update({
          error: presentActionFailure(error),
        }),
      );
    return pending.command.clientMessageId;
  }
  async discardPending(clientMessageId: string): Promise<void> {
    if (this.#removed || this.#disposed) return;
    const errors = { ...this.#snapshot.sendErrors };
    delete errors[clientMessageId];
    this.#update({
      sendErrors: errors,
      pending: this.#snapshot.pending.filter(
        (row) => row.command.clientMessageId !== clientMessageId,
      ),
    });
    await this.#save();
  }
  async editPending(clientMessageId: string, text: string): Promise<void> {
    const pending = this.#snapshot.pending.find(
      (row) => row.command.clientMessageId === clientMessageId,
    );
    if (!pending?.failure) throw new Error("Only a refused message can be edited.");
    const scope: TeamScope = pending.command.threadRootId
      ? {
          kind: "thread",
          channelId: pending.command.channelId,
          rootId: pending.command.threadRootId,
        }
      : { kind: "channel", channelId: pending.command.channelId };
    await this.setDraft(scope, text);
    await this.discardPending(clientMessageId);
  }
  async #fail(sends: readonly PendingTeamSend[], error: OpensteerError): Promise<void> {
    const ids = new Set(sends.map((row) => row.command.clientMessageId));
    const { name, target } = this.connection.getSnapshot();
    const failure = presentMessageRejection({
      code: "rejected",
      reason: error.reason ?? error.code,
      ...(name ? { name } : {}),
      target,
    });
    this.#update({
      pending: this.#snapshot.pending.map((row) =>
        ids.has(row.command.clientMessageId) ? { ...row, failure } : row,
      ),
    });
    await this.#save();
  }
  async #transmit(pending: PendingTeamSend, lifetime: number): Promise<void> {
    const errors = { ...this.#snapshot.sendErrors };
    delete errors[pending.command.clientMessageId];
    this.#update({ sendErrors: errors });
    try {
      const result = await this.rpc["commands.dispatch"](pending.command).then(unwrapRpcResult);
      if (lifetime !== this.#lifetime || result.type !== "team.message.send") return;
      const key = teamScopeKey(
        pending.command.threadRootId
          ? {
              kind: "thread",
              channelId: pending.command.channelId,
              rootId: pending.command.threadRootId,
            }
          : { kind: "channel", channelId: pending.command.channelId },
      );
      const refusals = result.askOutcomes.filter((outcome) => outcome.outcome !== "queued");
      if (refusals.length)
        this.#update({ sendNotices: { ...this.#snapshot.sendNotices, [key]: refusals } });
      await this.#confirm([result.message]);
    } catch (error) {
      if (lifetime !== this.#lifetime) return;
      if (!refusedSend(error)) {
        this.#update({
          sendErrors: { ...this.#snapshot.sendErrors, [pending.command.clientMessageId]: error },
        });
        throw error;
      }
      await this.#fail([pending], error);
    }
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
    const errors = { ...this.#snapshot.sendErrors };
    for (const id of confirmed) delete errors[id];
    this.#update({
      sendErrors: errors,
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
      const pending = this.#snapshot.pending.filter((row) => !row.failure);
      const channels = new Set(pending.map((send) => send.command.channelId));
      for (const channelId of channels) {
        const sends = pending.filter((send) => send.command.channelId === channelId);
        for (let index = 0; index < sends.length; index += 50) {
          const batch = sends.slice(index, index + 50);
          let stored;
          try {
            stored = await this.rpc["team.messages.check"]({
              channelId,
              clientMessageIds: batch.map((send) => send.command.clientMessageId),
            }).then(unwrapRpcResult);
          } catch (error) {
            if (!current()) return;
            if (!refusedSend(error)) throw error;
            await this.#fail(batch, error);
            continue;
          }
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
    this.#searchInput = input;
    this.#searchMore = null;
    this.#update({ search: null });
    const search = await this.rpc["team.search"]({ input }).then(unwrapRpcResult);
    if (generation === this.#searchGeneration && lifetime === this.#lifetime)
      this.#update({ people: mergeTeamPeople(this.#snapshot.people ?? {}, search.people), search });
  }
  loadMoreSearch(): Promise<void> {
    if (this.#searchMore) return this.#searchMore;
    const { search } = this.#snapshot,
      input = this.#searchInput;
    const before = search?.results.at(-1)?.message.id;
    if (this.#removed || this.#disposed || !input || !search?.hasMore || !before)
      return Promise.resolve();
    const generation = this.#searchGeneration,
      lifetime = this.#lifetime;
    const operation = this.rpc["team.search"]({ input: { ...input, before } })
      .then(unwrapRpcResult)
      .then((page) => {
        if (generation !== this.#searchGeneration || lifetime !== this.#lifetime) return;
        const results = [...search.results, ...page.results].filter(
          (row, index, rows) =>
            rows.findIndex((other) => other.message.id === row.message.id) === index,
        );
        this.#update({
          people: mergeTeamPeople(this.#snapshot.people ?? {}, page.people),
          search: { ...page, results },
        });
      })
      .finally(() => {
        if (this.#searchMore === operation) this.#searchMore = null;
      });
    this.#searchMore = operation;
    return operation;
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
    const blob = await this.#options.readFile(
      file,
      part,
      signal ? AbortSignal.any([signal, this.signal]) : this.signal,
    );
    if (blob.size > (open ? teamUploadMaxBytes : teamPreviewMaxBytes))
      throw new Error("Team file exceeds its byte bound.");
    if (
      lifetime !== this.#lifetime ||
      contentGeneration !== this.#contentGeneration ||
      this.#removed ||
      this.#disposed
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
    const file = await this.#options.uploadFile({
      ...input,
      signal: input.signal ? AbortSignal.any([input.signal, this.signal]) : this.signal,
    });
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
  async leave(): Promise<void> {
    if (!this.#snapshot.bootstrap) await this.load(false);
    const member = this.#snapshot.bootstrap?.member;
    if (!member) throw new Error("Sign in to the team before leaving it.");
    await this.rpc["commands.dispatch"]({ type: "team.member.remove", userId: member.userId }).then(
      unwrapRpcResult,
    );
    await this.remove();
  }
  disconnect(): void {
    this.#connectionGeneration++;
    this.connection.stop();
    const socket = this.#socket;
    this.#socket = null;
    this.#synchronize = null;
    socket?.close();
    this.#update({ connection: "offline", typing: {}, presence: {} });
  }
  remove(ended: TeamSessionSnapshot["ended"] = "removed"): Promise<void> {
    if (this.#disposed) return this.#removal ?? Promise.resolve();
    if (this.#removal) {
      if (ended !== "sign-in" && this.#snapshot.ended === "sign-in") {
        this.#update({ ended });
        this.#removal = this.#removal
          .catch(() => undefined)
          .then(() => this.#options.persistence.remove(this.scope));
      }
      return this.#removal;
    }
    this.#removal = this.#persist
      .catch(() => undefined)
      .then(() =>
        ended === "sign-in" ? undefined : this.#options.persistence.remove(this.#options.scope),
      );
    this.#removed = true;
    this.#controller.abort(new Error("Team session ended."));
    this.#lifetime++;
    this.disconnect();
    this.connection.invalidateScope();
    this.#files.clear();
    this.#fileBytes = 0;
    this.#searchInput = null;
    this.#searchMore = null;
    this.#typingAt.clear();
    this.#update({
      people: {},
      peopleByChannel: {},
      handlesByChannel: {},
      sendErrors: {},
      agentRecipients: [],
      bootstrap: null,
      sidebar: null,
      channel: null,
      thread: null,
      pending: [],
      sendNotices: {},
      drafts: {},
      search: null,
      ended,
      contentGeneration: ++this.#contentGeneration,
    });
    return this.#removal;
  }
  dispose(): void {
    if (this.#disposed) return;
    void this.remove("sign-in");
    this.#disposed = true;
    this.connection.dispose();
    this.#releaseOwner?.();
    this.#releaseAuthentication();
    this.#releaseProfiles?.();
    this.#listeners.clear();
  }
}
