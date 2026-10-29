import { renderToStaticMarkup } from "react-dom/server";
import { createId, type Request } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, DeniedRequestBody } from "./input-surface.js";
import { IntegrationInstallReview } from "./integration-install-review.js";

const requester = createId("user");

function pendingRequest(
  overrides: Partial<Extract<Request, { status: "pending" }>> = {},
): Extract<Request, { status: "pending" }> {
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    id: createId("request"),
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: createId("workspace"),
    payload: { kind: "harness.approval" },
    presentation: {
      kind: "choice",
      options: [
        { hint: "allow-once", id: "allow", label: "Allow once" },
        { hint: "reject-once", id: "reject", label: "Reject" },
      ],
      risk: "medium",
      title: "Run a command?",
    },
    requestedBy: requester,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: createId("workspace"),
    ...overrides,
  };
}

describe("ActionForm", () => {
  it("renders secret fields as password inputs without placing values in markup", () => {
    const request = pendingRequest({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [{ id: "token", multiSelect: false, prompt: "Enter the token", secret: true }],
        kind: "form",
        title: "Secret needed",
      },
    });
    const html = renderToStaticMarkup(
      <ActionForm request={request} onRespond={vi.fn()} pending={false} />,
    );

    expect(html).toContain('type="password"');
    expect(html).toContain("Enter the token");
    expect(html).not.toContain("PRIVATE");
  });
});

describe("DeniedRequestBody", () => {
  it("shows a non-administrator what the install request would install, without the actions", () => {
    const request = pendingRequest({
      kind: "integration.install",
      mode: "durable",
      payload: {
        kind: "integration.install",
        manifest: catalogManifest(),
        reason: "Install Calendar",
      },
      presentation: {
        kind: "choice",
        options: [
          { hint: "reject-once", id: "declined", label: "Not now" },
          { hint: "confirm", id: "installed", label: "Install" },
        ],
        title: "Install Test Calendar?",
      },
      requiredActor: "administrator",
    });
    const html = renderToStaticMarkup(
      <DeniedRequestBody denied="administrator" request={request} />,
    );

    expect(html).toContain("Test Calendar");
    // A preset is described by its description, and says nothing of provenance:
    // only an agent's proposal needs that said.
    expect(html).toContain("Scheduling for the test suite.");
    expect(html).not.toContain("catalog");
    // One note: who must answer. What installing leads to is not this viewer's.
    expect(html.match(/class="action-note/gu)).toHaveLength(1);
    expect(html).toContain("A Host administrator must complete this request.");
    expect(html).not.toContain("<button");
  });
});

describe("IntegrationInstallReview", () => {
  it("refuses to describe a manifest it cannot read", () => {
    const html = renderToStaticMarkup(<IntegrationInstallReview manifest={{ kind: "catalog" }} />);

    expect(html).toContain("cannot read what this request would install");
    expect(html).toContain('role="alert"');
  });
});

function catalogManifest() {
  return {
    definition: {
      adapter: "openapi",
      authMethods: [
        {
          id: "api-key",
          inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
          kind: "api-key",
          label: "API key",
          placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
        },
      ],
      description: "Scheduling for the test suite.",
      id: "google-calendar",
      name: "Test Calendar",
      provider: "google",
    },
    digest: "c".repeat(43),
    kind: "catalog",
  };
}
