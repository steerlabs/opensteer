// Adapted from T3 Code (MIT): contained, incremental workflow transcript reads.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord } from "@opensteer/shared/isRecord";

export interface WorkflowTranscriptCursor {
  readonly offset: number;
  readonly identity: { readonly dev: number; readonly ino: number } | null;
}
export const initialWorkflowTranscriptCursor: WorkflowTranscriptCursor = {
  offset: 0,
  identity: null,
};
const transcriptReadByteCap = 512 * 1024;

export function workflowSessionRoot(profile: string, cwd: string, sessionId: string): string {
  let project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (project.length > 200) {
    let hash = 0;
    for (let index = 0; index < cwd.length; index++)
      hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
    project = `${project.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
  }
  return join(profile, "projects", project, sessionId);
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Missing or unsafe transcripts leave a member with its summary, without exposing filesystem paths. */
export async function readWorkflowAgentTranscript(input: {
  readonly sessionRoot: string;
  readonly transcriptDir: string;
  readonly agentId: string;
  readonly cursor: WorkflowTranscriptCursor;
}): Promise<
  | {
      readonly lines: readonly Record<string, unknown>[];
      readonly cursor: WorkflowTranscriptCursor;
      readonly truncated: boolean;
    }
  | undefined
> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.agentId) || !isAbsolute(input.transcriptDir))
    return undefined;
  const path = join(input.transcriptDir, `agent-${input.agentId}.jsonl`);
  if (extname(path) !== ".jsonl" || !contained(resolve(input.sessionRoot), resolve(path)))
    return undefined;
  try {
    const root = await realpath(input.sessionRoot);
    // The admitted session directory itself must not redirect to another session or profile.
    const projects = await realpath(resolve(input.sessionRoot, "../.."));
    if (
      root !==
      join(projects, relative(resolve(input.sessionRoot, "../.."), resolve(input.sessionRoot)))
    )
      return undefined;
    const resolved = await realpath(path);
    if (!contained(root, resolved) || extname(resolved) !== ".jsonl") return undefined;
    const before = await lstat(resolved);
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      const pathStat = await lstat(resolved);
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.dev !== pathStat.dev ||
        stat.ino !== pathStat.ino
      )
        return undefined;
      const previous = input.cursor.identity;
      const start =
        previous !== null &&
        previous.dev === stat.dev &&
        previous.ino === stat.ino &&
        input.cursor.offset <= stat.size
          ? input.cursor.offset
          : 0;
      const buffer = Buffer.alloc(Math.min(stat.size - start, transcriptReadByteCap));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const after = await lstat(resolved);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        (await realpath(path)) !== resolved ||
        (await realpath(input.sessionRoot)) !== root
      )
        return undefined;
      const read = buffer.subarray(0, bytesRead);
      const lineEnd = read.lastIndexOf(0x0a) + 1;
      const consumed = lineEnd === 0 && bytesRead === transcriptReadByteCap ? bytesRead : lineEnd;
      const lines: Record<string, unknown>[] = [];
      for (const line of read.subarray(0, lineEnd).toString("utf8").split("\n")) {
        try {
          const entry: unknown = JSON.parse(line);
          if (
            !isRecord(entry) ||
            (entry.type !== "assistant" && entry.type !== "user") ||
            entry.isMeta === true ||
            typeof entry.uuid !== "string" ||
            !entry.uuid.trim()
          )
            continue;
          lines.push(entry);
        } catch {}
      }
      return {
        cursor: { offset: start + consumed, identity: { dev: stat.dev, ino: stat.ino } },
        lines,
        truncated: stat.size - start > transcriptReadByteCap,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export interface WorkflowAgentMetadata {
  readonly messageId?: string;
  readonly effort?: string;
  readonly speed?: string;
}
export function mergeWorkflowAgentMetadata(
  lines: readonly Record<string, unknown>[],
  previous: WorkflowAgentMetadata = {},
): WorkflowAgentMetadata {
  let metadata = previous;
  for (const entry of lines) {
    if (entry.type !== "assistant" || entry.isMeta === true || entry.isApiErrorMessage === true)
      continue;
    const message = isRecord(entry.message) ? entry.message : {};
    const messageId = typeof message.id === "string" ? message.id : undefined;
    const effort = typeof entry.effort === "string" ? entry.effort : undefined;
    const usage = isRecord(message.usage) ? message.usage : {};
    const speed = typeof usage.speed === "string" ? usage.speed : undefined;
    metadata = {
      ...(messageId !== undefined && messageId === metadata.messageId ? metadata : {}),
      ...(messageId === undefined ? {} : { messageId }),
      ...(effort === undefined ? {} : { effort }),
      ...(speed === undefined ? {} : { speed }),
    };
  }
  return metadata;
}
