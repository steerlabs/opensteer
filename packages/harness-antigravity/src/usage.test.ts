import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAntigravityUsage } from "./usage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Antigravity usage", () => {
  it("reads five-hour and weekly Google quota as hub/2.24.0", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-usage-"));
    temporaryDirectories.push(directory);
    const tokenPath = join(directory, "acp_token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        project_id: "project-id",
        refresh_token: "refresh-token",
      }),
    );
    const requests: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const request = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = String(value);
      requests.push({ ...(init ? { init } : {}), url });
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      return Response.json({
        groups: [
          {
            buckets: [
              {
                bucketId: "gemini-5h",
                remainingFraction: 0.75,
                resetTime: "2026-11-01T15:00:00Z",
                window: "5h",
              },
              {
                bucketId: "gemini-weekly",
                remainingFraction: 0.2,
                resetTime: "2026-11-07T15:00:00Z",
                window: "weekly",
              },
            ],
          },
        ],
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage?.windows).toEqual([
      { label: "Gemini · 5-hour", resetsAt: "2026-11-01T15:00:00.000Z", usedPercent: 25 },
      { label: "Gemini · Weekly", resetsAt: "2026-11-07T15:00:00.000Z", usedPercent: 80 },
    ]);
    expect(requests.filter(({ url }) => url.includes("retrieveUserQuotaSummary"))).toHaveLength(2);
    for (const quota of requests.filter(({ url }) => url.includes("retrieveUserQuotaSummary"))) {
      expect(new Headers(quota.init?.headers).get("user-agent")).toContain("hub/2.24.0");
      expect(quota.init?.redirect).toBe("manual");
    }
  });

  it("does not probe quota for API-key sources", async () => {
    const request = vi.fn();
    await expect(
      readAntigravityUsage({
        authMethod: "gemini-api-key",
        fetch: request,
        signal: new AbortController().signal,
        tokenPath: "/does/not/matter",
      }),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
