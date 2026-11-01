import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { LocalProfileBindingSchema, type LocalProfileBinding } from "@opensteer/protocol";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
  serializePrivateFileCommit,
} from "@opensteer/shared/atomicPrivateFile";
import {
  ProtectedJsonFile,
  ProtectedStateUnreadableError,
  ProtectedStorageUnavailableError,
  type DesktopSecretCryptography,
} from "../secrets/protected-json-file.js";

const maximumBytes = 16 * 1_024 * 1_024;
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const partitionKeySchema = z.strictObject({
  topLevelSite: z.url(),
  hasCrossSiteAncestor: z.boolean(),
});
const recordSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  hostOnly: z.boolean(),
  path: z.string(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  priority: z.enum(["Low", "Medium", "High"]),
  sourceScheme: z.enum(["Unset", "NonSecure", "Secure"]),
  sourcePort: z.number().int(),
  partitionKey: partitionKeySchema.optional(),
});
const cdpCookieSchema = z.object({
  ...recordSchema.omit({ hostOnly: true }).shape,
  expires: z.number(),
  session: z.boolean(),
  partitionKeyOpaque: z.boolean().optional(),
});
const plaintextSchema = z.strictObject({
  version: z.literal(1),
  binding: LocalProfileBindingSchema,
  sequence: sequenceSchema,
  cookies: z.array(recordSchema),
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  sequence: sequenceSchema,
  nonce: base64,
  ciphertext: base64,
  tag: base64,
});
const keySchema = z.strictObject({
  version: z.literal(1),
  binding: LocalProfileBindingSchema,
  key: base64,
});
type SessionCookieRecord = z.infer<typeof recordSchema>;

interface SessionCookieMirrorOptions {
  /** Opensteer's profile directory, outside Chromium's native subdirectory. */
  readonly directory: string;
  readonly binding: LocalProfileBinding;
  readonly cryptography: DesktopSecretCryptography;
  readonly platform?: NodeJS.Platform;
  /** Network.getAllCookies on a private target in this exact Session. */
  readonly capture: () => Promise<unknown[]>;
  readonly restore: (cookies: readonly Record<string, unknown>[]) => Promise<void>;
  readonly subscribe: (invalidate: () => void) => () => void;
  readonly onFailure: (error: unknown) => void;
  readonly onIdle?: () => void;
  readonly publish?: (file: string, content: string, assertCurrent: () => void) => Promise<void>;
}

