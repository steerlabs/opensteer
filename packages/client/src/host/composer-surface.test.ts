import { createId, type Request } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { deriveSurface } from "./composer-surface.js";

const requester = createId("user");
const viewer = { id: requester, instanceRole: "user" as const };

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

describe("deriveSurface", () => {
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

  it("hides the textarea while a live form collects its own answers", () => {
    const request = pendingRequest({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [{ id: "q", multiSelect: false, prompt: "Which one?", secret: false }],
        kind: "form",
        title: "More information needed",
      },
    });
    expect(deriveSurface([request], viewer)?.textRole).toBe("hidden");
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

  it("keeps the approve/decline choice semantics for integration installs", () => {
    const durable = pendingRequest({
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
    });
    const surface = deriveSurface([durable], viewer);
    expect(surface?.request.kind).toBe("integration.install");
    expect(surface?.textRole).toBe("message");
  });

  it("says who may answer when the viewer cannot", () => {
    const surface = deriveSurface([pendingRequest()], {
      id: createId("user"),
      instanceRole: "user",
    });
    expect(surface?.denied).toBe("requester");
    expect(surface?.textRole).toBe("message");
  });

  it("lets an administrator install for another requester but not grant installed access", () => {
    const administrator = { id: createId("user"), instanceRole: "administrator" as const };
    const preinstall = pendingRequest({
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
