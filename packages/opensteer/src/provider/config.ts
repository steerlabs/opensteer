import type { CloudBrowserProfilePreference } from "@opensteer/protocol";

export const OPENSTEER_PROVIDER_MODES = ["local", "cloud"] as const;

export type OpensteerProviderMode = (typeof OPENSTEER_PROVIDER_MODES)[number];
export type OpensteerProviderSource = "explicit" | "env" | "default";

export interface OpensteerLocalProviderOptions {
  readonly mode: "local";
}

export interface OpensteerCloudProviderOptions {
  readonly mode: "cloud";
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
  readonly mode: OpensteerProviderMode;
  readonly source: OpensteerProviderSource;
}

export function assertProviderSupportsEngine(
  provider: OpensteerProviderMode,
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

export function normalizeOpensteerProviderMode(
  value: string,
  source = "OPENSTEER_PROVIDER",
): OpensteerProviderMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === OPENSTEER_PROVIDER_MODES[0] || normalized === OPENSTEER_PROVIDER_MODES[1]) {
    return normalized;
  }

  throw new Error(
    `${source} must be one of ${OPENSTEER_PROVIDER_MODES.join(", ")}; received "${value}".`,
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
      mode: input.provider.mode,
      source: "explicit",
    };
  }

  if (input.environmentProvider !== undefined && input.environmentProvider.trim().length > 0) {
    return {
      mode: normalizeOpensteerProviderMode(input.environmentProvider),
      source: "env",
    };
  }

  return {
    mode: "local",
    source: "default",
  };
}
