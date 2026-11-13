import {
  isLoopbackHostname,
  decodeBase64Url,
  browserSourceInvitationPrefix,
  decodeBrowserSourceInvitation,
  verifyBrowserSourcePairChallenge,
  type BrowserSourceInvitation,
  type BrowserSourceInvitationDestination,
  type HostDiscoveryEnvelope,
} from "@opensteer/browser-source-wire/frozen";
import {
  BrowserSourcePairChallengeResultSchema,
  BrowserSourcePairInputSchema,
  BrowserSourcePairResultSchema,
  browserSourceWireCurrent,
} from "@opensteer/browser-source-wire/frames";
import { readHostJson } from "./json.js";
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

const hostJson = { maximumBytes: 16_384 } as const;

export function websocketUrl(origin: string): string {
  const url = new URL("/internal/v1/browser-sources/connect", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wire", String(browserSourceWireCurrent));
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
      await readHostJson(response, hostJson),
    );
    return verifyBrowserSourcePairChallenge({ ...challenge, authority, signature });
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "TimeoutError")
    )
      throw error;
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
    try {
      if (await proveDestination(destination, invitation.authority, timeoutMs)) return destination;
    } catch {
      continue;
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
  version?: number;
}): Promise<z.infer<typeof BrowserSourcePairResultSchema>> {
  const { destination } = input;
  const body = BrowserSourcePairInputSchema.parse({
    code: input.code,
    name: input.name,
    origin: destination.origin,
    replaces: input.replaces,
    routeGeneration: destination.route?.document.route.generation ?? null,
    version: input.version ?? browserSourceWireCurrent,
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
      await readHostJson(response, hostJson).catch(() => null),
    );
    if (
      error.success &&
      error.data.error.reason === "unsupported-version" &&
      input.version === undefined
    ) {
      return await requestPairing({ ...input, version: 4 });
    }
    throw new ConnectProblem(
      error.success && error.data.error.reason === "unsupported-version" ? "update" : "rejected",
      destination.origin,
      input.deploymentName,
    );
  }
  return BrowserSourcePairResultSchema.parse(await readHostJson(response, hostJson));
}
