import type { CloudBrowserProfilePreference } from "@opensteer/protocol";
import type { OpensteerEnvironment } from "../env.js";
import {
  resolveOpensteerProvider,
  type OpensteerCloudProviderOptions,
  type OpensteerProviderOptions,
} from "../provider/config.js";

export const DEFAULT_OPENSTEER_CLOUD_BASE_URL = "https://api.opensteer.com";

export interface OpensteerCloudConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly appBaseUrl?: string;
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export function resolveCloudConfig(
  input: {
    readonly provider?: OpensteerProviderOptions;
    readonly environment?: OpensteerEnvironment;
  } = {},
): OpensteerCloudConfig | undefined {
  const provider = resolveOpensteerProvider({
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.environment?.OPENSTEER_PROVIDER === undefined
      ? {}
      : { environmentProvider: input.environment.OPENSTEER_PROVIDER }),
  });
  if (provider.mode !== "cloud") {
    return undefined;
  }

  const cloudProvider =
    input.provider?.mode === "cloud"
      ? (input.provider as OpensteerCloudProviderOptions)
      : undefined;
  const apiKey =
    normalizeOptionalCloudConfigValue(cloudProvider?.apiKey) ??
    normalizeOptionalCloudConfigValue(input.environment?.OPENSTEER_API_KEY);
  if (apiKey === undefined) {
    throw new Error("provider=cloud requires OPENSTEER_API_KEY or provider.apiKey.");
  }
  const baseUrl =
    normalizeOptionalCloudConfigValue(cloudProvider?.baseUrl) ??
    normalizeOptionalCloudConfigValue(input.environment?.OPENSTEER_BASE_URL) ??
    DEFAULT_OPENSTEER_CLOUD_BASE_URL;
  const appBaseUrl =
    normalizeOptionalCloudConfigValue(cloudProvider?.appBaseUrl) ??
    normalizeOptionalCloudConfigValue(input.environment?.OPENSTEER_CLOUD_APP_BASE_URL);

  return {
    apiKey,
    baseUrl,
    ...(appBaseUrl === undefined ? {} : { appBaseUrl }),
    ...(cloudProvider?.browserProfile === undefined
      ? {}
      : { browserProfile: cloudProvider.browserProfile }),
  };
}

export function requireCloudAppBaseUrl(
  cloudConfig: Pick<OpensteerCloudConfig, "appBaseUrl">,
): string {
  const appBaseUrl = normalizeOptionalCloudConfigValue(cloudConfig.appBaseUrl);
  if (appBaseUrl === undefined) {
    throw new Error(
      'record with provider=cloud requires OPENSTEER_CLOUD_APP_BASE_URL or "--cloud-app-base-url".',
    );
  }
  return appBaseUrl;
}

function normalizeOptionalCloudConfigValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.length === 0 ? undefined : normalized;
}
