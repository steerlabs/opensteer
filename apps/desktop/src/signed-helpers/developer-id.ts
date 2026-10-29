import { signingTeamId } from "./signing-build.js";

export const opensteerAppleTeamId = signingTeamId ?? "";

/**
 * The code requirement a release helper must satisfy before this app installs,
 * replaces or launches it.
 *
 * It is checked by `codesign -R`, which validates the certificate chain up to
 * Apple, rather than read off `codesign -dv`: a self-signed certificate can
 * carry any authority name and any team in its subject, and `--verify` alone
 * accepts it. The Developer ID markers admit only Developer ID-signed builds,
 * as the helper's own peer requirement does.
 */
export function opensteerDeveloperIdRequirement(teamId: string, identifier: string): string {
  return (
    `anchor apple generic ` +
    `and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ ` +
    `and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ ` +
    `and certificate leaf[subject.OU] = "${teamId}" ` +
    `and identifier "${identifier}"`
  );
}
