import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import { resolvePublicAddresses } from "../../packages/access/src/public-network.js";

/**
 * The account service as the product requires its issuer to be, a bare public HTTPS origin, in
 * the guest: a public-looking name the guest's hosts file puts on an address of the guest's own
 * loopback interface (`journeyAccountAddress`, one the Host's resolver counts as public), and a certificate
 * from a fixture authority made for the job. The guarded step `scripts/test-vm/fixture-keychain.sh`
 * makes both and removes them (`account-tls.test.ts` holds these names to it). The Mac app is
 * handed the authority as NODE_EXTRA_CA_CERTS, which it passes to its Host, and its Chromium is
 * told at launch to accept the account service's one public key (`journeyAccountSpki`). Nothing in
 * the guest's system trust changes.
 */
export const journeyAccountName = "account.first-run.opensteer.example";

/**
 * Where the guest puts that name: an address of its own on the guest's loopback interface, which
 * the Host's resolver counts as public (`isPublicIp`), as it never counts 127.0.0.1. It is in
 * 192.88.99.0/24, the 6to4 relay anycast prefix RFC 7526 deprecated, so no destination a guest
 * reaches is there; the guest step adds it, and the hosts line naming it, and removes both.
 */
export const journeyAccountAddress = "192.88.99.10";

/** Where the guest step writes the authority and the account service's certificate. */
export function fixtureAuthorityDirectory(home = homedir()): string {
  return path.join(home, "opensteer-job", "fixture-authority");
}

export interface JourneyAccountTls {
  readonly name: string;
  /** Where the guest's hosts line puts the name: the account service's TLS front listens there. */
  readonly address: string;
  /** The authority's certificate file: what the Mac app gets as NODE_EXTRA_CA_CERTS. */
  readonly authorityFile: string;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

/** The guest's fixture authority, or null where the guest step did not make one. */
export function journeyAccountTls(
  directory = fixtureAuthorityDirectory(),
): JourneyAccountTls | null {
  const file = (name: string) => path.join(directory, name);
  if (!["ca.pem", "account.pem", "account.key"].every((name) => existsSync(file(name))))
    return null;
  return {
    address: journeyAccountAddress,
    authorityFile: file("ca.pem"),
    ca: readFileSync(file("ca.pem"), "utf8"),
    cert: readFileSync(file("account.pem"), "utf8"),
    key: readFileSync(file("account.key"), "utf8"),
    name: journeyAccountName,
  };
}

/**
 * What the Host's key fetch does with the account service's name, done before anything is
 * launched: the guest resolves it to its loopback address, and the Host's own resolver rule takes
 * that address as public. A name it refuses stops the journey here, with the address it found,
 * not later as a Home that never links (run on e7080ea31).
 */
export async function assertAccountAddressPublic(tls: JourneyAccountTls): Promise<void> {
  let addresses: readonly { readonly address: string }[];
  try {
    addresses = await resolvePublicAddresses(tls.name);
  } catch (error) {
    throw new Error(
      `The Host would refuse ${tls.name}: ${error instanceof Error ? error.message : String(error)}. scripts/test-vm/fixture-keychain.sh puts it on ${tls.address}.`,
    );
  }
  const found = addresses.map(({ address }) => address);
  if (found.length !== 1 || found[0] !== tls.address)
    throw new Error(`${tls.name} resolves to ${found.join(", ")}, not ${tls.address}`);
}

/**
 * The account service certificate's public key as Chromium's
 * `--ignore-certificate-errors-spki-list` names one: the base64 SHA-256 of its SubjectPublicKeyInfo.
 */
export function journeyAccountSpki(certificate: string): string {
  const key = new X509Certificate(certificate).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(key).digest("base64");
}

/**
 * What the journey's own sign-in client does with the fixture's files, done before anything is
 * launched: a TLS handshake with a server holding the account service's pair, on loopback under
 * the account host's name, trusting only the authority. A pair it refuses stops the journey here,
 * with Node's reason, not later as a sign-in that never finishes.
 */
export async function assertAccountTlsAccepted(tls: JourneyAccountTls): Promise<void> {
  const server = createServer({ cert: tls.cert, key: tls.key }, (_incoming, outgoing) =>
    outgoing.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const refused = await new Promise<string | null>((resolve) => {
      const outgoing = request(
        { ca: tls.ca, host: "127.0.0.1", path: "/", port, servername: tls.name },
        (incoming) => {
          incoming.resume();
          resolve(null);
        },
      );
      outgoing.on("error", (error) => resolve(error.message));
      outgoing.end();
    });
    if (refused !== null)
      throw new Error(
        `Node's client refuses the fixture authority's certificate for ${tls.name}: ${refused}`,
      );
  } finally {
    server.close();
  }
}
