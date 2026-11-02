import { describe, expect, it, vi } from "vitest";
import type { IntegrationPlatformStore } from "@opensteer/database";
import type { RunnerId, UserId } from "@opensteer/core";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import type { ComputerAppSetupRequest } from "@opensteer/integration-core";
import {
  ComputerAppApprovalService,
  type ComputerUseApprovalGateway,
} from "./computer-app-approval-service.js";

const ownerUserId = "usr_00000000-0000-4000-8000-000000000001" as UserId;
const runnerId = "rnr_00000000-0000-4000-8000-000000000002" as RunnerId;
const app = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLECOMP1" };
const request: ComputerAppSetupRequest = {
  id: "00000000-0000-4000-8000-000000000003",
  runnerId,
  ownerUserId,
  deploymentId:
    "dep_00000000-0000-4000-8000-000000000004" as ComputerAppSetupRequest["deploymentId"],
  kind: "app",
  app,
  definitionId: "macos-app",
  definitionDigest: "definition",
  access: "read",
  policyAppApproval: null,
  server: null,
  reason: null,
  threadId: null,
  threadTitle: null,
  workspaceId: null,
  workspaceName: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
function fixture(pending = request) {
  const store = {
    getComputerUsePolicy: vi.fn(async () => ({ appApproval: "ask" })),
    getComputerAppSetupRequest: vi.fn(async () => pending),
    listInstallations: vi.fn(async () => []),
    localMcp: {
      approve: vi.fn(async () => ({ launchDigest: "launch", serverId: "ims_server" })),
      decline: vi.fn(),
    },
    setComputerConnection: vi.fn(),
    cancelComputerAppSetup: vi.fn(async () => ({ requestEvents: [] })),
    requests: { declineComputerAppAccessRequest: vi.fn(async () => ({ events: [], request: {} })) },
  };
  const computerUse = {
    resolveApp: vi.fn(async () => ({
      identity: app,
      allowed: true,
      path: "/System/Applications/Notes.app",
      risk: "standard",
      reason: null as string | null,
      running: false,
    })),
  };
  const admission = vi.fn(async <T>(_runner: RunnerId, work: () => Promise<T>): Promise<T> =>
    work(),
  );
  const install = vi.fn(async () => undefined);
  const changed = vi.fn();
  const service = new ComputerAppApprovalService({
    computerApps: { withRunnerAdmission: admission, attached: () => true } as never,
    computerUse: computerUse as unknown as ComputerUseApprovalGateway,
    definitions: integrationDefinitions,
    deploymentName: null,
    installCatalogDefinition: install,
    listCallableTools: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    onConnectionsChanged: changed,
    onLocalServerApproved: vi.fn(),
    publishRequestEvents: vi.fn(),
    store: store as unknown as IntegrationPlatformStore,
  });
  return { service, store, computerUse, admission, install, changed };
}
const answer = {
  setupRequestId: request.id,
  actorUserId: ownerUserId,
  isAdministrator: false,
  requestId: "answer",
  decision: "allow" as const,
  authorize: async () => undefined,
};

describe("owner-session computer app approvals", () => {
  it("passes the authenticated session through owner denial and task decline", async () => {
    const { service, store } = fixture();
    await service.respondComputerAppSetup({
      ...answer,
      decision: "deny",
      settlementSessionId: "session",
    });
    expect(store.cancelComputerAppSetup).toHaveBeenCalledWith({
      requestId: request.id,
      ownerUserId,
      settlementSessionId: "session",
    });
    await service.declineComputerAppAccess({
      requestId: "req_task" as import("@opensteer/core").RequestId,
      resolvedBy: ownerUserId,
      settlementSessionId: "session",
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(store.requests.declineComputerAppAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ settlementSessionId: "session", actorUserId: ownerUserId }),
    );
  });
  it("verifies the current owner's app through the target helper", async () => {
    const { service, computerUse } = fixture();
    const review = await service.reviewComputerAppSetup({
      setupRequestId: request.id,
      ownerUserId,
    });
    expect(review.app?.path).toBe("/System/Applications/Notes.app");
    expect(computerUse.resolveApp).toHaveBeenCalledWith({ app: app.bundleId, runnerId });
  });
  it("never consults the helper for a non-owner", async () => {
    const { service, store, computerUse } = fixture();
    store.getComputerUsePolicy.mockRejectedValue(new Error("Only this computer’s owner"));
    await expect(
      service.reviewComputerAppSetup({ setupRequestId: request.id, ownerUserId }),
    ).rejects.toThrow("owner");
    expect(computerUse.resolveApp).not.toHaveBeenCalled();
  });
  it("leaves approval pending when the helper cannot verify it", async () => {
    const { service, computerUse, store } = fixture();
    computerUse.resolveApp.mockRejectedValue(new Error("offline"));
    await expect(service.respondComputerAppSetup(answer)).rejects.toThrow("verify");
    expect(store.setComputerConnection).not.toHaveBeenCalled();
  });
  it("refuses changed identities and denied apps before allowing", async () => {
    const { service, computerUse, store } = fixture();
    computerUse.resolveApp.mockResolvedValueOnce({
      identity: { ...app, teamId: "OTHERTEAM1" },
      allowed: true,
      path: "/tmp/Notes.app",
      risk: "standard",
      reason: null,
      running: false,
    });
    await expect(service.respondComputerAppSetup(answer)).rejects.toThrow("changed");
    computerUse.resolveApp.mockResolvedValueOnce({
      identity: app,
      allowed: false,
      path: "/System/Applications/Notes.app",
      risk: "standard",
      reason: "This app is denied",
      running: false,
    });
    await expect(service.respondComputerAppSetup(answer)).rejects.toThrow("denied");
    expect(store.setComputerConnection).not.toHaveBeenCalled();
  });
  it("keeps first installation administrator-only even for the computer owner", async () => {
    const { service, install, store } = fixture();
    await expect(service.respondComputerAppSetup(answer)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(install).not.toHaveBeenCalled();
    expect(store.setComputerConnection).not.toHaveBeenCalled();
  });
  it("revalidates the approving session after waiting in admission and grants nothing when it was revoked", async () => {
    const { service, store, admission, changed } = fixture({
      ...request,
      kind: "server",
      app: null,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    admission.mockImplementationOnce(async (_runner, work) => {
      await held;
      return work();
    });
    let revoked = false;
    const authorize = vi.fn(async () => {
      if (revoked) throw new Error("Session revoked");
    });
    const responding = service.respondComputerAppSetup({ ...answer, authorize });
    await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
    revoked = true;
    release();
    await expect(responding).rejects.toThrow("Session revoked");
    expect(store.localMcp.approve).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
