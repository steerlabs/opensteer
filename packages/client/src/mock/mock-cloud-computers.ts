import {
  CloudComputerIdSchema,
  OrganizationIdSchema,
  WorkAssignmentIdSchema,
  cloudComputerDeleteConfirmation,
  defaultWorkPolicy,
  type CloudComputerListResponse,
  type CloudComputerView,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import type {
  DesktopCloudComputerActInput,
  DesktopCloudComputerActResult,
  DesktopCloudComputerReadResult,
  DesktopWorkHome,
} from "@opensteer/protocol/desktop";
import type { CloudComputerAccount } from "../connections/account-cloud-computers.js";

/**
 * Cloud Computer states a preview opens on (`?mock-cloud=` on web,
 * `EXPO_PUBLIC_OPENSTEER_MOCK_CLOUD` on the phone). `checkout` starts with none and,
 * as the app reads again after checkout, prepares and then becomes ready.
 */
export const mockCloudComputerScenes = [
  "none",
  "checkout",
  "preparing",
  "ready",
  "attention",
  "suspended",
  "refused",
  "signed-out",
  "unreachable",
  "unavailable",
  /** A work Home an organization assigned, and no personal Cloud Computer. */
  "work",
  /** A personal Cloud Computer and a work Home. */
  "both",
] as const;
export type MockCloudComputerScene = (typeof mockCloudComputerScenes)[number];

export const mockCloudComputerId = CloudComputerIdSchema.parse(
  "cc_00000000-0000-4000-8000-0000000000c1",
);
export const mockCloudComputerAddress = "https://k7q2.cloud.opensteer.example";
const plan: CloudComputerListResponse["plan"] = {
  name: "Opensteer Cloud Computer",
  currency: "usd",
  amountMinor: 2000,
  interval: "month",
};

export const mockWorkComputerId = CloudComputerIdSchema.parse(
  "cc_00000000-0000-4000-8000-0000000000c2",
);
export const mockWorkAddress = "https://w3r8.cloud.opensteer.example";
export const mockOrganizationName = "Acme Robotics";
/** The Home the mock's ready Cloud Computer is, as the Account pins it. */
export const mockCloudComputerDeploymentId = DeploymentIdSchema.parse(
  "dep_00000000-0000-4000-8000-0000000000c1",
);
const region = { id: "ash", label: "Ashburn, Virginia" } as const;

function view(
  status: CloudComputerView["status"],
  deploymentId: string = mockCloudComputerDeploymentId,
): CloudComputerView {
  const id = mockCloudComputerId;
  switch (status) {
    case "preparing":
      return {
        id,
        egress: "pending",
        status,
        region,
        steps: [
          { id: "payment", state: "done" },
          { id: "machine", state: "current" },
          { id: "opensteer", state: "pending" },
          { id: "claim", state: "pending" },
        ],
      };
    case "ready":
      return {
        id,
        egress: "assigned",
        status,
        address: mockCloudComputerAddress,
        deploymentId: DeploymentIdSchema.parse(deploymentId),
        region,
        egressAddress: "203.0.113.24",
        renewsAt: "2026-12-20T00:00:00.000Z",
      };
    case "needs_attention":
      return {
        id,
        egress: "unavailable",
        status,
        reason: "The computer didn’t start in time. Opensteer is trying again.",
      };
    case "suspended":
      return { id, egress: "assigned", status, reason: "Suspended by you." };
    case "deleted":
      return { id, egress: "unavailable", status };
  }
}

/** A ready work Home for `organizationName`, as the Account shows its assignee. */
export function mockWorkHome(deploymentId: string | null = null): DesktopWorkHome {
  const organizationId = OrganizationIdSchema.parse("org_00000000-0000-4000-8000-0000000000a1");
  const assignmentId = WorkAssignmentIdSchema.parse("was_00000000-0000-4000-8000-0000000000a1");
  return {
    home: {
      assignment: {
        organizationId,
        organizationName: mockOrganizationName,
        assignmentId,
        computerId: mockWorkComputerId,
        state: "active",
        homeStatus: "ready",
        reason: null,
        address: mockWorkAddress,
        policyRevision: 3,
        appliedRevision: 3,
        policyStatus: "Applied",
        signInCut: false,
        suspended: false,
        deleted: false,
        retainUntil: null,
      },
      policy: { ...defaultWorkPolicy, allowTasks: true },
    },
    computer: {
      id: mockWorkComputerId,
      egress: "assigned",
      status: "ready",
      address: mockWorkAddress,
      region,
      ...(deploymentId ? { deploymentId: DeploymentIdSchema.parse(deploymentId) } : {}),
    },
  };
}

export class MockCloudComputerAccount implements CloudComputerAccount {
  readonly scene: MockCloudComputerScene;
  readonly #workDeploymentId: string | null;
  #computers: CloudComputerView[];
  #reads = 0;

  /**
   * `workDeploymentId`: the listed Home the mock work Home is, so its badge shows.
   * `homeDeploymentId`: the listed Home the personal Cloud Computer is, when it is one.
   */
  constructor(
    scene: MockCloudComputerScene = "none",
    workDeploymentId: string | null = null,
    homeDeploymentId: string | null = null,
  ) {
    this.scene = scene;
    this.#workDeploymentId = workDeploymentId;
    this.#computers =
      scene === "preparing"
        ? [view("preparing")]
        : scene === "ready" || scene === "refused" || scene === "both"
          ? [view("ready", homeDeploymentId ?? mockCloudComputerDeploymentId)]
          : scene === "attention"
            ? [view("needs_attention")]
            : scene === "suspended"
              ? [view("suspended")]
              : [];
  }

  async read(): Promise<DesktopCloudComputerReadResult> {
    this.#reads++;
    if (this.scene === "signed-out")
      return {
        ok: false,
        failure: {
          kind: "signed-out",
          message: "Sign in to your Opensteer account to set up a Cloud Computer.",
        },
      };
    if (this.scene === "unreachable")
      return {
        ok: false,
        failure: {
          kind: "unreachable",
          message: "We couldn’t reach Opensteer. Try again in a moment.",
        },
      };
    if (this.scene === "unavailable")
      return {
        ok: false,
        failure: {
          kind: "unavailable",
          message: "Sign-in isn’t available in this version of Opensteer.",
        },
      };
    if (this.scene === "checkout") {
      if (this.#reads === 3) this.#computers = [view("preparing")];
      if (this.#reads === 6) this.#computers = [view("ready")];
    }
    const work =
      this.scene === "work" || this.scene === "both" ? [mockWorkHome(this.#workDeploymentId)] : [];
    return { ok: true, data: { computers: [...this.#computers], plan }, work };
  }

  async act(input: DesktopCloudComputerActInput): Promise<DesktopCloudComputerActResult> {
    const current = this.#computers.find((computer) => computer.id === input.id);
    if (!current || current.status === "deleted")
      return {
        ok: false,
        failure: { kind: "refused", message: "That Cloud Computer isn’t yours." },
      };
    if (this.scene === "refused")
      return {
        ok: false,
        failure: {
          kind: "refused",
          message: "Cloud Computers can’t be changed right now. Try again later.",
        },
      };
    if (
      input.action === "delete" &&
      input.confirmation !== cloudComputerDeleteConfirmation(input.id)
    )
      return {
        ok: false,
        failure: { kind: "refused", message: "Confirm deletion of this Cloud Computer" },
      };
    const next =
      input.action === "suspend"
        ? view("suspended")
        : input.action === "resume"
          ? view("ready")
          : view("deleted");
    this.#computers = this.#computers.map((computer) =>
      computer.id === input.id ? next : computer,
    );
    return { ok: true, data: next };
  }
}
