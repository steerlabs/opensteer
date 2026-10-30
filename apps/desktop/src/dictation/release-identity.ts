import { developmentTrust } from "../signed-helpers/signing-build.js";
import {
  opensteerAppleTeamId,
  opensteerDeveloperIdRequirement,
} from "../signed-helpers/developer-id.js";
import { dictationBrokerBundleId } from "./paths.js";

export function dictationBrokerRequirement(development: boolean, teamId: string): string {
  return opensteerDeveloperIdRequirement(teamId, dictationBrokerBundleId(development));
}

export function desktopDictationTeamId(development: boolean): string | null {
  return developmentTrust && development ? null : opensteerAppleTeamId;
}
