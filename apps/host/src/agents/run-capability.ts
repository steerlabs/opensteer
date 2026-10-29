import {
  AgentCapabilityProfileIdSchema,
  EnvironmentIdSchema,
  GrantIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type WorkspaceId,
} from "@opensteer/core";
import { z } from "zod";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";

// PortableFS's default automatic mount enrollment is 24 hours. Run transport
// capabilities cover the same maximum unattended window, while every use is
// still authorized against the renewable live execution binding in PostgreSQL.
export const runCapabilityLifetimeSeconds = 24 * 60 * 60;

const RunCapabilityScopeSchema = z.strictObject({
  bindingGeneration: z.number().int().positive(),
  capabilityProfileId: AgentCapabilityProfileIdSchema,
  environmentId: EnvironmentIdSchema,
  // Tokens issued before grants existed name none; their Run's grant is found
  // by binding generation, so a Run that survived the upgrade keeps its tools.
  grantId: GrantIdSchema.optional(),
  membershipGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestedBy: UserIdSchema,
  runId: RunIdSchema,
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  threadId: ThreadIdSchema,
  workspaceId: WorkspaceIdSchema,
});
export type RunCapabilityScope = z.infer<typeof RunCapabilityScopeSchema>;

export interface RunCapabilityBindingAuthorizer {
  assertActiveGrant(input: {
    readonly bindingGeneration: number;
    readonly environmentId: EnvironmentId;
    readonly grantId?: GrantId | undefined;
    readonly membershipGeneration: number;
    readonly requestedBy: RunCapabilityScope["requestedBy"];
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }): Promise<void>;
}

export type RunCapabilityClaims<Audience extends string> = RunCapabilityScope & {
  readonly aud: Audience;
  readonly exp: number;
  readonly iat: number;
  readonly iss: "opensteer-host";
  readonly jti: string;
};

/** A narrowly-audienced bearer capability tied to one live Run binding and its grant. */
export class RunCapabilityTokenService<Audience extends string> {
  readonly #audience: Audience;
  readonly #authorizer: RunCapabilityBindingAuthorizer;
  readonly #lifetimeSeconds: number;
  readonly #schema: z.ZodType<RunCapabilityClaims<Audience>>;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly audience: Audience;
    readonly authorizer: RunCapabilityBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    this.#audience = options.audience;
    this.#authorizer = options.authorizer;
    this.#lifetimeSeconds = options.lifetimeSeconds ?? runCapabilityLifetimeSeconds;
    this.#schema = SignedTokenClaimsSchema.extend({
      ...RunCapabilityScopeSchema.shape,
      aud: z.literal(options.audience),
    }) as z.ZodType<RunCapabilityClaims<Audience>>;
    this.#tokens = options.tokens;
  }

  issue(input: RunCapabilityScope): string {
    return this.#tokens.issue({ ...input, aud: this.#audience }, this.#lifetimeSeconds);
  }

  /** How long an issued token lives; the Runner asks for fresh ones at half of it. */
  get lifetimeSeconds(): number {
    return this.#lifetimeSeconds;
  }

  async authenticate(token: string): Promise<RunCapabilityClaims<Audience>> {
    const claims = this.#tokens.verify(token, this.#schema);
    await this.#authorizer.assertActiveGrant(claims);
    return claims;
  }

  /**
   * For a connection authenticated once and kept open: its grant must still
   * stand, but the token that opened it may expire meanwhile. A shell or
   * browser connection lives as long as its Run's authority, not its token.
   */
  async reauthorize(claims: RunCapabilityClaims<Audience>): Promise<RunCapabilityClaims<Audience>> {
    await this.#authorizer.assertActiveGrant(claims);
    return claims;
  }
}
