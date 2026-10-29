import { createHash } from "node:crypto";
import {
  EnvironmentIdSchema,
  OpensteerError,
  RunnerIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type EnvironmentId,
  type RunnerId,
  type UserId,
  type Workspace,
  type WorkspaceId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerIdentity, RunnerRegistry } from "@opensteer/orchestration";
import {
  MountGrantExchangeRequestSchema,
  MountGrantExchangeResponseSchema,
  type MountGrantExchangeResponse,
} from "@opensteer/protocol";
import { PortableFsError, type PortableFsControlPlane } from "@opensteer/workspace-portablefs";
import { z } from "zod";
import { SignedTokenClaimsSchema, SignedTokenService } from "./host-keys.js";
import type { WorkspaceActivityService } from "../workspace/workspace-activity.js";
import type { WorkspaceMountService } from "../workspace/workspace-mount-service.js";

const MountExchangeClaimsSchema = SignedTokenClaimsSchema.extend({
  aud: z.literal("opensteer-mount-exchange"),
  environmentId: EnvironmentIdSchema,
  membershipGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: UserIdSchema,
  requestedBy: UserIdSchema,
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  subject: z.string().min(1).max(512),
  volumeId: z.string().min(1).max(220),
  workspaceBackingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workspaceId: WorkspaceIdSchema,
});
export type MountExchangeClaims = z.infer<typeof MountExchangeClaimsSchema>;

type MountExchangeStore = Pick<OpensteerStore, "assertWorkspaceMountAuthority">;

interface SeenExchange {
  readonly csrHash: string;
  readonly expiresAt: number;
}

