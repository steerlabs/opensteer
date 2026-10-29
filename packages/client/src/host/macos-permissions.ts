/** Shared presentation for the macOS Full Disk Access grant. */

/** The action that opens the permission review on the Mac that needs it. */
export const fullAccessButtonLabel = "Review macOS permission";

/** The quiet way out of every surface that offers the permission. */
export const fullAccessDeclineLabel = "Not now";

/** The name macOS gives the permission. */
export const fullDiskAccessLabel = "macOS Full Disk Access";

/** The action label used when Opensteer can open the macOS settings pane. */
export const fullDiskAccessSettingsLabel = "Open System Settings";

/** What the operating-system permission gives the Opensteer process. */
export const fullDiskAccessExplanation =
  "Full Disk Access lets Opensteer access protected files on this Mac, beyond any one app integration.";

/** What the operating-system permission does not authorize by itself. */
export const fullDiskAccessBoundary =
  "It does not enable other integrations or remote command access. Separately allowed commands can benefit from this macOS permission.";

/**
 * What macOS currently lets Opensteer reach on one Mac, and — when the
 * permission is off and this is not the Mac in front of the reader — where to
 * complete setup.
 */
export function fullAccessDetail(input: {
  readonly granted: boolean;
  readonly machineName: string;
  readonly onThisDevice: boolean;
}): string {
  if (input.granted) {
    return "Opensteer has macOS permission to access protected files. Agent access still follows your app and computer settings.";
  }
  const denied =
    "macOS Full Disk Access has not been granted. Some protected data may be unavailable.";
  return input.onThisDevice ? denied : `${denied} ${fullAccessElsewhere(input.machineName)}`;
}

/** Where setup has to be completed when the reader is not at that Mac. */
export function fullAccessElsewhere(machineName: string): string {
  return `Complete setup on ${machineName}. Grant Full Disk Access to the app that runs Opensteer on that Mac.`;
}

/**
 * Whether the app reading this is running on that exact Mac. The matching
 * lent computer qualifies, as does a Personal Host running on this computer.
 */
export function fullAccessOnThisMac(input: {
  readonly hostsDeployment: boolean;
  readonly hostsDeploymentOnThisComputer: boolean;
  readonly inDesktopApp: boolean;
  readonly lentByThisDesktop: boolean;
}): boolean {
  return (
    input.inDesktopApp &&
    (input.lentByThisDesktop || (input.hostsDeployment && input.hostsDeploymentOnThisComputer))
  );
}

/** Where an agent's Request for the permission has to be answered. */
export function fullAccessRequestBody(machineName: string): string {
  return `Complete setup on ${machineName}. Grant Full Disk Access to the app that runs Opensteer on that Mac.`;
}
