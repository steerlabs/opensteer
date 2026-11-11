import {
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  type TeamActor,
  type AuthenticatedSession,
} from "@opensteer/core";
import { TeamBinaryUploadMetadataSchema } from "@opensteer/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { z as schema } from "zod";
import type { TeamFileService } from "./file-service.js";
import { assertTeamApiVersion } from "./services.js";
import { requireTeam, type TeamAccessStore } from "@opensteer/database/team-access";

export const teamHumanFileRoutes = {
  upload: "/v1/team/files/upload/:channelId",
  download: "/v1/team/files/:blobId/:part",
} as const;
export function registerTeamBinaryRoutes(
  app: FastifyInstance,
  options: {
    files: TeamFileService;
    access: TeamAccessStore;
    authenticate: (request: FastifyRequest, mutation: boolean) => Promise<AuthenticatedSession>;
  },
) {
  void app.register(async (binary) => {
    binary.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
      done(null, payload),
    );
    const gate = async (request: FastifyRequest) => {
      const headers = new Headers();
      const value = request.headers["x-opensteer-team-api-version"];
      if (typeof value === "string") headers.set("x-opensteer-team-api-version", value);
      assertTeamApiVersion(headers);
    };
    binary.post(
      teamHumanFileRoutes.upload,
      { onRequest: gate, bodyLimit: 100 * 1024 * 1024 + 65536 },
      async (request, reply) => {
        const session = await options.authenticate(request, true);
        return options.access.withHumanSession(session, async () => {
          const actor: TeamActor = { kind: "human", userId: session.user.id };
          const { channelId } = schema
            .strictObject({ channelId: TeamChannelIdSchema })
            .parse(request.params);
          const header = schema
            .string()
            .max(2048)
            .parse(request.headers["x-opensteer-team-upload"]);
          const metadata = TeamBinaryUploadMetadataSchema.parse(JSON.parse(header));
          const controller = new AbortController(),
            abort = () => controller.abort(new Error("Upload disconnected"));
          request.raw.once("aborted", abort);
          try {
            const body = request.body as AsyncIterable<Uint8Array>;
            requireTeam(body && Symbol.asyncIterator in body);
            void reply.header("cache-control", "no-store");
            return await options.files.upload(
              actor,
              channelId,
              metadata,
              splitTeamUpload(body, metadata),
              undefined,
              controller.signal,
            );
          } finally {
            request.raw.off("aborted", abort);
          }
        });
      },
    );
    binary.get(teamHumanFileRoutes.download, { onRequest: gate }, async (request, reply) => {
      const session = await options.authenticate(request, false);
      return options.access.withHumanSession(session, async () => {
        const actor: TeamActor = { kind: "human", userId: session.user.id };
        const { blobId, part } = schema
          .strictObject({ blobId: TeamBlobIdSchema, part: schema.enum(["original", "preview"]) })
          .parse(request.params);
        const file = await options.files.download(actor, blobId, part);
        for (const [name, value] of Object.entries(file.headers)) void reply.header(name, value);
        void reply.header("content-length", file.sizeBytes);
        return reply.send(file.body);
      });
    });
  });
}
/** Human upload is the existing streamed binary body: original bytes followed by the bounded client preview. */
export function splitTeamUpload(
  body: AsyncIterable<Uint8Array>,
  metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>,
) {
  const iterator = body[Symbol.asyncIterator]();
  let pending: Uint8Array = new Uint8Array(0);
  let originalDone = false;
  async function* take(length: number, finish: boolean): AsyncGenerator<Uint8Array> {
    let remaining = length;
    while (remaining > 0) {
      if (!pending.length) {
        const next = await iterator.next();
        requireTeam(!next.done, "Upload ended early");
        pending = next.value;
      }
      const size = Math.min(remaining, pending.length);
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
      remaining -= size;
    }
    if (finish) {
      requireTeam(pending.length === 0, "Unexpected trailing upload bytes");
      const extra = await iterator.next();
      requireTeam(extra.done, "Unexpected trailing upload bytes");
    }
  }
  async function* original() {
    yield* take(metadata.sizeBytes, metadata.previewSizeBytes === 0);
    originalDone = true;
  }
  async function* preview() {
    requireTeam(originalDone, "Upload parts must be consumed in order");
    yield* take(metadata.previewSizeBytes, true);
  }
  return { original: original(), ...(metadata.previewSizeBytes ? { preview: preview() } : {}) };
}
