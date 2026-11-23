import { X509Certificate } from "node:crypto";
import { lookup as resolve } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { connect } from "node:tls";

/**
 * What answered at an HTTPS origin, read without trusting it: which address the name reached,
 * and the certificate the server presented there, held against the certificate the journey's
 * account service was given. Run 20261122T204520Z-11a2b496 stopped at "self-signed certificate"
 * in the journey's own sign-in, with a chain that verifies on this Mac; this says next time which
 * certificate, from where.
 */
export interface PresentedCertificate {
  /** Every address the name resolves to here, in the order a client tries them. */
  readonly resolved: readonly string[];
  readonly address: string | null;
  readonly subject: string;
  readonly issuer: string;
  readonly fingerprint256: string;
  /** Subject and issuer the same: what a client calls self-signed at depth zero. */
  readonly selfIssued: boolean;
  /** Whether it is the certificate the account service was given. */
  readonly accountCertificate: boolean;
}

export function presentedCertificate(
  origin: string,
  accountCertificate: string,
  lookup?: LookupFunction,
): Promise<PresentedCertificate> {
  const url = new URL(origin);
  const expected = new X509Certificate(accountCertificate).fingerprint256;
  const resolved = lookup
    ? Promise.resolve([] as string[])
    : resolve(url.hostname, { all: true, order: "verbatim" }).then(
        (addresses) => addresses.map(({ address }) => address),
        (error: unknown) => [String(error)],
      );
  return resolved.then((addresses) => connected(url, origin, expected, addresses, lookup));
}

function connected(
  url: URL,
  origin: string,
  expected: string,
  resolved: readonly string[],
  lookup: LookupFunction | undefined,
): Promise<PresentedCertificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      // Read, never trusted: nothing is sent over it.
      rejectUnauthorized: false,
      ...(lookup === undefined ? {} : { lookup }),
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error(`${origin} did not answer`)));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerX509Certificate();
      const address = socket.remoteAddress ?? null;
      socket.end();
      if (!peer) {
        reject(new Error(`${origin} presented no certificate`));
        return;
      }
      resolve({
        accountCertificate: peer.fingerprint256 === expected,
        address,
        fingerprint256: peer.fingerprint256,
        issuer: peer.issuer,
        resolved,
        selfIssued: peer.subject === peer.issuer,
        subject: peer.subject,
      });
    });
  });
}

/** One line for the run's log. */
export function presentedCertificateLine(certificate: PresentedCertificate): string {
  return (
    `the name resolves to ${certificate.resolved.join(", ") || "what the test's lookup gives"}; ` +
    `the server at ${certificate.address ?? "an unknown address"} presented ` +
    `${certificate.accountCertificate ? "the account service's certificate" : "another certificate"} ` +
    `(subject ${certificate.subject.replace(/\n/gu, ", ")}; issuer ${certificate.issuer.replace(/\n/gu, ", ")}; ` +
    `sha256 ${certificate.fingerprint256})`
  );
}
