import {
  AgentDirectoryResponseSchema,
  agentDirectoryPath,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance } from "fastify";
import type { ControlPlaneAuth } from "../auth/auth.js";
import {
  accountAgentDirectorySigner,
  signAgentDirectoryDocument,
  type AgentDirectorySigner,
} from "./sign.js";
import type { AgentDirectoryReader } from "./store.js";

export const agentDirectoryCacheControl = "public, max-age=300";

export interface AgentDirectoryRouteOptions {
  readonly agentDirectory: AgentDirectoryReader;
  readonly auth?: ControlPlaneAuth;
  readonly sign?: AgentDirectorySigner;
  readonly publicOrigin: URL;
  readonly now?: () => number;
}

export function registerAgentDirectoryRoutes(
  app: FastifyInstance,
  options: AgentDirectoryRouteOptions,
): void {
  const sign =
    options.sign ?? (options.auth ? accountAgentDirectorySigner(options.auth) : undefined);
  if (!sign) {
    throw new Error("registerAgentDirectoryRoutes requires auth or sign");
  }
  app.get(agentDirectoryPath, async (_request, reply) => {
    const document = await options.agentDirectory.document();
    const assertion = await signAgentDirectoryDocument({
      document,
      issuer: options.publicOrigin,
      sign,
      ...(options.now ? { now: options.now } : {}),
    });
    void reply.header("cache-control", agentDirectoryCacheControl);
    return AgentDirectoryResponseSchema.parse({ assertion });
  });
}
