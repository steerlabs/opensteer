import { RuntimeModeSchema, type RuntimeMode } from "@opensteer/core";
import { validateRunnerTransport } from "@opensteer/runner-client";
import { readProcessSecrets } from "@opensteer/shared/processSecrets";
import { z } from "zod";

const EnvironmentSchema = z.object({
  OPENSTEER_MESSAGING_BIND_ADDRESS: z.string().trim().min(1).default("127.0.0.1"),
  OPENSTEER_MESSAGING_DATA_DIR: z.string().trim().min(1).default(".opensteer/channel-runtime"),
  OPENSTEER_MESSAGING_HOST_URL: z.url(),
  OPENSTEER_MESSAGING_NAME: z.string().trim().min(1).max(160).default("Messaging service"),
  OPENSTEER_MESSAGING_PORT: z.coerce.number().int().min(1).max(65_535).default(4320),
  OPENSTEER_RUNNER_CONTROL_CA_PATH: z.string().trim().min(1).optional(),
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: z
    .string()
    .min(32)
    .max(4_096)
    .refine((value) => !value.startsWith("replace-with-"), {
      message: "Runner enrollment token is a one-use deployment credential",
    })
    .optional(),
  OPENSTEER_MODE: RuntimeModeSchema.default("development"),
});

export interface ChannelRuntimeConfig {
  readonly bindAddress: string;
  readonly controlCaPath: string | undefined;
  readonly dataDirectory: string;
  readonly enrollmentToken: string | undefined;
  readonly hostUrl: URL;
  readonly mode: RuntimeMode;
  readonly name: string;
  readonly port: number;
}

/** The one credential a messaging service takes off its environment. */
const SecretsSchema = z.strictObject({
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: z.string().optional(),
});

/**
 * The messaging service's configuration. Its enrollment token may arrive in
 * the environment or, from the desktop, on the descriptor
 * `OPENSTEER_SECRETS_FD` names (see `@opensteer/shared/processSecrets`); it is
 * read once, and removed from `environment` either way, so nothing this
 * process spawns inherits it.
 */
export function parseChannelRuntimeConfig(environment: NodeJS.ProcessEnv): ChannelRuntimeConfig {
  let parsed: z.infer<typeof EnvironmentSchema>;
  try {
    parsed = EnvironmentSchema.parse({
      ...environment,
      ...SecretsSchema.parse(readProcessSecrets(environment)),
    });
  } finally {
    delete environment.OPENSTEER_RUNNER_ENROLLMENT_TOKEN;
  }
  const hostUrl = new URL(parsed.OPENSTEER_MESSAGING_HOST_URL);
  validateRunnerTransport({
    ...(parsed.OPENSTEER_RUNNER_CONTROL_CA_PATH
      ? { controlCaPath: parsed.OPENSTEER_RUNNER_CONTROL_CA_PATH }
      : {}),
    hostOrigin: hostUrl,
    mode: parsed.OPENSTEER_MODE,
  });
  return {
    bindAddress: parsed.OPENSTEER_MESSAGING_BIND_ADDRESS,
    controlCaPath: parsed.OPENSTEER_RUNNER_CONTROL_CA_PATH,
    dataDirectory: parsed.OPENSTEER_MESSAGING_DATA_DIR,
    enrollmentToken: parsed.OPENSTEER_RUNNER_ENROLLMENT_TOKEN,
    hostUrl,
    mode: parsed.OPENSTEER_MODE,
    name: parsed.OPENSTEER_MESSAGING_NAME,
    port: parsed.OPENSTEER_MESSAGING_PORT,
  };
}
