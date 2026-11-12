import { type TeamChannelId, createId } from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import {
  TeamFileSchema,
  TeamAgentRequestSchema,
  TeamBinaryUploadMetadataSchema,
  serializeTeamLinkOffer,
  TeamChannelAccessSchema,
  TeamGroupSchema,
  TeamInviteSchema,
} from "@opensteer/protocol";
import type { TeamFileUpload } from "./files.js";
import {
  DeploymentIdSchema,
  UserIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  SequenceSchema,
} from "@opensteer/core";
import {
  TeamBootstrapSchema,
  TeamChannelSchema,
  TeamClientFrameSchema,
  TeamCommandSchema,
  TeamMessageSchema,
  TeamConsistentCutSchema,
  hostApi,
  type HostApiClient,
  type TeamMessage,
  type TeamMember,
  type TeamAgentRequest,
  type TeamConsistentCut,
} from "@opensteer/protocol";
import type { z } from "zod";
import type { WebSocketClient } from "../host/host-session-client.js";
import type { TeamScope, TeamSidebar } from "./reducers.js";

export const mockTeamId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001");
export const mockTeamUserId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
export const mockTeamChannelId = TeamChannelIdSchema.parse(
  "tch_00000000-0000-4000-8000-000000000001",
);
export class MockTeamSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readyState = 0;
  readonly #events = new Map<string, Set<(event: never) => void>>();
  readonly #send: (frame: z.infer<typeof TeamClientFrameSchema>) => void;
  constructor(send: (frame: z.infer<typeof TeamClientFrameSchema>) => void) {
    this.#send = send;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    const set = this.#events.get(type) ?? new Set();
    set.add(listener);
    this.#events.set(type, set);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.#events.get(type) ?? []) listener(event as never);
  }
  deliver(frame: unknown): void {
    if (this.readyState === 1) this.emit("message", { data: JSON.stringify(frame) });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") throw new Error("Expected a text frame.");
    this.#send(TeamClientFrameSchema.parse(JSON.parse(data)));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }
}
export class MockTeamHost {
  readonly channels = new Map<string, z.infer<typeof TeamChannelSchema>>();
  readonly messages = new Map<string, TeamMessage>();
  readonly calls: string[] = [];
  readonly files = new Map<
    string,
    { file: z.infer<typeof TeamFileSchema>; original: Blob; preview: Blob | null }
  >();
  readonly members: TeamMember[] = [];
  readonly requests: TeamAgentRequest[] = [];
  readonly linkPresence: TeamConsistentCut["linkPresence"] = [];
  readonly groups = new Map<string, z.infer<typeof TeamGroupSchema>>();
  readonly invites = new Map<string, z.infer<typeof TeamInviteSchema>>();
  readonly #uploads = new Map<string, z.infer<typeof TeamFileSchema>>();
  readonly #directParticipants = new Map<string, string[]>();
  readonly #access = new Map<string, z.infer<typeof TeamChannelAccessSchema>>();
  readonly #preferences = new Map<string, "all" | "mentions" | "muted">();
  readonly #sockets = new Map<
    MockTeamSocket,
    Map<string, { scope: TeamScope; generation: number }>
  >();
  readonly #reads = new Map<string, string>();
  #seq = 0n;
  #messageId = 0n;
  loseNextSendAck = false;
  readonly bootstrap: z.infer<typeof TeamBootstrapSchema>;
  readonly rpc: HostApiClient;
  readonly teamId: typeof mockTeamId;
  readonly userId: typeof mockTeamUserId;
  get socketCount(): number {
    return this.#sockets.size;
  }
  constructor(options: { teamId?: typeof mockTeamId; userId?: typeof mockTeamUserId } = {}) {
    this.teamId = options.teamId ?? mockTeamId;
    this.userId = options.userId ?? mockTeamUserId;
    const channel = TeamChannelSchema.parse({
      id: mockTeamChannelId,
      kind: "public",
      name: "general",
      peopleOnly: false,
      archivedAt: null,
      changeSeq: "0",
      latestMessageId: null,
      can: { read: true, post: true, manage: true, join: false, leave: true, wakeOwnAgent: true },
      instructionsMarkdown: "",
      instructionsRevision: "0",
    });
    this.channels.set(channel.id, channel);
    this.bootstrap = TeamBootstrapSchema.parse({
      teamId: this.teamId,
      teamName: "Acme",
      member: {
        userId: this.userId,
        displayName: "Maya",
        handle: "maya",
        image: null,
        role: "owner",
        state: "active",
        generation: "1",
        joinedAt: new Date().toISOString(),
      },
      can: {
        createChannel: true,
        manageMembers: true,
        manageGroups: true,
        manageInvites: true,
        transferOwner: true,
        viewAudit: true,
        connectAgent: true,
      },
      sidebar: this.#sidebarPage(),
    });
    this.members.push(this.bootstrap.member);
    this.rpc = new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name !== "string" || !(name in hostApi)
            ? undefined
            : async (input: unknown) => {
                this.calls.push(name);
                const declaration = hostApi[name as keyof typeof hostApi];
                try {
                  const data = await this.read(name, declaration.payload.parse(input));
                  return { ok: true, data: declaration.success.parse(data) };
                } catch (error) {
                  return {
                    ok: false,
                    error: {
                      code: "internal",
                      message: error instanceof Error ? error.message : "Mock team request failed.",
                      retryable: true,
                    },
                  };
                }
              },
      },
    ) as HostApiClient;
  }
  sidebar(): TeamSidebar {
    const channels = [...this.channels.values()].map(
      ({ instructionsMarkdown: _instructions, instructionsRevision: _revision, ...channel }) => ({
        channel,
        unread:
          channel.latestMessageId !== null &&
          BigInt(channel.latestMessageId) > BigInt(this.#reads.get(channel.id) ?? "0"),
        mentionCount: [...this.messages.values()].filter(
          (message) =>
            message.channelId === channel.id &&
            BigInt(message.id) > BigInt(this.#reads.get(channel.id) ?? "0") &&
            message.mentions.some((mention) => mention.userId === this.userId),
        ).length,
        lastReadMessageId: this.#reads.has(channel.id)
          ? TeamMessageIdSchema.parse(this.#reads.get(channel.id))
          : null,
        notificationLevel: this.#preferences.get(channel.id) ?? "mentions",
        agentOnline: true,
      }),
    );
    return {
      accessRevision: SequenceSchema.parse("1"),
      nextCursor: null,
      channels,
      totalMentionCount: channels.reduce((total, row) => total + row.mentionCount, 0),
    };
  }
  #sidebarPage(after?: string, channelIds?: readonly TeamChannelId[]): TeamSidebar {
    const sidebar = this.sidebar(),
      rows = sidebar.channels
        .filter((row) => !row.channel.archivedAt && !row.channel.can.join)
        .sort((a, b) => a.channel.id.localeCompare(b.channel.id))
        .filter((row) => !after || row.channel.id > after)
        .filter((row) => !channelIds || channelIds.includes(row.channel.id)),
      channels = rows.slice(0, 50);
    return {
      ...sidebar,
      channels,
      nextCursor: rows.length > 50 ? channels.at(-1)!.channel.id : null,
    };
  }
  uploadFile = async (input: TeamFileUpload) => {
    const metadata = TeamBinaryUploadMetadataSchema.parse(input.metadata);
    const key = JSON.stringify([input.channelId, metadata.clientUploadId]);
    const existing = this.#uploads.get(key);
    if (existing) return existing;
    if (
      input.original.size !== metadata.sizeBytes ||
      (input.preview?.size ?? 0) !== metadata.previewSizeBytes
    )
      throw new Error("Upload size changed.");
    const file = TeamFileSchema.parse({
      id: createId("teamBlob"),
      channelId: input.channelId,
      filename: metadata.filename,
      mediaType: metadata.mediaType,
      sizeBytes: metadata.sizeBytes,
      sha256: metadata.sha256,
      preview: input.preview
        ? { mediaType: input.preview.type, sizeBytes: input.preview.size }
        : null,
    });
    this.files.set(file.id, { file, original: input.original, preview: input.preview });
    this.#uploads.set(key, file);
    return file;
  };
  readFile = async (file: z.infer<typeof TeamFileSchema>, part: "original" | "preview") => {
    const held = this.files.get(file.id),
      blob = part === "original" ? held?.original : held?.preview;
    if (!blob || held?.file.channelId !== file.channelId) throw new Error("Unknown file.");
    return blob;
  };
  connect = (): MockTeamSocket => {
    const socket = new MockTeamSocket((frame) => {
      if (frame.type === "team.subscribe") {
        if (frame.teamApiVersion !== teamApiVersion) {
          socket.close();
          return;
        }
        socket.deliver({ type: "team.sidebar", sidebar: this.#sidebarPage() });
        if (!frame.scope) {
          this.#sockets.get(socket)?.delete(frame.subscriptionId);
          return;
        }
        this.#sockets
          .get(socket)
          ?.set(frame.subscriptionId, { scope: frame.scope, generation: frame.generation });
        socket.deliver({
          type: "team.cut",
          cut: this.cut(frame.scope, frame.subscriptionId, frame.generation, frame.sinceSeq),
        });
      } else if (frame.type === "team.typing") {
        for (const peer of this.#sockets.keys())
          peer.deliver({
            type: "team.typing",
            channelId: frame.channelId,
            rootId: frame.rootId,
            userIds: frame.typing ? [this.userId] : [],
          });
      } else if (frame.type === "team.presence")
        socket.deliver({
          type: "team.presence",
          people: frame.watchedUserIds.map((userId) => ({ userId, online: frame.visible })),
        });
    });
    this.#sockets.set(socket, new Map());
    socket.addEventListener("close", () => this.#sockets.delete(socket));
    return socket;
  };
  cut(
    scope: TeamScope,
    subscriptionId: string,
    generation: number,
    since: string | null,
  ): TeamConsistentCut {
    const channel = this.channels.get(scope.channelId);
    if (!channel) throw new Error("Unknown channel.");
    const messages = [...this.messages.values()]
      .filter(
        (row) =>
          row.channelId === scope.channelId &&
          (scope.kind === "channel"
            ? row.threadRootId === null
            : row.id === scope.rootId || row.threadRootId === scope.rootId),
      )
      .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    const changed = messages.filter(
      (row) => since !== null && BigInt(row.changeSeq) > BigInt(since),
    );
    const base = {
      channel,
      throughSeq: channel.changeSeq,
      subscriptionId,
      generation,
      scope,
      requests: this.requests.filter(
        (request) =>
          request.channelId === scope.channelId &&
          (scope.kind === "channel" || request.threadRootId === scope.rootId),
      ),
      linkPresence: this.linkPresence,
    };
    if (since !== null) {
      const delta = TeamConsistentCutSchema.safeParse({
        ...base,
        type: "resumed",
        changedRows: changed,
        deletedIds: [],
      });
      if (delta.success) return delta.data;
    }
    let retained = messages.slice(-50);
    while (
      retained.length > 0 &&
      !TeamConsistentCutSchema.safeParse({
        ...base,
        type: "snapshot",
        messages: retained,
        hasMore: messages.length > retained.length,
      }).success
    )
      retained = retained.slice(1);
    return TeamConsistentCutSchema.parse({
      ...base,
      type: "snapshot",
      messages: retained,
      hasMore: messages.length > retained.length,
    });
  }
  async read(name: string, input: unknown): Promise<unknown> {
    if (name === "team.bootstrap.get") return { ...this.bootstrap, sidebar: this.#sidebarPage() };
    if (name === "team.sidebar.get") {
      const { after, channelIds } = hostApi[name].payload.parse(input);
      return this.#sidebarPage(after, channelIds);
    }
    if (name === "team.channels.list") {
      const { after } = hostApi[name].payload.parse(input),
        page = this.#sidebarPage(after);
      return {
        channels: page.channels.map((row) => row.channel),
        hasMore: page.nextCursor !== null,
      };
    }
    if (name === "team.channel.get")
      return this.channels.get(hostApi[name].payload.parse(input).channelId);
    if (name === "team.channel.access.get") {
      const { channelId } = hostApi[name].payload.parse(input);
      return (
        this.#access.get(channelId) ?? {
          revision: "0",
          entries: [],
          can: this.channels.get(channelId)?.can,
        }
      );
    }
    if (name === "team.channel.instructions.get") {
      const channel = this.channels.get(hostApi[name].payload.parse(input).channelId);
      return {
        instructionsMarkdown: channel?.instructionsMarkdown ?? "",
        revision: channel?.instructionsRevision ?? "0",
      };
    }
    if (name === "team.message.get") {
      const { channelId, messageId } = hostApi[name].payload.parse(input),
        message = this.messages.get(messageId);
      if (message?.channelId !== channelId) throw new Error("Unknown message.");
      return message;
    }
    if (name === "team.members.list") return { members: this.members, hasMore: false };
    if (name === "team.groups.list")
      return { groups: [...this.groups.values()].slice(0, 50), hasMore: false };
    if (name === "team.group.get")
      return this.groups.get(hostApi[name].payload.parse(input).groupId);
    if (name === "team.invites.list")
      return { invites: [...this.invites.values()].slice(0, 50), hasMore: false };
    if (name === "team.links.list") return { links: [] };
    if (name === "team.audit.page") return { audit: [], hasMore: false };
    if (name === "team.notices.page") return { notices: [], hasMore: false };
    if (name === "team.knowledge.topics.list") return { topics: [], hasMore: false };
    if (name === "team.knowledge.facts.page" || name === "team.knowledge.history.page")
      return { facts: [], hasMore: false };
    if (name === "team.agent.requests.get") {
      const { channelId, rootId } = hostApi[name].payload.parse(input);
      return {
        requests: this.requests.filter(
          (request) => request.channelId === channelId && request.threadRootId === rootId,
        ),
      };
    }
    if (name === "team.mentions.page" || name === "team.pins.page")
      return {
        messages: [...this.messages.values()]
          .filter((row) =>
            name === "team.pins.page"
              ? row.pinned
              : row.mentions.some((mention) => mention.userId === this.userId),
          )
          .slice(-50),
        hasMore: false,
      };
    if (name === "team.files.page") {
      const { channelId } = hostApi[name].payload.parse(input);
      return {
        files: [...this.messages.values()]
          .filter((row) => row.channelId === channelId)
          .flatMap((message) =>
            message.attachments.map((file) => ({ file, messageId: message.id })),
          )
          .slice(-50),
        hasMore: false,
      };
    }
    if (name === "commands.dispatch") {
      const common = hostApi["commands.dispatch"].payload.parse(input);
      if (common.type === "notification.preview.register")
        return {
          type: common.type,
          installationId: common.installationId,
          keyId: common.keyId,
          registered: true,
        };
      const command = TeamCommandSchema.parse(common);
      if (command.type === "team.dm.open") {
        const people = [...new Set([this.userId, ...command.participants])].sort();
        const held = [...this.#directParticipants].find(
          ([, members]) => JSON.stringify(members) === JSON.stringify(people),
        );
        if (held) return { type: command.type, channel: this.channels.get(held[0]) };
        const channel = TeamChannelSchema.parse({
          ...this.channels.get(mockTeamChannelId),
          id: createId("teamChannel"),
          kind: "dm",
          name: people
            .map((id) => (id === this.userId ? this.bootstrap.member.displayName : "Teammate"))
            .join(", ")
            .slice(0, 160),
          can: {
            read: true,
            post: true,
            manage: false,
            join: false,
            leave: true,
            wakeOwnAgent: true,
          },
          latestMessageId: null,
          changeSeq: String(++this.#seq),
        });
        this.channels.set(channel.id, channel);
        this.#directParticipants.set(channel.id, people);
        this.publish();
        return { type: command.type, channel };
      }
      if (command.type === "team.dm.people.add") {
        const people = this.#directParticipants.get(command.channelId);
        if (!people) throw new Error("Unknown direct message.");
        this.#directParticipants.set(
          command.channelId,
          [...new Set([...people, ...command.userIds])].sort(),
        );
        return { type: command.type };
      }
      if (command.type === "team.channel.access.set") {
        const held = this.#access.get(command.channelId);
        if ((held?.revision ?? "0") !== command.expectedRevision)
          throw new Error("Channel access changed.");
        const channel = this.channels.get(command.channelId);
        if (!channel) throw new Error("Unknown channel.");
        this.#access.set(command.channelId, {
          revision: SequenceSchema.parse(String(++this.#seq)),
          entries: command.access,
          can: channel.can,
        });
        this.publish();
        return { type: command.type };
      }
      if (command.type === "team.group.create") {
        this.groups.set(
          command.id,
          TeamGroupSchema.parse({
            id: command.id,
            name: command.name,
            people: [],
            children: [],
            updatedAt: new Date().toISOString(),
          }),
        );
        return { type: command.type };
      }
      if (command.type === "team.group.delete") {
        this.groups.delete(command.groupId);
        for (const group of this.groups.values())
          group.children = group.children.filter((id) => id !== command.groupId);
        return { type: command.type };
      }
      if (
        command.type === "team.group.rename" ||
        command.type === "team.group.person.add" ||
        command.type === "team.group.person.remove" ||
        command.type === "team.group.child.add" ||
        command.type === "team.group.child.remove"
      ) {
        const group = this.groups.get(command.groupId);
        if (!group) throw new Error("Unknown group.");
        if (command.type === "team.group.rename") group.name = command.name;
        else if (command.type === "team.group.person.add")
          group.people = [...new Set([...group.people, command.userId])];
        else if (command.type === "team.group.person.remove")
          group.people = group.people.filter((id) => id !== command.userId);
        else if (command.type === "team.group.child.remove")
          group.children = group.children.filter((id) => id !== command.childGroupId);
        else {
          const reaches = (id: string, visited = new Set<string>()): boolean => {
            if (id === group.id) return true;
            if (visited.has(id)) return false;
            visited.add(id);
            return this.groups.get(id)?.children.some((child) => reaches(child, visited)) ?? false;
          };
          if (!this.groups.has(command.childGroupId) || reaches(command.childGroupId))
            throw new Error("Group nesting would form a cycle.");
          group.children = [...new Set([...group.children, command.childGroupId])];
        }
        group.updatedAt = new Date().toISOString();
        return { type: command.type };
      }
      if (command.type === "team.invite.create") {
        const selector = crypto.randomUUID().replaceAll("-", ""),
          verifier = crypto.randomUUID().replaceAll("-", "");
        const invite = TeamInviteSchema.parse({
          id: command.id,
          selector,
          maxUses: command.maxUses,
          usedCount: 0,
          expiresAt: command.expiresAt,
          revokedAt: null,
          createdBy: this.userId,
          createdAt: new Date().toISOString(),
        });
        this.invites.set(invite.id, invite);
        return {
          type: command.type,
          invite,
          url: `https://acme.example/invite?selector=${selector}#${verifier}`,
        };
      }
      if (command.type === "team.invite.revoke") {
        const invite = this.invites.get(command.inviteId);
        if (invite) invite.revokedAt = new Date().toISOString();
        return { type: command.type };
      }
      if (command.type === "team.channel.create") {
        const channel = TeamChannelSchema.parse({
          ...this.channels.get(mockTeamChannelId),
          id: command.id,
          name: command.name,
          kind: command.kind,
          peopleOnly: command.peopleOnly,
          latestMessageId: null,
          archivedAt: null,
          instructionsMarkdown: "",
          instructionsRevision: "0",
          changeSeq: String(++this.#seq),
        });
        this.channels.set(channel.id, channel);
        this.#access.set(channel.id, {
          revision: channel.changeSeq,
          entries: command.access,
          can: channel.can,
        });
        this.publish();
        return { type: command.type, channel };
      }
      if (command.type === "team.channel.update") {
        const channel = this.channels.get(command.channelId);
        if (!channel) throw new Error("Unknown channel.");
        this.channels.set(channel.id, {
          ...channel,
          name: command.name,
          peopleOnly: command.peopleOnly,
          changeSeq: SequenceSchema.parse(String(++this.#seq)),
        });
        this.publish();
        return { type: command.type };
      }
      if (command.type === "team.channel.preferences.set") {
        this.#preferences.set(command.channelId, command.notificationLevel);
        this.publish();
        return { type: command.type };
      }
      if (command.type === "team.channel.instructions.set") {
        const channel = this.channels.get(command.channelId);
        if (!channel || channel.instructionsRevision !== command.expectedRevision)
          throw new Error("Instructions changed.");
        this.channels.set(channel.id, {
          ...channel,
          instructionsMarkdown: command.instructionsMarkdown,
          instructionsRevision: SequenceSchema.parse(String(++this.#seq)),
        });
        this.publish();
        return { type: command.type };
      }
      if (
        command.type === "team.channel.archive" ||
        command.type === "team.channel.restore" ||
        command.type === "team.channel.join" ||
        command.type === "team.channel.leave"
      ) {
        const channel = this.channels.get(command.channelId);
        if (!channel) throw new Error("Unknown channel.");
        this.channels.set(channel.id, {
          ...channel,
          archivedAt:
            command.type === "team.channel.archive"
              ? new Date().toISOString()
              : command.type === "team.channel.restore"
                ? null
                : channel.archivedAt,
          can: {
            ...channel.can,
            join: command.type === "team.channel.leave",
            leave: command.type !== "team.channel.leave",
          },
          changeSeq: SequenceSchema.parse(String(++this.#seq)),
        });
        this.publish();
        return { type: command.type };
      }
      if (
        command.type === "team.message.edit" ||
        command.type === "team.message.delete" ||
        command.type === "team.message.pin" ||
        command.type === "team.message.unpin"
      ) {
        const message = this.messages.get(command.messageId),
          channel = this.channels.get(command.channelId);
        if (!message || !channel || message.channelId !== channel.id)
          throw new Error("Unknown message.");
        const changeSeq = SequenceSchema.parse(String(++this.#seq));
        this.messages.set(message.id, {
          ...message,
          changeSeq,
          ...(command.type === "team.message.edit"
            ? {
                bodyMarkdown: command.bodyMarkdown,
                plainText: command.bodyMarkdown,
                mentions: command.mentions,
                editedAt: new Date().toISOString(),
              }
            : command.type === "team.message.delete"
              ? {
                  deletedAt: new Date().toISOString(),
                  bodyMarkdown: "",
                  plainText: "",
                  attachments: [],
                }
              : { pinned: command.type === "team.message.pin" }),
        });
        channel.changeSeq = changeSeq;
        if (message.threadRootId) {
          const root = this.messages.get(message.threadRootId);
          if (root) {
            const replies = [...this.messages.values()].filter(
              (row) => row.threadRootId === root.id && !row.deletedAt,
            );
            this.messages.set(root.id, {
              ...root,
              changeSeq,
              replySummary: {
                count: replies.length,
                latestMessageId: replies.at(-1)?.id ?? null,
                repliers: [...new Set(replies.map((row) => row.authorUserId))].slice(0, 4),
              },
            });
          }
        }
        this.publish();
        return { type: command.type };
      }
      if (command.type === "team.link.code.create")
        return {
          type: command.type,
          replacing: null,
          offer: serializeTeamLinkOffer({
            origin: "https://acme.example",
            teamId: this.teamId,
            hostKeyFingerprint: "mock-team-key",
            code: (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 43),
          }),
        };
      if (
        command.type === "team.upload.complete" ||
        command.type === "team.upload.cancel" ||
        command.type === "team.notice.read"
      )
        return { type: command.type };
      if (command.type === "team.message.send") {
        let message = [...this.messages.values()].find(
          (row) =>
            row.clientMessageId === command.clientMessageId && row.authorUserId === this.userId,
        );
        if (!message) {
          message = this.post({
            channelId: command.channelId,
            threadRootId: command.threadRootId,
            clientMessageId: command.clientMessageId,
            bodyMarkdown: command.bodyMarkdown,
            mentions: command.mentions,
            attachments: command.attachmentIds.map((id) => {
              const file = this.files.get(id)?.file;
              if (!file || file.channelId !== command.channelId)
                throw new Error("Unknown attachment.");
              return file;
            }),
          });
        }
        if (this.loseNextSendAck) {
          this.loseNextSendAck = false;
          throw new Error("Acknowledgement lost.");
        }
        return { type: command.type, message, wake: "not-requested" };
      }
      if (command.type === "team.channel.read") {
        this.markRead(command.channelId, command.throughMessageId);
        return { type: command.type };
      }
      throw new Error(`Mock command not implemented: ${command.type}`);
    }
    if (name === "team.messages.check") {
      const payload = hostApi["team.messages.check"].payload.parse(input);
      return {
        messages: [...this.messages.values()].filter(
          (row) =>
            row.channelId === payload.channelId &&
            row.authorUserId === this.userId &&
            payload.clientMessageIds.includes(row.clientMessageId),
        ),
      };
    }
    if (name === "team.messages.page" || name === "team.thread.page") {
      const payload = hostApi[name].payload.parse(input);
      const rows = [...this.messages.values()]
        .filter(
          (row) =>
            row.channelId === payload.channelId &&
            ("rootId" in payload
              ? row.threadRootId === payload.rootId || row.id === payload.rootId
              : row.threadRootId === null),
        )
        .filter(
          (row) =>
            payload.page.direction === "newest" ||
            (payload.page.direction === "before"
              ? BigInt(row.id) < BigInt(payload.page.messageId)
              : BigInt(row.id) > BigInt(payload.page.messageId)),
        )
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
      return {
        channel: this.channels.get(payload.channelId),
        messages: payload.page.direction === "after" ? rows.slice(0, 50) : rows.slice(-50),
        hasMore: rows.length > 50,
        throughSeq: String(this.#seq),
      };
    }
    if (name === "team.search") {
      const { input: query } = hostApi[name].payload.parse(input);
      return {
        results: [...this.messages.values()]
          .filter((row) => row.plainText.includes(query.query))
          .slice(0, 50)
          .map((message) => ({
            message,
            source: {
              teamId: this.teamId,
              channelId: message.channelId,
              threadRootId: message.threadRootId ?? message.id,
              messageId: message.id,
              audience: {
                teamName: "Acme",
                channelName: this.channels.get(message.channelId)?.name ?? "general",
                channelKind: "public",
                memberCount: 1,
                peopleOnly: false,
              },
            },
          })),
        hasMore: false,
      };
    }
    throw new Error(`Mock read not implemented: ${name}`);
  }
  setRequest(input: TeamAgentRequest): TeamAgentRequest {
    const channel = this.channels.get(input.channelId);
    const root = this.messages.get(input.threadRootId);
    if (!channel || root?.channelId !== channel.id) throw new Error("Unknown request thread.");
    const request = TeamAgentRequestSchema.parse({ ...input, changeSeq: String(++this.#seq) });
    const index = this.requests.findIndex((held) => held.id === request.id);
    if (index === -1) this.requests.push(request);
    else this.requests[index] = request;
    channel.changeSeq = request.changeSeq;
    this.messages.set(root.id, {
      ...root,
      changeSeq: request.changeSeq,
      requests: this.requests.filter(
        (held) => held.channelId === channel.id && held.threadRootId === root.id,
      ),
    });
    this.publish();
    return request;
  }
  markRead(channelId: TeamChannelId, throughMessageId: string): void {
    const held = this.#reads.get(channelId) ?? "0";
    if (BigInt(throughMessageId) > BigInt(held)) this.#reads.set(channelId, throughMessageId);
    this.publish();
  }
  post(
    input: Pick<TeamMessage, "channelId" | "bodyMarkdown"> &
      Partial<
        Pick<
          TeamMessage,
          | "authorUserId"
          | "authorKind"
          | "agentRequestId"
          | "clientMessageId"
          | "threadRootId"
          | "createdAt"
          | "attachments"
          | "mentions"
          | "pinned"
        >
      >,
  ): TeamMessage {
    const channel = this.channels.get(input.channelId);
    if (!channel) throw new Error("Unknown channel.");
    const authorUserId = input.authorUserId ?? this.userId;
    if (!this.members.some((member) => member.userId === authorUserId))
      throw new Error("Unknown member.");
    const message = TeamMessageSchema.parse({
      authorUserId,
      authorKind: "human",
      agentRequestId: null,
      clientMessageId: crypto.randomUUID(),
      threadRootId: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      mentions: [],
      attachments: [],
      pinned: false,
      replySummary: { count: 0, latestMessageId: null, repliers: [] },
      requests: [],
      ...input,
      id: String(++this.#messageId),
      changeSeq: String(++this.#seq),
      plainText: input.bodyMarkdown,
    });
    this.messages.set(message.id, message);
    channel.changeSeq = message.changeSeq;
    channel.latestMessageId = message.id;
    if (message.threadRootId) {
      const root = this.messages.get(message.threadRootId);
      if (root) {
        const replies = [...this.messages.values()].filter(
          (row) => row.threadRootId === root.id && !row.deletedAt,
        );
        this.messages.set(root.id, {
          ...root,
          changeSeq: message.changeSeq,
          replySummary: {
            count: replies.length,
            latestMessageId: message.id,
            repliers: [...new Set(replies.map((row) => row.authorUserId).reverse())].slice(0, 4),
          },
        });
      }
    }
    this.publish();
    return message;
  }
  publish(): void {
    for (const [socket, scopes] of this.#sockets) {
      socket.deliver({ type: "team.sidebar", sidebar: this.#sidebarPage() });
      for (const [id, { scope, generation }] of scopes)
        socket.deliver({ type: "team.cut", cut: this.cut(scope, id, generation, null) });
    }
  }
  dispose(): void {
    for (const socket of this.#sockets.keys()) socket.close();
    this.#sockets.clear();
  }
}
