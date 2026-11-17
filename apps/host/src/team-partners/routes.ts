import type { FastifyInstance } from "fastify";
import { teamPartnerSocketPath } from "@opensteer/protocol";
import { partnerError } from "./identity.js";
import type { TeamPartners } from "./service.js";

export function registerTeamPartnerRoutes(app: FastifyInstance, partners: TeamPartners) {
  app.get(
    teamPartnerSocketPath,
    {
      websocket: true,
      preValidation: async (request) => {
        if (
          request.url !== teamPartnerSocketPath ||
          request.headers.authorization !== undefined ||
          request.headers.cookie !== undefined ||
          request.headers.origin !== undefined
        )
          throw partnerError();
      },
    },
    (socket) => partners.accept(socket),
  );
}