/** One lane for cookie capture, publication and Opensteer-controlled mutations. */
export class SessionCookieMirror {
  readonly #options: SessionCookieMirrorOptions;
  readonly #binding: LocalProfileBinding;
  readonly #keyFile: ProtectedJsonFile<z.infer<typeof keySchema>>;
  readonly #file: string;
  readonly #unsubscribe: () => void;
  #key: Buffer | undefined;
  #sequence = 0;
  #canonical: string | undefined;
  #lane: Promise<unknown> = Promise.resolve();
  #pumping = false;
  #suspended = true;
  #epoch = 0;
  #dirty = 0;
  #captured = 0;
  #failure: unknown;
  #stopped = false;
  readonly #waiters = new Set<{
    generation: number;
    resolve(): void;
    reject(error: unknown): void;
  }>();

  constructor(options: SessionCookieMirrorOptions) {
    this.#options = options;
    this.#binding = LocalProfileBindingSchema.parse(options.binding);
    this.#file = path.join(options.directory, "session-cookies.v1.json");
    this.#keyFile = new ProtectedJsonFile({
      content: "critical",
      cryptography: options.cryptography,
      filePath: path.join(options.directory, "session-cookie-key.v1.json"),
      maxFileBytes: 16_384,
      maxPlaintextBytes: 8_192,
      messages: {
        protectedStore: "Browser profile cookie key",
        protectedState: "Browser profile cookie key",
      },
      schema: keySchema,
      assertCurrent: () => {
        if (this.#stopped) throw unreadable();
      },
      ...(options.platform ? { platform: options.platform } : {}),
    });
    // Cookie events omit partition keys. Their only authority is invalidation.
    this.#unsubscribe = options.subscribe(() => {
      this.#dirty++;
      this.#pump();
    });
  }

  /** Only the runtime's positively identified initializing profile may create sidecars. */
  initialize(
    importAndFlush: () => Promise<void>,
    commitStorage?: () => Promise<void>,
  ): Promise<void> {
    const epoch = this.#epoch;
    return this.#enqueue(async () => {
      await this.#loadKey(true);
      await importAndFlush();
      if (this.#epoch !== epoch) throw unreadable();
      const generation = this.#dirty;
      await this.#capture(epoch, true);
      await commitStorage?.();
      if (this.#epoch !== epoch) throw unreadable();
      this.#captured = generation;
      this.#suspended = false;
      this.#settle();
      this.#pump();
    });
  }

  /** Synchronous: no capture taken after a NetworkContext restart may replace the mirror. */
  suspend(): void {
    this.#suspended = true;
    this.#epoch++;
  }

  /** The gate remains closed until this has restored and reconciled the complete jar. */
  recover(): Promise<boolean> {
    const epoch = this.#epoch;
    return this.#enqueue(async () => {
      try {
        const saved = await this.#read(this.#loadKey(false));
        this.#sequence = saved.sequence;
        this.#canonical = canonicalCookies(saved.cookies);
        const live = parseCookieJar(await this.#options.capture());
        if (epoch !== this.#epoch) return false;
        const persistent = new Set(live.filter((cookie) => !cookie.session).map(cookieIdentity));
        const restoring = saved.cookies.filter((cookie) => !persistent.has(cookieIdentity(cookie)));
        if (restoring.length) await this.#options.restore(restoring.map(cookieParameters));
        if (epoch !== this.#epoch) return false;
        const generation = this.#dirty;
        await this.#capture(epoch, true, restoring);
        if (epoch !== this.#epoch) return false;
        this.#captured = generation;
        this.#suspended = false;
        this.#settle();
        this.#pump();
        return true;
      } catch (error) {
        if (epoch !== this.#epoch) return false;
        throw error;
      }
    });
  }

  /** Event delivery can lag an acknowledged cookie write: always demand a new capture. */
  flush(): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#stopped) return Promise.reject(unreadable());
    const generation = ++this.#dirty;
    const result = new Promise<void>((resolve, reject) =>
      this.#waiters.add({ generation, resolve, reject }),
    );
    this.#pump();
    return result;
  }

  async mutate(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    // A flush waits out suspension without occupying the lane needed by recovery.
    await this.flush();
    const epoch = this.#epoch;
    const interrupted = new Error(
      "Browser profile recovery interrupted the cookie operation. Try again.",
    );
    await this.#enqueue(
      async () => {
        if (this.#suspended || this.#epoch !== epoch) throw interrupted;
        await operation();
        if (this.#suspended || this.#epoch !== epoch) throw interrupted;
      },
      (error) => error !== interrupted && !(signal?.aborted && error === signal.reason),
    );
    await this.flush();
  }

  /** Disable before clearing a deleted profile; never publish an empty shutdown jar. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.suspend();
    this.#unsubscribe();
    for (const waiter of this.#waiters) waiter.reject(unreadable());
    this.#waiters.clear();
    void this.#lane
      .finally(() => {
        this.#key?.fill(0);
      })
      .catch(() => undefined);
    this.#key?.fill(0);
    this.#key = undefined;
    this.#canonical = undefined;
  }

  #enqueue<T>(
    operation: () => Promise<T>,
    fatal: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const result = this.#lane.then(async () => {
      try {
        if (this.#failure) throw this.#failure;
        if (this.#stopped) throw unreadable();
        return await operation();
      } finally {
        this.#options.onIdle?.();
      }
    });
    this.#lane = result.catch((error: unknown) => {
      if (!fatal(error)) return;
      const failure =
        error instanceof ProtectedStorageUnavailableError ||
        error instanceof ProtectedStateUnreadableError
          ? error
          : new Error("Browser profile cookie persistence failed. The profile was preserved.", {
              cause: error,
            });
      this.#failure = failure;
      this.#suspended = true;
      this.#options.onFailure(failure);
      for (const waiter of this.#waiters) waiter.reject(failure);
      this.#waiters.clear();
    });
    return result.catch((error: unknown) => {
      throw this.#failure ?? error;
    });
  }

  #pump(): void {
    if (
      this.#pumping ||
      this.#suspended ||
      this.#stopped ||
      this.#failure ||
      this.#dirty <= this.#captured
    )
      return;
    this.#pumping = true;
    void this.#enqueue(async () => {
      while (!this.#suspended && !this.#stopped && this.#dirty > this.#captured) {
        const generation = this.#dirty;
        const epoch = this.#epoch;
        await this.#capture(epoch);
        if (this.#suspended || this.#epoch !== epoch) break;
        this.#captured = generation;
        this.#settle();
      }
    })
      .finally(() => {
        this.#pumping = false;
        this.#pump();
      })
      .catch(() => undefined);
  }

  #settle(): void {
    for (const waiter of this.#waiters)
      if (waiter.generation <= this.#captured) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
  }

  async #loadKey(create: boolean): Promise<void> {
    // A retired writer may already have issued its rename. Observe it before reading.
    await serializePrivateFileCommit(
      path.join(this.#options.directory, "session-cookie-key.v1.json"),
      async () => {},
    );
    if (this.#stopped) throw unreadable();
    // Availability must be checked on reopen/recovery even with a cached key.
    await this.#keyFile.assertAvailable();
    if (this.#stopped) throw unreadable();
    if (this.#key) return;
    let wrapped = await this.#keyFile.read();
    if (!wrapped) {
      if (!create) throw unreadable();
      wrapped = { version: 1, binding: this.#binding, key: randomBytes(32).toString("base64") };
      await this.#keyFile.write(wrapped);
    }
    if (JSON.stringify(wrapped.binding) !== JSON.stringify(this.#binding)) throw unreadable();
    const key = Buffer.from(wrapped.key, "base64");
    if (key.length !== 32) throw unreadable();
    if (this.#stopped) {
      key.fill(0);
      throw unreadable();
    }
    this.#key = key;
  }

  async #read(keyReady: Promise<void>): Promise<z.infer<typeof plaintextSchema>> {
    const [read, key] = await Promise.allSettled([
      serializePrivateFileCommit(this.#file, async () => {}).then(() =>
        readPrivateFileText(this.#file, maximumBytes, { invalid: unreadable, exposed: unreadable }),
      ),
      keyReady,
    ]);
    if (key.status === "rejected") throw key.reason;
    if (read.status === "rejected") throw read.reason;
    const text = read.value;
    if (!text) throw unreadable();
    try {
      const envelope = envelopeSchema.parse(JSON.parse(text));
      const nonce = Buffer.from(envelope.nonce, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) throw unreadable();
      const decipher = createDecipheriv("aes-256-gcm", this.#key!, nonce);
      decipher.setAAD(this.#aad(envelope.sequence));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const saved = plaintextSchema.parse(JSON.parse(plaintext.toString("utf8")));
      if (
        saved.sequence !== envelope.sequence ||
        JSON.stringify(saved.binding) !== JSON.stringify(this.#binding)
      )
        throw unreadable();
      return saved;
    } catch {
      throw unreadable();
    }
  }

  async #capture(
    epoch: number,
    restoring = false,
    required: SessionCookieRecord[] = [],
  ): Promise<void> {
    let captured: unknown[];
    try {
      captured = await this.#options.capture();
    } catch (error) {
      if (epoch !== this.#epoch || this.#stopped) return;
      throw error;
    }
    if (epoch !== this.#epoch || this.#stopped || (this.#suspended && !restoring)) return;
    const cookies = parseCookieJar(captured).flatMap((cookie) => {
      if (!cookie.session) return [];
      const {
        expires: _expires,
        session: _session,
        partitionKeyOpaque: _opaque,
        ...record
      } = cookie;
      return [recordSchema.parse({ ...record, hostOnly: !cookie.domain.startsWith(".") })];
    });
    if (this.#epoch !== epoch || this.#stopped || (this.#suspended && !restoring)) return;
    for (const cookie of required) {
      if (!cookies.some((actual) => JSON.stringify(actual) === JSON.stringify(cookie)))
        throw unreadable();
    }
    const canonical = canonicalCookies(cookies);
    if (canonical === this.#canonical) return;
    const sequence = this.#sequence + 1;
    sequenceSchema.parse(sequence);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key!, nonce);
    cipher.setAAD(this.#aad(sequence));
    const plaintext = JSON.stringify({
      version: 1,
      binding: this.#binding,
      sequence,
      cookies: JSON.parse(canonical),
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const serialized = JSON.stringify({
      version: 1,
      sequence,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
    if (Buffer.byteLength(serialized) > maximumBytes) throw unreadable();
    await (this.#options.publish ?? replacePrivateFileAtomically)(this.#file, serialized, () => {
      if (epoch !== this.#epoch || this.#stopped || (this.#suspended && !restoring))
        throw unreadable();
    });
    if (epoch !== this.#epoch || this.#stopped) return;
    this.#sequence = sequence;
    this.#canonical = canonical;
  }

  #aad(sequence: number): Buffer {
    return Buffer.from(JSON.stringify({ binding: this.#binding, sequence }));
  }
}

function unreadable(): Error {
  return new ProtectedStateUnreadableError(
    "Browser profile session cookies are missing, incompatible or corrupt. The profile was preserved.",
  );
}
// Scheme/port-bound cookie keys are disabled in the pinned Chromium 152.0.7977.167.
function cookieIdentity(cookie: {
  name: string;
  domain: string;
  path: string;
  partitionKey?: z.infer<typeof partitionKeySchema> | undefined;
}): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);
}
function canonicalCookies(cookies: SessionCookieRecord[]): string {
  return JSON.stringify(
    cookies.sort((a, b) =>
      cookieIdentity(a) < cookieIdentity(b) ? -1 : cookieIdentity(a) > cookieIdentity(b) ? 1 : 0,
    ),
  );
}
function cookieParameters(cookie: SessionCookieRecord): Record<string, unknown> {
  const { hostOnly, domain, ...parameters } = cookie;
  return {
    ...parameters,
    ...(hostOnly ? { url: `${cookie.secure ? "https" : "http"}://${domain}/` } : { domain }),
  };
}

function parseCookieJar(values: unknown[]): z.infer<typeof cdpCookieSchema>[] {
  return values.flatMap((value) => {
    if (z.object({ partitionKeyOpaque: z.boolean().optional() }).parse(value).partitionKeyOpaque)
      return [];
    return [cdpCookieSchema.parse(value)];
  });
}
