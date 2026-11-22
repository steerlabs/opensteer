// Round H's real-host run only: a stand-in for the account service's slot-egress route, on the
// host's loopback, with a certificate from a root only this run's instance trusts. It checks
// the agent's request against the host's public key exactly as the contract says, and answers
// the slot's upstream when one is assigned, {} otherwise. It logs no password.
import { createPublicKey, verify } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const hostKey = createPublicKey(readFileSync(config.hostKeyPub, "utf8"));
const record = (row) =>
  appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), ...row })}\n`);

createServer(
  { key: readFileSync(config.key), cert: readFileSync(config.cert) },
  (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const bytes = Buffer.from(
        [
          "opensteer-pool-slot-egress-v1",
          parsed.hostId,
          parsed.slotId,
          parsed.issuedAt,
          parsed.nonce,
        ].join("\n"),
        "utf8",
      );
      const signatureOk =
        typeof parsed.signature === "string" &&
        verify(null, bytes, hostKey, Buffer.from(parsed.signature, "base64"));
      const pathOk =
        request.url === `/v1/browser-pool/hosts/${encodeURIComponent(config.hostId)}/slot-egress`;
      const fresh = Math.abs(Date.now() - Date.parse(parsed.issuedAt)) < 5 * 60_000;
      const assigned = config.assigned[parsed.slotId];
      record({
        slotId: parsed.slotId,
        signatureOk,
        pathOk,
        fresh,
        assigned: !!assigned,
        nonce: parsed.nonce?.length,
      });
      if (!signatureOk || !pathOk || !fresh || parsed.hostId !== config.hostId) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(assigned ? { egress: assigned } : {}));
    });
  },
).listen(config.port, "127.0.0.1", () => record({ listening: config.port }));
