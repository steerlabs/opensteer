import type { IdentityConfig } from "@opensteer/core";

export function accountPortalHref(input: {
  readonly desktop: boolean;
  readonly identityConfig: Pick<IdentityConfig, "portalOrigin"> | null;
}): string | null {
  if (input.desktop) return null;
  return input.identityConfig?.portalOrigin ?? null;
}
