import { Effect } from "effect";
import { expect, it } from "vitest";
import { openapiImport, planOpenapiImport } from "./openapi-import.js";

const origin = "https://api.example.test";
const description = {
  openapi: "3.0.3",
  info: { title: "Example", version: "1" },
  servers: [{ url: origin }],
  components: {
    securitySchemes: {
      header: { type: "apiKey", in: "header", name: "X-Key" },
      cookie: { type: "apiKey", in: "cookie", name: "session" },
      oauth: { type: "oauth2" },
      oidc: { type: "openIdConnect" },
      mtls: { type: "mutualTLS" },
      basic: { type: "http", scheme: "basic" },
      otherHeader: { $ref: "#/components/securitySchemes/header" },
    },
  },
};
const responses = { "200": { description: "OK" } };

it("applies an operation's security override and keeps complete supported alternatives", () => {
  const plan = planOpenapiImport({
    ...description,
    security: [{ cookie: [], header: [] }, { otherHeader: [] }],
    paths: {
      "/secured": { get: { responses } },
      "/public": { get: { responses, security: [] } },
      "/optional": { get: { responses, security: [{ header: [] }, {}] } },
      "/cookie": { get: { responses, security: [{ cookie: [] }] } },
    },
  });
  expect(plan.auth).toEqual({
    apiKey: {
      kind: "secrets",
      label: "API key",
      fields: ["token"],
      placements: [{ carrier: "header", name: "X-Key", field: "token" }],
    },
  });
  expect(plan.document.paths).toEqual({
    "/secured": { get: { responses, security: [{ otherHeader: [] }] } },
    "/public": { get: { responses, security: [] } },
    "/optional": { get: { responses, security: [] } },
    "/cookie": {},
  });
  expect(plan.excluded.get("GET /cookie")).toContain("cookie API key");
});

it.each([
  ["cookie", "cookie API key"],
  ["oauth", "oauth2"],
  ["oidc", "openIdConnect"],
  ["mtls", "mutualTLS"],
  ["basic", "HTTP basic"],
])("refuses a document with only %s operations and names the reason", async (scheme, reason) => {
  const result = await Effect.runPromise(
    openapiImport(
      "Example",
      origin,
      {
        ...description,
        paths: { "/secured": { get: { responses, security: [{ [scheme]: [] }] } } },
      },
      AbortSignal.timeout(2_000),
    ),
  );
  expect(result).toMatchObject({
    error: expect.stringContaining(
      `GET /secured — Unsupported authentication: ${scheme} (${reason})`,
    ),
  });
});

it("reports operations on other origins in a partial install", async () => {
  const result = await Effect.runPromise(
    openapiImport(
      "Example",
      origin,
      {
        ...description,
        paths: {
          "/public": { get: { responses } },
          "/elsewhere": { get: { responses, servers: [{ url: "https://other.example.test" }] } },
        },
      },
      AbortSignal.timeout(2_000),
    ),
  );
  expect(result).toMatchObject({ warnings: [expect.stringContaining("GET /elsewhere")] });
});
