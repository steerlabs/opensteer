import { randomBytes } from "node:crypto";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  AesGcmCredentialVault,
  AesGcmSecretVault,
  createCredentialResponseRedactor,
  HostEgressGateway,
  StaticEncryptionKeyProvider,
} from "./index.js";
import { isPublicIp } from "./public-network.js";

describe("credential vault", () => {
  it("binds ciphertext to credential identity and detects tampering", async () => {
    const vault = new AesGcmCredentialVault(
      new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
    );
    const context = {
      credentialId: createId("credential"),
      ownerId: createId("user"),
      provider: "github",
    };
    const sealed = await vault.seal({ token: "real-secret" }, context);
    await expect(vault.open(sealed.envelope, context)).resolves.toEqual({ token: "real-secret" });
    await expect(
      vault.open(sealed.envelope, { ...context, credentialId: createId("credential") }),
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("round-trips secret fields with prototype-like names as own data", async () => {
    const vault = new AesGcmCredentialVault(
      new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
    );
    const context = {
      credentialId: createId("credential"),
      ownerId: createId("user"),
      provider: "custom",
    };
    const secrets = JSON.parse('{"__proto__":"safe","constructor":"also-safe"}') as Record<
      string,
      string
    >;
    const opened = await vault.open((await vault.seal(secrets, context)).envelope, context);
    expect(Object.hasOwn(opened, "__proto__")).toBe(true);
    expect(opened.__proto__).toBe("safe");
    expect(opened.constructor).toBe("also-safe");
  });
});

describe("generic Host secret vault", () => {
  it("binds ciphertext to record, scope, and purpose", async () => {
    const vault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
    );
    const context = {
      binding: "google",
      purpose: "provider-application",
      recordId: "ipa_example",
      scope: "instance",
    };
    const sealed = await vault.seal({ clientSecret: "secret" }, context);
    await expect(vault.open(sealed.envelope, context)).resolves.toEqual({
      clientSecret: "secret",
    });
    await expect(
      vault.open(sealed.envelope, { ...context, purpose: "provider-connection" }),
    ).rejects.toThrow("Secret could not be decrypted");
    await expect(vault.open(sealed.envelope, { ...context, binding: "github" })).rejects.toThrow(
      "Secret could not be decrypted",
    );
  });
});

describe("credential response redactor", () => {
  it("scrubs raw and encoded credential representations", () => {
    const secret = "secret with spaces";
    const redactor = createCredentialResponseRedactor([secret]);
    const reflected = `${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString("base64")}`;
    const output = redactor.redactText(reflected);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
    expect(output).not.toContain(Buffer.from(secret).toString("base64"));
  });
});

describe("Host egress gateway", () => {
  it("blocks loopback and private-network SSRF targets", async () => {
    const gateway = new HostEgressGateway();
    await expect(
      gateway.forward({
        bodyBase64: "",
        headers: {},
        method: "GET",
        url: "http://127.0.0.1/latest/meta-data",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("never forwards a legacy credential handle", async () => {
    const gateway = new HostEgressGateway();
    await expect(
      gateway.forward({
        bodyBase64: "",
        headers: { authorization: "Bearer os_secret_abcdefghijklmnopqrstuv" },
        method: "GET",
        url: "https://example.com/",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects ambiguous base64 and tunnel methods before opening a connection", async () => {
    const gateway = new HostEgressGateway();
    await expect(
      gateway.forward({
        bodyBase64: "not base64",
        headers: {},
        method: "POST",
        url: "https://example.com",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      gateway.forward({
        bodyBase64: "",
        headers: {},
        method: "CONNECT",
        url: "https://example.com",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("public egress address policy", () => {
  it("rejects private, documentation, and address-transition ranges", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIp("2001:db8::1")).toBe(false);
    expect(isPublicIp("2002:7f00:1::")).toBe(false);
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
  });
});
