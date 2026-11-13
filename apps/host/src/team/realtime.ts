import { OpensteerError, type TeamActor, type TeamChannelId, type UserId } from "@opensteer/core";
import {
  readTeamFrame,
  TeamClientFrameViewSchema,
  type TeamConsistentCut,
  type TeamServerFrameSchema,
} from "@opensteer/protocol";
import { acceptsTeamApiVersion, teamApiVersionRefusal } from "@opensteer/deployment-authority";
import type { z } from "zod";
import type { TeamChatStore } from "@opensteer/database/team-chat";
import { teamReadableChannels, type TeamAccessStore } from "@opensteer/database/team-access";

type Frame = z.infer<typeof TeamServerFrameSchema>;
type Scope = TeamConsistentCut["scope"];
export interface TeamSocket {
  send(frame: Frame): boolean;
  close(reason: string): void;
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
  actor: TeamActor;
  socket: TeamSocket;
  subscriptions: Map<string, Subscription>;
  visible: boolean;
  watched: UserId[];
  seen: number;
  closed: boolean;
  presence: string;
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
  constructor(access: TeamAccessStore, chat: TeamChatStore) {
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
  #snapshot(actor: TeamActor, subscription: Subscription) {
    const key = JSON.stringify([
      actor,
      subscription.scope,
      subscription.since,
      this.access.revision,
    ]);
    let pending = this.#snapshots.get(key);
    if (!pending) {
      pending = this.chat
        .resume(actor, {
          subscriptionId: subscription.id,
          generation: subscription.generation,
          scope: subscription.scope!,
          sinceSeq: subscription.since,
        })
        .finally(() => this.#snapshots.delete(key));
      this.#snapshots.set(key, pending);
    }
    return pending.then((cut) => ({
      ...cut,
      subscriptionId: subscription.id,
      generation: subscription.generation,
    }));
  }
  #sidebar(actor: TeamActor) {
    const key = JSON.stringify([actor, this.access.revision]);
    let pending = this.#sidebars.get(key);
    if (!pending) {
      pending = this.chat
        .directory(actor, undefined, true)
        .finally(() => this.#sidebars.delete(key));
      this.#sidebars.set(key, pending);
    }
    return pending;
  }
  visible(userId: UserId, channelId: TeamChannelId) {
    return [...this.#peers].some(
      (p) =>
        p.actor.userId === userId &&
        p.visible &&
        [...p.subscriptions.values()].some((s) => s.scope?.channelId === channelId) &&
        Date.now() - p.seen < 90000,
    );
  }
  connect(actor: TeamActor, socket: TeamSocket) {
    if (actor.kind !== "human")
      throw new OpensteerError({ code: "forbidden", message: "Human team session required" });
    const peer: Peer = {
      actor,
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
            const revision = this.access.revision;
            const sidebar = await this.#sidebar(actor);
            await this.#handoff(peer, { type: "team.sidebar", sidebar }, revision);
          }
          if (frame.scope) {
            const revision = this.access.revision;
            const cut = await this.#snapshot(actor, subscription);
            if (peer.subscriptions.get(subscription.id) !== subscription || peer.closed) return;
            subscription.can = cut.channel.can;
            subscription.linkOwners = cut.linkPresence.map((entry) => entry.ownerUserId);
            await this.#handoff(peer, { type: "team.cut", cut }, revision);
            subscription.since = cut.throughSeq;
          }
        } else if (frame.type === "team.presence") {
          peer.visible = frame.visible;
          peer.watched = frame.watchedUserIds;
          this.#presence(peer);
        } else {
          const allowed = await this.access.database
            .transaction()
            .execute(async (t) => (await this.access.channel(t, actor, frame.channelId)).read);
          if (!allowed) return;
          const key = `${actor.userId}:${frame.channelId}:${frame.rootId}`;
          const prior = this.#typing.get(key);
          if (!frame.typing) {
            this.#typing.delete(key);
            this.#typingFrame(frame.channelId, frame.rootId);
            return;
          }
          if (prior && Date.now() - prior.sent < 3000) return;
          this.#typing.set(key, {
            userId: actor.userId,
            channelId: frame.channelId,
            rootId: frame.rootId,
            sent: Date.now(),
            until: Date.now() + 6000,
          });
          this.#typingFrame(frame.channelId, frame.rootId);
        }
      },
      close: () => this.#close(peer, "Disconnected"),
    };
  }
  #send(peer: Peer, frame: Frame) {
    if (frame.type === "team.link.presence")
      frame = { ...frame, online: this.chat.identity.agentOnline?.(frame.userId) ?? frame.online };
    else if (frame.type === "team.cut")
      frame = {
        ...frame,
        cut: {
          ...frame.cut,
          linkPresence: frame.cut.linkPresence.map((entry) => ({
            ...entry,
            online: this.chat.identity.agentOnline?.(entry.ownerUserId) ?? entry.online,
          })),
        },
      };
    if (!peer.closed && !peer.socket.send(frame))
      this.#close(peer, "Team connection exceeded its buffer");
  }
  async #handoff(peer: Peer, frame: Frame, revision: typeof this.access.revision) {
    await this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          await this.access.member(t, peer.actor.userId);
          return (
            await Promise.all(
              [...peer.subscriptions.values()]
                .filter((s) => s.scope)
                .map(
                  async (s) => (await this.access.channel(t, peer.actor, s.scope!.channelId)).read,
                ),
            )
          ).every(Boolean);
        }),
      () => this.#send(peer, frame),
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
            } catch {
              this.#close(peer, "Team sidebar unavailable");
            }
          }
          for (const subscription of peer.subscriptions.values()) {
            if (!subscription.scope || !dirty.includes(subscription.scope.channelId)) continue;
            const key = JSON.stringify([subscription.scope, subscription.since]);
            const list = groups.get(key) ?? [];
            list.push({ peer, subscription });
            groups.set(key, list);
          }
        }
        for (const viewers of groups.values()) {
          const first = viewers[0]!,
            subscription = first.subscription;
          if (!subscription.scope) continue;
          try {
            const revision = this.access.revision;
            const cut = await this.chat.resume(first.peer.actor, {
              subscriptionId: subscription.id,
              generation: subscription.generation,
              scope: subscription.scope,
              sinceSeq: subscription.since,
            });
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
          } catch {
            for (const { peer } of viewers) this.#close(peer, "Team subscription unavailable");
          }
        }
      }
    } finally {
      this.#pumping = false;
    }
  }
  async #readable(peer: Peer) {
    while (peer.readable?.revision !== this.access.revision) {
      const revision = this.access.revision;
      const ids = await this.access.database.transaction().execute(async (t) => {
        await this.access.member(t, peer.actor.userId);
        return t
          .selectFrom("teamChannels")
          .select("id")
          .where("id", "in", teamReadableChannels(peer.actor))
          .execute();
      });
      if (revision === this.access.revision)
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
  async linkPresenceChanged(userId: UserId, online: boolean) {
    for (const peer of this.#peers) {
      if (
        ![...peer.subscriptions.values()].some(
          (s) => (s.sidebar && peer.actor.userId === userId) || s.linkOwners.includes(userId),
        )
      )
        continue;
      try {
        const revision = this.access.revision;
        await this.access.database.transaction().execute(async (t) => {
          await this.access.member(t, peer.actor.userId);
          for (const subscription of peer.subscriptions.values())
            if (
              subscription.scope &&
              !(await this.access.channel(t, peer.actor, subscription.scope.channelId)).read
            )
              throw new OpensteerError({ code: "forbidden", message: "Team access changed" });
        });
        await this.#handoff(peer, { type: "team.link.presence", userId, online }, revision);
      } catch {
        this.#close(peer, "Team presence unavailable");
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
  #presence(peer: Peer, online = this.#online()) {
    const people = peer.watched.map((userId) => ({ userId, online: online.has(userId) }));
    const key = JSON.stringify(people);
    if (key === peer.presence) return;
    peer.presence = key;
    this.#send(peer, { type: "team.presence", people });
  }
  #online() {
    return new Set(
      [...this.#peers]
        .filter((p) => p.visible && p.seen > Date.now() - 90000)
        .map((p) => p.actor.userId),
    );
  }
  #expire() {
    const now = Date.now();
    for (const [key, typing] of this.#typing)
      if (typing.until <= now) {
        this.#typing.delete(key);
        this.#typingFrame(typing.channelId, typing.rootId);
      }
    const online = this.#online();
    for (const peer of this.#peers) if (peer.watched.length) this.#presence(peer, online);
  }
  #close(peer: Peer, reason: string) {
    if (peer.closed) return;
    peer.closed = true;
    this.#peers.delete(peer);
    peer.socket.close(reason);
  }
  close() {
    clearInterval(this.#timer);
    this.#unsubscribeChange();
    this.#unsubscribeAccess();
    for (const peer of this.#peers) this.#close(peer, "Team Host stopped");
  }
}
