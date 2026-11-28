import { expect, it } from "vitest";
import {
  credentialNamePattern,
  engineDiagnosticSecrets,
  networkCredentialSecrets,
  redactNetworkCredentials,
  redactUrlCredentials,
  safeMessage,
} from "./safeMessage.js";

it.each([
  ["AUTHORIZATION", true],
  ["COOKIE", true],
  ["TOKEN", true],
  ["SECRET", true],
  ["PASSWORD", true],
  ["PASSWD", true],
  ["API_KEY", true],
  ["APIKEY", true],
  ["ACCESS_KEY", true],
  ["CREDENTIAL", true],
  ["PRIVATE_KEY", true],
  ["PROXY", true],
  ["PATH", false],
  ["HOME", false],
  ["LANG", false],
  ["KEYBOARD", false],
] as const)(
  "matches credential variable name %s in either case when expected",
  (name, expected) => {
    expect(credentialNamePattern.test(name)).toBe(expected);
    expect(credentialNamePattern.test(name.toLowerCase())).toBe(expected);
  },
);

it("removes a proxy address's user and password and keeps the rest", () => {
  const text =
    "connect ECONNREFUSED via http://person:hunter2-proxy-secret@proxy.example.test:8080 and https://token-only@proxy.test/";
  const redacted = redactUrlCredentials(text);
  expect(redacted).not.toContain("hunter2-proxy-secret");
  expect(redacted).not.toContain("person:");
  expect(redacted).not.toContain("token-only");
  expect(redacted).toBe(
    "connect ECONNREFUSED via http://[REDACTED]@proxy.example.test:8080 and https://[REDACTED]@proxy.test/",
  );
  expect(redactUrlCredentials("https://example.test/path?a=b")).toBe(
    "https://example.test/path?a=b",
  );
});

it("stays linear on a long message", () => {
  const message = `HEAD:${"f".repeat(200_000)}:TAIL http://person:fake-proxy-password@proxy.test`;
  const started = performance.now();
  expect(redactUrlCredentials(message)).not.toContain("fake-proxy-password");
  expect(performance.now() - started).toBeLessThan(1_000);
});

it("removes userinfo containing an at sign", () => {
  const redacted = redactUrlCredentials("connect via http://alice:p@ssword@proxy.corp:8080");
  expect(redacted).not.toContain("ssword");
  expect(redacted).not.toContain("p@ss");
  expect(redacted).not.toContain("alice:");
  expect(redacted).toContain("proxy.corp:8080");
});

it("removes userinfo containing a slash when the proxy comes from the environment", () => {
  const secrets = networkCredentialSecrets({
    HTTPS_PROXY: "http://alice:pa/ss-word@proxy.corp:8080",
  });
  const redacted = redactNetworkCredentials(
    "connect failed for http://alice:pa/ss-word@proxy.corp:8080",
    secrets,
  );
  expect(redacted).toBe("connect failed for http://[REDACTED]@proxy.corp:8080");
});

it("removes userinfo from a configured proxy address without a scheme", () => {
  const secrets = networkCredentialSecrets({ http_proxy: "alice:secretpw@proxy.corp:8080" });
  expect(redactNetworkCredentials("tunnel to alice:secretpw@proxy.corp:8080 failed", secrets)).toBe(
    "tunnel to [REDACTED]@proxy.corp:8080 failed",
  );
});

it("removes both encoded and decoded proxy passwords", () => {
  const secrets = networkCredentialSecrets({
    HTTPS_PROXY: "http://alice:p%40ss-word@proxy.corp:8080",
  });
  expect(redactNetworkCredentials("bad password p%40ss-word", secrets)).toBe(
    "bad password [REDACTED]",
  );
  expect(redactNetworkCredentials("bad password p@ss-word", secrets)).toBe(
    "bad password [REDACTED]",
  );
});

it("removes every occurrence of a proxy password on its own", () => {
  const secrets = networkCredentialSecrets({
    HTTPS_PROXY: "http://alice:Zx9-fake-pw@proxy.corp:8080",
  });
  expect(
    redactNetworkCredentials("auth failed: bad password Zx9-fake-pw (Zx9-fake-pw)", secrets),
  ).toBe("auth failed: bad password [REDACTED] ([REDACTED])");
});

it("keeps a short password in plain text and removes it from a URL", () => {
  const secrets = networkCredentialSecrets({ HTTP_PROXY: "http://user:abc@proxy.corp" });
  expect(redactNetworkCredentials("abc http://user:abc@proxy.corp", secrets)).toBe(
    "abc http://[REDACTED]@proxy.corp",
  );
});

