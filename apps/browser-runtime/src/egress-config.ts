import { createSecureContext, getCACertificates, type SecureContext } from "node:tls";
import { refused } from "@opensteer/core";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

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
  if (value === undefined) return undefined;
  const text = value.trim();
  const url = URL.parse(text);
  if (!/^https:\/\/(?:\[[^\]]+\]|[^:/?#@\\\s]+):[0-9]+$/iu.test(text) || !url || url.port === "0") {
    throw refused(
      "bad_request",
      `${upstreamUrl} must be https://host:port without credentials or a path.`,
    );
  }

  const username = await readCredential(environment, upstreamUsername);
  const password = await readCredential(environment, upstreamPassword);
  if (username.includes(":")) {
    throw refused("bad_request", `${upstreamUsername} cannot contain a colon.`);
  }
  const caFile = environment[upstreamCaFile];
  const extraCa = caFile ? await readFile(caFile, upstreamCaFile, 1024 * 1024) : undefined;
  let secureContext: SecureContext;
  try {
    secureContext = createSecureContext({
      ca: [
        ...new Set([...getCACertificates("default"), ...getCACertificates("system")]),
        ...(extraCa ? [extraCa] : []),
      ],
    });
  } catch {
    throw refused("bad_request", "Could not configure browser egress upstream TLS trust.");
  }
  return {
    hostname: url.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(url.port || 443),
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
    secureContext,
  };
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
  if (!value?.trim()) {
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
