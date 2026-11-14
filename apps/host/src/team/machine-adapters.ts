import { sql } from "kysely";
import type { TeamActor, TeamLinkId } from "@opensteer/core";
import {
  TeamFileResultSchema,
  TeamLinkClientFrameSchema,
  TeamReadResultSchema,
} from "@opensteer/protocol";
import { requireTeam } from "@opensteer/database/team-access";
import { teamFileView } from "@opensteer/database/team-files";
import type { z } from "zod";
import type { TeamKnowledge } from "../knowledge/team-knowledge.js";
import type { TeamLinkCall, TeamMachineFilesPort } from "../team-link-endpoint/contracts.js";
import type { startTeamServices } from "./services.js";

type Services = Awaited<ReturnType<typeof startTeamServices>>;
type ReadCall = Extract<z.infer<typeof TeamLinkClientFrameSchema>, { type: "read" }>;
export function createTeamMachineAdapters(
  services: Pick<Services, "access" | "chat" | "files">,
  knowledge: Pick<TeamKnowledge, "topics" | "readNotes" | "write">,
) {
  const { access, chat, files } = services;
  return {
    data: {
      async channels(
        actor: TeamActor,
        linkId: TeamLinkId,
        input: Extract<TeamLinkCall, { type: "channels" }>,
      ) {
        const page = await chat.directory(actor, input.after, false, undefined, linkId, {
          ...input,
          operationId: input.operationId ?? input.id,
        });
        return {
          channels: page.channels.map((entry) => entry.channel),
          hasMore: page.nextCursor !== null,
          nextAfter: page.nextCursor,
        };
      },
      async knowledge(
        linkId: TeamLinkId,
        ownerUserId: TeamActor["userId"],
        frame: Extract<TeamLinkCall, { type: `knowledge.${string}` }>,
      ) {
        const agent = {
          linkId,
          ownerUserId,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        };
        switch (frame.type) {
          case "knowledge.topics": {
            const answer = await knowledge.topics(agent);
            return {
              result: { kind: "knowledge.topics" as const, result: answer.result },
              reauthorize: answer.reauthorize,
            };
          }
          case "knowledge.read": {
            const answer = await knowledge.readNotes(agent, frame.input);
            return {
              result: { kind: "knowledge.read" as const, result: answer.result },
              reauthorize: answer.reauthorize,
            };
          }
          case "knowledge.write": {
            const answer = await knowledge.write(agent, frame.input);
            return {
              result: { kind: "knowledge.write" as const, result: answer.result },
              reauthorize: answer.reauthorize,
            };
          }
        }
      },
      async read(actor: TeamActor, linkId: TeamLinkId, input: ReadCall) {
        return chat.read(
          actor,
          "read",
          input.channelId,
          async (t) => {
            const page = await chat.pageIn(
              t,
              actor,
              input.channelId,
              input.after
                ? { direction: "after", messageId: input.after }
                : input.before
                  ? { direction: "before", messageId: input.before }
                  : { direction: "newest" },
              input.threadRootId,
            );
            const rootId =
              input.threadRootId ?? page.messages[0]?.threadRootId ?? page.messages[0]?.id;
            const source = await chat.source(t, actor, input.channelId, rootId ?? null);
            const owner = await t
              .selectFrom("teamMembers")
              .select(
                sql<string>`coalesce((select a.handle from team_share_participants a join team_shares s on s.id=a.share_id
                where s.channel_id=${input.channelId} and a.principal_id=${actor.userId} and (s.state='active' or s.role='follower')
                order by s.created_at desc limit 1),handle)`.as("handle"),
              )
              .where("userId", "=", actor.userId)
              .executeTakeFirstOrThrow();
            return TeamReadResultSchema.parse({ page, source, ownerHandle: owner.handle });
          },
          linkId,
          { ...input, operationId: input.operationId ?? input.id },
        );
      },
      async search(
        actor: TeamActor,
        linkId: TeamLinkId,
        input: Extract<TeamLinkCall, { type: "search" }>,
      ) {
        return chat.search(actor, input.input, linkId, {
          ...input,
          operationId: input.operationId ?? input.id,
        });
      },
    },
    files: {
      async open(input: Parameters<TeamMachineFilesPort["open"]>[0]) {
        const blob = await files.store.authorized(input.actor, input.blobId, input);
        const source = await access.database.transaction().execute(async (t) => {
          const message = await t
            .selectFrom("teamMessages")
            .select(["id", "threadRootId"])
            .where("id", "=", blob.messageId)
            .executeTakeFirstOrThrow();
          return chat.source(
            t,
            input.actor,
            blob.channelId,
            message.threadRootId ?? message.id,
            message.id,
          );
        });
        const opened = await files.download(
          input.actor,
          input.blobId,
          input.part,
          input.requestId,
          input.signal,
          input,
        );
        return { file: teamFileView(blob), source, bytes: opened.body };
      },
      async upload(input: Parameters<TeamMachineFilesPort["upload"]>[0]) {
        const { channelId: _, ...metadata } = input.metadata;
        const iterator = input.parts[Symbol.asyncIterator]();
        const first = await iterator.next();
        requireTeam(
          !first.done && first.value.name === "original",
          "Original upload part required first",
        );
        async function* original() {
          yield* first.value!.bytes;
          if (!input.metadata.previewSizeBytes)
            requireTeam((await iterator.next()).done, "Unexpected upload part");
        }
        async function* preview() {
          const part = await iterator.next();
          requireTeam(!part.done && part.value.name === "preview", "Image preview required second");
          yield* part.value.bytes;
          requireTeam((await iterator.next()).done, "Unexpected upload part");
        }
        const file = await files.upload(
          input.actor,
          input.metadata.channelId,
          metadata,
          {
            original: original(),
            ...(input.metadata.previewSizeBytes ? { preview: preview() } : {}),
          },
          input.requestId,
          input.signal,
          input,
        );
        const source = await access.database
          .transaction()
          .execute((t) => chat.source(t, input.actor, input.metadata.channelId, null));
        return TeamFileResultSchema.parse({ file, source });
      },
    },
  };
}
