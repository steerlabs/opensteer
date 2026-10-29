/**
 * Private, per-application file storage, as this package needs it.
 *
 * The contract is deliberately the one the Desktop's containment helper
 * already implements: every path is resolved inside one initialized root,
 * writes replace atomically, and a missing file reads as `null` rather than
 * throwing. A phone satisfies it with its own sandboxed application
 * directory. The implementation, and therefore the containment guarantee,
 * belongs to the platform; nothing in this package may open a path itself.
 *
 * `readFile` answers in bytes rather than a Node `Buffer`, because this
 * package compiles without Node's type surface.
 */
export interface PrivateFilesystem {
  readonly root: string;
  directoryEmpty(path: string, signal?: AbortSignal): Promise<boolean>;
  ensureDirectory(path: string, signal?: AbortSignal): Promise<void>;
  fileExists(path: string, signal?: AbortSignal): Promise<boolean>;
  readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  removeFile(path: string, signal?: AbortSignal): Promise<boolean>;
  writeFileAtomic(path: string, content: Uint8Array | string, signal?: AbortSignal): Promise<void>;
  writeFileExclusive(
    path: string,
    content: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void>;
}
