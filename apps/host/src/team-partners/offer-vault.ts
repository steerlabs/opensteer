import { createHash } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import type { DeploymentId } from "@opensteer/core";
import {
  parseTeamPartnerOffer,
  serializeTeamPartnerOffer,
  type TeamPartnerOffer,
} from "@opensteer/protocol";
import { z } from "zod";

export interface TeamPartnerOfferVault {
  seal(id: string, offer: TeamPartnerOffer): Promise<Buffer>;
  open(id: string, sealed: Buffer): Promise<TeamPartnerOffer>;
}

export function createTeamPartnerOfferVault(
  authSecret: string,
  teamId: DeploymentId,
): TeamPartnerOfferVault {
  const vault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(
      new Map([
        [1, createHash("sha256").update("team-partner-offer-v1\0").update(authSecret).digest()],
      ]),
      1,
    ),
  );
  const context = (id: string) => ({ purpose: "team-partner-offer", recordId: id, scope: teamId });
  return {
    seal: async (id, offer) =>
      (await vault.seal({ offer: serializeTeamPartnerOffer(offer) }, context(id))).envelope,
    open: async (id, sealed) =>
      parseTeamPartnerOffer(
        z.object({ offer: z.string() }).parse(await vault.open(sealed, context(id))).offer,
      ),
  };
}
