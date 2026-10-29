import Fastify, { type FastifyInstance } from "fastify";

export class ChannelRuntimeServer {
  readonly app: FastifyInstance;

  constructor(options: {
    readonly logger?: boolean | Record<string, unknown>;
    readonly providers: () => readonly string[];
    readonly ready: () => boolean;
  }) {
    this.app = Fastify({
      logger: options.logger ?? false,
      requestIdHeader: false,
    });
    this.app.get("/healthz", async () => ({ ok: true, providers: options.providers() }));
    this.app.get("/readyz", async (_request, reply) => {
      const hostAuthenticated = options.ready();
      return reply
        .code(hostAuthenticated ? 200 : 503)
        .send({ hostAuthenticated, ok: hostAuthenticated });
    });
  }
}
