import {
  CloudDeploymentOperationIdSchema,
  CloudDeploymentOperationSchema,
  CreateCloudDeploymentRequestSchema,
  DeleteCloudDeploymentRequestSchema,
  ListCloudDeploymentsResponseSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import { ControlPlaneError } from "../server/errors.js";
import { toWebHeaders } from "../portal/routes.js";
import type { CloudDeploymentLifecycle } from "./lifecycle.js";

const OperationParamsSchema = z.strictObject({ operationId: CloudDeploymentOperationIdSchema });

export function registerCloudDeploymentRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly authenticator: ControlPlaneAuthenticator;
    readonly cloudDeployments?: CloudDeploymentLifecycle;
  },
): void {
  app.get("/v1/account/cloud-deployments", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:read",
    });
    void reply.header("cache-control", "no-store");
    return ListCloudDeploymentsResponseSchema.parse({
      available: dependencies.cloudDeployments?.available ?? false,
      deployments: (await dependencies.cloudDeployments?.list(principal.accountId)) ?? [],
    });
  });
  app.post("/v1/account/cloud-deployments", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:write",
      mutation: true,
    });
    const input = CreateCloudDeploymentRequestSchema.parse(request.body);
    void reply.header("cache-control", "no-store");
    return CloudDeploymentOperationSchema.parse(
      await requireLifecycle().create(principal.accountId, input),
    );
  });
  app.post("/v1/account/cloud-deployments/:operationId/retry", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:write",
      mutation: true,
    });
    const { operationId } = OperationParamsSchema.parse(request.params);
    z.strictObject({}).parse(request.body ?? {});
    void reply.header("cache-control", "no-store");
    return CloudDeploymentOperationSchema.parse(
      await requireLifecycle().retry(principal.accountId, operationId),
    );
  });
  app.delete("/v1/account/cloud-deployments/:operationId", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:write",
      mutation: true,
    });
    const { operationId } = OperationParamsSchema.parse(request.params);
    const { name } = DeleteCloudDeploymentRequestSchema.parse(request.body);
    void reply.header("cache-control", "no-store");
    return CloudDeploymentOperationSchema.parse(
      await requireLifecycle().delete(principal.accountId, operationId, name),
    );
  });
  function requireLifecycle(): CloudDeploymentLifecycle {
    if (!dependencies.cloudDeployments)
      throw new ControlPlaneError("unavailable", "Cloud deployment creation is not available");
    return dependencies.cloudDeployments;
  }
}
