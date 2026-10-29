import type { IdentityConfig } from "@opensteer/core";

/**
 * Where — if anywhere — this session should send someone to manage the account
 * that owns their Deployment.
 *
 * A self-hosted Host has no portal above it, so there is nothing to link to. A
 * Desktop session has one, but reaching it is the native bridge's job
 * (`openCloudPortal` opens the system browser); an in-app link there would
 * navigate the renderer away from the Host it is bound to. That leaves the
 * ordinary browser session of a portal-managed Deployment, which is exactly the
 * case where the portal is one hierarchical step up from where you are.
 */
export function cloudPortalHref(input: {
  readonly desktop: boolean;
  readonly identityConfig: Pick<IdentityConfig, "portalOrigin"> | null;
}): string | null {
  if (input.desktop) return null;
  return input.identityConfig?.portalOrigin ?? null;
}
