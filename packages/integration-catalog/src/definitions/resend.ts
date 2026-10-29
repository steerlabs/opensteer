import { IntegrationDefinitionSchema } from "@opensteer/integration-core";

const servicePolicy = {
  "email.send": { operations: ["emails/send", "emails/send-batch"] },
  "domains.read": { operations: ["domains/list", "domains/get"] },
} as const;

export const resendIntegration = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "Resend API key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey", placeholder: "re_..." }],
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    },
  ],
  config: {
    specUrl: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
    baseUrl: "https://api.resend.com",
    operationFilter: {
      include: [
        { operationId: Object.values(servicePolicy).flatMap((mapping) => mapping.operations) },
      ],
    },
    healthCheck: { method: "get", path: "/domains" },
  },
  description: "Send transactional email and inspect sending domains through Resend.",
  id: "resend",
  name: "Resend REST",
  provider: "resend",
  setupUrl: "https://resend.com/api-keys",
});
