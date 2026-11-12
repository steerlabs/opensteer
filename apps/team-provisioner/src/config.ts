import { z } from "zod";
import type { TeamImages } from "./template.js";

const PinnedImageSchema = z
  .string()
  .regex(/^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/u, "Expected an image pinned by digest");

const EnvironmentSchema = z.object({
  OPENSTEER_ACCOUNT_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }, "Expected an HTTPS origin"),
  OPENSTEER_TEAM_HOST_IMAGE: PinnedImageSchema,
  OPENSTEER_TEAM_GATEWAY_IMAGE: PinnedImageSchema,
  OPENSTEER_TEAM_POSTGRES_IMAGE: PinnedImageSchema,
  KUBERNETES_SERVICE_HOST: z.string().min(1),
  KUBERNETES_SERVICE_PORT: z.string().regex(/^\d{1,5}$/u),
});

export interface ProvisionerConfig {
  readonly accountOrigin: URL;
  readonly images: TeamImages;
  readonly kubernetes: { readonly host: string; readonly port: string };
}

export function loadProvisionerConfig(environment: NodeJS.ProcessEnv): ProvisionerConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    accountOrigin: new URL(parsed.OPENSTEER_ACCOUNT_URL),
    images: {
      host: parsed.OPENSTEER_TEAM_HOST_IMAGE,
      gateway: parsed.OPENSTEER_TEAM_GATEWAY_IMAGE,
      postgres: parsed.OPENSTEER_TEAM_POSTGRES_IMAGE,
    },
    kubernetes: {
      host: parsed.KUBERNETES_SERVICE_HOST,
      port: parsed.KUBERNETES_SERVICE_PORT,
    },
  };
}
