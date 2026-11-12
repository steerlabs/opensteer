import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PasswordsBrokerAccountSchema,
  PasswordsBrokerAccountsSchema,
  PasswordsBrokerSignInReleaseParamsSchema,
  PasswordsBrokerSignInRequestParamsSchema,
  passwordsBrokerMaxFrameBytes,
  PasswordsBrokerMethodSchema,
  PasswordsBrokerReplySchema,
  PasswordsBrokerStatusChangedEventSchema,
  passwordsBrokerProtocolVersion,
  passwordsBrokerRequests,
  passwordsBrokerResults,
} from "./passwords-broker.js";

/**
 * The broker's side of the wire, as the broker itself encodes it.
 *
 * `passwords-wire.json` is written by the Swift package's own test from its
 * real request and result types, so this test is the two ends of the socket
 * agreeing. A shape change on either end fails exactly one of the two.
 */
const fixturePath = path.resolve(
  import.meta.dirname,
  "../../../apps/desktop/native/passwords/Tests/Fixtures/passwords-wire.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  readonly error: unknown;
  readonly event: unknown;
  readonly rejected: readonly { readonly method: string; readonly params: unknown }[];
  readonly requests: Readonly<Record<string, readonly unknown[]>>;
  readonly results: Readonly<Record<string, readonly unknown[]>>;
};
const methods = PasswordsBrokerMethodSchema.options;

describe("Passwords broker wire fixture", () => {
  it("refuses login and card shapes on each other's methods", () => {
    expect(fixture.rejected.length).toBeGreaterThan(0);
    for (const { method, params } of fixture.rejected) {
      const schema = passwordsBrokerRequests[PasswordsBrokerMethodSchema.parse(method)];
      expect(schema.safeParse(params).success).toBe(false);
    }
  });

  it("accepts 100 page-ranked accounts and refuses 101", () => {
    const account = {
      id: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      username: "u".repeat(1024),
      host: "a".repeat(63) + ".example.com",
      onPage: true,
      updatedAt: "2026-10-13T00:00:00.000Z",
      label: "l".repeat(200),
    };
    expect(PasswordsBrokerAccountSchema.safeParse(account).success).toBe(true);
    const accounts = Array.from({ length: 100 }, () => account);
    expect(PasswordsBrokerAccountsSchema.safeParse(accounts).success).toBe(true);
    expect(PasswordsBrokerAccountsSchema.safeParse([...accounts, account]).success).toBe(false);
    expect(
      Buffer.byteLength(JSON.stringify({ id: 1, result: { decision: "approve", accounts } })),
    ).toBeLessThanOrEqual(passwordsBrokerMaxFrameBytes);
  });

  it("names no page on a request and an exact HTTPS origin on each release", () => {
    const [request] = fixture.requests["signin.request"] ?? [];
    expect(PasswordsBrokerSignInRequestParamsSchema.safeParse(request).success).toBe(true);
    expect(
      PasswordsBrokerSignInRequestParamsSchema.safeParse({
        ...Object(request),
        pageOrigin: "https://github.com",
      }).success,
    ).toBe(false);
    const release = (fixture.requests["signin.release"] ?? []).find(
      (value) => Object(value).kind === "browser",
    );
    expect(release).toBeDefined();
    for (const origin of ["https://github.com", "https://gist.github.com:8443"]) {
      expect(
        PasswordsBrokerSignInReleaseParamsSchema.safeParse({ ...Object(release), origin }).success,
      ).toBe(true);
    }
    for (const origin of [
      null,
      undefined,
      "http://github.com",
      "https://github.com/path",
      "https://github.com/",
    ]) {
      expect(
        PasswordsBrokerSignInReleaseParamsSchema.safeParse({ ...Object(release), origin }).success,
      ).toBe(false);
    }
  });

  it("covers every method in both directions", () => {
    expect(Object.keys(fixture.requests).sort()).toEqual([...methods].sort());
    expect(Object.keys(fixture.results).sort()).toEqual([...methods].sort());
  });

  it.each(methods)("%s requests and results match their schemas", (method) => {
    for (const params of fixture.requests[method] ?? []) {
      expect(passwordsBrokerRequests[method].safeParse(params).error?.issues ?? []).toEqual([]);
    }
    for (const result of fixture.results[method] ?? []) {
      expect(passwordsBrokerResults[method].safeParse(result).error?.issues ?? []).toEqual([]);
    }
    expect(fixture.requests[method]?.length ?? 0).toBeGreaterThan(0);
    expect(fixture.results[method]?.length ?? 0).toBeGreaterThan(0);
  });

  it("answers each hello with the protocol version it asked for", () => {
    const asked = (fixture.requests.hello ?? []).map(
      (hello) => passwordsBrokerRequests.hello.parse(hello).protocolVersion,
    );
    const answered = (fixture.results.hello ?? []).map(
      (hello) => passwordsBrokerResults.hello.parse(hello).protocolVersion,
    );
    expect(new Set(asked)).toEqual(new Set([passwordsBrokerProtocolVersion]));
    expect(new Set(answered)).toEqual(new Set([passwordsBrokerProtocolVersion]));
  });

  it("asks for personal consent without a page binding or an older permission version", () => {
    const modern = (fixture.requests["signin.request"] ?? []).filter(
      (params) => PasswordsBrokerSignInRequestParamsSchema.safeParse(params).success,
    );
    expect(modern.length).toBeGreaterThan(0);
    for (const params of modern) {
      expect(params).not.toHaveProperty("sessionId");
      expect(params).not.toHaveProperty("runtimeId");
      expect(
        PasswordsBrokerSignInRequestParamsSchema.safeParse({
          ...Object(params),
          permissionVersion: 4,
        }).success,
      ).toBe(false);
    }
  });

  it("releases to an app only when asked by kind, and to a browser only with its origin", () => {
    const releases = (fixture.requests["signin.release"] ?? []).flatMap((params) => {
      const parsed = PasswordsBrokerSignInReleaseParamsSchema.safeParse(params);
      return parsed.success ? [parsed.data] : [];
    });
    const app = releases.find((release) => release.kind === "app");
    const browser = releases.find((release) => release.kind === "browser");
    expect(app).toBeDefined();
    expect(browser).toBeDefined();
    expect(
      PasswordsBrokerSignInReleaseParamsSchema.safeParse({ ...app, origin: "https://github.com" })
        .success,
    ).toBe(false);
    const { origin: _origin, ...browserWithoutOrigin } = browser ?? {};
    expect(PasswordsBrokerSignInReleaseParamsSchema.safeParse(browserWithoutOrigin).success).toBe(
      false,
    );
  });

  it("speaks the protocol version this package declares", () => {
    const [hello] = fixture.results.hello ?? [];
    expect(passwordsBrokerResults.hello.parse(hello).protocolVersion).toBe(
      passwordsBrokerProtocolVersion,
    );
  });

  it("frames errors and the status event the way the client reads them", () => {
    expect(PasswordsBrokerReplySchema.safeParse(fixture.error).success).toBe(true);
    expect(PasswordsBrokerStatusChangedEventSchema.safeParse(fixture.event).success).toBe(true);
    expect(PasswordsBrokerReplySchema.safeParse(fixture.event).success).toBe(true);
    expect(PasswordsBrokerStatusChangedEventSchema.parse(fixture.event).params.personFill).toBe(
      "on",
    );
    expect(PasswordsBrokerStatusChangedEventSchema.parse(fixture.event).params.personSave).toBe(
      "on",
    );
  });
});
