import { expect, it } from "vitest";
import {
  browserSiteCookieMatches,
  validateBrowserSourceSnapshot,
  maxBrowserSourceCookies,
  maxBrowserSourceSnapshotBytes,
} from "./source-state.js";
const cookie = {
  domain: "example.com",
  expires: -1,
  httpOnly: true,
  name: "session",
  path: "/",
  secure: true,
  value: "signed-in",
};
it("keeps the cookie-only Chrome envelope and scope, including partition ancestry", () => {
  const snapshot = {
    cookies: [
      cookie,
      {
        ...cookie,
        name: "chips",
        partitionKey: "https://example.com",
        partitionKeyHasCrossSiteAncestor: true,
      },
    ],
    origins: [],
  };
  expect(validateBrowserSourceSnapshot("https://example.com", snapshot)).toEqual(snapshot);
  for (const candidate of [
    { ...cookie, domain: "notexample.com" },
    { ...cookie, domain: "embedded.test", partitionKey: "https://example.com" },
    { ...cookie, partitionKey: "https://other.test" },
  ])
    expect(browserSiteCookieMatches("https://example.com", candidate)).toBe(false);
  expect(() =>
    validateBrowserSourceSnapshot("https://example.com", {
      ...snapshot,
      origins: [{ origin: "https://example.com", localStorage: [] }],
    }),
  ).toThrow("invalid browser state");
  expect(() =>
    validateBrowserSourceSnapshot("https://example.com", {
      cookies: [{ ...cookie, domain: "other.com" }],
      origins: [],
    }),
  ).toThrow("outside");
});
it("counts UTF-8 cookie bytes and enforces the same envelope and count limits without a profile encoder", () => {
  expect(
    validateBrowserSourceSnapshot("https://example.com", {
      cookies: Array.from({ length: maxBrowserSourceCookies }, () => cookie),
      origins: [],
    }),
  ).toMatchObject({ cookies: expect.any(Array), origins: [] });
  expect(() =>
    validateBrowserSourceSnapshot("https://example.com", {
      cookies: Array.from({ length: maxBrowserSourceCookies + 1 }, () => cookie),
      origins: [],
    }),
  ).toThrow();
  const cookies = Array.from({ length: 8 }, (_, index) => ({
    ...cookie,
    name: String(index),
    value: "é".repeat(65536),
  }));
  const snapshot = { cookies, origins: [] };
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(
    maxBrowserSourceSnapshotBytes,
  );
  expect(() => validateBrowserSourceSnapshot("https://example.com", snapshot)).toThrow("1 MiB");
});
