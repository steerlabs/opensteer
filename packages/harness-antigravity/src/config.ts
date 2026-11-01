import type { HarnessSourceDescriptor } from "@opensteer/harness";
import { z } from "zod";

const cloudField = z.string().trim().max(256).default("");

export const AntigravityHarnessConfigSchema = z.strictObject({
  gcpLocation: cloudField,
  gcpProject: cloudField,
});

export type AntigravityHarnessConfig = z.infer<typeof AntigravityHarnessConfigSchema>;

export const antigravitySourceIds = {
  agentPlatform: "google-agent-platform",
  enterprise: "google-gemini-enterprise",
  geminiApiKey: "google-gemini-api-key",
  personal: "google",
} as const;

export type AntigravitySourceId = (typeof antigravitySourceIds)[keyof typeof antigravitySourceIds];

export type AntigravityAuthMethod =
  "agent-platform" | "gemini-api-key" | "oauth-business" | "oauth-personal";

interface AntigravitySourceRow extends HarnessSourceDescriptor {
  readonly authMethod: AntigravityAuthMethod;
  readonly authKind: "api-key" | "cloud-identity" | "subscription";
}

const isolated = ["isolated"] as const;
const projectField = {
  id: "gcpProject",
  kind: "text",
  label: "Google Cloud project",
  placeholder: "my-project",
} as const;
const locationField = {
  id: "gcpLocation",
  kind: "text",
  label: "Google Cloud location",
  placeholder: "us-central1",
} as const;

export const antigravitySourceTable: readonly AntigravitySourceRow[] = [
  {
    authKind: "subscription",
    authMethod: "oauth-personal",
    detail: "A personal Google account signed in through Google's browser flow.",
    fields: [],
    kind: "first-party",
    label: "Google account",
    quota: "windows",
    sourceId: antigravitySourceIds.personal,
    stateKinds: isolated,
  },
  {
    authKind: "subscription",
    authMethod: "oauth-business",
    detail: "Gemini Enterprise browser sign-in for a Google Cloud project and location.",
    fields: [
      { ...projectField, required: true },
      { ...locationField, required: true },
    ],
    kind: "cloud-identity",
    label: "Gemini Enterprise",
    quota: "windows",
    sourceId: antigravitySourceIds.enterprise,
    stateKinds: isolated,
  },
  {
    authKind: "api-key",
    authMethod: "gemini-api-key",
    detail: "A Gemini API key stored only on this computer.",
    fields: [],
    kind: "first-party",
    label: "Gemini API key",
    quota: "none",
    sourceId: antigravitySourceIds.geminiApiKey,
    stateKinds: isolated,
  },
  {
    authKind: "cloud-identity",
    authMethod: "agent-platform",
    detail:
      "Agent Platform or Vertex AI using a saved API key, or this computer's Application Default Credentials.",
    fields: [projectField, locationField],
    kind: "cloud-identity",
    label: "Agent Platform / Vertex AI",
    quota: "none",
    sourceId: antigravitySourceIds.agentPlatform,
    stateKinds: isolated,
  },
];

export const antigravitySources: readonly HarnessSourceDescriptor[] = antigravitySourceTable;

export function antigravitySource(sourceId: string): AntigravitySourceRow {
  const source = antigravitySourceTable.find((candidate) => candidate.sourceId === sourceId);
  if (!source) throw new Error(`Unknown Antigravity source ${sourceId}`);
  return source;
}