export class MountExchangeService {
  readonly #activity: Pick<WorkspaceActivityService, "note"> | undefined;
  readonly #controlPlane: PortableFsControlPlane;
  readonly #mounts: Pick<WorkspaceMountService, "recordIssued" | "revokeIssued">;
  readonly #onControlPlaneFailure:
    ((workspaceId: WorkspaceId, error: PortableFsError) => Promise<void>) | undefined;
  readonly #runners: Pick<RunnerRegistry, "identityForEnvironment">;
  readonly #seen = new Map<string, SeenExchange>();
  readonly #store: MountExchangeStore;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly activity?: Pick<WorkspaceActivityService, "note">;
    readonly controlPlane: PortableFsControlPlane;
    readonly mounts: Pick<WorkspaceMountService, "recordIssued" | "revokeIssued">;
    readonly onControlPlaneFailure?: (
      workspaceId: WorkspaceId,
      error: PortableFsError,
    ) => Promise<void>;
    readonly runners: Pick<RunnerRegistry, "identityForEnvironment">;
    readonly store: MountExchangeStore;
    readonly tokens: SignedTokenService;
  }) {
    this.#activity = options.activity;
    this.#controlPlane = options.controlPlane;
    this.#mounts = options.mounts;
    this.#onControlPlaneFailure = options.onControlPlaneFailure;
    this.#runners = options.runners;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  async issue(input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: Workspace & {
      readonly backing: Extract<Workspace["backing"], { readonly kind: "portablefs" }>;
    };
  }): Promise<string> {
    const { runnerIdentity, workspace } = input;
    this.#assertConnectedRunner(
      input.environmentId,
      runnerIdentity.runnerId,
      runnerIdentity.bootId,
    );
    const claims = {
      environmentId: input.environmentId,
      membershipGeneration: input.membershipGeneration,
      owner: workspace.createdBy,
      requestedBy: input.requestedBy,
      runnerBootId: runnerIdentity.bootId,
      runnerId: runnerIdentity.runnerId,
      subject: `opensteer:workspace:${workspace.id}:${input.environmentId}`,
      volumeId: workspace.backing.volumeId,
      workspaceBackingGeneration: workspace.backing.generation,
      workspaceId: workspace.id,
    };
    await this.#assertDurableAuthority(claims);
    return this.#tokens.issue({ ...claims, aud: "opensteer-mount-exchange" }, 15 * 60);
  }

  async exchange(token: string, input: unknown): Promise<MountGrantExchangeResponse> {
    const claims = this.#tokens.verify(token, MountExchangeClaimsSchema);
    const request = MountGrantExchangeRequestSchema.parse(input);
    await this.#assertAuthority(claims);
    this.#rememberCsr(claims, request.clientCertificateRequestPem);
    const grantInput = {
      access: "write" as const,
      authorization: {
        expiresUnix: claims.exp,
        nonce: claims.jti,
        notBeforeUnix: claims.iat,
      },
      clientCertificateRequestPem: request.clientCertificateRequestPem,
      owner: claims.owner,
      subject: claims.subject,
    };
    let grant: Awaited<ReturnType<PortableFsControlPlane["issueAutomaticMountGrant"]>>;
    try {
      grant = await this.#controlPlane.issueAutomaticMountGrant(claims.volumeId, grantInput, {
        idempotencyKey: `mount:${claims.jti}:issue`,
      });
    } catch (error) {
      if (!(error instanceof PortableFsError)) throw error;
      await this.#onControlPlaneFailure?.(claims.workspaceId, error).catch(() => undefined);
      throw new OpensteerError({
        code: error.retryable ? "workspace_unavailable" : "internal",
        message: error.retryable
          ? "Workspace storage is temporarily unavailable"
          : "Workspace storage rejected the mount request",
        retryable: error.retryable,
      });
    }
    try {
      await this.#mounts.recordIssued({
        authorizedBy: claims.requestedBy,
        enrollmentId: grant.enrollment.id,
        environmentId: claims.environmentId,
        membershipGeneration: claims.membershipGeneration,
        runnerId: claims.runnerId,
        volumeId: grant.volumeId,
        workspaceBackingGeneration: claims.workspaceBackingGeneration,
        workspaceId: claims.workspaceId,
      });
      await this.#assertAuthority(claims);
    } catch (error) {
      await this.#mounts
        .revokeIssued({
          enrollmentId: grant.enrollment.id,
          reason: "opensteer-mount-authority-fenced",
          volumeId: grant.volumeId,
        })
        .catch(() => undefined);
      throw error;
    }
    this.#activity?.note(claims.workspaceId);
    return MountGrantExchangeResponseSchema.parse({
      automaticReauthorization: {
        authorityGeneration: grant.authorityGeneration,
        enrollmentCertificatePem: grant.enrollment.certificatePem,
        enrollmentId: grant.enrollment.id,
        manager: grant.manager,
      },
      authority: {
        address: grant.authorityAddress,
        caCertificatePem: grant.authorityCaCertificatePem,
        serverName: grant.authorityServerName,
        transport: "tls-private-ca",
      },
      capability: grant.capability,
      clientCertificatePem: grant.clientCertificatePem,
      expiresAt: grant.expiresAt,
      volumeId: grant.volumeId,
    });
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, seen] of this.#seen) {
      if (seen.expiresAt <= now) {
        this.#seen.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  #rememberCsr(claims: MountExchangeClaims, pem: string): void {
    this.sweep();
    const csrHash = createHash("sha256").update(pem, "utf8").digest("base64url");
    const prior = this.#seen.get(claims.jti);
    if (prior && prior.csrHash !== csrHash) {
      throw new OpensteerError({
        code: "conflict",
        message: "Mount exchange token was already used with another key",
      });
    }
    this.#seen.set(claims.jti, { csrHash, expiresAt: claims.exp * 1_000 });
  }

  async #assertAuthority(claims: MountExchangeClaims): Promise<void> {
    this.#assertConnectedRunner(claims.environmentId, claims.runnerId, claims.runnerBootId);
    await this.#assertDurableAuthority(claims);
  }

  #assertConnectedRunner(
    environmentId: EnvironmentId,
    runnerId: RunnerId,
    runnerBootId: string,
  ): RunnerIdentity {
    const identity = this.#runners.identityForEnvironment(environmentId);
    if (!identity || identity.runnerId !== runnerId || identity.bootId !== runnerBootId) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Mount exchange Runner identity is no longer connected",
      });
    }
    return identity;
  }

  #assertDurableAuthority(
    claims: Pick<
      MountExchangeClaims,
      | "environmentId"
      | "membershipGeneration"
      | "requestedBy"
      | "runnerId"
      | "volumeId"
      | "workspaceBackingGeneration"
      | "workspaceId"
    >,
  ): Promise<void> {
    return this.#store.assertWorkspaceMountAuthority({
      environmentId: claims.environmentId,
      membershipGeneration: claims.membershipGeneration,
      requestedBy: claims.requestedBy,
      runnerId: claims.runnerId,
      volumeId: claims.volumeId,
      workspaceBackingGeneration: claims.workspaceBackingGeneration,
      workspaceId: claims.workspaceId,
    });
  }
}
