import { renderToStaticMarkup } from "react-dom/server";
import { createId, type Request } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, DeniedRequestBody } from "./input-surface.js";

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
    ...overrides,
  };
}

describe("ActionForm", () => {
  it("renders secret fields as password inputs without placing values in markup", () => {
    const request = pendingRequest({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [
          {
            custom: false,
            id: "token",
            multiSelect: false,
            prompt: "Enter the token",
            secret: true,
          },
        ],
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
  it("says who must answer, without the actions", () => {
    const html = renderToStaticMarkup(<DeniedRequestBody denied="administrator" />);

    expect(html).toContain("A Host administrator must complete this request.");
    expect(html).not.toContain("<button");
  });
});
