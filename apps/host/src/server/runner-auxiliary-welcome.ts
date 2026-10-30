import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import { RunnerAuxiliaryWelcomeSchema, type RunnerAuxiliaryWelcome } from "@opensteer/protocol";

/** Optional fields are selected from the authenticated descriptor before the strict welcome is sent. */
export function runnerAuxiliaryWelcome(
  stream: Pick<RunnerAuxiliaryStream, "fence" | "identity" | "streamLeaseExpiresAt">,
  fields: Readonly<Record<string, unknown>> = {},
): RunnerAuxiliaryWelcome {
  const module = stream.fence.module;
  return RunnerAuxiliaryWelcomeSchema.parse({
    ...stream.fence,
    ...fields,
    ...(module === "integrations" && stream.identity.modules.integrations?.loginText === 1
      ? { loginText: 1 }
      : {}),
    ...(module === "integrations" && stream.identity.modules.integrations?.passwordSignIn === 1
      ? { passwordSignIn: 1 }
      : {}),
    ...(module === "browser" &&
    stream.identity.modules.browser?.passkeys === 1 &&
    process.env.OPENSTEER_PASSKEYS === "1"
      ? { passkeys: 1 }
      : {}),
    heartbeatIntervalMs: 15_000,
    serverTime: new Date().toISOString(),
    streamLeaseExpiresAt: stream.streamLeaseExpiresAt,
    type: "host.auxiliary.welcome",
  });
}
