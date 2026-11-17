import { gatherComputerAccess } from "./computer-access.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
import { describe, expect, it } from "vitest";
import {
  computerAppDiscovery,
  phoneDiscovery,
  type PhoneDiscoveryFacts,
} from "./computer-use-discovery.js";

const phone: PhoneDiscoveryFacts = {
  phone: { name: "Pixel", state: "ready", computerId: "rnr_pixel" },
  connection: { access: "read-write" },
  callable: false,
  canAct: false,
  pendingPhoneAccess: false,
  pendingPersonalGrant: false,
  heldByAnotherRun: false,
};
describe("computer access", () => {
  it("ignores this Run's holding and reports a different Run's holding", async () => {
    const run = { runId: "run_this" } as Parameters<
      IntegrationPlatformService["computerAccess"]
    >[1];
    let holdingRun = "run_this";
    const platform = {
      computerAppApprovals: {
        computerUseInventory: async () => ({
          machines: [],
          phones: [
            {
              runnerId: "rnr_pixel",
              name: "Pixel",
              state: "ready",
              connection: { connectionId: "connection", access: "read-write" },
            },
          ],
        }),
        computerAppHolders: () =>
          new Map([["display:android-phone", { runId: holdingRun, threadTitle: "Calendar" }]]),
      },
      store: {
        listComputerAppSetupRequests: async () => [],
        requests: { listPendingIntegrationAccessRequests: async () => [] },
      },
      listCallableTools: async () => [
        {
          grant: { connectionId: "connection", id: "grant" },
          tool: { name: "observe", id: "observe", schemaDigest: "digest" },
        },
      ],
      computerToolEnabled: () => true,
      computerUseVersion: () => 2,
    } as unknown as IntegrationPlatformService;
    const input = { ownerUserId: "user" } as Parameters<
      IntegrationPlatformService["computerAccess"]
    >[0];
    const own = await gatherComputerAccess(platform, input, run);
    expect(own.phone(own.phones[0]!)).toEqual({ access: "read" });
    holdingRun = "run_other";
    const other = await gatherComputerAccess(platform, input, run);
    expect(other.phone(other.phones[0]!).blocked).toMatchObject({
      code: "in_use",
      message: "Pixel is in use by another task.",
    });
  });
  it("lists pending Mac apps without a bindable connection id and keeps version facts explicit", async () => {
    let version: number | undefined = 2;
    let state = "ready";
    const platform = {
      computerAppApprovals: {
        computerUseInventory: async () => ({
          machines: [{ runnerId: "rnr_mac", name: "Mac", state, appApproval: "ask", apps: [] }],
          phones: [],
        }),
        computerAppHolders: () => new Map(),
      },
      store: {
        listComputerAppSetupRequests: async () => [
          {
            kind: "app",
            definitionId: "macos-app",
            runnerId: "rnr_mac",
            app: { displayName: "Notes", bundleId: "com.apple.Notes" },
            access: "read",
          },
        ],
        requests: { listPendingIntegrationAccessRequests: async () => [] },
      },
      listCallableTools: async () => [],
      computerUseVersion: () => version,
    } as unknown as IntegrationPlatformService;
    const input = { ownerUserId: "user" } as Parameters<
      IntegrationPlatformService["computerAccess"]
    >[0];
    const access = await gatherComputerAccess(platform, input);
    expect(access.appEntries(access.machines[0]!)).toMatchObject([
      { id: null, name: "Notes", blocked: { code: "access_pending" } },
    ]);
    version = undefined;
    const outdated = await gatherComputerAccess(platform, input);
    expect(outdated.machine(outdated.machines[0]!)?.blocked.code).toBe("update_required");
    state = "offline";
    const offline = await gatherComputerAccess(platform, input);
    expect(offline.machine(offline.machines[0]!)?.blocked.code).toBe("computer_offline");
  });
  it("requires a personal grant even when the phone connection exists", () => {
    expect(phoneDiscovery(phone)).toEqual({
      blocked: {
        code: "access_required",
        message: "Pixel needs access for this task.",
        next: 'Request access with app_access_request {computerId:"rnr_pixel", access:"read-write", reason:"<why you need it>"}; the owner can approve from any Opensteer app.',
      },
    });
  });
  it.each([
    [{ pendingPhoneAccess: true, phone: { ...phone.phone, state: "offline" } }, "computer_offline"],
    [{ phone: { ...phone.phone, state: "offline" }, heldByAnotherRun: true }, "computer_offline"],
    [{ callable: true, heldByAnotherRun: true }, "in_use"],
    [{ phone: { ...phone.phone, computerToolEnabled: false } }, "update_required"],
  ])("uses the most specific phone blocker", (overrides, code) => {
    expect(phoneDiscovery({ ...phone, ...overrides }).blocked?.code).toBe(code);
  });
  it("reports usable read access when the task cannot act", () => {
    expect(phoneDiscovery({ ...phone, callable: true, pendingPersonalGrant: true })).toEqual({
      access: "read",
    });
    expect(phoneDiscovery({ ...phone, callable: true, canAct: true })).toEqual({
      access: "read-write",
    });
  });
  it("prioritizes owner blocks and device problems before usable and pending access", () => {
    const facts = {
      app: "Notes",
      computerId: "rnr_mac",
      machine: { name: "Mac", state: "offline", appApproval: "ask" as const },
      approval: { status: "blocked" as const, access: "read" as const },
      callable: true,
      pendingOnMac: true,
      pendingPersonalGrant: false,
      heldByAnotherRun: true,
    };
    expect(computerAppDiscovery(facts).blocked?.code).toBe("blocked_by_owner");
    expect(computerAppDiscovery({ ...facts, approval: null }).blocked?.code).toBe(
      "computer_offline",
    );
    expect(
      computerAppDiscovery({ ...facts, approval: null, pendingOnMac: false }).blocked?.code,
    ).toBe("computer_offline");
    const ready = {
      ...facts,
      approval: null,
      machine: { ...facts.machine, state: "ready" },
      heldByAnotherRun: false,
    };
    expect(computerAppDiscovery(ready)).toEqual({ access: "read" });
    expect(computerAppDiscovery({ ...ready, callable: false }).blocked?.code).toBe(
      "access_pending",
    );
  });
});
