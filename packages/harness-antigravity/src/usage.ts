import { readFile } from "node:fs/promises";
import {
  canonicalModelReference,
  ModelIdSchema,
  ModelProviderIdSchema,
  surrogateSafeCut,
  type ModelSelection,
} from "@opensteer/core";
import {
  harnessObservedUsageLabelMaxLength,
  harnessObservedUsageMaxWindows,
  usageWindowHasReset,
  usageWindowIsAccountWide,
  type HarnessObservedUsage,
  type HarnessObservedUsageWindow,
} from "@opensteer/harness";
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
// Antigravity 1.5 writes OAuth tokens to `antigravity-oauth-token` without an
// OAuth client secret, so we use its access token directly while it is valid.
const CliTokenFileSchema = z.object({
  token: z.object({
    access_token: z.string().min(1),
    expiry: z.string().optional(),
    refresh_token: z.string().optional(),
  }),
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
const SummaryGroupSchema = z.object({
  buckets: z.array(z.unknown()).optional(),
  displayName: z.string().optional(),
});
const SummarySchema = z.object({
  buckets: z.array(z.unknown()).optional(),
  groups: z.array(z.unknown()).optional(),
});
const ModelEntrySchema = z.object({
  modelProvider: z.string().optional(),
  quotaInfo: z.unknown().optional(),
  weeklyQuotaInfo: z.unknown().optional(),
});
const ModelsSchema = z.object({
  models: z.record(z.string(), z.unknown()),
});

type ProviderId = ModelSelection["providerId"];
type ModelId = ModelSelection["modelId"];

const googleProvider = ModelProviderIdSchema.parse("google");
const anthropicProvider = ModelProviderIdSchema.parse("anthropic");
const openaiProvider = ModelProviderIdSchema.parse("openai");

interface KeyedWindow {
  /** Stable provider identity used to merge duplicate readings across endpoints. */
  readonly key: string;
  readonly window: HarnessObservedUsageWindow;
}

interface ParsedModelQuota {
  readonly cadence: "quota" | "weekly";
  readonly modelId: ModelId;
  readonly providerId: ProviderId;
  readonly resetsAt: string | null;
  readonly usedPercent: number;
}

interface ParsedModelsResponse {
  readonly hasUnattributedEntry: boolean;
  readonly modelsByProvider: ReadonlyMap<ProviderId, ReadonlySet<ModelId>>;
  readonly quotas: readonly ParsedModelQuota[];
}

function resetTime(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * Converts Google's `[0, 1]` remaining fraction into a `[0, 100]` used
 * percentage without IEEE-754 drift and without rounding a tiny positive
 * remainder into false 100% exhaustion.
 */
function usedPercent(quota: z.infer<typeof QuotaSchema>): number | undefined {
  const remaining = quota.remainingFraction;
  if (remaining === undefined || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) {
    return undefined;
  }
  if (remaining === 0) return 100;
  const rounded = Math.round((1 - remaining) * 10_000) / 100;
  return Math.min(99.99, Math.max(0, rounded));
}

function cleanText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Formats a concise window label guaranteed to satisfy the wire contract and
 * stay valid UTF-16 (no split surrogate pairs) while preserving the cadence
 * suffix when an unrecognized provider bucket has a long display name.
 */
function formatWindowLabel(subject: string, cadence: string): string {
  const cleanSubject = cleanText(subject);
  const cleanCadence = cleanText(cadence) || "quota";
  if (!cleanSubject) {
    return cleanCadence.slice(
      0,
      surrogateSafeCut(cleanCadence, harnessObservedUsageLabelMaxLength),
    );
  }
  const full = `${cleanSubject} ${cleanCadence}`;
  if (full.length <= harnessObservedUsageLabelMaxLength) return full;
  const maxSubject = harnessObservedUsageLabelMaxLength - cleanCadence.length - 1;
  if (maxSubject <= 1) {
    return cleanCadence.slice(
      0,
      surrogateSafeCut(cleanCadence, harnessObservedUsageLabelMaxLength),
    );
  }
  const cut = surrogateSafeCut(cleanSubject, maxSubject - 1);
  const trimmed = cleanSubject.slice(0, cut).trimEnd();
  return trimmed ? `${trimmed}… ${cleanCadence}` : cleanCadence;
}

function isActionableWindow(window: HarnessObservedUsageWindow): boolean {
  return window.providerIds === undefined || window.providerIds.length > 0;
}

function moreConstrained(
  candidate: { readonly resetsAt: string | null; readonly usedPercent: number },
  existing: { readonly resetsAt: string | null; readonly usedPercent: number },
  now: number,
): boolean {
  const candidateActive = !usageWindowHasReset(candidate.resetsAt, now);
  const existingActive = !usageWindowHasReset(existing.resetsAt, now);
  if (candidateActive !== existingActive) return candidateActive;
  if (candidate.usedPercent !== existing.usedPercent) {
    return candidate.usedPercent > existing.usedPercent;
  }
  if (candidate.resetsAt === null) return false;
  if (existing.resetsAt === null) return true;
  return Date.parse(candidate.resetsAt) < Date.parse(existing.resetsAt);
}

function providerFamilyName(providerId: ProviderId): string {
  if (providerId === googleProvider) return "Gemini";
  if (providerId === anthropicProvider) return "Claude";
  if (providerId === openaiProvider) return "GPT";
  return providerId;
}

function classifySummaryBucket(
  bucket: z.infer<typeof BucketSchema>,
  groupDisplayName: string | undefined,
): {
  readonly family: string;
  readonly poolKey: string;
  readonly providerIds: readonly ProviderId[];
} {
  if (bucket.bucketId.startsWith("gemini-")) {
    return { family: "Gemini", poolKey: "provider:google", providerIds: [googleProvider] };
  }
  if (bucket.bucketId.startsWith("3p-")) {
    return {
      family: "Claude & GPT",
      poolKey: "provider:anthropic+openai",
      providerIds: [anthropicProvider, openaiProvider],
    };
  }
  if (bucket.bucketId.startsWith("claude-")) {
    return { family: "Claude", poolKey: "provider:anthropic", providerIds: [anthropicProvider] };
  }
  if (bucket.bucketId.startsWith("gpt-")) {
    return { family: "GPT", poolKey: "provider:openai", providerIds: [openaiProvider] };
  }
  // Unrecognized buckets remain visible at the account level but must not
  // constrain known models whose membership in the bucket is unverified.
  return {
    family: groupDisplayName?.trim() || bucket.displayName?.trim() || bucket.bucketId,
    poolKey: `bucket:${bucket.bucketId}`,
    providerIds: [],
  };
}

function summaryWindows(value: unknown, now: number): readonly KeyedWindow[] {
  const parsedSummary = SummarySchema.safeParse(value);
  if (!parsedSummary.success) return [];
  const summary = parsedSummary.data;
  const parsedGroups = (summary.groups ?? []).flatMap((rawGroup) => {
    const group = SummaryGroupSchema.safeParse(rawGroup);
    return group.success ? [group.data] : [];
  });
  const groups = parsedGroups.some((group) => group.buckets?.length)
    ? parsedGroups
    : [{ buckets: summary.buckets, displayName: undefined }];
  const windows = new Map<string, KeyedWindow>();
  for (const group of groups) {
    for (const rawBucket of group.buckets ?? []) {
      const parsedBucket = BucketSchema.safeParse(rawBucket);
      if (!parsedBucket.success) continue;
      const bucket = parsedBucket.data;
      if (bucket.disabled) continue;
      const used = usedPercent(bucket);
      if (used === undefined) continue;
      const { family, poolKey, providerIds } = classifySummaryBucket(bucket, group.displayName);
      const cadence =
        bucket.window === "weekly" ? "weekly" : bucket.window === "5h" ? "5h" : "quota";
      const key = `${poolKey}:${cadence}`;
      const window: HarnessObservedUsageWindow = {
        label: formatWindowLabel(family, cadence),
        providerIds,
        resetsAt: resetTime(bucket.resetTime),
        usedPercent: used,
      };
      const previous = windows.get(key);
      if (!previous || moreConstrained(window, previous.window, now)) {
        windows.set(key, { key, window });
      }
    }
  }
  return [...windows.values()];
}

function modelProviderHint(
  modelId: string,
  modelProvider: string | undefined,
): ProviderId | undefined {
  if (modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")) {
    return googleProvider;
  }
  if (modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")) {
    return anthropicProvider;
  }
  if (modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")) {
    return openaiProvider;
  }
  return undefined;
}

function isJsonbSafeIdentifier(value: string): boolean {
  return value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value) && value === value.toWellFormed();
}

function parseModelsResponse(value: unknown): ParsedModelsResponse {
  const parsedModels = ModelsSchema.safeParse(value);
  if (!parsedModels.success) {
    return { hasUnattributedEntry: false, modelsByProvider: new Map(), quotas: [] };
  }
  const modelsByProvider = new Map<ProviderId, Set<ModelId>>();
  const quotas: ParsedModelQuota[] = [];
  let hasUnattributedEntry = false;
  for (const [nativeModelId, rawModel] of Object.entries(parsedModels.data.models)) {
    const parsedModel = ModelEntrySchema.safeParse(rawModel);
    const hinted = modelProviderHint(
      nativeModelId,
      parsedModel.success ? parsedModel.data.modelProvider : undefined,
    );
    if (!isJsonbSafeIdentifier(nativeModelId)) {
      if (hinted) hasUnattributedEntry = true;
      continue;
    }
    if (!hinted) {
      if (!parsedModel.success) hasUnattributedEntry = true;
      continue;
    }
    const canonical = canonicalModelReference(nativeModelId, hinted);
    if (!isJsonbSafeIdentifier(canonical.modelId)) {
      hasUnattributedEntry = true;
      continue;
    }
    const providerId = ModelProviderIdSchema.safeParse(canonical.providerId);
    const modelId = ModelIdSchema.safeParse(canonical.modelId);
    if (!providerId.success || !modelId.success) {
      hasUnattributedEntry = true;
      continue;
    }
    // Count every recognized model toward provider coverage even if its entry
    // or quota is missing/malformed, so partial data never widens to a provider block.
    const knownModels = modelsByProvider.get(providerId.data) ?? new Set<ModelId>();
    knownModels.add(modelId.data);
    modelsByProvider.set(providerId.data, knownModels);
    if (!parsedModel.success) continue;
    const model = parsedModel.data;
    for (const [cadence, rawQuota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (rawQuota === undefined) continue;
      const parsedQuota = QuotaSchema.safeParse(rawQuota);
      if (!parsedQuota.success) continue;
      const used = usedPercent(parsedQuota.data);
      if (used === undefined) continue;
      quotas.push({
        cadence,
        modelId: modelId.data,
        providerId: providerId.data,
        resetsAt: resetTime(parsedQuota.data.resetTime),
        usedPercent: used,
      });
    }
  }
  return { hasUnattributedEntry, modelsByProvider, quotas };
}

function projectModelQuotas(
  responses: readonly ParsedModelsResponse[],
  now: number,
): readonly HarnessObservedUsageWindow[] {
  const modelsByProvider = new Map<ProviderId, Set<ModelId>>();
  const byModel = new Map<string, ParsedModelQuota>();
  let hasUnattributedEntry = false;
  for (const response of responses) {
    if (response.hasUnattributedEntry) hasUnattributedEntry = true;
    for (const [providerId, modelIds] of response.modelsByProvider) {
      const target = modelsByProvider.get(providerId) ?? new Set<ModelId>();
      for (const modelId of modelIds) target.add(modelId);
      modelsByProvider.set(providerId, target);
    }
    for (const entry of response.quotas) {
      const key = `${entry.providerId}/${entry.modelId}:${entry.cadence}`;
      const previous = byModel.get(key);
      if (!previous || moreConstrained(entry, previous, now)) {
        byModel.set(key, entry);
      }
    }
  }

  // Group by (providerId, cadence). Collapse to one provider-scoped window only
  // when multiple models of that provider exist, every one of them reported a
  // reading for this cadence, and every reading is identical; otherwise keep
  // exact per-model scopes so a sibling model with capacity is never poisoned.
  const groups = new Map<string, ParsedModelQuota[]>();
  for (const entry of byModel.values()) {
    const key = `${entry.providerId}:${entry.cadence}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  const windows: HarnessObservedUsageWindow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const providerModels = modelsByProvider.get(first.providerId);
    const coversWholeProvider =
      !hasUnattributedEntry &&
      providerModels !== undefined &&
      providerModels.size >= 2 &&
      group.length === providerModels.size;
    const uniform =
      coversWholeProvider &&
      group.every(
        (entry) => entry.usedPercent === first.usedPercent && entry.resetsAt === first.resetsAt,
      );
    if (uniform) {
      windows.push({
        label: formatWindowLabel(providerFamilyName(first.providerId), first.cadence),
        providerIds: [first.providerId],
        resetsAt: first.resetsAt,
        usedPercent: first.usedPercent,
      });
    } else {
      for (const entry of group) {
        windows.push({
          label: formatWindowLabel(entry.modelId, entry.cadence),
          resetsAt: entry.resetsAt,
          scope: { kind: "model", modelId: entry.modelId, providerId: entry.providerId },
          usedPercent: entry.usedPercent,
        });
      }
    }
  }
  return capWindows(windows, now);
}

function capWindows(
  windows: readonly HarnessObservedUsageWindow[],
  now: number,
): readonly HarnessObservedUsageWindow[] {
  if (windows.length <= harnessObservedUsageMaxWindows) return windows;
  const keepIndices = new Set(
    windows
      .map((window, index) => ({
        actionable: isActionableWindow(window) ? 1 : 0,
        active: usageWindowHasReset(window.resetsAt, now) ? 0 : 1,
        index,
        usedPercent: window.usedPercent,
      }))
      .sort(
        (left, right) =>
          right.active - left.active ||
          right.actionable - left.actionable ||
          right.usedPercent - left.usedPercent ||
          left.index - right.index,
      )
      .slice(0, harnessObservedUsageMaxWindows)
      .map(({ index }) => index),
  );
  return windows.filter((_, index) => keepIndices.has(index));
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

async function resolveAccessToken(input: {
  readonly cliTokenPath?: string;
  readonly now: number;
  readonly request: typeof fetch;
  readonly signal: AbortSignal;
  readonly tokenPath: string;
}): Promise<{ readonly accessToken: string; readonly projectId?: string } | undefined> {
  if (input.cliTokenPath) {
    let rawCliToken: string | undefined;
    try {
      rawCliToken = await readFile(input.cliTokenPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (rawCliToken !== undefined) {
      // A 1.5 CLI token file is authoritative for this profile: never silently fall back
      // to a potentially stale or different-account legacy `acp_token.json` when it expires.
      try {
        const cliToken = CliTokenFileSchema.parse(JSON.parse(rawCliToken));
        const expiryMs = cliToken.token.expiry ? Date.parse(cliToken.token.expiry) : Number.NaN;
        if (
          !cliToken.token.expiry ||
          (Number.isFinite(expiryMs) && expiryMs > input.now + 30_000)
        ) {
          return { accessToken: cliToken.token.access_token };
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
  }
  let token: z.infer<typeof TokenFileSchema>;
  try {
    token = TokenFileSchema.parse(JSON.parse(await readFile(input.tokenPath, "utf8")));
  } catch {
    return undefined;
  }
  const refreshed = TokenResponseSchema.parse(
    await requestJson(
      input.request,
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
      input.signal,
    ),
  );
  return {
    accessToken: refreshed.access_token,
    ...(token.project_id ? { projectId: token.project_id } : {}),
  };
}

/** Reads Google's account quota without exposing or retaining OAuth credentials. */
export async function readAntigravityUsage(input: {
  readonly authMethod: AntigravityAuthMethod;
  readonly cliTokenPath?: string;
  readonly fetch?: typeof fetch;
  readonly now?: number;
  readonly signal: AbortSignal;
  readonly tokenPath: string;
}): Promise<HarnessObservedUsage | undefined> {
  if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
    return undefined;
  }
  const now = input.now ?? Date.now();
  const request = input.fetch ?? fetch;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const credential = await resolveAccessToken({
    ...(input.cliTokenPath ? { cliTokenPath: input.cliTokenPath } : {}),
    now,
    request,
    signal,
    tokenPath: input.tokenPath,
  });
  if (!credential) return undefined;
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    "content-type": "application/json",
    "user-agent": `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch})`,
  };
  const body = JSON.stringify(credential.projectId ? { project: credential.projectId } : {});
  const fetchOperation = async <T>(
    operation: string,
    parse: (value: unknown) => T,
    fallback: T,
  ): Promise<readonly T[]> =>
    Promise.all(
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
          return fallback;
        }
      }),
    );

  const summaryAnswers = (
    await fetchOperation("retrieveUserQuotaSummary", (value) => summaryWindows(value, now), [])
  ).flat();
  const mergedSummary = new Map<string, HarnessObservedUsageWindow>();
  for (const { key, window } of summaryAnswers) {
    const previous = mergedSummary.get(key);
    if (!previous || moreConstrained(window, previous, now)) {
      mergedSummary.set(key, window);
    }
  }
  const summaryResult = [...mergedSummary.values()];
  let windows: readonly HarnessObservedUsageWindow[] = capWindows(summaryResult, now);
  if (
    !summaryResult.some(
      (window) => isActionableWindow(window) && !usageWindowHasReset(window.resetsAt, now),
    )
  ) {
    const modelAnswers = await fetchOperation("fetchAvailableModels", parseModelsResponse, {
      hasUnattributedEntry: false,
      modelsByProvider: new Map(),
      quotas: [],
    });
    const modelResult = projectModelQuotas(modelAnswers, now);
    if (modelResult.length > 0) {
      windows = capWindows([...modelResult, ...summaryResult], now);
    }
  }
  if (windows.length === 0) return undefined;
  return {
    limitReached: windows.some(
      (window) => usageWindowIsAccountWide(window) && window.usedPercent >= 100,
    ),
    observedAt: new Date(now).toISOString(),
    windows,
  };
}
