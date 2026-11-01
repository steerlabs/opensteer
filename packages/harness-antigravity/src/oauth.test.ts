import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  forwardAntigravityCallback,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
} from "./oauth.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Antigravity browser OAuth", () => {
  it("accepts only Google's one-state loopback authorization URL", () => {
    const authorization = parseAntigravityAuthorizationUrl(
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=state-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123%2F",
    );
    expect(authorization).toMatchObject({
      redirectUri: "http://127.0.0.1:8123/",
      state: "state-1",
    });
    expect(() =>
      parseAntigravityAuthorizationUrl(
        "https://evil.example/o/oauth2/v2/auth?response_type=code&state=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123%2F",
      ),
    ).toThrow("invalid Google sign-in URL");
    expect(() =>
      parseAntigravityAuthorizationUrl(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=x&state=y&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123%2F",
      ),
    ).toThrow("invalid Google sign-in URL");
  });

  it("binds a pasted callback to its exact origin, path, state, and one result", () => {
    const pending = { redirectUri: "http://127.0.0.1:8123/", state: "state-1" };
    expect(
      validateAntigravityCallbackUrl(
        pending,
        "http://127.0.0.1:8123/?code=one&state=state-1&iss=https%3A%2F%2Faccounts.google.com",
      ).searchParams.get("code"),
    ).toBe("one");
    for (const invalid of [
      "http://127.0.0.1:8124/?code=one&state=state-1",
      "http://127.0.0.1:8123/?code=one&state=other",
      "http://127.0.0.1:8123/?code=one&code=two&state=state-1",
      "http://127.0.0.1:8123/?code=one&error=denied&state=state-1",
      "http://127.0.0.1:8123/?code=one&state=state-1&iss=https%3A%2F%2Fevil.example",
    ]) {
      expect(() => validateAntigravityCallbackUrl(pending, invalid)).toThrow();
    }
  });

  it("forwards one direct loopback GET", async () => {
    let received = "";
    const server = createServer((request, response) => {
      received = request.url ?? "";
      response.writeHead(204).end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");

    await forwardAntigravityCallback(
      new URL(`http://127.0.0.1:${address.port}/?code=secret-code&state=state-1`),
    );
    expect(received).toBe("/?code=secret-code&state=state-1");
  });
});
