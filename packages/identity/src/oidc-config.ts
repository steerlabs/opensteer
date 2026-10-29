import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { OidcProviderConfigurationSchema, type OidcProviderConfiguration } from "./types.js";

const OperatorProviderSchema = z.strictObject({
  allowPrivateNetwork: z.boolean().default(false),
  clientId: z.string().trim().min(1).max(512),
  clientSecretPath: z.string().min(1).max(4_096),
  discoveryEndpoint: z.url().optional(),
  issuer: z.url(),
  label: z.string().trim().min(1).max(80),
  providerId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  trustedOrigins: z.array(z.url()).max(16).default([]),
});

export async function loadOidcProvidersFromFile(
  path: string | undefined,
  options: {
    readonly requireAbsolutePaths?: boolean;
    readonly requireSecureTransport?: boolean;
  } = {},
): Promise<readonly OidcProviderConfiguration[]> {
  if (!path) return [];
  if (options.requireAbsolutePaths && !isAbsolute(path)) {
    throw new Error("Production OIDC configuration path must be absolute");
  }
  const raw = await readRegularFile(path, 256 * 1_024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("OIDC configuration must contain valid JSON", { cause: error });
  }
  const providers = z.array(OperatorProviderSchema).max(16).parse(parsed);
  const seen = new Set<string>();
  return Promise.all(
    providers.map(async (provider) => {
      if (seen.has(provider.providerId)) {
        throw new Error(`Duplicate OIDC provider ID: ${provider.providerId}`);
      }
      seen.add(provider.providerId);
      const secretPath = isAbsolute(provider.clientSecretPath)
        ? provider.clientSecretPath
        : resolve(path, "..", provider.clientSecretPath);
      if (options.requireAbsolutePaths && !isAbsolute(provider.clientSecretPath)) {
        throw new Error(`Production client secret path must be absolute: ${provider.providerId}`);
      }
      const clientSecret = decodeSecret(await readRegularFile(secretPath, 64 * 1_024));
      const issuer = exactHttpUrl(provider.issuer, `OIDC issuer for ${provider.providerId}`);
      const discoveryEndpoint = provider.discoveryEndpoint
        ? exactHttpUrl(
            provider.discoveryEndpoint,
            `OIDC discovery endpoint for ${provider.providerId}`,
            true,
          ).toString()
        : undefined;
      const trustedOrigins = provider.trustedOrigins.map((value) =>
        exactOrigin(value, `trusted OIDC origin for ${provider.providerId}`),
      );
      if (options.requireSecureTransport) {
        for (const [label, value] of [
          ["issuer", issuer.toString()],
          ...(discoveryEndpoint ? ([["discovery endpoint", discoveryEndpoint]] as const) : []),
          ...trustedOrigins.map((origin) => ["trusted origin", origin] as const),
        ] as const) {
          if (new URL(value).protocol !== "https:") {
            throw new Error(`Production OIDC ${label} must use HTTPS: ${provider.providerId}`);
          }
        }
      }
      if (!provider.allowPrivateNetwork && trustedOrigins.length > 0) {
        throw new Error(`OIDC trusted origins require allowPrivateNetwork: ${provider.providerId}`);
      }
      return OidcProviderConfigurationSchema.parse({
        allowPrivateNetwork: provider.allowPrivateNetwork,
        clientId: provider.clientId,
        clientSecret,
        ...(discoveryEndpoint ? { discoveryEndpoint } : {}),
        issuer: issuer.toString().replace(/\/$/u, ""),
        label: provider.label,
        providerId: provider.providerId,
        trustedOrigins,
      });
    }),
  );
}

async function readRegularFile(path: string, maximumBytes: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error(`Identity configuration is not a bounded regular file: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | noFollowFlag() | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maximumBytes || current.ino !== before.ino) {
      throw new Error(`Identity configuration changed while opening: ${path}`);
    }
    const value = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      throw new Error(`Identity configuration exceeds its byte limit: ${path}`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

function decodeSecret(value: string): string {
  const normalized = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  if (
    normalized.length < 1 ||
    normalized.length > 64 * 1_024 ||
    normalized.trim() !== normalized ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new Error("OIDC client secret has an invalid representation");
  }
  return normalized;
}

function exactHttpUrl(value: string, label: string, allowPath = true): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPath && url.pathname !== "/")
  ) {
    throw new Error(`${label} must be an uncredentialed HTTP(S) URL`);
  }
  return url;
}

function exactOrigin(value: string, label: string): string {
  const url = exactHttpUrl(value, label, false);
  return url.origin;
}
