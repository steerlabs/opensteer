import { describe, expect, it } from "vitest";
import { fullAccessOnThisMac } from "./macos-permissions.js";

describe("macOS permission presentation", () => {
  it("offers local controls only in the matching desktop app", () => {
    expect(
      fullAccessOnThisMac({
        hostsDeployment: false,
        hostsDeploymentOnThisComputer: false,
        inDesktopApp: true,
        lentByThisDesktop: true,
      }),
    ).toBe(true);
    expect(
      fullAccessOnThisMac({
        hostsDeployment: true,
        hostsDeploymentOnThisComputer: true,
        inDesktopApp: true,
        lentByThisDesktop: false,
      }),
    ).toBe(true);

    for (const input of [
      // A browser on the Mac is not the desktop app that can open the pane.
      {
        hostsDeployment: true,
        hostsDeploymentOnThisComputer: true,
        inDesktopApp: false,
        lentByThisDesktop: true,
      },
      // A phone viewing that Mac likewise has no local permission control.
      {
        hostsDeployment: false,
        hostsDeploymentOnThisComputer: false,
        inDesktopApp: false,
        lentByThisDesktop: false,
      },
      // Another desktop cannot operate this Mac's permission.
      {
        hostsDeployment: false,
        hostsDeploymentOnThisComputer: false,
        inDesktopApp: true,
        lentByThisDesktop: false,
      },
      // Hosting a deployment elsewhere is not a machine-local proof.
      {
        hostsDeployment: true,
        hostsDeploymentOnThisComputer: false,
        inDesktopApp: true,
        lentByThisDesktop: false,
      },
    ]) {
      expect(fullAccessOnThisMac(input)).toBe(false);
    }
  });
});
