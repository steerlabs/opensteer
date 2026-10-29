import { developmentTrust } from "../signed-helpers/signing-build.js";
import {
  opensteerAppleTeamId,
  opensteerDeveloperIdRequirement,
} from "../signed-helpers/developer-id.js";

export function computerUseHelperRequirement(teamId: string): string {
  return opensteerDeveloperIdRequirement(teamId, "com.opensteer.computer-use");
}

/**
 * A development build has no team to compare, so it says so with null: the
 * helper client then checks the bundle identifier alone and logs that it did.
 * A packaged build never gets that fallback.
 */
export function desktopComputerUseTeamId(packaged: boolean): string | null {
  return developmentTrust && !packaged ? null : opensteerAppleTeamId;
}
