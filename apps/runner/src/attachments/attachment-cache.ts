import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve } from "node:path";
import { AttachmentPageSchema, ThreadIdSchema, type ReadyAttachment } from "@opensteer/core";
import { runnerHttpTransport, type RunnerTransportPolicy } from "@opensteer/runner-client";
import {
  ensurePrivateDirectory,
  noFollowFlag,
  setPrivateHandleMode,
} from "@opensteer/shared/privateFiles";

export type ReadyRunnerAttachment = ReadyAttachment;
export interface ResolvedRunnerAttachment {
  readonly attachment: ReadyRunnerAttachment;
  readonly path: string;
}

export interface AttachmentCapabilityPlan {
  readonly token: string;
}

/**
 * A model-visible cache separate from Runner identity, profile and thread state.
 * The Host inventory is scoped to references the current Run may see, and every
 * use verifies bytes. Each file lives at `<Thread>/<attachment ID>/<name>`: the
 * immutable ID keeps paths unique, and the leaf keeps the name the user gave
 * it, reduced to one safe path segment, because whatever reads the file — an
 * upload form, a model, a command — takes its name and type from it.
 */
export class AttachmentCache {
  readonly #root: string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #transport: RunnerTransportPolicy;
  readonly #preparations = new Map<string, Promise<void>>();

  constructor(options: {
    readonly root: string;
    readonly transport: RunnerTransportPolicy;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#root = resolve(options.root);
    this.#fetch = options.fetch;
    this.#transport = options.transport;
  }

  get root(): string {
    return this.#root;
  }

  /** The Host is authoritative; a new Runner reconstructs this disposable cache. */
  async reset(): Promise<void> {
    await rm(this.#root, { force: true, recursive: true });
    await ensurePrivateDirectory(this.#root);
  }

  async clear(threadId: string): Promise<void> {
    ThreadIdSchema.parse(threadId);
    const prior = this.#preparations.get(threadId) ?? Promise.resolve();
    await prior;
    await rm(join(this.#root, threadId), { force: true, recursive: true });
  }

  async prepare(input: {
    readonly plan: AttachmentCapabilityPlan;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<ReadonlyMap<string, ResolvedRunnerAttachment>> {
    const prior = this.#preparations.get(input.threadId) ?? Promise.resolve();
    const result = prior.then(() => this.#prepareLocked(input));
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#preparations.set(input.threadId, settled);
    try {
      return await result;
    } finally {
      if (this.#preparations.get(input.threadId) === settled)
        this.#preparations.delete(input.threadId);
    }
  }

  async #prepareLocked(input: {
    readonly plan: AttachmentCapabilityPlan;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<ReadonlyMap<string, ResolvedRunnerAttachment>> {
    if (!ThreadIdSchema.safeParse(input.threadId).success) {
      throw new Error("Invalid attachment cache Thread ID");
    }
    await ensurePrivateDirectory(this.#root, "Attachment cache root is not a directory");
    const directory = join(this.#root, input.threadId);
    await ensurePrivateDirectory(directory, "Attachment cache Thread path is not a directory");
    const inventory = new Map<string, ReadyRunnerAttachment>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const path = `/v1/runner/attachments${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`;
      const response = await this.#request(path, input.plan.token, input.signal);
      if (response.status !== 200)
        throw new Error(`Attachment inventory failed (${response.status})`);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > 256 * 1024) throw new Error("Attachment inventory page is too large");
        chunks.push(Buffer.from(chunk));
      }
      const parsed = AttachmentPageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      for (const attachment of parsed.attachments) {
        if (inventory.has(attachment.id)) throw new Error("Attachment inventory repeated an ID");
        if (attachment.threadId !== input.threadId || !attachment.messageId) {
          throw new Error("Attachment inventory returned an unbound or foreign Thread file");
        }
        inventory.set(attachment.id, attachment);
      }
      cursor = parsed.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Attachment inventory cursor repeated");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const entry of await readdir(directory)) {
      if (!inventory.has(entry)) await rm(join(directory, entry), { force: true, recursive: true });
    }
    const result = new Map<string, ResolvedRunnerAttachment>();
    for (const attachment of inventory.values()) {
      const folder = join(directory, attachment.id);
      await ensurePrivateDirectory(folder, "Attachment cache entry is not a directory");
      const path = join(folder, attachmentFileName(attachment.name));
      await this.#ensureVerified(path, attachment, input.plan, input.signal);
      result.set(attachment.id, { attachment, path });
    }
    return result;
  }

  async #ensureVerified(
    path: string,
    attachment: ReadyRunnerAttachment,
    plan: AttachmentCapabilityPlan,
    signal: AbortSignal,
  ): Promise<void> {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isFile() && (await verifiedFile(path, attachment))) return;
    if (existing && !existing.isFile())
      throw new Error("Attachment cache path is not a regular file");

    const temporary = `${path}.${randomUUID()}.partial`;
    const response = await this.#request(
      `/v1/runner/attachments/${encodeURIComponent(attachment.id)}/content`,
      plan.token,
      signal,
    );
    if (response.status !== 200) throw new Error(`Attachment download failed (${response.status})`);
    const output = await open(temporary, "wx", 0o600);
    let installed = false;
    try {
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        if (length > attachment.sizeBytes)
          throw new Error("Attachment download exceeded declared size");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await output.write(chunk, offset, chunk.byteLength - offset);
          if (written.bytesWritten === 0) throw new Error("Attachment cache write stalled");
          offset += written.bytesWritten;
        }
      }
      await output.sync();
      if (length !== attachment.sizeBytes) throw new Error("Attachment download size mismatch");
      if (hash.digest("hex") !== attachment.sha256) throw new Error("Attachment checksum mismatch");
      await setPrivateHandleMode(output, 0o444);
      await output.close();
      await rename(temporary, path);
      installed = true;
    } finally {
      await output.close().catch(() => undefined);
      if (!installed) await rm(temporary, { force: true });
    }
  }

  async #request(
    path: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly body: AsyncIterable<Uint8Array> }> {
    const { url, ca } = await runnerHttpTransport(this.#transport, path);
    const headers = { authorization: `Bearer ${token}` };
    if (this.#fetch) {
      const response = await this.#fetch(url, { headers, redirect: "error", signal });
      if (!response.body) throw new Error("Host returned an empty attachment response");
      return { status: response.status, body: response.body };
    }
    const body = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const request =
        url.protocol === "https:"
          ? httpsRequest(url, { ca, headers, signal }, resolveResponse)
          : httpRequest(url, { headers, signal }, resolveResponse);
      request.once("error", reject);
      request.end();
    });
    return { status: body.statusCode ?? 0, body };
  }
}

async function verifiedFile(path: string, attachment: ReadyRunnerAttachment): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size !== attachment.sizeBytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex") === attachment.sha256;
  } finally {
    await handle.close();
  }
}

/** The user's file name as one path segment of at most 255 bytes, extension kept. */
function attachmentFileName(name: string): string {
  const cleaned = name.replace(/[/\\\p{Cc}]/gu, "_").trim();
  const safe = cleaned === "" || cleaned === "." || cleaned === ".." ? "attachment" : cleaned;
  if (Buffer.byteLength(safe, "utf8") <= 255) return safe;
  const extension = extname(safe).slice(0, 16);
  let stem = safe.slice(0, safe.length - extension.length);
  while (Buffer.byteLength(stem + extension, "utf8") > 255) stem = stem.slice(0, -1);
  return stem + extension;
}
