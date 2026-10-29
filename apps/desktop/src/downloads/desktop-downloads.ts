import { app, shell, type DownloadItem, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  desktopDownloadsActiveLimit,
  desktopDownloadsFinishedLimit,
  DesktopDownloadsSnapshotSchema,
  type DesktopDownload,
  type DesktopDownloadActionResult,
  type DesktopDownloadsSnapshot,
} from "@opensteer/protocol/desktop";

const execute = promisify(execFile);
type Entry = {
  view: DesktopDownload;
  item: DownloadItem | null;
  /** Chromium's file while it downloads, alone in its own folder under the staging root. */
  staged: string | null;
  /** The finished file in the Downloads folder. */
  destination: string | null;
  settled: Promise<void>;
  resolve: () => void;
  ending: boolean;
};

export interface DesktopDownloadsOptions {
  /** The Downloads folder that finished files move into. */
  readonly directory: () => string;
  /**
   * A private folder that holds files while they download. Chromium names and
   * deletes its in-progress files on its own schedule, so only finished files
   * ever enter Downloads; this folder is swept at start and at close.
   */
  readonly staging: string;
}

/** Owns downloads across page, tab and runtime lifetimes; paths never cross IPC. */
export class DesktopDownloads {
  readonly #directory: () => string;
  readonly #staging: string;
  readonly #sessions = new WeakSet<Session>();
  readonly #transfers = new Set<Entry>();
  /** Copies being made beside a Downloads folder on another volume. */
  readonly #copies = new Set<string>();
  readonly #listeners = new Set<(snapshot: DesktopDownloadsSnapshot) => void>();
  #entries: Entry[] = [];
  #closing: Promise<void> | undefined;
  #stopped = false;
  #progressTimer: ReturnType<typeof setTimeout> | undefined;
  #lastBroadcast = 0;

