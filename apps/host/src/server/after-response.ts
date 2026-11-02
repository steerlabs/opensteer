import type { FastifyReply } from "fastify";

/** An accepted mutation survives a caller disconnecting before receiving its reply. */
export function afterResponse(reply: FastifyReply, effect: () => void): void {
  let settled = false;
  const run = () => {
    if (settled) return;
    settled = true;
    reply.raw.off("finish", run);
    reply.raw.off("close", run);
    effect();
  };
  if (reply.raw.writableFinished || reply.raw.destroyed) {
    run();
    return;
  }
  reply.raw.once("finish", run);
  reply.raw.once("close", run);
}
