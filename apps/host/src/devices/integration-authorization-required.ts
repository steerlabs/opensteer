import type { CallableIntegrationTool } from "@opensteer/database";

export class IntegrationAuthorizationRequiredError extends Error {
  readonly callable: CallableIntegrationTool;

  constructor(callable: CallableIntegrationTool) {
    // The title can come from a document an agent researched, and this message
    // is read by an agent, so it is quoted rather than spliced into prose.
    super(
      `"${callable.installation.title}" account authorization is required. Search again for current readiness and call integration_request if this task still needs access.`,
    );
    this.name = "IntegrationAuthorizationRequiredError";
    this.callable = callable;
  }
}
