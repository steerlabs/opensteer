import { expect, it } from "vitest";
import { releaseSmokeCryptography } from "./release-smoke-cryptography.js";

it("seals temporary credentials for one smoke process and rejects tampering", async () => {
  const cryptography = releaseSmokeCryptography();
  const sealed = await cryptography.encryptStringAsync("temporary credential");
  expect(sealed.includes(Buffer.from("temporary credential"))).toBe(false);
  await expect(cryptography.decryptStringAsync(sealed)).resolves.toEqual({
    result: "temporary credential",
    shouldReEncrypt: false,
  });
  await expect(releaseSmokeCryptography().decryptStringAsync(sealed)).rejects.toThrow();
  sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
  await expect(cryptography.decryptStringAsync(sealed)).rejects.toThrow();
});
