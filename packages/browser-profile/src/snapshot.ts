import { z } from "zod";

export const maxBrowserProfileSnapshotBytes = 64 * 1_024 * 1_024;
export const browserProfileSnapshotVersion = 2;
// Chromium StorageAreaMap counts both keys and values as two bytes per UTF-16 code unit.
export const maxBrowserLocalStorageBytes = 10 * 1_024 * 1_024;

export const BrowserCookieSchema = z.strictObject({
  domain: z.string().min(1).max(4_096),
  expires: z.number().finite(),
  httpOnly: z.boolean(),
  hostOnly: z.boolean().optional(),
  name: z.string().max(4_096),
  path: z.string().min(1).max(4_096),
  partitionKey: z.url().max(16_384).optional(),
  partitionKeyHasCrossSiteAncestor: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  secure: z.boolean(),
  value: z.string().max(64 * 1_024),
});

const LocalStorageEntrySchema = z.strictObject({
  name: z.string().max(maxBrowserLocalStorageBytes / 2),
  value: z.string().max(maxBrowserLocalStorageBytes / 2),
});

const IndexedDbRecordSchema = z
  .strictObject({
    key: z.unknown().optional(),
    keyEncoded: z.unknown().optional(),
    value: z.unknown().optional(),
    valueEncoded: z.unknown().optional(),
  })
  .refine((record) => record.value !== undefined || record.valueEncoded !== undefined, {
    message: "IndexedDB record is missing its value.",
  })
  .refine((record) => !(record.value !== undefined && record.valueEncoded !== undefined), {
    message: "IndexedDB record has two value encodings.",
  })
  .refine((record) => !(record.key !== undefined && record.keyEncoded !== undefined), {
    message: "IndexedDB record has two key encodings.",
  });

const IndexedDbIndexSchema = z.strictObject({
  keyPath: z.string().max(16_384).optional(),
  keyPathArray: z.array(z.string().max(16_384)).max(128).optional(),
  multiEntry: z.boolean(),
  name: z.string().max(16_384),
  unique: z.boolean(),
});

const IndexedDbStoreSchema = z.strictObject({
  autoIncrement: z.boolean(),
  indexes: z.array(IndexedDbIndexSchema).max(1_000),
  keyPath: z.string().max(16_384).optional(),
  keyPathArray: z.array(z.string().max(16_384)).max(128).optional(),
  name: z.string().max(16_384),
  records: z.array(IndexedDbRecordSchema).max(100_000),
});

