import type { TeamActor, TeamAgentRequestId, TeamBlobId, TeamLinkId } from "@opensteer/core";
import {
  TeamFileResultSchema,
  TeamLinkClientFrameSchema,
  TeamReadResultSchema,
  type TeamBinaryUploadMetadataSchema,
  type TeamSearchInputSchema,
} from "@opensteer/protocol";
import { requireTeam } from "@opensteer/database/team-access";
import { teamFileView } from "@opensteer/database/team-files";
import type { z } from "zod";
import type { TeamKnowledge, TeamKnowledgeSqlCall } from "../knowledge/team-knowledge.js";
import type { startTeamServices } from "./services.js";

type Services = Awaited<ReturnType<typeof startTeamServices>>;
type ReadCall = Extract<z.infer<typeof TeamLinkClientFrameSchema>, { type: "read" }>;
type UploadPart = {
  readonly name: "original" | "preview";
  readonly bytes: AsyncIterable<Uint8Array>;
};

export function createTeamMachineAdapters(
  services: Services,
  knowledge: Pick<TeamKnowledge, "sql">,
) {
  const { access, chat, requests, files } = services;
  async function authorize(
    actor: TeamActor,
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    action: "read" | "post",
  ) {
    requireTeam(actor.kind === "agent");
    const request = await requests.authorize(linkId, requestId, action);
    requireTeam(request.ownerUserId === actor.userId);
    return request;
  }
  return {
    data: {
      sql: (
        linkId: TeamLinkId,
        requestId: TeamAgentRequestId,
        input: TeamKnowledgeSqlCall["input"],
      ) => knowledge.sql({ linkId, requestId, input }),
      async read(actor: TeamActor, linkId: TeamLinkId, input: ReadCall) {
        await authorize(actor, linkId, input.requestId, "read");
        return chat.read(actor, "read", input.channelId, async (t) => {
          const page = await chat.pageIn(
            t,
            actor,
            input.channelId,
            input.before
              ? { direction: "before", messageId: input.before }
              : { direction: "newest" },
            input.threadRootId,
          );
          const rootId =
            input.threadRootId ?? page.messages[0]?.threadRootId ?? page.messages[0]?.id;
          requireTeam(rootId, "This channel has no messages");
          const source = await chat.source(t, actor, input.channelId, rootId);
          return TeamReadResultSchema.parse({ page, source });
        });
      },
      async search(
        actor: TeamActor,
        linkId: TeamLinkId,
        requestId: TeamAgentRequestId,
        input: z.infer<typeof TeamSearchInputSchema>,
      ) {
        await authorize(actor, linkId, requestId, "read");
        return chat.search(actor, input);
      },
    },
    files: {
      async open(input: {
        actor: TeamActor;
        linkId: TeamLinkId;
        requestId: TeamAgentRequestId;
        blobId: TeamBlobId;
        part: "original" | "preview";
        signal: AbortSignal;
      }) {
        await authorize(input.actor, input.linkId, input.requestId, "read");
        const blob = await files.store.authorized(input.actor, input.blobId, input.requestId);
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
        );
        return { file: teamFileView(blob), source, bytes: opened.body };
      },
      async upload(input: {
        actor: TeamActor;
        linkId: TeamLinkId;
        requestId: TeamAgentRequestId;
        metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>;
        signal: AbortSignal;
        parts: AsyncIterable<UploadPart>;
      }) {
        const request = await authorize(input.actor, input.linkId, input.requestId, "post");
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
          request.channelId,
          input.metadata,
          {
            original: original(),
            ...(input.metadata.previewSizeBytes ? { preview: preview() } : {}),
          },
          input.requestId,
          input.signal,
        );
        const source = await access.database
          .transaction()
          .execute((t) =>
            chat.source(
              t,
              input.actor,
              request.channelId,
              request.threadRootId,
              request.triggerMessageId,
            ),
          );
        return TeamFileResultSchema.parse({ file, source });
      },
    },
  };
}
