import type { CloudBrowserProfilePreference } from "@opensteer/protocol";

export const OPENSTEER_PROVIDER_KINDS = ["local", "cloud"] as const;

export type OpensteerProviderKind = (typeof OPENSTEER_PROVIDER_KINDS)[number];
export type OpensteerProviderSource = "explicit" | "env" | "default";

export interface OpensteerLocalProviderOptions {
  readonly kind: "local";
}

export interface OpensteerCloudProviderOptions {
  readonly kind: "cloud";
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly browserProfile?: CloudBrowserProfilePreference;
  readonly region?: string;
  readonly sessionId?: string;
}

export type OpensteerProviderOptions =
  | OpensteerLocalProviderOptions
  | OpensteerCloudProviderOptions;

export interface OpensteerResolvedProvider {
  readonly kind: OpensteerProviderKind;
  readonly source: OpensteerProviderSource;
}

export function assertProviderSupportsEngine(
  provider: OpensteerProviderKind,
  engine: string,
): void {
  if (engine !== "abp") {
    return;
  }

  if (provider === "cloud") {
    throw new Error(
      "ABP is not supported for provider=cloud. Cloud provider currently requires Playwright.",
    );
  }
}

export function normalizeOpensteerProviderKind(
  value: string,
  source = "OPENSTEER_PROVIDER",
): OpensteerProviderKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === OPENSTEER_PROVIDER_KINDS[0] || normalized === OPENSTEER_PROVIDER_KINDS[1]) {
    return normalized;
  }

  throw new Error(
    `${source} must be one of ${OPENSTEER_PROVIDER_KINDS.join(", ")}; received "${value}".`,
  );
}

export function resolveOpensteerProvider(
  input: {
    readonly provider?: OpensteerProviderOptions;
    readonly environmentProvider?: string;
  } = {},
): OpensteerResolvedProvider {
  if (input.provider) {
    return {
      kind: input.provider.kind,
      source: "explicit",
    };
  }

  if (input.environmentProvider !== undefined && input.environmentProvider.trim().length > 0) {
    return {
      kind: normalizeOpensteerProviderKind(input.environmentProvider),
      source: "env",
    };
  }

  return {
    kind: "local",
    source: "default",
  };
}
