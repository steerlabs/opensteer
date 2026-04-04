import type { CloudBrowserProfilePreference } from "@opensteer/protocol";
import type { OpensteerEnvironment } from "../env.js";
import {
  resolveOpensteerProvider,
  type OpensteerCloudProviderOptions,
  type OpensteerProviderOptions,
} from "../provider/config.js";

export interface OpensteerCloudConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
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
  const apiKey = cloudProvider?.apiKey ?? input.environment?.OPENSTEER_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("provider=cloud requires OPENSTEER_API_KEY or provider.apiKey.");
  }
  const baseUrl = cloudProvider?.baseUrl ?? input.environment?.OPENSTEER_BASE_URL;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error("provider=cloud requires OPENSTEER_BASE_URL or provider.baseUrl.");
  }

  return {
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    ...(cloudProvider?.browserProfile === undefined
      ? {}
      : { browserProfile: cloudProvider.browserProfile }),
  };
}
