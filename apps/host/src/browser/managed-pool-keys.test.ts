import { createPublicKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { afterEach, expect, it } from "vitest";
import { managedBrowserPoolRegistration } from "./managed-pool.js";
import {
  loadOrCreateManagedBrowserPoolKeys,
  managedBrowserPoolKeysPath,
  selfSignedCertificate,
} from "./managed-pool-keys.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function dataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-keys-"));
  directories.push(directory);
  return directory;
}

it("makes the Home's pooled-browser keys once, keeps them private, and reads the same ones again", async () => {
  const directory = await dataDirectory();
  const first = await loadOrCreateManagedBrowserPoolKeys(directory);
  const path = managedBrowserPoolKeysPath(directory);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const again = await loadOrCreateManagedBrowserPoolKeys(directory);
  // Only the public halves are what the Home registers; they are stable across restarts.
  expect(managedBrowserPoolRegistration(again)).toEqual(managedBrowserPoolRegistration(first));
  expect(again.ticketKey.keyId).toBe(first.ticketKey.keyId);
  // Nothing public-only is stored as the key itself: every one is a private Ed25519 key.
  expect(first.homeKey.type).toBe("private");
  expect(first.ticketKey.key.type).toBe("private");
  // A new data directory makes new keys.
  const other = await loadOrCreateManagedBrowserPoolKeys(await dataDirectory());
  expect(managedBrowserPoolRegistration(other).homeKey).not.toBe(
    managedBrowserPoolRegistration(first).homeKey,
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
});

it("makes a self-signed certificate that carries the relay key and works for TLS 1.3", async () => {
  const keys = await loadOrCreateManagedBrowserPoolKeys(await dataDirectory());
  const certificate = new X509Certificate(keys.relayCertificate);
  const spki = (key: ReturnType<typeof createPublicKey>) =>
    key.export({ format: "der", type: "spki" }).toString("base64");
  expect(spki(certificate.publicKey)).toBe(spki(createPublicKey(keys.relayKey)));
  expect(certificate.verify(certificate.publicKey)).toBe(true);
  expect(certificate.subject).toContain("opensteer-pool");
  // Presented as a client certificate, as the relay's tunnels are opened.
  const server = await dataDirectory().then(async () => {
    const serverKeys = await loadOrCreateManagedBrowserPoolKeys(await dataDirectory());
    return createServer({
      key: serverKeys.relayKey,
      cert: serverKeys.relayCertificate,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
  });
  const seen = new Promise<string>((resolve) =>
    server.on("secureConnection", (socket: TLSSocket) => {
      resolve(spki(socket.getPeerX509Certificate()!.publicKey));
      socket.end();
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const client = connect({
    host: "127.0.0.1",
    port,
    key: keys.relayKey,
    cert: keys.relayCertificate,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
  });
  client.on("error", () => undefined);
  expect(await seen).toBe(spki(createPublicKey(keys.relayKey)));
  client.destroy();
  server.close();
  expect(() => selfSignedCertificate(createPublicKey(keys.relayKey) as never)).toThrow();
});

it("gives every start racing the first one the same whole keys, never a file being written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-keys-race-"));
  try {
    const all = await Promise.all(
      Array.from({ length: 16 }, () => loadOrCreateManagedBrowserPoolKeys(directory)),
    );
    const first = managedBrowserPoolRegistration(all[0]!);
    for (const keys of all) expect(managedBrowserPoolRegistration(keys)).toEqual(first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
