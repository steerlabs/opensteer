import { createHash } from "node:crypto";
import path from "node:path";
import { isNetworkPath } from "@opensteer/shared/fileHref";
import { OpensteerError } from "@opensteer/core";
import { NativeFsHelper } from "@opensteer/shared/files/native-fs-helper";

export function fileUnavailable() {
  return new OpensteerError({ code: "not_found", message: "File unavailable" });
}
export function fileTooLarge(sizeBytes: number, maxBytes: number) {
  return new OpensteerError({
    code: "resource_exhausted",
    reason: "file-too-large",
    message: `File is ${sizeBytes} bytes; too large to download here (limit ${maxBytes} bytes)`,
    details: { sizeBytes, maxBytes },
  });
}
export function rootedFileKey(segments: readonly string[]) {
  return Buffer.concat(
    segments.flatMap((s, i) => [...(i ? [Buffer.from([0])] : []), Buffer.from(s, "base64url")]),
  ).toString("base64url");
}
export function rootedFileSegments(key: string): string[] {
  if (!key || key.length > 16384 || !/^[\w-]+$/u.test(key)) throw fileUnavailable();
  const raw = Buffer.from(key, "base64url");
  if (raw.toString("base64url") !== key) throw fileUnavailable();
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++)
    if (i === raw.length || raw[i] === 0) {
      parts.push(raw.subarray(start, i));
      start = i + 1;
    }
  if (
    parts.some(
      (p) =>
        !p.length ||
        p.equals(Buffer.from(".")) ||
        p.equals(Buffer.from("..")) ||
        p.includes(47) ||
        p.includes(92),
    )
  )
    throw fileUnavailable();
  return parts.map((p) => p.toString("base64url"));
}
export function absoluteFileKey(root: string, absolutePath: string) {
  if (
    !path.isAbsolute(absolutePath) ||
    /\p{Cc}/u.test(absolutePath) ||
    (process.platform !== "win32" && absolutePath.includes("\\")) ||
    isNetworkPath(absolutePath) ||
    absolutePath.split(/[/\\]/u).some((p) => p === "." || p === "..")
  )
    throw fileUnavailable();
  const relative = path.relative(root, absolutePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw fileUnavailable();
  return rootedFileKey(relative.split(path.sep).map((p) => Buffer.from(p).toString("base64url")));
}

/** No caller can substitute a root; revisions bind the captured root and the opened file. */
export class RootedFileReader {
  readonly #lifetime = new AbortController();
  readonly options: { root: () => Promise<string>; helperPath: string | undefined };
  constructor(options: RootedFileReader["options"]) {
    this.options = options;
  }
  async #root(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.options.helperPath) throw fileUnavailable();
    const root = await this.options.root();
    const helper = new NativeFsHelper({
      binary: this.options.helperPath,
      rootPolicy: "managed-local",
    });
    const expectedRootIdentity = await helper.directoryIdentity({ root, path: "." }, signal);
    const scope = createHash("sha256")
      .update(JSON.stringify([root, expectedRootIdentity]))
      .digest("base64url");
    return { helper, root, expectedRootIdentity, scope };
  }
  async resolveAbsolutePath(absolutePath: string, signal = AbortSignal.timeout(15000)) {
    // Reject syntax and containment before invoking the native helper.
    const key = absoluteFileKey(await this.options.root(), absolutePath);
    const result = await this.read(key, { maxBytes: 1 }, signal);
    return {
      key,
      revision: result.metadata.revision,
      name: path.basename(absolutePath),
      sizeBytes: result.metadata.sizeBytes,
    };
  }
  async read(
    key: string,
    options: { maxBytes: number; expectedRevision?: string },
    signal = AbortSignal.timeout(15000),
  ) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 512 * 1024
    )
      throw fileUnavailable();
    const segments = rootedFileSegments(key);
    const { helper, scope, ...root } = await this.#root(signal);
    const expected = options.expectedRevision;
    if (
      expected &&
      (!expected.startsWith(scope + ".") || !/^[\w-]{43}\.[\w-]{43}$/u.test(expected))
    )
      throw fileUnavailable();
    const result = await helper.filesReadRange(
      {
        ...root,
        pathSegmentsBase64: segments,
        offset: 0,
        maxBytes: options.maxBytes,
        ...(expected ? { expectedFileRevision: expected.slice(44) } : {}),
      },
      signal,
    );
    return {
      ...result,
      metadata: { ...result.metadata, revision: `${scope}.${result.metadata.revision}` },
    };
  }
  async readContent(
    key: string,
    options: { expectedRevision: string; maxBytes: number },
    signal = AbortSignal.timeout(60000),
  ) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 32 * 1024 * 1024
    )
      throw fileUnavailable();
    const probe = await this.read(
      key,
      { maxBytes: 1, expectedRevision: options.expectedRevision },
      signal,
    );
    if (probe.metadata.sizeBytes > options.maxBytes)
      throw fileTooLarge(probe.metadata.sizeBytes, options.maxBytes);
    const { helper, scope, ...root } = await this.#root(signal);
    if (!options.expectedRevision.startsWith(scope + ".")) throw fileUnavailable();
    const download = await helper.filesDownload(
      {
        ...root,
        pathSegmentsBase64: rootedFileSegments(key),
        expectedFileRevision: options.expectedRevision.slice(44),
        offset: 0,
        length: 0,
      },
      signal,
    );
    try {
      if (download.length > options.maxBytes) throw fileTooLarge(download.length, options.maxBytes);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of download.stream) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > options.maxBytes) throw fileTooLarge(size, options.maxBytes);
        chunks.push(bytes);
      }
      if (size !== probe.metadata.sizeBytes) throw fileUnavailable();
      return { bytes: Buffer.concat(chunks, size), metadata: probe.metadata, eof: true };
    } finally {
      download.stream.destroy();
    }
  }
  close() {
    this.#lifetime.abort();
  }
}
