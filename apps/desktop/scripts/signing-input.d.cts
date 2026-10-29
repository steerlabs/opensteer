export interface SigningInput {
  readonly teamId: string;
  readonly identity: string;
  readonly keychain?: string;
  readonly notarizationProfile?: string;
}
export type SigningMode =
  { readonly mode: "development" } | { readonly mode: "signed"; readonly signing: SigningInput };
export interface SigningOptions {
  readonly platform?: string;
  readonly signing?: unknown;
  readonly distributable?: boolean;
}
export function parseSigningInput(input: unknown): SigningInput;
export function resolveSigningMode(options?: SigningOptions): SigningMode;
export function readSigningMode(
  environment?: Readonly<Record<string, string | undefined>>,
): SigningMode;
export function developerIdRequirement(teamId: string, identifier: string): string;
export function generatedSigningConstants(options: SigningOptions): {
  typescript: string;
  build: SigningInput | { mode: "development" | "unavailable" };
};
export function writeSigningConstants(
  directory: string,
  options: SigningOptions,
): ReturnType<typeof generatedSigningConstants>;

export function writePlatformSigningConstants(
  directory: string,
  environment?: Readonly<Record<string, string | undefined>>,
  platform?: string,
): ReturnType<typeof generatedSigningConstants>;

export function signingKeychainArguments(
  environment?: Readonly<Record<string, string | undefined>>,
): string[];

export function personalRuntimeSigningIdentity(
  environment?: Readonly<Record<string, string | undefined>>,
): string;

export function personalRuntimeSigningOptions(identity: string): string[];
