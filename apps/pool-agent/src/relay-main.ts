/**
 * The pool relay's process: its own unprivileged user, the one the host's rules let reach a
 * guest's bridge port. `relay.json`: `{ "listen": { "host", "port" }, "certificate": <path>,
 * "authSocket": <path> }`; the host key comes from systemd's credential directory (`host-key`),
 * never from a file this user could read otherwise.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createRelayServer, relayAuthClient } from "./relay.js";

const configSchema = z.strictObject({
  listen: z.strictObject({ host: z.string().min(1), port: z.number().int().min(1).max(65_535) }),
  certificate: z.string().startsWith("/"),
  authSocket: z.string().startsWith("/"),
});

function log(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const config = configSchema.parse(
    JSON.parse(await readFile(process.argv[2] ?? "/etc/opensteer-pool/relay.json", "utf8")),
  );
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (!credentials) throw new Error("The relay's host key is given as a systemd credential.");
  const server = createRelayServer({
    key: await readFile(join(credentials, "host-key"), "utf8"),
    certificate: await readFile(config.certificate, "utf8"),
    authorize: relayAuthClient(config.authSocket),
    log,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  log({ event: "relay.ready", port: config.listen.port });
  const stop = () => server.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  log({ event: "relay.failed", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
