import { readFileSync } from "node:fs";
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
  OPENSTEER_TEAM_REPLICAS: z.coerce.number().int().min(1).default(1),
  OPENSTEER_TEAM_DATABASE_IP: z.ipv4(),
  OPENSTEER_TEAM_DATABASE_HOST: z.hostname(),
  OPENSTEER_TEAM_DATABASE_CA_FILE: z.string().min(1),
  /** The provisioner's IAM database user; it logs in with its own Google access token. */
  OPENSTEER_PROVISIONER_DATABASE_USER: z.string().min(1),
  OPENSTEER_TEAM_GCS_BUCKET: z.string().min(1),
  OPENSTEER_GOOGLE_PROJECT: z.string().min(1),
  OPENSTEER_GOOGLE_PROJECT_NUMBER: z.string().regex(/^\d+$/u),
  KUBERNETES_SERVICE_HOST: z.string().min(1),
  KUBERNETES_SERVICE_PORT: z.string().regex(/^\d{1,5}$/u),
});

export interface ProvisionerConfig {
  readonly accountOrigin: URL;
  readonly replicas: number;
  readonly images: TeamImages;
  readonly platform: {
    databaseIp: string;
    databaseHost: string;
    databaseCa: string;
    bucket: string;
  };
  readonly databaseUser: string;
  readonly project: string;
  readonly projectNumber: string;
  readonly kubernetes: { readonly host: string; readonly port: string };
}

export function loadProvisionerConfig(environment: NodeJS.ProcessEnv): ProvisionerConfig {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    accountOrigin: new URL(parsed.OPENSTEER_ACCOUNT_URL),
    replicas: parsed.OPENSTEER_TEAM_REPLICAS,
    images: {
      host: parsed.OPENSTEER_TEAM_HOST_IMAGE,
    },
    platform: {
      databaseIp: parsed.OPENSTEER_TEAM_DATABASE_IP,
      databaseHost: parsed.OPENSTEER_TEAM_DATABASE_HOST,
      databaseCa: readFileSync(parsed.OPENSTEER_TEAM_DATABASE_CA_FILE, "utf8"),
      bucket: parsed.OPENSTEER_TEAM_GCS_BUCKET,
    },
    databaseUser: parsed.OPENSTEER_PROVISIONER_DATABASE_USER,
    project: parsed.OPENSTEER_GOOGLE_PROJECT,
    projectNumber: parsed.OPENSTEER_GOOGLE_PROJECT_NUMBER,
    kubernetes: {
      host: parsed.KUBERNETES_SERVICE_HOST,
      port: parsed.KUBERNETES_SERVICE_PORT,
    },
  };
}
