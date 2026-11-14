import { watch } from "node:fs";
import { join } from "node:path";
import { AgentHomeSettingsSchema, agentHomeSettingsFileName } from "@opensteer/core";
import type { AgentHomeSettingsError, RunnerSettingsReport } from "@opensteer/protocol";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

export type AgentHomeSettingsRead = RunnerSettingsReport["result"];
const maximumSettingsBytes = 64 * 1024;

/** Reads `<Agent home>/settings.json`. Agents write it, so every failure is reported, never thrown. */
export async function readAgentHomeSettings(agentHomePath: string): Promise<AgentHomeSettingsRead> {
  const path = join(agentHomePath, agentHomeSettingsFileName);
  const invalid = (error: Omit<AgentHomeSettingsError, "path">): AgentHomeSettingsRead => ({
    status: "invalid",
    error: { path, ...error, message: error.message.slice(0, 500) },
  });
  let bytes: Buffer | null;
  try {
    bytes = await readBoundedRegularFile(path, maximumSettingsBytes, {
      changedError: () => new Error("It changed while it was being read"),
      invalidFileError: () => new Error("It must be a regular file, not a link or a folder"),
      missing: "null",
      sizeError: () => new Error(`It is larger than ${maximumSettingsBytes / 1024} KB`),
    });
  } catch (error) {
    return invalid({ message: error instanceof Error ? error.message : "It could not be read" });
  }
  if (!bytes) return { status: "missing" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid({ message: "It is not valid UTF-8" });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const lines = text.slice(0, jsonErrorOffset(text)).split("\n");
    return invalid({
      line: lines.length,
      column: lines.at(-1)!.length + 1,
      message: (error instanceof Error ? error.message : "Invalid JSON")
        .replace(/ in JSON at position \d+.*$/su, "")
        .replace(/, \S*".*" is not valid JSON$/su, ""),
    });
  }
  const parsed = AgentHomeSettingsSchema.safeParse(value);
  if (parsed.success) return { status: "valid", settings: parsed.data };
  const issue = parsed.error.issues[0]!;
  return invalid({
    ...(issue.path.length ? { at: issue.path.join(".") } : {}),
    message: issue.message,
  });
}

/** Where JSON text that `JSON.parse` refused first goes wrong; V8 reports a position only sometimes. */
function jsonErrorOffset(text: string): number {
  let at = 0;
  const fail = (): never => {
    throw at;
  };
  const space = () => {
    while (/[ \t\n\r]/u.test(text[at] ?? "")) at++;
  };
  const expect = (token: string) => (text.startsWith(token, at) ? (at += token.length) : fail());
  const string = () => {
    expect('"');
    while (text[at] !== '"') {
      if (at >= text.length || text.charCodeAt(at) < 0x20) fail();
      at += text[at] === "\\" ? 2 : 1;
    }
    at++;
  };
  const list = (close: string, item: () => void) => {
    at++;
    space();
    if (text[at] === close) return void at++;
    for (;;) {
      item();
      space();
      if (text[at] === close) return void at++;
      expect(",");
    }
  };
  const value = (): void => {
    space();
    const next = text[at];
    if (next === "{")
      return list("}", () => {
        space();
        string();
        space();
        expect(":");
        value();
      });
    if (next === "[") return list("]", value);
    if (next === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(at),
    );
    if (!literal) fail();
    at += literal![0].length;
  };
  try {
    value();
    space();
  } catch (offset) {
    return offset as number;
  }
  return at;
}

/** Calls `changed` shortly after settings.json is written, replaced or removed. */
export function watchAgentHomeSettings(agentHomePath: string, changed: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  // Agent home itself: editors and agents replace the file rather than write it in place.
  const watcher = watch(agentHomePath, { persistent: false }, (_event, name) => {
    if (name !== null && name !== agentHomeSettingsFileName) return;
    clearTimeout(timer);
    timer = setTimeout(changed, 200);
  });
  const stop = () => {
    clearTimeout(timer);
    watcher.close();
  };
  watcher.on("error", stop);
  return stop;
}
