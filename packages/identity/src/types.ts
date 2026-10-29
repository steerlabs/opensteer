import type {
  AuthSessionId,
  DeploymentId,
  DeploymentPresentation,
  HostExposure,
  HostInstanceId,
  HostKeyFingerprint,
  NativeOAuthClient,
  UserId,
} from "@opensteer/core";
import { z } from "zod";

const SignupPolicySchema = z.enum(["closed", "invite-only", "open"]);
type SignupPolicy = z.infer<typeof SignupPolicySchema>;

export const OidcProviderConfigurationSchema = z.strictObject({
  allowPrivateNetwork: z.boolean().default(false),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(8_192),
  discoveryEndpoint: z.url().optional(),
  issuer: z.url(),
  label: z.string().trim().min(1).max(80),
  providerId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  trustedOrigins: z.array(z.url()).max(16).default([]),
});
export type OidcProviderConfiguration = z.infer<typeof OidcProviderConfigurationSchema>;

export interface AccountAdoptionAuthority {
  readonly canonicalOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly hostInstanceId: HostInstanceId;
  readonly hostKeyFingerprint: HostKeyFingerprint;
}

export interface AccountAdoptionAccount {
  readonly issuer: string;
  readonly subject: string;
}

export interface IssuedAccountAdoptionProof {
  readonly account: AccountAdoptionAccount;
  readonly deployment: AccountAdoptionAuthority;
  readonly expiresAt: Date;
  readonly proofCredential: string;
  readonly proofId: string;
}

export interface ConsumedAccountAdoptionProof {
  readonly account: AccountAdoptionAccount;
  readonly authorizedBy: {
    readonly sessionId: AuthSessionId;
    readonly userId: UserId;
  };
  readonly consumedAt: Date;
  readonly deployment: AccountAdoptionAuthority;
  readonly proofId: string;
}

/**
 * Claims returned only after the implementation has authenticated a grant as
 * issued by the configured Opensteer Account control plane. Parsing an
 * untrusted JSON object into this shape is not verification.
 */
export interface VerifiedAccountAdoptionGrant extends ConsumedAccountAdoptionProof {
  readonly expiresAt: Date;
  readonly grantId: string;
  readonly issuedAt: Date;
}

export interface AccountAdoptionGrantVerifier {
  verify(grant: unknown): Promise<VerifiedAccountAdoptionGrant>;
}

export interface IdentityServiceOptions {
  readonly deployment: DeploymentPresentation;
  /** Actual fingerprint of the Host key loaded by the composition root. */
  readonly hostKeyFingerprint?: HostKeyFingerprint;
  /**
   * Enables completion of an existing self-hosted Deployment attachment.
   * Omitting the verifier leaves proof issuance available but does not expose
   * or execute completion; the Host cannot trust unsigned control-plane data.
   */
  readonly accountAdoption?: {
    readonly grantVerifier: AccountAdoptionGrantVerifier;
    readonly logicalProviderId: string;
  };
  readonly emailDeliveryAvailable?: boolean;
  readonly initialOwnerEnrollment?: {
    readonly expiresAt: Date;
    /**
     * Whether restarting the Host may push the deadline forward.
     *
     * An operator-configured code keeps a fixed deadline, so a leaked value has
     * a bounded life no matter how often the Host restarts. A loopback setup
     * code is renewable instead because an expired value would leave that
     * same-machine owner path permanently unclaimable.
     */
    readonly renewable?: boolean;
    readonly token: string;
  };
  readonly localPasswordEnabled: boolean;
  /** Called after a durable Host session has ended. */
  readonly onSessionEnded?: (sessionId: AuthSessionId) => void;
  /**
   * Enables the Desktop-owned, passwordless first-owner path for a Host that is
   * reachable only over loopback. The implementation may use a private
   * machine credential internally, but password signup and password login stay
   * disabled in the public identity configuration unless
   * `localPasswordEnabled` is also true.
   */
  readonly localMachineOwner?: {
    readonly displayName: string;
    readonly email: string;
  };
  /**
   * A managed Deployment is registered by an already-authenticated Opensteer
   * Account user before its Host starts. Persist that exact upstream account
   * as the local administrator once, then let normal OIDC sign-in create only
   * Host-local sessions. The Host never accepts an Account bearer token.
   */
  readonly managedOwner?: {
    readonly accountId: string;
    readonly displayName: string;
    readonly email: string;
    readonly providerId: string;
  };
  /**
   * Enables the Host's OAuth/OIDC authorization-server surface for native
   * Opensteer clients. Browser sessions and native bearer sessions remain
   * Host-local and are never exchanged for a control-plane bearer token.
   */
  readonly nativeOAuth?: {
    readonly clients: readonly NativeOAuthClient[];
  };
  readonly oidcProviders: readonly OidcProviderConfiguration[];
  /**
   * A `loopback` Host is reachable only from its own machine, so its setup
   * admission is long-lived and reusable. A `networked` Host keeps the short
   * single-use admission an internet-facing claim requires.
   */
  readonly exposure: HostExposure;
  /**
   * Apex portal this Deployment belongs to. It is navigation metadata the
   * Deployment's own clients render as a way back, never a trust root, so a
   * Deployment without one simply publishes no portal.
   */
  readonly portalOrigin?: URL;
  readonly publicOrigin: URL;
  readonly secret: string;
  readonly signupPolicy: SignupPolicy;
}
