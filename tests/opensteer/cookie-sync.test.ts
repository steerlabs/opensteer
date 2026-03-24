import { describe, expect, test } from "vitest";

import { prepareBrowserProfileSyncCookies } from "../../packages/opensteer/src/cloud/cookie-sync.js";

describe("prepareBrowserProfileSyncCookies", () => {
  test("filters, normalizes, and dedupes cookies using the old sync rules", () => {
    const prepared = prepareBrowserProfileSyncCookies({
      domains: ["GitHub.com"],
      cookies: [
        {
          name: "session",
          value: "old",
          domain: ".github.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "session",
          value: "new",
          domain: "github.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "other",
          value: "drop-me",
          domain: ".example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "None",
        },
        {
          name: "partitioned",
          value: "chips",
          domain: "github.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          partitionKey: "https://github.com",
        },
      ],
    });

    expect(prepared.cookies).toEqual([
      {
        name: "session",
        value: "new",
        domain: "github.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        session: true,
        expiresAt: null,
      },
      {
        name: "partitioned",
        value: "chips",
        domain: "github.com",
        path: "/",
        secure: true,
        httpOnly: true,
        partitionKey: "https://github.com",
        session: true,
        expiresAt: null,
      },
    ]);
  });
});
