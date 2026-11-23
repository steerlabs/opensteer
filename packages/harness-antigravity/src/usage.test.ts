import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessObservedUsageSchema } from "@opensteer/harness";
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

async function writeTokenFile(): Promise<string> {
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
  return tokenPath;
}

describe("Antigravity usage", () => {
  it("reads Gemini and 3P five-hour and weekly Google quota as contract-valid scoped windows", async () => {
    const tokenPath = await writeTokenFile();
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
              {
                bucketId: "3p-5h",
                remainingFraction: 0,
                resetTime: "2026-11-01T16:00:00Z",
                window: "5h",
              },
              {
                bucketId: "3p-weekly",
                remainingFraction: 0.4,
                resetTime: "2026-11-07T16:00:00Z",
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
      now: Date.parse("2026-11-01T12:00:00Z"),
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    // An exhausted 3P bucket must not flip the account-wide limit flag while Gemini still has capacity.
    expect(usage?.limitReached).toBe(false);
    expect(usage?.windows).toEqual([
      {
        label: "Gemini 5h",
        providerIds: ["google"],
        resetsAt: "2026-11-01T15:00:00.000Z",
        usedPercent: 25,
      },
      {
        label: "Gemini weekly",
        providerIds: ["google"],
        resetsAt: "2026-11-07T15:00:00.000Z",
        usedPercent: 80,
      },
      {
        label: "Claude & GPT 5h",
        providerIds: ["anthropic", "openai"],
        resetsAt: "2026-11-01T16:00:00.000Z",
        usedPercent: 100,
      },
      {
        label: "Claude & GPT weekly",
        providerIds: ["anthropic", "openai"],
        resetsAt: "2026-11-07T16:00:00.000Z",
        usedPercent: 60,
      },
    ]);
    expect(requests.filter(({ url }) => url.includes("retrieveUserQuotaSummary"))).toHaveLength(2);
    for (const quota of requests.filter(({ url }) => url.includes("retrieveUserQuotaSummary"))) {
      expect(new Headers(quota.init?.headers).get("user-agent")).toContain("hub/2.24.0");
      expect(quota.init?.redirect).toBe("manual");
    }
  });

  it("merges by bucket identity, keeps distinct same-name unknown buckets, bounds labels and caps at 8 windows", async () => {
    const tokenPath = await writeTokenFile();
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("daily-cloudcode-pa")) {
        return Response.json({
          groups: [
            {
              displayName: "Very Long Experimental Model Pool Name",
              buckets: [
                {
                  bucketId: "exp-alpha",
                  remainingFraction: 0.1,
                  resetTime: "2026-11-01T15:00:00Z",
                  window: "weekly",
                },
                {
                  bucketId: "exp-beta",
                  remainingFraction: 0.3,
                  resetTime: "2026-11-02T15:00:00Z",
                  window: "weekly",
                },
                ...Array.from({ length: 8 }, (_, index) => ({
                  bucketId: `extra-${index}`,
                  displayName: `Extra Bucket With Long Name ${index}`,
                  remainingFraction: 0.9 - index * 0.05,
                  window: "5h",
                })),
              ],
            },
          ],
        });
      }
      // Production endpoint reports a higher usage on exp-alpha and lower on exp-beta.
      return Response.json({
        buckets: [
          {
            bucketId: "exp-alpha",
            displayName: "Very Long Experimental Model Pool Name",
            remainingFraction: 0.05,
            resetTime: "2026-11-01T15:00:00Z",
            window: "weekly",
          },
          {
            bucketId: "exp-beta",
            displayName: "Very Long Experimental Model Pool Name",
            remainingFraction: 0.8,
            resetTime: "2026-11-02T15:00:00Z",
            window: "weekly",
          },
        ],
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now: Date.parse("2026-11-01T12:00:00Z"),
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    expect(usage?.windows).toHaveLength(8);
    // Both distinct unknown buckets survive without clobbering each other by label,
    // and each carries informational scope (`providerIds: []`).
    expect(usage?.windows[0]).toMatchObject({
      providerIds: [],
      usedPercent: 95,
    });
    expect(usage?.windows[1]).toMatchObject({
      providerIds: [],
      usedPercent: 70,
    });
    for (const window of usage?.windows ?? []) {
      expect(window.label.length).toBeLessThanOrEqual(24);
    }
  });

  it("falls back to fetchAvailableModels with provider-scoped and per-model scopes", async () => {
    const tokenPath = await writeTokenFile();
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return Response.json({ buckets: [] });
      }
      return Response.json({
        models: {
          "gemini-4-neon": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-01T15:00:00Z" },
          },
          "gemini-3.8-flash": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-01T15:00:00Z" },
          },
          "claude-opus-5-5": {
            modelProvider: "MODEL_PROVIDER_ANTHROPIC",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-11-01T16:00:00Z" },
          },
          "claude-sonnet-5-5": {
            modelProvider: "MODEL_PROVIDER_ANTHROPIC",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-01T16:00:00Z" },
          },
        },
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now: Date.parse("2026-11-01T12:00:00Z"),
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    expect(usage?.limitReached).toBe(false);
    // Uniform Gemini models collapse to one provider-scoped window; differing Claude models keep model scopes.
    expect(usage?.windows).toEqual([
      {
        label: "Gemini quota",
        providerIds: ["google"],
        resetsAt: "2026-11-01T15:00:00.000Z",
        usedPercent: 50,
      },
      {
        label: "claude-opus-5-5 quota",
        resetsAt: "2026-11-01T16:00:00.000Z",
        scope: { kind: "model", modelId: "claude-opus-5-5", providerId: "anthropic" },
        usedPercent: 100,
      },
      {
        label: "claude-sonnet-5-5 quota",
        resetsAt: "2026-11-01T16:00:00.000Z",
        scope: { kind: "model", modelId: "claude-sonnet-5-5", providerId: "anthropic" },
        usedPercent: 20,
      },
    ]);
  });

  it("never splits emoji surrogate pairs at the label truncation boundary and preserves zero-capacity precision", async () => {
    const tokenPath = await writeTokenFile();
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      return Response.json({
        buckets: [
          {
            // 15 BMP chars + emoji (UTF-16 units 15..16) + suffix, cadence "weekly" (6 chars)
            // => maxSubject = 24 - 6 - 1 = 17, maxSubject - 1 = 16 lands inside the emoji pair.
            bucketId: "emoji-pool",
            displayName: "Experimental AI🚀Ultra Long Pool",
            remainingFraction: 0.00001,
            resetTime: "2026-11-07T15:00:00Z",
            window: "weekly",
          },
          {
            bucketId: "negative-fraction",
            remainingFraction: -0.25,
            window: "5h",
          },
          {
            bucketId: "malformed-sibling",
            remainingFraction: "not-a-number",
            window: "5h",
          },
          "not-an-object",
          {
            bucketId: "gemini-5h",
            remainingFraction: 0.5,
            resetTime: "2026-11-01T15:00:00Z",
            window: "5h",
          },
        ],
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now: Date.parse("2026-11-01T12:00:00Z"),
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    expect(usage?.windows).toHaveLength(2);
    const emojiWindow = usage?.windows[0]!;
    expect(emojiWindow.label.length).toBeLessThanOrEqual(24);
    expect(emojiWindow.label).toBe(emojiWindow.label.toWellFormed());
    // Tiny positive remainder must not round up to 100% exhaustion.
    expect(emojiWindow.usedPercent).toBe(99.99);
    expect(usage?.windows[1]).toMatchObject({
      label: "Gemini 5h",
      providerIds: ["google"],
      usedPercent: 50,
    });
  });

  it("prefers active readings over elapsed 100% readings, prioritizes actionable windows in the cap, and falls back when summary is informational-only", async () => {
    const tokenPath = await writeTokenFile();
    const now = Date.parse("2026-11-01T12:00:00Z");
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("daily-cloudcode-pa")) {
        return Response.json({
          buckets: [
            {
              bucketId: "gemini-5h",
              remainingFraction: 0,
              resetTime: "2026-11-01T11:00:00Z", // elapsed before `now`
              window: "5h",
            },
            ...Array.from({ length: 8 }, (_, index) => ({
              bucketId: `info-${index}`,
              displayName: `Info ${index}`,
              remainingFraction: 0.01,
              resetTime: "2026-11-01T18:00:00Z",
              window: "5h",
            })),
          ],
        });
      }
      return Response.json({
        buckets: [
          {
            bucketId: "gemini-5h",
            remainingFraction: 0.2,
            resetTime: "2026-11-01T16:00:00Z", // active
            window: "5h",
          },
        ],
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now,
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage?.windows).toHaveLength(8);
    // Active 80% Gemini window beats elapsed 100% Gemini window AND survives the 8-window cap over 99% informational buckets.
    expect(usage?.windows[0]).toEqual({
      label: "Gemini 5h",
      providerIds: ["google"],
      resetsAt: "2026-11-01T16:00:00.000Z",
      usedPercent: 80,
    });

    // Informational-only summary must still query fetchAvailableModels for actionable quotas.
    const infoOnlyRequest = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return Response.json({
          buckets: [
            {
              bucketId: "unknown-pool",
              displayName: "Unknown Pool",
              remainingFraction: 0.5,
              resetTime: "2026-11-01T18:00:00Z",
              window: "5h",
            },
          ],
        });
      }
      return Response.json({
        models: {
          "gemini-4-neon": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-01T15:00:00Z" },
          },
          "gemini-3.8-flash": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-01T15:00:00Z" },
          },
        },
      });
    });
    const combined = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: infoOnlyRequest,
      now,
      signal: new AbortController().signal,
      tokenPath,
    });
    expect(combined?.windows).toEqual([
      {
        label: "Gemini quota",
        providerIds: ["google"],
        resetsAt: "2026-11-01T15:00:00.000Z",
        usedPercent: 40,
      },
      {
        label: "Unknown Pool 5h",
        providerIds: [],
        resetsAt: "2026-11-01T18:00:00.000Z",
        usedPercent: 50,
      },
    ]);
  });

  it("keeps model scopes on partial provider fallback and when mixed per-model readings exceed 8 windows", async () => {
    const tokenPath = await writeTokenFile();
    const now = Date.parse("2026-11-01T12:00:00Z");
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return Response.json({ buckets: [] });
      }
      return Response.json({
        models: {
          // Only one Gemini model has quotaInfo while a sibling has none: must NOT become provider-wide.
          "gemini-4-neon": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-11-01T15:00:00Z" },
          },
          "gemini-3.8-flash": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
          },
          // 9 distinct Claude models with mixed readings (> 8 cap): must stay model-scoped, never collapse to provider-wide 100%.
          ...Object.fromEntries(
            Array.from({ length: 9 }, (_, index) => [
              `claude-model-${index}`,
              {
                modelProvider: "MODEL_PROVIDER_ANTHROPIC",
                quotaInfo: {
                  remainingFraction: index === 0 ? 0 : 0.8 - index * 0.05,
                  resetTime: "2026-11-01T16:00:00Z",
                },
              },
            ]),
          ),
        },
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now,
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    expect(usage?.windows).toHaveLength(8);
    expect(usage?.windows.every((window) => window.scope?.kind === "model")).toBe(true);
    expect(usage?.windows[0]).toMatchObject({
      scope: { kind: "model", modelId: "gemini-4-neon", providerId: "google" },
      usedPercent: 100,
    });
  });

  it("drops NUL/surrogate model IDs, keeps model scopes when a sibling entry is malformed, and falls back when summary windows have expired", async () => {
    const tokenPath = await writeTokenFile();
    const now = Date.parse("2026-11-01T12:00:00Z");
    const request = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3_600 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return Response.json({
          buckets: [
            {
              bucketId: "gemini-5h",
              remainingFraction: 0.5,
              resetTime: "2026-11-01T10:00:00Z", // already expired at `now`
              window: "5h",
            },
          ],
        });
      }
      return Response.json({
        models: {
          "gemini-4-neon": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-11-01T15:00:00Z" },
          },
          "gemini-4-carbon": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-11-01T15:00:00Z" },
          },
          // Malformed third Gemini sibling must prevent widening to a provider-wide block.
          "gemini-3.8-flash": {
            modelProvider: null,
          },
          // Unsafe NUL model ID must be skipped so PostgreSQL JSONB never rejects the catalog.
          "gemini-bad\u0000id": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-11-01T15:00:00Z" },
          },
        },
      });
    });

    const usage = await readAntigravityUsage({
      authMethod: "oauth-personal",
      fetch: request,
      now,
      signal: new AbortController().signal,
      tokenPath,
    });

    expect(usage).toBeDefined();
    expect(() => HarnessObservedUsageSchema.parse(usage)).not.toThrow();
    // Active fallback model windows appear and stay model-scoped (never widened to provider-wide).
    expect(
      usage?.windows.filter((window) => window.scope?.kind === "model").map((w) => w.scope),
    ).toEqual([
      { kind: "model", modelId: "gemini-4-neon", providerId: "google" },
      { kind: "model", modelId: "gemini-4-carbon", providerId: "google" },
    ]);
    expect(JSON.stringify(usage)).not.toContain("\\u0000");
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
