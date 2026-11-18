declare module "fastify" {
  interface FastifyContextConfig {
    readonly apiVersion?: "exempt" | ((request: FastifyRequest) => boolean);
  }
}

/**
 * Route config for the few `/v1/` routes a browser navigation or another
 * service reaches, which cannot state the epoch. Each use says who calls it.
 */
export const unversionedRoute = { apiVersion: "exempt" } as const;
