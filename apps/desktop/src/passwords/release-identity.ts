import { developmentTrust } from "../signed-helpers/signing-build.js";
import {
  opensteerAppleTeamId,
  opensteerDeveloperIdRequirement,
} from "../signed-helpers/developer-id.js";
import { passwordsBrokerBundleId } from "./paths.js";

/**
 * The code requirement the broker of this build must satisfy before it is
 * installed or launched: Opensteer's Developer ID and the build's own bundle
 * id, so a release desktop never accepts the development broker even when
 * both are signed by the same team.
 */
export function passwordsBrokerRequirement(development: boolean, teamId: string): string {
  return opensteerDeveloperIdRequirement(teamId, passwordsBrokerBundleId(development));
}

/**
 * A development desktop has no team to compare and accepts an ad-hoc broker;
 * a packaged one never does.
 */
export function desktopPasswordsTeamId(development: boolean): string | null {
  return developmentTrust && development ? null : opensteerAppleTeamId;
}
