import {
  OpensteerError,
  type AuthenticatedSession,
  type DeploymentId,
  type DeploymentKind,
  type TeamActor,
} from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { TeamCommandSchema, TeamBootstrapSchema, teamReadSchemas } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { z } from "zod";
import type { ChannelTopicPort, DatabaseSchema } from "@opensteer/database";
import { TeamAccessStore, requireTeam } from "@opensteer/database/team-access";
import { TeamMembersStore } from "@opensteer/database/team-members";
import { TeamGroupsStore } from "@opensteer/database/team-groups";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamChatStore, teamMessageViews, teamRequestView } from "@opensteer/database/team-chat";
import { TeamFilesStore } from "@opensteer/database/team-files";
import { TeamAuditStore } from "@opensteer/database/team-audit";
import { TeamNoticesStore } from "@opensteer/database/team-notices";
import { TeamOutboxStore, type TeamPushDelivery } from "@opensteer/database/team-outbox";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { TeamFileService } from "./file-service.js";
import { TeamRealtimeHub } from "./realtime.js";

export function assertTeamApiVersion(headers: Headers) {
  if (headers.get(teamApiVersionHeader) !== String(teamApiVersion))
    throw new OpensteerError({
      code: "conflict",
      reason: "api-version-mismatch",
      message: "Team API version mismatch",
    });
}
export interface TeamServiceOptions {
  readonly kind: DeploymentKind;
  readonly database: Kysely<DatabaseSchema>;
  readonly teamId: DeploymentId;
  readonly teamName: string;
  readonly origin: string;
  readonly dataDirectory: string;
  readonly topics: ChannelTopicPort;
  readonly ensureKnowledge: () => Promise<void>;
  readonly knowledge: {
    read(actor: TeamActor, name: string, input: unknown): Promise<unknown>;
    command(actor: TeamActor, command: z.infer<typeof TeamCommandSchema>): Promise<unknown>;
  };
  readonly links: {
    createCode(actor: TeamActor): Promise<unknown>;
    list(actor: TeamActor): Promise<unknown>;
    revoke(actor: TeamActor, id: import("@opensteer/core").TeamLinkId): Promise<void>;
  };
  readonly publishPush: (delivery: TeamPushDelivery) => Promise<void>;
  readonly backgroundError: (area: "team-maintenance" | "team-push") => void;
}
export async function startTeamServices(options: TeamServiceOptions) {
  requireTeam(options.kind === "team", "Team services require a team Host");
  const durable = await options.database
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("id", "=", options.teamId)
    .executeTakeFirstOrThrow();
  requireTeam(durable.deploymentShape.kind === "team");
  const access = new TeamAccessStore(options.database);
  await access.initialize();
  await options.ensureKnowledge();
  const members = new TeamMembersStore(access),
    groups = new TeamGroupsStore(access),
    invites = new TeamInvitesStore(access, options.origin);
  const chat = new TeamChatStore(access, options.topics, {
    teamId: options.teamId,
    teamName: options.teamName,
  });
  const requests = new TeamRequestsStore(access, chat);
  const files = new TeamFilesStore(access);
  const fileService = new TeamFileService(files, access, options.dataDirectory);
  const realtime = new TeamRealtimeHub(access, chat);
  const outbox = new TeamOutboxStore(access, (userId, channelId) =>
    realtime.visible(userId, channelId),
  );
  const audit = new TeamAuditStore(options.database),
    notices = new TeamNoticesStore(options.database);
  let stopped = false,
    pushing: Promise<unknown> | null = null,
    maintaining: Promise<unknown> | null = null;
  const push = () => {
    if (!stopped && !pushing)
      pushing = outbox
        .drain(options.publishPush)
        .catch(() => options.backgroundError("team-push"))
        .finally(() => {
          pushing = null;
        });
  };
  const maintenance = () => {
    if (!stopped && !maintaining)
      maintaining = Promise.all([requests.expire(), fileService.collectGarbage()])
        .catch(() => options.backgroundError("team-maintenance"))
        .finally(() => {
          maintaining = null;
        });
  };
  const pushTimer = setInterval(push, 1000),
    maintenanceTimer = setInterval(maintenance, 60000);
  pushTimer.unref();
  maintenanceTimer.unref();
  const unsubscribe = chat.onChange(push);
  push();
  maintenance();
  async function dispatch(actor: TeamActor, raw: unknown): Promise<unknown> {
    requireTeam(actor.kind === "human", "Human session required for team commands");
    const command = TeamCommandSchema.parse(raw);
    requireTeam(
      command.type.startsWith("team."),
      "Personal commands are unavailable on a team Host",
    );
    if (
      command.type.startsWith("team.knowledge.") ||
      command.type === "team.channel.topic.attach" ||
      command.type === "team.channel.topic.detach"
    )
      return options.knowledge.command(actor, command);
    switch (command.type) {
      case "team.channel.create":
        return { type: command.type, channel: await chat.create(actor, command) };
      case "team.channel.update":
        await chat.update(actor, command.channelId, command);
        break;
      case "team.channel.archive":
      case "team.channel.restore":
        await chat.update(actor, command.channelId, {
          archived: command.type === "team.channel.archive",
        });
        break;
      case "team.channel.join":
      case "team.channel.leave":
        await chat.joinOrLeave(actor, command.channelId, command.type === "team.channel.join");
        break;
      case "team.channel.access.set":
        await chat.setAccess(actor, command.channelId, command.expectedRevision, command.access);
        break;
      case "team.channel.instructions.set":
        await chat.update(actor, command.channelId, command);
        break;
      case "team.dm.open":
        return { type: command.type, channel: await chat.openDm(actor, command.participants) };
      case "team.dm.people.add":
        await chat.addDmPeople(
          actor,
          command.channelId,
          command.userIds,
          command.historyVisibleConfirmed,
        );
        break;
      case "team.message.send":
        return { type: command.type, ...(await chat.send(actor, command)) };
      case "team.message.edit":
        await chat.editOrDelete(actor, command.channelId, command.messageId, command);
        break;
      case "team.message.delete":
        await chat.editOrDelete(actor, command.channelId, command.messageId, null);
        break;
      case "team.message.pin":
      case "team.message.unpin":
        await chat.pin(
          actor,
          command.channelId,
          command.messageId,
          command.type === "team.message.pin",
        );
        break;
      case "team.channel.read":
        await chat.readMarker(actor, command.channelId, command.throughMessageId);
        break;
      case "team.channel.preferences.set":
        await chat.preferences(actor, command.channelId, command.notificationLevel);
        break;
      case "team.upload.begin":
        return {
          type: command.type,
          fileId: (await files.begin(actor, command.channelId, command.metadata)).id,
        };
      case "team.upload.complete": {
        const row = await options.database
          .selectFrom("teamBlobs")
          .selectAll()
          .where("id", "=", command.blobId)
          .executeTakeFirstOrThrow();
        requireTeam(row.uploaderUserId === actor.userId && row.state === "ready");
        break;
      }
      case "team.upload.cancel":
        await files.cancel(actor, command.blobId);
        break;
      case "team.member.role.set":
        await members.change(actor, command.userId, command.role);
        break;
      case "team.member.remove":
        await members.change(actor, command.userId, "remove");
        break;
      case "team.owner.transfer":
        await members.change(actor, command.userId, "owner");
        break;
      case "team.group.create":
        await groups.create(actor, command.id, command.name);
        break;
      case "team.group.rename":
        await groups.renameOrDelete(actor, command.groupId, command.name);
        break;
      case "team.group.delete":
        await groups.renameOrDelete(actor, command.groupId, null);
        break;
      case "team.group.person.add":
      case "team.group.person.remove":
        await groups.person(
          actor,
          command.groupId,
          command.userId,
          command.type === "team.group.person.add",
        );
        break;
      case "team.group.child.add":
      case "team.group.child.remove":
        await groups.child(
          actor,
          command.groupId,
          command.childGroupId,
          command.type === "team.group.child.add",
        );
        break;
      case "team.invite.create":
        return {
          type: command.type,
          ...(await invites.create(
            actor,
            command.id,
            new Date(command.expiresAt),
            command.maxUses,
          )),
        };
      case "team.invite.revoke":
        await invites.revoke(actor, command.inviteId);
        break;
      case "team.invite.accept":
        await invites.accept(actor.userId, command.selector, command.verifier);
        break;
      case "team.link.code.create":
        return {
          type: command.type,
          ...((await options.links.createCode(actor)) as Record<string, unknown>),
        };
      case "team.link.revoke":
        await options.links.revoke(actor, command.linkId);
        break;
      case "team.notice.read":
        await notices.markRead(actor.userId, command.noticeId);
        break;
      case "team.agent.request.cancel": {
        const row = await options.database
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("id", "=", command.requestId)
          .executeTakeFirstOrThrow();
        requireTeam(row.ownerUserId === actor.userId);
        await requests.cancel(row.linkId, row.id);
        break;
      }
      default:
        throw new OpensteerError({ code: "not_found", message: "Unsupported team command" });
    }
    return { type: command.type };
  }
  async function read(actor: TeamActor, name: string, raw: unknown): Promise<unknown> {
    requireTeam(actor.kind === "human");
    if (name.startsWith("team.knowledge.")) return options.knowledge.read(actor, name, raw);
    switch (name) {
      case "team.bootstrap.get": {
        const page = await members.page(actor);
        const member =
          page.members.find((m) => m.userId === actor.userId) ??
          (await options.database.transaction().execute(async (t) => {
            await access.member(t, actor.userId);
            const row = await t
              .selectFrom("teamMembers as m")
              .innerJoin("users as u", "u.id", "m.userId")
              .selectAll("m")
              .select(["u.displayName", "u.image"])
              .where("m.userId", "=", actor.userId)
              .executeTakeFirstOrThrow();
            return { ...row, joinedAt: row.joinedAt.toISOString() };
          }));
        return TeamBootstrapSchema.strip().parse({
          teamId: options.teamId,
          teamName: options.teamName,
          member,
          can: {
            createChannel: true,
            manageMembers: member.role !== "member",
            manageGroups: member.role !== "member",
            manageInvites: member.role !== "member",
            transferOwner: member.role === "owner",
            viewAudit: member.role !== "member",
            connectAgent: true,
          },
          sidebar: await chat.directory(actor, undefined, true),
        });
      }
      case "team.sidebar.get":
        return chat.directory(actor, teamReadSchemas[name].input.parse(raw).after, true);
      case "team.channels.list": {
        const rows = await chat.directory(actor, teamReadSchemas[name].input.parse(raw).after);
        return { channels: rows.channels.map((r) => r.channel), hasMore: rows.nextCursor !== null };
      }
      case "team.channel.get": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.read(actor, "read", input.channelId, (t) =>
          chat.channelView(t, actor, input.channelId),
        );
      }
      case "team.channel.access.get":
        return chat.accessList(actor, teamReadSchemas[name].input.parse(raw).channelId);
      case "team.channel.instructions.get": {
        const input = teamReadSchemas[name].input.parse(raw);
        const row = await chat.read(actor, "read", input.channelId, (t) =>
          chat.channelView(t, actor, input.channelId),
        );
        return {
          instructionsMarkdown: row.instructionsMarkdown,
          revision: row.instructionsRevision,
        };
      }
      case "team.messages.page": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.page(actor, input.channelId, input.page);
      }
      case "team.thread.page": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.page(actor, input.channelId, input.page, input.rootId);
      }
      case "team.message.get": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.message(actor, input.channelId, input.messageId);
      }
      case "team.messages.check": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.check(actor, input.channelId, input.clientMessageIds);
      }
      case "team.search":
        return chat.search(actor, teamReadSchemas[name].input.parse(raw).input);
      case "team.members.list":
        return members.page(actor, teamReadSchemas[name].input.parse(raw).after);
      case "team.groups.list":
        return groups.page(actor, teamReadSchemas[name].input.parse(raw).after);
      case "team.group.get":
        return groups.get(actor, teamReadSchemas[name].input.parse(raw).groupId);
      case "team.invites.list":
        return invites.page(actor, teamReadSchemas[name].input.parse(raw).after);
      case "team.audit.page":
        await options.database.transaction().execute((t) => access.admin(t, actor));
        return audit.page(teamReadSchemas[name].input.parse(raw).before);
      case "team.notices.page":
        return notices.page(actor.userId, teamReadSchemas[name].input.parse(raw).before);
      case "team.files.page": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.read(actor, "files", input.channelId, () =>
          files.page(actor, input.channelId, input.before),
        );
      }
      case "team.agent.requests.get": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.read(actor, "requests", input.channelId, async (t) => ({
          requests: (
            await t
              .selectFrom("teamAgentRequests")
              .selectAll()
              .where("channelId", "=", input.channelId)
              .where("threadRootId", "=", input.rootId)
              .orderBy("createdAt", "desc")
              .limit(32)
              .execute()
          ).map(teamRequestView),
        }));
      }
      case "team.links.list":
        return options.links.list(actor);
      case "team.mentions.page":
      case "team.pins.page": {
        const input = teamReadSchemas[name].input.parse(raw);
        return chat.read(actor, "read", input.channelId, async (t) => {
          let query = t
            .selectFrom("teamMessages as m")
            .selectAll("m")
            .where("m.deletedAt", "is", null)
            .where(
              "m.channelId",
              "in",
              (await import("@opensteer/database/team-access")).teamReadableChannels(actor),
            );
          if (name === "team.mentions.page")
            query = query.where(
              "m.id",
              "in",
              t
                .selectFrom("teamMentions")
                .select("messageId")
                .where("targetUserId", "=", actor.userId)
                .where("targetKind", "=", "person"),
            );
          else
            query = query.where("m.id", "in", t.selectFrom("teamMessagePins").select("messageId"));
          if (input.channelId) query = query.where("m.channelId", "=", input.channelId);
          if (input.before) query = query.where("m.id", "<", input.before);
          const rows = await query.orderBy("m.id", "desc").limit(51).execute();
          return {
            messages: await teamMessageViews(t, rows.slice(0, 50)),
            hasMore: rows.length > 50,
          };
        });
      }
      default:
        throw new OpensteerError({
          code: "not_found",
          message: "Personal routes are unavailable on a team Host",
        });
    }
  }
  return {
    kind: "team" as const,
    access,
    resolver: access,
    locks: access,
    members,
    groups,
    invites,
    chat,
    requests,
    files: fileService,
    realtime,
    async rpc(
      headers: Headers,
      name: string,
      raw: unknown,
      authenticate: () => Promise<AuthenticatedSession>,
    ) {
      assertTeamApiVersion(headers);
      requireTeam(
        name === "commands.dispatch" ||
          (Object.hasOwn(teamReadSchemas, name) && name.startsWith("team.")),
        "Personal routes are unavailable on a team Host",
      );
      const session = await authenticate();
      const actor: TeamActor = { kind: "human", userId: session.user.id };
      await options.database.transaction().execute((t) => access.member(t, actor.userId));
      if (name === "commands.dispatch") return dispatch(actor, raw);
      return read(actor, name, raw);
    },
    dispatch,
    read,
    async close() {
      stopped = true;
      clearInterval(pushTimer);
      clearInterval(maintenanceTimer);
      unsubscribe();
      realtime.close();
      fileService.close();
      await Promise.all([pushing, maintaining]);
    },
  };
}
