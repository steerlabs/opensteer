import { isLoopbackHostname } from "@opensteer/core";
import {
  HostDescriptorSchema,
  browserSourceInvitationPrefix,
  decodeBrowserSourceInvitation,
  isSameHost,
  verifyBrowserSourcePairChallenge,
  verifyHostDiscoveryEnvelope,
  type BrowserSourceInvitation,
  type BrowserSourceInvitationDestination,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  BrowserSourcePairChallengeResultSchema,
  BrowserSourcePairInputSchema,
  BrowserSourcePairResultSchema,
  browserSourceProtocolVersion,
} from "@opensteer/protocol/browser-sources";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import type { ConnectProblemCode } from "./messages.js";

/** A failure the connect page explains in its own words. */
export class ConnectProblem extends Error {
  readonly code: ConnectProblemCode;
  readonly deploymentName: string | null;
  readonly origin: string | null;

  constructor(
    code: ConnectProblemCode,
    origin: string | null = null,
    deploymentName: string | null = null,
  ) {
    super(code);
    this.code = code;
    this.deploymentName = deploymentName;
    this.origin = origin;
  }
}

const hostJson = {
  maximumBytes: 16_384,
  expectedContentType: "application/json",
  emptyError: () => new Error("Opensteer sent an empty response."),
  invalidContentLengthError: () => new Error("Opensteer sent an unexpected response."),
  invalidJsonError: () => new Error("Opensteer sent an unexpected response."),
  sizeError: () => new Error("Opensteer sent an unexpected response."),
  unexpectedContentTypeError: () => new Error("Opensteer sent an unexpected response."),
} as const;

