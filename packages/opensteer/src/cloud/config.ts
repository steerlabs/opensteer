import { resolveOpensteerExecutionMode } from "../mode/config.js";

export interface OpensteerCloudConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export function resolveCloudConfig(input: {
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly mode?: "local" | "connect" | "cloud";
} = {}): OpensteerCloudConfig | undefined {
  const mode = resolveOpensteerExecutionMode({
    ...(input.mode === undefined ? {} : { explicit: input.mode }),
    ...(input.enabled === undefined ? {} : { cloud: input.enabled }),
    ...(process.env.OPENSTEER_MODE === undefined ? {} : { environment: process.env.OPENSTEER_MODE }),
  });
  if (mode !== "cloud") {
    return undefined;
  }

  const apiKey = input.apiKey ?? process.env.OPENSTEER_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("Cloud mode requires OPENSTEER_API_KEY or cloud.apiKey.");
  }

  return {
    apiKey: apiKey.trim(),
    baseUrl: (input.baseUrl ?? process.env.OPENSTEER_BASE_URL ?? "https://api.opensteer.dev")
      .trim()
      .replace(/\/+$/, ""),
  };
}
