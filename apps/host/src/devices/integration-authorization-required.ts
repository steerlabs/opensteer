import type { CallableIntegrationTool } from "@opensteer/database";

export class IntegrationAuthorizationRequiredError extends Error {
  readonly callable: CallableIntegrationTool;

  constructor(callable: CallableIntegrationTool) {
    // The title can come from a document an agent researched, and this message
    // is read by an agent, so it is quoted rather than spliced into prose.
    super(
      `"${callable.installation.title}" access is required. Ask for it with app_access_request if this task still needs it.`,
    );
    this.name = "IntegrationAuthorizationRequiredError";
    this.callable = callable;
  }
}