  constructor(options: DesktopDownloadsOptions) {
    this.#directory = options.directory;
    this.#staging = options.staging;
    // What a crash left mid-download.
    rmSync(this.#staging, { recursive: true, force: true });
    mkdirSync(this.#staging, { recursive: true });
  }

  accept(session: Session): void {
    if (this.#sessions.has(session)) return;
    this.#sessions.add(session);
    // Bytes Chromium writes before a download's path is chosen stay private too.
    session.setDownloadPath(this.#staging);
    session.on("will-download", (event, item) => {
      if (this.#stopped) {
        event.preventDefault();
        return;
      }
      const view: DesktopDownload = {
        id: randomUUID(),
        filename: fit(safeName(item.getFilename()), 255),
        site: downloadSite(item.getURL()),
        state: "progressing",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
      };
      let resolve = () => {};
      const settled = new Promise<void>((done) => {
        resolve = done;
      });
      const entry: Entry = {
        view,
        item,
        staged: null,
        destination: null,
        settled,
        resolve,
        ending: false,
      };
      const overflow =
        this.#entries.filter((entry) => entry.view.state === "progressing").length >=
        desktopDownloadsActiveLimit;
      this.#entries.unshift(entry);
      try {
        if (overflow) throw new Error("Too many active downloads.");
        const folder = path.join(this.#staging, view.id);
        mkdirSync(folder, { recursive: true });
        entry.staged = path.join(folder, view.filename);
        item.setSavePath(entry.staged);
      } catch {
        event.preventDefault();
        this.#finish(entry, "failed");
        return;
      }
      this.#transfers.add(entry);
      item.on("updated", (_event, state) => {
        if (entry.ending || entry.view.state !== "progressing") return;
        this.#progress(entry);
        if (state === "interrupted") {
          entry.ending = true;
          entry.view.state = "failed";
          // Cancelling inside DownloadUpdated re-enters Chromium's observer list.
          setImmediate(() => entry.item?.cancel());
          this.#publish(true);
        } else this.#publish(false);
      });
      item.once("done", (_event, state) => {
        if (entry.view.state === "failed" || entry.view.state === "cancelled") {
          this.#finish(entry, entry.view.state);
          return;
        }
        this.#progress(entry);
        if (state !== "completed") {
          this.#finish(entry, state === "cancelled" ? "cancelled" : "failed");
          return;
        }
        entry.ending = true;
        void this.#complete(entry);
      });
      this.#publish(true);
    });
  }

  snapshot(): DesktopDownloadsSnapshot {
    return DesktopDownloadsSnapshotSchema.parse({
      downloads: this.#entries.map((entry) => entry.view),
    });
  }

  subscribe(listener: (snapshot: DesktopDownloadsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async open(id: string): Promise<DesktopDownloadActionResult> {
    const entry = this.#completed(id);
    if (!entry?.destination) return { status: "missing" };
    try {
      const error = await shell.openPath(entry.destination);
      return { status: error ? (existsSync(entry.destination) ? "failed" : "missing") : "done" };
    } catch {
      return { status: existsSync(entry.destination) ? "failed" : "missing" };
    }
  }

  show(id: string): DesktopDownloadActionResult {
    const entry = this.#completed(id);
    if (!entry?.destination) return { status: "missing" };
    shell.showItemInFolder(entry.destination);
    return { status: "done" };
  }

  cancel(id: string): DesktopDownloadActionResult {
    const entry = this.#entries.find((entry) => entry.view.id === id);
    if (!entry) return { status: "missing" };
    if (entry.view.state === "progressing" && !entry.ending) {
      entry.view.state = "cancelled";
      entry.ending = true;
      entry.item?.cancel();
      this.#publish(true);
    }
    return { status: "done" };
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#stopped = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const active = [...this.#transfers];
    const pending = active.map((entry) => {
      if (!entry.ending) {
        entry.view.state = "cancelled";
        entry.ending = true;
        entry.item?.cancel();
      }
      return entry.settled;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    for (const entry of active) {
      if (entry.view.state !== "completed")
        this.#finish(entry, entry.view.state === "failed" ? "failed" : "cancelled");
    }
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
    for (const copy of this.#copies) rmSync(copy, { force: true });
    rmSync(this.#staging, { recursive: true, force: true });
  }

  #completed(id: string): Entry | undefined {
    return this.#entries.find(
      (entry) =>
        entry.view.id === id &&
        entry.view.state === "completed" &&
        entry.destination !== null &&
        existsSync(entry.destination),
    );
  }

  #progress(entry: Entry): void {
    if (!entry.item) return;
    entry.view.receivedBytes = Math.max(0, entry.item.getReceivedBytes());
    const total = entry.item.getTotalBytes();
    entry.view.totalBytes = total > 0 ? total : null;
  }

  async #complete(entry: Entry): Promise<void> {
    try {
      if (!entry.staged) throw new Error("Download has no file.");
      // Marked before it enters Downloads, so it is never there unmarked.
      if (process.platform === "darwin") await ensureQuarantine(entry.staged);
      const destination = await this.#place(entry.staged, entry.view.filename);
      entry.destination = destination;
      entry.view.filename = path.basename(destination);
      this.#finish(entry, "completed");
      app.dock?.downloadFinished(destination);
    } catch {
      this.#finish(entry, "failed");
    }
  }

  /**
   * Links a finished file into Downloads. Downloads on another volume gets a
   * copy first, made and marked under a hidden name beside it, so its visible
   * name still only ever appears complete and quarantined. A crash during that
   * copy can leave the hidden file behind.
   */
  async #place(staged: string, name: string): Promise<string> {
    const directory = this.#directory();
    await mkdir(directory, { recursive: true });
    try {
      return await publish(staged, directory, name);
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
    }
    const copy = path.join(directory, `.${path.basename(path.dirname(staged))}.opensteer-download`);
    this.#copies.add(copy);
    try {
      // A copy carries no extended attributes, so quarantine is applied to it again.
      await copyFile(staged, copy, constants.COPYFILE_EXCL);
      if (process.platform === "darwin") await ensureQuarantine(copy);
      return await publish(copy, directory, name);
    } finally {
      this.#copies.delete(copy);
      await rm(copy, { force: true });
    }
  }

  #finish(entry: Entry, state: DesktopDownload["state"]): void {
    this.#transfers.delete(entry);
    entry.ending = true;
    entry.view.state = state;
    entry.item = null;
    if (entry.staged) {
      rmSync(path.dirname(entry.staged), { recursive: true, force: true });
      entry.staged = null;
    }
    entry.resolve();
    this.#publish(true);
  }

  #publish(immediate: boolean): void {
    if (!immediate) {
      if (!this.#progressTimer)
        this.#progressTimer = setTimeout(
          () => this.#publish(true),
          Math.max(0, 250 - (Date.now() - this.#lastBroadcast)),
        );
      return;
    }
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
    let finished = 0;
    this.#entries = this.#entries.filter(
      (entry) => entry.view.state === "progressing" || ++finished <= desktopDownloadsFinishedLimit,
    );
    this.#lastBroadcast = Date.now();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function downloadSite(value: string): string | null {
  try {
    // Node does not recognize Electron's registered app: scheme as an origin.
    const url = new URL(value.startsWith("blob:") ? value.slice(5) : value);
    // A name, as Chrome shows; with its port it could exceed a hostname's 253 characters.
    const site = url.protocol === "data:" ? "" : url.hostname;
    return site.length > 0 && site.length <= 253 ? site : null;
  } catch {
    return null;
  }
}

function safeName(value: string): string {
  const name = path.posix.basename(value.replaceAll("\\", "/")).replace(/[\p{Cc}/\\]/gu, "");
  return !name || name === "." || name === ".." ? "download" : name.replace(/^\./u, "_");
}

function fit(value: string, bytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result;
}

/**
 * Links a file into Downloads under its first free name, Chrome's
 * `name (1).ext`. A link never replaces a file: the filesystem refuses a taken
 * name, also one differing only in case or one another app took a moment ago.
 * A volume without hard links fails the download.
 */
async function publish(source: string, directory: string, name: string): Promise<string> {
  const extension = /\.tar\.[^.]+$/iu.exec(name)?.[0] ?? path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 10_000; index++) {
    const suffix = index ? ` (${index})` : "";
    const ext = fit(extension, 254 - Buffer.byteLength(suffix));
    const stem = fit(base, 255 - Buffer.byteLength(suffix + ext)) || "_";
    const destination = path.join(directory, `${stem}${suffix}${ext}`);
    try {
      await link(source, destination);
      return destination;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("No free download filename.");
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function ensureQuarantine(file: string): Promise<void> {
  try {
    const { stdout } = await execute("/usr/bin/xattr", ["-p", "com.apple.quarantine", file], {
      timeout: 1_000,
    });
    if (stdout.trim()) return;
  } catch {
    /* Electron's delegate may not have a quarantine connection. */
  }
  // LaunchServices serializes web downloads as flags;Unix seconds in hex;agent;event UUID.
  // Chrome's 0081 web-download mark leaves Gatekeeper's approval bit unset.
  const value = `0081;${Math.floor(Date.now() / 1_000).toString(16)};Opensteer;`;
  await execute("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, file], {
    timeout: 1_000,
  });
}
