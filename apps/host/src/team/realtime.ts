import { OpensteerError, type TeamActor, type TeamChannelId, type UserId } from "@opensteer/core";
import {
  TeamClientFrameSchema,
  type TeamConsistentCut,
  type TeamServerFrameSchema,
} from "@opensteer/protocol";
import { teamApiVersion } from "@opensteer/deployment-authority";
import type { z } from "zod";
import type { TeamChatStore } from "@opensteer/database/team-chat";
import type { TeamAccessStore } from "@opensteer/database/team-access";

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
}
interface Peer {
  actor: TeamActor;
  socket: TeamSocket;
  subscription: Subscription | null;
  visible: boolean;
  watched: UserId[];
  seen: number;
  closed: boolean;
  presence: string;
}
export class TeamRealtimeHub {
  readonly #peers = new Set<Peer>();
  readonly #typing = new Map<
    string,
    { userId: UserId; channelId: TeamChannelId; rootId: string | null; sent: number; until: number }
  >();
  readonly #dirty = new Set<TeamChannelId>();
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
        try {
          await access.database.transaction().execute(async (t) => {
            await access.member(t, peer.actor.userId);
            if (peer.subscription?.scope) {
              const channel = await chat.channelView(
                t,
                peer.actor,
                peer.subscription.scope.channelId,
              );
              peer.subscription.can = channel.can;
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
  visible(userId: UserId, channelId: TeamChannelId) {
    return [...this.#peers].some(
      (p) =>
        p.actor.userId === userId &&
        p.visible &&
        p.subscription?.scope?.channelId === channelId &&
        Date.now() - p.seen < 90000,
    );
  }
  connect(actor: TeamActor, socket: TeamSocket) {
    if (actor.kind !== "human")
      throw new OpensteerError({ code: "forbidden", message: "Human team session required" });
    const peer: Peer = {
      actor,
      socket,
      subscription: null,
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
          (!("teamApiVersion" in raw) || raw.teamApiVersion !== teamApiVersion)
        )
          throw new OpensteerError({
            code: "conflict",
            reason: "api-version-mismatch",
            message: "Team API version mismatch",
          });
        const frame = TeamClientFrameSchema.parse(raw);
        peer.seen = Date.now();
        if (frame.type === "team.subscribe") {
          const subscription: Subscription = {
            id: frame.subscriptionId,
            generation: frame.generation,
            scope: frame.scope,
            sidebar: frame.sidebar,
            since: frame.sinceSeq,
            can: null,
          };
          peer.subscription = subscription;
          if (frame.sidebar) {
            const revision = this.access.revision;
            const sidebar = await this.chat.directory(actor, undefined, true);
            await this.#handoff(peer, { type: "team.sidebar", sidebar }, revision);
          }
          if (frame.scope) {
            const revision = this.access.revision;
            const cut = await this.chat.resume(actor, {
              subscriptionId: frame.subscriptionId,
              generation: frame.generation,
              scope: frame.scope,
              sinceSeq: frame.sinceSeq,
            });
            if (peer.subscription !== subscription || peer.closed) return;
            subscription.can = cut.channel.can;
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
            !peer.subscription?.scope ||
            (await this.access.channel(t, peer.actor, peer.subscription.scope.channelId)).read
          );
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
        const groups = new Map<string, Peer[]>();
        for (const peer of this.#peers) {
          const s = peer.subscription;
          if (!s) continue;
          if (s.sidebar)
            this.#send(peer, {
              type: "team.sidebar.dirty",
              channelIds: dirty.slice(0, 200),
              accessRevision: this.access.revision,
            });
          if (!s.scope || !dirty.includes(s.scope.channelId)) continue;
          const key = JSON.stringify([s.scope, s.since]);
          const list = groups.get(key) ?? [];
          list.push(peer);
          groups.set(key, list);
        }
        for (const peers of groups.values()) {
          const first = peers[0]!,
            subscription = first.subscription!;
          if (!subscription.scope) continue;
          try {
            const revision = this.access.revision;
            const cut = await this.chat.resume(first.actor, {
              subscriptionId: subscription.id,
              generation: subscription.generation,
              scope: subscription.scope,
              sinceSeq: subscription.since,
            });
            for (const peer of peers) {
              const current = peer.subscription;
              if (
                !current?.scope ||
                JSON.stringify(current.scope) !== JSON.stringify(cut.scope) ||
                !current.can
              )
                continue;
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
            for (const peer of peers) this.#close(peer, "Team subscription unavailable");
          }
        }
      }
    } finally {
      this.#pumping = false;
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
      if (peer.subscription?.scope?.channelId === channelId)
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
