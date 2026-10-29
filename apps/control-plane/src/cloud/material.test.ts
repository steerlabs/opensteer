import { describe, expect, it } from "vitest";
import { CloudMaterialCipher } from "./material.js";

describe("cloud credential encryption", () => {
  it("binds ciphertext to its operation and rejects alteration or another key", () => {
    const cipher = new CloudMaterialCipher(Buffer.alloc(32, 1).toString("base64url"));
    const sealed = cipher.seal("one", { secret: "do not disclose" });
    expect(sealed).not.toContain("do not disclose");
    expect(cipher.open("one", sealed)).toEqual({ secret: "do not disclose" });
    expect(() => cipher.open("two", sealed)).toThrow();
    expect(() =>
      new CloudMaterialCipher(Buffer.alloc(32, 2).toString("base64url")).open("one", sealed),
    ).toThrow();
    const tagStart = sealed.lastIndexOf(".") + 1;
    const changedCharacter = sealed[tagStart] === "A" ? "B" : "A";
    const altered = `${sealed.slice(0, tagStart)}${changedCharacter}${sealed.slice(tagStart + 1)}`;
    expect(() => cipher.open("one", altered)).toThrow();
    expect(() => new CloudMaterialCipher("bad key")).toThrow();
  });
});
