import type { IdentityService } from "@opensteer/identity";
import type { TeamMembersStore } from "@opensteer/database/team-members";
import {
  TeamSessionExchangeRequestSchema,
  TeamSessionExchangeResponseSchema,
  teamSessionExchangePath,
} from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";

/**
 * Public on purpose: the signed, single-use Account assertion is the authentication. Its body
 * carries the assertion and invite verifier, so nothing here may log or echo it.
 */
export function registerTeamSessionExchangeRoute(
  app: FastifyInstance,
  options: { readonly identity: IdentityService; readonly members: TeamMembersStore },
): void {
  app.post(teamSessionExchangePath, async (request, reply) => {
    const body = TeamSessionExchangeRequestSchema.parse(request.body);
    const userAgent = request.headers["user-agent"];
    const entered = await options.identity.exchangeTeamSession({
      assertion: body.assertion,
      ...(body.invite ? { invite: body.invite } : {}),
      userAgent: typeof userAgent === "string" ? userAgent : null,
    });
    const member = await options.members.get({ kind: "human", userId: entered.userId });
    void reply.header("cache-control", "no-store");
    return TeamSessionExchangeResponseSchema.parse({
      admitted: entered.admitted,
      member,
      tokens: entered.tokens,
    });
  });
}
