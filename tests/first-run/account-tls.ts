import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The account service as the product requires its issuer to be, a bare public HTTPS origin, in
 * the guest: a public-looking name the guest's hosts file puts on loopback, and a certificate
 * from a fixture authority made for the job. The guarded step `scripts/test-vm/fixture-keychain.sh`
 * makes both and removes them (`account-tls.test.ts` holds these names to it). The Mac app is
 * handed the authority as NODE_EXTRA_CA_CERTS, which it passes to its Host, and its Chromium is
 * told at launch to accept the account service's one public key (`journeyAccountSpki`). Nothing in
 * the guest's system trust changes.
 */
export const journeyAccountName = "account.first-run.opensteer.example";

/** Where the guest step writes the authority and the account service's certificate. */
export function fixtureAuthorityDirectory(home = homedir()): string {
  return path.join(home, "opensteer-job", "fixture-authority");
}

export interface JourneyAccountTls {
  readonly name: string;
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
    authorityFile: file("ca.pem"),
    ca: readFileSync(file("ca.pem"), "utf8"),
    cert: readFileSync(file("account.pem"), "utf8"),
    key: readFileSync(file("account.key"), "utf8"),
    name: journeyAccountName,
  };
}

/**
 * The account service certificate's public key as Chromium's
 * `--ignore-certificate-errors-spki-list` names one: the base64 SHA-256 of its SubjectPublicKeyInfo.
 */
export function journeyAccountSpki(certificate: string): string {
  const key = new X509Certificate(certificate).publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(key).digest("base64");
}
