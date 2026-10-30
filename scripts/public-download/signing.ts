import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { journeyMetadata } from "./evidence.js";
const { readSigningMode } = createRequire(import.meta.url)(
  "../../apps/desktop/scripts/signing-input.cjs",
) as typeof import("../../apps/desktop/scripts/signing-input.cjs");
export function journeySigning() {
  process.env.OPENSTEER_DESKTOP_SIGNING_FILE ??= path.join(
    homedir(),
    ".config/opensteer/desktop-signing.json",
  );
  const mode = readSigningMode({ ...process.env, OPENSTEER_DESKTOP_RELEASE: "1" });
  if (mode.mode !== "signed" || !mode.signing.notarizationProfile)
    throw Error("Signed journey requires signing-input.cjs configuration with notarizationProfile");
  return {
    ...mode.signing,
    notarizationProfile: mode.signing.notarizationProfile,
    metadata: journeyMetadata.parse({ expectedTeamId: mode.signing.teamId }),
  };
}
