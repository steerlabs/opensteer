import {
  HostedTeamIdSchema,
  HostedTeamStatusReportSchema,
  DesiredHostedTeamsResponseSchema,
  hostedTeamsDesiredPath,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedTeamStore } from "./hosted-team-store.js";

const googleIssuers = ["https://accounts.google.com", "accounts.google.com"];
const googleKeys = new URL("https://www.googleapis.com/oauth2/v3/certs");

/**
 * Admits exactly one Google service account: the provisioner's Workload Identity. Its ID token
 * names this Account as audience, so a token minted for any other service is refused here.
 */
export function googleServiceAccountVerifier(input: {
  readonly audience: string;
  readonly email: string;
  readonly keys?: JWTVerifyGetKey;
}): (authorization: string | undefined) => Promise<void> {
  const keys = input.keys ?? createRemoteJWKSet(googleKeys);
  return async (authorization) => {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/u.exec(authorization ?? "")?.[1];
    if (!token) throw new ControlPlaneError("unauthorized", "Provisioner credential is required");
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        audience: input.audience,
        issuer: googleIssuers,
      }));
    } catch {
      throw new ControlPlaneError("unauthorized", "Provisioner credential is invalid");
    }
    if (payload.email !== input.email || payload.email_verified !== true) {
      throw new ControlPlaneError("forbidden", "Provisioner credential is not allowed");
    }
  };
}

const StatusParamsSchema = z.strictObject({ id: HostedTeamIdSchema });

export function registerHostedTeamProvisionerRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly hostedTeams: HostedTeamStore;
    readonly verifyProvisioner: (authorization: string | undefined) => Promise<void>;
    readonly kickBootstrap?: () => void;
  },
): void {
  const authenticate = (request: FastifyRequest) =>
    dependencies.verifyProvisioner(request.headers.authorization);

  app.get(hostedTeamsDesiredPath, async (request, reply) => {
    await authenticate(request);
    void reply.header("cache-control", "no-store");
    return DesiredHostedTeamsResponseSchema.parse({
      teams: await dependencies.hostedTeams.desired(),
    });
  });

  app.post("/v1/hosted-teams/:id/status", async (request, reply) => {
    await authenticate(request);
    const { id } = StatusParamsSchema.parse(request.params);
    const recorded = await dependencies.hostedTeams.reportStatus(
      id,
      HostedTeamStatusReportSchema.parse(request.body),
    );
    if (recorded.configuring) dependencies.kickBootstrap?.();
    void reply.header("cache-control", "no-store");
    return { recorded: true };
  });
}
