const integrationExecutionToolNames = [
  "integration_search",
  "integration_describe",
  "integration_call",
] as const;

const integrationSetupToolNames = ["integration_request", "integration_propose"] as const;

export const integrationGatewayToolNames = [
  ...integrationExecutionToolNames,
  "computer",
  ...integrationSetupToolNames,
] as const;
