import {
  CloudComputerIdSchema,
  cloudComputerDeleteConfirmation,
  type CloudComputerListResponse,
  type CloudComputerView,
} from "@opensteer/control-plane-protocol";
import type {
  DesktopCloudComputerActInput,
  DesktopCloudComputerActResult,
  DesktopCloudComputerReadResult,
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

function view(status: CloudComputerView["status"]): CloudComputerView {
  const id = mockCloudComputerId;
  switch (status) {
    case "preparing":
      return { id, egress: "pending", status };
    case "ready":
      return { id, egress: "assigned", status, address: mockCloudComputerAddress };
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

export class MockCloudComputerAccount implements CloudComputerAccount {
  readonly scene: MockCloudComputerScene;
  #computers: CloudComputerView[];
  #reads = 0;

  constructor(scene: MockCloudComputerScene = "none") {
    this.scene = scene;
    this.#computers =
      scene === "preparing"
        ? [view("preparing")]
        : scene === "ready" || scene === "refused"
          ? [view("ready")]
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
          message: "Sign in to your Opensteer Account to set up a Cloud Computer.",
        },
      };
    if (this.scene === "unreachable")
      return {
        ok: false,
        failure: {
          kind: "unreachable",
          message: "Opensteer Account isn’t answering. Try again in a moment.",
        },
      };
    if (this.scene === "unavailable")
      return {
        ok: false,
        failure: {
          kind: "unavailable",
          message: "This build of Opensteer has no Opensteer Account.",
        },
      };
    if (this.scene === "checkout") {
      if (this.#reads === 3) this.#computers = [view("preparing")];
      if (this.#reads === 6) this.#computers = [view("ready")];
    }
    return { ok: true, data: { computers: [...this.#computers], plan } };
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
