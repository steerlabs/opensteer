import { resolveOpensteerExecutionMode } from "../mode/config.js";

export interface OpensteerConnectConfig {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function resolveConnectConfig(input: {
  readonly enabled?: boolean;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly mode?: "local" | "connect" | "cloud";
} = {}): OpensteerConnectConfig | undefined {
  const mode = resolveOpensteerExecutionMode({
    ...(input.mode === undefined ? {} : { explicit: input.mode }),
    ...(input.enabled === undefined ? {} : { connect: input.enabled }),
    ...(process.env.OPENSTEER_MODE === undefined ? {} : { environment: process.env.OPENSTEER_MODE }),
  });
  if (mode !== "connect") {
    return undefined;
  }

  const url = input.url ?? process.env.OPENSTEER_CONNECT_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "Connect mode requires a URL. Set OPENSTEER_CONNECT_URL or pass connect.url.",
    );
  }

  return {
    url: url.trim(),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  };
}
