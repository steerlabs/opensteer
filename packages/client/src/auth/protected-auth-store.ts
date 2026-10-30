import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IdentityEmailSchema,
  IsoDateTimeSchema,
  type DeploymentId,
} from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";

const AuthTokenSchema = z.string().min(16).max(65_536).refine(noAsciiControl);
const ScopeSchema = z.string().regex(/^[A-Za-z0-9:._/-]{1,100}$/u);

export const OAuthCredentialSchema = z.strictObject({
  viewLoginId: z.uuid().optional(),
  accessToken: AuthTokenSchema,
  accessTokenExpiresAt: IsoDateTimeSchema,
  grantedScopes: z.array(ScopeSchema).max(32),
  refreshToken: AuthTokenSchema,
  updatedAt: IsoDateTimeSchema,
});

export const AccountCredentialSchema = OAuthCredentialSchema.extend({
  email: IdentityEmailSchema.optional(),
  issuerOrigin: CanonicalOriginSchema,
  subject: ControlPlaneAccountIdSchema,
});
export type AccountCredential = z.infer<typeof AccountCredentialSchema>;

export const HostCredentialSchema = OAuthCredentialSchema.extend({
  canonicalOrigin: CanonicalOriginSchema,
  deploymentId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  hostKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u),
});
export type HostCredential = z.infer<typeof HostCredentialSchema>;

export const ProtectedAuthStateSchema = z
  .strictObject({
    account: AccountCredentialSchema.nullable(),
    hosts: z.array(HostCredentialSchema).max(100),
    schemaVersion: z.literal(2),
  })
  .superRefine(refineProtectedAuthState);
export type ProtectedAuthState = z.infer<typeof ProtectedAuthStateSchema>;

/**
 * Where a client keeps its OAuth credentials: one Account record keyed by
 * issuer and subject, and one record per verified Host identity. The platform
 * owns the secrecy of the medium — Electron's `safeStorage` file on a desktop,
 * the Keychain or Keystore on a phone — and this package owns what a record
 * means, when it is replaced, and when it is dropped.
 *
 * Every mutation returns the whole state so a caller never has to read back
 * what it just wrote, and `assertAvailable` is what distinguishes protected
 * storage that is unusable from an identity that is merely signed out.
 */
export interface ProtectedAuthStore {
  assertAvailable(): Promise<void>;
  clearAccount(): Promise<ProtectedAuthState>;
  clearHost(deploymentId: DeploymentId | string): Promise<ProtectedAuthState>;
  clearHosts(deploymentIds: readonly (DeploymentId | string)[]): Promise<ProtectedAuthState>;
  load(): Promise<ProtectedAuthState>;
  setAccount(credential: AccountCredential): Promise<ProtectedAuthState>;
  setHost(credential: HostCredential): Promise<ProtectedAuthState>;
}

export function emptyProtectedAuthState(): ProtectedAuthState {
  return { account: null, hosts: [], schemaVersion: 2 };
}

function noAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function refineProtectedAuthState(
  value: { readonly hosts: readonly HostCredential[] },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, credential] of value.hosts.entries()) {
    if (ids.has(credential.deploymentId)) {
      context.addIssue({
        code: "custom",
        message: "A Deployment may have only one OAuth credential",
        path: ["hosts", index, "deploymentId"],
      });
    }
    ids.add(credential.deploymentId);
  }
}
