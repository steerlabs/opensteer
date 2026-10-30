import compress, { type FastifyCompressOptions } from "@fastify/compress";
import { hostApi } from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import { constants } from "node:zlib";

// The reads a client makes to show Chat, tasks and tabs, opted in by method
// name rather than URL prefix: commands can mint credentials, and other reads
// (invitations, authentication, triggers) can return secrets beside
// caller-controlled labels, which compression would turn into a length oracle.
// Review each addition for that.
export const compressedReads = new Set<keyof typeof hostApi>([
  "bootstrap.get",
  "browser.tabs.get",
  "requests.list",
  "tasks.list",
  "thread.assignments.list",
  "thread.events.list",
  "thread.inputQueue.get",
  "thread.live.get",
  "thread.messages.list",
  "thread.requests.list",
  "workspace.tabs.get",
]);

const compressionOptions = {
  encodings: ["br", "gzip", "deflate"],
  threshold: 1024,
  syncThreshold: 0,
  brotliOptions: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
  zlibOptions: { level: 6 },
} satisfies FastifyCompressOptions;

export async function registerResponseCompression(app: FastifyInstance): Promise<void> {
  app.addHook("onRoute", (route) => {
    const name = route.url.startsWith("/v1/rpc/") ? route.url.slice(8) : "";
    const declaration = hostApi[name as keyof typeof hostApi];
    route.compress =
      compressedReads.has(name as keyof typeof hostApi) &&
      declaration &&
      route.method === declaration.method &&
      !declaration.stream &&
      !("binaryRequest" in declaration)
        ? compressionOptions
        : false;
  });
  await app.register(compress, {
    ...compressionOptions,
    global: false,
    globalDecompression: false,
  });
  // The plugin appends its onSend hook to each opted-in route. Guard only
  // that last hook, preserving any earlier route hooks: only complete JSON
  // strings may enter the compressor.
  app.addHook("onRoute", (route) => {
    if (!route.compress) return;
    const hooks = Array.isArray(route.onSend) ? route.onSend : route.onSend ? [route.onSend] : [];
    route.onSend = hooks.map((hook, index) =>
      index !== hooks.length - 1
        ? hook
        : function (this: FastifyInstance, request, reply, payload, done) {
            const type = String(reply.getHeader("content-type") ?? "");
            if (
              typeof payload !== "string" ||
              !/^application\/(?:[\w.-]+\+)?json(?:;|$)/iu.test(type) ||
              request.headers.range !== undefined ||
              request.headers.upgrade !== undefined ||
              reply.statusCode !== 200 ||
              reply.hasHeader("content-range") ||
              reply.hasHeader("content-length") ||
              reply.hasHeader("content-encoding") ||
              reply.hasHeader("set-cookie")
            ) {
              done(null, payload);
              return;
            }
            const vary = String(reply.getHeader("vary") ?? "");
            if (
              !vary
                .split(",")
                .some((value) => ["*", "accept-encoding"].includes(value.trim().toLowerCase()))
            ) {
              void reply.header("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
            }
            return hook.call(this, request, reply, payload, done);
          },
    );
  });
}
