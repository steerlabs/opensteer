import { HostEgressGateway } from "@opensteer/access/host";
import {
  EnvironmentIdSchema,
  GrantIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import type { RunEgressPlan } from "@opensteer/protocol";
import { z } from "zod";
import { SignedTokenClaimsSchema, SignedTokenService } from "../identity/host-keys.js";
import {
  runCapabilityLifetimeSeconds,
  type RunCapabilityBindingAuthorizer,
} from "../agents/run-capability.js";

const EgressClaimsSchema = SignedTokenClaimsSchema.extend({
  aud: z.literal("opensteer-egress"),
  bindingGeneration: z.number().int().positive(),
  environmentId: EnvironmentIdSchema,
  grantId: GrantIdSchema.optional(),
  membershipGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestedBy: UserIdSchema,
  runId: RunIdSchema,
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  threadId: ThreadIdSchema,
  workspaceId: WorkspaceIdSchema,
});
type EgressClaims = z.infer<typeof EgressClaimsSchema>;

export class EgressService {
  readonly #authorizer: RunCapabilityBindingAuthorizer;
  readonly #gateway: HostEgressGateway;
  readonly #publicUrl: URL;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly authorizer: RunCapabilityBindingAuthorizer;
    readonly publicUrl: URL;
    readonly tokens: SignedTokenService;
  }) {
    this.#authorizer = options.authorizer;
    this.#gateway = new HostEgressGateway({
      maxRequestBytes: 8 * 1_024 * 1_024,
      maxResponseBytes: 16 * 1_024 * 1_024,
    });
    this.#publicUrl = options.publicUrl;
    this.#tokens = options.tokens;
  }

  issue(claims: Omit<EgressClaims, "aud" | "exp" | "iat" | "iss" | "jti">): RunEgressPlan {
    return {
      maxRequestBytes: 8 * 1_024 * 1_024,
      maxResponseBytes: 16 * 1_024 * 1_024,
      relayToken: this.#tokens.issue(
        { ...claims, aud: "opensteer-egress" },
        runCapabilityLifetimeSeconds,
      ),
      relayUrl: new URL("/internal/v1/egress", this.#publicUrl).toString(),
    };
  }

  async forward(token: string, request: unknown) {
    const claims = this.#tokens.verify(token, EgressClaimsSchema);
    await this.#authorizer.assertActiveGrant(claims);
    return this.#gateway.forward(request);
  }
}
