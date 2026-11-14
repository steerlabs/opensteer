import { withTeamPeerVersion } from "@opensteer/database/team-access";
import type { FastifyInstance, FastifyRequest } from "fastify";
import "@fastify/websocket";
import { OpensteerError } from "@opensteer/core";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { teamStorageFullReason } from "@opensteer/database/team-files";
import { teamBinaryRoutes } from "@opensteer/protocol";
import { Readable } from "node:stream";
import { checkTeamVersion, linkError, teamLinkRoutes } from "./contracts.js";
import type { TeamLinkEndpoint } from "./endpoint.js";
import type { TeamLinkBinary } from "./binary.js";

function headers(request: FastifyRequest): Record<string, string> {
  const selected: Record<string, string> = {};
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index]!.toLowerCase();
    if (
      name === "authorization" ||
      name === "content-type" ||
      name.startsWith("x-opensteer-team-")
    ) {
      if (selected[name] !== undefined) throw linkError("unauthorized");
      selected[name] = request.raw.rawHeaders[index + 1]!;
    }
  }
  if (request.raw.url?.includes("?")) throw linkError("bad_request");
  return selected;
}

export async function registerTeamLinkRoutes(
  app: FastifyInstance,
  endpoint: TeamLinkEndpoint,
  binary: TeamLinkBinary,
): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      const version =
        error instanceof OpensteerError &&
        (error.reason === "unsupported-version" || error.reason === "api-version-mismatch");
      const full = error instanceof OpensteerError && error.reason === teamStorageFullReason;
      const status = version
        ? 426
        : full
          ? 507
          : error instanceof OpensteerError && error.code === "unauthorized"
            ? 401
            : 403;
      void reply
        .code(status)
        .header(teamApiVersionHeader, String(teamApiVersion))
        .send({
          error: version
            ? "Team API version mismatch"
            : full
              ? error.message
              : "Team request is unavailable",
        });
    });
    scope.addHook("onRequest", async (request) => {
      const values: string[] = [];
      for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
        if (request.raw.rawHeaders[index]!.toLowerCase() === teamApiVersionHeader)
          values.push(request.raw.rawHeaders[index + 1]!);
      checkTeamVersion(values.length === 1 ? values[0] : undefined);
    });
    scope.post(teamLinkRoutes.redeem, { bodyLimit: 8192 }, async (request) =>
      endpoint.options.links.redeem(request.body),
    );
    scope.get(
      teamLinkRoutes.socket,
      {
        websocket: true,
        preValidation: async (request) => {
          const value = headers(request).authorization;
          if (!value?.startsWith("Bearer ")) throw linkError("unauthorized");
          await endpoint.options.links.authenticate(value.slice(7));
        },
      },
      (socket, request) => {
        socket.pause();
        void (async () => {
          const credential = headers(request).authorization!.slice(7);
          const link = await endpoint.options.links.authenticate(credential);
          await endpoint.attach(socket, link.id);
          socket.resume();
        })().catch(() => socket.terminate());
      },
    );
    scope.get(teamBinaryRoutes.download, async (request, reply) => {
      const controller = new AbortController();
      reply.raw.once("close", () => controller.abort());
      const result = await withTeamPeerVersion(Number(request.headers[teamApiVersionHeader]), () =>
        binary.download(headers(request), controller.signal),
      );
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", result.size)
        .header("content-disposition", 'attachment; filename="download"')
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox")
        .header("cache-control", "no-store")
        .header(
          "x-opensteer-team-file",
          Buffer.from(JSON.stringify({ file: result.file, source: result.source })).toString(
            "base64url",
          ),
        )
        .send(result.bytes);
    });
    scope.addContentTypeParser(/^multipart\/form-data/u, (_request, payload, done) =>
      done(null, payload),
    );
    scope.post(
      teamBinaryRoutes.upload,
      { bodyLimit: 100 * 1024 * 1024 + 80 * 1024 },
      async (request, reply) => {
        if (!(request.body instanceof Readable)) throw linkError("bad_request");
        const controller = new AbortController();
        request.raw.once("aborted", () => controller.abort());
        reply.raw.once("close", () => controller.abort());
        try {
          const body = request.body;
          return await withTeamPeerVersion(Number(request.headers[teamApiVersionHeader]), () =>
            binary.upload(headers(request), body, controller.signal),
          );
        } catch (error) {
          request.body.destroy();
          throw error;
        } finally {
          controller.abort();
        }
      },
    );
  });
}
