import { X509Certificate } from "node:crypto";
import { createSecureContext, getCACertificates, type SecureContext } from "node:tls";
import { refused } from "@opensteer/core/opensteer-error";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import {
  browserEgressCredentialAccepted,
  parseBrowserEgressUpstreamUrl,
} from "@opensteer/browser-runtime-core/browser-egress-upstream";

const upstreamUrl = "OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL";
const upstreamUsername = "OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME";
const upstreamPassword = "OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD";
const upstreamCaFile = "OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE";

export interface BrowserEgressUpstream {
  readonly hostname: string;
  readonly port: number;
  readonly authorization: string;
  readonly secureContext: SecureContext;
}

export async function readBrowserEgressUpstream(
  environment: NodeJS.ProcessEnv,
): Promise<BrowserEgressUpstream | undefined> {
  const value = environment[upstreamUrl];
  if (value === undefined) {
    const configured = [
      upstreamUsername,
      `${upstreamUsername}_FILE`,
      upstreamPassword,
      `${upstreamPassword}_FILE`,
      upstreamCaFile,
    ].find((name) => environment[name] !== undefined);
    if (configured) throw refused("bad_request", `${configured} requires ${upstreamUrl}.`);
    return undefined;
  }
  // Round I, U2: the same check a pool host applies before it writes an upstream.
  const url = parseBrowserEgressUpstreamUrl(value);
  if (!url) {
    throw refused(
      "bad_request",
      `${upstreamUrl} must be https://host:port without credentials or a path.`,
    );
  }

  const username = await readCredential(environment, upstreamUsername);
  const password = await readCredential(environment, upstreamPassword);
  if (!browserEgressCredentialAccepted(username, "username")) {
    throw refused("bad_request", `${upstreamUsername} cannot contain a colon.`);
  }
  const caFile = environment[upstreamCaFile];
  const extraCa = caFile === undefined ? [] : await readExtraCa(caFile);
  let secureContext: SecureContext;
  try {
    secureContext = createSecureContext({
      ca: [
        ...new Set([...getCACertificates("default"), ...getCACertificates("system")]),
        ...extraCa,
      ],
    });
  } catch {
    throw refused("bad_request", "Could not configure browser egress upstream TLS trust.");
  }
  return {
    hostname: url.hostname,
    port: url.port,
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
    secureContext,
  };
}

async function readExtraCa(path: string): Promise<string[]> {
  const contents = (await readFile(path, upstreamCaFile, 1024 * 1024)).toString("utf8");
  const pem = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu;
  const certificates = contents.match(pem);
  try {
    if (!certificates || contents.replace(pem, "").trim()) throw new Error();
    return certificates.map((certificate) => new X509Certificate(certificate).toString());
  } catch {
    throw refused("bad_request", `${upstreamCaFile} must contain PEM certificates.`);
  }
}

async function readCredential(environment: NodeJS.ProcessEnv, name: string): Promise<string> {
  const fileName = `${name}_FILE`;
  const file = environment[fileName];
  let value = environment[name];
  if (file) {
    if (value !== undefined) {
      throw refused("bad_request", `Configure exactly one of ${name} or ${fileName}.`);
    }
    value = (await readFile(file, fileName, 16 * 1024)).toString("utf8").replace(/[\r\n]+$/u, "");
  }
  if (!value || !browserEgressCredentialAccepted(value, "password")) {
    throw refused("bad_request", `${upstreamUrl} requires ${name} or ${fileName}.`);
  }
  return value;
}

async function readFile(path: string, name: string, maximumBytes: number): Promise<Buffer> {
  const invalid = () => refused("bad_request", `Could not read the file configured by ${name}.`);
  try {
    const contents = await readBoundedRegularFile(path, maximumBytes, {
      changedError: invalid,
      invalidFileError: invalid,
      minimumBytes: 1,
      sizeError: invalid,
    });
    if (contents) return contents;
  } catch {
    throw invalid();
  }
  throw invalid();
}
