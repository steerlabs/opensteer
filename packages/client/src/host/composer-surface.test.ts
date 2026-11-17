import { createId, type Request } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { deriveSurface } from "./composer-surface.js";

const requester = createId("user");
const viewer = { id: requester };

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

describe("deriveSurface", () => {
  it("shows the Request a person asked to see, and ignores one no longer waiting", () => {
    const first = pendingRequest({ mode: "live" });
    const second = pendingRequest({ mode: "durable" });
    expect(deriveSurface([first, second], viewer, second.id)?.request.id).toBe(second.id);
    expect(deriveSurface([first, second], viewer, createId("request"))?.request.id).toBe(first.id);
  });

  // Typing beside a blocking approval must never answer it: the approval's own
  // buttons do that, and the words are an ordinary message.
  it("keeps the textarea an ordinary message beside a live approval", () => {
    const surface = deriveSurface([pendingRequest()], viewer);
    expect(surface?.textRole).toBe("message");
    expect(surface).not.toHaveProperty("steerOptionId");
    expect(surface?.queued).toBe(0);
  });

  it("keeps the textarea a plain message without a reject-hinted option", () => {
    const request = pendingRequest({
      presentation: {
        kind: "choice",
        options: [{ hint: "confirm", id: "ok", label: "Confirm" }],
        title: "Confirm?",
      },
    });
    const surface = deriveSurface([request], viewer);
    expect(surface?.textRole).toBe("message");
  });

  it("makes the textarea a question's answer, and hides it while a form takes a secret", () => {
    const question = (secret: boolean, kind: "harness.input" | "person.question") =>
      pendingRequest({
        kind,
        mode: kind === "harness.input" ? "live" : "durable",
        payload: { kind },
        presentation: {
          fields: [{ custom: true, id: "q", multiSelect: false, prompt: "Which one?", secret }],
          kind: "form",
          title: "More information needed",
        },
      });
    expect(deriveSurface([question(false, "harness.input")], viewer)?.textRole).toBe("answer");
    expect(deriveSurface([question(false, "person.question")], viewer)?.textRole).toBe("answer");
    expect(deriveSurface([question(true, "harness.input")], viewer)?.textRole).toBe("hidden");
    // Someone the question wasn't asked of keeps an ordinary message box.
    expect(
      deriveSurface([question(false, "person.question")], { id: createId("user") })?.textRole,
    ).toBe("message");
  });

  it("focuses the oldest live action ahead of durable ones and names what waits", () => {
    const durable = pendingRequest({
      kind: "integration.access",
      createdAt: "2026-08-12T00:00:00.000Z",
      mode: "durable",
      payload: integrationAccessPayload(),
      presentation: {
        kind: "external",
        subject: { id: "req", kind: "integration.access" },
        title: "Gmail access",
      },
    });
    const live = pendingRequest({ createdAt: "2026-08-12T00:00:01.000Z" });
    const surface = deriveSurface([durable, live], viewer);
    expect(surface?.request.id).toBe(live.id);
    expect(surface?.queued).toBe(1);
    expect(surface?.queuedTitle).toBe("Gmail access");
  });

  it("keeps durable external actions alongside a normal composer", () => {
    const durable = pendingRequest({
      kind: "integration.access",
      mode: "durable",
      payload: integrationAccessPayload(),
      presentation: {
        kind: "external",
        subject: { id: "req", kind: "integration.access" },
        title: "Gmail access",
      },
    });
    expect(deriveSurface([durable], viewer)?.textRole).toBe("message");
  });

  it("keeps the approve/decline choice semantics for plugin approvals", () => {
    const durable = pendingRequest({
      kind: "plugin.approval",
      mode: "live",
      payload: { kind: "plugin.approval", executionId: "execution", interactionId: "interaction" },
      presentation: {
        kind: "choice",
        options: [
          { hint: "reject-once", id: "decline", label: "Not now" },
          { hint: "confirm", id: "accept", label: "Allow" },
        ],
        title: "Create Calendar event?",
      },
    });
    const surface = deriveSurface([durable], viewer);
    expect(surface?.request.kind).toBe("plugin.approval");
    expect(surface?.textRole).toBe("message");
  });

  it("says who may answer when the viewer cannot", () => {
    const surface = deriveSurface([pendingRequest()], {
      id: createId("user"),
    });
    expect(surface?.denied).toBe("requester");
    expect(surface?.textRole).toBe("message");
  });

  it("uses the Host required actor for installation and requester grants", () => {
    const administrator = { id: createId("user") };
    const preinstall = pendingRequest({
      requiredActor: "owner",
      kind: "integration.access",
      mode: "durable",
      payload: {
        ...integrationAccessPayload(),
        installationId: null,
        manifest: catalogManifest(),
      },
      presentation: {
        kind: "external",
        subject: { id: "calendar", kind: "integration.access" },
        title: "Install Calendar",
      },
    });

    expect(deriveSurface([preinstall], administrator)?.denied).toBeNull();
    expect(
      deriveSurface(
        [
          {
            ...preinstall,
            requiredActor: "requester",
            payload: integrationAccessPayload(),
          },
        ],
        administrator,
      )?.denied,
    ).toBe("requester");
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

function integrationAccessPayload() {
  return {
    access: "read" as const,
    installationId: "installation",
    kind: "integration.access" as const,
    manifest: null,
    requestedConnectionId: null,
    reason: "Read mail",
    requestedServerId: null,
  };
}
