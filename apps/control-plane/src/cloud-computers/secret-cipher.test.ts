import { describe, expect, it } from "vitest";
import { CloudComputerSecretCipher } from "./secret-cipher.js";

// Sealed by this cipher under its previous name (`HostedTeamSetupTokenCipher`, in
// `hosted-teams/setup-token-cipher.ts`) at 36f84ac1d: every value stored before the move opens.
const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const sealedBeforeTheMove =
  "hts1.giCeLXRoylve9qAm.9gFZVsjYXcND50cj-BrN_7vwrGprAfuLlkoGvEN29-UazyQ.ywer-Iuv_BqY62q_Srk-dA";

describe("CloudComputerSecretCipher", () => {
  it("opens a value sealed before it moved", () => {
    const cipher = new CloudComputerSecretCipher(key);
    expect(cipher.open("cloud-computer-boot:0f3c", 3, sealedBeforeTheMove)).toBe(
      "a boot token sealed before the move",
    );
  });

  it("refuses the same value under another context or generation", () => {
    const cipher = new CloudComputerSecretCipher(key);
    expect(() => cipher.open("cloud-computer-boot:0f3d", 3, sealedBeforeTheMove)).toThrow();
    expect(() => cipher.open("cloud-computer-boot:0f3c", 4, sealedBeforeTheMove)).toThrow();
  });

  it("seals with the prefix every stored value carries", () => {
    const cipher = new CloudComputerSecretCipher(key);
    const sealed = cipher.seal("egress:1", 1, "password");
    expect(sealed.startsWith("hts1.")).toBe(true);
    expect(cipher.open("egress:1", 1, sealed)).toBe("password");
  });
});
