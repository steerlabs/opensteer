import { createId, PendingRequestSchema } from "@opensteer/core";
import type { ReachableMachineRecord } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import { MachineFullDiskAccessService } from "./machine-full-disk-access-service.js";

const claims: AgentControlRunScope = {
  aud: "opensteer-agent-control",
  bindingGeneration: 1,
  capabilityProfileId: "workspace",
  environmentId: createId("environment"),
  exp: 2000000000,
  iat: 1900000000,
  iss: "opensteer-host",
  jti: "test",
  membershipGeneration: 1,
  requestedBy: createId("user"),
  runId: createId("run"),
  runnerBootId: "boot-1",
  runnerId: createId("runner"),
  threadId: createId("thread"),
  workspaceId: createId("workspace"),
};
function machine(overrides: Partial<ReachableMachineRecord> = {}): ReachableMachineRecord {
  return {
    commands: true,
    forwarding: false,
    fullDiskAccess: false,
    hostPublicKey: "ssh-ed25519 AAAA",
    lastSeenAt: null,
    name: "Test Mac",
    platform: "darwin",
    runnerId: createId("runner"),
    shares: [],
    ...overrides,
  };
}
function fixture(machines: ReachableMachineRecord[]) {
  const create = vi.fn(
    async (
      input: Parameters<
        ConstructorParameters<typeof MachineFullDiskAccessService>[0]["store"]["requests"]["create"]
      >[0],
    ) => ({
      events: [],
      replayed: false,
      request: PendingRequestSchema.parse({
        ...input,
        id: createId("request"),
        createdAt: new Date().toISOString(),
        status: "pending",
        cancellationReason: null,
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        originatingOccurrenceId: null,
      }),
    }),
  );
  const listReachableMachines = vi.fn(async () => machines);
  const service = new MachineFullDiskAccessService({
    store: {
      listReachableMachines,
      requests: {
        create,
        declineMachineFullDiskAccessRequest: vi.fn(),
        fulfillMachineFullDiskAccessRequests: vi.fn(),
      },
    },
    onWorkspaceEvent: vi.fn(),
    continuations: { notify: vi.fn() },
  });
  return { service, create, listReachableMachines };
}

describe("Machine macOS Full Disk Access requests", () => {
  it.each([
    { machines: [], message: "No reachable computer is called test-mac." },
    {
      machines: [machine({ platform: "linux", fullDiskAccess: null })],
      message: "Test Mac is not a Mac, so macOS Full Disk Access does not apply.",
    },
    {
      machines: [machine({ fullDiskAccess: true })],
      message: "Test Mac already has macOS Full Disk Access.",
    },
  ])("refuses unavailable requests: $message", async ({ machines, message }) => {
    const { service, create } = fixture(machines);
    await expect(
      service.request({ callId: "call", computer: "test-mac", reason: "Read Mail", claims }),
    ).rejects.toMatchObject({ code: "bad_request", message });
    expect(create).not.toHaveBeenCalled();
  });
});
