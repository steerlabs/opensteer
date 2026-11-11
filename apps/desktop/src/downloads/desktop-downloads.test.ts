import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DownloadItem, Session, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { DesktopDownloads } from "./desktop-downloads.js";

vi.mock("electron", () => ({ app: {}, shell: {} }));

it("holds the originating page until all of its downloads settle, including cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-download-policy-"));
  const downloads = new DesktopDownloads({
    directory: () => root,
    staging: path.join(root, "staging"),
  });
  const session = Object.assign(new EventEmitter(), { setDownloadPath: vi.fn() });
  downloads.accept(session as unknown as Session);
  const item = () =>
    Object.assign(new EventEmitter(), {
      getFilename: () => "file.bin",
      getURL: () => "https://site.test/file",
      getTotalBytes: () => 100,
      getReceivedBytes: () => 0,
      setSavePath: vi.fn(),
      cancel: vi.fn(),
    });
  const first = item(),
    second = item(),
    other = item();
  const start = (transfer: ReturnType<typeof item>, id: number) =>
    session.emit(
      "will-download",
      { preventDefault: vi.fn() },
      transfer as unknown as DownloadItem,
      { id } as WebContents,
    );
  try {
    start(first, 7);
    start(second, 7);
    start(other, 8);
    expect(downloads.active(7)).toBe(true);
    first.emit("done", {}, "cancelled");
    expect(downloads.active(7)).toBe(true);
    second.emit("updated", {}, "interrupted");
    expect(downloads.active(7)).toBe(true);
    second.emit("done", {}, "cancelled");
    expect(downloads.active(7)).toBe(false);
    expect(downloads.active(8)).toBe(true);
    other.emit("done", {}, "cancelled");
    expect(downloads.active(8)).toBe(false);
  } finally {
    await downloads.close();
    await rm(root, { recursive: true, force: true });
  }
});
