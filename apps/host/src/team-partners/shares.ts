import {
  OpensteerError,
  SequenceSchema,
  type TeamActor,
  type TeamChannelId,
  type TeamMessageId,
} from "@opensteer/core";
import {
  TeamShareBatchSchema,
  TeamShareReceiptSchema,
  type TeamShareOperation,
} from "@opensteer/protocol";
import { TeamSharesStore, type Share } from "@opensteer/database/team-shares";
import { emptyTeamAccessEffects, requireTeam } from "@opensteer/database/team-access";
import {
  teamMessageViews,
  type TeamChatRelay,
  type TeamChatStore,
} from "@opensteer/database/team-chat";
import { setImmediate } from "node:timers/promises";
import type { TeamRequestsStore } from "@opensteer/database/team-requests";
import type { TeamPartners } from "./service.js";
import { teamShareFileView } from "@opensteer/database/team-files";
import type { TeamShareFiles } from "./files.js";

export class TeamShares implements TeamChatRelay {
  files: TeamShareFiles | undefined;
  readonly store: TeamSharesStore;
  readonly #connecting = new Map<string, Promise<void>>();
  readonly #pulling = new Map<string, Promise<void>>();
  readonly #dirty = new Set<string>();
  readonly #syncRetry = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #rosters = new Map<string, string>();
  readonly #rosterJobs = new Map<string, Promise<unknown>>();
  readonly #agentStates = new Map<string, string>();
  readonly #statusJobs = new Map<string, Promise<void>>();
  readonly #rates = new Map<string, { until: number; count: number }>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeAccess: () => void;
  readonly #unsubscribeRoster: () => void;
  readonly #unsubscribeRequests: () => void;

