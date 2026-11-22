import { describe, expect, it } from "vitest";
import { DeploymentAccessSnapshotSchema, desktopExternalUrlAllowed } from "./desktop.js";

const snapshot = (portalOrigin: string) => ({
  account: { available: true, portalOrigin, status: "signed-in" },
  deployments: [],
  personalAccountLink: {
    account: null,
    deploymentId: null,
    displayName: null,
    status: "unavailable",
    unlinkStep: null,
  },
  personalSetup: null,
  revision: 1,
  selectedDeploymentId: null,
  unavailable: [],
});

describe("the Opensteer website the Mac opens for checkout", () => {
  it("enters the snapshot only as a bare https origin, or loopback http in development", () => {
    for (const origin of ["https://app.opensteer.com", "http://127.0.0.1:4310"])
      expect(DeploymentAccessSnapshotSchema.safeParse(snapshot(origin)).success, origin).toBe(true);
    for (const origin of [
      "https://app.opensteer.com/cloud-computer",
      "https://app.opensteer.com/?next=x",
      "https://user:secret@app.opensteer.com",
      "http://app.opensteer.com",
      "javascript:alert(1)",
    ])
      expect(DeploymentAccessSnapshotSchema.safeParse(snapshot(origin)).success, origin).toBe(
        false,
      );
  });

  it("opens a development website's checkout on loopback, and nothing else there", () => {
    expect(desktopExternalUrlAllowed("http://127.0.0.1:4310/cloud-computer/checkout")).toBe(true);
    expect(desktopExternalUrlAllowed("http://127.0.0.1:4310/cloud-computer/checkout?x=1")).toBe(
      false,
    );
    expect(desktopExternalUrlAllowed("http://127.0.0.1:4310/cloud-computer/billing")).toBe(false);
    expect(desktopExternalUrlAllowed("http://app.opensteer.com/cloud-computer/checkout")).toBe(
      false,
    );
  });
});
