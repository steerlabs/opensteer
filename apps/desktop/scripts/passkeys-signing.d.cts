export interface PasskeySigningIdentity {
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
