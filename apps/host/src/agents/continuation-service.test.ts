import type { BrowserSignInRequestResponse } from "@opensteer/protocol/browser-sources";
import { createBrowserSessionId } from "@opensteer/protocol";
import { createHash } from "node:crypto";
import { OpensteerError, PendingRequestSchema, RequestSchema, createId } from "@opensteer/core";
import type { Request } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { createIntegrationId } from "@opensteer/integration-core";
import type { IntegrationReadiness } from "@opensteer/integration-core";
import type { CommandService } from "@opensteer/orchestration";
import { describe, expect, it, vi } from "vitest";
import {
  ContinuationService,
  continuationMessage,
  type IntegrationInventorySource,
} from "./continuation-service.js";
const now = "2026-08-22T12:00:00.000Z";
const ownerId = createId("user");
const threadId = createId("thread");

const definitionId = "google-gmail";
const proposalDigest = "0123456789abcdef0123456789abcdef0123456789a";
const installationId = createIntegrationId("installation");
const serverId = createIntegrationId("server");
const accountConnectionId = createIntegrationId("connection");
type InventoryEntry = Awaited<
  ReturnType<IntegrationInventorySource["listDiscoveryInventory"]>
>[number];
describe("ContinuationService", () => {
  it("continues device fulfillment with fresh routes and preserves a task decline", async () => {
    const base = fulfilledRequest("machine.full-disk-access");
    const fulfilled = RequestSchema.parse({
      ...base,
      kind: "device.access",
      payload: {
        kind: "device.access",
        machineId: createId("runner"),
        machineName: "Phone",
        access: "browser",
        reason: "Read the task's page",
      },
    });
    const fixture = makeService([fulfilled]);
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledOnce();
    expect(fixture.enqueueThreadInput.mock.calls[0]![0].content[0].text).toContain(
      "rebuilds device routes",
    );
    expect(
      await continuationMessage(fulfilled, {
        listDiscoveryInventory: async () => [],
        listCallableTools: async () => [],
        computerUseMachines: async () => [],
        computerUsePhones: async () => [],
      }),
    ).toContain("Per-app, profile or OS authorization");
    const declined = RequestSchema.parse({
      ...fulfilled,
      status: "declined",
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(
      await continuationMessage(declined, {
        listDiscoveryInventory: async () => [],
        listCallableTools: async () => [],
        computerUseMachines: async () => [],
        computerUsePhones: async () => [],
      }),
    ).toContain("do not request it again in this task");
  });

  it("uses a human-settled reference and a different key when later outcomes from the same Run arrive", async () => {
    const answered = RequestSchema.parse({
      ...fulfilledRequest("browser.access"),
      settlementProvenance: {
        sessionId: createId("authSession"),
        deviceLabel: "Test phone",
      },
    });
    const cancelled = RequestSchema.parse({
      ...fulfilledRequest("browser.access"),
      originatingRunId: answered.originatingRunId,
      createdAt: "2026-08-21T12:00:00.000Z",
      status: "cancelled",
      cancellationReason: "resource-deleted",
      response: null,
      resolvedBy: null,
    });
    const automatic = {
      ...fulfilledRequest("browser.access"),
      originatingRunId: answered.originatingRunId,
      createdAt: "2026-08-21T13:00:00.000Z",
    };
    const fixture = makeService([cancelled, automatic, answered]);
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledOnce();
    expect(fixture.enqueueThreadInput.mock.calls[0]![0].source.referenceId).toBe(answered.id);
    expect(fixture.enqueueThreadInput.mock.calls[0]![0].content[0].text).toContain(
      "cancelled (resource-deleted)",
    );
    const later = makeService([answered]);
    later.service.notify();
    await later.service.close();
    expect(later.enqueueThreadInput.mock.calls[0]![0].idempotencyKey).not.toBe(
      fixture.enqueueThreadInput.mock.calls[0]![0].idempotencyKey,
    );
  });
  it("holds all a Run's outcomes while a sign-in is still publishing", async () => {
    const answered = fulfilledRequest("browser.access");
    const signIn = RequestSchema.parse({
      ...answered,
      id: createId("request"),
      kind: "browser.password-sign-in",
      payload: {
        scope: "personal",
        permissionVersion: 6,
        kind: "browser.password-sign-in",
        computerName: "Test Mac",
        runnerId: createId("runner"),
        expiresAt: now,
        operationId: crypto.randomUUID(),
        reason: "Read email",

        site: "https://example.com",
      },
    });
    const fixture = makeService([answered, signIn], {
      passwordSignIn: () => ({
        publishing: true,
        loginRef: undefined,
      }),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).not.toHaveBeenCalled();
    expect(fixture.recordContinuationAttempt).not.toHaveBeenCalled();
  });
  it("reads a sign-in's publication only once its Request is settled", async () => {
    const answered = fulfilledRequest("browser.access");
    const pending = RequestSchema.parse({
      ...answered,
      kind: "browser.password-sign-in",
      payload: {
        scope: "personal",
        permissionVersion: 6,
        kind: "browser.password-sign-in",
        computerName: "Test Mac",
        runnerId: createId("runner"),
        expiresAt: now,
        operationId: crypto.randomUUID(),
        reason: "Read email",

        site: "https://example.com",
      },
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
    });
    const passwordSignIn = vi.fn(() => ({
      publishing: false as const,
      loginRef: undefined,
    }));
    const fixture = makeService([], {
      passwordSignIn,
    });
    await expect(fixture.service.outcome(pending)).resolves.toBeNull();
    expect(passwordSignIn).not.toHaveBeenCalled();
    await fixture.service.close();
  });
  it("batches a Run's outcomes, retaining siblings when one outcome cannot be rendered", async () => {
    const first = fulfilledRequest("browser.access");
    const second = {
      ...fulfilledRequest("integration.access"),
      originatingRunId: first.originatingRunId,
    };
    const broken = RequestSchema.parse({
      ...fulfilledRequest("browser.access"),
      originatingRunId: first.originatingRunId,
      kind: "browser.sign-in",
      payload: {
        kind: "browser.sign-in",
        reason: "Sign in",
        site: "https://example.com",
        sessionId: createBrowserSessionId(),
      },
    });
    const fixture = makeService([second, first, broken]);
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledOnce();
    const input = fixture.enqueueThreadInput.mock.calls[0]![0];
    expect(input.idempotencyKey).toMatch(/^request-continuation:[a-f0-9]{64}$/);
    expect(input.content[0].text).toContain(first.id);
    expect(input.content[0].text).toContain(second.id);
    expect(input.content[0].text).toContain(broken.id);
    expect(input.content[0].text).toContain("pending_request");
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledTimes(3);
  });

  it("drains every durable kind through one outbox and one idempotency shape", async () => {
    const requests = [
      fulfilledRequest("browser.access"),
      fulfilledRequest("integration.access"),
      fulfilledRequest("integration.install"),
    ];
    const fixture = makeService(requests, {
      enqueueThreadInput: vi
        .fn()
        .mockResolvedValueOnce(delivery("pending"))
        .mockResolvedValueOnce(delivery("run-queued"))
        .mockResolvedValueOnce(delivery("steering"))
        .mockResolvedValueOnce(delivery("pending")),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledTimes(3);
    for (const request of requests) {
      expect(fixture.enqueueThreadInput).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `request-continuation:${createHash("sha256")
            .update(JSON.stringify([request.id]))
            .digest("hex")}`,
          requestedBy: request.requestedBy,
          source: {
            cause: "request-resolved",
            kind: "platform",
            referenceId: request.id,
            sourceRunId: request.originatingRunId,
          },
          threadId: request.originatingThreadId,
        }),
      );
      expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
        reason: null,
        requestId: request.id,
        status: "queued",
      });
    }
    expect(fixture.errors).toEqual([]);
  });
  it("drains a notification received while the previous drain is still busy", async () => {
    const fixture = makeService([fulfilledRequest("browser.access")]);
    const listed =
      Promise.withResolvers<Awaited<ReturnType<typeof fixture.listPendingContinuations>>>();
    fixture.listPendingContinuations.mockReturnValueOnce(listed.promise);
    fixture.service.notify();
    try {
      expect(fixture.listPendingContinuations).toHaveBeenCalledOnce();
      fixture.service.notify();
      listed.resolve([]);
      await vi.waitFor(() => expect(fixture.enqueueThreadInput).toHaveBeenCalledOnce(), {
        timeout: 1_000,
      });
      expect(fixture.listPendingContinuations).toHaveBeenCalledTimes(2);
    } finally {
      listed.resolve([]);
      await fixture.service.close();
    }
  });
  it("settles a Trigger-originated Request without delivering any continuation", async () => {
    const triggerRequest = triggerOriginatedRequest();
    const runRequest = fulfilledRequest("integration.access");
    const fixture = makeService([triggerRequest, runRequest], {
      enqueueThreadInput: vi.fn().mockResolvedValue(delivery("run-queued")),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledOnce();
    expect(fixture.enqueueThreadInput).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: runRequest.originatingThreadId,
      }),
    );
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
      reason: expect.stringContaining("Trigger-originated Requests receive no continuation"),
      requestId: triggerRequest.id,
      status: "undeliverable",
    });
    expect(fixture.errors).toEqual([]);
  });
  it("leaves a transient failure waiting and continues draining sibling rows", async () => {
    const failure = new OpensteerError({
      code: "timeout",
      message: "Thread admission timed out",
      retryable: true,
    });
    const requests = [fulfilledRequest("integration.access"), fulfilledRequest("browser.access")];
    const fixture = makeService(requests, {
      enqueueThreadInput: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(delivery("run-queued")),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledTimes(2);
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
      reason: null,
      requestId: requests[0]!.id,
      status: "waiting",
    });
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
      reason: null,
      requestId: requests[1]!.id,
      status: "queued",
    });
    expect(fixture.errors).toEqual([failure]);
  });
  it("settles a permanently unreachable originating Thread", async () => {
    const failure = new OpensteerError({
      code: "conflict",
      message: "Archived threads cannot run",
    });
    const request = fulfilledRequest("browser.access");
    const fixture = makeService([request], {
      enqueueThreadInput: vi.fn().mockRejectedValueOnce(failure),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
      reason: "Archived threads cannot run",
      requestId: request.id,
      status: "undeliverable",
    });
    expect(fixture.errors).toEqual([]);
  });
  it("marks a cancelled Thread input as undeliverable instead of queued", async () => {
    const request = fulfilledRequest("integration.install");
    const fixture = makeService([request], {
      enqueueThreadInput: vi.fn(async () => delivery("cancelled")),
    });
    fixture.service.notify();
    await fixture.service.close();
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledOnce();
    expect(fixture.recordContinuationAttempt).toHaveBeenCalledWith({
      reason: "Continuation delivery was cancelled by Thread input admission",
      requestId: request.id,
      status: "undeliverable",
    });
    expect(fixture.recordContinuationAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
      }),
    );
    expect(fixture.errors).toEqual([]);
  });
});
describe("continuationMessage", () => {
  it("says a Chrome Request found nothing to copy without steering the agent", async () => {
    const message = await continuationMessage(
      browserSignInRequest({ outcome: "not-signed-in" }),
      inventory(),
    );
    expect(message).toContain("did not decline");
    expect(message).toContain("nothing was copied");
  });
  it.each(["browser.access"] as const)(
    "names the exact Host-recorded profile for %s",
    async (kind) => {
      const profile = {
        id: createId("browserProfile"),
        name: 'Owner "renamed" work',
      };
      const request = RequestSchema.parse({
        ...fulfilledRequest(kind),
        response: {
          kind: "external",
          value: {
            decision: "fulfilled",
            profile,
          },
        },
      });
      expect(await continuationMessage(request, inventory())).toBe(
        kind === "browser.access"
          ? String.raw`Request ${request.id} was fulfilled. The person chose browser profile "Owner \"renamed\" work" (${profile.id}); use it for this task even if you suggested another. Open a tab with Browser Harness newTab(url, { profile: "${profile.id}" }), then continue the task.`
          : `Request ${request.id} is historical. Open a named browser profile before signing in, or ask for one with browser_profile_request; Guest sign-ins cannot be saved.`,
      );
    },
  );
  it.each(["browser.access"] as const)(
    "does not guess the profile for historical %s rows",
    async (kind) => {
      const request = fulfilledRequest(kind);
      expect(await continuationMessage(request, inventory())).toBe(
        kind === "browser.access"
          ? `Request ${request.id} was fulfilled. Browser profile access is now available; browser_profile_list shows the profiles your Opensteer can use. Continue the task.`
          : `Request ${request.id} is historical. Open a named browser profile before signing in, or ask for one with browser_profile_request; Guest sign-ins cannot be saved.`,
      );
    },
  );
  it.each(["browser.access"] as const)("preserves the declined %s text", async (kind) => {
    const request = RequestSchema.parse({
      ...fulfilledRequest(kind),
      response: {
        kind: "external",
        value: {
          decision: "declined",
        },
      },
      status: "declined",
    });
    expect(await continuationMessage(request, inventory())).toBe(
      kind === "browser.access"
        ? `Request ${request.id} was declined by the user. Browser profiles your Opensteer could already use are unchanged: browser_profile_list shows them. Do not request this access again unless the user asks.`
        : `Request ${request.id} is historical. Open a named browser profile before signing in, or ask for one with browser_profile_request; Guest sign-ins cannot be saved.`,
    );
  });
  it.each([
    {
      outcome: "interrupted",
    },
    {
      outcome: "expired",
    },
    {
      outcome: "unavailable",
      reason: "not-responding",
    },
  ])("describes a recoverable Passwords result honestly: %o", async (value) => {
    const request = RequestSchema.parse({
      ...fulfilledRequest("browser.access"),
      kind: "browser.password-sign-in",
      payload: {
        scope: "personal",
        permissionVersion: 6,
        kind: "browser.password-sign-in",
        computerName: "Test Mac",
        expiresAt: now,
        operationId: crypto.randomUUID(),
        reason: "Read the invoice",
        runnerId: createId("runner"),

        site: "https://example.com",
      },
      response: {
        kind: "external",
        value,
      },
    });
    const message = await continuationMessage(request, inventory());
    expect(message).not.toContain("open a fresh Browser Session");
    expect(message).not.toContain("because Opensteer Passwords stopped answering");
    expect(message).not.toContain("the user did not sign in another way");
    expect(message).toContain("use_saved_login again");
  });
  it("uses the live personal ref on every surface without inventing a session", async () => {
    const request = RequestSchema.parse({
      ...fulfilledRequest("browser.access"),
      kind: "browser.password-sign-in",
      payload: {
        kind: "browser.password-sign-in",
        scope: "personal",
        permissionVersion: 6,
        computerName: "Vault Mac",
        expiresAt: now,
        operationId: crypto.randomUUID(),
        reason: "Read invoice",
        runnerId: createId("runner"),
        site: "https://example.com",
      },
      response: {
        kind: "external",
        value: {
          outcome: "authorized",
          account: "masked",
        },
      },
    });
    const loginRef = "lgn_" + "1".repeat(32);
    const message = await continuationMessage(request, inventory(), loginRef);
    expect(message).toContain(loginRef);
    expect(message).toContain("type");
    expect(message).toContain("fillLogin");
    expect(message).not.toContain("Browser Session undefined");
    expect(await continuationMessage(request, inventory())).toContain("use_saved_login again");
  });
  it("does not claim access when the Mac has been removed", async () => {
    await expect(
      continuationMessage(computerAppAccessRequest("fulfilled"), withMacs(false)),
    ).resolves.toContain("is no longer available to this task. Continue without it.");
  });
  it("reports a ready installation and points the agent at integration_search", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "READY",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail is installed and ready. Call integration_search now to pick up its tools and continue the task.`,
    );
  });
  it("says an installation with no personal grant is not yet usable", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "ACCESS_GRANT_REQUIRED",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail is installed and its account connection works, but your Opensteer holds no access grant yet. Call integration_search now, then call integration_request with this integration and the access class the task needs.`,
    );
  });
  it("reports a missing personal grant after fulfillment", async () => {
    const request = fulfilledRequest("integration.access");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "ACCESS_GRANT_REQUIRED",
            detail: "No personal grant",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail read access was granted for connectionless operations. Your Opensteer still holds no access grant (No personal grant).`,
    );
  });
  it("sends the agent to integration_request when the installation has no account", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "USER_AUTHORIZATION_REQUIRED",
            detail: "No Google account",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail is installed but has no connected account (No Google account). Call integration_request now for the account connection, then continue the task.`,
    );
  });
  it("reports the statusDetail of an installation that landed unusable", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "INTEGRATION_UNAVAILABLE",
            detail: "The OpenAPI document could not be compiled",
            status: "needs-attention",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled, but Gmail installed in an unusable state: The OpenAPI document could not be compiled. Requesting it again will not help. Continue without it and tell the user what that detail says.`,
    );
  });
  it("directs a misconfigured provider through the agent-owned setup request", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "ADMIN_CONFIGURATION_REQUIRED",
            detail: "No Google application",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled, but Gmail installed in an unusable state: No Google application. Request access through integration_request; the connection UI offers supported personal-app setup and identifies any administrator prerequisite.`,
    );
  });
  it("never claims an installation that the inventory does not hold", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "READY",
            provenance: {
              definitionId: "slack",
            },
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was approved, but Gmail is not present in the current integration inventory. Call integration_search now to see what is actually installed and continue from there.`,
    );
  });
  it("locates a proposal installation by the approved artifact digest", async () => {
    const request = fulfilledRequest("integration.install", {
      proposal: true,
    });
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "READY",
            provenance: {
              artifactDigest: proposalDigest,
            },
            sourceKind: "proposed",
            title: "Weather API",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Weather API is installed and ready. Call integration_search now to pick up its tools and continue the task.`,
    );
  });
  it("reports an installation that exposes no servers as unusable", async () => {
    const request = fulfilledRequest("integration.install");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            servers: [],
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled, but Gmail installed in an unusable state: the installation exposes no servers. An administrator must repair the installation. Continue without it and tell the user.`,
    );
  });
  it("names the connected account once the access grant is verified", async () => {
    const request = fulfilledRequest("integration.access", {
      accountIdentifier: "alex@example.com",
      displayName: "Alex",
    });
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "READY",
            connectionId: accountConnectionId,
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail read access was granted for connection ${accountConnectionId}. Granted account: Alex (alex@example.com). Its read access is active.`,
    );
  });
  it("reports an unusable fulfilled target", async () => {
    const request = fulfilledRequest("integration.access");
    expect(
      await continuationMessage(
        request,
        inventory(
          entry({
            code: "REAUTHORIZATION_REQUIRED",
            detail: "Missing gmail.modify",
          }),
        ),
      ),
    ).toBe(
      `Request ${request.id} was fulfilled. Gmail read access was granted for connectionless operations. The fulfilled target is not usable (Missing gmail.modify).`,
    );
  });
  it("never claims access to an installation that has left the inventory", async () => {
    const request = fulfilledRequest("integration.access");
    expect(await continuationMessage(request, inventory())).toBe(
      `Request ${request.id} was fulfilled. ${installationId} read access was granted for connectionless operations. The integration is no longer in the inventory this Run can see.`,
    );
  });
});
function inventory(...entries: readonly InventoryEntry[]): IntegrationInventorySource {
  return {
    listDiscoveryInventory: async () => [...entries],
    computerUseMachines: async () => [],
    computerUsePhones: async () => [],
    listCallableTools: async () => [],
  };
}
const macRunnerId = createId("runner");
const macConnectionId = createIntegrationId("connection");
const macGrantId = createIntegrationId("grant");
const macObserveId = createIntegrationId("tool");
const macActId = createIntegrationId("tool");
function browserSignInRequest(value: BrowserSignInRequestResponse) {
  return RequestSchema.parse({
    ...fulfilledRequest("browser.access"),
    kind: "browser.sign-in",
    payload: {
      kind: "browser.sign-in",
      reason: "Pull this month's spend",
      sessionId: `bsn_${crypto.randomUUID()}`,
      site: "https://brex.com",
    },
    response: {
      kind: "external",
      value,
    },
  });
}
function computerAppAccessRequest(status: "declined" | "fulfilled") {
  const pending = PendingRequestSchema.parse({
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "computer.app.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: threadId,
    payload: {
      access: "read-write",
      app: {
        bundleId: "com.apple.Notes",
        displayName: "Notes",
        teamId: null,
      },
      definitionId: "macos-app",
      kind: "computer.app.access",
      reason: "Read my notes",
      runnerId: macRunnerId,
      setupRequestId: crypto.randomUUID(),
    },
    presentation: {
      kind: "external",
      subject: {
        id: crypto.randomUUID(),
        kind: "computer-app-setup",
      },
      title: "Wants to use Notes on Alex's Mac",
    },
    requestedBy: ownerId,
    requiredActor: "owner",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
  return RequestSchema.parse({
    ...pending,
    resolvedAt: now,
    resolvedBy: ownerId,
    response: {
      kind: "external",
      value: {
        decision: status,
      },
    },
    status,
  });
}
function withMacs(named: boolean): IntegrationInventorySource {
  return {
    ...inventory(),
    computerUseMachines: async () =>
      named
        ? [
            {
              name: "Alex's Mac",
              ready: true,
              state: "ready",
              appApproval: "ask",
              apps: [
                {
                  bundleId: "com.apple.Notes",
                  name: "Notes",
                  access: "read-write",
                  status: "approved",
                  connectionId: macConnectionId,
                },
              ],
              runnerId: macRunnerId,
            },
          ]
        : [],
    listCallableTools: async () =>
      ["observe", "act"].map(
        (name) =>
          ({
            grant: {
              id: macGrantId,
              connectionId: macConnectionId,
            },
            tool: {
              name,
              id: name === "observe" ? macObserveId : macActId,
              schemaDigest: "digest",
            },
          }) as unknown as Awaited<
            ReturnType<IntegrationInventorySource["listCallableTools"]>
          >[number],
      ),
  };
}
function entry(
  input: {
    readonly code?: IntegrationReadiness["code"];
    readonly connectionId?: IntegrationReadiness["connectionId"];
    readonly detail?: string;
    readonly provenance?: Readonly<Record<string, string>>;
    readonly servers?: readonly IntegrationReadiness[];
    readonly sourceKind?: "built-in" | "proposed";
    readonly status?: "active" | "needs-attention";
    readonly title?: string;
  } = {},
): InventoryEntry {
  return {
    accounts: [],
    installation: {
      createdAt: now,
      description: "Gmail",
      id: installationId,
      manifest: {},
      name: "google-gmail",
      provenance: input.provenance ?? {
        definitionId,
      },
      revision: 1,
      sourceKind: input.sourceKind ?? "built-in",
      status: input.status ?? "active",
      title: input.title ?? "Gmail",
      trust: "built-in",
      updatedAt: now,
      version: "1.0.0",
    },
    readiness: {
      servers: input.servers ?? [
        {
          code: input.code ?? "READY",
          connectionId: input.connectionId ?? null,
          detail: input.detail ?? null,
          provider: null,
          requiredAccess: (input.code ?? "READY") === "ACCESS_GRANT_REQUIRED" ? "read" : null,
          serverId,
        },
      ],
      tools: [],
    },
    servers: [],
    tools: [],
  };
}
function makeService(
  requests: readonly Request[],
  options: {
    enqueueThreadInput?: ReturnType<typeof vi.fn>;
    passwordSignIn?: ConstructorParameters<typeof ContinuationService>[0]["passwordSignIn"];
  } = {},
) {
  const errors: unknown[] = [];
  const enqueueThreadInput = options.enqueueThreadInput ?? vi.fn(async () => delivery("pending"));
  const recordContinuationAttempt = vi.fn(async () => true);
  const listPendingContinuations = vi.fn(async () =>
    requests.map((request) => ({
      attemptedAt: null,
      reason: null,
      request,
      status: "waiting" as const,
    })),
  );
  const service = new ContinuationService({
    commands: {
      enqueueThreadInput,
    } as unknown as Pick<CommandService, "enqueueThreadInput">,
    integrations: inventory(),
    ...(options.passwordSignIn
      ? {
          passwordSignIn: options.passwordSignIn,
        }
      : {}),
    onError: (error) => errors.push(error),
    requests: {
      get: async (id: Request["id"]) => requests.find((request) => request.id === id) ?? null,
      listPendingContinuations,
      recordContinuationAttempt,
    } as unknown as Pick<
      OpensteerStore["requests"],
      "listPendingContinuations" | "recordContinuationAttempt" | "get"
    >,
  });
  return {
    enqueueThreadInput,
    errors,
    listPendingContinuations,
    recordContinuationAttempt,
    service,
  };
}
function delivery(disposition: "cancelled" | "pending" | "run-queued" | "steering") {
  return {
    disposition,
  };
}

/** The same durable Request, opened by a Trigger Occurrence instead of a Run. */
function triggerOriginatedRequest(): Request {
  return RequestSchema.parse({
    ...fulfilledRequest("integration.access"),
    originatingOccurrenceId: createId("triggerOccurrence"),
    originatingRunId: null,
  });
}
function fulfilledRequest(
  kind:
    "browser.access" | "integration.access" | "integration.install" | "machine.full-disk-access",
  account?:
    | {
        readonly accountIdentifier: string | null;
        readonly displayName: string;
      }
    | {
        readonly proposal: true;
      },
) {
  const proposal = account !== undefined && "proposal" in account;
  const pending = PendingRequestSchema.parse({
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind,
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: threadId,
    payload: payloadFor(kind, proposal),
    presentation:
      kind === "integration.install"
        ? {
            kind: "choice",
            options: [
              {
                hint: "confirm",
                id: "installed",
                label: "Install",
              },
              {
                hint: "cancel",
                id: "declined",
                label: "Decline",
              },
            ],
            title: "Install Gmail?",
          }
        : {
            kind: "external",
            subject: {
              id: threadId,
              kind: "thread",
            },
            title: "Request",
          },
    requestedBy: ownerId,
    requiredActor: kind === "integration.install" ? "owner" : "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
  return RequestSchema.parse({
    ...pending,
    resolvedAt: now,
    resolvedBy: ownerId,
    response:
      kind === "integration.install"
        ? {
            kind: "choice",
            optionId: "installed",
          }
        : {
            kind: "external",
            value: {
              ...(account && !proposal
                ? {
                    account,
                  }
                : {}),
              connectionId: account && !proposal ? accountConnectionId : null,
              decision: "fulfilled",
            },
          },
    status: "fulfilled",
  });
}
function payloadFor(
  kind:
    "browser.access" | "integration.access" | "integration.install" | "machine.full-disk-access",
  proposal: boolean,
) {
  switch (kind) {
    case "browser.access":
      return {
        kind,
        reason: "Need the portal",
        suggestion: {
          kind: "user_choice" as const,
        },
      };
    case "integration.access":
      return {
        access: "read" as const,
        installationId,
        kind,
        manifest: null,
        reason: "Need records",
        requestedConnectionId: null,
        requestedServerId: null,
      };
    case "integration.install":
      return {
        kind,
        manifest: proposal
          ? {
              kind: "proposal",
              proposal: {
                authMethods: ["api-key"],
                digest: proposalDigest,
                kind: "openapi",
                preview: {
                  title: "Weather API",
                },
                source: {
                  origin: "https://weather.example.test",
                  type: "url",
                },
              },
            }
          : {
              definition: {
                id: definitionId,
                name: "Gmail",
              },
              digest: proposalDigest,
              kind: "catalog",
            },
        reason: "Need records",
      };
    case "machine.full-disk-access":
      return {
        kind,
        machineId: createId("runner"),
        machineName: "Test Mac",
        reason: "Read Mail",
      };
  }
}
