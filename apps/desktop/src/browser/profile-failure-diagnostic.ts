import { nodeErrorCode } from "@opensteer/shared/nodeError";

/** Error messages, Zod issues and CDP payloads can contain website secrets. */
export function profileFailureDiagnostic(error: unknown, depth = 0): unknown {
  if (depth >= 5) return { name: "TruncatedCause" };
  if (!(error instanceof Error)) return { name: "NonError" };
  const code = nodeErrorCode(error);
  return {
    name: [
      "Error",
      "TypeError",
      "ZodError",
      "BrowserRuntimeError",
      "ProtectedStorageUnavailableError",
      "ProtectedStateUnreadableError",
    ].includes(error.name)
      ? error.name
      : "Error",
    ...(code &&
    [
      "EACCES",
      "EPERM",
      "ENOENT",
      "ENOSPC",
      "EIO",
      "EMFILE",
      "ENFILE",
      "EROFS",
      "ELOOP",
      "ENOTDIR",
      "EISDIR",
      "EEXIST",
      "EBUSY",
      "EINVAL",
      "EBADF",
      "ENAMETOOLONG",
      "ENOTEMPTY",
      "EXDEV",
    ].includes(code)
      ? { code }
      : {}),
    // Retain only source locations, never the message or evaluated page source.
    frames: (error.stack ?? "")
      .split("\n")
      .flatMap((line) => {
        const match = /\/([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/u.exec(line);
        return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
      })
      .slice(0, 8),
    ...(error.cause instanceof Error && error.cause !== error
      ? { cause: profileFailureDiagnostic(error.cause, depth + 1) }
      : {}),
  };
}