export async function fetchHostAuthority(
  origin: string,
  timeoutMs = 10_000,
): Promise<HostDiscoveryEnvelope> {
  const response = await fetch(new URL("/.well-known/opensteer", origin), {
    cache: "no-store",
    credentials: "omit",
    method: "GET",
    redirect: "manual",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || response.type === "opaqueredirect") {
    throw new Error("Opensteer did not identify itself.");
  }
  const descriptor = HostDescriptorSchema.parse(await readBoundedJson(response, hostJson));
  verifyHostDiscoveryEnvelope(descriptor.authority);
  return descriptor.authority;
}

export function samePinnedAuthority(
  pinned: HostDiscoveryEnvelope,
  current: HostDiscoveryEnvelope,
): boolean {
  return (
    isSameHost(pinned, current) &&
    pinned.document.canonicalOrigin === current.document.canonicalOrigin
  );
}

/** One Deployment keeps its signing key across addresses and restarts. */
export function sameDeployment(left: HostDiscoveryEnvelope, right: HostDiscoveryEnvelope): boolean {
  return left.publicKey.spki === right.publicKey.spki;
}

export function websocketUrl(origin: string): string {
  const url = new URL("/internal/v1/browser-sources/connect", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

const LooseInvitationSchema = z.object({
  expiresAt: z.string().optional(),
  version: z.unknown(),
});

/** Verifies an invitation, turning each failure into the one fix the person can make. */
export function readInvitation(text: string): BrowserSourceInvitation {
  const trimmed = text.trim();
  if (!trimmed) throw new ConnectProblem("missing");
  try {
    return decodeBrowserSourceInvitation(trimmed);
  } catch {
    // Only the explanation depends on this unverified read; nothing is trusted from it.
    let loose: z.infer<typeof LooseInvitationSchema> | null = null;
    try {
      if (trimmed.startsWith(browserSourceInvitationPrefix)) {
        loose = LooseInvitationSchema.parse(
          JSON.parse(
            new TextDecoder().decode(
              decodeBase64Url(trimmed.slice(browserSourceInvitationPrefix.length)),
            ),
          ),
        );
      }
    } catch {
      loose = null;
    }
    if (!loose) throw new ConnectProblem("invalid");
    if (loose.version !== 2) throw new ConnectProblem("update");
    if (loose.expiresAt && Date.parse(loose.expiresAt) <= Date.now()) {
      throw new ConnectProblem("expired");
    }
    throw new ConnectProblem("invalid");
  }
}

/**
 * A Host answers a fresh nonce with a signature from the invitation's key
 * before it receives the one-use code or a replaced connection's token. The
 * discovery document alone proves nothing: it is public and can be replayed
 * by anything listening on the address, loopback included.
 */
async function proveDestination(
  destination: BrowserSourceInvitationDestination,
  authority: HostDiscoveryEnvelope,
  timeoutMs: number,
): Promise<boolean> {
  const challenge = {
    nonce: crypto.randomUUID(),
    origin: destination.origin,
    routeGeneration: destination.route?.document.route.generation ?? null,
  };
  try {
    const response = await fetch(
      new URL("/internal/v1/browser-sources/pair/challenge", destination.origin),
      {
        body: JSON.stringify(challenge),
        cache: "no-store",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok || response.type === "opaqueredirect") return false;
    const { signature } = BrowserSourcePairChallengeResultSchema.parse(
      await readBoundedJson(response, hostJson),
    );
    return verifyBrowserSourcePairChallenge({ ...challenge, authority, signature });
  } catch {
    return false;
  }
}

/**
 * Chrome on the Deployment's own computer reaches it over loopback; elsewhere
 * only the remote route answers. The first address that signs a fresh
 * challenge with the invitation's key wins; call this again right before
 * pairing so the proof is current.
 */
export async function chooseDestination(
  invitation: BrowserSourceInvitation,
): Promise<BrowserSourceInvitationDestination> {
  const ordered = [...invitation.destinations].sort(
    (left, right) =>
      Number(isLoopbackHostname(new URL(right.origin).hostname)) -
      Number(isLoopbackHostname(new URL(left.origin).hostname)),
  );
  let impostor = false;
  for (const destination of ordered) {
    const timeoutMs = isLoopbackHostname(new URL(destination.origin).hostname) ? 4_000 : 10_000;
    let authority: HostDiscoveryEnvelope;
    try {
      authority = await fetchHostAuthority(destination.origin, timeoutMs);
    } catch {
      continue;
    }
    if (
      samePinnedAuthority(invitation.authority, authority) &&
      (await proveDestination(destination, invitation.authority, timeoutMs))
    ) {
      return destination;
    }
    impostor = true;
  }
  const shown = invitation.destinations.at(-1)?.origin ?? null;
  throw new ConnectProblem(impostor ? "mismatch" : "unreachable", shown, invitation.deploymentName);
}

const PairErrorSchema = z.object({ error: z.object({ reason: z.string().optional() }) });

export async function requestPairing(input: {
  code: string;
  deploymentName: string;
  destination: BrowserSourceInvitationDestination;
  name: string;
  replaces: { sourceId: string; token: string } | null;
}): Promise<z.infer<typeof BrowserSourcePairResultSchema>> {
  const { destination } = input;
  const body = BrowserSourcePairInputSchema.parse({
    code: input.code,
    name: input.name,
    origin: destination.origin,
    replaces: input.replaces,
    routeGeneration: destination.route?.document.route.generation ?? null,
    version: browserSourceProtocolVersion,
  });
  let response: Response;
  try {
    response = await fetch(new URL("/internal/v1/browser-sources/pair", destination.origin), {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ConnectProblem("unreachable", destination.origin, input.deploymentName);
  }
  if (response.type === "opaqueredirect") {
    throw new ConnectProblem("rejected", destination.origin, input.deploymentName);
  }
  if (!response.ok) {
    const error = PairErrorSchema.safeParse(
      await readBoundedJson(response, hostJson).catch(() => null),
    );
    throw new ConnectProblem(
      error.success && error.data.error.reason === "unsupported-version" ? "update" : "rejected",
      destination.origin,
      input.deploymentName,
    );
  }
  return BrowserSourcePairResultSchema.parse(await readBoundedJson(response, hostJson));
}
