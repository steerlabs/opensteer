import {
  EnvironmentIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type UserId,
  type ThreadId,
} from "@opensteer/core";
import type { TriggerStore } from "@opensteer/database";

import type { TriggerControlInput } from "@opensteer/triggers";
import { z } from "zod";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";
import { runCapabilityLifetimeSeconds } from "../agents/run-capability.js";

const TriggerCapabilityScopeSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  executionGeneration: z.number().int().positive(),
  occurrenceId: TriggerOccurrenceIdSchema,
  requestedBy: UserIdSchema,
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  threadId: ThreadIdSchema,
  toolContractVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  workspaceId: WorkspaceIdSchema,
});
type TriggerCapabilityScope = z.infer<typeof TriggerCapabilityScopeSchema>;
export type TriggerCapabilityClaims<Audience extends string> = TriggerCapabilityScope & {
  readonly aud: Audience;
  readonly exp: number;
  readonly iat: number;
  readonly iss: "opensteer-host";
  readonly jti: string;
};
export type TriggerControlScope = TriggerCapabilityClaims<"opensteer-trigger-control">;

export class TriggerCapabilityTokenService<Audience extends string> {
  readonly #audience: Audience;
  readonly #schema: z.ZodType<TriggerCapabilityClaims<Audience>>;
  readonly #store: Pick<TriggerStore, "assertActiveExecutionBinding">;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly audience: Audience;
    readonly store: Pick<TriggerStore, "assertActiveExecutionBinding">;
    readonly tokens: SignedTokenService;
  }) {
    this.#audience = options.audience;
    this.#schema = SignedTokenClaimsSchema.extend({
      ...TriggerCapabilityScopeSchema.shape,
      aud: z.literal(options.audience),
    }) as z.ZodType<TriggerCapabilityClaims<Audience>>;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  issue(input: TriggerCapabilityScope): string {
    return this.#tokens.issue({ ...input, aud: this.#audience }, runCapabilityLifetimeSeconds);
  }

  async authenticate(token: string): Promise<TriggerCapabilityClaims<Audience>> {
    const claims = this.#tokens.verify(token, this.#schema);
    await this.#store.assertActiveExecutionBinding(claims);
    return claims;
  }
}

export class TriggerControlTokenService extends TriggerCapabilityTokenService<"opensteer-trigger-control"> {
  constructor(options: {
    readonly store: Pick<TriggerStore, "assertActiveExecutionBinding">;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-trigger-control" });
  }
}

export interface TriggerManager {
  manage(
    ownerId: UserId,
    input: TriggerControlInput,
    actorThreadId: ThreadId | null,
  ): Promise<unknown>;
}
