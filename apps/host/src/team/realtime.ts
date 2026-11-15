import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { TeamBus } from "@opensteer/database/team-bus";
import { OpensteerError, type TeamActor, type TeamChannelId, type UserId } from "@opensteer/core";
import {
  readTeamFrame,
  TeamClientFrameViewSchema,
  type TeamConsistentCut,
  type TeamServerFrameSchema,
} from "@opensteer/protocol";
import { acceptsTeamApiVersion, teamApiVersionRefusal } from "@opensteer/deployment-authority";
import type { z } from "zod";
import { teamLinksOnline, type TeamChatStore } from "@opensteer/database/team-chat";
import { teamMemberView } from "@opensteer/database/team-members";
import {
  withTeamPeerVersion,
  assertTeamSharedChannelVersion,
  teamReadableChannels,
  type TeamAccessStore,
} from "@opensteer/database/team-access";

type Frame = z.infer<typeof TeamServerFrameSchema>;
type Scope = TeamConsistentCut["scope"];
export interface TeamSocket {
  send(frame: Frame): boolean;
  close(code: number, reason: string): void;
}
interface Subscription {
  id: string;
  generation: number;
  scope: Scope | null;
  sidebar: boolean;
  since: TeamConsistentCut["throughSeq"] | null;
  can: TeamConsistentCut["channel"]["can"] | null;
  linkOwners: UserId[];
}
interface Peer {
  id: string;
  version: number;
  actor: TeamActor;
  socket: TeamSocket;
  subscriptions: Map<string, Subscription>;
  visible: boolean;
  watched: UserId[];
  seen: number;
  closed: boolean;
  presence: string;
  /** What this process last stored for the peer; undefined until it is first visible. */
  stored?: string;
  readable?: { revision: TeamAccessStore["revision"]; ids: Set<TeamChannelId> };
}
export class TeamRealtimeHub {
  readonly #peers = new Set<Peer>();
  readonly #typing = new Map<
    string,
    { userId: UserId; channelId: TeamChannelId; rootId: string | null; sent: number; until: number }
  >();
  readonly #dirty = new Set<TeamChannelId>();
  readonly #snapshots = new Map<string, Promise<TeamConsistentCut>>();
  readonly #sidebars = new Map<string, Promise<Awaited<ReturnType<TeamChatStore["directory"]>>>>();
  readonly #unsubscribeChange: () => void;
  readonly #unsubscribeAccess: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #pumping = false;
  readonly access: TeamAccessStore;
  readonly chat: TeamChatStore;
  readonly #bus: TeamBus | undefined;
  readonly #processId: string;
  readonly #off: (() => void)[] = [];
  #lastPresence = 0;
  constructor(
    access: TeamAccessStore,
    chat: TeamChatStore,
    bus?: TeamBus,
    processId: string = randomUUID(),
  ) {
    this.#bus = bus;
    this.#processId = processId;
    this.#off.push(access.onCloseAll((code) => this.closeAll(code)));
    if (bus)
      this.#off.push(
        bus.on((event) => {
          if (event.kind === "typing") {
            const key = `${event.userId}:${event.channelId}:${event.rootId}`;
            if (event.typing)
              this.#typing.set(key, { ...event, sent: Date.now(), until: Date.now() + 6000 });
            else this.#typing.delete(key);
            this.#typingFrame(event.channelId, event.rootId);
          }
          if (event.kind === "presence")
            void this.#refreshPresence().catch(() => this.closeAll(1012));
          if (event.kind === "member")
            void this.#member(event.userId).catch(() => this.closeAll(1012));
          if (event.kind === "linkPresence") void this.linkPresenceChanged(event.userId, false);
        }),
      );
    this.access = access;
    this.chat = chat;
    this.#unsubscribeChange = chat.onChange((id) => {
      this.#dirty.add(id);
      void this.#pump();
    });
    this.#unsubscribeAccess = access.onRevoke(async (effects) => {
      for (const peer of this.#peers) {
        if (effects.users.includes(peer.actor.userId)) {
          this.#close(peer, "Team membership changed");
          continue;
        }
        try {
          await access.database.transaction().execute(async (t) => {
            await access.member(t, peer.actor.userId);
            for (const subscription of peer.subscriptions.values()) {
              if (!subscription.scope) continue;
              const channel = await chat.channelView(t, peer.actor, subscription.scope.channelId);
              subscription.can = channel.can;
            }
          });
          this.#send(peer, { type: "team.access.changed", accessRevision: access.revision });
        } catch {
          this.#close(peer, "Team access changed");
        }
      }
      for (const channelId of effects.channels) this.#dirty.add(channelId);
      void this.#pump();
    });
    this.#timer = setInterval(() => this.#expire(), 1000);
    this.#timer.unref();
  }
  agentRecipient(
    userId: UserId,
    recipient: Extract<Frame, { type: "team.agent.recipient" }>["recipient"],
  ) {
    for (const peer of this.#peers) {
      if (
        peer.actor.userId === userId &&
        [...peer.subscriptions.values()].some(
          (subscription) => subscription.scope?.channelId === recipient.channelId,
        )
      )
        this.#send(peer, { type: "team.agent.recipient", recipient });
    }
  }
  /** Every member sees every member's name, so each open session redraws it. */
  memberUpdated(member: Extract<Frame, { type: "team.member.updated" }>["member"]) {
    for (const peer of this.#peers) this.#send(peer, { type: "team.member.updated", member });
  }
  #snapshot(actor: TeamActor, subscription: Subscription, version: number) {
    const key = JSON.stringify([
      actor,
      version,
      subscription.scope,
      subscription.since,
      this.access.revision,
    ]);
    let pending = this.#snapshots.get(key);
    if (!pending) {
      pending = withTeamPeerVersion(version, () =>
        this.chat.resume(actor, {
          subscriptionId: subscription.id,
          generation: subscription.generation,
          scope: subscription.scope!,
          sinceSeq: subscription.since,
        }),
      ).finally(() => this.#snapshots.delete(key));
      this.#snapshots.set(key, pending);
    }
    return pending.then((cut) => ({
      ...cut,
      subscriptionId: subscription.id,
      generation: subscription.generation,
    }));
  }
  #sidebar(actor: TeamActor, version: number) {
    const key = JSON.stringify([actor, version, this.access.revision]);
    let pending = this.#sidebars.get(key);
    if (!pending) {
      pending = withTeamPeerVersion(version, () =>
        this.chat.directory(actor, undefined, true),
      ).finally(() => this.#sidebars.delete(key));
      this.#sidebars.set(key, pending);
    }
    return pending;
  }
  async visible(userId: UserId, channelId: TeamChannelId) {
    const result = await sql`select 1 from team_presence where user_id=${userId} and visible
      and seen_at > now()-interval '90 seconds' and ${channelId}=any(channel_ids) limit 1`.execute(
      this.access.database,
    );
    return result.rows.length > 0;
  }
  /**
   * Shares what other copies read from presence: only visible devices count as online or
   * suppress a push, so an unseen device writes nothing. A presence frame refreshes freshness.
   */
  async #persist(peer: Peer, heartbeat = false) {
    if (peer.closed) return;
    const ids = [...peer.subscriptions.values()].flatMap((s) =>
      s.scope ? [s.scope.channelId] : [],
    );
    const stored = JSON.stringify([peer.visible, ids]);
    if (!peer.visible && peer.stored === undefined) return;
    if (!heartbeat && stored === peer.stored) return;
    peer.stored = stored;
    await sql`insert into team_presence(connection_id,process_id,user_id,visible,channel_ids,seen_at)
      values (${peer.id},${this.#processId},${peer.actor.userId},${peer.visible},${ids}::text[],${new Date(peer.seen)})
      on conflict(connection_id) do update set visible=excluded.visible,channel_ids=excluded.channel_ids,seen_at=excluded.seen_at`.execute(
      this.access.database,
    );
    if (peer.closed) await this.#deletePresence(peer);
  }
  async #deletePresence(peer: Peer) {
    await sql`delete from team_presence where connection_id=${peer.id}`.execute(
      this.access.database,
    );
  }
  async #member(userId: UserId) {
    const row = await this.access.database
      .selectFrom("teamMembers as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .selectAll("m")
      .select(["u.displayName", "u.image", "u.nameRevision"])
      .where("m.userId", "=", userId)
      .executeTakeFirst();
    if (row) this.memberUpdated(teamMemberView(row));
  }
  async resync() {
    await this.access.sync();
    for (const peer of this.#peers) {
      for (const subscription of peer.subscriptions.values())
        if (subscription.scope) this.#dirty.add(subscription.scope.channelId);
      if ([...peer.subscriptions.values()].some((s) => s.sidebar)) {
        const revision = await this.access.current();
        await this.#handoff(
          peer,
          { type: "team.sidebar", sidebar: await this.#sidebar(peer.actor, peer.version) },
          revision,
        );
      }
    }
    const members = await this.access.database.selectFrom("teamMembers").select("userId").execute();
    for (const member of members) await this.#member(member.userId);
    await this.#refreshPresence();
    await this.#pump();
  }
  connect(actor: TeamActor, socket: TeamSocket) {
    if (actor.kind !== "human")
      throw new OpensteerError({ code: "forbidden", message: "Human team session required" });
    const peer: Peer = {
      id: randomUUID(),
      actor,
      version: 0,
      socket,
      subscriptions: new Map(),
      visible: false,
      watched: [],
      seen: Date.now(),
      closed: false,
      presence: "",
    };
    this.#peers.add(peer);
    return {
      receive: async (raw: unknown) => {
        if (typeof raw !== "object" || raw === null || !("type" in raw))
          throw new OpensteerError({ code: "bad_request", message: "Invalid team frame" });
        if (
          raw.type === "team.subscribe" &&
          (!("teamApiVersion" in raw) || !acceptsTeamApiVersion(raw.teamApiVersion))
        )
          throw new OpensteerError({
            code: "conflict",
            reason: "api-version-mismatch",
            message: teamApiVersionRefusal,
          });
        const frame = readTeamFrame(TeamClientFrameViewSchema, raw);
        if (!frame) return;
        peer.seen = Date.now();
        if (frame.type === "team.subscribe") {
          peer.version = frame.teamApiVersion;
          const subscription: Subscription = {
            id: frame.subscriptionId,
            generation: frame.generation,
            scope: frame.scope,
            sidebar: frame.sidebar,
            since: frame.sinceSeq,
            can: null,
            linkOwners: [],
          };
          if (!peer.subscriptions.has(subscription.id) && peer.subscriptions.size >= 3)
            throw new OpensteerError({
              code: "resource_exhausted",
              message: "Too many team subscriptions",
            });
          const hadSidebar = [...peer.subscriptions.values()].some((s) => s.sidebar);
          peer.subscriptions.set(subscription.id, subscription);
          if (frame.sidebar && !hadSidebar) {
            const revision = await this.access.current();
            const sidebar = await this.#sidebar(actor, peer.version);
            await this.#handoff(peer, { type: "team.sidebar", sidebar }, revision);
          }
          if (frame.scope) {
            const revision = await this.access.current();
            const cut = await this.#snapshot(actor, subscription, peer.version);
            if (peer.subscriptions.get(subscription.id) !== subscription || peer.closed) return;
            subscription.can = cut.channel.can;
            subscription.linkOwners = cut.linkPresence.map((entry) => entry.ownerUserId);
            await this.#handoff(peer, { type: "team.cut", cut }, revision);
            subscription.since = cut.throughSeq;
          }
        } else if (frame.type === "team.presence") {
          peer.visible = frame.visible;
          peer.watched = frame.watchedUserIds;
          await this.#refreshPresence();
        } else {
          const allowed = await withTeamPeerVersion(peer.version, () =>
            this.access.database
              .transaction()
              .execute(
                async (t) => (await this.access.peerChannel(t, actor, frame.channelId)).read,
              ),
          );
          if (!allowed) return;
          const key = `${actor.userId}:${frame.channelId}:${frame.rootId}`;
          const prior = this.#typing.get(key);
          if (frame.typing && prior && Date.now() - prior.sent < 3000) return;
          await this.#bus?.publish({
            kind: "typing",
            channelId: frame.channelId,
            rootId: frame.rootId,
            userId: actor.userId,
            typing: frame.typing,
          });
          if (!frame.typing) {
            this.#typing.delete(key);
            this.#typingFrame(frame.channelId, frame.rootId);
            return;
          }
          this.#typing.set(key, {
            userId: actor.userId,
            channelId: frame.channelId,
            rootId: frame.rootId,
            sent: Date.now(),
            until: Date.now() + 6000,
          });
          this.#typingFrame(frame.channelId, frame.rootId);
        }
        await this.#persist(peer, frame.type === "team.presence");
      },
      close: () => this.#close(peer, "Disconnected", 1012),
    };
  }
  #send(peer: Peer, frame: Frame) {
    void (async () => {
      const revision = await this.access.current();
      if (!(await this.#authorize(peer)))
        throw new OpensteerError({ code: "forbidden", message: "Team access changed" });
      await this.#handoff(peer, frame, revision);
    })().catch((error) => this.#failure(peer, error, "Team access changed"));
  }
  #write(peer: Peer, frame: Frame) {
    if (frame.type === "team.cut") {
      const shared = !!frame.cut.channel.share;
      try {
        withTeamPeerVersion(peer.version, () => assertTeamSharedChannelVersion(shared));
      } catch (error) {
        this.#close(peer, error instanceof Error ? error.message : "Update Opensteer");
        return;
      }
    }
    if (!peer.closed && !peer.socket.send(frame))
      this.#close(peer, "Team connection exceeded its buffer", 1012);
  }
  async #authorize(peer: Peer) {
    return withTeamPeerVersion(peer.version, () =>
      this.access.database.transaction().execute(async (t) => {
        await this.access.member(t, peer.actor.userId);
        for (const subscription of peer.subscriptions.values())
          if (
            subscription.scope &&
            !(await this.access.peerChannel(t, peer.actor, subscription.scope.channelId)).read
          )
            return false;
        return true;
      }),
    );
  }
  async #handoff(peer: Peer, frame: Frame, revision: typeof this.access.revision) {
    await withTeamPeerVersion(peer.version, () =>
      this.access.handoff(
        revision,
        () => this.#authorize(peer),
        () => this.#write(peer, frame),
      ),
    );
  }
  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#dirty.size) {
        const dirty = [...this.#dirty];
        this.#dirty.clear();
        const groups = new Map<string, { peer: Peer; subscription: Subscription }[]>();
        for (const peer of this.#peers) {
          if ([...peer.subscriptions.values()].some((s) => s.sidebar)) {
            try {
              await this.#sidebarDirty(peer, dirty);
            } catch (error) {
              this.#failure(peer, error, "Team sidebar unavailable");
            }
          }
          for (const subscription of peer.subscriptions.values()) {
            if (!subscription.scope || !dirty.includes(subscription.scope.channelId)) continue;
            const key = JSON.stringify([
              peer.actor,
              peer.version,
              subscription.scope,
              subscription.since,
            ]);
            const list = groups.get(key) ?? [];
            list.push({ peer, subscription });
            groups.set(key, list);
          }
        }
        for (const viewers of groups.values()) {
          const first = viewers[0]!,
            subscription = first.subscription;
          const scope = subscription.scope;
          if (!scope) continue;
          try {
            const revision = await this.access.current();
            const cut = await withTeamPeerVersion(first.peer.version, () =>
              this.chat.resume(first.peer.actor, {
                subscriptionId: subscription.id,
                generation: subscription.generation,
                scope,
                sinceSeq: subscription.since,
              }),
            );
            for (const { peer, subscription: current } of viewers) {
              if (peer.subscriptions.get(current.id) !== current || !current.can) continue;
              current.linkOwners = cut.linkPresence.map((entry) => entry.ownerUserId);
              await this.#handoff(
                peer,
                {
                  type: "team.cut",
                  cut: {
                    ...cut,
                    subscriptionId: current.id,
                    generation: current.generation,
                    channel: { ...cut.channel, can: current.can },
                  },
                },
                revision,
              );
              current.since = cut.throughSeq;
            }
          } catch (error) {
            for (const { peer } of viewers)
              this.#failure(peer, error, "Team subscription unavailable");
          }
        }
      }
    } finally {
      this.#pumping = false;
    }
  }
  async #readable(peer: Peer) {
    while (peer.readable?.revision !== (await this.access.current())) {
      const revision = await this.access.current();
      const ids = await withTeamPeerVersion(peer.version, () =>
        this.access.database.transaction().execute(async (t) => {
          await this.access.member(t, peer.actor.userId);
          return t
            .selectFrom("teamChannels")
            .select("id")
            .where("id", "in", teamReadableChannels(peer.actor))
            .execute();
        }),
      );
      if (revision === (await this.access.current()))
        peer.readable = { revision, ids: new Set(ids.map((row) => row.id)) };
    }
    return peer.readable;
  }
  async #sidebarDirty(peer: Peer, dirty: readonly TeamChannelId[]) {
    const readable = await this.#readable(peer);
    await this.access.handoff(
      readable.revision,
      async () => {
        await this.#readable(peer);
        return true;
      },
      () => {
        const channelIds = dirty.filter((id) => peer.readable!.ids.has(id)).slice(0, 200);
        if (channelIds.length)
          this.#send(peer, {
            type: "team.sidebar.dirty",
            channelIds,
            accessRevision: this.access.revision,
          });
      },
    );
  }
  /** Never rejects: presence is advisory, and callers fire it from events while a copy drains. */
  async linkPresenceChanged(userId: UserId, online: boolean) {
    try {
      online = (await teamLinksOnline(this.access.database, [userId])).has(userId);
    } catch {
      return;
    }
    for (const peer of this.#peers) {
      if (
        ![...peer.subscriptions.values()].some(
          (s) => (s.sidebar && peer.actor.userId === userId) || s.linkOwners.includes(userId),
        )
      )
        continue;
      try {
        const revision = await this.access.current();
        await this.access.database.transaction().execute(async (t) => {
          await this.access.member(t, peer.actor.userId);
          for (const subscription of peer.subscriptions.values())
            if (
              subscription.scope &&
              !(await this.access.peerChannel(t, peer.actor, subscription.scope.channelId)).read
            )
              throw new OpensteerError({ code: "forbidden", message: "Team access changed" });
        });
        await this.#handoff(peer, { type: "team.link.presence", userId, online }, revision);
      } catch (error) {
        this.#failure(peer, error, "Team presence unavailable");
      }
    }
  }
  #typingFrame(channelId: TeamChannelId, rootId: string | null) {
    const userIds = [
      ...new Set(
        [...this.#typing.values()]
          .filter((t) => t.channelId === channelId && t.rootId === rootId && t.until > Date.now())
          .map((t) => t.userId),
      ),
    ].slice(0, 50);
    for (const peer of this.#peers)
      if ([...peer.subscriptions.values()].some((s) => s.scope?.channelId === channelId))
        this.#send(peer, {
          type: "team.typing",
          channelId,
          rootId: rootId as import("@opensteer/core").TeamMessageId | null,
          userIds,
        });
  }
  #presence(peer: Peer, online: Set<UserId>) {
    const people = peer.watched.map((userId) => ({ userId, online: online.has(userId) }));
    const key = JSON.stringify(people);
    if (key === peer.presence) return;
    peer.presence = key;
    this.#send(peer, { type: "team.presence", people });
  }
  async #refreshPresence() {
    const rows = await sql<{
      userId: UserId;
    }>`select distinct user_id from team_presence where visible and seen_at > now()-interval '90 seconds'`.execute(
      this.access.database,
    );
    const online = new Set(rows.rows.map((row) => row.userId));
    for (const peer of this.#peers) if (peer.watched.length) this.#presence(peer, online);
  }
  #expire() {
    const now = Date.now();
    for (const [key, typing] of this.#typing)
      if (typing.until <= now) {
        this.#typing.delete(key);
        this.#typingFrame(typing.channelId, typing.rootId);
      }
    if (now - this.#lastPresence >= 15_000) {
      this.#lastPresence = now;
      void this.#refreshPresence().catch(() => this.closeAll(1012));
    }
  }
  #failure(peer: Peer, error: unknown, reason: string) {
    const refused =
      error instanceof OpensteerError &&
      (error.code === "forbidden" || error.reason === "api-version-mismatch");
    this.#close(peer, error instanceof Error ? error.message : reason, refused ? 1008 : 1012);
  }
  #close(peer: Peer, reason: string, code = 1008) {
    if (peer.closed) return;
    peer.closed = true;
    this.#peers.delete(peer);
    peer.socket.close(code, reason);
    if (peer.stored !== undefined) void this.#deletePresence(peer).catch(() => {});
  }
  async cleanup() {
    await sql`delete from team_presence where process_id=${this.#processId}`.execute(
      this.access.database,
    );
  }
  closeAll(code = 1012) {
    for (const peer of this.#peers) this.#close(peer, "Team connection moved", code);
  }
  close() {
    for (const off of this.#off) off();
    clearInterval(this.#timer);
    this.#unsubscribeChange();
    this.#unsubscribeAccess();
    this.closeAll(1012);
  }
}
