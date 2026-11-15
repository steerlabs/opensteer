import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { createTeamPartnerOfferVault } from "./offer-vault.js";

it("seals offers across vault instances and binds ciphertext to team, link and secret", async () => {
  const teamId = createId("deployment");
  const vault = createTeamPartnerOfferVault("secret", teamId);
  const offer = {
    teamId,
    origin: "https://partner.example",
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    selector: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    verifier: "V".repeat(43),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const sealed = await vault.seal("link", offer);
  expect(sealed.toString()).not.toContain(offer.verifier);
  expect(await createTeamPartnerOfferVault("secret", teamId).open("link", sealed)).toEqual(offer);
  await expect(vault.open("other-link", sealed)).rejects.toThrow();
  await expect(
    createTeamPartnerOfferVault("secret", createId("deployment")).open("link", sealed),
  ).rejects.toThrow();
  await expect(
    createTeamPartnerOfferVault("other-secret", teamId).open("link", sealed),
  ).rejects.toThrow();
});