it("keeps a proxy username on its own and masks it inside an address", () => {
  const proxy = "http://alice@proxy.corp:8080";
  const secrets = networkCredentialSecrets({ HTTPS_PROXY: proxy });
  expect(redactNetworkCredentials("user alice signed in", secrets)).toBe("user alice signed in");
  expect(redactNetworkCredentials(proxy, secrets)).toBe("http://[REDACTED]@proxy.corp:8080");
});

it("applies the password length floor to the percent-decoded form", () => {
  const secrets = networkCredentialSecrets({
    HTTPS_PROXY: "http://u:ab%40@proxy",
    HTTP_PROXY: "http://u:%40%40%40%40@proxy",
  });
  expect(redactNetworkCredentials("ab@ ab%40 @@@@", secrets)).toBe("ab@ [REDACTED] [REDACTED]");
  expect(redactNetworkCredentials("u:ab@ u:ab%40", secrets)).toBe("[REDACTED] [REDACTED]");
});

it("redacts multiple addresses with an uppercase scheme and an IPv6 host", () => {
  expect(
    redactUrlCredentials(
      "HTTP://alice:Zx9-fake-pw@proxy.corp and http://alice:Zx9-fake-pw@[::1]:8080",
    ),
  ).toBe("HTTP://[REDACTED]@proxy.corp and http://[REDACTED]@[::1]:8080");
});

it("keeps path mentions, mailto addresses and ordinary text", () => {
  const message = "https://example.com/users/@me mailto:someone@example.com no address";
  expect(redactUrlCredentials(message)).toBe(message);
});

it.each(["a", "a:"])("stays linear on a long string of %s repetitions", (part) => {
  const message = part.repeat(200_000 / part.length);
  const started = performance.now();
  expect(redactUrlCredentials(message)).toBe(message);
  expect(performance.now() - started).toBeLessThan(500);
});

it("ignores empty environments and bypass lists", () => {
  expect(networkCredentialSecrets({})).toEqual([]);
  expect(networkCredentialSecrets({ NO_PROXY: "user:pass@x", no_proxy: "user:pass@y" })).toEqual(
    [],
  );
});

it("returns distinct credentials longest first and keeps malformed escapes literal", () => {
  const proxy = "HTTP://alice:p%XX-word@proxy.corp:8080";
  expect(networkCredentialSecrets({ ALL_PROXY: proxy, all_proxy: proxy })).toEqual([
    "alice:p%XX-word",
    "p%XX-word",
  ]);
});

it("redacts safe messages before truncating", () => {
  const secrets = networkCredentialSecrets({ HTTPS_PROXY: "http://alice:pa/ss-word@proxy" });
  expect(
    safeMessage(new Error("via http://alice:pa/ss-word@proxy"), {
      fallback: "x",
      maximumLength: 25,
      secrets,
    }),
  ).toBe("via http://[REDACTED]@pro");
});

it("keeps proxy endpoints visible while scrubbing proxy passwords and other PROXY-named secrets", () => {
  const plainSecrets = engineDiagnosticSecrets({
    HTTPS_PROXY: "http://proxy.corp:8080",
    https_proxy: "http://proxy2.corp:8080",
    HTTP_PROXY: "http://proxy3.corp:8080",
    http_proxy: "http://proxy4.corp:8080",
    ALL_PROXY: "socks5://proxy5.corp:1080",
    all_proxy: "socks5://proxy6.corp:1080",
    PROXY_PASSWORD: "top-secret-proxy-password",
  });
  expect(
    redactNetworkCredentials(
      "connect to http://proxy.corp:8080 failed (auth top-secret-proxy-password)",
      plainSecrets,
    ),
  ).toBe("connect to http://proxy.corp:8080 failed (auth [REDACTED])");

  const withAuthSecrets = engineDiagnosticSecrets({
    HTTPS_PROXY: "http://alice:secret-pw@proxy.corp:8080",
  });
  expect(
    redactNetworkCredentials(
      "connect to http://alice:secret-pw@proxy.corp:8080 failed; secret-pw",
      withAuthSecrets,
    ),
  ).toBe("connect to http://[REDACTED]@proxy.corp:8080 failed; [REDACTED]");
});

it("accepts a custom minimum value length for named credentials", () => {
  const env = { API_TOKEN: "t0k3n" };
  expect(engineDiagnosticSecrets(env)).toEqual([]);
  expect(engineDiagnosticSecrets(env, 4)).toEqual(["t0k3n"]);
});

it("never treats network bypass lists or proxy host settings as secrets (Y4)", () => {
  const env = {
    NO_PROXY: "*",
    no_proxy: "localhost",
    PROXY_HOST: "proxy.corp",
    HTTP_PROXY: "http://proxy.corp:8080",
  };
  expect(engineDiagnosticSecrets(env, 4)).toEqual([]);
  expect(
    redactNetworkCredentials("could not connect to localhost", engineDiagnosticSecrets(env, 4)),
  ).toBe("could not connect to localhost");
});
