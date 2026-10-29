import { readSigningMode } from "../../scripts/signing-input.cjs";

// Raw test/dev consumers have no generated-file prerequisite. Distributable
// bundlers replace this module with immutable values from the current input.
const mode = readSigningMode();
export const signingTeamId: string | null = mode.mode === "signed" ? mode.signing.teamId : null;
export const developmentTrust = mode.mode === "development";
