import type { SpecialistRegistration } from "@opensteer/core";
import type { BrowserService } from "../browser/browser-service.js";
import type {
  IntegrationToolHandlers,
  IntegrationToolsRunScope,
} from "../mcp/handlers/integrations.js";

export async function requestSpecialistRequirements(input: {
  registration: SpecialistRegistration;
  scope: IntegrationToolsRunScope;
  browser: Pick<BrowserService, "requestAccess">;
  integrations: Pick<IntegrationToolHandlers, "requestSpecialistAccess">;
}) {
  const { registration, scope, browser, integrations } = input;
  for (const [index, requirement] of registration.access.entries()) {
    if (requirement.state !== "needs-access") continue;
    const callId = `specialist:${registration.id}:${registration.pluginVersionId}:${index}`;
    if (requirement.type === "browser-profile") {
      await browser.requestAccess({
        callId,
        originatingWorkspaceId: scope.workspaceId,
        ownerId: scope.requestedBy,
        reason: requirement.reason,
        runId: scope.runId,
        suggestion: { kind: "user_choice" },
        threadId: scope.threadId,
        workspaceId: scope.workspaceId,
      });
    } else await integrations.requestSpecialistAccess(scope, requirement, callId);
  }
}
