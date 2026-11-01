import { readFile } from "node:fs/promises";
import type { HarnessObservedUsage, HarnessObservedUsageWindow } from "@opensteer/harness";
import { z } from "zod";
import type { AntigravityAuthMethod } from "./config.js";

const quotaEndpoints = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const TokenFileSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  project_id: z.string().optional(),
  refresh_token: z.string().min(1),
});
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const QuotaSchema = z.object({
  remainingFraction: z.number().optional(),
  resetTime: z.string().optional(),
});
const BucketSchema = QuotaSchema.extend({
  bucketId: z.string().min(1),
  disabled: z.boolean().optional(),
  displayName: z.string().optional(),
  window: z.string().optional(),
});
const SummarySchema = z.object({
  buckets: z.array(BucketSchema).optional(),
  groups: z
    .array(
      z.object({
        buckets: z.array(BucketSchema).optional(),
        displayName: z.string().optional(),
      }),
    )
    .optional(),
});
const ModelsSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      modelProvider: z.string().optional(),
      quotaInfo: QuotaSchema.optional(),
      weeklyQuotaInfo: QuotaSchema.optional(),
    }),
  ),
});

function resetTime(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function quotaWindow(
  label: string,
  quota: z.infer<typeof QuotaSchema>,
): HarnessObservedUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  return {
    label,
    resetsAt: resetTime(quota.resetTime),
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
  };
}

function summaryWindows(value: unknown): readonly HarnessObservedUsageWindow[] {
  const summary = SummarySchema.parse(value);
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  const windows = new Map<string, HarnessObservedUsageWindow>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      const family = bucket.bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucket.bucketId.startsWith("3p-")
          ? "Claude & GPT (shared)"
          : group.displayName?.trim() || bucket.displayName?.trim() || bucket.bucketId;
      const cadence =
        bucket.window === "weekly" ? "Weekly" : bucket.window === "5h" ? "5-hour" : "Quota";
      const window = quotaWindow(`${family} · ${cadence}`, bucket);
      if (window) windows.set(`${family}:${cadence}`, window);
    }
  }
  return [...windows.values()];
}

function modelWindows(value: unknown): readonly HarnessObservedUsageWindow[] {
  const models = ModelsSchema.parse(value);
  const windows = new Map<string, HarnessObservedUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    for (const [cadence, quota] of [
      ["Reported quota", model.quotaInfo],
      ["Weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(`${family} · ${cadence}`, quota);
      const previous = windows.get(`${family}:${cadence}`);
      if (window && (!previous || previous.usedPercent < window.usedPercent)) {
        windows.set(`${family}:${cadence}`, window);
      }
    }
  }
  return [...windows.values()];
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Google quota request failed with HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1_024 * 1_024) {
    throw new Error("Google quota response was too large");
  }
  return JSON.parse(text) as unknown;
}

async function requestJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  return jsonResponse(await request(url, { ...init, redirect: "manual", signal }));
}

/** Reads Google's account quota without exposing or retaining OAuth credentials. */
export async function readAntigravityUsage(input: {
  readonly authMethod: AntigravityAuthMethod;
  readonly fetch?: typeof fetch;
  readonly signal: AbortSignal;
  readonly tokenPath: string;
}): Promise<HarnessObservedUsage | undefined> {
  if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
    return undefined;
  }
  let token: z.infer<typeof TokenFileSchema>;
  try {
    token = TokenFileSchema.parse(JSON.parse(await readFile(input.tokenPath, "utf8")));
  } catch {
    return undefined;
  }
  const request = input.fetch ?? fetch;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const refreshed = TokenResponseSchema.parse(
    await requestJson(
      request,
      "https://oauth2.googleapis.com/token",
      {
        body: new URLSearchParams({
          client_id: token.client_id,
          client_secret: token.client_secret,
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      signal,
    ),
  );
  const headers = {
    Authorization: `Bearer ${refreshed.access_token}`,
    "content-type": "application/json",
    "user-agent": `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch})`,
  };
  const body = JSON.stringify(token.project_id ? { project: token.project_id } : {});
  const read = async (
    operation: string,
    parse: (value: unknown) => readonly HarnessObservedUsageWindow[],
  ) => {
    const answers = await Promise.all(
      quotaEndpoints.map(async (endpoint) => {
        try {
          return parse(
            await requestJson(
              request,
              `${endpoint}/v1internal:${operation}`,
              { body, headers, method: "POST" },
              signal,
            ),
          );
        } catch {
          return [];
        }
      }),
    );
    const windows = new Map<string, HarnessObservedUsageWindow>();
    for (const window of answers.flat()) {
      const previous = windows.get(window.label);
      if (!previous || previous.usedPercent < window.usedPercent) windows.set(window.label, window);
    }
    return [...windows.values()];
  };
  let windows = await read("retrieveUserQuotaSummary", summaryWindows);
  if (windows.length === 0) windows = await read("fetchAvailableModels", modelWindows);
  if (windows.length === 0) return undefined;
  return {
    limitReached: windows.some((window) => window.usedPercent >= 100),
    observedAt: new Date().toISOString(),
    windows,
  };
}
