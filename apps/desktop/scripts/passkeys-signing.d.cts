export interface PasskeySigningIdentity {
  readonly channel: "stable" | "beta";
  readonly bundleId: string;
  readonly teamId: string;
}
export function preparePasskeySigning(
  desktop: string,
  env: NodeJS.ProcessEnv,
  identity: PasskeySigningIdentity,
): string[];

export function releasePasskeyInputs(
  env: NodeJS.ProcessEnv,
): { profile: string; entitlements: string } | undefined;
