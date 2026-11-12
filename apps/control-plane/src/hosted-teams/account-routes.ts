import {
  CreateHostedTeamRequestSchema,
  HostedTeamAvailabilityQuerySchema,
  HostedTeamAvailabilityResponseSchema,
  HostedTeamIdSchema,
  HostedTeamResponseSchema,
  ListHostedTeamsResponseSchema,
  accountHostedTeamAvailabilityPath,
  accountHostedTeamsPath,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import { toWebHeaders } from "../portal/routes.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedTeamStore } from "./hosted-team-store.js";

const TeamParamsSchema = z.strictObject({ id: HostedTeamIdSchema });

/** The Account JSON API native apps use to create, follow, retry and remove hosted teams. */
export function registerHostedTeamAccountRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly authenticator: ControlPlaneAuthenticator;
    readonly hostedTeams: HostedTeamStore;
  },
): void {
  const { authenticator, hostedTeams } = dependencies;
  const read = (headers: Parameters<typeof toWebHeaders>[0]) =>
    authenticator.authenticate(toWebHeaders(headers), { scope: "deployments:read" });
  const write = (headers: Parameters<typeof toWebHeaders>[0]) =>
    authenticator.authenticate(toWebHeaders(headers), {
      mutation: true,
      scope: "deployments:write",
    });

  app.get(accountHostedTeamAvailabilityPath, async (request, reply) => {
    await read(request.headers);
    const { slug } = HostedTeamAvailabilityQuerySchema.parse(request.query);
    void reply.header("cache-control", "no-store");
    return HostedTeamAvailabilityResponseSchema.parse(await hostedTeams.availability(slug));
  });

  app.get(accountHostedTeamsPath, async (request, reply) => {
    const principal = await read(request.headers);
    void reply.header("cache-control", "no-store");
    return ListHostedTeamsResponseSchema.parse({
      teams: await hostedTeams.listForAccount(principal.accountId),
    });
  });

  app.post(accountHostedTeamsPath, async (request, reply) => {
    const principal = await write(request.headers);
    const input = CreateHostedTeamRequestSchema.parse(request.body);
    const team = await hostedTeams.create(principal.accountId, input);
    void reply.code(201).header("cache-control", "no-store");
    return HostedTeamResponseSchema.parse(team);
  });

  app.get(`${accountHostedTeamsPath}/:id`, async (request, reply) => {
    const principal = await read(request.headers);
    const { id } = TeamParamsSchema.parse(request.params);
    const team = await hostedTeams.forAccount(principal.accountId, id);
    if (!team) throw new ControlPlaneError("not_found", "Hosted team was not found");
    void reply.header("cache-control", "no-store");
    return HostedTeamResponseSchema.parse(team);
  });

  app.post(`${accountHostedTeamsPath}/:id/retry`, async (request, reply) => {
    const principal = await write(request.headers);
    const { id } = TeamParamsSchema.parse(request.params);
    void reply.header("cache-control", "no-store");
    return HostedTeamResponseSchema.parse(await hostedTeams.retry(principal.accountId, id));
  });

  app.delete(`${accountHostedTeamsPath}/:id`, async (request, reply) => {
    const principal = await write(request.headers);
    const { id } = TeamParamsSchema.parse(request.params);
    void reply.header("cache-control", "no-store");
    return HostedTeamResponseSchema.parse(await hostedTeams.remove(principal.accountId, id));
  });
}
