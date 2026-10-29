import {
  EnvironmentIdSchema,
  ThreadIdSchema,
  TriggerIdSchema,
  TriggerRevisionIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";
import { z } from "zod";
import { runCapabilityLifetimeSeconds } from "../agents/run-capability.js";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";

export const WatchCapabilityScopeSchema = z.strictObject({
  activationId: TriggerWatchActivationIdSchema,
  anchorThreadId: ThreadIdSchema,
  createdBy: UserIdSchema,
  environmentId: EnvironmentIdSchema,
  executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  membershipGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revisionId: TriggerRevisionIdSchema,
  triggerId: TriggerIdSchema,
  toolContractVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  workspaceId: WorkspaceIdSchema,
});
export type WatchCapabilityScope = z.infer<typeof WatchCapabilityScopeSchema>;

export type WatchCapabilityClaims<Audience extends string> = WatchCapabilityScope & {
  readonly aud: Audience;
  readonly exp: number;
  readonly iat: number;
  readonly iss: "opensteer-host";
  readonly jti: string;
};
export type WatchControlScope = WatchCapabilityClaims<"opensteer-watch-control">;

export class WatchCapabilityTokenService<Audience extends string> {
  readonly #audience: Audience;
  readonly #schema: z.ZodType<WatchCapabilityClaims<Audience>>;
  readonly #store: Pick<TriggerStore, "assertActiveWatchBinding">;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly audience: Audience;
    readonly store: Pick<TriggerStore, "assertActiveWatchBinding">;
    readonly tokens: SignedTokenService;
  }) {
    this.#audience = options.audience;
    this.#schema = SignedTokenClaimsSchema.extend({
      ...WatchCapabilityScopeSchema.shape,
      aud: z.literal(options.audience),
    }) as z.ZodType<WatchCapabilityClaims<Audience>>;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  issue(input: WatchCapabilityScope): { readonly expiresAt: string; readonly token: string } {
    return {
      expiresAt: new Date(Date.now() + runCapabilityLifetimeSeconds * 1_000).toISOString(),
      token: this.#tokens.issue({ ...input, aud: this.#audience }, runCapabilityLifetimeSeconds),
    };
  }

  async authenticate(token: string): Promise<WatchCapabilityClaims<Audience>> {
    const claims = this.#tokens.verify(token, this.#schema);
    await this.#store.assertActiveWatchBinding(claims);
    return claims;
  }
}

export class WatchControlTokenService extends WatchCapabilityTokenService<"opensteer-watch-control"> {
  constructor(options: {
    readonly store: Pick<TriggerStore, "assertActiveWatchBinding">;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-watch-control" });
  }
}
