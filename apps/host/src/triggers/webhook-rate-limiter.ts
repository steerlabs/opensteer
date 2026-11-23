const defaultWindowMs = 60_000;
const defaultPerIpLimit = 60;
const defaultPerRouteLimit = 120;
const defaultMaxBuckets = 10_000;

interface SlidingBucket {
  readonly timestamps: number[];
}

export interface WebhookRateLimiterOptions {
  readonly maxBuckets?: number;
  readonly now?: () => number;
  readonly perIpLimit?: number;
  readonly perRouteLimit?: number;
  readonly windowMs?: number;
}

export type WebhookRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Bounded in-memory sliding-window limiter checked BEFORE PostgreSQL (T7 / Y3).
 * Prevents unknown-key floods or hot-key bursts from consuming DB connections
 * or exhausting memory under random-IP / random-path spraying.
 */
export class WebhookRateLimiter {
  readonly #ipBuckets = new Map<string, SlidingBucket>();
  readonly #routeBuckets = new Map<string, SlidingBucket>();
  readonly #maxBuckets: number;
  readonly #now: () => number;
  readonly #perIpLimit: number;
  readonly #perRouteLimit: number;
  readonly #windowMs: number;

  constructor(options: WebhookRateLimiterOptions = {}) {
    this.#maxBuckets = options.maxBuckets ?? defaultMaxBuckets;
    this.#now = options.now ?? (() => Date.now());
    this.#perIpLimit = options.perIpLimit ?? defaultPerIpLimit;
    this.#perRouteLimit = options.perRouteLimit ?? defaultPerRouteLimit;
    this.#windowMs = options.windowMs ?? defaultWindowMs;
  }

  consume(ip: string, routeKey: string): WebhookRateLimitDecision {
    const now = this.#now();
    const ipCheck = this.#check(this.#ipBuckets, ip, this.#perIpLimit, now);
    if (!ipCheck.allowed) return ipCheck;
    const routeCheck = this.#check(this.#routeBuckets, routeKey, this.#perRouteLimit, now);
    if (!routeCheck.allowed) return routeCheck;
    this.#record(this.#ipBuckets, ip, now);
    this.#record(this.#routeBuckets, routeKey, now);
    return { allowed: true };
  }

  #check(
    buckets: Map<string, SlidingBucket>,
    key: string,
    limit: number,
    now: number,
  ): WebhookRateLimitDecision {
    const bucket = buckets.get(key);
    if (!bucket) return { allowed: true };
    const cutoff = now - this.#windowMs;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) {
      bucket.timestamps.shift();
    }
    if (bucket.timestamps.length === 0) {
      buckets.delete(key);
      return { allowed: true };
    }
    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1_000));
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true };
  }

  #record(buckets: Map<string, SlidingBucket>, key: string, now: number): void {
    const existing = buckets.get(key);
    if (existing) {
      // Refresh LRU insertion order.
      buckets.delete(key);
      existing.timestamps.push(now);
      buckets.set(key, existing);
      return;
    }
    while (buckets.size >= this.#maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
    buckets.set(key, { timestamps: [now] });
  }
}
