import { createHash } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import type { DeploymentId } from "@opensteer/core";
import type { TeamInviteVerifierVault } from "@opensteer/database/team-invites";
import { z } from "zod";

const SealedVerifierSchema = z.strictObject({ verifier: z.string().min(24).max(128) });

/** Keyed from the team Host's auth secret, so any replica can show a manager the same link. */
export function createTeamInviteVerifierVault(
  authSecret: string,
  teamId: DeploymentId,
): TeamInviteVerifierVault {
  const vault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(
      new Map([[1, createHash("sha256").update("team-invite-v1\0").update(authSecret).digest()]]),
      1,
    ),
  );
  const context = (inviteId: string) => ({
    purpose: "team-invite-verifier",
    recordId: inviteId,
    scope: teamId,
  });
  return {
    seal: async (inviteId, verifier) =>
      (await vault.seal({ verifier }, context(inviteId))).envelope,
    open: async (inviteId, sealed) =>
      SealedVerifierSchema.parse(await vault.open(sealed, context(inviteId))).verifier,
  };
}
