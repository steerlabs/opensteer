// Adapted from T3 Code (MIT): incremental transcript and file replacement cases.
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialWorkflowTranscriptCursor,
  mergeWorkflowAgentMetadata,
  readWorkflowAgentTranscript,
  workflowSessionRoot,
} from "./workflow-transcript.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const line = (uuid: string, text: string) =>
  `${JSON.stringify({ type: "assistant", uuid, message: { id: uuid, content: [{ type: "text", text }] } })}\n`;
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), "claude-workflow-files-"));
  roots.push(profile);
  const sessionRoot = workflowSessionRoot(profile, "/workspace", "own-session");
  const transcriptDir = join(sessionRoot, "workflows", "wf");
  await mkdir(transcriptDir, { recursive: true });
  const file = join(transcriptDir, "agent-a1.jsonl");
  const read = (
    cursor = initialWorkflowTranscriptCursor,
    directory = transcriptDir,
    agentId = "a1",
  ) => readWorkflowAgentTranscript({ sessionRoot, transcriptDir: directory, agentId, cursor });
  return { profile, sessionRoot, transcriptDir, file, read };
}

describe("contained workflow transcripts", () => {
  it("defers partial lines, skips bookkeeping, and resets the cursor on replacement or shrinkage", async () => {
    const { file, read } = await fixture();
    const bookkeeping =
      JSON.stringify({ type: "attachment", uuid: "attachment" }) +
      "\n" +
      JSON.stringify({ type: "user", isMeta: true, uuid: "meta" }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { content: "No UUID" } }) +
      "\n";
    const second = line("b", "second");
    await writeFile(file, bookkeeping + line("a", "first") + second.slice(0, 20));
    const first = (await read())!;
    expect(first.lines.map((entry) => entry.uuid)).toEqual(["a"]);
    expect(first.cursor.offset).toBe(Buffer.byteLength(bookkeeping + line("a", "first")));
    expect(first.truncated).toBe(false);
    await appendFile(file, second.slice(20));
    const next = (await read(first.cursor))!;
    expect(next.lines.map((entry) => entry.uuid)).toEqual(["b"]);
    const replacement = `${file}.replacement`;
    await writeFile(replacement, line("c", "replacement"));
    await rename(replacement, file);
    const replaced = (await read(next.cursor))!;
    expect(replaced.lines.map((entry) => entry.uuid)).toEqual(["c"]);
    expect(replaced.cursor.identity?.ino).not.toBe(next.cursor.identity?.ino);
    await writeFile(file, line("d", "x"));
    expect((await lstat(file)).ino).toBe(replaced.cursor.identity?.ino);
    expect((await read(replaced.cursor))!.lines.map((entry) => entry.uuid)).toEqual(["d"]);
    expect(await read((await read())!.cursor)).toMatchObject({ lines: [] });
  });

  it("caps reads and advances over a single over-cap line", async () => {
    const { file, read } = await fixture();
    await writeFile(file, "x".repeat(512 * 1024) + "\n" + line("reply", "Answer after the cap"));
    const first = (await read())!;
    expect(first).toMatchObject({ truncated: true, lines: [], cursor: { offset: 512 * 1024 } });
    expect((await read(first.cursor))!.lines.map((entry) => entry.uuid)).toEqual(["reply"]);
  });

  it("returns no detail for missing files, relative paths, invalid ids, directories, or another session/profile", async () => {
    const { profile, sessionRoot, transcriptDir, file, read } = await fixture();
    expect(await read()).toBeUndefined();
    for (const agentId of ["../escape", "a/b", "x".repeat(129), ""])
      expect(await read(undefined, transcriptDir, agentId)).toBeUndefined();
    expect(await read(undefined, "relative/path")).toBeUndefined();
    await mkdir(file);
    expect(await read()).toBeUndefined();
    const sibling = join(sessionRoot, "..", "other-session");
    const foreign = join(profile, "..", `${profile.split("/").at(-1)}-foreign`);
    roots.push(foreign);
    for (const directory of [sibling, foreign]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "agent-a1.jsonl"), line("private", "Other session's text"));
      expect(await read(undefined, directory)).toBeUndefined();
    }
  });

  it("refuses escaping symlinks, wrong resolved extensions, and a redirected session root", async () => {
    const { profile, sessionRoot, file, read } = await fixture();
    const outside = join(profile, "outside.jsonl");
    await writeFile(outside, line("outside", "Private"));
    await symlink(outside, file);
    expect(await read()).toBeUndefined();
    await rm(file);
    const textFile = join(sessionRoot, "wrong.txt");
    await writeFile(textFile, line("wrong", "Wrong extension"));
    await symlink(textFile, file);
    expect(await read()).toBeUndefined();
    await rm(sessionRoot, { recursive: true });
    const other = join(profile, "projects", "other", "other-session");
    await mkdir(join(other, "workflows", "wf"), { recursive: true });
    await writeFile(
      join(other, "workflows", "wf", "agent-a1.jsonl"),
      line("other", "Other session"),
    );
    await symlink(other, sessionRoot);
    expect(await read()).toBeUndefined();
  });

  it("refuses a file swapped between validation and open", async () => {
    const { file, read } = await fixture();
    await writeFile(file, line("original", "Expected"));
    const originalOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const swapped = `${file}.swapped`;
      await writeFile(swapped, line("swapped", "Unexpected"));
      await rename(swapped, file);
      return originalOpen(...args);
    });
    expect(await read()).toBeUndefined();
  });
});

it("retains effort across chunks of one assistant response and drops it for a new response", () => {
  const assistant = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    message: { id },
    ...extra,
  });
  const first = mergeWorkflowAgentMetadata([assistant("one", { effort: "xhigh" })]);
  expect(
    mergeWorkflowAgentMetadata(
      [
        assistant("one"),
        assistant("ignored", { isMeta: true }),
        assistant("ignored", { isApiErrorMessage: true }),
      ],
      first,
    ),
  ).toEqual(first);
  expect(mergeWorkflowAgentMetadata([assistant("two")], first)).toEqual({ messageId: "two" });
});