const IndexedDbDatabaseSchema = z.strictObject({
  name: z.string().min(1).max(16_384),
  stores: z.array(IndexedDbStoreSchema).max(1_000),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const BrowserOriginStateSchema = z.strictObject({
  indexedDB: z.array(IndexedDbDatabaseSchema).max(1_000).optional(),
  localStorage: z.array(LocalStorageEntrySchema).superRefine((entries, context) => {
    let bytes = 0;
    const keys = new Set<string>();
    for (const entry of entries) {
      bytes += 2 * (entry.name.length + entry.value.length);
      if (keys.has(entry.name)) {
        context.addIssue({ code: "custom", message: "Duplicate localStorage key." });
        return;
      }
      keys.add(entry.name);
    }
    if (bytes > maxBrowserLocalStorageBytes)
      context.addIssue({
        code: "custom",
        message: "localStorage exceeds Chromium's 10 MiB per-origin quota.",
      });
  }),
  origin: z
    .url()
    .max(16_384)
    .refine((value) => new URL(value).origin === value, "Browser storage key must be an origin."),
});

export const BrowserProfileSnapshotSchema = z.strictObject({
  cookies: z.array(BrowserCookieSchema).max(10_000),
  origins: z.array(BrowserOriginStateSchema).max(5_000),
});
export type BrowserProfileSnapshot = z.infer<typeof BrowserProfileSnapshotSchema>;
export type BrowserCookie = z.infer<typeof BrowserCookieSchema>;
export type BrowserOriginState = z.infer<typeof BrowserOriginStateSchema>;

export const EmptyBrowserProfileSnapshot: BrowserProfileSnapshot = Object.freeze({
  cookies: [],
  origins: [],
});

export function encodeBrowserProfileSnapshot(snapshot: BrowserProfileSnapshot): Uint8Array {
  const parsed = BrowserProfileSnapshotSchema.parse(snapshot);
  const encoded = new TextEncoder().encode(JSON.stringify(parsed));
  if (encoded.byteLength > maxBrowserProfileSnapshotBytes) {
    throw new Error("Browser profile snapshot exceeds its 64 MiB limit.");
  }
  return encoded;
}

export function decodeBrowserProfileSnapshot(encoded: Uint8Array): BrowserProfileSnapshot {
  if (encoded.byteLength > maxBrowserProfileSnapshotBytes) {
    throw new Error("Browser profile snapshot exceeds its 64 MiB limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
  } catch (error) {
    throw new Error("Browser profile snapshot is not valid UTF-8 JSON.", { cause: error });
  }
  return BrowserProfileSnapshotSchema.parse(value);
}

export interface BrowserOriginCaptureFailure {
  readonly origin: string | null;
  readonly reason: "invalid" | "capture" | "snapshot-size";
  readonly retained: boolean;
}

export class IncompleteBrowserProfileSnapshotError extends Error {
  readonly #snapshot: BrowserProfileSnapshot;
  readonly failures: readonly BrowserOriginCaptureFailure[];
  constructor(snapshot: BrowserProfileSnapshot, failures: readonly BrowserOriginCaptureFailure[]) {
    super("Browser profile snapshot is incomplete; some sites could not be saved.");
    this.name = "IncompleteBrowserProfileSnapshotError";
    this.#snapshot = snapshot;
    this.failures = failures;
  }

  get snapshot(): BrowserProfileSnapshot {
    return this.#snapshot;
  }
}

/** Validate at the producer boundary, retaining the last capture of rejected sites.
 * Strict decoding still rejects malformed snapshots from storage or the network.
 * Reports contain origins and reasons only, never storage keys, values or raw errors. */
export function captureBrowserProfileSnapshot(input: {
  readonly cookies: unknown;
  readonly origins: readonly unknown[];
  readonly previous: BrowserProfileSnapshot;
  readonly failedOrigins?: readonly string[];
  readonly onOriginFailure?: (failure: BrowserOriginCaptureFailure) => void;
}): BrowserProfileSnapshot {
  const cookies = BrowserProfileSnapshotSchema.shape.cookies.parse(input.cookies);
  const previous = new Map(input.previous.origins.map((state) => [state.origin, state]));
  const originKeys = input.origins.map((candidate) =>
    z.object({ origin: BrowserOriginStateSchema.shape.origin }).safeParse(candidate),
  );
  const originCounts = new Map<string, number>();
  for (const key of originKeys)
    if (key.success)
      originCounts.set(key.data.origin, (originCounts.get(key.data.origin) ?? 0) + 1);
  const attempted = new Set([
    ...originKeys.flatMap((key) => (key.success ? [key.data.origin] : [])),
    ...(input.failedOrigins ?? []),
  ]);
  const states = new Map([...previous].filter(([origin]) => attempted.has(origin)));
  const failures: BrowserOriginCaptureFailure[] = [];
  const originBytes = (state: BrowserOriginState) =>
    new TextEncoder().encode(JSON.stringify(state)).byteLength;
  let bytes = new TextEncoder().encode(
    JSON.stringify({ cookies, origins: [...states.values()] }),
  ).byteLength;
  // The saved baseline must fit before replacing any site with a newer capture.
  if (bytes > maxBrowserProfileSnapshotBytes)
    throw new Error("Browser profile snapshot exceeds its 64 MiB limit.");
  const reject = (origin: string | null, reason: BrowserOriginCaptureFailure["reason"]) => {
    failures.push({ origin, reason, retained: origin !== null && previous.has(origin) });
  };
  for (const origin of input.failedOrigins ?? []) reject(origin, "capture");
  const seen = new Set<string>();
  for (const candidate of input.origins) {
    const parsed = BrowserOriginStateSchema.safeParse(candidate);
    const key = z.object({ origin: BrowserOriginStateSchema.shape.origin }).safeParse(candidate);
    const origin = key.success ? key.data.origin : null;
    if (!parsed.success || (origin !== null && (originCounts.get(origin) ?? 0) > 1)) {
      reject(origin, "invalid");
      continue;
    }
    const state = parsed.data;
    seen.add(state.origin);
    const old = states.get(state.origin);
    const nextBytes =
      bytes +
      originBytes(state) -
      (old ? originBytes(old) : 0) +
      (old || states.size === 0 ? 0 : 1);
    if (nextBytes > maxBrowserProfileSnapshotBytes || (!old && states.size >= 5_000)) {
      reject(state.origin, "snapshot-size");
      continue;
    }
    bytes = nextBytes;
    states.set(state.origin, state);
  }
  // Successful sites keep producer order; retained sites follow them.
  const origins = [...seen].flatMap((origin) => (states.has(origin) ? [states.get(origin)!] : []));
  for (const [origin, state] of states) if (!seen.has(origin)) origins.push(state);
  const snapshot = BrowserProfileSnapshotSchema.parse({ cookies, origins });
  if (failures.length > 0 && !input.onOriginFailure)
    throw new IncompleteBrowserProfileSnapshotError(snapshot, failures);
  for (const failure of failures) input.onOriginFailure?.(failure);
  return snapshot;
}
