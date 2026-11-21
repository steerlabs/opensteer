import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";

// The production ticket issuer is in-process and has no public issuance route.
// Expose it only through a private fixture socket in the verifier's BYO Host.
const socketPath = "/tmp/opensteer-home-proof-cdp.sock";
globalThis.opensteerHomeProofCdp = (runtime) => {
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
    });
    socket.on("error", () => socket.destroy());
    socket.on("end", () => {
      void (async () => {
        const { ownerId, threadId, environmentId } = JSON.parse(body);
        const authority = { ownerId, agentBindingId: `thread:${threadId}`, environmentId };
        const { session } = await runtime.browser.openAgentSession({ ...authority, fresh: true });
        const { path } = await runtime.browser.issueStandardCdpTicket({
          authority,
          browserSessionId: session.id,
          mode: "session",
        });
        socket.end(JSON.stringify({ path, sessionId: session.id }));
      })().catch((error) => {
        socket.end(JSON.stringify({ error: error.message }));
      });
    });
  });
  server.listen(socketPath).unref();
};

// The bundler may rename the local (`address2` in the Host image), so match the statement.
const anchor = /^(\s*const [A-Za-z_$][\w$]* = await runtime\.listen\(\);)$/mu;

export function injectCdpFixture(source) {
  if (!anchor.test(source)) throw new Error("Cannot find the Host CDP verifier fixture anchor");
  return source.replace(anchor, "$1\nglobalThis.opensteerHomeProofCdp(runtime);");
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== "file:///app/dist/main.js") return loaded;
    return { ...loaded, source: injectCdpFixture(String(loaded.source)) };
  },
});
