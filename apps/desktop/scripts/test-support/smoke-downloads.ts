import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopDownloads } from "../../src/downloads/desktop-downloads.js";

/** The real download owner, with Downloads and staging folders this run alone owns. */
export function smokeDesktopDownloads(artifactRoot?: string): DesktopDownloads {
  const root = artifactRoot ?? mkdtempSync(path.join(tmpdir(), "opensteer-smoke-downloads-"));
  if (!artifactRoot) process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return new DesktopDownloads({
    directory: () => path.join(root, "Downloads"),
    staging: path.join(root, "partial"),
  });
}
