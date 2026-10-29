import { IntegrationDefinitionSchema } from "@opensteer/integration-core";

const servicePolicy = {
  "issues.read": { operations: ["query.issue", "query.issues", "query.viewer"] },
  "issues.write": {
    operations: ["mutation.issueCreate", "mutation.issueUpdate", "mutation.commentCreate"],
  },
} as const;

export const linearIntegration = IntegrationDefinitionSchema.parse({
  adapter: "graphql",
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "Linear personal API key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
      placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
    },
  ],
  config: {
    endpoint: "https://api.linear.app/graphql",
    healthCheck: {
      query: "query OpensteerLinearHealth { viewer { id name organization { id } } }",
      identityPath: "data.viewer.id",
      displayNamePath: "data.viewer.name",
      tenantPath: "data.viewer.organization.id",
    },
    operationFilter: {
      include: Object.values(servicePolicy).flatMap(({ operations }) => operations),
    },
  },
  description: "Read and update Linear issues, projects, teams, and comments.",
  id: "linear",
  name: "Linear GraphQL",
  provider: "linear",
  setupUrl: "https://linear.app/settings/api",
});