  #closed = false;
  readonly partners: TeamPartners;
  readonly chat: TeamChatStore;
  readonly onError: () => void;
  readonly requests: TeamRequestsStore;
  readonly generalChannel: () => Promise<TeamChannelId | null>;
  constructor(
    partners: TeamPartners,
    chat: TeamChatStore,
    requests: TeamRequestsStore,
    onError: () => void,
    generalChannel: () => Promise<TeamChannelId | null> = async () => null,
  ) {
    this.partners = partners;
    this.chat = chat;
    this.requests = requests;
    this.onError = onError;
    this.generalChannel = generalChannel;
    this.store = new TeamSharesStore(chat.access, chat);
    this.#unsubscribeAccess = chat.access.beforeAccessCommit((t, effects) =>
      this.store.reconcileAccess(t, effects),
    );
    this.#unsubscribeRoster = chat.access.onRevoke(() => this.refreshRosters());
    this.#unsubscribeRequests = chat.onRequestChange((event) => {
      if (event.kind === "cancelled")
        partners.lifetimes.close({ ...emptyTeamAccessEffects, requests: [event.requestId] });
    });
    chat.relay = this;
    partners.setDataHandler({
      receive: (id, op) => this.receive(id, op),
      reply: async (id, op, send) => {
        if (op.op === "end" || op.op === "offer") return send();
        const revision = this.chat.access.revision;
        const authorize = () =>
          op.op === "file" && this.files
            ? this.files.authorized(id, op).then(() => true)
            : this.store.db.transaction().execute(async (t) => {
                await this.store.scoped(t, id, op.shareId, op.generation);
                return true;
              });
        await authorize();
        await this.chat.access.handoff(revision, authorize, send);
      },
      changed: async (id, shareId, generation) => {
        this.admit(id, shareId);
        const s = await this.store.get(shareId);
        if (
          s.partnerLinkId !== id ||
          s.generation !== generation ||
          s.role !== "follower" ||
          s.state !== "active"
        )
          return;
        await this.sync(s);
      },
      connected: (id) => {
        const job = this.connected(id);
        this.#connecting.set(id, job);
        return job.finally(() => this.#connecting.delete(id));
      },
      revoked: (id) => this.revoked(id),
    });
    this.#unsubscribe = chat.onChange((id) => this.track(this.changed(id)));
  }
  track(p: Promise<unknown>) {
    this.#jobs.add(p);
    void p.catch(() => this.onError()).finally(() => this.#jobs.delete(p));
  }
  async offer(actor: TeamActor, channelId: TeamChannelId, linkId: string, confirmed: boolean) {
    requireTeam(
      channelId !== (await this.generalChannel()),
      "The default channel cannot be shared",
    );
    const s = await this.store.offer(actor, channelId, linkId, confirmed);
    if (s.localApproved) await this.deliverOffer(s);
    return { shareId: s.id };
  }
  async approve(actor: TeamActor, id: string) {
    await this.deliverOffer(await this.store.approve(actor, id));
  }
  async deliverOffer(s: Share) {
    if (s.channelId) await this.files?.files.prepareShare(s.channelId);
    return this.partners.request(s.partnerLinkId, {
      op: "offer",
      historyFromShareId: s.historyFromShareId,
      shareId: s.id,
      generation: s.generation,
      name: s.name,
      peopleOnly: s.peopleOnly,
    });
  }
  async accept(actor: TeamActor, id: string, input: Parameters<TeamChatStore["create"]>[1]) {
    const s = await this.store.prepareAccept(actor, id, input);
    await this.sendRoster(s, "accept");
    await this.store.activate(id);
    await this.sync(await this.store.get(id));
    return {
      channel: await this.chat.read(actor, "read", input.id, (t) =>
        this.chat.channelView(t, actor, input.id),
      ),
    };
  }
  admit(linkId: string, shareId: string) {
    const key = `${linkId}:${shareId}`;
    const now = Date.now();
    let rate = this.#rates.get(key);
    if (!rate || rate.until <= now) {
      if (this.#rates.size >= 4096) {
        for (const [k, v] of this.#rates) if (v.until <= now) this.#rates.delete(k);
        if (this.#rates.size >= 4096)
          throw new OpensteerError({
            code: "resource_exhausted",
            message: "Shared channel rate limit",
          });
      }
      rate = { until: now + 60_000, count: 0 };
      this.#rates.set(key, rate);
    }
    if (++rate.count > 600)
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Shared channel rate limit",
        retryable: true,
        details: { retryAfterMs: Math.max(1, rate.until - now) },
      });
  }
  async receive(linkId: string, op: TeamShareOperation): Promise<unknown> {
    if (op.op !== "file") this.admit(linkId, op.shareId);
    switch (op.op) {
      case "file":
        requireTeam(this.files);
        return this.files.receive(linkId, op);
      case "offer":
        return this.store.incomingOffer(linkId, op);
      case "accept":
      case "roster": {
        const result = await this.store.accept(linkId, op);
        await this.partners.hint(linkId, op.shareId, op.generation);
        return result;
      }
      case "pull":
        return this.store.pull(linkId, op);
      case "write": {
        const result = await this.store.write(linkId, op);
        if (op.write.action === "delete") await this.files?.files.collectGarbage();
        return result;
      }
      case "ask.status":
        return this.store.agentStatus(linkId, op);
      case "end":
        await this.store.end(op.shareId, undefined, { linkId, generation: op.generation });
        this.#cancelSyncRetry(op.shareId);
        await this.#rosterJobs.get(op.shareId)?.catch(() => {});
        return {};
    }
  }
  sendRoster(s: Share, op: "accept" | "roster" = "roster") {
    const previous = this.#rosterJobs.get(s.id) ?? Promise.resolve();
    const job = this.chat.access.outsideHumanSession(() =>
      previous
        .catch(() => {})
        .then(async () => {
          const revision = this.chat.access.revision;
          const people = await this.store.roster(s);
          const authorize = () =>
            this.store.db.transaction().execute(async (t) => {
              await this.store.scoped(t, s.partnerLinkId, s.id, s.generation, undefined, true);
              return true;
            });
          return this.chat.access.handoff(revision, authorize, () =>
            this.partners.request(s.partnerLinkId, {
              op,
              shareId: s.id,
              generation: s.generation,
              people,
            }),
          );
        }),
    );
    this.#rosterJobs.set(s.id, job);
    void job
      .finally(() => {
        if (this.#rosterJobs.get(s.id) === job) this.#rosterJobs.delete(s.id);
      })
      .catch(() => {});
    return job;
  }
  #cancelSyncRetry(id: string) {
    const timer = this.#syncRetry.get(id);
    if (timer) clearTimeout(timer);
    this.#syncRetry.delete(id);
  }
  #retrySync(id: string, delay: number) {
    if (this.#closed || this.#syncRetry.has(id)) return;
    const timer = setTimeout(() => {
      this.track(
        this.chat.access.outsideHumanSession(() =>
          this.store
            .get(id)
            .then(async (s) => {
              if (this.#closed || s.state !== "active" || s.role !== "follower") {
                this.#cancelSyncRetry(id);
                return;
              }
              await this.sendRoster(s);
              await this.sync(s);
            })
            .catch((error: unknown) => {
              this.#cancelSyncRetry(id);
              if (error instanceof OpensteerError && error.retryable)
                this.#retrySync(id, Number(error.details?.retryAfterMs ?? 1000));
              else throw error;
            }),
        ),
      );
    }, delay);
    timer.unref();
    this.#syncRetry.set(id, timer);
  }
  async sync(s: Share) {
    this.#cancelSyncRetry(s.id);
    this.#dirty.add(s.id);
    let job = this.#pulling.get(s.id);
    if (job) return job;
    job = (async () => {
      let batches = 0;
      do {
        this.#dirty.delete(s.id);
        for (;;) {
          if (this.#closed) return;
          if (batches++ >= 8) {
            this.#retrySync(s.id, 1000);
            throw new OpensteerError({
              code: "conflict",
              reason: "shared-channel-sync-pending",
              retryable: true,
              message: "This shared channel is catching up. Retry this change.",
            });
          }
          const current = await this.store.get(s.id);
          if (current.state !== "active" || current.role !== "follower") return;
          const parsed = TeamShareBatchSchema.safeParse(
            await this.partners.request(current.partnerLinkId, {
              op: "pull",
              shareId: current.id,
              generation: current.generation,
              cursor: {
                created: SequenceSchema.parse(current.creationCursor),
                sequence: SequenceSchema.parse(current.cursor),
                publicId: current.cursorPublicId,
              },
            }),
          );
          if (!parsed.success) {
            await this.store.db
              .updateTable("teamShares")
              .set({ syncError: "update-required" })
              .where("id", "=", current.id)
              .execute();
            this.chat.changed(current.channelId!);
            throw new OpensteerError({
              code: "conflict",
              reason: "shared-channel-update-required",
              message: "Update Opensteer to read this shared channel",
            });
          }
          const batch = parsed.data;
          if (await this.store.apply(current.partnerLinkId, current.id, current.generation, batch))
            await this.files?.files.collectGarbage();
          await setImmediate();
          if (!batch.more) break;
        }
      } while (this.#dirty.has(s.id));
    })();
    this.#pulling.set(s.id, job);
    try {
      await job;
    } catch (error) {
      if (error instanceof OpensteerError && error.reason === "partner-retry-later") {
        this.#retrySync(s.id, Number(error.details?.retryAfterMs ?? 1000));
        throw new OpensteerError({
          code: "conflict",
          reason: "shared-channel-sync-pending",
          retryable: true,
          message: "This shared channel is catching up. Retry this change.",
          ...(error.details ? { details: error.details } : {}),
        });
      }
      throw error;
    } finally {
      this.#pulling.delete(s.id);
    }
  }
  async connected(linkId: string) {
    const ended = await this.store.db
      .selectFrom("teamShares")
      .selectAll()
      .where("partnerLinkId", "=", linkId)
      .where("state", "=", "ended")
      .execute();
    for (const s of ended)
      try {
        await this.partners.request(linkId, {
          op: "end",
          shareId: s.id,
          generation: s.generation - 1,
        });
      } catch {
        /* Already ended remotely. */
      }
    const rows = await this.store.db
      .selectFrom("teamShares")
      .selectAll()
      .where("partnerLinkId", "=", linkId)
      .where("state", "!=", "ended")
      .execute();
    for (const s of rows) {
      try {
        if (s.role === "owner" && s.state === "offered" && s.localApproved)
          await this.deliverOffer(s);
        if (s.role === "follower" && s.state === "active") {
          await this.sendRoster(s);
          await this.sync(s);
          await this.store.recoverRelayAdmissions(await this.store.get(s.id));
          await this.sendAgentStates(s);
        }
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          (error.reason === "shared-channel-sync-pending" ||
            error.reason === "shared-channel-update-required")
        )
          continue;
        if (error instanceof OpensteerError && error.reason === "partner-retry-later") {
          this.#retrySync(s.id, Number(error.details?.retryAfterMs ?? 1000));
          continue;
        }
        throw error;
      }
    }
  }
  async changed(channelId: TeamChannelId) {
    const rows = await this.store.db
      .selectFrom("teamShares")
      .selectAll()
      .where("channelId", "=", channelId)
      .where("state", "=", "active")
      .execute();
    for (const s of rows) {
      if (s.role === "owner") await this.partners.hint(s.partnerLinkId, s.id, s.generation);
      else if (this.partners.connected(s.partnerLinkId)) await this.sendAgentStates(s);
    }
  }
  async sendAgentStates(s: Share): Promise<void> {
    const previous = this.#statusJobs.get(s.id) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        for (const row of await this.store.agentStatuses(s)) {
          const signature = JSON.stringify({ ...row.status, revision: undefined });
          if (this.#agentStates.get(row.id) === signature) continue;
          await this.partners.request(s.partnerLinkId, {
            op: "ask.status",
            shareId: s.id,
            generation: s.generation,
            triggerPublicId: row.triggerPublicId,
            target: {
              teamId: row.homeTeamId,
              userId: row.homeUserId as import("@opensteer/core").UserId,
            },
            status: row.status!,
          });
          this.#agentStates.set(row.id, signature);
        }
      });
    this.#statusJobs.set(s.id, job);
    try {
      await job;
    } finally {
      if (this.#statusJobs.get(s.id) === job) this.#statusJobs.delete(s.id);
    }
  }
  async refreshRosters() {
    if (this.#closed) return;
    // Roster delivery follows the committed local ACL change, outside its access fence.
    const rows = await this.store.db
      .selectFrom("teamShares")
      .selectAll()
      .where("state", "=", "active")
      .where((eb) =>
        eb.exists(
          eb.selectFrom("teamSharingSettings").select("singletonKey").where("policy", "!=", "off"),
        ),
      )
      .execute();
    for (const s of rows) {
      const channel = await this.store.db
        .selectFrom("teamChannels")
        .select("archivedAt")
        .where("id", "=", s.channelId!)
        .executeTakeFirstOrThrow();
      if (channel.archivedAt) {
        await this.end(s.id);
        continue;
      }
      const people = await this.store.roster(s),
        signature = JSON.stringify(people);
      if (this.#rosters.get(s.id) === signature) continue;
      this.#rosters.set(s.id, signature);
      if (s.role === "owner") this.chat.changed(s.channelId!);
      if (s.role === "follower" && this.partners.connected(s.partnerLinkId))
        this.track(this.sendRoster(s));
    }
  }
  async end(id: string, actor?: TeamActor) {
    const s = await this.store.end(id, actor);
    this.#cancelSyncRetry(id);
    await this.#rosterJobs.get(id)?.catch(() => {});
    this.#dirty.delete(id);
    await this.#pulling.get(id)?.catch(() => {});
    if (this.partners.connected(s.partnerLinkId))
      try {
        await this.partners.request(s.partnerLinkId, {
          op: "end",
          shareId: s.id,
          generation: s.generation,
        });
      } catch {
        /* The local archive is authoritative even while the partner is offline. */
      }
    if (s.channelId) this.chat.changed(s.channelId);
  }
  async revoked(linkId: string) {
    for (const s of await this.store.db
      .selectFrom("teamShares")
      .selectAll()
      .where("partnerLinkId", "=", linkId)
      .where("state", "!=", "ended")
      .execute())
      await this.store.end(s.id);
  }
  async write(
    actor: TeamActor,
    s: Share,
    write: Extract<TeamShareOperation, { op: "write" }>["write"],
    provenance?: Pick<
      Parameters<TeamChatStore["send"]>[1],
      "linkId" | "runId" | "publication" | "agentRequestId"
    >,
  ) {
    try {
      await this.#connecting.get(s.partnerLinkId);
      await this.#pulling.get(s.id);
    } catch (error) {
      if (error instanceof OpensteerError && error.reason === "shared-channel-update-required")
        throw error;
      throw new OpensteerError({
        code: "conflict",
        reason: "partner-unreachable",
        retryable: true,
        message: "The owning team is unreachable. Retry this change.",
      });
    }
    if (this.#syncRetry.has(s.id))
      throw new OpensteerError({
        code: "conflict",
        reason: "shared-channel-sync-pending",
        retryable: true,
        message: "This shared channel is catching up. Retry this change.",
      });
    const controller = new AbortController();
    const unregister = this.partners.lifetimes.register({
      userId: actor.userId,
      ...(provenance?.linkId ? { linkId: provenance.linkId } : {}),
      ...(provenance?.agentRequestId ? { requestId: provenance.agentRequestId } : {}),
      channelIds: [s.channelId!],
      cancel: () =>
        controller.abort(
          new OpensteerError({ code: "not_found", message: "Shared channel not found" }),
        ),
    });
    const authorize = async () => {
      controller.signal.throwIfAborted();
      requireTeam(await this.store.local(actor, s.channelId!));
      if (actor.kind === "agent") {
        requireTeam(provenance?.linkId);
        await this.store.db
          .transaction()
          .execute((t) => this.chat.access.link(t, actor, provenance.linkId!));
        if (provenance.agentRequestId)
          await this.requests.authorize(provenance.linkId, provenance.agentRequestId, "post");
      }
      return true;
    };
    let receipt;
    try {
      s = await this.store.recordRelay(actor, s, write, provenance);
      receipt = TeamShareReceiptSchema.parse(
        await this.partners.request(
          s.partnerLinkId,
          {
            op: "write",
            shareId: s.id,
            generation: s.generation,
            createdThrough: SequenceSchema.parse(s.creationCursor),
            write,
          },
          controller.signal,
          async (send) => {
            const revision = this.chat.access.revision;
            await authorize();
            return this.chat.access.handoff(revision, authorize, send);
          },
        ),
      );
    } catch (error) {
      controller.signal.throwIfAborted();
      if (error instanceof OpensteerError && error.code === "forbidden") throw error;
      if (error instanceof OpensteerError && error.reason === "not-found")
        throw new OpensteerError({ code: "not_found", message: "Shared channel not found" });
      throw new OpensteerError({
        code: "conflict",
        reason: "partner-unreachable",
        retryable: true,
        message: "The owning team is unreachable. Retry this change.",
      });
    } finally {
      unregister();
    }
    if (await this.store.apply(s.partnerLinkId, s.id, s.generation, receipt.batch, false))
      await this.files?.files.collectGarbage();
    return this.store.db.transaction().execute(async (t) => {
      const stored = await t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", s.channelId!)
        .where("publicId", "=", receipt.publicId)
        .executeTakeFirstOrThrow();
      return (await teamMessageViews(t, [stored]))[0]!;
    });
  }
  async send(actor: TeamActor, input: Parameters<TeamChatStore["send"]>[1]) {
    const s = await this.store.local(actor, input.channelId);
    if (!s) return undefined;
    if (actor.kind === "agent") {
      requireTeam(input.linkId);
      await this.store.db
        .transaction()
        .execute((t) => this.chat.access.link(t, actor, input.linkId!));
    }
    const root = input.threadRootId
      ? await this.publicId(input.channelId, input.threadRootId)
      : null;
    if (input.attachmentIds.length) await this.files?.files.prepareShare(input.channelId);
    const rows = input.attachmentIds.length
      ? await this.store.db
          .selectFrom("teamBlobs")
          .selectAll()
          .where("channelId", "=", input.channelId)
          .where("id", "in", [...input.attachmentIds])
          .execute()
      : [];
    requireTeam(rows.length === input.attachmentIds.length);
    const attachments = input.attachmentIds.map((id) =>
      teamShareFileView(
        rows.find((r) => r.id === id)!,
        this.chat.identity.teamId,
      ),
    );
    const message = await this.write(
      actor,
      s,
      {
        action: "send",
        publication: input.publication ?? false,
        author: { teamId: this.chat.identity.teamId, userId: actor.userId },
        authorKind: actor.kind,
        clientMessageId: input.clientMessageId,
        bodyMarkdown: input.bodyMarkdown,
        threadRootPublicId: root,
        attachments,
      },
      input,
    );
    return this.store.relayAdmission(actor, s, message.id);
  }
  async publicId(channelId: TeamChannelId, id: TeamMessageId) {
    return (
      await this.store.db
        .selectFrom("teamMessages")
        .select("publicId")
        .where("channelId", "=", channelId)
        .where("id", "=", id)
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow()
    ).publicId;
  }
  async edit(
    actor: TeamActor,
    channelId: TeamChannelId,
    id: TeamMessageId,
    input: { bodyMarkdown: string } | null,
  ) {
    const s = await this.store.local(actor, channelId);
    if (!s) return false;
    requireTeam(actor.kind === "human");
    const row = await this.store.db
      .selectFrom("teamMessages")
      .select(["authorUserId", "authorKind", "publicId"])
      .where("channelId", "=", channelId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    requireTeam(row.authorUserId === actor.userId && row.authorKind === "human");
    await this.write(
      actor,
      s,
      input
        ? {
            action: "edit",
            author: { teamId: this.chat.identity.teamId, userId: actor.userId },
            publicId: row.publicId,
            bodyMarkdown: input.bodyMarkdown,
          }
        : {
            action: "delete",
            author: { teamId: this.chat.identity.teamId, userId: actor.userId },
            publicId: row.publicId,
          },
    );
    return true;
  }
  async pin(actor: TeamActor, channelId: TeamChannelId, id: TeamMessageId, pinned: boolean) {
    const s = await this.store.local(actor, channelId);
    if (!s) return false;
    requireTeam(actor.kind === "human");
    await this.write(actor, s, {
      action: "pin",
      author: { teamId: this.chat.identity.teamId, userId: actor.userId },
      publicId: await this.publicId(channelId, id),
      pinned,
    });
    return true;
  }
  async close() {
    this.#closed = true;
    for (const id of this.#syncRetry.keys()) this.#cancelSyncRetry(id);
    this.#unsubscribe();
    this.#unsubscribeAccess();
    this.#unsubscribeRoster();
    this.#unsubscribeRequests();
    this.chat.relay = undefined;
    await Promise.allSettled([
      ...this.#jobs,
      ...this.#pulling.values(),
      ...this.#rosterJobs.values(),
      ...this.#statusJobs.values(),
    ]);
  }
}
