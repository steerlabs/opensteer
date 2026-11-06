import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { NativeFsHelper } from "@opensteer/workspace-local";
import {
  ensurePrivateDirectory,
  noFollowFlag,
  setPrivateHandleMode,
} from "@opensteer/shared/privateFiles";
import {
  runFileMaxBytes,
  runFileMaxPerCall,
  runFileNameHeader,
  runFileTransferContentType,
  runFileTransferPath,
  type RunFileExecution,
  type RunFileTransfer,
  type HostIntegrationsInvoke,
} from "@opensteer/protocol";
import type { RunnerTransportPolicy } from "@opensteer/runner-client";
import { attachmentFileName } from "./attachment-cache.js";
import { runnerFileRequest } from "./host-http.js";
import {
  ComputerAppError,
  type ComputerAppInvocation,
  type ComputerAppValue,
} from "../computer-apps/provider.js";

export class RunFileError extends Error {}

export interface RunFileAccess {
  readonly roots: readonly string[];
  readonly directory: string;
  readonly signal: AbortSignal;
}
export interface RunFilePort {
  withRunFiles<T>(
    execution: RunFileExecution,
    signal: AbortSignal,
    work: (access: RunFileAccess) => Promise<T>,
  ): Promise<T>;
}
const exported = z.object({
  file: z.string().min(1),
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().nonnegative().max(runFileMaxBytes),
});
const within = (root: string, path: string): boolean => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
export class RunFiles {
  readonly scratchRoot: string;
  readonly #native: NativeFsHelper;
  readonly options: {
    dataDirectory: string;
    helperBinary: string;
    transport: RunnerTransportPolicy;
    port?: RunFilePort;
  };
  constructor(options: {
    dataDirectory: string;
    helperBinary: string;
    transport: RunnerTransportPolicy;
    port?: RunFilePort;
  }) {
    this.options = options;
    this.scratchRoot = join(options.dataDirectory, "private", "app-files");
    this.#native = new NativeFsHelper({
      binary: options.helperBinary,
      rootPolicy: "managed-local",
      timeoutMilliseconds: 120_000,
    });
  }
  async scratch<T>(work: (directory: string) => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.scratchRoot);
    const directory = await mkdtemp(join(this.scratchRoot, "call-"));
    try {
      return await work(directory);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
  async source(path: string, access: RunFileAccess) {
    access.signal.throwIfAborted();
    if (path.split(/[\\/]/u).includes(".."))
      throw new RunFileError("Choose a file inside this task's Workspace.");
    const absolute = resolve(access.roots[0] ?? ".", path);
    const root = access.roots.find((root) => within(root, absolute));
    if (!root || within(resolve(this.options.dataDirectory), absolute))
      throw new RunFileError("Choose a file inside this task's Workspace or attachment directory.");
    const expectedRootIdentity = await this.#native.directoryIdentity(
      { root, path: "." },
      access.signal,
    );
    const download = await this.#native.filesDownload(
      {
        root,
        expectedRootIdentity,
        pathSegmentsBase64: relative(root, absolute)
          .split(sep)
          .map((part) => Buffer.from(part).toString("base64url")),
        offset: 0,
        length: 0,
      },
      access.signal,
    );
    if (download.length > runFileMaxBytes) {
      download.stream.destroy();
      throw new RunFileError("Choose a file smaller than 2 GiB.");
    }
    return {
      body: download.stream,
      size: download.length,
      name: attachmentFileName(basename(path)),
    };
  }
  async download(transfer: RunFileTransfer, signal: AbortSignal) {
    const response = await runnerFileRequest(
      this.options.transport,
      runFileTransferPath(transfer.id),
      { authorization: `Bearer ${transfer.token}` },
      signal,
    );
    try {
      if (response.statusCode !== 200)
        throw new RunFileError("File transfer expired; retry the app request.");
      const size = Number(response.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size < 0 || size > runFileMaxBytes)
        throw new RunFileError("The transferred file must be smaller than 2 GiB.");
      const encoded = response.headers[runFileNameHeader];
      if (typeof encoded !== "string")
        throw new RunFileError("The transferred file has no name; retry the request.");
      return { body: response, size, name: attachmentFileName(decodeURIComponent(encoded)) };
    } catch (error) {
      response.destroy();
      throw error;
    }
  }
  async upload(
    transfer: RunFileTransfer,
    file: { body: AsyncIterable<Uint8Array>; size: number; name: string },
    signal: AbortSignal,
  ) {
    const response = await runnerFileRequest(
      this.options.transport,
      runFileTransferPath(transfer.id),
      {
        authorization: `Bearer ${transfer.token}`,
        "content-type": runFileTransferContentType,
        "content-length": String(file.size),
        [runFileNameHeader]: encodeURIComponent(file.name),
      },
      signal,
      bounded(file.body, file.size, signal),
    );
    response.resume();
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
      throw new RunFileError("File transfer failed; retry the app request.");
  }
  async install(
    file: { body: AsyncIterable<Uint8Array>; size: number; name: string },
    directory: string,
    signal: AbortSignal,
    readonly = true,
  ): Promise<string> {
    signal.throwIfAborted();
    const folder = join(directory, randomUUID());
    await ensurePrivateDirectory(folder);
    if (signal.aborted) {
      await rm(folder, { force: true, recursive: true });
      signal.throwIfAborted();
    }
    const path = join(folder, attachmentFileName(file.name));
    const temporary = join(folder, ".partial");
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    try {
      for await (const chunk of bounded(file.body, file.size, signal)) {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await output.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw new RunFileError("File copy stalled; retry the request.");
          offset += result.bytesWritten;
        }
      }
      await output.sync();
      await setPrivateHandleMode(output, readonly ? 0o444 : 0o600);
      signal.throwIfAborted();
      await rename(temporary, path);
      return path;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      await output.close();
    }
  }
  async invoke(
    message: HostIntegrationsInvoke,
    mode: "export" | "send",
    invocation: ComputerAppInvocation,
    signal: AbortSignal,
    provider: (
      args: HostIntegrationsInvoke["arguments"],
      signal: AbortSignal,
      invocation: ComputerAppInvocation,
    ) => Promise<ComputerAppValue>,
  ): Promise<ComputerAppValue> {
    const work = async (access?: RunFileAccess): Promise<ComputerAppValue> =>
      this.scratch(async (directory) => {
        const linked = access?.signal ?? signal;
        let args = message.arguments;
        if (mode === "send") {
          const paths = z
            .array(z.string())
            .max(runFileMaxPerCall)
            .parse(args.files ?? []);
          const names: string[] = [];
          if (message.files && "transfers" in message.files) {
            for (const transfer of message.files.transfers) {
              const file = await this.download(transfer, linked);
              const path = await this.install(file, directory, linked, false);
              const name = attachmentFileName(`${randomUUID()}-${file.name}`);
              await rename(path, join(directory, name));
              names.push(name);
            }
          } else {
            if (!access) throw new RunFileError("Send files from a running task.");
            for (const path of paths) {
              const file = await this.source(path, access);
              const installed = await this.install(file, directory, linked, false);
              const name = attachmentFileName(`${randomUUID()}-${file.name}`);
              await rename(installed, join(directory, name));
              names.push(name);
            }
          }
          args = { ...args, files: names };
        }
        const result = await provider(args, linked, { ...invocation, scratchDirectory: directory });
        linked.throwIfAborted();
        if (mode === "send") return result;
        const info = exported.parse(result);
        if (
          info.file !== basename(info.file) ||
          info.file.includes("\\") ||
          info.file === "." ||
          info.file === ".."
        )
          throw new RunFileError("The app returned an invalid file; retry the request.");
        const handle = await open(join(directory, info.file), constants.O_RDONLY | noFollowFlag());
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== info.sizeBytes)
            throw new RunFileError("The app returned an incomplete file; retry the request.");
          const file = {
            body: handle.createReadStream({ autoClose: false }),
            size: info.sizeBytes,
            name: info.name,
          };
          const metadata = {
            name: attachmentFileName(info.name),
            mediaType: info.mediaType,
            sizeBytes: info.sizeBytes,
          };
          if (message.files && "transfers" in message.files) {
            if (message.files.transfers.length !== 1)
              throw new RunFileError("Export needs one file transfer.");
            await this.upload(message.files.transfers[0]!, file, linked);
            return metadata;
          }
          if (!access) throw new RunFileError("Export files from a running task.");
          return {
            ...metadata,
            path: await this.install(file, join(access.directory, "exports"), linked),
          };
        } finally {
          await handle.close();
        }
      });
    try {
      if (message.files && "run" in message.files) {
        if (!this.options.port)
          throw new RunFileError(
            "This computer cannot deliver files to a task; use an execution Runner.",
          );
        return await this.options.port.withRunFiles(message.files.run, signal, work);
      }
      if (!message.files) throw new RunFileError("Use a running task to move files.");
      return await work();
    } catch (error) {
      if (error instanceof ComputerAppError) throw error;
      if (error instanceof RunFileError) throw new ComputerAppError("failed", error.message);
      throw new ComputerAppError(
        "failed",
        "The file could not be moved. Check that it is a regular file inside this task's Workspace, is smaller than 2 GiB, and retry from the current task.",
      );
    }
  }
}
async function* bounded(body: AsyncIterable<Uint8Array>, size: number, signal: AbortSignal) {
  if (size > runFileMaxBytes) throw new RunFileError("Choose a file smaller than 2 GiB.");
  let total = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > size || total > runFileMaxBytes)
      throw new RunFileError("File size changed; retry the request.");
    yield chunk;
  }
  signal.throwIfAborted();
  if (total !== size) throw new RunFileError("File transfer was incomplete; retry the request.");
}
