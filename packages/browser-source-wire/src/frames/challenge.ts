import { z } from "zod";
import { BrowserSourceOriginSchema } from "../frozen/browser-source.js";
import { PersonalAccessRouteGenerationSchema } from "../frozen/personal-access-route.js";
import { BrowserSourceIdSchema } from "../frozen/primitives.js";

export const BrowserSourceDestinationSchema = z.strictObject({
  origin: BrowserSourceOriginSchema,
  routeGeneration: PersonalAccessRouteGenerationSchema.nullable(),
});
export type BrowserSourceDestination = z.infer<typeof BrowserSourceDestinationSchema>;

export const BrowserSourceChallengeSchema = BrowserSourceDestinationSchema.extend({
  sourceId: BrowserSourceIdSchema,
  nonce: z.uuid(),
});
export type BrowserSourceChallenge = z.infer<typeof BrowserSourceChallengeSchema>;

/** Domain separation keeps a source connection proof from signing another Host protocol. */
export function browserSourceChallengeBytes(input: BrowserSourceChallenge): Uint8Array {
  const challenge = BrowserSourceChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source/v2\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.sourceId}\0${challenge.nonce}`,
  );
}

/**
 * Proves the Host holds the invitation's key before the extension spends the
 * one-use code (or a replaced connection's token) on it. Loopback is tried
 * first, and any local process could answer there.
 */
export const BrowserSourcePairChallengeSchema = BrowserSourceDestinationSchema.extend({
  nonce: z.uuid(),
});
export type BrowserSourcePairChallenge = z.infer<typeof BrowserSourcePairChallengeSchema>;

export function browserSourcePairChallengeBytes(input: BrowserSourcePairChallenge): Uint8Array {
  const challenge = BrowserSourcePairChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source-pair/v1\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.nonce}`,
  );
}

/**
 * A Host that no longer serves the address a source challenged on says so
 * before its connection proof, so the extension can trust the notice only
 * with this signature over the same challenge.
 */
export function browserSourceRouteChangedBytes(input: BrowserSourceChallenge): Uint8Array {
  const challenge = BrowserSourceChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source-route-changed/v1\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.sourceId}\0${challenge.nonce}`,
  );
}
