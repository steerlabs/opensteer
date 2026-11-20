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
    socket.on("end", async () => {
      try {
        const { ownerId, threadId, environmentId } = JSON.parse(body);
        const authority = { ownerId, agentBindingId: `thread:${threadId}`, environmentId };
        const { session } = await runtime.browser.openAgentSession({ ...authority, fresh: true });
        const { path } = await runtime.browser.issueStandardCdpTicket({
          authority,
          browserSessionId: session.id,
          mode: "session",
        });
        socket.end(JSON.stringify({ path, sessionId: session.id }));
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  server.listen(socketPath).unref();
};

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== "file:///app/dist/main.js") return loaded;
    const source = String(loaded.source);
    const anchor = "const address = await runtime.listen();";
    if (!source.includes(anchor))
      throw new Error("Cannot find the Host CDP verifier fixture anchor");
    return {
      ...loaded,
      source: source.replace(anchor, `${anchor}\nglobalThis.opensteerHomeProofCdp(runtime);`),
    };
  },
});
